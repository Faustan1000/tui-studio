// Bubble Tea (Go) exporter: bubbletea v1 + lipgloss v1 + bubbles (textinput, spinner, progress, table).
//
// Output: `main.go` (a real `model` with Init/Update/View) and `go.mod`.
//
// Layout strategies (also stated in the header of the generated file):
//   - flex containers (no wrap): NATIVE. Children are rendered to fixed-size strings and joined
//     with lipgloss.JoinHorizontal / JoinVertical; gaps, padding, justify and align become
//     margins computed from the editor's own layout (`rel`).
//   - flex with wrap, grid, absolute and unpositioned ("none") containers: SNAPSHOT. Every child
//     is rendered at its `rel` size and drawn at its `rel` position on a cell canvas (`overlay`).
//   - modals: rendered as a box and overlaid, centred, on top of their parent.
//
// There is no Go toolchain in the test environment: the generated code is checked structurally
// (tests/export.bubbletea.test.ts), not compiled.

import type { ExportAdapter, ExportFile } from '../adapter';
import { CodeWriter, goStr } from '../lang';
import {
  itemText,
  inlineText,
  recase,
  treeLines,
  visibleChildren,
  type IRItem,
  type IRNode,
  type IRScreen,
} from '../ir';

export const BUBBLETEA_VERSIONS = {
  go: '1.24',
  bubbletea: 'v1.3.10',
  bubbles: 'v0.21.1',
  lipgloss: 'v1.1.0',
} as const;

// ── Names ─────────────────────────────────────────────────────────────────────

const GO_KEYWORDS = [
  'break',
  'default',
  'func',
  'interface',
  'select',
  'case',
  'defer',
  'go',
  'map',
  'struct',
  'chan',
  'else',
  'goto',
  'package',
  'switch',
  'const',
  'fallthrough',
  'if',
  'range',
  'type',
  'continue',
  'for',
  'import',
  'return',
  'var',
];

class Namer {
  private used: Set<string>;
  constructor(reserved: readonly string[]) {
    this.used = new Set(reserved);
  }
  take(base: string): string {
    let candidate = base;
    for (let i = 2; this.used.has(candidate); i++) candidate = `${base}${i}`;
    this.used.add(candidate);
    return candidate;
  }
}

const CONTAINERS = new Set<string>(['Screen', 'Box', 'Grid', 'Modal']);
const FOCUSABLE = new Set<string>([
  'TextInput',
  'Button',
  'Checkbox',
  'Radio',
  'Select',
  'Toggle',
  'Table',
  'List',
  'Tree',
  'Menu',
  'Tabs',
]);

interface Info {
  node: IRNode;
  /** Struct field (state of the component). */
  field: string;
  /** `render<Name>` method. */
  method: string;
  /** Extra struct fields (`opts`, `open`, `value`). */
  extra: Record<string, string>;
  focusConst?: string;
}

// ── Sizes ─────────────────────────────────────────────────────────────────────

/** Terminal cells of a string (CJK and emoji are two cells wide, combining marks none). */
export function cellWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x200d || cp === 0xfe0f || (cp >= 0x300 && cp <= 0x36f)) continue;
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff);
    w += wide ? 2 : 1;
  }
  return w;
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ');
const maxW = (lines: string[]) => lines.reduce((m, l) => Math.max(m, cellWidth(l)), 0);
const clampSize = (n: number) => Math.min(500, Math.max(1, Math.round(Number.isFinite(n) ? n : 1)));

function borderCells(n: IRNode) {
  const b = n.style.border;
  return {
    left: b?.left ? 1 : 0,
    right: b?.right ? 1 : 0,
    top: b?.top ? 1 : 0,
    bottom: b?.bottom ? 1 : 0,
  };
}

function tabLabel(i: IRItem): string {
  return `${i.status ? '● ' : ''}${i.icon ? `${i.icon} ` : ''}${oneLine(i.label)}`;
}

/** Table: column titles, normalised rows and column widths (what bubbles/table needs). */
function tableData(n: IRNode) {
  // The declared columns decide; without any, the widest row does.
  const ncols = n.columns.length || Math.max(0, ...n.rows.map((r) => r.length));
  const titles = Array.from({ length: ncols }, (_, i) => oneLine(n.columns[i] ?? ''));
  const rows = n.rows.map((r) => Array.from({ length: ncols }, (_, i) => oneLine(r[i] ?? '')));
  const widths = titles.map((t, i) =>
    Math.max(1, cellWidth(t), ...rows.map((r) => cellWidth(r[i])))
  );
  return { titles, rows, widths };
}

/** Content size of a widget, used when the editor's layout collapsed an auto-sized node. */
function natural(n: IRNode): { w: number; h: number } | undefined {
  const b = borderCells(n);
  const bw = b.left + b.right;
  const bh = b.top + b.bottom;
  switch (n.type) {
    case 'Text': {
      const lines = n.text.split('\n');
      return { w: maxW(lines), h: lines.length };
    }
    case 'Button':
      return {
        w: cellWidth(oneLine(inlineText(n))) + n.layout.padding.left + n.layout.padding.right + bw,
        h: 1 + bh,
      };
    case 'Checkbox':
    case 'Radio':
    case 'Toggle':
    case 'Breadcrumb':
    case 'Spinner':
      return { w: cellWidth(oneLine(inlineText(n))) + bw, h: 1 + bh };
    case 'Select':
      return { w: maxW([...n.options, n.value]) + 2 + bw, h: 1 + bh };
    case 'TextInput':
      return { w: Math.max(10, cellWidth(oneLine(n.value || n.placeholder)) + 1) + bw, h: 1 + bh };
    case 'ProgressBar':
      return { w: 20 + bw, h: 1 + bh };
    case 'Table': {
      const t = tableData(n);
      return { w: t.widths.reduce((s, x) => s + x + 2, 0) + bw, h: 1 + t.rows.length + bh };
    }
    case 'List':
    case 'Menu':
      return { w: maxW(n.items.map((i) => oneLine(itemText(i)))) + bw, h: n.items.length + bh };
    case 'Tree': {
      const lines = treeLines(n.items).map((l) => oneLine(l.text));
      return { w: maxW(lines) + bw, h: lines.length + bh };
    }
    case 'Tabs':
      return { w: n.items.reduce((s, i) => s + cellWidth(tabLabel(i)) + 2, 0), h: 2 };
    default:
      return undefined;
  }
}

