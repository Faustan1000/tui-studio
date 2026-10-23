// Blessed (Node.js) exporter.
//
// Layout strategy: SNAPSHOT. Blessed positions widgets with absolute `left/top/width/height` in
// cells, so every widget is placed at the `rel` box the editor's layout engine computed (position
// relative to the parent's OUTER box). The result matches the editor exactly at the design size
// but does not reflow when the terminal is resized.
//
// Border offsets: blessed only shifts children by the parent's border/padding when the screen is
// created with `autoPadding: true` (then `left` is relative to the parent's content area). The
// generated screen sets `autoPadding: false`, so `left/top` are relative to the parent's outer box,
// which is exactly what `rel` is. Children of a bordered box therefore land where the editor
// puts them without any compensation.
//
// Known limits: blessed has only `line` and `bg` borders (double/rounded/bold are drawn as
// `line`), no italic/strikethrough, and hidden tab/menu bodies are not part of the output.

import type { ExportAdapter, ExportFile } from '../adapter';
import { inlineText, itemText, recase, treeLines, visibleChildren } from '../ir';
import type { IRBox, IRItem, IRNode, IRScreen, IRStyle } from '../ir';
import { CodeWriter, jsStr } from '../lang';
import { apiName, buildApiModel, safeIdent } from '../api/model';
import type { ApiModel } from '../api/model';
import {
  BLESSED_RUNTIME_FILENAME,
  BLESSED_RUNTIME_SOURCE,
  BLESSED_RUNTIME_TYPES,
} from '../api/blessed/runtime';

/** Pinned blessed release. */
export const BLESSED_VERSION = '0.1.81';

const FOCUS_COLOR = '#5fafff';
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
/** U+2028 and U+2029, built here so this source file never contains them. */
const LINE_SEPARATORS = String.fromCharCode(0x2028, 0x2029);
const LINE_BREAK_RE = new RegExp('[\\r\\n' + LINE_SEPARATORS + ']+', 'g');
const SEPARATOR_RE = new RegExp('[' + LINE_SEPARATORS + ']', 'g');

const JS_RESERVED = new Set(
  (
    'break case catch class const continue debugger default delete do else enum export extends false finally for function if ' +
    'import in instanceof new null return super switch this throw true try typeof var void while with yield let static ' +
    'await async of arguments eval'
  ).split(' ')
);
const FIXED_NAMES = [
  'blessed',
  'screen',
  'require',
  'module',
  'exports',
  'process',
  'console',
  'ui',
  'Ui',
  'Handle',
  'StudioUi',
];

/** Members of the base class: a code name must not shadow them. */
const BASE_MEMBERS = [
  'start',
  'stop',
  'wait',
  'run',
  'report',
  'log',
  'errors',
  'ready',
  'running',
  'screen',
  'get',
  'on',
  'nextEvent',
  'installExcepthooks',
  'focusNext',
  'textbox',
  'wire',
  'constructor',
];

/** Where the children of a container go: the variable of the inner box and its inset. */
interface Inner {
  var: string;
  inset: number;
}

interface Ctx {
  w: CodeWriter;
  used: Set<string>;
  vars: Map<IRNode, string>;
  /** Handler names in first-use order (deduplicated stubs). */
  handlers: Set<string>;
  /** Facade member (`ui.<member>`) of the nodes that have a code name. */
  members: Map<IRNode, string>;
}

// ── Public helpers (also used by tests) ───────────────────────────────────────

/** The box a node gets in blessed: relative to the parent's outer box, at least 1x1, whole cells. */
export function blessedPlacement(node: IRNode): IRBox {
  const flow = FLOW.get(node);
  if (flow) return { x: flow.x, y: flow.y, width: flow.width, height: flow.height };
  let b: IRBox | undefined = node.rel;
  if (!b && node.box) {
    const pb = node.parent?.box;
    b = pb
      ? {
          x: node.box.x - pb.x,
          y: node.box.y - pb.y,
          width: node.box.width,
          height: node.box.height,
        }
      : node.box;
  }
  if (!b) {
    b = {
      x: 0,
      y: 0,
      width: typeof node.width === 'number' ? node.width : 10,
      height: typeof node.height === 'number' ? node.height : node.style.border ? 3 : 1,
    };
  }
  const n = (v: number) => (Number.isFinite(v) ? Math.round(v) : 0);
  // The editor's engine gives components with an automatic width a minimum width; blessed
  // clips, so such widgets get at least the width of their content.
  let width = node.width === 'auto' ? Math.max(n(b.width), intrinsicWidth(node)) : n(b.width);
  // The program can write longer text into a Text with a code name: it may grow to the right
  // edge of its parent unless the parent lays its children out in a row.
  const parent = node.parent;
  if (node.tag && node.type === 'Text' && node.width === 'auto' && parent?.box) {
    const row = parent.layout.mode === 'flex' && parent.layout.direction === 'row';
    const inner = parent.box.width - (parent.style.border ? 1 : 0) - n(b.x);
    if (!row) width = Math.max(width, inner);
  }
  const adj = ADJUST.get(node);
  return {
    x: n(b.x),
    y: n(b.y) + (adj?.dy ?? 0),
    width: Math.max(1, width),
    height: Math.max(1, n(b.height) + (adj?.dh ?? 0)),
  };
}

const longest = (lines: string[]) => Math.max(0, ...lines.map((l) => [...l].length));

