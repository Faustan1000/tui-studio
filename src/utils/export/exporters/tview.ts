// tview (Go) exporter, generated from the export IR.
//
// Output: `main.go` + `go.mod` (tview v0.42.0 on tcell v2).
//
// Layout strategy per container (also written into the header of the generated file):
//   - flex (no wrap)      NATIVE: tview.Flex. IR `row` = tview.FlexColumn (items side by side),
//                         IR `column` = tview.FlexRow (items stacked). Fixed sizes use the IR
//                         numbers (`auto` = the size the editor computed), `fill` = proportion 1.
//                         `gap` = fixed empty items, `justify` = flexible empty items,
//                         `align` / fixed cross sizes = a small cross-direction Flex around the
//                         child, `padding` = Box.SetBorderPadding.
//   - grid                NATIVE: tview.Grid with tracks measured from the editor layout.
//   - wrap / absolute / none  SNAPSHOT: nested Flex rows and spacers built from the editor
//                         positions (`rel`). Reproduces the design size; overlapping children are
//                         placed one after another.
//   - Modal               a centred overlay page in a tview.Pages on top of the screen.
//
// Limitations: tview.Borders is global, so the most common border kind is used everywhere;
// per-side borders and text styles outside TextView-based widgets are not representable; the
// editor's tab bodies are not part of the tabs widget (they are siblings), so the tab bar only
// highlights the selected tab and calls the user's handler.

import type { ExportAdapter, ExportFile } from '../adapter';
import { inlineText, itemText, progressText, recase, treeLines, visibleChildren } from '../ir';
import type { BorderKind, IRItem, IRNode, IRScreen } from '../ir';
import { CodeWriter, goStr } from '../lang';

export const TVIEW_VERSION = 'v0.42.0';
export const TCELL_VERSION = 'v2.8.1';

const GO_RESERVED = [
  // keywords
  'break',
  'case',
  'chan',
  'const',
  'continue',
  'default',
  'defer',
  'else',
  'fallthrough',
  'for',
  'func',
  'go',
  'goto',
  'if',
  'import',
  'interface',
  'map',
  'package',
  'range',
  'return',
  'select',
  'struct',
  'switch',
  'type',
  'var',
  // predeclared
  'any',
  'append',
  'bool',
  'byte',
  'cap',
  'clear',
  'close',
  'complex',
  'copy',
  'delete',
  'error',
  'false',
  'float32',
  'float64',
  'imag',
  'int',
  'int8',
  'int16',
  'int32',
  'int64',
  'iota',
  'len',
  'make',
  'max',
  'min',
  'new',
  'nil',
  'panic',
  'print',
  'println',
  'real',
  'recover',
  'rune',
  'string',
  'true',
  'uint',
  'uint8',
  'uint16',
  'uint32',
  'uint64',
  'uintptr',
  // used by the generated code
  'main',
  'app',
  'pages',
  'tview',
  'tcell',
  'time',
  'focusables',
  'cycleFocus',
  'event',
  'checked',
  'other',
  'frames',
  'frame',
  'text',
  'label',
  'node',
  'current',
  'next',
  'step',
  'typing',
  'key',
  'row',
  'column',
  'selected',
  'index',
  'i',
  'err',
];

interface Item {
  expr: string;
  fixed: number;
  prop: number;
}

const FOCUSABLE = new Set([
  'TextInput',
  'Button',
  'Checkbox',
  'Radio',
  'Toggle',
  'Select',
  'Table',
  'List',
  'Menu',
  'Tree',
  'Tabs',
]);
const BORDER_RUNES: Record<BorderKind, string[]> = {
  // horizontal, vertical, top-left, top-right, bottom-left, bottom-right
  single: ['─', '│', '┌', '┐', '└', '┘'],
  double: ['═', '║', '╔', '╗', '╚', '╝'],
  rounded: ['─', '│', '╭', '╮', '╰', '╯'],
  bold: ['━', '┃', '┏', '┓', '┗', '┛'],
};

/** Terminal cells a string needs (wide characters count twice). */
function cellWidth(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    n +=
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0x1f300 && c <= 0x1faff)
        ? 2
        : 1;
  }
  return n;
}

const esc = (s: string) => `tview.Escape(${goStr(s)})`;
const color = (hex: string) => `tcell.GetColor(${goStr(hex)})`;

class TviewGen {
  private w = new CodeWriter('\t', 1);
  private names = new Set<string>(GO_RESERVED);
  private vars = new Map<IRNode, string>();
  private handlerNames = new Map<string, string>();
  private modalQueue: IRNode[] = [];
  private focusScopes: string[][] = [[]];
  private radioRun: { node: IRNode; v: string }[] = [];
  usesTime = false;
  private spinnerBlocks: string[][] = [];
  borders = new Map<BorderKind, number>();

  constructor(private readonly screen: IRScreen) {}

  // ── Names ───────────────────────────────────────────────────────────────────

