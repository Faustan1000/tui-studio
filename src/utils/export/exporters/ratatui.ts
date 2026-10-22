// Ratatui (Rust) exporter, written on top of the export IR (see ../ir.ts).
//
// Output: `src/main.rs` (a complete program with an `App` struct, key handling and a `ui` function)
// and `Cargo.toml` (ratatui 0.29 with the crossterm it re-exports).
//
// Layout strategy per container (also stated in the header of the generated file):
//   - flex (row/column)  native: `Layout` with `Constraint`s (Length / Fill), `spacing` for the gap,
//                        `Flex` for justify, `aligned()` for the cross axis, `Block::padding` for padding
//   - grid               native: a vertical `Layout` of rows, each a horizontal `Layout` of columns
//   - wrap, absolute     snapshot: every child is placed at the editor's position (`rel`) with
//                        `clamp_rect`; it does not reflow when the terminal is resized
//   - modal              overlay drawn last over the whole screen (`Clear`, then the container)

import type { ExportAdapter } from '../adapter';
import { API_SPEC } from '../api/spec';
import { apiEventMethod, apiName, safeIdent } from '../api/model';
import runtimeSource from '../api/rust/ui_runtime.rs?raw';
import type { IRBorder, IRNode, IRStyle } from '../ir';
import { inlineText, itemText, treeLines, visibleChildren, walkIR } from '../ir';
import { CodeWriter, rustStr } from '../lang';

export const RATATUI_VERSION = '0.29.0';
export const CROSSTERM_VERSION = '0.28.1';

// ── Small helpers ─────────────────────────────────────────────────────────────

const u16 = (n: number) => Math.max(0, Math.min(65535, Math.round(n)));