/** Width of the content of a widget with an automatic width (0 = unknown). */
function intrinsicWidth(node: IRNode): number {
  const border = node.style.border ? 2 : 0;
  switch (node.type) {
    case 'Text':
      return node.wrapText ? 0 : longest(node.text.split(String.fromCharCode(10))) + border;
    case 'Checkbox':
    case 'Radio':
    case 'Toggle':
    case 'Breadcrumb':
    case 'Spinner':
    case 'Button':
      return longest([inlineText(node)]) + border;
    case 'List':
    case 'Menu':
      return longest(node.items.map((i) => itemText(i, node.type === 'Menu'))) + 1 + border;
    case 'Tree':
      return longest(treeLines(node.items).map((l) => l.text)) + 1 + border;
    case 'Select':
      return longest(node.options.length ? node.options : ['']) + 2 + border;
    case 'Table': {
      const cols = Math.max(node.columns.length, ...node.rows.map((r) => r.length));
      let total = 0;
      for (let c = 0; c < cols; c++) {
        total += longest([node.columns[c] ?? '', ...node.rows.map((r) => r[c] ?? '')]) + 2;
      }
      return total + border;
    }
    default:
      return 0;
  }
}

interface Adjust {
  dy: number;
  dh: number;
}

/** Growth of widgets that the editor sizes too small for their content, and what it shifts. */
let ADJUST = new WeakMap<IRNode, Adjust>();

/** Height of the content of a widget with an automatic height (0 = unknown). */
function intrinsicHeight(node: IRNode): number {
  const border = node.style.border ? 2 : 0;
  switch (node.type) {
    case 'List':
    case 'Menu':
      return node.items.length + border;
    case 'Tree':
      return treeLines(node.items).length + border;
    case 'Table':
      return node.rows.length + 1 + border;
    default:
      return 0;
  }
}

/**
 * Lists, menus, trees and tables with an automatic height get the height of their content;
 * siblings below them (that overlap horizontally) move down by the same amount and containers
 * with an automatic height grow. Returns how much `node` itself grows.
 */
function computeAdjust(node: IRNode): number {
  const kids = visibleChildren(node).filter((k) => k.type !== 'Spacer' && k.rel);
  const grows = new Map<IRNode, number>();
  for (const k of kids) grows.set(k, computeAdjust(k));
  const sorted = [...kids].sort((a, b) => a.rel!.y - b.rel!.y);
  let bottom = 0;
  // The editor's engine sometimes places a widget over the one above it (its height is larger
  // than the room it left); in a column that is pushed down so nothing overlaps.
  const column = node.layout.mode === 'flex' && node.layout.direction === 'column';
  let cursor = -Infinity;
  for (const k of sorted) {
    const r = k.rel!;
    let dy = 0;
    for (const e of sorted) {
      if (e === k) break;
      const er = e.rel!;
      const overlapX = er.x < r.x + r.width && r.x < er.x + er.width;
      if (overlapX && er.y + er.height <= r.y) dy += grows.get(e)!;
    }
    if (column && r.y + dy < cursor) dy = cursor - r.y;
    cursor = r.y + dy + r.height + grows.get(k)!;
    ADJUST.set(k, { dy, dh: grows.get(k)! });
    bottom = Math.max(bottom, r.y + dy + r.height + grows.get(k)!);
  }
  const canGrow = node.parent === null || node.height === 'auto';
  if (!canGrow) {
    for (const k of kids) ADJUST.set(k, { dy: 0, dh: 0 });
    return 0;
  }
  if (!node.rel) return 0;
  const own = Math.max(0, intrinsicHeight(node) - node.rel.height);
  if (own > 0) return own;
  if (!kids.length) return 0;
  return Math.max(0, bottom + (node.style.border ? 1 : 0) - node.rel.height);
}

// ── Flow layout (the Textual reference) ──────────────────────────────────────
//
// A column of auto-height children is laid out like Textual does (docs/VISUAL_SPEC.md): children
// one below the other, every widget at its natural size, border and padding of a container
// add up. The editor's own engine gives such children fixed slots, so those boxes are not used
// there. Widgets that fill the width get a percentage, so they follow the terminal.

/** A box computed by the flow layout, relative to the content area of the parent. */
interface FlowBox extends IRBox {
  /** The width is the width of the parent's content area (a percentage in the output). */
  fill: boolean;
}

let FLOW = new WeakMap<IRNode, FlowBox>();

const flowKids = (n: IRNode) =>
  visibleChildren(n).filter((k) => k.type !== 'Spacer' && k.type !== 'Modal');

/** Containers whose children are stacked top to bottom at their natural height. */
function isFlowContainer(n: IRNode): boolean {
  if (n.type !== 'Screen' && n.type !== 'Box') return false;
  const l = n.layout;
  if (l.mode !== 'flex' || l.direction !== 'column' || l.wrap || l.justify !== 'start') return false;
  if (l.align !== 'start' && l.align !== 'stretch') return false;
  return flowKids(n).every((k) => k.height === 'auto' || typeof k.height === 'number');
}

/** Border and padding of a flow container (cells per side). */
function flowFrame(n: IRNode): { b: number; l: number; t: number; h: number; v: number } {
  const b = n.style.border ? 1 : 0;
  const p = n.layout.padding;
  return { b, l: b + p.left, t: b + p.top, h: 2 * b + p.left + p.right, v: 2 * b + p.top + p.bottom };
}

/** The content area of a container with children laid out by the flow. */
export function hasFlow(n: IRNode): boolean {
  return isFlowContainer(n);
}