  claim(base: string): string {
    let candidate = GO_RESERVED.includes(base) || this.names.has(base) ? `${base}Node` : base;
    for (let i = 2; this.names.has(candidate); i++) candidate = `${base}Node${i}`;
    this.names.add(candidate);
    return candidate;
  }

  private varFor(node: IRNode): string {
    let v = this.vars.get(node);
    if (!v) {
      v = this.claim(recase(node.ident, 'camel'));
      this.vars.set(node, v);
    }
    return v;
  }

  private handler(raw: string): string {
    let name = this.handlerNames.get(raw);
    if (!name) {
      const clean = /^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)
        ? raw
        : 'handler' +
          (raw.match(/[A-Za-z0-9]+/g) ?? ['Event'])
            .map((p) => p[0].toUpperCase() + p.slice(1))
            .join('');
      name = this.claim(clean);
      this.handlerNames.set(raw, name);
    }
    return name;
  }

  /** Event handlers bound to the node's main callback (focus/blur/key events only get stubs). */
  private calls(node: IRNode): string[] {
    const out: string[] = [];
    for (const [key, raw] of Object.entries(node.events)) {
      if (!raw.trim()) continue;
      const name = this.handler(raw);
      if (!['onFocus', 'onBlur', 'onKeyPress'].includes(key) && !out.includes(name)) out.push(name);
    }
    return out;
  }

  handlerStubs(): string[] {
    return [...this.handlerNames.values()];
  }

  // ── Entry ───────────────────────────────────────────────────────────────────

  generate(): string {
    const root = this.screen.root;
    const rootVar = this.place(root);
    const overlays: { name: string; v: string; focus: string[] }[] = [];
    while (this.modalQueue.length) {
      const modal = this.modalQueue.shift()!;
      this.focusScopes.push([]);
      const m = this.place(modal);
      const focus = this.focusScopes.pop()!;
      overlays.push({ name: modal.ident, v: this.overlay(modal, m), focus });
    }

    const w = this.w;
    let rootExpr = rootVar;
    if (overlays.length) {
      w.line('pages := tview.NewPages()');
      w.line(`pages.AddPage("main", ${rootVar}, true, true)`);
      for (const o of overlays) w.line(`pages.AddPage(${goStr(o.name)}, ${o.v}, true, true)`);
      rootExpr = 'pages';
    }

    const focusList =
      overlays.length && overlays[overlays.length - 1].focus.length
        ? overlays[overlays.length - 1].focus
        : this.focusScopes[0];
    if (focusList.length) {
      w.line(`focusables := []tview.Primitive{${focusList.join(', ')}}`);
      w.line('cycleFocus := func(step int) {').indent();
      w.line('current := app.GetFocus()');
      w.line('next := 0');
      w.line('for i, p := range focusables {').indent();
      w.line('if p == current {').indent();
      w.line('next = (i + step + len(focusables)) % len(focusables)');
      w.line('break');
      w.dedent().line('}');
      w.dedent().line('}');
      w.line('app.SetFocus(focusables[next])');
      w.dedent().line('}');
    }

    for (const block of this.spinnerBlocks) for (const l of block) w.line(l);

    w.line('app.SetInputCapture(func(event *tcell.EventKey) *tcell.EventKey {').indent();
    w.line('switch event.Key() {');
    w.line('case tcell.KeyCtrlC:').indent();
    w.line('app.Stop()');
    w.line('return nil');
    w.dedent();
    if (focusList.length) {
      w.line('case tcell.KeyTab:').indent();
      w.line('cycleFocus(1)');
      w.line('return nil');
      w.dedent();
      w.line('case tcell.KeyBacktab:').indent();
      w.line('cycleFocus(-1)');
      w.line('return nil');
      w.dedent();
    }
    w.line('case tcell.KeyRune:').indent();
    w.line("if event.Rune() == 'q' {").indent();
    w.line('if _, typing := app.GetFocus().(*tview.InputField); !typing {').indent();
    w.line('app.Stop()');
    w.line('return nil');
    w.dedent().line('}');
    w.dedent().line('}');
    w.dedent();
    w.line('}');
    w.line('return event');
    w.dedent().line('})');
    w.line();
    if (focusList.length) w.line(`app.SetRoot(${rootExpr}, true).SetFocus(focusables[0])`);
    else w.line(`app.SetRoot(${rootExpr}, true)`);
    w.line('if err := app.EnableMouse(true).Run(); err != nil {').indent();
    w.line('panic(err)');
    w.dedent().line('}');
    return w.toString();
  }

  /** Centred overlay for a modal: [nil][modal][nil] in both directions. */
  private overlay(modal: IRNode, m: string): string {
    const v = this.claim(`${m}Overlay`);
    const { w: width, h: height } = this.size(modal);
    const inner = this.claim(`${m}Column`);
    this.w.line(
      `${inner} := tview.NewFlex().SetDirection(tview.FlexRow).AddItem(nil, 0, 1, false).AddItem(${m}, ${Math.max(3, height)}, 0, true).AddItem(nil, 0, 1, false)`
    );
    this.w.line(
      `${v} := tview.NewFlex().SetDirection(tview.FlexColumn).AddItem(nil, 0, 1, false).AddItem(${inner}, ${Math.max(5, width)}, 0, true).AddItem(nil, 0, 1, false)`
    );
    return v;
  }

  // ── Nodes ───────────────────────────────────────────────────────────────────

  private place(node: IRNode): string {
    if (
      node.type === 'Screen' ||
      node.type === 'Box' ||
      node.type === 'Grid' ||
      node.type === 'Modal'
    )
      return this.container(node);
    return this.leaf(node);
  }

  /** Children as primitives, in order (radio runs become mutually exclusive groups). */
  private placeKids(kids: IRNode[]): string[] {
    const out: string[] = [];
    kids.forEach((kid, i) => {
      out.push(this.place(kid));
      if (kid.type !== 'Radio') return;
      this.radioRun.push({ node: kid, v: out[i] });
      if (kids[i + 1]?.type !== 'Radio') this.flushRadios();
    });
    return out;
  }

  private flushRadios(): void {
    const run = this.radioRun;
    this.radioRun = [];
    if (!run.length) return;
    const w = this.w;
    const group = this.claim(`${run[0].v}Group`);
    w.line(`${group} := []*tview.Checkbox{${run.map((r) => r.v).join(', ')}}`);
    for (const r of run) {
      w.line(`${r.v}.SetChangedFunc(func(checked bool) {`).indent();
      w.line('if checked {').indent();
      w.line(`for _, other := range ${group} {`).indent();
      w.line(`if other != ${r.v} {`).indent();
      w.line('other.SetChecked(false)');
      w.dedent().line('}');
      w.dedent().line('}');
      for (const c of this.calls(r.node)) w.line(`${c}()`);
      w.dedent().line('}');
      w.dedent().line('})');
    }
  }

  private container(node: IRNode): string {
    const kids = visibleChildren(node).filter((k) => {
      if (k.type === 'Modal') {
        this.modalQueue.push(k);
        return false;
      }
      return true;
    });
    const l = node.layout;
    if (l.mode === 'grid') return this.gridContainer(node, kids);
    if (l.mode === 'flex' && !l.wrap) return this.flexContainer(node, kids);
    return this.snapshotContainer(node, kids);
  }

  private flexContainer(node: IRNode, kids: IRNode[]): string {
    const v = this.varFor(node);
    const dir = node.layout.direction;
    this.w.line(
      `${v} := tview.NewFlex().SetDirection(${dir === 'row' ? 'tview.FlexColumn' : 'tview.FlexRow'})`
    );
    this.boxStyle(node, v);
    const exprs = this.placeKids(kids);
    const items = kids.map((k, i) => this.item(k, exprs[i], dir, node.layout.align));
    this.addItems(v, this.justify(items, node));
    return v;
  }

  private snapshotContainer(node: IRNode, kids: IRNode[]): string {
    const v = this.varFor(node);
    this.w.line(`${v} := tview.NewFlex().SetDirection(tview.FlexRow)`);
    this.boxStyle(node, v);
    const exprs = this.placeKids(kids);
    const pad = node.layout.padding;
    const inset = node.style.border ? 1 : 0;
    const ox = pad.left + inset;
    const oy = pad.top + inset;

    const placed = kids
      .map((k, i) => ({
        k,
        expr: exprs[i],
        x: k.rel?.x ?? ox,
        y: k.rel?.y ?? oy,
        w: this.size(k).w,
        h: this.size(k).h,
      }))
      .sort((a, b) => a.y - b.y || a.x - b.x);
    const rows: (typeof placed)[] = [];
    for (const p of placed) {
      const last = rows[rows.length - 1];
      if (last && last[0].y === p.y) last.push(p);
      else rows.push([p]);
    }

    let cursorY = oy;
    const outer: Item[] = [];
    rows.forEach((row, ri) => {
      const rowH = Math.max(...row.map((p) => p.h));
      if (row[0].y > cursorY) outer.push({ expr: 'nil', fixed: row[0].y - cursorY, prop: 0 });
      const rv = this.claim(`${v}Row${ri + 1}`);
      this.w.line(`${rv} := tview.NewFlex().SetDirection(tview.FlexColumn)`);
      let cursorX = ox;
      const inner: Item[] = [];
      for (const p of row) {
        if (p.x > cursorX) inner.push({ expr: 'nil', fixed: p.x - cursorX, prop: 0 });
        const cell = `tview.NewFlex().SetDirection(tview.FlexRow).AddItem(${p.expr}, ${p.h}, 0, false).AddItem(nil, 0, 1, false)`;
        inner.push({ expr: cell, fixed: p.w, prop: 0 });
        cursorX = Math.max(cursorX, p.x) + p.w;
      }
      this.addItems(rv, inner);
      outer.push({ expr: rv, fixed: rowH, prop: 0 });
      cursorY = Math.max(cursorY, row[0].y) + rowH;
    });
    outer.push({ expr: 'nil', fixed: 0, prop: 1 });
    this.addItems(v, outer);
    return v;
  }

  private gridContainer(node: IRNode, kids: IRNode[]): string {
    const v = this.varFor(node);
    const l = node.layout;
    const cols = Math.max(1, l.columns);
    const rowCount = Math.max(l.rows, Math.ceil(kids.length / cols), 1);
    this.w.line(`${v} := tview.NewGrid().SetGap(${l.rowGap}, ${l.columnGap})`);
    this.boxStyle(node, v);
    const exprs = this.placeKids(kids);

    // Tracks are measured from the children (the editor positions of auto-sized cells are not reliable).
    const colW: number[] = Array.from({ length: cols }, () => 0);
    const rowH: number[] = Array.from({ length: rowCount }, () => 0);
    kids.forEach((k, i) => {
      const d = this.size(k);
      colW[i % cols] = Math.max(colW[i % cols], d.w);
      rowH[Math.floor(i / cols)] = Math.max(rowH[Math.floor(i / cols)], d.h);
    });
    this.w.line(`${v}.SetColumns(${colW.join(', ')})`);
    this.w.line(`${v}.SetRows(${rowH.join(', ')})`);
    kids.forEach((_, i) => {
      this.w.line(
        `${v}.AddItem(${exprs[i]}, ${Math.floor(i / cols)}, ${i % cols}, 1, 1, 0, 0, false)`
      );
    });
    return v;
  }

  // ── Sizes ───────────────────────────────────────────────────────────────────
  // The editor's layout engine reports 1-cell widths for content-sized widgets (it never measures
  // text), so `auto` sizes are measured here from the widget's content and the editor size is
  // only used as a lower bound.

  private sizes = new Map<IRNode, { w: number; h: number }>();

  private size(node: IRNode): { w: number; h: number } {
    const known = this.sizes.get(node);
    if (known) return known;
    const own = node.style.border ? 2 : 0;
    const guess = this.isBox(node) ? this.boxSize(node) : this.contentSize(node);
    const w =
      typeof node.width === 'number'
        ? node.width
        : Math.max(guess.w + (this.isBox(node) ? 0 : own), node.rel?.width ?? 0, 1);
    const h =
      typeof node.height === 'number'
        ? node.height
        : Math.max(guess.h + (this.isBox(node) ? 0 : own), node.rel?.height ?? 0, 1);
    const out = { w, h };
    this.sizes.set(node, out);
    return out;
  }

  private isBox(node: IRNode): boolean {
    return (
      node.type === 'Screen' || node.type === 'Box' || node.type === 'Grid' || node.type === 'Modal'
    );
  }

  private liveKids(node: IRNode): IRNode[] {
    return visibleChildren(node).filter((k) => k.type !== 'Modal');
  }

  private boxSize(node: IRNode): { w: number; h: number } {
    const l = node.layout;
    const extraW = l.padding.left + l.padding.right + (node.style.border ? 2 : 0);
    const extraH = l.padding.top + l.padding.bottom + (node.style.border ? 2 : 0);
    const kids = this.liveKids(node);
    const dims = kids.map((k) => this.size(k));
    let w = 0;
    let h = 0;
    if (l.mode === 'grid') {
      const cols = Math.max(1, l.columns);
      const colW: number[] = [];
      const rowH: number[] = [];
      dims.forEach((d, i) => {
        colW[i % cols] = Math.max(colW[i % cols] ?? 0, d.w);
        rowH[Math.floor(i / cols)] = Math.max(rowH[Math.floor(i / cols)] ?? 0, d.h);
      });
      w = colW.reduce((a, b) => a + b, 0) + Math.max(0, colW.length - 1) * l.columnGap;
      h = rowH.reduce((a, b) => a + b, 0) + Math.max(0, rowH.length - 1) * l.rowGap;
    } else if (l.mode === 'flex' && !l.wrap) {
      const gaps = Math.max(0, dims.length - 1) * l.gap;
      if (l.direction === 'row') {
        w = dims.reduce((a, d) => a + d.w, 0) + gaps;
        h = Math.max(0, ...dims.map((d) => d.h));
      } else {
        w = Math.max(0, ...dims.map((d) => d.w));
        h = dims.reduce((a, d) => a + d.h, 0) + gaps;
      }
    } else {
      kids.forEach((k, i) => {
        w = Math.max(
          w,
          (k.rel?.x ?? 0) - (l.padding.left + (node.style.border ? 1 : 0)) + dims[i].w
        );
        h = Math.max(
          h,
          (k.rel?.y ?? 0) - (l.padding.top + (node.style.border ? 1 : 0)) + dims[i].h
        );
      });
    }
    return { w: w + extraW, h: h + extraH };
  }

  /** Content size of a widget without its border. */
  private contentSize(node: IRNode): { w: number; h: number } {
    const lines = (t: string) => t.split('\n');
    const widest = (xs: string[]) => Math.max(0, ...xs.map(cellWidth));
    switch (node.type) {
      case 'Text': {
        const ls = lines(node.text);
        return { w: widest(ls), h: ls.length };
      }
      case 'Button':
        return { w: cellWidth(inlineText(node)) + 4, h: 1 };
      case 'Checkbox':
      case 'Radio':
      case 'Toggle':
        return { w: cellWidth(node.text) + 2, h: 1 };
      case 'Select':
        return { w: widest(node.options) + 4, h: 1 };
      case 'TextInput':
        return { w: Math.max(10, cellWidth(node.value || node.placeholder) + 2), h: 1 };
      case 'ProgressBar':
        return { w: 20, h: 1 };
      case 'Spinner':
        return { w: cellWidth(node.text || 'Loading...') + 2, h: 1 };
      case 'Breadcrumb':
        return { w: cellWidth(inlineText(node)), h: 1 };
      case 'Table': {
        const cols = Math.max(node.columns.length, ...node.rows.map((r) => r.length), 0);
        let w = 0;
        for (let c = 0; c < cols; c++)
          w +=
            Math.max(
              cellWidth(node.columns[c] ?? ''),
              ...node.rows.map((r) => cellWidth(r[c] ?? ''))
            ) + 1;
        return { w, h: node.rows.length + (node.columns.length ? 1 : 0) };
      }
      case 'List':
      case 'Menu':
        return { w: widest(node.items.map((i) => itemText(i))) + 2, h: node.items.length };
      case 'Tree': {
        const ls = treeLines(node.items);
        return { w: widest(ls.map((l) => l.text)) + 2, h: ls.length };
      }
      case 'Tabs':
        return { w: node.items.reduce((a, i) => a + cellWidth(i.label) + 3, 0), h: 1 };
      default:
        return { w: 1, h: 1 };
    }
  }

  // ── Flex helpers ────────────────────────────────────────────────────────────

  private mainSize(k: IRNode, dir: 'row' | 'column'): number | 'fill' {
    const d = dir === 'row' ? k.width : k.height;
    if (typeof d === 'number') return Math.max(1, d);
    if (d === 'fill') return 'fill';
    return dir === 'row' ? this.size(k).w : this.size(k).h;
  }

  private crossSize(k: IRNode, dir: 'row' | 'column', align: string): number | 'fill' {
    const d = dir === 'row' ? k.height : k.width;
    if (typeof d === 'number') return Math.max(1, d);
    if (d === 'fill' || align === 'stretch') return 'fill';
    return dir === 'row' ? this.size(k).h : this.size(k).w;
  }

  private item(k: IRNode, expr: string, dir: 'row' | 'column', align: string): Item {
    const main = this.mainSize(k, dir);
    const cross = this.crossSize(k, dir, align);
    let out = expr;
    if (typeof cross === 'number') {
      const crossDir = dir === 'row' ? 'tview.FlexRow' : 'tview.FlexColumn';
      const spacer = '.AddItem(nil, 0, 1, false)';
      const pre = align === 'center' || align === 'end' ? spacer : '';
      const post = align === 'end' ? '' : spacer;
      out = `tview.NewFlex().SetDirection(${crossDir})${pre}.AddItem(${expr}, ${cross}, 0, false)${post}`;
    }
    return main === 'fill' ? { expr: out, fixed: 0, prop: 1 } : { expr: out, fixed: main, prop: 0 };
  }

  /** Insert gap items and flexible spacers for gap/justify. */
  private justify(items: Item[], node: IRNode): Item[] {
    const { gap, justify } = node.layout;
    const flex = (n: number): Item => ({ expr: 'nil', fixed: 0, prop: n });
    const gapItem = (): Item[] => (gap > 0 ? [{ expr: 'nil', fixed: gap, prop: 0 }] : []);
    const hasFill = items.some((i) => i.prop > 0);
    const between = (sep: () => Item[]): Item[] =>
      items.flatMap((it, i) => (i === 0 ? [it] : [...sep(), it]));
    if (hasFill || !items.length) return between(gapItem);
    switch (justify) {
      case 'center':
        return [flex(1), ...between(gapItem), flex(1)];
      case 'end':
        return [flex(1), ...between(gapItem)];
      case 'space-between':
        return between(() => [...gapItem(), flex(1)]);
      case 'space-around':
        return [flex(1), ...between(() => [...gapItem(), flex(2)]), flex(1)];
      default:
        return [...between(gapItem), flex(1)];
    }
  }

  private addItems(v: string, items: Item[]): void {
    for (const it of items) this.w.line(`${v}.AddItem(${it.expr}, ${it.fixed}, ${it.prop}, false)`);
  }

  // ── Style ───────────────────────────────────────────────────────────────────

  private boxStyle(node: IRNode, v: string): void {
    const s = node.style;
    const p = node.layout.padding;
    if (s.bg) this.w.line(`${v}.SetBackgroundColor(${color(s.bg)})`);
    if (s.border) {
      this.w.line(`${v}.SetBorder(true)`);
      if (s.border.color) this.w.line(`${v}.SetBorderColor(${color(s.border.color)})`);
      this.borders.set(s.border.kind, (this.borders.get(s.border.kind) ?? 0) + 1);
    }
    const title =
      node.type === 'Modal'
        ? node.text
        : typeof node.props.title === 'string'
          ? node.props.title
          : '';
    if (title) {
      this.w.line(`${v}.SetTitle(${esc(title)})`);
      this.w.line(`${v}.SetTitleAlign(tview.AlignLeft)`);
    }
    if (
      node.type === 'Screen' ||
      node.type === 'Box' ||
      node.type === 'Grid' ||
      node.type === 'Modal'
    ) {
      if (p.top || p.right || p.bottom || p.left)
        this.w.line(`${v}.SetBorderPadding(${p.top}, ${p.bottom}, ${p.left}, ${p.right})`);
    }
  }

  private textFlags(node: IRNode): string {
    const s = node.style;
    return (
      (s.bold ? 'b' : '') +
      (s.italic ? 'i' : '') +
      (s.underline ? 'u' : '') +
      (s.strikethrough ? 's' : '')
    );
  }

  private styled(node: IRNode, inner: string): string {
    const flags = this.textFlags(node);
    return flags ? `"[::${flags}]" + ${inner} + "[::-]"` : inner;
  }

  // ── Leaves ──────────────────────────────────────────────────────────────────

  private leaf(node: IRNode): string {
    const v = this.varFor(node);
    const w = this.w;
    const fg = node.style.fg;
    const bind = (setter: string, params: string) => {
      const calls = this.calls(node);
      if (!calls.length) return;
      w.line(`${v}.${setter}(func(${params}) {`).indent();
      for (const c of calls) w.line(`${c}()`);
      w.dedent().line('})');
    };

    switch (node.type) {
      case 'Text': {
        const align =
          node.textAlign === 'center'
            ? 'tview.AlignCenter'
            : node.textAlign === 'right'
              ? 'tview.AlignRight'
              : 'tview.AlignLeft';
        w.line(
          `${v} := tview.NewTextView().SetDynamicColors(true).SetWrap(${node.wrapText}).SetTextAlign(${align}).SetText(${this.styled(node, esc(node.text))})`
        );
        if (fg) w.line(`${v}.SetTextColor(${color(fg)})`);
        break;
      }
      case 'Breadcrumb': {
        w.line(
          `${v} := tview.NewTextView().SetDynamicColors(true).SetText(${this.styled(node, esc(inlineText(node)))})`
        );
        if (fg) w.line(`${v}.SetTextColor(${color(fg)})`);
        break;
      }
      case 'ProgressBar': {
        const total = this.size(node).w;
        const pct = Math.round(
          Math.max(0, Math.min(1, node.progress.value / node.progress.max)) * 100
        );
        w.line(
          `${v} := tview.NewTextView().SetText(${goStr(`${progressText(node, Math.max(1, total - 5))} ${pct}%`)})`
        );
        if (fg) w.line(`${v}.SetTextColor(${color(fg)})`);
        break;
      }
      case 'Spinner': {
        const label = node.text || 'Loading...';
        w.line(
          `${v} := tview.NewTextView().SetDynamicColors(true).SetText(${this.styled(node, esc(`⠋ ${label}`))})`
        );
        if (fg) w.line(`${v}.SetTextColor(${color(fg)})`);
        this.usesTime = true;
        const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'].map(goStr).join(', ');
        this.spinnerBlocks.push([
          'go func() {',
          `\tframes := []string{${frames}}`,
          '\tfor i := 0; ; i++ {',
          '\t\tframe := frames[i%len(frames)]',
          '\t\ttime.Sleep(100 * time.Millisecond)',
          '\t\tapp.QueueUpdateDraw(func() {',
          `\t\t\t${v}.SetText(${this.styled(node, `tview.Escape(frame + ${goStr(' ' + label)})`)})`,
          '\t\t})',
          '\t}',
          '}()',
        ]);
        break;
      }
      case 'Spacer':
        w.line(`${v} := tview.NewBox()`);
        break;
      case 'TextInput': {
        w.line(`${v} := tview.NewInputField()`);
        if (node.value) w.line(`${v}.SetText(${goStr(node.value)})`);
        if (node.placeholder) w.line(`${v}.SetPlaceholder(${goStr(node.placeholder)})`);
        if (fg) w.line(`${v}.SetFieldTextColor(${color(fg)})`);
        if (node.style.bg) w.line(`${v}.SetFieldBackgroundColor(${color(node.style.bg)})`);
        if (node.disabled) w.line(`${v}.SetDisabled(true)`);
        const changed = this.calls(node);
        if (changed.length) {
          w.line(`${v}.SetChangedFunc(func(text string) {`).indent();
          for (const c of changed) w.line(`${c}()`);
          w.dedent().line('})');
        }
        break;
      }
      case 'Button': {
        w.line(`${v} := tview.NewButton(${esc(inlineText(node))})`);
        if (fg) w.line(`${v}.SetLabelColor(${color(fg)})`);
        if (node.disabled) w.line(`${v}.SetDisabled(true)`);
        bind('SetSelectedFunc', '');
        break;
      }
      case 'Checkbox':
      case 'Radio':
      case 'Toggle': {
        const glyph = node.type === 'Toggle' ? '' : node.glyphs.on;
        w.line(
          `${v} := tview.NewCheckbox().SetLabel(${esc(node.text)} + " ").SetChecked(${node.checked})`
        );
        if (glyph.trim()) w.line(`${v}.SetCheckedString(${goStr(glyph)})`);
        if (fg) w.line(`${v}.SetLabelColor(${color(fg)})`);
        if (node.disabled) w.line(`${v}.SetDisabled(true)`);
        // Radios get their (mutually exclusive) handler from flushRadios.
        if (node.type !== 'Radio') bind('SetChangedFunc', 'checked bool');
        break;
      }
      case 'Select': {
        const opts = node.options.map(esc).join(', ');
        w.line(`${v} := tview.NewDropDown().SetOptions([]string{${opts}}, nil)`);
        const idx = Math.max(0, node.options.indexOf(node.value));
        if (node.options.length) w.line(`${v}.SetCurrentOption(${idx})`);
        if (fg) w.line(`${v}.SetLabelColor(${color(fg)})`);
        if (node.disabled) w.line(`${v}.SetDisabled(true)`);
        bind('SetSelectedFunc', 'text string, index int');
        break;
      }
      case 'Table': {
        w.line(`${v} := tview.NewTable().SetSelectable(true, false)`);
        const cellColor = fg ? `.SetTextColor(${color(fg)})` : '';
        const hasHeader = node.columns.length > 0;
        node.columns.forEach((c, i) => {
          w.line(
            `${v}.SetCell(0, ${i}, tview.NewTableCell(${esc(c)}).SetAttributes(tcell.AttrBold).SetSelectable(false).SetExpansion(1)${cellColor})`
          );
        });
        node.rows.forEach((r, ri) => {
          r.forEach((c, ci) => {
            w.line(
              `${v}.SetCell(${ri + (hasHeader ? 1 : 0)}, ${ci}, tview.NewTableCell(${esc(c)}).SetExpansion(1)${cellColor})`
            );
          });
        });
        if (hasHeader) w.line(`${v}.SetFixed(1, 0)`);
        bind('SetSelectedFunc', 'row, column int');
        break;
      }
      case 'List':
      case 'Menu': {
        w.line(`${v} := tview.NewList().ShowSecondaryText(false)`);
        if (fg) w.line(`${v}.SetMainTextColor(${color(fg)})`);
        const calls = this.calls(node);
        const cb = calls.length === 1 ? calls[0] : 'nil';
        node.items.forEach((item) => {
          const short = [...item.hotkey].length === 1 ? `rune(${item.hotkey.codePointAt(0)})` : '0';
          const text = itemText(item, short === '0');
          w.line(`${v}.AddItem(${esc(text)}, "", ${short}, ${cb})`);
        });
        if (calls.length > 1) {
          w.line(
            `${v}.SetSelectedFunc(func(index int, text string, secondary string, shortcut rune) {`
          ).indent();
          for (const c of calls) w.line(`${c}()`);
          w.dedent().line('})');
        }
        if (node.selected > 0 && node.selected < node.items.length)
          w.line(`${v}.SetCurrentItem(${node.selected})`);
        break;
      }
      case 'Tree':
        this.tree(node, v);
        break;
      case 'Tabs':
        this.tabs(node, v);
        break;
      default:
        w.line(`${v} := tview.NewBox()`);
    }
    this.boxStyle(node, v);
    if (FOCUSABLE.has(node.type) && !node.disabled)
      this.focusScopes[this.focusScopes.length - 1].push(v);
    return v;
  }

  private tree(node: IRNode, v: string): void {
    const w = this.w;
    const root = this.claim(`${v}Root`);
    w.line(`${root} := tview.NewTreeNode("")`);
    const fg = node.style.fg;
    const add = (parent: string, items: IRItem[]) => {
      for (const item of items) {
        const text = esc(itemText(item, false));
        const col = fg ? `.SetColor(${color(fg)})` : '';
        if (!item.children.length) {
          w.line(`${parent}.AddChild(tview.NewTreeNode(${text})${col})`);
          continue;
        }
        const child = this.claim(`${v}Branch`);
        w.line(`${child} := tview.NewTreeNode(${text})${col}`);
        if (!item.expanded) w.line(`${child}.SetExpanded(false)`);
        add(child, item.children);
        w.line(`${parent}.AddChild(${child})`);
      }
    };
    add(root, node.items);
    w.line(`${v} := tview.NewTreeView().SetRoot(${root}).SetTopLevel(1)`);
    if (node.items.length) w.line(`${v}.SetCurrentNode(${root}.GetChildren()[0])`);
    w.line(`${v}.SetSelectedFunc(func(node *tview.TreeNode) {`).indent();
    w.line('node.SetExpanded(!node.IsExpanded())');
    for (const c of this.calls(node)) w.line(`${c}()`);
    w.dedent().line('})');
  }

  private tabs(node: IRNode, v: string): void {
    const w = this.w;
    const labels = this.claim(`${v}Labels`);
    const active = this.claim(`${v}Active`);
    const render = this.claim(`${v}Render`);
    const items = node.items.map((i) => esc(i.label + (i.status ? ' ●' : '')));
    const start = Math.max(0, Math.min(node.selected, Math.max(0, items.length - 1)));
    w.line(`${v} := tview.NewTextView().SetDynamicColors(true)`);
    w.line(`${labels} := []string{${items.join(', ')}}`);
    w.line(`${active} := ${start}`);
    w.line(`${render} := func() {`).indent();
    w.line('text := ""');
    w.line(`for i, label := range ${labels} {`).indent();
    w.line(`if i == ${active} {`).indent();
    w.line('text += "[black:white] " + label + " [-:-]"');
    w.dedent().line('} else {').indent();
    w.line('text += " " + label + " "');
    w.dedent().line('}');
    w.dedent().line('}');
    w.line(`${v}.SetText(text)`);
    w.dedent().line('}');
    w.line(`${render}()`);
    const calls = this.calls(node);
    w.line(`${v}.SetInputCapture(func(event *tcell.EventKey) *tcell.EventKey {`).indent();
    w.line('switch event.Key() {');
    w.line('case tcell.KeyLeft:').indent();
    w.line(`if ${active} > 0 {`).indent();
    w.line(`${active}--`);
    w.line(`${render}()`);
    for (const c of calls) w.line(`${c}()`);
    w.dedent().line('}');
    w.line('return nil');
    w.dedent();
    w.line('case tcell.KeyRight:').indent();
    w.line(`if ${active} < len(${labels})-1 {`).indent();
    w.line(`${active}++`);
    w.line(`${render}()`);
    for (const c of calls) w.line(`${c}()`);
    w.dedent().line('}');
    w.line('return nil');
    w.dedent();
    w.line('}');
    w.line('return event');
    w.dedent().line('})');
  }
}