/** Outer size in cells: the editor's size, grown to the content for auto-sized widgets. */
function sizeOf(n: IRNode): { w: number; h: number } {
  const rect = n.rel ?? n.box;
  const nat = natural(n);
  let w = rect?.width ?? (typeof n.width === 'number' ? n.width : (nat?.w ?? 1));
  let h = rect?.height ?? (typeof n.height === 'number' ? n.height : (nat?.h ?? 1));
  if (nat && n.width === 'auto') w = Math.max(w, nat.w);
  if (nat && n.height === 'auto') h = Math.max(h, nat.h);
  return { w: clampSize(w), h: clampSize(h) };
}

function dims(n: IRNode) {
  const { w, h } = sizeOf(n);
  const b = borderCells(n);
  return {
    w,
    h,
    bl: b.left,
    bt: b.top,
    iw: Math.max(1, w - b.left - b.right),
    ih: Math.max(1, h - b.top - b.bottom),
    bordered: !!n.style.border,
  };
}

// ── Style ─────────────────────────────────────────────────────────────────────

/** `handleClick` stays `handleClick`; anything that is not an identifier is cleaned up. */
export function handlerName(raw: string): string {
  const words = raw.match(/[A-Za-z0-9]+/g) ?? [];
  const joined = words
    .map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join('');
  const base = joined.charAt(0).toLowerCase() + joined.slice(1);
  if (!base) return 'handler';
  return /^[0-9]/.test(base) ? `handle${base}` : base;
}

const col = (hex: string) => `lipgloss.Color(${goStr(hex)})`;

const BORDER_FN: Record<string, string> = {
  single: 'NormalBorder',
  double: 'DoubleBorder',
  rounded: 'RoundedBorder',
  bold: 'ThickBorder',
};

function styleChain(n: IRNode): string {
  const s = n.style;
  const parts = ['lipgloss.NewStyle()'];
  if (s.fg) parts.push(`.Foreground(${col(s.fg)})`);
  if (s.bg) parts.push(`.Background(${col(s.bg)})`);
  if (s.bold) parts.push('.Bold(true)');
  if (s.italic) parts.push('.Italic(true)');
  if (s.underline) parts.push('.Underline(true)');
  if (s.strikethrough) parts.push('.Strikethrough(true)');
  if (n.disabled) parts.push('.Faint(true)');
  if (s.border) {
    parts.push(`.BorderStyle(lipgloss.${BORDER_FN[s.border.kind]}())`);
    if (s.border.color) parts.push(`.BorderForeground(${col(s.border.color)})`);
    parts.push(
      `.BorderTop(${s.border.top})`,
      `.BorderRight(${s.border.right})`,
      `.BorderBottom(${s.border.bottom})`,
      `.BorderLeft(${s.border.left})`
    );
  }
  return parts.join('');
}

const HPOS = { left: 'lipgloss.Left', center: 'lipgloss.Center', right: 'lipgloss.Right' } as const;

// ── Events ────────────────────────────────────────────────────────────────────

const EVENT_CLASSES: Record<string, string[]> = {
  click: ['onClick', 'onPress', 'onActivate'],
  change: ['onChange'],
  select: ['onSelect', 'onSubmit', 'onEnter'],
  focus: ['onFocus'],
  blur: ['onBlur'],
  key: ['onKeyPress'],
};

// ── Generator ─────────────────────────────────────────────────────────────────

class Gen {
  readonly infos = new Map<IRNode, Info>();
  readonly order: Info[] = [];
  readonly members = new Namer([
    ...GO_KEYWORDS,
    'winW',
    'winH',
    'focus',
    'Init',
    'Update',
    'View',
    'updateKey',
    'updateFocused',
    'typing',
    'moveFocus',
    'setFocus',
    'applyFocus',
  ]);
  readonly pkg = new Namer([
    ...GO_KEYWORDS,
    'main',
    'model',
    'newModel',
    'canvas',
    'newCanvas',
    'canvasOf',
    'overlay',
    'frame',
    'shift',
    'moveCursor',
    'treeNode',
    'treeVisible',
    'treeRows',
    'treeKey',
    'menuRows',
    'tabsView',
    'tableStyles',
    'accent',
    'focusCount',
    'tea',
    'lipgloss',
    'strings',
    'fmt',
    'os',
    'textinput',
    'spinner',
    'progress',
    'table',
  ]);
  /** raw handler name -> method name */
  readonly handlers = new Map<string, string>();
  readonly focusables: Info[] = [];
  uses = { textinput: false, spinner: false, progress: false, table: false };

  constructor(readonly screen: IRScreen) {
    this.register(screen.root);
    this.collectHandlers();
  }

  private register(n: IRNode): void {
    if (!n.visible) return;
    const camel = recase(n.ident, 'camel');
    const pascal = recase(n.ident, 'pascal');
    const info: Info = {
      node: n,
      field: this.members.take(camel),
      method: this.members.take(`render${pascal}`),
      extra: {},
    };
    this.infos.set(n, info);
    this.order.push(info);
    const f = info.field;
    if (n.type === 'Select') info.extra.opts = this.members.take(`${f}Opts`);
    if (n.type === 'Tree') info.extra.open = this.members.take(`${f}Open`);
    if (n.type === 'Tree') info.extra.nodes = this.members.take(`${f}Nodes`);
    if (n.type === 'ProgressBar') info.extra.value = this.members.take(`${f}Value`);
    if (n.type === 'TextInput') this.uses.textinput = true;
    if (n.type === 'Spinner') this.uses.spinner = true;
    if (n.type === 'ProgressBar') this.uses.progress = true;
    if (n.type === 'Table') this.uses.table = true;
    if (FOCUSABLE.has(n.type) && !n.disabled) {
      info.focusConst = this.pkg.take(`focus${pascal}`);
      this.focusables.push(info);
    }
    if (CONTAINERS.has(n.type)) visibleChildren(n).forEach((c) => this.register(c));
  }

  private collectHandlers(): void {
    for (const info of this.order) {
      for (const raw of Object.values(info.node.events)) {
        if (!raw || this.handlers.has(raw)) continue;
        this.handlers.set(raw, this.members.take(handlerName(raw)));
      }
    }
  }

  /** `m.handleX()` statements for the event classes of a node. */
  calls(n: IRNode, ...classes: string[]): string[] {
    const out: string[] = [];
    for (const cls of classes) {
      for (const [event, raw] of Object.entries(n.events)) {
        if (!EVENT_CLASSES[cls].includes(event)) continue;
        const stmt = `m.${this.handlers.get(raw)}()`;
        if (!out.includes(stmt)) out.push(stmt);
      }
    }
    return out;
  }