function tableWidth(n: IRNode): number {
  const cols = Math.max(n.columns.length, ...n.rows.map((r) => r.length));
  let total = 0;
  for (let c = 0; c < cols; c++) {
    total += longest([n.columns[c] ?? '', ...n.rows.map((r) => r[c] ?? '')]);
  }
  return total + 2 * Math.max(0, cols - 1) + 2;
}

/** Label of a tab: icon, label, status dot and hotkey, as in the reference. */
export function tabLabel(t: IRItem): string {
  return (
    (t.icon ? `${t.icon} ` : '') + t.label + (t.status ? ' ●' : '') + (t.hotkey ? ` ${t.hotkey}` : '')
  );
}

/** Natural size of a node in the flow (`fill` = as wide as the parent's content area). */
function measure(n: IRNode, avail: number): { w: number; h: number; fill: boolean } {
  const border = n.style.border ? 2 : 0;
  const numW = typeof n.width === 'number' ? n.width : null;
  const numH = typeof n.height === 'number' ? n.height : null;
  let w = 0;
  let h = 1 + border;
  let fill = n.width === 'fill';
  const stretch = () => {
    if (numW === null) fill = true;
  };
  switch (n.type) {
    case 'Screen':
    case 'Box':
      if (isFlowContainer(n)) {
        const f = flowFrame(n);
        const kids = flowKids(n);
        const inner = Math.max(1, avail - f.h);
        const sizes = kids.map((k) => measure(k, inner));
        w = Math.max(0, ...sizes.map((s) => (s.fill ? 10 : s.w))) + f.h;
        h = sizes.reduce((a, s) => a + s.h, 0) + Math.max(0, kids.length - 1) * n.layout.gap + f.v;
        if (!kids.length) h = Math.max(h, 1);
      } else {
        w = n.rel?.width ?? 10;
        h = n.rel?.height ?? 3;
      }
      break;
    case 'Text': {
      const lines = n.text.split(String.fromCharCode(10));
      w = longest(lines) + border;
      h = lines.length + border;
      break;
    }
    case 'TextInput':
      stretch();
      h = border ? 3 : 1;
      break;
    case 'Button':
      w = longest([inlineText(n)]) + 2 + border;
      if (border) w = Math.max(16, w);
      break;
    case 'Select':
      stretch();
      h = border ? 3 : 1;
      break;
    case 'ProgressBar':
      stretch();
      h = border ? 3 : 1;
      break;
    case 'Table':
      w = tableWidth(n) + border;
      h = n.rows.length + 1 + border;
      break;
    case 'List':
    case 'Menu':
      stretch();
      h = n.items.length + border;
      break;
    case 'Tree':
      stretch();
      h = treeLines(n.items).length + border;
      break;
    case 'Tabs':
      stretch();
      h = 2;
      break;
    default:
      w = longest([inlineText(n)]) + border;
  }
  if (numW !== null) {
    w = numW;
    fill = false;
  }
  if (numH !== null) h = numH;
  return { w: Math.max(1, Math.min(w, Math.max(avail, 1))), h: Math.max(1, h), fill };
}