function color(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `Color::Rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

function styleExpr(s: IRStyle, extra: string[] = []): string {
  let e = 'Style::default()';
  if (s.fg) e += `.fg(${color(s.fg)})`;
  if (s.bg) e += `.bg(${color(s.bg)})`;
  const mods = [...extra];
  if (s.bold) mods.push('Modifier::BOLD');
  if (s.italic) mods.push('Modifier::ITALIC');
  if (s.underline) mods.push('Modifier::UNDERLINED');
  if (s.strikethrough) mods.push('Modifier::CROSSED_OUT');
  if (mods.length) e += `.add_modifier(${mods.join(' | ')})`;
  return e;
}

function bordersExpr(b: IRBorder): string {
  const sides = [
    b.top && 'Borders::TOP',
    b.right && 'Borders::RIGHT',
    b.bottom && 'Borders::BOTTOM',
    b.left && 'Borders::LEFT',
  ].filter(Boolean) as string[];
  if (sides.length === 4) return 'Borders::ALL';
  if (sides.length === 0) return 'Borders::NONE';
  return sides.join(' | ');
}

function borderType(kind: IRBorder['kind']): string {
  switch (kind) {
    case 'double':
      return 'BorderType::Double';
    case 'rounded':
      return 'BorderType::Rounded';
    case 'bold':
      return 'BorderType::Thick';
    default:
      return 'BorderType::Plain';
  }
}

/** Method name for a user handler name: `handleChange` -> `handle_change`. */
const RUST_KEYWORDS = new Set(
  (
    'as break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref ' +
    'return self Self static struct super trait true type unsafe use where while async await dyn abstract become ' +
    'box do final macro override priv typeof unsized virtual yield try gen'
  ).split(' ')
);
const OWN_FNS = [
  'main',
  'program',
  'ui',
  'run_loop',
  'read_event',
  'on_event',
  'register_handlers',
  'slots',
  'byte_index',
  'aligned',
  'centered',
  'clamp_rect',
  'focus_style',
  'focus_border',
  'dim_if',
  'render_log',
  'render_errors',
];

function methodName(raw: string): string {
  let n = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase()
    .replace(/^_+|_+$/g, '');
  if (!n) n = 'handler';
  if (/^[0-9]/.test(n)) n = `_${n}`;
  if (RUST_KEYWORDS.has(n) || OWN_FNS.includes(n)) n += '_handler';
  return n;
}

const FOCUSABLE = new Set([
  'TextInput',
  'Button',
  'Checkbox',
  'Radio',
  'Toggle',
  'Select',
  'List',
  'Menu',
  'Tree',
  'Tabs',
  'Table',
]);

/** Whether a node draws anything (Spacers and empty plain containers do not). */
function renders(node: IRNode): boolean {
  if (!node.visible || node.type === 'Spacer') return false;
  if (node.type === 'Modal') return true;
  if (node.type === 'Screen' || node.type === 'Box' || node.type === 'Grid') {
    return needsBlock(node) || contentKids(node).some(renders);
  }
  return true;
}

function contentKids(node: IRNode): IRNode[] {
  return visibleChildren(node).filter((k) => k.type !== 'Modal');
}

function needsBlock(node: IRNode): boolean {
  const p = node.layout.padding;
  return !!node.style.border || !!node.style.bg || p.top + p.right + p.bottom + p.left > 0;
}

/** Display width of a string in cells (wide characters count twice). */
function cells(text: string): number {
  let n = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    n += cp >= 0x2e80 || (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x1f300 && cp <= 0x1faff) ? 2 : 1;
  }
  return n;
}

/**
 * Width a node needs for its content. The editor's box of an auto-width widget can be narrower
 * (a one-cell text box), so the exporter measures the text itself.
 */
/** Text of one tab: icon, label, status dot and hotkey (same as the Textual export). */
function tabText(i: IRNode['items'][number]): string {
  return `${i.icon ? `${i.icon} ` : ''}${i.label || 'Tab'}${i.status ? ' ●' : ''}${i.hotkey ? ` ${i.hotkey}` : ''}`;
}

/** Components that take the whole width of their parent when it does not say otherwise. */
const FILLS_WIDTH = new Set(['Select', 'List', 'Menu', 'Tree', 'Tabs']);

function intrinsicWidth(node: IRNode): number {
  const border = node.style.border ? 2 : 0;
  const longest = (lines: string[]) => Math.max(0, ...lines.map(cells));
  switch (node.type) {
    case 'Text':
      return longest(node.text.split('\n')) + border;
    case 'Button': {
      // Like Textual: a bordered button is at least 16 cells wide and keeps 2 cells of padding.
      const w = longest(inlineText(node).split('\n'));
      return node.style.border ? Math.max(16, w + 6) : w;
    }
    case 'Checkbox':
    case 'Radio':
    case 'Toggle':
    case 'Select':
    case 'Spinner':
    case 'Breadcrumb':
      return longest(inlineText(node).split('\n')) + border;
    case 'List':
      return longest(node.items.map((i) => i.label)) + border;
    case 'Menu':
      return longest(node.items.map((i) => itemText(i))) + 2 + border;
    case 'Tree':
      return longest(treeLines(node.items).map((l) => l.text)) + 2 + border;
    case 'Tabs':
      return node.items.reduce((sum, i) => sum + cells(tabText(i)) + 2, 0) + border;
    case 'Table': {
      const n = Math.max(node.columns.length, ...node.rows.map((r) => r.length));
      let total = Math.max(0, n - 1) * 2;
      for (let c = 0; c < n; c++) {
        total += Math.max(3, longest([node.columns[c] ?? '', ...node.rows.map((r) => r[c] ?? '')]));
      }
      return total + 2 + border; // one cell of padding on both sides, like Textual
    }
    default:
      return 0;
  }
}

interface Focusable {
  node: IRNode;
  name: string;
  index: number;
  modal?: IRNode;
}

// ── Store keys, seeds and handles ─────────────────────────────────────────────

/** Key of a component in the runtime store: its code name, or an internal key. */
function keyOf(node: IRNode): string {
  return node.tag ?? `_${node.ident}`;
}

const HANDLE_TYPE: Record<IRNode['type'], string> = {
  Screen: 'ContainerHandle',
  Box: 'ContainerHandle',
  Grid: 'ContainerHandle',
  Spacer: 'ContainerHandle',
  Breadcrumb: 'ContainerHandle',
  Text: 'TextHandle',
  Spinner: 'SpinnerHandle',
  Button: 'ButtonHandle',
  TextInput: 'InputHandle',
  Checkbox: 'CheckHandle',
  Radio: 'CheckHandle',
  Toggle: 'CheckHandle',
  Select: 'SelectHandle',
  ProgressBar: 'ProgressHandle',
  Table: 'TableHandle',
  List: 'ListHandle',
  Tree: 'TreeHandle',
  Menu: 'MenuHandle',
  Tabs: 'TabsHandle',
  Modal: 'ModalHandle',
};

const rustFloat = (n: number) =>
  Number.isFinite(n) ? (Number.isInteger(n) ? `${n}.0` : String(n)) : '0.0';
const strList = (items: string[]) => `Value::list(&[${items.map(rustStr).join(', ')}])`;

function zeroValue(type: string): string {
  switch (type) {
    case 'int':
      return 'Value::Int(0)';
    case 'float':
      return 'Value::Float(0.0)';
    case 'bool':
      return 'Value::Bool(false)';
    case 'str_list':
      return 'Value::list(&[])';
    case 'rows':
      return 'Value::rows(&[])';
    default:
      return 'Value::text("")';
  }
}

/** The initial value of an API property as Rust code (what the user sees when the UI opens). */
function valueExpr(node: IRNode, prop: string): string {
  switch (prop) {
    case 'text':
    case 'title':
      return `Value::text(${rustStr(node.text)})`;
    case 'label':
      return `Value::text(${rustStr(node.type === 'Spinner' ? node.text || 'Loading...' : node.text)})`;
    case 'value':
      if (node.type === 'ProgressBar') return `Value::Float(${rustFloat(node.progress.value)})`;
      if (node.type === 'Select')
        return `Value::text(${rustStr(node.value || node.options[0] || '')})`;
      return `Value::text(${rustStr(node.value)})`;
    case 'max':
      return `Value::Float(${rustFloat(node.progress.max)})`;
    case 'placeholder':
      return `Value::text(${rustStr(node.placeholder)})`;
    case 'checked':
      return `Value::Bool(${node.checked})`;
    case 'options':
      return strList(node.options);
    case 'columns':
      return strList(node.columns);
    case 'rows':
      return `Value::rows(&[${node.rows.map((r) => `&[${r.map(rustStr).join(', ')}]`).join(', ')}])`;
    case 'items':
      return strList(node.items.map((i) => (node.type === 'List' ? i.label : itemText(i))));
    default:
      return `Value::Int(${Math.max(0, node.selected)})`;
  }
}

function seedCode(node: IRNode): string {
  const spec = API_SPEC[node.type];
  const state = !node.visible ? 'State::Hidden' : node.disabled ? 'State::Muted' : 'State::Active';
  const props = spec.properties.map(
    (p) =>
      `.prop(${rustStr(p.name)}, ${node.visible ? valueExpr(node, p.name) : zeroValue(p.type)})`
  );
  if (node.type === 'Modal') props.push(`.prop("open", Value::Bool(${node.visible && !node.tag}))`);
  const head = `Seed::new(${rustStr(keyOf(node))}, ${state})`;
  return props.length ? [head, ...props.map((p) => `    ${p}`)].join('\n') : head;
}

function needsSeed(node: IRNode): boolean {
  if (node.tag) return true;
  if (!node.visible) return false;
  return (
    API_SPEC[node.type].properties.length > 0 ||
    FOCUSABLE.has(node.type) ||
    node.type === 'Modal' ||
    node.disabled
  );
}

/** Whether the muted state exists for the component (it is drawn dimmed). */
const canMute = (node: IRNode) => API_SPEC[node.type].states.includes('muted');

// ── Generator ─────────────────────────────────────────────────────────────────

interface HandleField {
  node: IRNode;
  field: string;
}

class Gen {
  private w = new CodeWriter('    ', 1);
  private fields: { name: string; type: string; init: string }[] = [];
  private consts: string[] = [];
  private focus: Focusable[] = [];
  private focusOf = new Map<string, Focusable>();
  private arms: string[] = [];
  private target = 'frame';
  private scrollable = false;
  private rootOuter = '';
  private selects: IRNode[] = [];
  private clicks: string[] = [];
  private inModal = false;
  private stubs = new Set<string>();
  private regs: string[] = [];
  private strategies: string[] = [];
  private spinner = false;
  private handles: HandleField[] = [];
  private fieldOf = new Map<string, string>();

  constructor(
    private readonly screenIdent: string,
    private readonly root: IRNode,
    private readonly modals: IRNode[]
  ) {}

  // ── Collect state, key arms and handlers ────────────────────────────────────

  private collectHandles(): void {
    const used = new Set<string>();
    for (const node of walkIR(this.root)) {
      if (!node.tag || node === this.root) continue;
      const field = safeIdent(apiName(node.tag, 'snake'), 'rust');
      if (used.has(field)) continue;
      used.add(field);
      this.handles.push({ node, field });
      this.fieldOf.set(node.id, field);
    }
  }

  private collect(node: IRNode, modal?: IRNode): void {
    if (!node.visible) return;
    if (node.type === 'Modal' && node !== modal) return;
    this.register(node, modal);
    node.children.forEach((c) => this.collect(c, modal));
  }

  private register(node: IRNode, modal?: IRNode): void {
    const id = node.ident;
    const up = id.toUpperCase();
    const K = rustStr(keyOf(node));
    const field = (name: string, type: string, init: string) =>
      this.fields.push({ name, type, init });
    let f: Focusable | undefined;
    if (FOCUSABLE.has(node.type) && !node.disabled) {
      f = { node, name: `F_${up}`, index: this.focus.length, modal };
      this.focus.push(f);
      this.focusOf.set(node.id, f);
    }
    const T = node.style.border?.top ? 1 : 0;
    const L = (node.style.border?.left ? 1 : 0) + (node.type === 'TextInput' && node.style.border ? 2 : 0);
    const click = (lines: string[]) => {
      if (f)
        this.clicks.push(
          `${f.name} => {\n${lines.map((l) => `    ${l.replace(/ [+-] 0(?![\d.])/g, '')}`).join('\n')}\n}`
        );
    };
    const toggle = (set: string[]) => [
      `let on = !self.rt.get_bool(${K}, "checked");`,
      `self.rt.user_set(${K}, "checked", Value::Bool(on), Some("change"));`,
      ...set,
    ];
    const arm = (lines: string[]) => {
      if (f) this.arms.push(`Some(${f.name}) => ${lines.join('\n')},`);
    };

    // Handlers named in the editor become stubs that are registered on the runtime.
    for (const ev of API_SPEC[node.type].events) {
      const name = ev.editorKey ? node.events[ev.editorKey] : undefined;
      if (!name) continue;
      const m = methodName(name);
      this.stubs.add(m);
      const tagged = this.fieldOf.get(node.id);
      this.regs.push(
        tagged
          ? `ui.${tagged}.${apiEventMethod(ev.name, 'snake')}(${m});`
          : `ui.runtime().on(${K}, ${rustStr(ev.name)}, Arc::new(${m}));`
      );
    }

    switch (node.type) {
      case 'TextInput':
        click([
          `let col = m.column.saturating_sub(hit.rect.x + ${L}) as usize;`,
          `self.${id}_cursor = col.min(self.rt.get_text(${K}, "value").chars().count());`,
        ]);
        break;
      case 'Button':
        click([`self.rt.user_emit(${K}, "click", Value::None);`]);
        break;
      case 'Checkbox':
      case 'Toggle':
        click(toggle([]));
        break;
      case 'Radio': {
        const group = (node.parent?.children ?? []).filter(
          (x) => x !== node && x.type === 'Radio' && x.visible
        );
        click([
          `if !self.rt.get_bool(${K}, "checked")`,
          `    && self.rt.user_set(${K}, "checked", Value::Bool(true), Some("change"))`,
          '{',
          ...group.map(
            (x) => `    self.rt.set(${rustStr(keyOf(x))}, "checked", Value::Bool(false));`
          ),
          '}',
        ]);
        break;
      }
      case 'Select':
        click([`self.open_dropdown(${f?.name ?? '0'}, ${K});`]);
        break;
      case 'List':
      case 'Menu':
        click([
          `if m.row >= hit.rect.y + ${T} {`,
          `    let row = (m.row - hit.rect.y - ${T}) as usize + self.${id}_state.offset();`,
          `    let len = ${node.type === 'Menu' ? `${up}_ITEMS.len()` : `self.rt.get_list(${K}, "items").len()`};`,
          '    if row < len {',
          `        self.rt.user_set(${K}, "selected", Value::Int(row as i64), None);`,
          `        self.rt.user_emit(${K}, "select", Value::Int(row as i64));`,
          '    }',
          '}',
        ]);
        break;
      case 'Tree':
        click([
          `if m.row >= hit.rect.y + ${T} {`,
          `    let row = (m.row - hit.rect.y - ${T}) as usize + self.${id}_state.offset();`,
          `    if row < ${up}_ITEMS.len() && self.rt.accepts(${K}) {`,
          `        self.${id}_state.select(Some(row));`,
          `        self.rt.user_emit(${K}, "select", Value::Int(row as i64));`,
          '    }',
          '}',
        ]);
        break;
      case 'Tabs':
        click([
          `let mut x = hit.rect.x + ${L};`,
          `for (i, title) in ${up}_TABS.iter().enumerate() {`,
          '    let width = title.chars().count() as u16 + 2;',
          '    if m.column >= x && m.column < x + width {',
          `        if self.rt.get_int(${K}, "active_tab") != i as i64 {`,
          `            self.rt.user_set(${K}, "active_tab", Value::Int(i as i64), Some("change"));`,
          '        }',
          '        break;',
          '    }',
          '    x += width;',
          '}',
        ]);
        break;
      case 'Table':
        click([
          `if m.row >= hit.rect.y + ${T} + ${node.columns.length ? 1 : 0} {`,
          `    let row = (m.row - hit.rect.y - ${T} - ${node.columns.length ? 1 : 0}) as usize + self.${id}_state.offset();`,
          `    if row < self.rt.get_rows(${K}, "rows").len() && self.rt.accepts(${K}) {`,
          `        self.${id}_state.select(Some(row));`,
          '    }',
          '}',
        ]);
        break;
      default:
        break;
    }

    switch (node.type) {
      case 'Spinner':
        this.spinner = true;
        break;
      case 'TextInput': {
        const cur = `self.${id}_cursor`;
        field(`${id}_cursor`, 'usize', String([...node.value].length));
        arm([
          'match key.code {',
          '    KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => {',
          `        if self.rt.accepts(${K}) {`,
          `            let mut v = self.rt.get_text(${K}, "value");`,
          `            let at_char = ${cur}.min(v.chars().count());`,
          '            let at = byte_index(&v, at_char);',
          '            v.insert(at, c);',
          `            ${cur} = at_char + 1;`,
          `            self.rt.user_set(${K}, "value", Value::Str(v), Some("change"));`,
          '        }',
          '    }',
          '    KeyCode::Backspace => {',
          `        if self.rt.accepts(${K}) {`,
          `            let mut v = self.rt.get_text(${K}, "value");`,
          `            let at_char = ${cur}.min(v.chars().count());`,
          '            if at_char > 0 {',
          '                let at = byte_index(&v, at_char - 1);',
          '                v.remove(at);',
          `                ${cur} = at_char - 1;`,
          `                self.rt.user_set(${K}, "value", Value::Str(v), Some("change"));`,
          '            }',
          '        }',
          '    }',
          '    KeyCode::Left => {',
          `        ${cur} = ${cur}.saturating_sub(1);`,
          '    }',
          '    KeyCode::Right => {',
          `        let n = self.rt.get_text(${K}, "value").chars().count();`,
          `        ${cur} = (${cur} + 1).min(n);`,
          '    }',
          '    KeyCode::Home => {',
          `        ${cur} = 0;`,
          '    }',
          '    KeyCode::End => {',
          `        ${cur} = self.rt.get_text(${K}, "value").chars().count();`,
          '    }',
          '    KeyCode::Enter => {',
          `        let v = self.rt.get_text(${K}, "value");`,
          `        self.rt.user_emit(${K}, "submit", Value::Str(v));`,
          '    }',
          '    _ => {}',
          '}',
        ]);
        break;
      }
      case 'Button':
        arm([
          'match key.code {',
          "    KeyCode::Enter | KeyCode::Char(' ') => {",
          `        self.rt.user_emit(${K}, "click", Value::None);`,
          '    }',
          '    _ => {}',
          '}',
        ]);
        break;
      case 'Checkbox':
      case 'Toggle':
        arm([
          'match key.code {',
          "    KeyCode::Char(' ') | KeyCode::Enter => {",
          `        let on = !self.rt.get_bool(${K}, "checked");`,
          `        self.rt.user_set(${K}, "checked", Value::Bool(on), Some("change"));`,
          '    }',
          '    _ => {}',
          '}',
        ]);
        break;
      case 'Radio': {
        const group = (node.parent?.children ?? []).filter(
          (s) => s !== node && s.type === 'Radio' && s.visible
        );
        arm([
          'match key.code {',
          "    KeyCode::Char(' ') | KeyCode::Enter => {",
          `        if !self.rt.get_bool(${K}, "checked")`,
          `            && self.rt.user_set(${K}, "checked", Value::Bool(true), Some("change"))`,
          '        {',
          ...group.map(
            (s) => `            self.rt.set(${rustStr(keyOf(s))}, "checked", Value::Bool(false));`
          ),
          '        }',
          '    }',
          '    _ => {}',
          '}',
        ]);
        break;
      }
      case 'Select':
        if (f) this.selects.push(node);
        arm([
          'match key.code {',
          "    KeyCode::Enter | KeyCode::Char(' ') | KeyCode::Up | KeyCode::Down => {",
          `        self.open_dropdown(${f?.name ?? '0'}, ${K});`,
          '    }',
          '    _ => {}',
          '}',
        ]);
        break;
      case 'List':
      case 'Menu': {
        const lines = node.type === 'Menu' ? node.items.map((i) => itemText(i)) : [];
        const items = `${up}_ITEMS`;
        if (node.type === 'Menu') {
          this.consts.push(`const ${items}: &[&str] = &[${lines.map(rustStr).join(', ')}];`);
        }
        field(`${id}_state`, 'ListState', 'ListState::default()');
        const len =
          node.type === 'Menu' ? `${items}.len()` : `self.rt.get_list(${K}, "items").len()`;
        arm([
          'match key.code {',
          '    KeyCode::Up | KeyCode::Down => {',
          `        let cur = self.rt.get_int(${K}, "selected");`,
          `        let last = (${len} as i64 - 1).max(0);`,
          '        let step = if key.code == KeyCode::Up { -1 } else { 1 };',
          `        self.rt.user_set(${K}, "selected", Value::Int((cur + step).clamp(0, last)), None);`,
          '    }',
          '    KeyCode::Enter => {',
          `        let cur = self.rt.get_int(${K}, "selected");`,
          `        self.rt.user_emit(${K}, "select", Value::Int(cur));`,
          '    }',
          '    _ => {}',
          '}',
        ]);
        break;
      }
      case 'Tree': {
        const lines = treeLines(node.items).map((l) => l.text);
        const items = `${up}_ITEMS`;
        this.consts.push(`const ${items}: &[&str] = &[${lines.map(rustStr).join(', ')}];`);
        field(
          `${id}_state`,
          'ListState',
          `ListState::default()${lines.length ? '.with_selected(Some(0))' : ''}`
        );
        const st = `self.${id}_state`;
        arm([
          'match key.code {',
          '    KeyCode::Up | KeyCode::Down => {',
          `        if self.rt.accepts(${K}) {`,
          `            let cur = ${st}.selected().unwrap_or(0);`,
          '            let next = if key.code == KeyCode::Up {',
          '                cur.saturating_sub(1)',
          '            } else {',
          `                (cur + 1).min(${items}.len().saturating_sub(1))`,
          '            };',
          `            ${st}.select(Some(next));`,
          '        }',
          '    }',
          '    KeyCode::Enter => {',
          `        let cur = ${st}.selected().unwrap_or(0) as i64;`,
          `        self.rt.user_emit(${K}, "select", Value::Int(cur));`,
          '    }',
          '    _ => {}',
          '}',
        ]);
        break;
      }
      case 'Tabs': {
        const tabs = `${up}_TABS`;
        this.consts.push(
          `const ${tabs}: &[&str] = &[${node.items.map((i) => rustStr(tabText(i))).join(', ')}];`
        );
        arm([
          'match key.code {',
          '    KeyCode::Left | KeyCode::Right => {',
          `        let cur = self.rt.get_int(${K}, "active_tab");`,
          '        let step = if key.code == KeyCode::Left { -1 } else { 1 };',
          `        let last = (${tabs}.len() as i64 - 1).max(0);`,
          '        let next = (cur + step).clamp(0, last);',
          '        if next != cur {',
          `            self.rt.user_set(${K}, "active_tab", Value::Int(next), Some("change"));`,
          '        }',
          '    }',
          '    _ => {}',
          '}',
        ]);
        break;
      }
      case 'Table': {
        field(`${id}_state`, 'TableState', 'TableState::default()');
        const st = `self.${id}_state`;
        arm([
          'match key.code {',
          '    KeyCode::Up | KeyCode::Down => {',
          `        if self.rt.accepts(${K}) {`,
          `            let cur = ${st}.selected().unwrap_or(0);`,
          `            let last = self.rt.get_rows(${K}, "rows").len().saturating_sub(1);`,
          '            let next = if key.code == KeyCode::Up {',
          '                cur.saturating_sub(1)',
          '            } else {',
          '                (cur + 1).min(last)',
          '            };',
          `            ${st}.select(Some(next));`,
          '        }',
          '    }',
          '    _ => {}',
          '}',
        ]);
        break;
      }
      default:
        break;
    }
  }

  // ── Widgets ─────────────────────────────────────────────────────────────────

  private key(node: IRNode): string {
    return rustStr(keyOf(node));
  }

  /** Block builder expression, or null when the node needs none. */
  private blockExpr(node: IRNode, o: { container?: boolean; focus?: Focusable }): string | null {
    const parts = ['Block::default()'];
    const b = node.style.border;
    if (b) {
      parts.push(`.borders(${bordersExpr(b)})`, `.border_type(${borderType(b.kind)})`);
      const base = b.color ? `Style::default().fg(${color(b.color)})` : 'Style::default()';
      if (o.focus)
        parts.push(`.border_style(focus_border(${base}, app.focus == Some(${o.focus.name})))`);
      else if (b.color) parts.push(`.border_style(${base})`);
    }
    if (o.container) {
      const p = node.layout.padding;
      if (p.top + p.right + p.bottom + p.left > 0) {
        parts.push(
          `.padding(Padding::new(${u16(p.left)}, ${u16(p.right)}, ${u16(p.top)}, ${u16(p.bottom)}))`
        );
      }
      if (b && b.top) {
        if (node.type === 'Modal') {
          parts.push(`.title(st.text(${this.key(node)}, "title"))`);
        } else if (node.type !== 'Screen' && node.name !== node.type && node.name.trim()) {
          parts.push(`.title(${rustStr(node.name)})`);
        }
      }
      if (node.style.fg || node.style.bg)
        parts.push(
          `.style(${styleExpr({ ...node.style, bold: false, italic: false, underline: false, strikethrough: false })})`
        );
    }
    return parts.length === 1 ? null : parts.join('');
  }

  private chain(prefix: string, parts: string[], suffix: string): void {
    const w = this.w;
    if (parts.length === 1) {
      w.line(`${prefix}${parts[0]}${suffix}`);
      return;
    }
    w.line(`${prefix}${parts[0]}`).indent();
    parts.forEach((p, i) => {
      if (i > 0) w.line(i === parts.length - 1 ? `${p}${suffix}` : p);
    });
    w.dedent();
  }

  private render(parts: string[], area: string, state?: string): void {
    const w = this.w;
    w.line(
      state ? `${this.target}.render_stateful_widget(` : `${this.target}.render_widget(`
    ).indent();
    if (parts.length === 1) {
      w.line(`${parts[0]},`);
    } else {
      w.line(parts[0]).indent();
      parts.slice(1).forEach((p, i, rest) => w.line(i === rest.length - 1 ? `${p},` : p));
      w.dedent();
    }
    w.line(`${area},`);
    if (state) w.line(`${state},`);
    w.dedent().line(');');
  }

  /** Style of a widget: the design, dimmed while muted. */
  private styled(node: IRNode): string {
    const base = styleExpr(node.style);
    return canMute(node) ? `dim_if(${base}, st.muted(${this.key(node)}))` : base;
  }

  private paragraph(
    node: IRNode,
    text: string,
    a: string,
    opts: { align?: 'left' | 'center' | 'right' } = {}
  ): void {
    const f = this.focusOf.get(node.id);
    const bordered = !!node.style.border;
    const base = this.styled(node);
    const style = f && !bordered ? `focus_style(${base}, app.focus == Some(${f.name}))` : base;
    const parts = [`Paragraph::new(${text})`];
    if (style !== 'Style::default()') parts.push(`.style(${style})`);
    const align = opts.align ?? 'left';
    if (align !== 'left')
      parts.push(`.alignment(Alignment::${align === 'center' ? 'Center' : 'Right'})`);
    if (node.wrapText) parts.push('.wrap(Wrap { trim: false })');
    const blk = this.blockExpr(node, { focus: bordered ? f : undefined });
    if (blk) parts.push(`.block(${blk})`);
    this.render(parts, a);
  }

  private stateful(
    node: IRNode,
    head: string,
    extra: string[],
    a: string,
    stateField: string,
    highlight: string
  ): void {
    const f = this.focusOf.get(node.id);
    const base = this.styled(node);
    const parts = [head];
    if (base !== 'Style::default()') parts.push(`.style(${base})`);
    parts.push(...extra);
    parts.push(
      f
        ? `.${highlight}(focus_style(Style::default().add_modifier(Modifier::BOLD), app.focus == Some(${f.name})))`
        : `.${highlight}(Style::default().add_modifier(Modifier::BOLD))`
    );
    const blk = this.blockExpr(node, { focus: node.style.border ? f : undefined });
    if (blk) {
      // A table keeps one cell of padding inside its border, like Textual's.
      parts.push(`.block(${blk}${node.type === 'Table' ? '.padding(Padding::horizontal(1))' : ''})`);
    }
    this.render(parts, a, stateField);
  }

  private leaf(node: IRNode, a: string): void {
    const id = node.ident;
    const up = id.toUpperCase();
    const K = this.key(node);
    const w = this.w;
    switch (node.type) {
      case 'Text':
        this.paragraph(node, `st.text(${K}, "text")`, a, { align: node.textAlign });
        break;
      case 'Button': {
        const left = node.iconLeft ? `${node.iconLeft} ` : '';
        const right = node.iconRight ? ` ${node.iconRight}` : '';
        const label =
          left || right
            ? `format!("{}{}{}", ${rustStr(left)}, st.text(${K}, "label"), ${rustStr(right)})`
            : `st.text(${K}, "label")`;
        this.paragraph(node, label, a, { align: 'center' });
        break;
      }
      case 'Breadcrumb':
        this.paragraph(node, rustStr(inlineText(node)), a);
        break;
      case 'Checkbox':
      case 'Radio':
      case 'Toggle': {
        const flag = `st.boolean(${K}, "checked")`;
        const label = `st.text(${K}, "label")`;
        let expr: string;
        if (node.type === 'Toggle') {
          expr = `format!("{} {}", if ${flag} { "[ON ]" } else { "[OFF]" }, ${label})`;
        } else {
          const [open, close] = node.type === 'Checkbox' ? ['[', ']'] : ['(', ')'];
          expr = `format!("${open}{}${close} {}", if ${flag} { ${rustStr(node.glyphs.on)} } else { ${rustStr(node.glyphs.off)} }, ${label})`;
        }
        this.paragraph(node, expr, a);
        break;
      }
      case 'Select':
        if (node.style.border) {
          // Like Textual: two cells of padding, the arrow at the right edge.
          w.line(`let ${id}_value = st.text(${K}, "value");`);
          w.line(`let ${id}_room = (${a}.width as usize).saturating_sub(2);`);
          w.line(
            `let ${id}_line = format!("  {}{}▼  ", ${id}_value, " ".repeat(${id}_room.saturating_sub(${id}_value.chars().count() + 5)));`
          );
          this.paragraph(node, `${id}_line`, a);
        } else {
          this.paragraph(node, `format!("{} ▾", st.text(${K}, "value"))`, a);
        }
        break;
      case 'Spinner':
        this.paragraph(
          node,
          `format!("{} {}", SPINNER_FRAMES[(app.tick / 3) % SPINNER_FRAMES.len()], st.text(${K}, "label"))`,
          a
        );
        break;
      case 'TextInput': {
        const f = this.focusOf.get(node.id);
        const bordered = !!node.style.border;
        const value = `st.text(${K}, "value")`;
        w.line(`let ${id}_text = if ${value}.is_empty() {`).indent();
        w.line(
          `Span::styled(st.text(${K}, "placeholder"), Style::default().fg(Color::Rgb(128, 128, 128)))`
        ).dedent();
        w.line('} else {').indent();
        w.line(`Span::raw(${value})`).dedent();
        w.line('};');
        let inner = a;
        let blockVar = '';
        if (bordered) {
          blockVar = `${id}_block`;
          this.chain(
            `let ${blockVar} = `,
            [`${this.blockExpr(node, { focus: f }) as string}.padding(Padding::horizontal(2))`],
            ';'
          );
          inner = `${id}_inner`;
          w.line(`let ${inner} = ${blockVar}.inner(${a});`);
        }
        const base = this.styled(node);
        const style = f && !bordered ? `focus_style(${base}, app.focus == Some(${f.name}))` : base;
        const parts = [`Paragraph::new(${id}_text)`];
        if (style !== 'Style::default()') parts.push(`.style(${style})`);
        if (bordered) parts.push(`.block(${blockVar})`);
        this.render(parts, a);
        if (f) {
          w.line(`if app.focus == Some(${f.name}) {`).indent();
          w.line(`${this.target}.set_cursor_position((`).indent();
          w.line(
            `${inner}.x + (app.${id}_cursor.min(${value}.chars().count()) as u16).min(${inner}.width.saturating_sub(1)),`
          );
          w.line(`${inner}.y,`).dedent();
          w.line('));').dedent().line('}');
        }
        break;
      }
      case 'ProgressBar': {
        const gauge = node.style.fg ? color(node.style.fg) : 'Color::Rgb(80, 200, 120)';
        w.line(`let ${id}_ratio = {`).indent();
        w.line(`let max = st.float(${K}, "max");`);
        w.line(`if max > 0.0 { (st.float(${K}, "value") / max).clamp(0.0, 1.0) } else { 0.0 }`);
        w.dedent().line('};');
        // `████░░░░  50%`: filled blocks in the bar colour, the rest dim, the percentage in 5 cells.
        const border = node.style.border ? 2 : 0;
        w.line(`let ${id}_room = (${a}.width as usize).saturating_sub(${border + 5}).max(1);`);
        w.line(`let ${id}_filled = ((${id}_ratio * ${id}_room as f64).round() as usize).min(${id}_room);`);
        w.line(`let ${id}_pct = format!("{}%", (${id}_ratio * 100.0).round() as u32);`);
        const parts = [
          'Paragraph::new(Line::from(vec![',
          `Span::styled("█".repeat(${id}_filled), Style::default().fg(${gauge})${node.style.bg ? `.bg(${color(node.style.bg)})` : ''}),`,
          `Span::styled("░".repeat(${id}_room - ${id}_filled), Style::default().fg(Color::DarkGray)),`,
          `Span::raw(format!("{:>5}", ${id}_pct)),`,
          ']))',
        ];
        const blk = this.blockExpr(node, {});
        if (blk) parts.push(`.block(${blk})`);
        this.render(parts, a);
        break;
      }
      case 'List': {
        w.line(`let ${id}_items = st.list(${K}, "items");`);
        w.line(`app.${id}_state.select(if ${id}_items.is_empty() {`).indent();
        w.line('None').dedent();
        w.line('} else {').indent();
        w.line(
          `Some((st.int(${K}, "selected").max(0) as usize).min(${id}_items.len() - 1))`
        ).dedent();
        w.line('});');
        this.stateful(
          node,
          `List::new(${id}_items.to_vec())`,
          [],
          a,
          `&mut app.${id}_state`,
          'highlight_style'
        );
        break;
      }
      case 'Menu':
        w.line(`app.${id}_state.select(if ${up}_ITEMS.is_empty() {`).indent();
        w.line('None').dedent();
        w.line('} else {').indent();
        w.line(
          `Some((st.int(${K}, "selected").max(0) as usize).min(${up}_ITEMS.len().saturating_sub(1)))`
        ).dedent();
        w.line('});');
        this.stateful(
          node,
          `List::new(${up}_ITEMS.to_vec())`,
          ['.highlight_symbol("> ")'],
          a,
          `&mut app.${id}_state`,
          'highlight_style'
        );
        break;
      case 'Tree':
        this.stateful(
          node,
          `List::new(${up}_ITEMS.to_vec())`,
          ['.highlight_symbol("> ")'],
          a,
          `&mut app.${id}_state`,
          'highlight_style'
        );
        break;
      case 'Tabs': {
        // One row of labels (a cell of padding on both sides of each) and, when there is no
        // border, an underline row below it with the active tab marked, like Textual's.
        const underline = !node.style.border;
        const bar = underline ? `${id}_bar` : a;
        if (underline) w.line(`let ${bar} = Rect { height: ${a}.height.min(1), ..${a} };`);
        this.stateful(
          node,
          `Tabs::new(${up}_TABS.to_vec())`,
          [
            `.select(st.int(${K}, "active_tab").max(0) as usize)`,
            '.padding(" ", " ")',
            '.divider("")',
          ],
          bar,
          '',
          'highlight_style'
        );
        if (underline) {
          w.line(`if ${a}.height > 1 {`).indent();
          w.line(`let ${id}_active = (st.int(${K}, "active_tab").max(0) as usize).min(${up}_TABS.len().saturating_sub(1));`);
          w.line(
            `let ${id}_before: usize = ${up}_TABS.iter().take(${id}_active).map(|t| t.chars().count() + 2).sum();`
          );
          w.line(
            `let ${id}_span = ${up}_TABS.get(${id}_active).map_or(0, |t| t.chars().count() + 2);`
          );
          w.line(
            `let ${id}_rest = (${a}.width as usize).saturating_sub(${id}_before + ${id}_span);`
          );
          w.line(`let ${id}_rule = format!(`).indent();
          w.line('"{}{}{}{}",');
          w.line(`"━".repeat(${id}_before.min(${a}.width as usize)),`);
          w.line(`if ${id}_span > 0 { "╸" } else { "" },`);
          w.line(`"━".repeat(${id}_span.saturating_sub(2)),`);
          w.line(`if ${id}_span > 1 { "╺" } else { "" },`);
          w.dedent().line(');');
          w.line(
            `${this.target}.render_widget(Paragraph::new(format!("{}{}", ${id}_rule, "━".repeat(${id}_rest))), Rect { y: ${a}.y + 1, height: 1, ..${a} });`
          );
          w.dedent().line('}');
        }
        break;
      }
      case 'Table': {
        w.line(`let ${id}_cols = st.list(${K}, "columns");`);
        w.line(`let ${id}_rows = st.rows(${K}, "rows");`);
        w.line(
          `let ${id}_n = ${id}_rows.iter().map(|r| r.len()).chain([${id}_cols.len()]).max().unwrap_or(1).max(1);`
        );
        // Column width: the longest cell or heading of the column.
        w.line(`let ${id}_w: Vec<usize> = (0..${id}_n)`).indent();
        w.line('.map(|c| {').indent();
        w.line(`${id}_rows`).indent();
        w.line('.iter()');
        w.line('.map(|r| r.get(c).map_or(0, |s| s.chars().count()))');
        w.line(`.chain(${id}_cols.get(c).map(|s| s.chars().count()))`);
        w.line('.max()');
        w.line('.unwrap_or(0)');
        w.line('.max(3)').dedent();
        w.dedent().line('})');
        w.line('.collect();').dedent();
        w.line(`app.${id}_state.select(if ${id}_rows.is_empty() {`).indent();
        w.line('None').dedent();
        w.line('} else {').indent();
        w.line(`Some(app.${id}_state.selected().unwrap_or(0).min(${id}_rows.len() - 1))`).dedent();
        w.line('});');
        const extra = ['.column_spacing(2)'];
        if (node.columns.length) {
          w.line(
            `let ${id}_head = Row::new((0..${id}_n).map(|c| Cell::from(${id}_cols.get(c).cloned().unwrap_or_default())))`
          ).indent();
          w.line('.style(Style::default().add_modifier(Modifier::BOLD));').dedent();
          extra.push(`.header(${id}_head)`);
        }
        this.stateful(
          node,
          `Table::new(${id}_rows.iter().map(|r| Row::new(r.clone())), ${id}_w.iter().map(|w| Constraint::Length(*w as u16)).collect::<Vec<_>>())`,
          extra,
          a,
          `&mut app.${id}_state`,
          'row_highlight_style'
        );
        break;
      }
      default:
        break;
    }
  }

  // ── Containers and layout ───────────────────────────────────────────────────

  private emit(node: IRNode, expr: string): void {
    if (!renders(node)) return;
    const w = this.w;
    const hideable = !!node.tag && node !== this.root && node.type !== 'Modal';
    if (hideable) w.line(`if st.shown(${this.key(node)}) {`).indent();
    const a = `${node.ident}_area`;
    w.line(`let ${a} = ${expr};`);
    const focusable = this.focusOf.get(node.id);
    if (focusable) {
      w.line(
        `app.hits.push(Hit { rect: ${a}, focus: ${focusable.name}, modal: ${this.inModal}, scrolls: ${this.target === 'cv'} });`
      );
    }
    if (
      node.type === 'Screen' ||
      node.type === 'Box' ||
      node.type === 'Grid' ||
      node.type === 'Modal'
    ) {
      this.container(node, a);
    } else this.leaf(node, a);
    if (hideable) w.dedent().line('}');
  }

  private container(node: IRNode, a: string): void {
    const w = this.w;
    const id = node.ident;
    const kids = contentKids(node);
    const kidsRender = kids.some(renders);
    const blk =
      needsBlock(node) || node.type === 'Modal' ? this.blockExpr(node, { container: true }) : null;
    const l = node.layout;
    const snapshot = l.mode === 'absolute' || (l.mode === 'flex' && l.wrap);
    if (node === this.root) this.rootOuter = a;
    let inner = a;
    if (blk) {
      if (kidsRender && !snapshot) {
        this.chain(`let ${id}_block = `, [blk], ';');
        w.line(`let ${id}_inner = ${id}_block.inner(${a});`);
        w.line(`${this.target}.render_widget(${id}_block, ${a});`);
        inner = `${id}_inner`;
      } else {
        w.line(`${this.target}.render_widget(${blk}, ${a});`);
      }
    }
    if (!kidsRender) return;

    if (l.mode === 'grid') {
      this.grid(node, kids, inner);
    } else if (snapshot) {
      this.strategies.push(
        `${id}: snapshot (${l.mode === 'absolute' ? 'absolute' : 'wrapping flex'} layout at the editor's positions)`
      );
      for (const k of kids) {
        if (!renders(k)) continue;
        const r = k.rel ?? {
          x: k.layout.x,
          y: k.layout.y,
          width: typeof k.width === 'number' ? k.width : 10,
          height: typeof k.height === 'number' ? k.height : 1,
        };
        this.emit(
          k,
          `clamp_rect(${a}, ${u16(r.x)}, ${u16(r.y)}, ${u16(r.width)}, ${u16(r.height)})`
        );
      }
    } else {
      this.flex(node, kids, inner);
    }
  }

  /** Size of a child along the main axis of its container. */
  private mainConstraint(k: IRNode, vertical: boolean): string {
    const d = vertical ? k.height : k.width;
    if (typeof d === 'number') return `Constraint::Length(${u16(d)})`;
    if (d === 'fill') return 'Constraint::Fill(1)';
    let b = k.box ? (vertical ? k.box.height : Math.max(k.box.width, intrinsicWidth(k))) : null;
    // A table shows its heading (two rows) and every row; the editor's box can be smaller.
    if (b !== null && vertical && k.type === 'Table') {
      b = Math.max(b, (k.style.border ? 2 : 0) + (k.columns.length ? 1 : 0) + k.rows.length);
    }
    // Tabs: the labels and the underline (the editor draws a box of three rows).
    if (b !== null && vertical && k.type === 'Tabs') b = k.style.border ? 3 : 2;
    // A bordered progress bar has a row for the bar between its borders.
    if (b !== null && vertical && k.type === 'ProgressBar' && k.style.border) b = Math.max(b, 3);
    return b === null ? 'Constraint::Min(0)' : `Constraint::Length(${u16(b)})`;
  }

  /** Width (a Rust expression) of a component the program can change, from its current text. */
  private dynamicWidth(k: IRNode): string | null {
    if (!k.tag) return null;
    const K = this.key(k);
    const b = k.style.border ? 2 : 0;
    if (k.type === 'Button') {
      const left = k.iconLeft ? `${k.iconLeft} ` : '';
      const right = k.iconRight ? ` ${k.iconRight}` : '';
      return `button_width(&format!("{}{}{}", ${rustStr(left)}, st.text(${K}, "label"), ${rustStr(right)}), ${b})`;
    }
    if (k.type === 'Table')
      return `table_width(st.list(${K}, "columns"), st.rows(${K}, "rows"), ${b})`;
    return null;
  }

  /** The screen's content scrolls when it is a column of fixed-size children. */
  private rootScrolls(): boolean {
    const r = this.root;
    const l = r.layout;
    if (r.type !== 'Screen' || l.mode !== 'flex' || l.wrap || l.direction !== 'column')
      return false;
    if (l.justify !== 'start') return false;
    const kids = contentKids(r);
    return (
      kids.some(renders) &&
      kids.every((k) => /^Constraint::Length\(/.test(this.mainConstraint(k, true)))
    );
  }

  private flex(node: IRNode, kids: IRNode[], inner: string): void {
    const l = node.layout;
    const id = node.ident;
    const vertical = l.direction === 'column';
    const flex = {
      start: 'Start',
      center: 'Center',
      end: 'End',
      'space-between': 'SpaceBetween',
      'space-around': 'SpaceAround',
    }[l.justify];
    // Children with a code name can be hidden by the program: their space is given back.
    const dynamic = kids.some((k) => k.tag && renders(k));
    this.strategies.push(
      `${id}: native ${vertical ? 'column' : 'row'} (Layout, Flex::${flex}${l.gap ? `, spacing ${l.gap}` : ''}${dynamic ? ', hideable children' : ''})`
    );
    const constraints = kids.map((k) => this.mainConstraint(k, vertical));
    const parts = [
      'Layout::default()',
      `.direction(Direction::${vertical ? 'Vertical' : 'Horizontal'})`,
      `.flex(Flex::${flex})`,
    ];
    if (l.gap > 0) parts.push(`.spacing(${u16(l.gap)})`);
    if (dynamic) {
      const shown = kids.map((k) => (k.tag ? `st.shown(${this.key(k)})` : 'true'));
      this.w.line(`let ${id}_show = [${shown.join(', ')}];`);
      this.w.line(`let ${id}_slot = slots(&${id}_show);`);
      this.w.line(`let ${id}_cs: Vec<Constraint> = [${constraints.join(', ')}]`).indent();
      this.w.line(`.iter()`);
      this.w.line(`.zip(${id}_show.iter())`);
      this.w.line('.filter(|(_, s)| **s)');
      this.w.line('.map(|(c, _)| *c)');
      this.w.line('.collect();').dedent();
      parts.push(`.constraints(${id}_cs)`, `.split(${inner})`);
    } else {
      parts.push(`.constraints([${constraints.join(', ')}])`, `.split(${inner})`);
    }
    // Fixed sizes that do not fit the terminal are cut off at its edge (like the editor shows the
    // design), not squeezed until the text is gone. Only for containers without flexible children.
    const lengths = constraints.map((c) => /^Constraint::Length\((\d+)\)$/.exec(c)?.[1]);
    const scrollRoot = node === this.root && this.scrollable;
    const clip =
      !scrollRoot &&
      l.justify === 'start' &&
      lengths.every((x) => x !== undefined) &&
      lengths.length > 0;
    let area = inner;
    if (scrollRoot) {
      // The whole content is laid out at full size on an off-screen canvas; the part that is
      // scrolled into view is copied to the screen afterwards.
      const need = dynamic
        ? `${id}_cs.iter().map(|c| match c { Constraint::Length(n) => *n, _ => 0 }).sum::<u16>() + ${u16(l.gap)} * (${id}_cs.len().saturating_sub(1) as u16)`
        : String(u16(lengths.reduce((sum, x) => sum + Number(x), 0) + l.gap * (kids.length - 1)));
      area = `${id}_virt`;
      this.w.line(`let ${id}_need: u16 = ${need};`);
      this.w.line(
        `let ${area} = Rect::new(0, 0, ${inner}.width, ${id}_need.max(${inner}.height));`
      );
      this.w.line(`app.view = ${inner};`);
      this.w.line(`app.scroll_max = ${id}_need.saturating_sub(${inner}.height);`);
      this.w.line('app.scroll = app.scroll.min(app.scroll_max);');
      this.w.line(`let mut cv = Canvas::new(${area});`);
      parts[parts.length - 1] = `.split(${area})`;
      this.target = 'cv';
    }
    if (clip) {
      const need = lengths.reduce((sum, x) => sum + Number(x), 0) + l.gap * (kids.length - 1);
      area = `${id}_virt`;
      this.w.line(
        vertical
          ? `let ${area} = Rect { height: ${inner}.height.max(${u16(need)}), ..${inner} };`
          : `let ${area} = Rect { width: ${inner}.width.max(${u16(need)}), ..${inner} };`
      );
      parts[parts.length - 1] = `.split(${area})`;
    }
    this.chain(`let ${id}_cells = `, parts, ';');
    const ax = l.align === 'center' ? 1 : l.align === 'end' ? 2 : 0;
    kids.forEach((k, i) => {
      if (!renders(k)) return;
      const raw = dynamic ? `${id}_cells[${id}_slot[${i}]]` : `${id}_cells[${i}]`;
      const cell = clip ? `${raw}.intersection(${inner})` : raw;
      const cross = vertical ? k.width : k.height;
      let expr = cell;
      // Components the program can write to (code name) get the whole cross axis when aligned to
      // the start, so a longer text is not cut off at the width of the design's text.
      const open =
        cross === 'auto' &&
        !!k.tag &&
        l.align === 'start' &&
        k.type !== 'Box' &&
        k.type !== 'Grid' &&
        !this.dynamicWidth(k);
      // Lists, selects and tabs fill the width of their parent (as in Textual).
      const fills =
        cross === 'auto' && FILLS_WIDTH.has(k.type) && (l.align === 'start' || l.align === 'stretch');
      const dyn = vertical && cross === 'auto' && l.align === 'start' ? this.dynamicWidth(k) : null;
      if (dyn) {
        expr = `aligned(${cell}, ${dyn}, u16::MAX, ${ax}, 0)`;
      } else if (!(cross === 'fill' || open || fills || (cross === 'auto' && l.align === 'stretch'))) {
        const size =
          typeof cross === 'number'
            ? cross
            : k.box
              ? vertical
                ? Math.max(k.box.width, intrinsicWidth(k))
                : k.box.height
              : null;
        if (size !== null) {
          expr = vertical
            ? `aligned(${cell}, ${u16(size)}, u16::MAX, ${ax}, 0)`
            : `aligned(${cell}, u16::MAX, ${u16(size)}, 0, ${ax})`;
        }
      }
      this.emit(k, expr);
    });
    if (scrollRoot) {
      this.target = 'frame';
      const a = this.rootOuter;
      this.w.line(`cv.blit(frame, ${inner}, app.scroll);`);
      this.w.line('if app.scroll_max > 0 {').indent();
      this.w.line(`let mut ${id}_bar = ScrollbarState::new(app.scroll_max as usize + 1)`).indent();
      this.w.line('.position(app.scroll as usize)');
      this.w.line(`.viewport_content_length(${inner}.height as usize);`).dedent();
      this.w.line('frame.render_stateful_widget(').indent();
      this.w.line('Scrollbar::new(ScrollbarOrientation::VerticalRight)').indent();
      this.w.line('.begin_symbol(None)');
      this.w.line('.end_symbol(None)');
      this.w.line('.track_symbol(Some("│"))');
      this.w.line('.thumb_symbol("█"),').dedent();
      this.w.line(`Rect { x: ${a}.x, y: ${inner}.y, width: ${a}.width, height: ${inner}.height },`);
      this.w.line(`&mut ${id}_bar,`).dedent();
      this.w.line(');').dedent().line('}');
    }
  }

  private grid(node: IRNode, kids: IRNode[], inner: string): void {
    const l = node.layout;
    const id = node.ident;
    const cols = Math.max(1, l.columns);
    const rows = Math.max(l.rows, Math.ceil(kids.length / cols), 1);
    this.strategies.push(`${id}: native grid ${cols}x${rows} (nested row/column Layouts)`);
    const fills = (n: number) => Array.from({ length: n }, () => 'Constraint::Fill(1)').join(', ');
    const vparts = ['Layout::default()', '.direction(Direction::Vertical)'];
    if (l.rowGap > 0) vparts.push(`.spacing(${u16(l.rowGap)})`);
    vparts.push(`.constraints([${fills(rows)}])`, `.split(${inner})`);
    this.chain(`let ${id}_rows = `, vparts, ';');
    for (let r = 0; r < rows; r++) {
      const rowKids = kids.slice(r * cols, (r + 1) * cols);
      if (!rowKids.some(renders)) continue;
      const hparts = ['Layout::default()', '.direction(Direction::Horizontal)'];
      if (l.columnGap > 0) hparts.push(`.spacing(${u16(l.columnGap)})`);
      hparts.push(`.constraints([${fills(cols)}])`, `.split(${id}_rows[${r}])`);
      this.chain(`let ${id}_row${r} = `, hparts, ';');
      rowKids.forEach((k, c) => {
        if (!renders(k)) return;
        const cell = `${id}_row${r}[${c}]`;
        const wn = typeof k.width === 'number' ? u16(k.width) : null;
        const hn = typeof k.height === 'number' ? u16(k.height) : null;
        this.emit(
          k,
          wn === null && hn === null
            ? cell
            : `aligned(${cell}, ${wn ?? 'u16::MAX'}, ${hn ?? 'u16::MAX'}, 0, 0)`
        );
      });
    }
  }

  private modal(m: IRNode): void {
    const w = this.w;
    const id = m.ident;
    const wd =
      typeof m.width === 'number'
        ? String(u16(m.width))
        : m.width === 'fill'
          ? 'area.width'
          : String(u16(m.box?.width ?? 40));
    const hd =
      typeof m.height === 'number'
        ? String(u16(m.height))
        : m.height === 'fill'
          ? 'area.height'
          : String(u16(m.box?.height ?? 12));
    this.strategies.push(`${id}: modal overlay (Clear, centered over the whole screen)`);
    w.line(`if st.modal_open(${this.key(m)}) {`).indent();
    w.line(`let ${id}_area = centered(area, ${wd}, ${hd});`);
    w.line(`frame.render_widget(Clear, ${id}_area);`);
    this.inModal = true;
    const before = this.target;
    this.target = 'frame';
    this.container(m, `${id}_area`);
    this.target = before;
    this.inModal = false;
    w.dedent().line('}');
  }

  // ── Whole file ──────────────────────────────────────────────────────────────

  /** `src/ui.rs`: the typed facade of the design. */
  buildFacade(): string {
    const nodes = walkIR(this.root).filter((n) => n !== this.root && needsSeed(n));
    const out = new CodeWriter('    ');
    out.line('/// One typed handle per component with a code name, plus the lifecycle of the UI.');
    out.line('#[derive(Clone)]');
    out.line('pub struct Ui {').indent();
    out.line('_runtime: Runtime,');
    for (const h of this.handles) out.line(`pub ${h.field}: ${HANDLE_TYPE[h.node.type]},`);
    out.dedent().line('}').line();
    out.line('impl Ui {').indent();
    out.line('/// The state of the UI without a running UI; see `start` and `run`.');
    out.line('pub fn new() -> Ui {').indent();
    out.line('let rt = Runtime::new();');
    out.line('rt.seed(seeds());');
    out.line('Ui {').indent();
    for (const h of this.handles) {
      out.line(`${h.field}: ${HANDLE_TYPE[h.node.type]}::new(&rt, ${rustStr(h.node.tag!)}),`);
    }
    out.line('_runtime: rt,');
    out.dedent().line('}').dedent().line('}').line();
    out.block(`pub fn runtime(&self) -> &Runtime {
    &self._runtime
}

/// Start the UI in its own thread and return when it is ready.
pub fn start() -> Result<Ui, UiError> {
    let ui = Ui::new();
    let worker = ui.clone();
    thread::Builder::new()
        .name("ui".to_string())
        .spawn(move || {
            let _ = worker.serve();
        })
        .map_err(|e| UiError::new(e.to_string()))?;
    ui._runtime.wait_ready(Duration::from_secs(10))?;
    Ok(ui)
}

/// Run the UI on the current thread and \`program\` in a worker thread; returns when the UI closes.
pub fn run<F>(&self, program: F) -> Result<(), UiError>
where
    F: FnOnce(Ui) + Send + 'static,
{
    self._runtime.install_panic_hook();
    let ui = self.clone();
    thread::Builder::new()
        .name("program".to_string())
        .spawn(move || program(ui))
        .map_err(|e| UiError::new(e.to_string()))?;
    self.serve().map_err(|e| UiError::new(e.to_string()))
}

/// The UI loop on the current thread, until the UI is closed.
pub fn serve(&self) -> io::Result<()> {
    let mut terminal = match ratatui::try_init() {
        Ok(terminal) => terminal,
        Err(e) => {
            self._runtime.mark_failed(&e.to_string());
            return Err(e);
        }
    };
    // Mouse clicks; the capture is switched off again on exit and when the program crashes.
    let _ = execute!(io::stdout(), EnableMouseCapture);
    let screen_hook = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        let _ = execute!(io::stdout(), DisableMouseCapture);
        screen_hook(info);
    }));
    install_hook();
    self._runtime.mark_ready();
    let mut app = App::new(self._runtime.clone());
    let result = panic::catch_unwind(AssertUnwindSafe(|| {
        run_loop(&mut terminal, &mut app, read_event, |_| {})
    }));
    let _ = execute!(io::stdout(), DisableMouseCapture);
    ratatui::restore();
    self._runtime.mark_closed();
    match result {
        Ok(r) => r,
        Err(_) => Err(io::Error::other("the UI loop panicked")),
    }
}

/// Close the UI.
pub fn stop(&self) {
    self._runtime.stop();
}

/// Block until the UI is closed.
pub fn wait(&self) {
    self._runtime.wait_closed();
}

pub fn ready(&self) -> bool {
    self._runtime.is_ready()
}

pub fn running(&self) -> bool {
    self._runtime.is_running()
}

/// Open the error dialog with \`error\`; it is added to \`errors()\` and the log.
pub fn report(&self, error: impl fmt::Display) {
    self._runtime.report(&error.to_string());
}

pub fn errors(&self) -> Vec<ErrorEntry> {
    self._runtime.errors()
}

pub fn log(&self) -> Log {
    Log::new(&self._runtime)
}

/// The queue of all events of all components (the alternative to handlers).
pub fn events(&self) -> Events {
    self._runtime.events()
}

pub fn next_event(&self, timeout: Duration) -> Option<Event> {
    self._runtime.events().next(timeout)
}

/// Report panics of your own threads in the error dialog instead of printing them.
pub fn install_panic_hook(&self) {
    self._runtime.install_panic_hook();
}`);
    out.dedent().line('}').line();
    out.block(`impl Default for Ui {
    fn default() -> Self {
        Ui::new()
    }
}
`);
    out.line('/// What the design contains when the UI opens.');
    out.line('fn seeds() -> Vec<Seed> {').indent();
    out.line('vec![').indent();
    for (const n of nodes) {
      const code = seedCode(n).split('\n');
      code.forEach((l, i) => out.line(i === code.length - 1 ? `${l},` : l));
    }
    out.dedent().line(']').dedent().line('}');
    const body = out.toString();
    const code = stripLiterals(body);
    const used = (names: string[]) =>
      names.filter((n) => new RegExp(`(?<!::)\\b${n}\\b`).test(code));
    const runtimeNames = used([
      'ButtonHandle',
      'CheckHandle',
      'ContainerHandle',
      'ErrorEntry',
      'Event',
      'Events',
      'InputHandle',
      'ListHandle',
      'Log',
      'MenuHandle',
      'ModalHandle',
      'ProgressHandle',
      'Runtime',
      'Seed',
      'SelectHandle',
      'SpinnerHandle',
      'State',
      'TableHandle',
      'TabsHandle',
      'TextHandle',
      'TreeHandle',
      'UiError',
      'Value',
      'install_hook',
    ]);
    const head = [
      '// The program API of the design (src/ui_runtime.rs does the work; this file is generated).',
      '//',
      '//     let ui = Ui::start()?;                  // UI runs in its own thread',
      '//     ui.submit_btn.on_click(|e| { /* ... */ });',
      '//     ui.status.set_text("Ready");',
      '//     ui.wait();',
      '',
      '#![allow(dead_code)]',
      '',
      `use crate::ui_runtime::{${runtimeNames.join(', ')}};`,
      'use crate::{read_event, run_loop, App};',
      'use ratatui::crossterm::event::{DisableMouseCapture, EnableMouseCapture};',
      'use ratatui::crossterm::execute;',
      'use std::fmt;',
      'use std::io;',
      'use std::panic::{self, AssertUnwindSafe};',
      'use std::thread;',
      'use std::time::Duration;',
      '',
      '',
    ].join('\n');
    return head + body;
  }

  build(): string {
    this.collectHandles();
    this.scrollable = this.rootScrolls();
    this.collect(this.root);
    this.modals.filter((m) => m.visible).forEach((m) => this.collect(m, m));
    const openModals = this.modals.filter((m) => m.visible);

    // ui body
    const w = this.w;
    w.line('let st = app.rt.lock();');
    if (this.focus.length) w.line('app.hits.clear();');
    if (this.selects.length) w.line('app.popup = None;');
    w.line('let full = frame.area();');
    w.line('let area = if st.log_visible() {').indent();
    w.line('let parts = Layout::default()').indent();
    w.line('.direction(Direction::Vertical)');
    w.line('.constraints([');
    w.indent().line('Constraint::Fill(1),');
    w.line('Constraint::Length((full.height / 3).max(3).min(full.height)),').dedent();
    w.line('])');
    w.line('.split(full);').dedent();
    w.line('render_log(frame, &st, parts[1]);');
    w.line('parts[0]').dedent();
    w.line('} else {').indent();
    w.line('full').dedent();
    w.line('};');
    if (renders(this.root)) this.emit(this.root, 'area');
    openModals.forEach((m) => this.modal(m));
    if (!renders(this.root) && !openModals.length) w.line('let _ = area;');
    for (const sel of this.selects) {
      const f = this.focusOf.get(sel.id)!;
      const K = this.key(sel);
      w.line(`if app.dropdown == Some(${f.name}) {`).indent();
      w.line(`let opts = st.list(${K}, "options");`);
      w.line(
        `match app.field_rect(${f.name}).filter(|_| !opts.is_empty() && st.state(${K}) == State::Active) {`
      ).indent();
      w.line('Some(field) => {').indent();
      w.line(
        'let popup = dropdown_area(field, opts.len(), opts.iter().map(|o| o.chars().count()).max().unwrap_or(0), full);'
      );
      w.line('frame.render_widget(Clear, popup);');
      w.line('app.dd_state.select(Some(app.dd_cursor.min(opts.len() - 1)));');
      w.line('frame.render_stateful_widget(').indent();
      w.line('List::new(opts.to_vec())').indent();
      w.line('.block(Block::default().borders(Borders::ALL))');
      w.line(`.style(${this.styled(sel)})`);
      w.line('.highlight_style(Style::default().add_modifier(Modifier::REVERSED))');
      w.line('.highlight_symbol("> "),').dedent();
      w.line('popup,');
      w.line('&mut app.dd_state,').dedent();
      w.line(');');
      w.line('app.popup = Some(popup);').dedent().line('}');
      w.line('None => app.dropdown = None,').dedent().line('}');
      w.dedent().line('}');
    }
    w.line('render_errors(frame, &st, full);');
    const ui = w.toString().replace(/\n$/, '');

    const out = new CodeWriter('    ');
    const n = this.focus.length;
    const textInputs = this.focus.filter((f) => f.node.type === 'TextInput');

    out.line('mod ui;');
    out.line('mod ui_runtime;');
    out.line();
    this.consts.forEach((c) => out.line(c));
    if (this.spinner) {
      out.line(
        'const SPINNER_FRAMES: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];'
      );
    }
    this.focus.forEach((f) => out.line(`const ${f.name}: usize = ${f.index};`));
    if (n) out.line(`const FOCUS_COUNT: usize = ${n};`);
    out.line();

    if (n) {
      out.block(`/// Where a focusable component was drawn this frame (for mouse clicks).
#[derive(Clone, Copy)]
struct Hit {
    rect: Rect,
    focus: usize,
    modal: bool,
    /// Drawn on the scrolling content: \`rect\` is in content coordinates, not screen cells.
    scrolls: bool,
}
`);
    }
    if (this.scrollable) {
      out.block(`/// Off-screen surface for the scrolling content; \`blit\` copies the visible part to the screen.
struct Canvas {
    buf: Buffer,
    cursor: Option<(u16, u16)>,
}

impl Canvas {
    fn new(area: Rect) -> Canvas {
        Canvas {
            buf: Buffer::empty(area),
            cursor: None,
        }
    }

    fn render_widget<W: Widget>(&mut self, widget: W, area: Rect) {
        widget.render(area, &mut self.buf);
    }

    fn render_stateful_widget<W: StatefulWidget>(
        &mut self,
        widget: W,
        area: Rect,
        state: &mut W::State,
    ) {
        widget.render(area, &mut self.buf, state);
    }

    fn set_cursor_position(&mut self, pos: (u16, u16)) {
        self.cursor = Some(pos);
    }

    /// Show the rows \`scroll..\` of the canvas in \`view\` on the screen.
    fn blit(&self, frame: &mut Frame, view: Rect, scroll: u16) {
        for dy in 0..view.height {
            for dx in 0..view.width {
                let from = (self.buf.area.x + dx, self.buf.area.y + scroll + dy);
                if let Some(src) = self.buf.cell(from) {
                    if let Some(dst) = frame.buffer_mut().cell_mut((view.x + dx, view.y + dy)) {
                        *dst = src.clone();
                    }
                }
            }
        }
        if let Some((x, y)) = self.cursor {
            if y >= scroll && y - scroll < view.height {
                frame.set_cursor_position((view.x + x, view.y + y - scroll));
            }
        }
    }
}
`);
    }

    // App struct
    out.line(
      '/// The state of the terminal UI: focus and cursors. Everything the program can see or'
    );
    out.line('/// change lives in the runtime store (`rt`).');
    out.line('struct App {').indent();
    out.line('rt: Runtime,');
    out.line('quit: bool,');
    if (this.focus.length) out.line('hits: Vec<Hit>,');
    if (this.scrollable) {
      out.line('/// Scroll offset of the content, its maximum, and where the content is shown.');
      out.line('scroll: u16,');
      out.line('scroll_max: u16,');
      out.line('view: Rect,');
    }
    if (this.selects.length) {
      out.line('/// The select whose list is open, the highlighted option and the list on screen.');
      out.line('dropdown: Option<usize>,');
      out.line('dd_cursor: usize,');
      out.line('dd_state: ListState,');
      out.line('popup: Option<Rect>,');
    }
    if (n) out.line('focus: Option<usize>,');
    out.line('tick: usize,');
    this.fields.forEach((f) => out.line(`${f.name}: ${f.type},`));
    out.dedent().line('}').line();

    out.line('impl App {').indent();
    out.line('fn new(rt: Runtime) -> Self {').indent();
    out.line('Self {').indent();
    out.line('rt,');
    out.line('quit: false,');
    if (n) out.line('hits: Vec::new(),');
    if (this.scrollable) {
      out.line('scroll: 0,');
      out.line('scroll_max: 0,');
      out.line('view: Rect::default(),');
    }
    if (this.selects.length) {
      out.line('dropdown: None,');
      out.line('dd_cursor: 0,');
      out.line('dd_state: ListState::default(),');
      out.line('popup: None,');
    }
    if (n) out.line('focus: None,');
    out.line('tick: 0,');
    this.fields.forEach((f) => out.line(`${f.name}: ${f.init},`));
    out.dedent().line('}').dedent().line('}').line();

    out.block(`/// The UI is over: the user quit or the program called \`stop()\`.
fn finished(&self) -> bool {
    self.quit || self.rt.is_closed()
}

fn on_tick(&mut self) {
    self.tick = self.tick.wrapping_add(1);
}
`);
    if (this.scrollable) {
      out.block(`/// Scroll the content by \`delta\` rows.
fn scroll_by(&mut self, delta: i32) {
    let next = (self.scroll as i32 + delta).clamp(0, self.scroll_max as i32);
    self.scroll = next as u16;
}
${
  n
    ? `
/// Scroll so that the component with \`focus\` is fully visible.
fn reveal(&mut self, focus: usize) {
    let Some(hit) = self.hits.iter().rev().find(|h| h.focus == focus && h.scrolls) else {
        return;
    };
    let (top, bottom) = (hit.rect.y, hit.rect.y + hit.rect.height);
    if top < self.scroll {
        self.scroll = top;
    } else if bottom > self.scroll + self.view.height {
        self.scroll = bottom.saturating_sub(self.view.height).min(top);
    }
    self.scroll = self.scroll.min(self.scroll_max);
}`
    : ''
}
`);
    }
    if (this.selects.length) {
      const keys = this.selects.map(
        (sel) => `${this.focusOf.get(sel.id)!.name} => Some(${rustStr(keyOf(sel))}),`
      );
      out.block(`/// Screen position of a focusable component (None when it is scrolled out of view).
fn field_rect(&self, focus: usize) -> Option<Rect> {
    let hit = self.hits.iter().rev().find(|h| h.focus == focus)?;
    if !hit.scrolls {
        return Some(hit.rect);
    }
    ${
      this.scrollable
        ? `let (top, bottom) = (self.scroll, self.scroll + self.view.height);
    if hit.rect.y < top || hit.rect.y >= bottom {
        return None;
    }
    Some(Rect::new(
        self.view.x + hit.rect.x,
        self.view.y + hit.rect.y - self.scroll,
        hit.rect.width,
        hit.rect.height.min(bottom - hit.rect.y),
    ))`
        : 'Some(hit.rect)'
    }
}

fn select_key(focus: usize) -> Option<&'static str> {
    match focus {
        ${keys.join('\n        ')}
        _ => None,
    }
}

/// Open the list of options of a select.
fn open_dropdown(&mut self, focus: usize, key: &str) {
    if !self.rt.accepts(key) {
        return;
    }
    let opts = self.rt.get_list(key, "options");
    if opts.is_empty() {
        return;
    }
    let value = self.rt.get_text(key, "value");
    self.dd_cursor = opts.iter().position(|o| *o == value).unwrap_or(0);
    self.dropdown = Some(focus);
}

/// Take the option; only a different one is a change.
fn choose_option(&mut self, key: &str, index: usize) {
    self.dropdown = None;
    let opts = self.rt.get_list(key, "options");
    if let Some(option) = opts.get(index) {
        if *option != self.rt.get_text(key, "value") {
            self.rt.user_set(key, "value", Value::Str(option.clone()), Some("change"));
        }
    }
}

/// Keys while the list of options is open.
fn dropdown_key(&mut self, key: KeyEvent) {
    let Some(focus) = self.dropdown else {
        return;
    };
    let Some(select) = Self::select_key(focus) else {
        self.dropdown = None;
        return;
    };
    let last = self.rt.get_list(select, "options").len().saturating_sub(1);
    match key.code {
        KeyCode::Up => self.dd_cursor = self.dd_cursor.saturating_sub(1),
        KeyCode::Down => self.dd_cursor = (self.dd_cursor + 1).min(last),
        KeyCode::Home => self.dd_cursor = 0,
        KeyCode::End => self.dd_cursor = last,
        KeyCode::Enter | KeyCode::Char(' ') => self.choose_option(select, self.dd_cursor),
        KeyCode::Esc | KeyCode::Tab | KeyCode::BackTab => self.dropdown = None,
        _ => {}
    }
}

/// A click while the list is open: inside it chooses, anywhere else closes it.
fn click_dropdown(&mut self, m: MouseEvent) {
    let Some(focus) = self.dropdown.take() else {
        return;
    };
    let (Some(popup), Some(select)) = (self.popup, Self::select_key(focus)) else {
        return;
    };
    let inside = m.column > popup.x
        && m.column + 1 < popup.x + popup.width
        && m.row > popup.y
        && m.row + 1 < popup.y + popup.height;
    if inside {
        let index = (m.row - popup.y - 1) as usize + self.dd_state.offset();
        self.choose_option(select, index);
    }
}
`);
    }

    if (n) {
      out.line('/// Whether the control can take the focus right now.');
      out.line('fn focusable(&self, id: usize) -> bool {').indent();
      out.line('let st = self.rt.lock();');
      out.line('match id {').indent();
      for (const f of this.focus) {
        const conds = [`st.focusable(${rustStr(keyOf(f.node))})`];
        for (let p = f.node.parent; p; p = p.parent) {
          if (p.type === 'Modal') conds.push(`st.modal_open(${rustStr(keyOf(p))})`);
          else if (p.tag && p.parent) conds.push(`st.shown(${rustStr(p.tag)})`);
        }
        out.line(`${f.name} => ${conds.join(' && ')},`);
      }
      out.line('_ => true,').dedent().line('}').dedent().line('}').line();

      out.block(`fn focus_next(&mut self) {
    for step in 1..=FOCUS_COUNT {
        let next = match self.focus {
            Some(i) => (i + step) % FOCUS_COUNT,
            None => step - 1,
        };
        if self.focusable(next) {
            self.focus = Some(next);${this.scrollable ? '\n            self.reveal(next);' : ''}
            return;
        }
    }
}

fn focus_prev(&mut self) {
    for step in 1..=FOCUS_COUNT {
        let prev = match self.focus {
            Some(i) => (i + FOCUS_COUNT - step) % FOCUS_COUNT,
            None => FOCUS_COUNT - step,
        };
        if self.focusable(prev) {
            self.focus = Some(prev);${this.scrollable ? '\n            self.reveal(prev);' : ''}
            return;
        }
    }
}`);
      out.line();
    }
    if (textInputs.length) {
      out.line('fn text_focused(&self) -> bool {').indent();
      out
        .line(`matches!(self.focus, ${textInputs.map((f) => `Some(${f.name})`).join(' | ')})`)
        .dedent()
        .line('}')
        .line();
    }

    // events
    out.block(`/// Every event of the terminal goes through here, also in the tests. Only key presses
/// count (Windows also reports releases), clicks are hit-tested, anything else just redraws.
fn on_event(&mut self, event: event::Event) {
    match event {
        event::Event::Key(key) => match key.kind {
            KeyEventKind::Press => self.on_key(key),
            // A held navigation key repeats; a held letter, Space or Enter must not fire again.
            KeyEventKind::Repeat
                if matches!(
                    key.code,
                    KeyCode::Up
                        | KeyCode::Down
                        | KeyCode::Left
                        | KeyCode::Right
                        | KeyCode::Backspace
                        | KeyCode::Home
                        | KeyCode::End
                ) =>
            {
                self.on_key(key)
            }
            _ => {}
        },
        event::Event::Mouse(m) => self.on_mouse(m),
        _ => {}
    }
}
`);
    out.line('/// A left click: focuses and activates the component under the mouse.');
    out.line('fn on_mouse(&mut self, m: MouseEvent) {').indent();
    out.block(`if self.rt.has_pending() {
    // The error dialog gets the click: it closes.
    if matches!(m.kind, MouseEventKind::Down(MouseButton::Left)) {
        self.rt.dismiss_errors();
    }
    return;
}`);
    if (this.selects.length) {
      out.block(`if self.dropdown.is_some() {
    // The list of options gets the click: it chooses or closes.
    if matches!(m.kind, MouseEventKind::Down(MouseButton::Left)) {
        self.click_dropdown(m);
    }
    return;
}`);
    }
    const modalCond = openModals
      .map((m) => `self.rt.modal_open(${rustStr(keyOf(m))})`)
      .join(' || ');
    if (this.scrollable) {
      out.block(`match m.kind {
    MouseEventKind::ScrollDown if !(${modalCond || 'false'}) => {
        self.scroll_by(3);
        return;
    }
    MouseEventKind::ScrollUp if !(${modalCond || 'false'}) => {
        self.scroll_by(-3);
        return;
    }
    _ => {}
}`);
    }
    out.block(`if !matches!(m.kind, MouseEventKind::Down(MouseButton::Left)) {
    return;
}`);
    if (n) {
      out.block(`let modal = ${modalCond || 'false'};`);
      if (this.scrollable) {
        out.block(`// The content is scrolled: its rectangles are in content coordinates.
let inside = m.column >= self.view.x
    && m.column < self.view.x + self.view.width
    && m.row >= self.view.y
    && m.row < self.view.y + self.view.height;
let vc = m.column.saturating_sub(self.view.x);
let vr = m.row.saturating_sub(self.view.y) + self.scroll;
let hit = self.hits.iter().rev().copied().find(|h| {
    if modal && !h.modal {
        return false;
    }
    let (c, r) = if h.scrolls {
        if !inside {
            return false;
        }
        (vc, vr)
    } else {
        (m.column, m.row)
    };
    c >= h.rect.x && c < h.rect.x + h.rect.width && r >= h.rect.y && r < h.rect.y + h.rect.height
});`);
      } else {
        out.block(`let hit = self.hits.iter().rev().copied().find(|h| {
    (!modal || h.modal)
        && m.column >= h.rect.x
        && m.column < h.rect.x + h.rect.width
        && m.row >= h.rect.y
        && m.row < h.rect.y + h.rect.height
});`);
      }
      out.block(`let Some(hit) = hit else {
    return;
};
if !self.focusable(hit.focus) {
    return;
}
self.focus = Some(hit.focus);`);
      if (this.scrollable) {
        out.block(`self.reveal(hit.focus);
let m = if hit.scrolls {
    MouseEvent { column: vc, row: vr, ..m }
} else {
    m
};`);
      }
      out.line('match hit.focus {').indent();
      this.clicks.forEach((c) => out.block(c));
      out.line('_ => {}').dedent().line('}');
    }
    out.dedent().line('}').line();

    // on_key
    out.line('/// Every key press of the UI goes through here (also in the tests).');
    out.line('fn on_key(&mut self, key: KeyEvent) {').indent();
    out.block(`if key.modifiers.contains(KeyModifiers::CONTROL) {
    match key.code {
        KeyCode::Char('c') => {
            self.quit = true;
            return;
        }
        KeyCode::Char('l') => {
            self.rt.toggle_log();
            return;
        }
        _ => {}
    }
}
if self.rt.has_pending() {
    // The error dialog is open: Enter / Esc close it, everything else waits.
    if matches!(key.code, KeyCode::Enter | KeyCode::Esc) {
        self.rt.dismiss_errors();
    }
    return;
}`);
    if (this.selects.length) {
      out.block(`if self.dropdown.is_some() {
    self.dropdown_key(key);
    return;
}`);
    }
    if (textInputs.length) out.line('let typing = self.text_focused();');
    out.line('match key.code {').indent();
    if (this.scrollable) {
      out.block(`KeyCode::PageDown => {
    self.scroll_by(self.view.height.max(1) as i32);
    return;
}
KeyCode::PageUp => {
    self.scroll_by(-(self.view.height.max(1) as i32));
    return;
}
KeyCode::Home${textInputs.length ? ' if !typing' : ''} => {
    self.scroll = 0;
    return;
}
KeyCode::End${textInputs.length ? ' if !typing' : ''} => {
    self.scroll = self.scroll_max;
    return;
}`);
    }
    if (n) {
      out.block('KeyCode::Tab => {\n    self.focus_next();\n    return;\n}');
      out.block('KeyCode::BackTab => {\n    self.focus_prev();\n    return;\n}');
    }
    out.line('KeyCode::Esc => {').indent();
    const esc: string[] = [];
    if (textInputs.length) esc.push('if typing {\n    self.focus = None;\n}');
    [...openModals].reverse().forEach((m) => {
      esc.push(
        `if self.rt.modal_open(${rustStr(keyOf(m))}) {\n    self.rt.set(${rustStr(keyOf(m))}, "open", Value::Bool(false));${n ? '\n    self.focus = None;' : ''}\n}`
      );
    });
    if (esc.length) {
      out.block(esc.join(' else ') + ' else {\n    self.quit = true;\n}');
    } else out.line('self.quit = true;');
    out.line('return;').dedent().line('}');
    out.block(
      `KeyCode::Char('q')${textInputs.length ? ' if !typing' : ''} => {\n    self.quit = true;\n    return;\n}`
    );
    out.line('_ => {}').dedent().line('}');
    if (n) {
      out.line('match self.focus {').indent();
      this.arms.forEach((a) => out.block(a));
      out.line('_ => {}').dedent().line('}');
    }
    out.dedent().line('}');
    out.dedent().line('}').line();

    if (textInputs.length) {
      out.block(`/// Byte offset of the \`chars\`-th character.
fn byte_index(s: &str, chars: usize) -> usize {
    s.char_indices().nth(chars).map(|(i, _)| i).unwrap_or(s.len())
}`);
      out.line();
    }

    // handlers named in the editor
    const stubs = [...this.stubs];
    if (stubs.length) {
      out.line('// Handlers named in the editor. Fill them in; they run on their own thread.');
      stubs.forEach((m) => out.line(`fn ${m}(_event: &Event) { /* TODO */ }`));
      out.line();
      out.line('fn register_handlers(ui: &Ui) {').indent();
      this.regs.forEach((r) => out.line(r));
      out.dedent().line('}').line();
    }

    out.block(`fn main() -> Result<(), UiError> {
    let ui = Ui::new();${stubs.length ? '\n    register_handlers(&ui);' : ''}
    // The UI runs on this thread, \`program\` on its own thread next to it.
    ui.run(program)
}

/// Your program goes here. It runs next to the UI, which keeps running when this returns.
/// Components with a code name are fields of \`ui\`, for example:
///     ui.status.set_text("Ready");
///     ui.log().info("started");
fn program(ui: Ui) {
    let _ = ui;
}

fn read_event(timeout: Duration) -> io::Result<Option<event::Event>> {
    if event::poll(timeout)? {
        return Ok(Some(event::read()?));
    }
    Ok(None)
}

/// The UI loop: draw, then wait for an event. \`input\` and \`on_frame\` let tests run it headless.
fn run_loop<B, I, D>(
    terminal: &mut Terminal<B>,
    app: &mut App,
    mut input: I,
    mut on_frame: D,
) -> io::Result<()>
where
    B: Backend,
    I: FnMut(Duration) -> io::Result<Option<event::Event>>,
    D: FnMut(&Buffer),
{
    while !app.finished() {
        let frame = terminal.draw(|f| ui(f, app))?;
        on_frame(frame.buffer);
        match input(Duration::from_millis(30))? {
            Some(event) => app.on_event(event),
            None => app.on_tick(),
        }
    }
    Ok(())
}
`);
    out.line('fn ui(frame: &mut Frame, app: &mut App) {');
    out.block(ui);
    out.line('}');
    out.line();
    out.block(`fn render_log(frame: &mut Frame, st: &Store, area: Rect) {
    let rows = area.height.saturating_sub(2) as usize;
    let log = st.log();
    let start = log.len().saturating_sub(rows);
    let lines: Vec<Line> = log[start..]
        .iter()
        .map(|e| Line::from(format!("{:>7} {}", e.level.name(), e.message.replace('\\n', " "))))
        .collect();
    frame.render_widget(
        Paragraph::new(lines).block(
            Block::default()
                .borders(Borders::ALL)
                .title("Log (Ctrl+L closes)"),
        ),
        area,
    );
}

fn render_errors(frame: &mut Frame, st: &Store, full: Rect) {
    let pending = st.pending();
    if pending.is_empty() {
        return;
    }
    let mut lines: Vec<Line> = Vec::new();
    for e in pending {
        lines.push(Line::from(e.message.clone()));
        if !e.details.is_empty() {
            lines.push(Line::from(format!("  {}", e.details)));
        }
    }
    lines.push(Line::from(""));
    lines.push(Line::from("Enter / Esc: close"));
    let width = full.width.saturating_sub(4).clamp(20, 64);
    let height = (lines.len() as u16 + 2).min(full.height);
    let area = centered(full, width, height);
    frame.render_widget(Clear, area);
    frame.render_widget(
        Paragraph::new(lines).wrap(Wrap { trim: false }).block(
            Block::default()
                .borders(Borders::ALL)
                .border_type(BorderType::Double)
                .border_style(Style::default().fg(Color::Rgb(255, 85, 85)))
                .title("Error"),
        ),
        area,
    );
}`);

    let body = out.toString();
    const code = stripLiterals(body);
    const helpers: string[] = [];
    const uses = (fn: string) => new RegExp(`\\b${fn}\\(`).test(code);
    if (uses('focus_style')) {
      helpers.push(
        '/// Highlight for the widget that has the keyboard focus.\nfn focus_style(style: Style, focused: bool) -> Style {\n    if focused {\n        style.add_modifier(Modifier::REVERSED)\n    } else {\n        style\n    }\n}'
      );
    }
    if (uses('focus_border')) {
      helpers.push(
        'fn focus_border(style: Style, focused: bool) -> Style {\n    if focused {\n        style.fg(Color::Rgb(255, 215, 0))\n    } else {\n        style\n    }\n}'
      );
    }
    if (uses('dim_if')) {
      helpers.push(
        '/// Muted components are drawn dimmed.\nfn dim_if(style: Style, dim: bool) -> Style {\n    if dim {\n        style.add_modifier(Modifier::DIM)\n    } else {\n        style\n    }\n}'
      );
    }
    if (uses('slots')) {
      helpers.push(
        '/// Position of each child among the children that are shown.\nfn slots(show: &[bool]) -> Vec<usize> {\n    let mut next = 0;\n    show.iter()\n        .map(|s| {\n            let slot = next;\n            if *s {\n                next += 1;\n            }\n            slot\n        })\n        .collect()\n}'
      );
    }
    if (uses('button_width')) {
      helpers.push(
        `/// Width of a button: its label with two cells of padding on each side, at least 16 when bordered.
fn button_width(label: &str, border: u16) -> u16 {
    let w = label.chars().count() as u16;
    if border > 0 {
        (w + 4 + border).max(16)
    } else {
        w
    }
}`
      );
    }
    if (uses('table_width')) {
      helpers.push(
        `/// Width of a table: the widest cell of each column, two cells between columns and one of padding on each side.
fn table_width(cols: &[String], rows: &[Vec<String>], border: u16) -> u16 {
    let n = rows.iter().map(|r| r.len()).chain([cols.len()]).max().unwrap_or(1).max(1);
    let cells: usize = (0..n)
        .map(|c| {
            rows.iter()
                .map(|r| r.get(c).map_or(0, |s| s.chars().count()))
                .chain(cols.get(c).map(|s| s.chars().count()))
                .max()
                .unwrap_or(0)
                .max(3)
        })
        .sum();
    (cells + 2 * (n - 1) + 2) as u16 + border
}`
      );
    }
    if (this.selects.length) {
      helpers.push(`/// The list of a select: under the field, or above it when there is no room below.
fn dropdown_area(field: Rect, count: usize, widest: usize, bounds: Rect) -> Rect {
    let width = (widest as u16 + 4).max(field.width).min(bounds.width);
    let want = count as u16 + 2;
    let below = bounds.bottom().saturating_sub(field.bottom());
    let above = field.y.saturating_sub(bounds.y);
    let x = field.x.min(bounds.right().saturating_sub(width));
    if below >= want || below >= above {
        Rect::new(x, field.bottom(), width, want.min(below))
    } else {
        let height = want.min(above);
        Rect::new(x, field.y - height, width, height)
    }
}`);
    }
    helpers.push(
      `/// Place a w x h rectangle inside \`area\`; ax/ay: 0 = start, 1 = center, 2 = end.
fn aligned(area: Rect, w: u16, h: u16, ax: u8, ay: u8) -> Rect {
    let w = w.min(area.width);
    let h = h.min(area.height);
    let x = match ax {
        1 => area.x + (area.width - w) / 2,
        2 => area.x + (area.width - w),
        _ => area.x,
    };
    let y = match ay {
        1 => area.y + (area.height - h) / 2,
        2 => area.y + (area.height - h),
        _ => area.y,
    };
    Rect::new(x, y, w, h)
}`,
      'fn centered(area: Rect, w: u16, h: u16) -> Rect {\n    aligned(area, w, h, 1, 1)\n}'
    );
    if (uses('clamp_rect')) {
      helpers.push(
        `/// A rectangle at (x, y) relative to \`parent\`, cut off at the edges of \`parent\`.
fn clamp_rect(parent: Rect, x: u16, y: u16, w: u16, h: u16) -> Rect {
    Rect::new(parent.x.saturating_add(x), parent.y.saturating_add(y), w, h).intersection(parent)
}`
      );
    }
    body += '\n' + helpers.join('\n\n') + '\n';

    return this.header() + this.imports(stripLiterals(body), stubs.length > 0) + '\n' + body;
  }

  private header(): string {
    const lines = [
      `// ${this.screenIdent}: generated by TUI Studio (Ratatui, Rust).`,
      '//',
      '// Run:   cargo run        (Rust 1.74+; src/main.rs, src/ui.rs and src/ui_runtime.rs)',
      '// Keys:  Tab / Shift+Tab move the focus, arrows move inside lists, tabs and selects,',
      '//        Space / Enter activate, q or Esc quits (Esc first leaves a text input; Ctrl+C always quits),',
      '//        Ctrl+L shows or hides the log, Enter / Esc close the error dialog.',
      '// API:   src/ui.rs: your program talks to the components that have a code name through `Ui`',
      '//        (see `program` below); the UI never blocks the program and the other way round.',
      '//',
      '// Layout strategy per container:',
      '//   native    flex rows/columns and grids use ratatui `Layout` constraints',
      "//   snapshot  wrapping and absolute containers place children at the editor's positions",
      '//   overlay   modals are drawn last with `Clear`',
      ...this.strategies.map((s) => `//   ${s}`),
      '',
      '',
    ];
    return lines.join('\n');
  }

  private imports(code: string, handlers: boolean): string {
    const uses = (names: string[]) =>
      names.filter((n) => new RegExp(`(?<!::)\\b${n}\\b`).test(code));
    const groups: [string, string[], boolean][] = [
      ['ratatui::backend', ['Backend'], false],
      ['ratatui::buffer', ['Buffer'], false],
      [
        'ratatui::crossterm::event',
        [
          'KeyCode',
          'KeyEvent',
          'KeyEventKind',
          'KeyModifiers',
          'MouseButton',
          'MouseEvent',
          'MouseEventKind',
        ],
        true,
      ],
      [
        'ratatui::layout',
        ['Alignment', 'Constraint', 'Direction', 'Flex', 'Layout', 'Rect'],
        false,
      ],
      ['ratatui::style', ['Color', 'Modifier', 'Style'], false],
      ['ratatui::text', ['Line', 'Span', 'Text'], false],
      [
        'ratatui::widgets',
        [
          'Block',
          'BorderType',
          'Cell',
          'Borders',
          'Clear',
          'Gauge',
          'List',
          'ListState',
          'Padding',
          'Paragraph',
          'Row',
          'Scrollbar',
          'ScrollbarOrientation',
          'ScrollbarState',
          'StatefulWidget',
          'Table',
          'TableState',
          'Tabs',
          'Widget',
          'Wrap',
        ],
        false,
      ],
      ['ratatui', ['Frame', 'Terminal'], false],
      ['crate::ui', ['Ui'], false],
      ['crate::ui_runtime', ['Event', 'Runtime', 'State', 'Store', 'UiError', 'Value'], false],
      ['std::sync', ['Arc'], false],
    ];
    const lines: string[] = [];
    for (const [path, names, withSelf] of groups) {
      const used = uses(names);
      if (withSelf) used.unshift('self');
      if (!used.length) continue;
      lines.push(
        used.length === 1 && !withSelf
          ? `use ${path}::${used[0]};`
          : `use ${path}::{${used.join(', ')}};`
      );
    }
    lines.push('use std::io;', 'use std::time::Duration;');
    void handlers;
    return lines.join('\n') + '\n';
  }
}

/** Blank out string and char literals so that identifiers inside user text are not counted. */
function stripLiterals(code: string): string {
  return code.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)'/g, "''");
}

function crateName(ident: string): string {
  const n = ident.replace(/^_+/, '') || 'app';
  const reserved = [
    'test',
    'core',
    'std',
    'alloc',
    'proc_macro',
    'build',
    'deps',
    'examples',
    'incremental',
    'main',
  ];
  return reserved.includes(n) ? `${n}_app` : /^[0-9]/.test(n) ? `app_${n}` : n;
}

export const RATATUI_RUNTIME_FILENAME = 'src/ui_runtime.rs';

export const ratatuiAdapter: ExportAdapter = {
  id: 'ratatui',
  label: 'Ratatui (Rust)',
  language: 'rs',
  verification: 'run',
  multiScreen: false,
  generate: ({ ir }) => {
    const screen = ir.start;
    const gen = new Gen(screen.ident, screen.root, screen.modals);
    const main = gen.build();
    const ui = gen.buildFacade();
    const cargo = `[package]
name = "${crateName(screen.ident)}"
version = "0.1.0"
edition = "2021"

[dependencies]
# ratatui re-exports crossterm (ratatui::crossterm); the pinned versions belong together.
ratatui = "${RATATUI_VERSION}"
crossterm = "${CROSSTERM_VERSION}"
`;
    return [
      { path: 'src/main.rs', content: main },
      { path: 'src/ui.rs', content: ui },
      { path: RATATUI_RUNTIME_FILENAME, content: runtimeSource },
      { path: 'Cargo.toml', content: cargo },
    ];
  },
};