  info(n: IRNode): Info {
    return this.infos.get(n)!;
  }

  // ── Files ───────────────────────────────────────────────────────────────────

  generate(): ExportFile[] {
    return [
      { path: 'main.go', content: this.mainGo() },
      { path: 'go.mod', content: this.goMod() },
    ];
  }

  private moduleName(): string {
    const name = this.screen.ident.replace(/^_+|_+$/g, '').replace(/_/g, '-');
    return `tuistudio/${name || 'app'}`;
  }

  private goMod(): string {
    const v = BUBBLETEA_VERSIONS;
    return [
      `module ${this.moduleName()}`,
      '',
      `go ${v.go}`,
      '',
      'require (',
      `\tgithub.com/charmbracelet/bubbles ${v.bubbles}`,
      `\tgithub.com/charmbracelet/bubbletea ${v.bubbletea}`,
      `\tgithub.com/charmbracelet/lipgloss ${v.lipgloss}`,
      ')',
      '',
    ].join('\n');
  }

  private mainGo(): string {
    const w = new CodeWriter('\t');
    this.header(w);
    this.imports(w);
    this.consts(w);
    this.modelStruct(w);
    this.newModel(w);
    this.initUpdate(w);
    this.focusCode(w);
    this.handlerStubs(w);
    this.view(w);
    w.block(this.helpers());
    w.line();
    w.block(this.mainFunc());
    return w.toString();
  }

  private header(w: CodeWriter): void {
    w.block(`// Generated by TUI Studio (Bubble Tea exporter). Edit freely.
//
// Run:
//   go mod tidy      // go.sum is not included: this downloads the pinned requirements
//   go run .
//
// Keys: tab / shift+tab move the focus, arrows / enter / space operate the focused component,
// esc closes modals, q or ctrl+c quits (q is typed into a focused text input instead).
//
// Layout strategy per container kind:
//   - flex containers: native, children are joined with lipgloss.JoinHorizontal/JoinVertical
//     and offset with margins computed from the editor's layout
//   - flex with wrap, grid, absolute and unpositioned containers: snapshot, every child is drawn
//     at the position the editor computed on a cell canvas (overlay), it does not reflow
//   - modals: overlaid, centred, on top of their parent
// Sizes are fixed to the design; the UI is centred when the terminal is larger.
//
// Dependencies: bubbletea ${BUBBLETEA_VERSIONS.bubbletea}, lipgloss ${BUBBLETEA_VERSIONS.lipgloss}, bubbles ${BUBBLETEA_VERSIONS.bubbles}.
// Event handlers (handleXxx) are stubs for you to fill in.`);
    w.line();
    w.line('package main');
    w.line();
  }

  private imports(w: CodeWriter): void {
    const std = ['"fmt"', '"os"', '"strings"'];
    const ext = [
      ...(this.uses.progress ? ['"github.com/charmbracelet/bubbles/progress"'] : []),
      ...(this.uses.spinner ? ['"github.com/charmbracelet/bubbles/spinner"'] : []),
      ...(this.uses.table ? ['"github.com/charmbracelet/bubbles/table"'] : []),
      ...(this.uses.textinput ? ['"github.com/charmbracelet/bubbles/textinput"'] : []),
      'tea "github.com/charmbracelet/bubbletea"',
      '"github.com/charmbracelet/lipgloss"',
    ];
    w.wrap(
      'import (',
      () => {
        std.forEach((s) => w.line(s));
        w.line();
        ext.forEach((s) => w.line(s));
      },
      ')'
    );
    w.line();
  }

  private consts(w: CodeWriter): void {
    w.line('// accent colours the border or text of the focused component.');
    w.line('const accent = lipgloss.Color("#bd93f9")');
    w.line();
    if (!this.focusables.length) {
      w.line('const focusCount = 0');
    } else {
      w.line('// Focus ring order (tab / shift+tab).');
      w.wrap(
        'const (',
        () => {
          this.focusables.forEach((f, i) =>
            w.line(i === 0 ? `${f.focusConst} = iota` : f.focusConst!)
          );
          w.line('focusCount');
        },
        ')'
      );
    }
    w.line();
  }

  private modelStruct(w: CodeWriter): void {
    w.line('type model struct {');
    w.indent();
    w.line('winW, winH int // terminal size');
    w.line('focus      int // index into the focus ring');
    for (const info of this.order) {
      const n = info.node;
      const f = info.field;
      switch (n.type) {
        case 'TextInput':
          w.line(`${f} textinput.Model`);
          break;
        case 'Spinner':
          w.line(`${f} spinner.Model`);
          break;
        case 'ProgressBar':
          w.line(`${f} progress.Model`);
          w.line(`${info.extra.value} float64 // 0..1`);
          break;
        case 'Table':
          w.line(`${f} table.Model`);
          break;
        case 'Checkbox':
        case 'Radio':
        case 'Toggle':
        case 'Modal':
          w.line(`${f} bool`);
          break;
        case 'Select':
          w.line(`${f} int`);
          w.line(`${info.extra.opts} []string`);
          break;
        case 'List':
        case 'Menu':
        case 'Tabs':
          w.line(`${f} int`);
          break;
        case 'Tree':
          w.line(`${f} int`);
          w.line(`${info.extra.open} []bool`);
          break;
        default:
          break;
      }
    }
    w.dedent();
    w.line('}');
    w.line();
  }