/** Lay out the children of a flow container (and, recursively, of its flow children). */
function computeFlow(n: IRNode, avail: number): void {
  const f = flowFrame(n);
  const inner = Math.max(1, avail - f.h);
  let y = 0;
  for (const k of flowKids(n)) {
    const m = measure(k, inner);
    FLOW.set(k, { x: 0, y, width: m.w, height: m.h, fill: m.fill });
    y += m.h + n.layout.gap;
    if (isFlowContainer(k)) computeFlow(k, m.fill ? inner : m.w);
  }
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export const blessedAdapter: ExportAdapter = {
  id: 'blessed',
  label: 'Blessed (Node.js)',
  language: 'js',
  verification: 'run',
  multiScreen: false,
  generate: ({ ir }): ExportFile[] => {
    const screen = ir.start;
    // Only the first screen is exported, so only its components get handles.
    const all = buildApiModel({ screens: [screen], start: screen });
    const model = { ...all, handles: all.handles.filter((h) => h.node.visible) };
    return [
      { path: 'index.js', content: generateIndex(screen, model) },
      { path: 'index.d.ts', content: generateTypes(model) },
      { path: BLESSED_RUNTIME_FILENAME, content: BLESSED_RUNTIME_SOURCE },
      { path: 'ui-runtime.d.ts', content: BLESSED_RUNTIME_TYPES },
      { path: 'package.json', content: generatePackageJson(screen) },
    ];
  },
};

function generatePackageJson(screen: IRScreen): string {
  const pkg = {
    name: `tui-${screen.ident.replace(/_/g, '-').replace(/^-+/, '') || 'app'}`,
    version: '1.0.0',
    private: true,
    description: 'Terminal UI exported from TUI Studio (Blessed)',
    main: 'index.js',
    types: 'index.d.ts',
    scripts: { start: 'node index.js' },
    dependencies: { blessed: BLESSED_VERSION },
  };
  return JSON.stringify(pkg, null, 2) + '\n';
}

// ── index.js ──────────────────────────────────────────────────────────────────

function generateIndex(screen: IRScreen, model: ApiModel): string {
  const root = screen.root;
  const ctx: Ctx = {
    w: new CodeWriter('  ', 2),
    used: new Set<string>([...JS_RESERVED, ...FIXED_NAMES]),
    vars: new Map(),
    handlers: new Set(),
    members: new Map(),
  };
  const facade = facadeNames(model);
  for (const h of model.handles) ctx.members.set(h.node, facade.get(h.tag)!);
  collectHandlers(root, ctx);

  const rootVar = nameFor(root, ctx);
  ADJUST = new WeakMap();
  FLOW = new WeakMap();
  computeAdjust(root);
  if (isFlowContainer(root)) computeFlow(root, screen.width);
  // The root fills the terminal; the design size is only where the content sits.
  const rootInner = emitWidget(
    root,
    'screen',
    { x: 0, y: 0, width: screen.width, height: screen.height },
    ctx,
    rootVar
  );
  const viewport = rootInner ?? { var: rootVar, inset: 0 };
  // The inner box of the root is a scrollable box: the program scrolls it by moving its
  // childBase (see ui-runtime.js).
  ctx.w
    .line(
      `ui.viewport(${rootInner ? rootVar : 'null'}, ${viewport.var}, ${contentBottom(root, viewport.inset)});`
    )
    .line();
  emitChildren(root, viewport.var, ctx, viewport.inset);
  const body = ctx.w.toString().trimEnd();

  const out = new CodeWriter('  ', 0);
  const title = oneLine(screen.name || screen.ident);
  out
    .line(`// ${title} - terminal UI exported from TUI Studio (Blessed).`)
    .line('//')
    .line(
      `// Run:    npm install && npm start      (Node.js 14 or newer; terminal of at least ${screen.width}x${screen.height} cells)`
    )
    .line('// Keys:   Tab / Shift-Tab move the focus, Enter / Space activate, q or Ctrl-C quit,')
    .line(
      '//         Esc closes an open dropdown or modal. In a text field Enter or Esc leaves the field.'
    )
    .line('//         Ctrl+L shows the log panel; errors open a dialog (Enter or Esc closes it).')
    .line('//')
    .line('// Program API: components with a code name are members of `ui` (see ui-runtime.js):')
    .line('//   const { Ui } = require("./index");  const ui = new Ui();  await ui.start();')
    .line('//   ui.status.text = "..."; ui.submitBtn.onClick((e) => ...); ui.nameInput.readonly();')
    .line('//')
    .line(
      '// Layout: columns of auto-sized children are stacked like Textual does (natural size, padding adds).'
    )
    .line(
      '//         Everything else is a SNAPSHOT: each widget sits at the cell position and size the editor computed for the'
    )
    .line(
      `//         design size ${screen.width}x${screen.height}. left/top are relative to the parent's outer box`
    )
    .line(
      "//         (autoPadding is off, so a parent's border does not shift its children). The layout does"
    )
    .line(
      '//         not reflow when the terminal is resized, and hidden widgets leave their space empty.'
    )
    .line(
      '// Limits: blessed only knows "line" and "bg" borders (double, rounded and bold are drawn as line),'
    )
    .line('//         and has no italic or strikethrough.')
    .line("'use strict';")
    .line()
    .line("const blessed = require('blessed');")
    .line("const { Handle, StudioUi } = require('./ui-runtime');")
    .line();

  if (ctx.handlers.size) {
    out
      .line('// ── Event handlers: fill these in ─────────────────────────────────────────────')
      .line();
    for (const name of ctx.handlers) {
      out.line('/** Called with the widget that fired the event, then the event arguments. */');
      out
        .line(`function ${name}(widget, ...args) {`)
        .indent()
        .line('// TODO: your code')
        .dedent()
        .line('}')
        .line();
    }
  }

  out
    .line('// ── The UI ────────────────────────────────────────────────────────────────────')
    .line();
  out.line('class Ui extends StudioUi {').indent();
  out.line('constructor(options) {').indent();
  out.line('super(options);');
  out.line(`this._title = ${jsStr(screen.name || screen.ident)};`);
  for (const h of model.handles) {
    const member = facade.get(h.tag)!;
    const props: Record<string, { type: string; value: unknown }> = {};
    for (const p of h.properties)
      props[apiName(p.name, 'camel')] = { type: p.type, value: p.initial };
    out.line(`/** ${h.type}: ${oneLine(h.node.name || h.type)} */`);
    out.line(`this${memberAccess(member)} = new Handle(this, ${jsStr(h.tag)}, {`).indent();
    out.line(`type: ${jsStr(h.type)},`);
    out.line(`states: ${jsJson(h.states.map((s) => s))},`);
    out.line(`state: ${jsStr(h.initialState === 'hidden' ? 'active' : h.initialState)},`);
    out.line(`props: ${jsJson(props)},`);
    out.line(`events: ${jsJson(h.events.map((e) => e.name))},`);
    out.dedent().line('});');
  }
  out.dedent().line('}').line();
  out.line('/** Creates the widgets (called by start()). */');
  out.line('_build(screen) {').indent();
  out.line('const ui = this;');
  out.block(body);
  out.dedent().line('}');
  out.dedent().line('}').line();
  out.line('module.exports = { Ui };').line();
  out.line('if (require.main === module) {').indent();
  out.line('const ui = new Ui();');
  out.line('ui.installExcepthooks();');
  out.line('ui.run().then(');
  out.indent().line('() => process.exit(0),').line('(err) => {').indent();
  out.line('console.error(err);').line('process.exit(1);').dedent().line('}').dedent();
  out.line(');').dedent().line('}');
  return out.toString();
}

/** `ui.submitBtn` for plain names, `ui["x"]` never needed: members are identifiers. */
function memberAccess(member: string): string {
  return `.${member}`;
}

/** Facade member per code name: camelCase, keywords and clashes with the base class get a `_`. */
function facadeNames(model: ApiModel): Map<string, string> {
  const used = new Set<string>(BASE_MEMBERS);
  const out = new Map<string, string>();
  for (const h of model.handles) {
    let name = safeIdent(apiName(h.tag, 'camel'), 'ts');
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) name = 'n' + name.replace(/[^A-Za-z0-9_$]/g, '_');
    while (used.has(name) || name.startsWith('_')) name += '_';
    used.add(name);
    out.set(h.tag, name);
  }
  return out;
}