// ── Files ───────────────────────────────────────────────────────────────────────

function generateTview(screen: IRScreen): ExportFile[] {
  const gen = new TviewGen(screen);
  const body = gen.generate();
  const w = new CodeWriter('\t');

  const kinds = [...gen.borders.entries()].sort((a, b) => b[1] - a[1]);
  const kind: BorderKind | null = kinds.length ? kinds[0][0] : null;

  w.line(`// ${screen.name || screen.ident}: generated by TUI Studio (tview exporter).`);
  w.line('//');
  w.line('// Run:  go mod tidy && go run .');
  w.line('//');
  w.line(
    '// Layout: tview.Flex / tview.Grid mirror the design; wrapped and absolute containers are'
  );
  w.line(
    '// a snapshot of the editor positions (nested Flex rows and spacers); modals are overlay pages.'
  );
  w.line('// Keys: q or Ctrl+C quits, Tab / Shift+Tab moves the focus.');
  w.line('package main');
  w.line();
  w.line('import (');
  w.indent();
  if (gen.usesTime) {
    w.line('"time"');
    w.line();
  }
  w.line('"github.com/gdamore/tcell/v2"');
  w.line('"github.com/rivo/tview"');
  w.dedent().line(')');
  w.line();
  w.line('func main() {');
  w.indent();
  w.line('tview.Styles.PrimitiveBackgroundColor = tcell.ColorDefault');
  w.line('tview.Styles.PrimaryTextColor = tcell.ColorDefault');
  if (kind) {
    const [h, vert, tl, tr, bl, br] = BORDER_RUNES[kind].map((r) => `'${r}'`);
    w.line(`// tview.Borders is global: every box uses the "${kind}" border.`);
    for (const suffix of ['', 'Focus']) {
      w.line(`tview.Borders.Horizontal${suffix} = ${h}`);
      w.line(`tview.Borders.Vertical${suffix} = ${vert}`);
      w.line(`tview.Borders.TopLeft${suffix} = ${tl}`);
      w.line(`tview.Borders.TopRight${suffix} = ${tr}`);
      w.line(`tview.Borders.BottomLeft${suffix} = ${bl}`);
      w.line(`tview.Borders.BottomRight${suffix} = ${br}`);
    }
  }
  w.line();
  w.line('app := tview.NewApplication()');
  w.dedent();
  const head = w.toString();

  const stubs = gen
    .handlerStubs()
    .map(
      (n) =>
        `\n// ${n} is called by the design; fill in what should happen.\nfunc ${n}() {\n\t// TODO\n}\n`
    )
    .join('');

  const main = `${head}${body}}\n${stubs}`;
  const goMod = `module ${screen.ident}\n\ngo 1.23\n\nrequire (\n\tgithub.com/gdamore/tcell/v2 ${TCELL_VERSION}\n\tgithub.com/rivo/tview ${TVIEW_VERSION}\n)\n`;
  return [
    { path: 'main.go', content: main },
    { path: 'go.mod', content: goMod },
  ];
}

export const tviewAdapter: ExportAdapter = {
  id: 'tview',
  label: 'tview (Go)',
  language: 'go',
  verification: 'snapshot',
  multiScreen: false,
  generate: ({ ir }) => generateTview(ir.start),
};