  private newModel(w: CodeWriter): void {
    w.line('func newModel() *model {');
    w.indent();
    w.line('m := &model{}');
    for (const info of this.order) {
      const n = info.node;
      const f = info.field;
      const d = dims(n);
      switch (n.type) {
        case 'TextInput':
          w.line(`m.${f} = textinput.New()`);
          w.line(`m.${f}.Prompt = ""`);
          w.line(`m.${f}.Placeholder = ${goStr(oneLine(n.placeholder))}`);
          w.line(`m.${f}.Width = ${Math.max(1, d.iw - 1)}`);
          if (n.value) w.line(`m.${f}.SetValue(${goStr(oneLine(n.value))})`);
          if (n.style.fg)
            w.line(`m.${f}.TextStyle = lipgloss.NewStyle().Foreground(${col(n.style.fg)})`);
          break;
        case 'Spinner':
          w.line(`m.${f} = spinner.New()`);
          w.line(`m.${f}.Spinner = spinner.MiniDot`);
          if (n.style.fg)
            w.line(`m.${f}.Style = lipgloss.NewStyle().Foreground(${col(n.style.fg)})`);
          break;
        case 'ProgressBar': {
          const fill = n.style.checkedColor ?? n.style.fg ?? '#ffffff';
          w.line(
            `m.${f} = progress.New(progress.WithSolidFill(${goStr(fill)}), progress.WithWidth(${d.iw}))`
          );
          const ratio = Math.max(0, Math.min(1, n.progress.value / n.progress.max));
          w.line(`m.${info.extra.value} = ${Number(ratio.toFixed(4))}`);
          break;
        }
        case 'Table': {
          const t = tableData(n);
          if (!t.titles.length) break;
          w.line(`m.${f} = table.New(`);
          w.indent();
          w.line('table.WithColumns([]table.Column{');
          w.indent();
          t.titles.forEach((title, i) =>
            w.line(`{Title: ${goStr(title)}, Width: ${t.widths[i]}},`)
          );
          w.dedent();
          w.line('}),');
          if (t.rows.length) {
            w.line('table.WithRows([]table.Row{');
            w.indent();
            t.rows.forEach((r) => w.line(`{${r.map(goStr).join(', ')}},`));
            w.dedent();
            w.line('}),');
          }
          w.line(`table.WithStyles(tableStyles(${goStr(n.style.fg ?? '')})),`);
          w.line(`table.WithHeight(${d.ih}),`);
          w.line('table.WithFocused(false),');
          w.dedent();
          w.line(')');
          break;
        }
        case 'Checkbox':
        case 'Radio':
        case 'Toggle':
          if (n.checked) w.line(`m.${f} = true`);
          break;
        case 'Modal':
          w.line(`m.${f} = true`);
          break;
        case 'Select': {
          w.line(
            `m.${info.extra.opts} = []string{${n.options.map((o) => goStr(oneLine(o))).join(', ')}}`
          );
          const idx = n.value ? n.options.indexOf(n.value) : 0;
          if (idx > 0) w.line(`m.${f} = ${idx}`);
          break;
        }
        case 'List':
        case 'Menu':
        case 'Tabs': {
          const sel = Math.min(Math.max(0, n.selected), Math.max(0, n.items.length - 1));
          if (sel > 0) w.line(`m.${f} = ${sel}`);
          break;
        }
        case 'Tree': {
          const flat = this.flattenTree(n.items);
          w.line(
            `m.${info.extra.open} = []bool{${flat.map((x) => String(x.expanded)).join(', ')}}`
          );
          break;
        }
        default:
          break;
      }
    }
    w.line('return m');
    w.dedent();
    w.line('}');
    w.line();
  }

  private flattenTree(items: readonly IRItem[]) {
    const out: {
      label: string;
      depth: number;
      parent: number;
      kids: boolean;
      expanded: boolean;
    }[] = [];
    const walk = (list: readonly IRItem[], depth: number, parent: number) => {
      for (const it of list) {
        const idx = out.length;
        out.push({
          label: oneLine(`${it.icon ? `${it.icon} ` : ''}${it.label}`),
          depth,
          parent,
          kids: it.children.length > 0,
          expanded: it.expanded,
        });
        walk(it.children, depth + 1, idx);
      }
    };
    walk(items, 0, -1);
    return out;
  }

  private initUpdate(w: CodeWriter): void {
    const cmds: string[] = [];
    if (this.focusables.length) cmds.push('m.applyFocus()');
    if (this.uses.textinput) cmds.push('textinput.Blink');
    for (const info of this.order)
      if (info.node.type === 'Spinner') cmds.push(`m.${info.field}.Tick`);
    w.line('func (m *model) Init() tea.Cmd {');
    w.indent();
    w.line(cmds.length ? `return tea.Batch(${cmds.join(', ')})` : 'return nil');
    w.dedent();
    w.line('}');
    w.line();

    w.line('func (m *model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {');
    w.indent();
    w.line('switch msg := msg.(type) {');
    w.line('case tea.WindowSizeMsg:');
    w.indent();
    w.line('m.winW, m.winH = msg.Width, msg.Height');
    w.line('return m, nil');
    w.dedent();
    w.line('case tea.KeyMsg:');
    w.indent();
    w.line('return m.updateKey(msg)');
    w.dedent();
    const spinners = this.order.filter((i) => i.node.type === 'Spinner');
    if (spinners.length) {
      w.line('case spinner.TickMsg:');
      w.indent();
      w.line('var cmds []tea.Cmd');
      w.line('var cmd tea.Cmd');
      for (const s of spinners) {
        w.line(`m.${s.field}, cmd = m.${s.field}.Update(msg)`);
        w.line('cmds = append(cmds, cmd)');
      }
      w.line('return m, tea.Batch(cmds...)');
      w.dedent();
    }
    w.line('}');
    w.line('return m, nil');
    w.dedent();
    w.line('}');
    w.line();

    const modals = this.order.filter((i) => i.node.type === 'Modal');
    w.line('func (m *model) updateKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {');
    w.indent();
    w.line('key := msg.String()');
    w.line('switch key {');
    w.line('case "ctrl+c":');
    w.indent().line('return m, tea.Quit').dedent();
    w.line('case "tab":');
    w.indent().line('return m, m.moveFocus(1)').dedent();
    w.line('case "shift+tab":');
    w.indent().line('return m, m.moveFocus(-1)').dedent();
    if (modals.length) {
      w.line('case "esc":');
      w.indent();
      modals.forEach((mo) => w.line(`m.${mo.field} = false`));
      w.line('return m, nil');
      w.dedent();
    }
    w.line('case "q":');
    w.indent();
    w.line('if !m.typing() {');
    w.indent().line('return m, tea.Quit').dedent();
    w.line('}');
    w.dedent();
    w.line('}');
    w.line('return m, m.updateFocused(msg, key)');
    w.dedent();
    w.line('}');
    w.line();

    // typing: a focused text input receives "q" as text.
    const inputs = this.focusables.filter((f) => f.node.type === 'TextInput');
    w.line('// typing reports whether the focused component takes text (so "q" does not quit).');
    w.line('func (m *model) typing() bool {');
    w.indent();
    if (inputs.length) {
      w.line('switch m.focus {');
      w.line(`case ${inputs.map((i) => i.focusConst).join(', ')}:`);
      w.indent().line('return true').dedent();
      w.line('}');
    }
    w.line('return false');
    w.dedent();
    w.line('}');
    w.line();

    // Key handling per focused component.
    w.line('// updateFocused handles a key for the focused component.');
    w.line('func (m *model) updateFocused(msg tea.KeyMsg, key string) tea.Cmd {');
    w.indent();
    if (this.focusables.length) {
      w.line('switch m.focus {');
      for (const info of this.focusables) {
        w.line(`case ${info.focusConst}:`);
        w.indent();
        this.focusedKeys(w, info);
        w.dedent();
      }
      w.line('}');
    }
    w.line('return nil');
    w.dedent();
    w.line('}');
    w.line();
  }