const TS_TYPES: Record<string, string> = {
  str: 'string',
  int: 'number',
  float: 'number',
  bool: 'boolean',
  str_list: 'string[]',
  rows: 'string[][]',
};

/** `index.d.ts`: the typed facade. */
function generateTypes(model: ApiModel): string {
  const facade = facadeNames(model);
  const out = new CodeWriter('  ', 0);
  out.line("import { Handle, StudioUi, UiEvent } from './ui-runtime';");
  out.line("export * from './ui-runtime';").line();
  out.line('type Listener = (event: UiEvent) => unknown;').line();
  out.line('export declare class Ui extends StudioUi {').indent();
  for (const h of model.handles) {
    const parts: string[] = [];
    for (const p of h.properties) {
      parts.push(`${apiName(p.name, 'camel')}: ${TS_TYPES[p.type] ?? 'unknown'}`);
    }
    for (const e of h.events)
      parts.push(`on${e.name.charAt(0).toUpperCase()}${e.name.slice(1)}(fn: Listener): Listener`);
    if (h.type === 'Modal') parts.push('open(): void', 'close(): void', 'readonly isOpen: boolean');
    const extra = parts.length ? ` & { ${parts.join('; ')} }` : '';
    out.line(`/** ${h.type}: ${oneLine(h.node.name || h.type).replace(/\*\//g, '* /')} */`);
    out.line(`readonly ${facade.get(h.tag)}: Handle${extra};`);
  }
  out.dedent().line('}');
  return out.toString();
}

// ── Names ─────────────────────────────────────────────────────────────────────

function oneLine(s: string): string {
  return s.replace(LINE_BREAK_RE, ' ').trim();
}

/** JSON array literal that is also valid JavaScript. */
function jsJson(v: unknown): string {
  return JSON.stringify(v).replace(SEPARATOR_RE, (c) => '\\u' + c.charCodeAt(0).toString(16));
}

/** First row below the design, relative to the inner box of the root; at least one row. */
function contentBottom(root: IRNode, inset: number): number {
  let bottom = 1;
  for (const c of visibleChildren(root)) {
    // A modal the program opens floats over the screen: it takes no room in the design.
    if (c.type === 'Spacer' || (c.type === 'Modal' && c.tag)) continue;
    const b = blessedPlacement(c);
    bottom = Math.max(bottom, b.y - (FLOW.has(c) ? 0 : inset) + b.height);
  }
  return bottom;
}

function nameFor(node: IRNode, ctx: Ctx): string {
  const existing = ctx.vars.get(node);
  if (existing) return existing;
  const base = recase(node.ident, 'camel');
  let name = base;
  for (let i = 2; ctx.used.has(name); i++) name = `${base}${i}`;
  ctx.used.add(name);
  ctx.vars.set(node, name);
  return name;
}

function handlerName(raw: string): string {
  let n = raw.replace(/[^A-Za-z0-9_$]/g, '_');
  if (!n) return '';
  if (/^[0-9]/.test(n)) n = '_' + n;
  if (JS_RESERVED.has(n) || FIXED_NAMES.includes(n)) n += '_';
  return n;
}

function collectHandlers(node: IRNode, ctx: Ctx): void {
  if (!node.visible) return;
  for (const raw of Object.values(node.events)) {
    const n = handlerName(raw);
    if (n) {
      ctx.handlers.add(n);
      ctx.used.add(n);
    }
  }
  node.children.forEach((c) => collectHandlers(c, ctx));
}

// ── Emission ──────────────────────────────────────────────────────────────────

function emitChildren(node: IRNode, parentVar: string, ctx: Ctx, inset: number): void {
  // Positions of the IR are relative to the outer box of the parent; the children of a framed
  // container sit in its inner box, one cell in.
  const place = (n: IRNode): IRBox => {
    const b = blessedPlacement(n);
    if (FLOW.has(n)) return b;
    return { ...b, x: b.x - inset, y: b.y - inset };
  };
  const kids = visibleChildren(node).filter((c) => c.type !== 'Spacer');
  for (let i = 0; i < kids.length; i++) {
    const kid = kids[i];
    if (kid.type === 'Radio') {
      // Consecutive radios form one group (blessed.radioset makes them exclusive).
      let j = i;
      while (j < kids.length && kids[j].type === 'Radio') j++;
      emitRadioGroup(
        kids.slice(i, j).map((r) => ({ node: r, box: place(r) })),
        parentVar,
        ctx
      );
      i = j - 1;
      continue;
    }
    const inner = emitWidget(kid, parentVar, place(kid), ctx);
    if (kid.children.length) {
      emitChildren(kid, inner?.var ?? nameFor(kid, ctx), ctx, inner?.inset ?? 0);
    }
  }
}

