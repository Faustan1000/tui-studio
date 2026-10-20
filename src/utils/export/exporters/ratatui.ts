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
import type { IRBorder, IRNode, IRStyle } from '../ir';
import { inlineText, itemText, treeLines, visibleChildren } from '../ir';
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
const OWN_METHODS = [
  'new',
  'on_key',
  'on_tick',
  'focus_next',
  'focus_prev',
  'focusable',
  'text_focused',
];

function methodName(raw: string): string {
  let n = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase()
    .replace(/^_+|_+$/g, '');
  if (!n) n = 'handler';
  if (/^[0-9]/.test(n)) n = `_${n}`;
  if (RUST_KEYWORDS.has(n) || OWN_METHODS.includes(n)) n += '_handler';
  return n;
}

type Trigger = 'activate' | 'change' | 'select' | 'submit';

function classify(event: string): Trigger {
  const e = event.toLowerCase();
  if (/click|press|activate/.test(e)) return 'activate';
  if (e.includes('change')) return 'change';
  if (e.includes('select')) return 'select';
  if (/submit|enter/.test(e)) return 'submit';
  return 'activate';
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
function intrinsicWidth(node: IRNode): number {
  const border = node.style.border ? 2 : 0;
  const longest = (lines: string[]) => Math.max(0, ...lines.map(cells));
  switch (node.type) {
    case 'Text':
      return longest(node.text.split('\n')) + border;
    case 'Button':
    case 'Checkbox':
    case 'Radio':
    case 'Toggle':
    case 'Select':
    case 'Spinner':
    case 'Breadcrumb':
      return longest(inlineText(node).split('\n')) + border;
    case 'List':
    case 'Menu':
      return longest(node.items.map((i) => itemText(i))) + 2 + border;
    case 'Tree':
      return longest(treeLines(node.items).map((l) => l.text)) + 2 + border;
    case 'Tabs':
      return node.items.reduce((sum, i) => sum + cells(i.label) + 3, 0) + border;
    case 'Table': {
      const n = Math.max(node.columns.length, ...node.rows.map((r) => r.length));
      let total = Math.max(0, n - 1);
      for (let c = 0; c < n; c++) {
        total += longest([node.columns[c] ?? '', ...node.rows.map((r) => r[c] ?? '')]);
      }
      return total + border;
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

// ── Generator ─────────────────────────────────────────────────────────────────

class Gen {
  private w = new CodeWriter('    ', 1);
  private fields: { name: string; type: string; init: string }[] = [];
  private consts: string[] = [];
  private focus: Focusable[] = [];
  private focusOf = new Map<string, Focusable>();
  private arms: string[] = [];
  private handlers = new Set<string>();
  private strategies: string[] = [];
  private spinner = false;

  constructor(
    private readonly screenIdent: string,
    private readonly root: IRNode,
    private readonly modals: IRNode[]
  ) {}

  // ── Collect state, key arms and handlers ────────────────────────────────────

  private collect(node: IRNode, modal?: IRNode): void {
    if (!node.visible) return;
    if (node.type === 'Modal' && node !== modal) return;
    this.register(node, modal);
    node.children.forEach((c) => this.collect(c, modal));
  }

  private method(raw: string): string {
    const m = methodName(raw);
    this.handlers.add(m);
    return m;
  }

  private callsFor(node: IRNode, kinds: Trigger[], indent: number): string {
    const out: string[] = [];
    for (const [event, fn] of Object.entries(node.events)) {
      if (kinds.includes(classify(event)))
        out.push(`${' '.repeat(indent)}self.${methodName(fn)}();`);
    }
    return [...new Set(out)].join('\n');
  }

  private register(node: IRNode, modal?: IRNode): void {
    for (const fn of Object.values(node.events)) this.method(fn);
    const id = node.ident;
    const up = id.toUpperCase();
    const field = (name: string, type: string, init: string) =>
      this.fields.push({ name, type, init });
    let f: Focusable | undefined;
    if (FOCUSABLE.has(node.type) && !node.disabled) {
      f = { node, name: `F_${up}`, index: this.focus.length, modal };
      this.focus.push(f);
      this.focusOf.set(node.id, f);
    }
    const arm = (body: string) => {
      if (f) this.arms.push(`Some(${f.name}) => ${body},`);
    };
    const calls = (kinds: Trigger[], indent: number) => this.callsFor(node, kinds, indent);
    const block = (head: string, kinds: Trigger[]) => {
      const c = calls(kinds, 8);
      return c ? `${head} => {\n${c}\n    }` : '';
    };

    switch (node.type) {
      case 'Modal':
        field(`${id}_open`, 'bool', 'true');
        break;
      case 'Spinner':
        this.spinner = true;
        break;
      case 'TextInput': {
        field(`${id}_value`, 'String', `String::from(${rustStr(node.value)})`);
        field(`${id}_cursor`, 'usize', String([...node.value].length));
        const v = `self.${id}_value`;
        const c = `self.${id}_cursor`;
        const change = calls(['change'], 12);
        const submit = calls(['submit'], 8);
        arm(
          [
            'match key.code {',
            '    KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => {',
            `        let at = byte_index(&${v}, ${c});`,
            `        ${v}.insert(at, c);`,
            `        ${c} += 1;`,
            ...(change ? [change.replace(/^ {4}/gm, '')] : []),
            '    }',
            '    KeyCode::Backspace => {',
            `        if ${c} > 0 {`,
            `            ${c} -= 1;`,
            `            let at = byte_index(&${v}, ${c});`,
            `            ${v}.remove(at);`,
            ...(change ? [change] : []),
            '        }',
            '    }',
            `    KeyCode::Left => {\n        ${c} = ${c}.saturating_sub(1);\n    }`,
            `    KeyCode::Right => {\n        ${c} = (${c} + 1).min(${v}.chars().count());\n    }`,
            `    KeyCode::Home => {\n        ${c} = 0;\n    }`,
            `    KeyCode::End => {\n        ${c} = ${v}.chars().count();\n    }`,
            ...(submit ? [`    KeyCode::Enter => {\n${submit}\n    }`] : []),
            '    _ => {}',
            '}',
          ].join('\n')
        );
        break;
      }
      case 'Button': {
        const b = block("KeyCode::Enter | KeyCode::Char(' ')", ['activate', 'select']);
        arm(b ? `match key.code {\n    ${b}\n    _ => {}\n}` : '{}');
        break;
      }
      case 'Checkbox':
      case 'Toggle': {
        field(`${id}_checked`, 'bool', String(node.checked));
        const c = calls(['activate', 'change'], 8);
        arm(
          [
            'match key.code {',
            "    KeyCode::Char(' ') | KeyCode::Enter => {",
            `        self.${id}_checked = !self.${id}_checked;`,
            ...(c ? [c] : []),
            '    }',
            '    _ => {}',
            '}',
          ].join('\n')
        );
        break;
      }
      case 'Radio': {
        field(`${id}_checked`, 'bool', String(node.checked));
        const group = (node.parent?.children ?? []).filter(
          (s) => s !== node && s.type === 'Radio' && s.visible
        );
        const c = calls(['activate', 'change'], 8);
        arm(
          [
            'match key.code {',
            "    KeyCode::Char(' ') | KeyCode::Enter => {",
            `        self.${id}_checked = true;`,
            ...group.map((s) => `        self.${s.ident}_checked = false;`),
            ...(c ? [c] : []),
            '    }',
            '    _ => {}',
            '}',
          ].join('\n')
        );
        break;
      }
      case 'Select': {
        const opts = `${up}_OPTIONS`;
        this.consts.push(`const ${opts}: &[&str] = &[${node.options.map(rustStr).join(', ')}];`);
        const at = Math.max(0, node.options.indexOf(node.value));
        field(`${id}_index`, 'usize', String(at));
        const c = calls(['change', 'select'], 8);
        arm(
          [
            'match key.code {',
            '    KeyCode::Up | KeyCode::Left => {',
            `        self.${id}_index = self.${id}_index.saturating_sub(1);`,
            ...(c ? [c] : []),
            '    }',
            '    KeyCode::Down | KeyCode::Right => {',
            `        if self.${id}_index + 1 < ${opts}.len() {`,
            `            self.${id}_index += 1;`,
            '        }',
            ...(c ? [c] : []),
            '    }',
            '    _ => {}',
            '}',
          ].join('\n')
        );
        break;
      }
      case 'List':
      case 'Menu':
      case 'Tree': {
        const lines =
          node.type === 'Tree'
            ? treeLines(node.items).map((l) => l.text)
            : node.items.map((i) => itemText(i));
        const items = `${up}_ITEMS`;
        this.consts.push(`const ${items}: &[&str] = &[${lines.map(rustStr).join(', ')}];`);
        const sel = lines.length
          ? `.with_selected(Some(${Math.min(Math.max(0, node.selected), lines.length - 1)}))`
          : '';
        field(`${id}_state`, 'ListState', `ListState::default()${sel}`);
        const change = calls(['change'], 8);
        const enter = calls(['select', 'activate'], 8);
        const st = `self.${id}_state`;
        arm(
          [
            'match key.code {',
            '    KeyCode::Up => {',
            `        let i = ${st}.selected().unwrap_or(0);`,
            `        ${st}.select(Some(i.saturating_sub(1)));`,
            ...(change ? [change] : []),
            '    }',
            '    KeyCode::Down => {',
            `        let i = ${st}.selected().unwrap_or(0);`,
            `        ${st}.select(Some((i + 1).min(${items}.len().saturating_sub(1))));`,
            ...(change ? [change] : []),
            '    }',
            ...(enter ? [`    KeyCode::Enter => {\n${enter}\n    }`] : []),
            '    _ => {}',
            '}',
          ].join('\n')
        );
        break;
      }
      case 'Tabs': {
        const tabs = `${up}_TABS`;
        this.consts.push(
          `const ${tabs}: &[&str] = &[${node.items.map((i) => rustStr(i.label)).join(', ')}];`
        );
        const at = node.items.length
          ? Math.min(Math.max(0, node.selected), node.items.length - 1)
          : 0;
        field(`${id}_tab`, 'usize', String(at));
        const c = calls(['change', 'select'], 8);
        arm(
          [
            'match key.code {',
            '    KeyCode::Left => {',
            `        self.${id}_tab = self.${id}_tab.saturating_sub(1);`,
            ...(c ? [c] : []),
            '    }',
            '    KeyCode::Right => {',
            `        self.${id}_tab = (self.${id}_tab + 1).min(${tabs}.len().saturating_sub(1));`,
            ...(c ? [c] : []),
            '    }',
            '    _ => {}',
            '}',
          ].join('\n')
        );
        break;
      }
      case 'Table': {
        this.consts.push(
          `const ${up}_COLUMNS: &[&str] = &[${node.columns.map(rustStr).join(', ')}];`
        );
        const rows = node.rows.map((r) => `&[${r.map(rustStr).join(', ')}]`).join(', ');
        this.consts.push(`const ${up}_ROWS: &[&[&str]] = &[${rows}];`);
        field(
          `${id}_state`,
          'TableState',
          `TableState::default()${node.rows.length ? '.with_selected(Some(0))' : ''}`
        );
        const st = `self.${id}_state`;
        const enter = calls(['select', 'activate'], 8);
        const change = calls(['change'], 8);
        arm(
          [
            'match key.code {',
            '    KeyCode::Up => {',
            `        let i = ${st}.selected().unwrap_or(0);`,
            `        ${st}.select(Some(i.saturating_sub(1)));`,
            ...(change ? [change] : []),
            '    }',
            '    KeyCode::Down => {',
            `        let i = ${st}.selected().unwrap_or(0);`,
            `        ${st}.select(Some((i + 1).min(${up}_ROWS.len().saturating_sub(1))));`,
            ...(change ? [change] : []),
            '    }',
            ...(enter ? [`    KeyCode::Enter => {\n${enter}\n    }`] : []),
            '    _ => {}',
            '}',
          ].join('\n')
        );
        break;
      }
      default:
        break;
    }
  }

  // ── Widgets ─────────────────────────────────────────────────────────────────

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
      const title =
        node.type === 'Modal'
          ? node.text
          : node.type !== 'Screen' && node.name !== node.type
            ? node.name
            : '';
      if (b && b.top && title.trim()) parts.push(`.title(${rustStr(title)})`);
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
    w.line(state ? 'frame.render_stateful_widget(' : 'frame.render_widget(').indent();
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

  private paragraph(
    node: IRNode,
    text: string,
    a: string,
    opts: { align?: 'left' | 'center' | 'right' } = {}
  ): void {
    const f = this.focusOf.get(node.id);
    const bordered = !!node.style.border;
    const base = styleExpr(node.style, node.disabled ? ['Modifier::DIM'] : []);
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
    const base = styleExpr(node.style, node.disabled ? ['Modifier::DIM'] : []);
    const parts = [head];
    if (base !== 'Style::default()') parts.push(`.style(${base})`);
    parts.push(...extra);
    parts.push(
      f
        ? `.${highlight}(focus_style(Style::default().add_modifier(Modifier::BOLD), app.focus == Some(${f.name})))`
        : `.${highlight}(Style::default().add_modifier(Modifier::BOLD))`
    );
    const blk = this.blockExpr(node, { focus: node.style.border ? f : undefined });
    if (blk) parts.push(`.block(${blk})`);
    this.render(parts, a, stateField);
  }

  private leaf(node: IRNode, a: string): void {
    const id = node.ident;
    const up = id.toUpperCase();
    const w = this.w;
    switch (node.type) {
      case 'Text':
        this.paragraph(node, rustStr(node.text), a, { align: node.textAlign });
        break;
      case 'Button':
        this.paragraph(node, rustStr(inlineText(node)), a, { align: 'center' });
        break;
      case 'Breadcrumb':
        this.paragraph(node, rustStr(inlineText(node)), a);
        break;
      case 'Checkbox':
      case 'Radio':
      case 'Toggle': {
        const flag = `app.${id}_checked`;
        let expr: string;
        if (node.type === 'Toggle') {
          expr = `format!("{} {}", if ${flag} { "[ON ]" } else { "[OFF]" }, ${rustStr(node.text)})`;
        } else {
          const [open, close] = node.type === 'Checkbox' ? ['[', ']'] : ['(', ')'];
          expr = `format!("${open}{}${close} {}", if ${flag} { ${rustStr(node.glyphs.on)} } else { ${rustStr(node.glyphs.off)} }, ${rustStr(node.text)})`;
        }
        this.paragraph(node, expr, a);
        break;
      }
      case 'Select':
        this.paragraph(
          node,
          `format!("{} ▾", ${up}_OPTIONS.get(app.${id}_index).copied().unwrap_or(""))`,
          a
        );
        break;
      case 'Spinner':
        this.paragraph(
          node,
          `format!("{} {}", SPINNER_FRAMES[app.tick % SPINNER_FRAMES.len()], ${rustStr(node.text || 'Loading...')})`,
          a
        );
        break;
      case 'TextInput': {
        const f = this.focusOf.get(node.id);
        const bordered = !!node.style.border;
        w.line(`let ${id}_text = if app.${id}_value.is_empty() {`).indent();
        w.line(
          `Span::styled(${rustStr(node.placeholder)}, Style::default().fg(Color::Rgb(128, 128, 128)))`
        ).dedent();
        w.line('} else {').indent();
        w.line(`Span::raw(app.${id}_value.clone())`).dedent();
        w.line('};');
        let inner = a;
        let blockVar = '';
        if (bordered) {
          blockVar = `${id}_block`;
          this.chain(`let ${blockVar} = `, [this.blockExpr(node, { focus: f }) as string], ';');
          inner = `${id}_inner`;
          w.line(`let ${inner} = ${blockVar}.inner(${a});`);
        }
        const base = styleExpr(node.style, node.disabled ? ['Modifier::DIM'] : []);
        const style = f && !bordered ? `focus_style(${base}, app.focus == Some(${f.name}))` : base;
        const parts = [`Paragraph::new(${id}_text)`];
        if (style !== 'Style::default()') parts.push(`.style(${style})`);
        if (bordered) parts.push(`.block(${blockVar})`);
        this.render(parts, a);
        if (f) {
          w.line(`if app.focus == Some(${f.name}) {`).indent();
          w.line('frame.set_cursor_position((').indent();
          w.line(`${inner}.x + (app.${id}_cursor as u16).min(${inner}.width.saturating_sub(1)),`);
          w.line(`${inner}.y,`).dedent();
          w.line('));').dedent().line('}');
        }
        break;
      }
      case 'ProgressBar': {
        const ratio = Math.max(0, Math.min(1, node.progress.value / node.progress.max));
        const gauge = node.style.fg ? color(node.style.fg) : 'Color::Rgb(80, 200, 120)';
        const parts = [
          'Gauge::default()',
          `.ratio(${ratio.toFixed(4)})`,
          `.label(${rustStr(`${Math.round(ratio * 100)}%`)})`,
          `.gauge_style(Style::default().fg(${gauge})${node.style.bg ? `.bg(${color(node.style.bg)})` : ''})`,
        ];
        const blk = this.blockExpr(node, {});
        if (blk) parts.push(`.block(${blk})`);
        this.render(parts, a);
        break;
      }
      case 'List':
      case 'Menu':
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
      case 'Tabs':
        this.stateful(
          node,
          `Tabs::new(${up}_TABS.to_vec())`,
          [`.select(app.${id}_tab)`],
          a,
          '',
          'highlight_style'
        );
        break;
      case 'Table': {
        const n = Math.max(1, node.columns.length, ...node.rows.map((r) => r.length));
        const widths = Array.from({ length: n }, () => 'Constraint::Fill(1)').join(', ');
        const extra: string[] = [];
        if (node.columns.length) {
          extra.push(
            `.header(Row::new(${up}_COLUMNS.to_vec()).style(Style::default().add_modifier(Modifier::BOLD)))`
          );
        }
        this.stateful(
          node,
          `Table::new(${up}_ROWS.iter().map(|r| Row::new(r.to_vec())), [${widths}])`,
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
    const a = `${node.ident}_area`;
    this.w.line(`let ${a} = ${expr};`);
    if (
      node.type === 'Screen' ||
      node.type === 'Box' ||
      node.type === 'Grid' ||
      node.type === 'Modal'
    ) {
      this.container(node, a);
    } else this.leaf(node, a);
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
    let inner = a;
    if (blk) {
      if (kidsRender && !snapshot) {
        this.chain(`let ${id}_block = `, [blk], ';');
        w.line(`let ${id}_inner = ${id}_block.inner(${a});`);
        w.line(`frame.render_widget(${id}_block, ${a});`);
        inner = `${id}_inner`;
      } else {
        w.line(`frame.render_widget(${blk}, ${a});`);
      }
    }
    if (!kidsRender) return;

    if (l.mode === 'grid') {
      this.grid(node, kids, inner);
    } else if (l.mode === 'absolute' || (l.mode === 'flex' && l.wrap)) {
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
    this.strategies.push(
      `${id}: native ${vertical ? 'column' : 'row'} (Layout, Flex::${flex}${l.gap ? `, spacing ${l.gap}` : ''})`
    );
    const constraints = kids.map((k) => {
      const d = vertical ? k.height : k.width;
      if (typeof d === 'number') return `Constraint::Length(${u16(d)})`;
      if (d === 'fill') return 'Constraint::Fill(1)';
      const b = k.box ? (vertical ? k.box.height : Math.max(k.box.width, intrinsicWidth(k))) : null;
      return b === null ? 'Constraint::Min(0)' : `Constraint::Length(${u16(b)})`;
    });
    const parts = [
      'Layout::default()',
      `.direction(Direction::${vertical ? 'Vertical' : 'Horizontal'})`,
      `.flex(Flex::${flex})`,
    ];
    if (l.gap > 0) parts.push(`.spacing(${u16(l.gap)})`);
    parts.push(`.constraints([${constraints.join(', ')}])`, `.split(${inner})`);
    this.chain(`let ${id}_cells = `, parts, ';');
    const ax = l.align === 'center' ? 1 : l.align === 'end' ? 2 : 0;
    kids.forEach((k, i) => {
      if (!renders(k)) return;
      const cell = `${id}_cells[${i}]`;
      const cross = vertical ? k.width : k.height;
      let expr = cell;
      if (!(cross === 'fill' || (cross === 'auto' && l.align === 'stretch'))) {
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
    w.line(`if app.${id}_open {`).indent();
    w.line(`let ${id}_area = centered(area, ${wd}, ${hd});`);
    w.line(`frame.render_widget(Clear, ${id}_area);`);
    this.container(m, `${id}_area`);
    w.dedent().line('}');
  }

  // ── Whole file ──────────────────────────────────────────────────────────────

  build(): string {
    this.collect(this.root);
    this.modals.filter((m) => m.visible).forEach((m) => this.collect(m, m));
    const openModals = this.modals.filter((m) => m.visible);

    // ui body
    const w = this.w;
    const hasModals = openModals.length > 0;
    if (renders(this.root) || hasModals) {
      w.line('let area = frame.area();');
      if (renders(this.root)) this.emit(this.root, 'area');
      openModals.forEach((m) => this.modal(m));
    } else {
      w.line('let _ = frame.area();');
    }
    const ui = w.toString().replace(/\n$/, '');

    const out = new CodeWriter('    ');
    const n = this.focus.length;
    const textInputs = this.focus.filter((f) => f.node.type === 'TextInput');

    this.consts.forEach((c) => out.line(c));
    if (this.spinner) {
      out.line(
        'const SPINNER_FRAMES: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];'
      );
    }
    this.focus.forEach((f) => out.line(`const ${f.name}: usize = ${f.index};`));
    if (n) out.line(`const FOCUS_COUNT: usize = ${n};`);
    if (this.consts.length || this.spinner || n) out.line();

    // App struct
    out.line('struct App {').indent();
    out.line('quit: bool,');
    if (n) out.line('focus: Option<usize>,');
    if (this.spinner) out.line('tick: usize,');
    this.fields.forEach((f) => out.line(`${f.name}: ${f.type},`));
    out.dedent().line('}').line();

    out.line('impl App {').indent();
    out.line('fn new() -> Self {').indent();
    out.line('Self {').indent();
    out.line('quit: false,');
    if (n) out.line('focus: None,');
    if (this.spinner) out.line('tick: 0,');
    this.fields.forEach((f) => out.line(`${f.name}: ${f.init},`));
    out.dedent().line('}').dedent().line('}').line();

    if (n) {
      out.block(
        `fn focusable(&self, ${this.focus.some((f) => f.modal) ? 'id' : '_id'}: usize) -> bool {`
      );
      out.indent();
      if (this.focus.some((f) => f.modal)) {
        out.line('match id {').indent();
        this.focus
          .filter((f) => f.modal)
          .forEach((f) => out.line(`${f.name} => self.${f.modal!.ident}_open,`));
        out.line('_ => true,').dedent().line('}');
      } else out.line('true');
      out.dedent().line('}').line();

      out.block(`fn focus_next(&mut self) {
    for step in 1..=FOCUS_COUNT {
        let next = match self.focus {
            Some(i) => (i + step) % FOCUS_COUNT,
            None => step - 1,
        };
        if self.focusable(next) {
            self.focus = Some(next);
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
            self.focus = Some(prev);
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

    // on_key
    out.line('fn on_key(&mut self, key: KeyEvent) {').indent();
    out.block(`if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
    self.quit = true;
    return;
}`);
    if (textInputs.length) out.line('let typing = self.text_focused();');
    out.line('match key.code {').indent();
    if (n) {
      out.block('KeyCode::Tab => {\n    self.focus_next();\n    return;\n}');
      out.block('KeyCode::BackTab => {\n    self.focus_prev();\n    return;\n}');
    }
    out.line('KeyCode::Esc => {').indent();
    const esc: string[] = [];
    if (textInputs.length) esc.push('if typing {\n    self.focus = None;\n}');
    [...openModals].reverse().forEach((m) => {
      esc.push(
        `if self.${m.ident}_open {\n    self.${m.ident}_open = false;${n ? '\n    self.focus = None;' : ''}\n}`
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

    if (this.spinner) {
      out
        .line()
        .line('fn on_tick(&mut self) {')
        .indent()
        .line('self.tick = self.tick.wrapping_add(1);')
        .dedent()
        .line('}');
    }
    // handler stubs
    const stubs = [...this.handlers];
    if (stubs.length) out.line();
    stubs.forEach((m) => out.line(`fn ${m}(&mut self) { /* TODO */ }`));
    out.dedent().line('}').line();

    if (textInputs.length) {
      out.block(`/// Byte offset of the \`chars\`-th character.
fn byte_index(s: &str, chars: usize) -> usize {
    s.char_indices().nth(chars).map(|(i, _)| i).unwrap_or(s.len())
}`);
      out.line();
    }

    // main / run
    out.block(`fn main() -> io::Result<()> {
    let mut terminal = ratatui::init();
    let result = run(&mut terminal);
    ratatui::restore();
    result
}

fn run(terminal: &mut DefaultTerminal) -> io::Result<()> {
    let mut app = App::new();
    while !app.quit {
        terminal.draw(|frame| ui(frame, &mut app))?;`);
    if (this.spinner) {
      out.block(`        if event::poll(Duration::from_millis(100))? {
            if let Event::Key(key) = event::read()? {
                if key.kind == KeyEventKind::Press {
                    app.on_key(key);
                }
            }
        } else {
            app.on_tick();
        }`);
    } else {
      out.block(`        if let Event::Key(key) = event::read()? {
            if key.kind == KeyEventKind::Press {
                app.on_key(key);
            }
        }`);
    }
    out.block(`    }
    Ok(())
}
`);
    out.line('fn ui(frame: &mut Frame, app: &mut App) {');
    out.block(ui);
    out.line('}');

    let body = out.toString();
    // helpers, only the ones that are used
    const code = stripLiterals(body);
    const helpers: string[] = [];
    if (/\bfocus_style\(/.test(code)) {
      helpers.push(
        '/// Highlight for the widget that has the keyboard focus.\nfn focus_style(style: Style, focused: bool) -> Style {\n    if focused {\n        style.add_modifier(Modifier::REVERSED)\n    } else {\n        style\n    }\n}'
      );
    }
    if (/\bfocus_border\(/.test(code)) {
      helpers.push(
        'fn focus_border(style: Style, focused: bool) -> Style {\n    if focused {\n        style.fg(Color::Rgb(255, 215, 0))\n    } else {\n        style\n    }\n}'
      );
    }
    const usesCentered = /\bcentered\(/.test(code);
    if (usesCentered || /\baligned\(/.test(code)) {
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
}`
      );
    }
    if (usesCentered) {
      helpers.push(
        'fn centered(area: Rect, w: u16, h: u16) -> Rect {\n    aligned(area, w, h, 1, 1)\n}'
      );
    }
    if (/\bclamp_rect\(/.test(code)) {
      helpers.push(
        `/// A rectangle at (x, y) relative to \`parent\`, cut off at the edges of \`parent\`.
fn clamp_rect(parent: Rect, x: u16, y: u16, w: u16, h: u16) -> Rect {
    Rect::new(parent.x.saturating_add(x), parent.y.saturating_add(y), w, h).intersection(parent)
}`
      );
    }
    if (helpers.length) body += '\n' + helpers.join('\n\n') + '\n';

    return this.header() + this.imports(stripLiterals(body)) + '\n' + body;
  }

  private header(): string {
    const lines = [
      `// ${this.screenIdent}: generated by TUI Studio (Ratatui, Rust).`,
      '//',
      '// Run:   cargo run        (Rust 1.74+; the project is src/main.rs + Cargo.toml)',
      '// Keys:  Tab / Shift+Tab move the focus, arrows move inside lists, tabs and selects,',
      '//        Space / Enter activate, q or Esc quits (Esc first leaves a text input; Ctrl+C always quits).',
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

  private imports(code: string): string {
    const uses = (names: string[]) => names.filter((n) => new RegExp(`\\b${n}\\b`).test(code));
    const groups: [string, string[], boolean][] = [
      [
        'ratatui::crossterm::event',
        ['Event', 'KeyCode', 'KeyEvent', 'KeyEventKind', 'KeyModifiers'],
        true,
      ],
      [
        'ratatui::layout',
        ['Alignment', 'Constraint', 'Direction', 'Flex', 'Layout', 'Rect'],
        false,
      ],
      ['ratatui::style', ['Color', 'Modifier', 'Style'], false],
      ['ratatui::text', ['Span'], false],
      [
        'ratatui::widgets',
        [
          'Block',
          'BorderType',
          'Borders',
          'Clear',
          'Gauge',
          'List',
          'ListState',
          'Padding',
          'Paragraph',
          'Row',
          'Table',
          'TableState',
          'Tabs',
          'Wrap',
        ],
        false,
      ],
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
    lines.push(`use ratatui::{${uses(['DefaultTerminal', 'Frame']).join(', ')}};`);
    lines.push('use std::io;');
    if (/\bDuration\b/.test(code)) lines.push('use std::time::Duration;');
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

export const ratatuiAdapter: ExportAdapter = {
  id: 'ratatui',
  label: 'Ratatui (Rust)',
  language: 'rs',
  verification: 'snapshot',
  multiScreen: false,
  generate: ({ ir }) => {
    const screen = ir.start;
    const gen = new Gen(screen.ident, screen.root, screen.modals);
    const main = gen.build();
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
      { path: 'Cargo.toml', content: cargo },
    ];
  },
};