  private focusedKeys(w: CodeWriter, info: Info): void {
    const n = info.node;
    const f = info.field;
    const emit = (lines: string[]) => lines.forEach((l) => w.line(l));
    emit(this.calls(n, 'key'));
    switch (n.type) {
      case 'TextInput': {
        const change = this.calls(n, 'change');
        if (change.length) w.line(`before := m.${f}.Value()`);
        w.line('var cmd tea.Cmd');
        w.line(`m.${f}, cmd = m.${f}.Update(msg)`);
        if (change.length) {
          w.line(`if m.${f}.Value() != before {`);
          w.indent();
          emit(change);
          w.dedent();
          w.line('}');
        }
        const submit = this.calls(n, 'select');
        if (submit.length) {
          w.line('if key == "enter" {');
          w.indent();
          emit(submit);
          w.dedent();
          w.line('}');
        }
        w.line('return cmd');
        break;
      }
      case 'Button': {
        w.line('if key == "enter" || key == " " {');
        w.indent();
        if (n.opensScreen)
          w.line('// This button opens another screen; only the start screen is exported.');
        emit(this.calls(n, 'click', 'select'));
        w.dedent();
        w.line('}');
        break;
      }
      case 'Checkbox':
      case 'Toggle': {
        w.line('if key == "enter" || key == " " {');
        w.indent();
        w.line(`m.${f} = !m.${f}`);
        emit(this.calls(n, 'change', 'click'));
        w.dedent();
        w.line('}');
        break;
      }
      case 'Radio': {
        w.line('if key == "enter" || key == " " {');
        w.indent();
        for (const sib of n.parent?.children ?? []) {
          if (sib !== n && sib.type === 'Radio' && this.infos.has(sib))
            w.line(`m.${this.info(sib).field} = false`);
        }
        w.line(`m.${f} = true`);
        emit(this.calls(n, 'change', 'click'));
        w.dedent();
        w.line('}');
        break;
      }
      case 'Select': {
        const opts = info.extra.opts;
        w.line(`if n := len(m.${opts}); n > 0 {`);
        w.indent();
        w.line('switch key {');
        w.line('case "up", "left":');
        w.indent().line(`m.${f} = (m.${f} + n - 1) % n`);
        emit(this.calls(n, 'change', 'select'));
        w.dedent();
        w.line('case "down", "right", "enter", " ":');
        w.indent().line(`m.${f} = (m.${f} + 1) % n`);
        emit(this.calls(n, 'change', 'select'));
        w.dedent();
        w.line('}');
        w.dedent();
        w.line('}');
        break;
      }
      case 'List':
      case 'Menu': {
        const count = n.items.length;
        w.line('switch key {');
        w.line('case "up", "k":');
        w.indent().line(`m.${f} = moveCursor(m.${f}, -1, ${count})`);
        emit(this.calls(n, 'change'));
        w.dedent();
        w.line('case "down", "j":');
        w.indent().line(`m.${f} = moveCursor(m.${f}, 1, ${count})`);
        emit(this.calls(n, 'change'));
        w.dedent();
        w.line('case "enter", " ":');
        w.indent();
        emit(this.calls(n, 'select', 'click'));
        w.dedent();
        w.line('}');
        break;
      }
      case 'Tree': {
        w.line(`m.${f} = treeKey(m.${info.extra.nodes}(), m.${info.extra.open}, m.${f}, key)`);
        const select = this.calls(n, 'select', 'click');
        if (select.length) {
          w.line('if key == "enter" {');
          w.indent();
          emit(select);
          w.dedent();
          w.line('}');
        }
        break;
      }
      case 'Tabs': {
        const last = Math.max(0, n.items.length - 1);
        w.line('switch key {');
        w.line('case "left", "h":');
        w.indent().line(`if m.${f} > 0 {`);
        w.indent().line(`m.${f}--`);
        emit(this.calls(n, 'change', 'select'));
        w.dedent().line('}').dedent();
        w.line('case "right", "l":');
        w.indent().line(`if m.${f} < ${last} {`);
        w.indent().line(`m.${f}++`);
        emit(this.calls(n, 'change', 'select'));
        w.dedent().line('}').dedent();
        w.line('}');
        break;
      }
      case 'Table': {
        if (!tableData(n).titles.length) break;
        w.line('var cmd tea.Cmd');
        w.line(`m.${f}, cmd = m.${f}.Update(msg)`);
        const select = this.calls(n, 'select', 'click');
        if (select.length) {
          w.line('if key == "enter" {');
          w.indent();
          emit(select);
          w.dedent();
          w.line('}');
        }
        w.line('return cmd');
        break;
      }
      default:
        break;
    }
  }

  private focusCode(w: CodeWriter): void {
    const count = this.focusables.length;
    w.line('func (m *model) moveFocus(d int) tea.Cmd {');
    w.indent();
    w.line(count ? 'return m.setFocus((m.focus + d + focusCount) % focusCount)' : 'return nil');
    w.dedent();
    w.line('}');
    w.line();

    // Blur actions
    const blur = this.focusables
      .map((i) => {
        const lines: string[] = [];
        if (i.node.type === 'TextInput') lines.push(`m.${i.field}.Blur()`);
        if (i.node.type === 'Table' && tableData(i.node).titles.length)
          lines.push(`m.${i.field}.Blur()`);
        lines.push(...this.calls(i.node, 'blur'));
        return { info: i, lines };
      })
      .filter((x) => x.lines.length);
    w.line('func (m *model) setFocus(i int) tea.Cmd {');
    w.indent();
    if (blur.length) {
      w.line('switch m.focus {');
      for (const b of blur) {
        w.line(`case ${b.info.focusConst}:`);
        w.indent();
        b.lines.forEach((l) => w.line(l));
        w.dedent();
      }
      w.line('}');
    }
    w.line('m.focus = i');
    w.line('return m.applyFocus()');
    w.dedent();
    w.line('}');
    w.line();

    const enter = this.focusables
      .map((i) => {
        const lines: string[] = [];
        lines.push(...this.calls(i.node, 'focus'));
        if (i.node.type === 'Table' && tableData(i.node).titles.length)
          lines.push(`m.${i.field}.Focus()`);
        if (i.node.type === 'TextInput') lines.push(`return m.${i.field}.Focus()`);
        return { info: i, lines };
      })
      .filter((x) => x.lines.length);
    w.line('func (m *model) applyFocus() tea.Cmd {');
    w.indent();
    if (enter.length) {
      w.line('switch m.focus {');
      for (const e of enter) {
        w.line(`case ${e.info.focusConst}:`);
        w.indent();
        e.lines.forEach((l) => w.line(l));
        w.dedent();
      }
      w.line('}');
    }
    w.line('return nil');
    w.dedent();
    w.line('}');
    w.line();
  }