function emitRadioGroup(items: { node: IRNode; box: IRBox }[], parentVar: string, ctx: Ctx): void {
  const radios = items.map((i) => i.node);
  const boxes = items.map((i) => i.box);
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.width));
  const y1 = Math.max(...boxes.map((b) => b.y + b.height));
  const setName = nameFor(radios[0], ctx) + 'Group';
  let setVar = setName;
  for (let i = 2; ctx.used.has(setVar); i++) setVar = `${setName}${i}`;
  ctx.used.add(setVar);
  const w = ctx.w;
  w.line('// Radio group');
  obj(w, 'radioset', setVar, [
    `parent: ${parentVar}`,
    `left: ${x0}`,
    `top: ${y0}`,
    `width: ${x1 - x0}`,
    `height: ${y1 - y0}`,
    'tags: false',
  ]);
  w.line(`ui.nest(${setVar});`).line();
  radios.forEach((r, i) =>
    emitWidget(r, setVar, { ...boxes[i], x: boxes[i].x - x0, y: boxes[i].y - y0 }, ctx)
  );
}

function obj(w: CodeWriter, kind: string, name: string, opts: string[]): void {
  w.line(`const ${name} = blessed.${kind}({`).indent();
  for (const o of opts) w.line(`${o},`);
  w.dedent().line('});');
}

function styleLiteral(s: IRStyle, opts: { focus?: boolean; extra?: string[] } = {}): string {
  const parts: string[] = [];
  if (s.fg) parts.push(`fg: ${jsStr(s.fg)}`);
  if (s.bg) parts.push(`bg: ${jsStr(s.bg)}`);
  if (s.bold) parts.push('bold: true');
  if (s.underline) parts.push('underline: true');
  if (s.border?.color) parts.push(`border: { fg: ${jsStr(s.border.color)} }`);
  parts.push(...(opts.extra ?? []));
  if (opts.focus) {
    parts.push(
      s.border
        ? `focus: { border: { fg: ${jsStr(FOCUS_COLOR)} } }`
        : 'focus: { bold: true, underline: true }'
    );
  }
  return `style: { ${parts.join(', ')} }`;
}

function borderLiteral(s: IRStyle): string | null {
  if (!s.border) return null;
  const sides: string[] = [];
  for (const side of ['left', 'top', 'right', 'bottom'] as const) {
    if (!s.border[side]) sides.push(`${side}: false`);
  }
  return `border: { ${["type: 'line'", ...sides].join(', ')} }`;
}