  private handlerStubs(w: CodeWriter): void {
    if (!this.handlers.size) return;
    w.line('// Event handlers: fill these in.');
    for (const name of new Set(this.handlers.values())) {
      w.line(`func (m *model) ${name}() {`);
      w.indent().line('// TODO: implement').dedent();
      w.line('}');
      w.line();
    }
  }

  // ── View ────────────────────────────────────────────────────────────────────

  private view(w: CodeWriter): void {
    w.line('func (m *model) View() string {');
    w.indent();
    w.line(`out := m.${this.info(this.screen.root).method}()`);
    w.line('if m.winW > 0 && m.winH > 0 {');
    w.indent();
    w.line('out = lipgloss.Place(m.winW, m.winH, lipgloss.Center, lipgloss.Center, out)');
    w.line('out = lipgloss.NewStyle().MaxWidth(m.winW).MaxHeight(m.winH).Render(out)');
    w.dedent();
    w.line('}');
    w.line('return out');
    w.dedent();
    w.line('}');
    w.line();

    for (const info of this.order) {
      const n = info.node;
      if (CONTAINERS.has(n.type)) this.container(w, info);
      else this.leaf(w, info);
      w.line();
    }
    // Tree node tables
    for (const info of this.order) {
      if (info.node.type !== 'Tree') continue;
      w.line(`func (m *model) ${info.extra.nodes}() []treeNode {`);
      w.indent();
      const flat = this.flattenTree(info.node.items);
      if (!flat.length) w.line('return nil');
      else {
        w.line('return []treeNode{');
        w.indent();
        flat.forEach((x) =>
          w.line(
            `{label: ${goStr(x.label)}, depth: ${x.depth}, parent: ${x.parent}, kids: ${x.kids}},`
          )
        );
        w.dedent();
        w.line('}');
      }
      w.dedent();
      w.line('}');
      w.line();
    }
  }

  private container(w: CodeWriter, info: Info): void {
    const n = info.node;
    const d = dims(n);
    const kids = visibleChildren(n).filter((c) => c.type !== 'Modal' && this.infos.has(c));
    const modals = visibleChildren(n).filter((c) => c.type === 'Modal' && this.infos.has(c));
    const native = n.layout.mode === 'flex' && !n.layout.wrap;
    w.line(`func (m *model) ${info.method}() string {`);
    w.indent();
    if (!kids.length) {
      w.line('content := ""');
    } else if (native) {
      const row = n.layout.direction === 'row';
      w.line(
        `content := lipgloss.Join${row ? 'Horizontal(lipgloss.Top' : 'Vertical(lipgloss.Left'},`
      );
      w.indent();
      let cursor = 0;
      for (const k of kids) {
        const r = k.rel ?? { x: 0, y: 0, width: 0, height: 0 };
        const s = sizeOf(k);
        const x = Math.max(0, r.x - d.bl);
        const y = Math.max(0, r.y - d.bt);
        let dx: number;
        let dy: number;
        if (row) {
          dx = Math.max(0, x - cursor);
          dy = y;
          cursor += dx + s.w;
        } else {
          dx = x;
          dy = Math.max(0, y - cursor);
          cursor += dy + s.h;
        }
        w.line(`shift(m.${this.info(k).method}(), ${dx}, ${dy}),`);
      }
      w.dedent();
      w.line(')');
    } else {
      w.line(`c := newCanvas(${d.iw}, ${d.ih})`);
      for (const k of kids) {
        const r = k.rel ?? { x: 0, y: 0, width: 0, height: 0 };
        w.line(`c.put(${r.x - d.bl}, ${r.y - d.bt}, m.${this.info(k).method}())`);
      }
      w.line('content := c.String()');
    }
    const body = `${styleChain(n)}.Render(frame(content, ${d.iw}, ${d.ih}, lipgloss.Left, lipgloss.Top))`;
    const title = n.type === 'Modal' ? oneLine(n.text) : '';
    if (!modals.length && !title) {
      w.line(`return ${body}`);
    } else {
      w.line(`out := ${body}`);
      if (title && d.w >= 6) {
        w.line(
          `out = overlay(out, 2, 0, lipgloss.NewStyle().Bold(true).MaxWidth(${d.w - 4}).Render(${goStr(` ${title} `)}))`
        );
      }
      for (const mo of modals) {
        const ms = sizeOf(mo);
        const x = Math.max(0, Math.floor((d.w - ms.w) / 2));
        const y = Math.max(0, Math.floor((d.h - ms.h) / 2));
        const mi = this.info(mo);
        w.line(`if m.${mi.field} {`);
        w.indent().line(`out = overlay(out, ${x}, ${y}, m.${mi.method}())`).dedent();
        w.line('}');
      }
      w.line('return out');
    }
    w.dedent();
    w.line('}');
  }