function emitWidget(
  node: IRNode,
  parentVar: string,
  box: IRBox,
  ctx: Ctx,
  forcedName?: string
): Inner | null {
  const w = ctx.w;
  let inner: Inner | null = null;
  /** Parent of the frame: the screen itself for a modal the program can open. */
  let parentRef = parentVar;
  const v = forcedName ?? nameFor(node, ctx);
  const member = ctx.members.get(node);
  w.line(`// ${node.type}: ${oneLine(node.name || node.type)}`);

  const fill = node.parent === null;
  const flow = FLOW.get(node);
  const flowC = isFlowContainer(node);
  const wide = fill || !!flow?.fill;
  const base = (focus: boolean, extraStyle: string[] = []): string[] => {
    const o = [
      `parent: ${parentRef}`,
      `left: ${box.x}`,
      `top: ${box.y}`,
      `width: ${wide ? "'100%'" : box.width}`,
      `height: ${fill ? "'100%'" : box.height}`,
      'tags: false',
    ];
    const b = borderLiteral(node.style);
    if (b) o.push(b);
    o.push(styleLiteral(node.style, { focus: focus && !node.disabled, extra: extraStyle }));
    return o;
  };
  // Components with a code name can become active later, so they are always focusable.
  const focusable = `focusable: ${member ? 'true' : String(!node.disabled)}`;
  const selectedStyle = 'selected: { bold: true, inverse: true }';
  /**
   * A container: a frame (when it has a border) and, inside it, the scrollable box that holds
   * the children. Blessed treats the border of a scrolled parent as part of the parent, which
   * drops the last visible row of a cut container; a borderless inner box has no such border.
   */
  const container = (frameOpts: string[], floating = false): Inner => {
    const fr = flowC ? flowFrame(node) : null;
    const bordered = !!node.style.border || (!!fr && (fr.h > 0 || fr.v > 0));
    const origin = (c: 'x' | 'y') => (floating ? "'center'" : String(box[c]));
    if (floating) parentRef = 'screen';
    const frame = base(false).map((o) => {
      if (floating && o.startsWith('left:')) return `left: ${origin('x')}`;
      if (floating && o.startsWith('top:')) return `top: ${origin('y')}`;
      return o;
    });
    if (!bordered) {
      obj(w, 'scrollablebox', v, [...frame, ...frameOpts]);
      return { var: v, inset: 0 };
    }
    obj(w, 'box', v, [...frame, ...frameOpts]);
    let k = `${v}Inner`;
    for (let i = 2; ctx.used.has(k); i++) k = `${v}Inner${i}`;
    ctx.used.add(k);
    const ph = fr ? fr.h : 2;
    const pv = fr ? fr.v : 2;
    const pl = fr ? fr.l : 1;
    const pt = fr ? fr.t : 1;
    const style = [
      node.style.fg ? `fg: ${jsStr(node.style.fg)}` : '',
      node.style.bg ? `bg: ${jsStr(node.style.bg)}` : '',
    ].filter(Boolean);
    obj(w, 'scrollablebox', k, [
      `parent: ${floating ? v : parentRef}`,
      `left: ${floating ? 1 : fill ? pl : box.x + pl}`,
      `top: ${floating ? 1 : fill ? pt : box.y + pt}`,
      `width: ${wide ? `'100%-${ph}'` : Math.max(1, box.width - ph)}`,
      `height: ${fill ? `'100%-${pv}'` : Math.max(1, box.height - pv)}`,
      'tags: false',
      `style: { ${style.join(', ')} }`,
    ]);
    return { var: k, inset: pl };
  };
  /** Options of `ui.wire`; null = the widget needs no runtime view unless it has a code name. */
  let wire: string[] | null = null;

  switch (node.type) {
    case 'Screen':
    case 'Box':
    case 'Grid':
      inner = container([]);
      if (inner.var !== v) wire = [`inner: ${inner.var}`];
      break;

    case 'Modal': {
      const o: string[] = [];
      if (node.style.border && node.text) o.push(`label: ${jsStr(` ${node.text} `)}`);
      else if (node.text) o.push(`name: ${jsStr(node.text)}`);
      // A modal the program can open starts closed and belongs to the screen (it is not
      // scrolled with the design); clicks inside it must not reach the widgets behind it.
      if (member) o.push('hidden: true');
      o.push('clickable: true');
      inner = container(o, !!member);
      wire = inner.var !== v ? [`inner: ${inner.var}`] : [];
      break;
    }

    case 'Text':
      obj(w, 'box', v, [
        ...base(false),
        `content: ${jsStr(node.text)}`,
        `align: ${jsStr(node.textAlign)}`,
        `wrap: ${node.wrapText}`,
      ]);
      break;

    case 'Breadcrumb':
      obj(w, 'box', v, [...base(false), `content: ${jsStr(inlineText(node))}`, 'wrap: false']);
      break;

    case 'Spinner': {
      const label = node.text || 'Loading...';
      obj(w, 'box', v, [
        ...base(false),
        `content: ${jsStr(`${SPINNER_FRAMES[0]} ${label}`)}`,
        'wrap: false',
      ]);
      wire = [`label: ${jsStr(label)}`];
      break;
    }

    case 'Button':
      obj(w, 'button', v, [
        ...base(true),
        `content: ${jsStr(inlineText(node))}`,
        "align: 'center'",
        'mouse: true',
        'keys: true',
      ]);
      wire = [
        `prefix: ${jsStr(node.iconLeft ? `${node.iconLeft} ` : '')}`,
        `suffix: ${jsStr(node.iconRight ? ` ${node.iconRight}` : '')}`,
        focusable,
      ];
      if (node.opensScreen) {
        w.line(
          `// Opens the screen "${oneLine(node.opensScreen)}" in the editor (single-screen export: wire it in the handler).`
        );
      }
      break;

    case 'TextInput': {
      const o = [...base(true), 'inputOnFocus: true', 'mouse: true', 'keys: true'];
      if (flow && node.style.border) o.push('padding: { left: 2 }');
      if (node.value) o.push(`value: ${jsStr(node.value)}`);
      w.line(`const ${v} = ui.textbox({`).indent();
      for (const x of o) w.line(`${x},`);
      w.dedent().line('});');
      wire = [`placeholder: ${jsStr(node.placeholder)}`, focusable];
      break;
    }

    case 'Checkbox':
    case 'Toggle':
    case 'Radio': {
      const radio = node.type === 'Radio';
      obj(w, radio ? 'radiobutton' : 'checkbox', v, [
        ...base(true),
        `text: ${jsStr(node.text)}`,
        `checked: ${node.checked}`,
        'mouse: true',
        'keys: true',
      ]);
      const [on, off] =
        node.type === 'Toggle'
          ? ['[ON ]', '[OFF]']
          : radio
            ? [`(${node.glyphs.on})`, `(${node.glyphs.off})`]
            : [`[${node.glyphs.on}]`, `[${node.glyphs.off}]`];
      wire = [`on: ${jsStr(on)}`, `off: ${jsStr(off)}`, focusable];
      break;
    }

    case 'Select': {
      obj(w, 'box', v, [
        ...base(true),
        `content: ${jsStr(inlineText(node))}`,
        'wrap: false',
        'keyable: true',
        'mouse: true',
      ]);
      const names = changeHandlers(node, ctx);
      wire = [
        `options: ${jsJson(node.options.map(String))}`,
        `value: ${jsStr(node.value || node.options[0] || '')}`,
        focusable,
      ];
      if (flow && node.style.border) wire.push('chevron: true');
      if (names.length) {
        wire.push(
          `onChange: (value, index) => { ${names.map((n) => `${n}(${v}, value, index);`).join(' ')} }`
        );
      }
      break;
    }

    case 'ProgressBar': {
      // A box whose one row is drawn by the runtime: `████░░░░  50%`, as in every export.
      obj(w, 'box', v, [...base(false), 'wrap: false']);
      wire = [`value: ${node.progress.value}`, `max: ${node.progress.max}`];
      break;
    }

    case 'List':
    case 'Menu':
    case 'Tree': {
      const labels =
        node.type === 'Tree'
          ? treeLines(node.items).map((l) => l.text)
          : node.type === 'List' && flow
            ? node.items.map((i) => i.label)
            : node.items.map((i) => itemText(i, node.type === 'Menu'));
      obj(w, 'list', v, [
        ...base(true, [selectedStyle]),
        `items: ${strArray(labels)}`,
        'keys: true',
        'mouse: true',
        'interactive: true',
      ]);
      if (node.type !== 'Tree' && node.selected > 0 && node.selected < labels.length) {
        w.line(`${v}.select(${node.selected});`);
      }
      wire = [`items: ${strArray(labels)}`, focusable];
      if (node.type === 'Tree') wire.push('byLabel: true');
      break;
    }

    case 'Table': {
      const rows = [node.columns, ...node.rows];
      const cell = [
        node.style.fg ? `fg: ${jsStr(node.style.fg)}` : '',
        node.style.bg ? `bg: ${jsStr(node.style.bg)}` : '',
        selectedStyle,
      ].filter(Boolean);
      const o = base(true).filter((x) => !x.startsWith('style:'));
      o.push(
        styleLiteral(node.style, {
          focus: !node.disabled,
          extra: ['header: { bold: true }', `cell: { ${cell.join(', ')} }`],
        })
      );
      if (flow && node.style.border) o.push('padding: { left: 1 }');
      obj(w, 'listtable', v, [
        ...o,
        `rows: ${jsJson(rows.map((r) => r.map(String)))}`,
        "align: 'left'",
        'noCellBorders: true',
        'keys: true',
        'mouse: true',
        'interactive: true',
      ]);
      wire = [
        `columns: ${jsJson(node.columns.map(String))}`,
        `rows: ${jsJson(node.rows.map((r) => r.map(String)))}`,
        focusable,
      ];
      if (flow && node.style.border) wire.push('indent: 1');
      break;
    }

    case 'Tabs': {
      const tabs = node.items.map((t) =>
        flow ? tabLabel(t) : (t.status ? '● ' : '') + (t.icon ? `${t.icon} ` : '') + t.label
      );
      const names = changeHandlers(node, ctx);
      w.line(`const ${v} = blessed.listbar({`).indent();
      for (const x of [
        ...base(true, ['item: {}', selectedStyle]),
        'keys: true',
        'mouse: true',
        'autoCommandKeys: false',
      ])
        w.line(`${x},`);
      w.line('commands: [').indent();
      for (const t of tabs) w.line(`{ text: ${jsStr(t)}, prefix: '' },`);
      w.dedent().line('],').dedent().line('});');
      w.line(`ui.nest(${v});`);
      if (node.selected > 0 && node.selected < tabs.length) {
        w.line(`${v}.select(${node.selected});`);
      }
      wire = [`tabs: ${strArray(tabs)}`, focusable];
      if (flow) wire.push('underline: true');
      if (names.length) {
        wire.push(`onChange: (index) => { ${names.map((n) => `${n}(${v}, index);`).join(' ')} }`);
      }
      break;
    }

    case 'Spacer':
      return null;
  }

  if (node.style.border?.kind === 'rounded') w.line(`ui.rounded(${v});`);
  wireEvents(node, v, ctx);
  if (wire || member) {
    w.line(
      `ui.wire(${v}, ${jsStr(node.type)}, { ${(wire ?? []).join(', ')} }, ${member ? `ui.${member}` : 'null'});`
    );
  }
  w.line();
  return inner;
}