  private leaf(w: CodeWriter, info: Info): void {
    const n = info.node;
    const f = info.field;
    const d = dims(n);
    const focused = info.focusConst ? `m.focus == ${info.focusConst}` : '';
    const frame = (content: string, hpos = 'lipgloss.Left', vpos = 'lipgloss.Top') =>
      `frame(${content}, ${d.iw}, ${d.ih}, ${hpos}, ${vpos})`;
    w.line(`func (m *model) ${info.method}() string {`);
    w.indent();
    w.line(`st := ${styleChain(n)}`);
    const focusStyle = (mode: 'reverse' | 'border-only') => {
      if (!focused) return;
      if (d.bordered) {
        w.line(`if ${focused} {`);
        w.indent().line('st = st.BorderForeground(accent)').dedent();
        w.line('}');
      } else if (mode === 'reverse') {
        w.line(`if ${focused} {`);
        w.indent().line('st = st.Reverse(true)').dedent();
        w.line('}');
      }
    };
    const stateColors = () => {
      if (n.style.checkedColor) {
        w.line(`if m.${f} {`);
        w.indent()
          .line(`st = st.Foreground(${col(n.style.checkedColor)})`)
          .dedent();
        if (n.style.uncheckedColor) {
          w.line('} else {');
          w.indent()
            .line(`st = st.Foreground(${col(n.style.uncheckedColor)})`)
            .dedent();
        }
        w.line('}');
      } else if (n.style.uncheckedColor) {
        w.line(`if !m.${f} {`);
        w.indent()
          .line(`st = st.Foreground(${col(n.style.uncheckedColor)})`)
          .dedent();
        w.line('}');
      }
    };
    const selectionStyles = () => {
      w.line('hl := lipgloss.NewStyle().Bold(true)');
      if (focused) {
        w.line(`if ${focused} {`);
        w.indent().line('hl = hl.Reverse(true)').dedent();
        w.line('}');
      }
    };

    switch (n.type) {
      case 'Text': {
        focusStyle('border-only');
        const text = goStr(n.text);
        const content = n.wrapText ? `lipgloss.NewStyle().Width(${d.iw}).Render(${text})` : text;
        w.line(`return st.Render(${frame(content, HPOS[n.textAlign])})`);
        break;
      }
      case 'Button': {
        w.line('// Button: Enter or Space presses it.');
        focusStyle('reverse');
        w.line(
          `return st.Render(${frame(goStr(oneLine(inlineText(n))), 'lipgloss.Center', 'lipgloss.Center')})`
        );
        break;
      }
      case 'Checkbox':
      case 'Radio': {
        const [open, close] = n.type === 'Checkbox' ? ['[', ']'] : ['(', ')'];
        stateColors();
        focusStyle('reverse');
        w.line(`mark := ${goStr(n.glyphs.off)}`);
        w.line(`if m.${f} {`);
        w.indent()
          .line(`mark = ${goStr(n.glyphs.on)}`)
          .dedent();
        w.line('}');
        w.line(
          `label := ${goStr(open)} + mark + ${goStr(close)} + ${goStr(` ${oneLine(n.text)}`)}`
        );
        w.line(`return st.Render(${frame('label')})`);
        break;
      }
      case 'Toggle': {
        stateColors();
        focusStyle('reverse');
        w.line('mark := "[OFF]"');
        w.line(`if m.${f} {`);
        w.indent().line('mark = "[ON ]"').dedent();
        w.line('}');
        w.line(`return st.Render(${frame(`mark + ${goStr(` ${oneLine(n.text)}`)}`)})`);
        break;
      }
      case 'Select': {
        focusStyle('reverse');
        w.line('current := ""');
        w.line(`if m.${f} < len(m.${info.extra.opts}) {`);
        w.indent().line(`current = m.${info.extra.opts}[m.${f}]`).dedent();
        w.line('}');
        w.line(`return st.Render(${frame('current + " ▾"')})`);
        break;
      }
      case 'TextInput': {
        focusStyle('reverse');
        w.line(`return st.Render(${frame(`m.${f}.View()`)})`);
        break;
      }
      case 'Spinner': {
        const label = n.text || 'Loading...';
        w.line(`return st.Render(${frame(`m.${f}.View() + " " + ${goStr(oneLine(label))}`)})`);
        break;
      }
      case 'ProgressBar': {
        w.line(`return st.Render(${frame(`m.${f}.ViewAs(m.${info.extra.value})`)})`);
        break;
      }
      case 'Breadcrumb': {
        w.line(`return st.Render(${frame(goStr(oneLine(inlineText(n))))})`);
        break;
      }
      case 'Spacer': {
        w.line(`return st.Render(${frame('""')})`);
        break;
      }
      case 'Table': {
        focusStyle('border-only');
        if (!tableData(n).titles.length) w.line(`return st.Render(${frame('""')})`);
        else w.line(`return st.Render(${frame(`m.${f}.View()`)})`);
        break;
      }
      case 'List':
      case 'Menu': {
        focusStyle('border-only');
        selectionStyles();
        const lines = n.items.map((i) => goStr(oneLine(itemText(i))));
        w.line(
          `body := menuRows([]string{${lines.join(', ')}}, m.${f}, ${d.iw}, lipgloss.NewStyle(), hl)`
        );
        w.line(`return st.Render(${frame('body')})`);
        break;
      }
      case 'Tree': {
        focusStyle('border-only');
        selectionStyles();
        w.line(
          `body := menuRows(treeRows(m.${info.extra.nodes}(), m.${info.extra.open}), m.${f}, ${d.iw}, lipgloss.NewStyle(), hl)`
        );
        w.line(`return st.Render(${frame('body')})`);
        break;
      }
      case 'Tabs': {
        focusStyle('border-only');
        selectionStyles();
        const labels = n.items.map((i) => goStr(tabLabel(i)));
        w.line(
          `body := tabsView([]string{${labels.join(', ')}}, m.${f}, ${d.iw}, lipgloss.NewStyle(), hl)`
        );
        w.line(`return st.Render(${frame('body')})`);
        break;
      }
      default:
        w.line(`return st.Render(${frame('""')})`);
    }
    w.dedent();
    w.line('}');
  }

  // ── Static parts ────────────────────────────────────────────────────────────

  private helpers(): string {
    const parts: string[] = [HELPERS];
    if (this.uses.table) parts.push(TABLE_STYLES);
    return parts.join('\n');
  }

  private mainFunc(): string {
    return String.raw`func main() {
	if _, err := tea.NewProgram(newModel(), tea.WithAltScreen()).Run(); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}`;
  }
}

const TABLE_STYLES = String.raw`func tableStyles(fg string) table.Styles {
	s := table.DefaultStyles()
	s.Header = lipgloss.NewStyle().Bold(true).Padding(0, 1)
	s.Cell = lipgloss.NewStyle().Padding(0, 1)
	s.Selected = lipgloss.NewStyle().Reverse(true)
	if fg != "" {
		s.Header = s.Header.Foreground(lipgloss.Color(fg))
		s.Cell = s.Cell.Foreground(lipgloss.Color(fg))
	}
	return s
}
`;