function strArray(items: string[]): string {
  return '[' + items.map(jsStr).join(', ') + ']';
}

// ── Events ────────────────────────────────────────────────────────────────────

const CHANGE_KEYS = ['onChange', 'onSelect', 'onClick', 'onSubmit'];

/** Handlers that run when a Select / Tabs value changes (blessed has no single event for it). */
function changeHandlers(node: IRNode, ctx: Ctx): string[] {
  const names = new Set<string>();
  for (const key of CHANGE_KEYS) {
    const n = handlerName(node.events[key] ?? '');
    if (n && ctx.handlers.has(n)) names.add(n);
  }
  return [...names];
}

function wireEvents(node: IRNode, v: string, ctx: Ctx): void {
  const w = ctx.w;
  const callbackKind = node.type === 'Select' || node.type === 'Tabs';
  for (const [key, raw] of Object.entries(node.events)) {
    const name = handlerName(raw);
    if (!name) continue;
    if (callbackKind && CHANGE_KEYS.includes(key)) continue;
    const call = (args = '') => `${name}(${v}${args ? `, ${args}` : ''})`;
    const on = (ev: string, args = '', params = '') =>
      w.line(`${v}.on(${jsStr(ev)}, (${params}) => ${call(args)});`);
    switch (key) {
      case 'onFocus':
        on('focus');
        break;
      case 'onBlur':
        on('blur');
        break;
      case 'onKeyPress':
        on('keypress', 'ch, key', 'ch, key');
        break;
      case 'onClick':
      case 'onChange':
      case 'onSubmit':
      case 'onSelect':
        switch (node.type) {
          case 'Button':
            on('press');
            break;
          case 'Checkbox':
          case 'Toggle':
          case 'Radio':
            w.line(
              `['check', 'uncheck'].forEach((ev) => ${v}.on(ev, () => ${call(`${v}.checked`)}));`
            );
            break;
          case 'TextInput':
            if (key === 'onChange')
              w.line(`${v}.on('keypress', () => setImmediate(() => ${call(`${v}.getValue()`)}));`);
            else if (key === 'onSubmit') on('submit', 'value', 'value');
            else on('click');
            break;
          case 'List':
          case 'Menu':
          case 'Tree':
          case 'Table':
            if (key === 'onChange') on('select item', 'index', 'item, index');
            else on('select', 'index', 'item, index');
            break;
          default:
            on('click');
        }
        break;
      default:
        w.line(`// ${oneLine(key)} has no blessed event; call ${name}(${v}) from your own code.`);
    }
  }
}