const HELPERS = String.raw`// ── Helpers ──────────────────────────────────────────────────────────────────

// frame clips s to w x h cells and pads it to exactly that size.
func frame(s string, w, h int, hpos, vpos lipgloss.Position) string {
	s = lipgloss.NewStyle().MaxWidth(w).MaxHeight(h).Render(s)
	return lipgloss.Place(w, h, hpos, vpos, s)
}

// shift moves a block right by dx cells and down by dy lines (used by the flex layout).
func shift(s string, dx, dy int) string {
	return lipgloss.NewStyle().MarginLeft(dx).MarginTop(dy).Render(s)
}

// canvas is a grid of cells; every cell holds one character with its ANSI style.
type canvas struct {
	w, h  int
	cells [][]string
}

func newCanvas(w, h int) *canvas {
	w, h = max(w, 0), max(h, 0)
	c := &canvas{w: w, h: h, cells: make([][]string, h)}
	for y := range c.cells {
		row := make([]string, w)
		for x := range row {
			row[x] = " "
		}
		c.cells[y] = row
	}
	return c
}

func canvasOf(s string) *canvas {
	lines := strings.Split(s, "\n")
	w := 0
	for _, l := range lines {
		w = max(w, lipgloss.Width(l))
	}
	c := newCanvas(w, len(lines))
	c.put(0, 0, s)
	return c
}

func (c *canvas) set(x, y int, style, ch string, width int) {
	if y < 0 || y >= c.h || x < 0 || x+width > c.w {
		return
	}
	cell := ch
	if style != "" {
		cell = style + ch + "\x1b[0m"
	}
	c.cells[y][x] = cell
	if width == 2 {
		c.cells[y][x+1] = ""
	}
}

// put draws a (styled, multi-line) block with its top-left corner at x, y.
func (c *canvas) put(x, y int, block string) {
	style := ""
	row, col := y, x
	rs := []rune(block)
	for i := 0; i < len(rs); i++ {
		r := rs[i]
		switch {
		case r == 0x1b:
			j := i + 1
			if j < len(rs) && rs[j] == '[' {
				j++
				for j < len(rs) && (rs[j] < 0x40 || rs[j] > 0x7e) {
					j++
				}
				if j < len(rs) && rs[j] == 'm' {
					seq := string(rs[i : j+1])
					if seq == "\x1b[0m" || seq == "\x1b[m" {
						style = ""
					} else {
						style += seq
					}
				}
				i = j
			}
		case r == '\n':
			row++
			col = x
		case r == '\r':
		default:
			width := lipgloss.Width(string(r))
			if width > 0 {
				c.set(col, row, style, string(r), width)
				col += width
			}
		}
	}
}

func (c *canvas) String() string {
	lines := make([]string, len(c.cells))
	for y, row := range c.cells {
		lines[y] = strings.Join(row, "")
	}
	return strings.Join(lines, "\n")
}

// overlay draws block over base with its top-left corner at x, y.
func overlay(base string, x, y int, block string) string {
	c := canvasOf(base)
	c.put(x, y, block)
	return c.String()
}

func clip(s string, w int) string {
	for lipgloss.Width(s) > w && s != "" {
		r := []rune(s)
		s = string(r[:len(r)-1])
	}
	return s
}

func moveCursor(cur, delta, n int) int {
	if n <= 0 {
		return 0
	}
	return min(max(cur+delta, 0), n-1)
}

// menuRows renders one line per entry and highlights the current one.
func menuRows(lines []string, cur, w int, normal, hl lipgloss.Style) string {
	out := make([]string, 0, len(lines))
	for i, l := range lines {
		st := normal
		if i == cur {
			st = hl
		}
		out = append(out, st.Width(w).Render(clip(l, w)))
	}
	return strings.Join(out, "\n")
}

// tabsView renders the tab labels and a rule under them.
func tabsView(labels []string, active, w int, normal, hl lipgloss.Style) string {
	cells := make([]string, 0, len(labels))
	rule := ""
	for i, l := range labels {
		cell := " " + l + " "
		if i == active {
			cells = append(cells, hl.Render(cell))
			rule += strings.Repeat("━", lipgloss.Width(cell))
		} else {
			cells = append(cells, normal.Render(cell))
			rule += strings.Repeat("─", lipgloss.Width(cell))
		}
	}
	rule += strings.Repeat("─", max(0, w-lipgloss.Width(rule)))
	return strings.Join(cells, "") + "\n" + rule
}

// treeNode is one entry of a Tree, in depth-first order (parents come first).
type treeNode struct {
	label  string
	depth  int
	parent int
	kids   bool
}

// treeVisible lists the entries whose ancestors are all expanded.
func treeVisible(nodes []treeNode, open []bool) []int {
	var out []int
	for i, n := range nodes {
		show := true
		for p := n.parent; p >= 0; p = nodes[p].parent {
			if !open[p] {
				show = false
				break
			}
		}
		if show {
			out = append(out, i)
		}
	}
	return out
}

func treeRows(nodes []treeNode, open []bool) []string {
	var lines []string
	for _, i := range treeVisible(nodes, open) {
		n := nodes[i]
		marker := ""
		if n.kids {
			marker = "▸ "
			if open[i] {
				marker = "▾ "
			}
		}
		lines = append(lines, strings.Repeat("  ", n.depth)+marker+n.label)
	}
	return lines
}

// treeKey moves the cursor / expands / collapses and returns the new cursor.
func treeKey(nodes []treeNode, open []bool, cur int, key string) int {
	vis := treeVisible(nodes, open)
	if len(vis) == 0 {
		return 0
	}
	cur = min(max(cur, 0), len(vis)-1)
	i := vis[cur]
	switch key {
	case "up", "k":
		return moveCursor(cur, -1, len(vis))
	case "down", "j":
		return moveCursor(cur, 1, len(vis))
	case "right", "l":
		if nodes[i].kids {
			open[i] = true
		}
	case "enter", " ":
		if nodes[i].kids {
			open[i] = !open[i]
		}
	case "left", "h":
		if nodes[i].kids && open[i] {
			open[i] = false
		} else if nodes[i].parent >= 0 {
			for j, v := range vis {
				if v == nodes[i].parent {
					return j
				}
			}
		}
	}
	return cur
}
`;

export const bubbleteaAdapter: ExportAdapter = {
  id: 'bubbletea',
  label: 'Bubble Tea (Go)',
  language: 'go',
  verification: 'snapshot',
  multiScreen: false,
  generate: ({ ir }) => new Gen(ir.start).generate(),
};
