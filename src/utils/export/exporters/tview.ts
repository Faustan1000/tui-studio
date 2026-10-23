// tview (Go) exporter, generated from the export IR.
//
// Output: `main.go` (your program), `ui.go` (typed program API), `ui_tview.go` (the tview UI),
// `ui_runtime.go` (shared Go runtime) and `go.mod` (tview v0.42.0 on tcell v2).
//
// Program API: components with a code name live in the runtime's store; the tview widgets are
// drawn from it (`syncAll`, run on the UI goroutine after every change) and user input is
// written back and reported as events. Muted/readonly widgets ignore the keyboard and mouse,
// hidden ones are removed from their Flex (or wrapped in a Pages when the container is not a
// Flex). Event handlers run on their own goroutine, never inside tview callbacks.
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
import { GO_RUNTIME_FILENAME, GO_RUNTIME_SOURCE } from '../api/go/runtime';
import { apiName, buildApiModel, type ApiHandleModel } from '../api/model';
import type { ApiValueType } from '../api/spec';
import {
  inlineText,
  itemText,
  progressText,
  recase,
  treeLines,
  visibleChildren,
  walkIR,
} from '../ir';
import type { BorderKind, IRItem, IRNode, IRProject, IRScreen } from '../ir';
import { CodeWriter, goStr } from '../lang';
import { BUBBLETEA_RESERVED_UI } from './bubbletea';

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
  'scrolls',
  'scroller',
  'blocking',
  'others',
  'slot',
  'focusItem',
  'dynLayout',
  'gate',
  'gateable',
  'fillFlex',
  'sameStrings',
  'sameRows',
  'progressBar',
  'hiddenKey',
  'testScreen',
  'tviewUi',
  'newTviewUi',
  'core',
  't',
  'syncing',
  'syncAll',
  'shell',
  'logView',
  'logShown',
  'logCount',
  'errModal',
  'errShown',
  'prevFocus',
  'focusKey',
  'mainFocus',
  'modalTags',
  'modalFocus',
  'currentFocus',
  'usable',
  'focusFirst',
  'cycleFocus',
  'pages',
  'shade',
  'st',
  'visible',
  'entries',
  'unseen',
  'e',
  'o',
  'found',
  'ok',
  'f',
  's',
  'b',
  'opts',
  'val',
  'texts',
  'items',
  'it',
  'sel',
  'cols',
  'rows',
  'col',
  'cell',
  'off',
  'r',
  'k',
  'limit',
  'a',
  'n',
  'list',
  'pos',
  'parent',
  'buttonIndex',
  'buttonLabel',
  'mainText',
  'secondaryText',
  'shortcut',
  'h',
  'program',
  'cloneValue',
  'Event',
  'State',
  'Comp',
  'Core',
  'Handle',
  'Renderer',
  'ErrorEntry',
  'LogApi',
  'Ui',
  'NewUi',
  'NewCore',
  'fmt',
  'atomic',
  'os',
  'errors',
  'start',
  'd',
  'p',
  'c',
  'v',
  'w',
  'x',
  'y',
];

interface Item {
  expr: string;
  fixed: number;
  prop: number;
}

/** Code-named components whose content width is not fixed by the design. */
const GROWING = new Set(['Text', 'Spinner', 'Checkbox', 'Radio', 'Toggle']);

/** Components that fill the width of their container when the design gives them none. */
const FILLS_WIDTH = new Set(['Select', 'List', 'Menu', 'Tabs']);

/** The label of a tab: icon, label, status dot and hotkey, one space apart. */
function tabText(item: IRItem): string {
  return [item.icon, item.label, item.status ? '●' : '', item.hotkey].filter(Boolean).join(' ');
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

interface FocusEntry {
  v: string;
  tag: string;
  anc: string[];
}

interface ModalInfo {
  /** Code name (empty: an overlay that is always shown). */
  tag: string;
  /** The centred overlay primitive. */
  overlay: string;
  /** `[]focusItem` of the modal's controls. */
  focus: string;
  node: IRNode;
}

/** Editor event key -> API event name. */
const EVENT_OF_KEY: Record<string, string> = {
  onClick: 'click',
  onChange: 'change',
  onSubmit: 'submit',
  onSelect: 'select',
};

const focusLiteral = (f: FocusEntry) =>
  `{p: ${f.v}, tag: ${goStr(f.tag)}, anc: []string{${f.anc.map((a) => goStr(a)).join(', ')}}}`;

class TviewGen {
  /** Body of `newTviewUi`. */
  private w = new CodeWriter('\t', 1);
  /** Lines inside `syncAll`. */
  private sw = new CodeWriter('\t', 2);
  private decls: string[] = [];
  private names = new Set<string>(GO_RESERVED);
  private vars = new Map<IRNode, string>();
  private compVars = new Map<IRNode, string>();
  private handlerNames = new Map<string, string>();
  private modalQueue: IRNode[] = [];
  private focusScopes: FocusEntry[][] = [[]];
  private ancTags: string[] = [];
  private radioRun: { node: IRNode; v: string }[] = [];
  usesTime = false;
  private noStyle: IRNode | null = null;
  /** True while the main screen (not a modal) is built: its lists/tables/trees scroll with the wheel. */
  private scrollReg = false;
  borders = new Map<BorderKind, number>();
  /** The border kind most nodes use: it is the global tview.Borders, the others are drawn by decor. */
  readonly dominant: BorderKind | null;

  constructor(private readonly screen: IRScreen) {
    const counts = new Map<BorderKind, number>();
    const visit = (n: IRNode) => {
      if (n.style.border)
        counts.set(n.style.border.kind, (counts.get(n.style.border.kind) ?? 0) + 1);
      visibleChildren(n).forEach(visit);
    };
    visit(screen.root);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    this.dominant = top ? top[0] : null;
  }

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

  /** Has a code name and so a handle in the program API. */
  private isApi(node: IRNode): boolean {
    return !!node.tag && node !== this.screen.root;
  }

  /** `vC := core.Comp("tag")`, declared on first use. */
  private comp(node: IRNode): string {
    let name = this.compVars.get(node);
    if (!name) {
      name = this.claim(`${this.varFor(node)}C`);
      this.compVars.set(node, name);
      this.w.line(`${name} := core.Comp(${goStr(node.tag)})`);
    }
    return name;
  }

  /** A cache variable for the last value applied to a widget (declared before `syncAll`). */
  private cache(v: string, suffix: string, init: string): string {
    const name = this.claim(`${v}${suffix}`);
    this.decls.push(`${name} := ${init}`);
    return name;
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

  /** Stub functions of the editor handlers that belong to an API event (all of them if omitted). */
  private stubs(node: IRNode, event?: string): string[] {
    const out: string[] = [];
    for (const [key, raw] of Object.entries(node.events)) {
      if (!raw.trim()) continue;
      const name = this.handler(raw);
      if (['onFocus', 'onBlur', 'onKeyPress'].includes(key)) continue;
      if (event && EVENT_OF_KEY[key] !== event) continue;
      if (!out.includes(name)) out.push(name);
    }
    return out;
  }

  handlerStubs(): string[] {
    return [...this.handlerNames.values()];
  }

  /**
   * Lines that report a user interaction: store entry + queue + handlers (tagged components) and
   * the editor's stub functions, which always run on the handler goroutine.
   */
  private fire(node: IRNode, event: string, value: string): string[] {
    const stubs = this.stubs(node, event);
    if (this.isApi(node)) {
      const c = this.comp(node);
      if (!stubs.length) return [`${c}.Emit(${goStr(event)}, ${value})`];
      return [
        `if ${c}.Emit(${goStr(event)}, ${value}) {`,
        ...stubs.map((s) => `\tcore.Defer(${s})`),
        '}',
      ];
    }
    return stubs.map((s) => `core.Defer(${s})`);
  }

  private emit(lines: string[]): void {
    for (const l of lines) this.w.line(l);
  }

  /** One binding of `syncAll`, in its own block so the locals cannot collide. */
  private sync(lines: string[]): void {
    this.sw.line('{');
    for (const l of lines) this.sw.line(`\t${l}`);
    this.sw.line('}');
  }

  /** Dim the widget while the component is muted. */
  private dim(node: IRNode, v: string, setters: string[]): void {
    const c = this.comp(node);
    const state = this.cache(v, 'State', 'State("")');
    const orig = node.style.fg ? color(node.style.fg) : 'tview.Styles.PrimaryTextColor';
    this.sync([
      `if st := ${c}.State(); st != ${state} {`,
      `\t${state} = st`,
      `\tshade := ${orig}`,
      '\tif st == StateMuted {',
      '\t\tshade = tcell.ColorGray',
      '\t}',
      ...setters.map((s) => `\t${v}.${s}(shade)`),
      '}',
    ]);
  }

  // ── Entry ───────────────────────────────────────────────────────────────────

  /** The body of `newTviewUi` (after the application is created) up to the end of the function. */
  generate(): string {
    this.w.line('scrolls := []scrollable{}');
    this.scrollReg = true;
    const rootVar = this.place(this.screen.root);
    const modals: ModalInfo[] = [];
    while (this.modalQueue.length) {
      const modal = this.modalQueue.shift()!;
      this.focusScopes.push([]);
      this.ancTags.push(this.isApi(modal) ? modal.tag! : '');
      const m = this.place(modal);
      this.ancTags.pop();
      const focus = this.focusScopes.pop()!;
      const overlay = this.overlay(modal, m);
      const list = this.claim(`${m}Focus`);
      this.w.line(`${list} := []focusItem{${focus.map(focusLiteral).join(', ')}}`);
      modals.push({ tag: this.isApi(modal) ? modal.tag! : '', overlay, focus: list, node: modal });
    }

    const w = this.w;
    w.line(`mainFocus := []focusItem{${this.focusScopes[0].map(focusLiteral).join(', ')}}`);
    // The scroll view finds the focused widget itself (the application is locked while it draws).
    this.block(`scroller.focus = func() tview.Primitive {
	for _, f := range mainFocus {
		if f.p.HasFocus() {
			return f.p
		}
	}
	return nil
}`);
    w.line(`modalTags := []string{${modals.map((m) => goStr(m.tag)).join(', ')}}`);
    w.line(`modalFocus := [][]focusItem{${modals.map((m) => m.focus).join(', ')}}`);

    // Screen + log panel, pages (modals, error dialog)
    w.line('shell := tview.NewFlex().SetDirection(tview.FlexRow)');
    w.line(`shell.AddItem(${rootVar}, 0, 1, false)`);
    w.line('logView := tview.NewTextView()');
    w.line('logView.SetBorder(true)');
    w.line('logView.SetTitle(" Log (Ctrl+L) ")');
    w.line('logShown := false');
    w.line('logCount := -1');
    w.line('pages := tview.NewPages()');
    w.line('pages.AddPage("main", shell, true, true)');
    for (const m of modals) {
      w.line(
        `pages.AddPage(${goStr(m.node.ident)}, ${m.overlay}, true, ${m.tag === '' ? 'true' : 'false'})`
      );
    }
    w.line('errModal := tview.NewModal().AddButtons([]string{"OK"})');
    w.line('errModal.SetBackgroundColor(tcell.ColorDefault)');
    w.line('errModal.SetTextColor(tcell.ColorDefault)');
    w.line('errModal.SetButtonStyle(tcell.StyleDefault)');
    w.line('errModal.SetButtonActivatedStyle(tcell.StyleDefault.Reverse(true))');
    w.line('errModal.SetDoneFunc(func(buttonIndex int, buttonLabel string) {').indent();
    w.line('core.MarkErrorsSeen()');
    w.dedent().line('})');
    w.line('pages.AddPage("errors", errModal, true, false)');
    w.line('errShown := false');
    w.line('var prevFocus tview.Primitive');
    w.line('focusKey := "?"');
    // Clicks go to the topmost dialog only: the error dialog, else an open modal.
    this.block(`blocking := func() bool {
	if errShown {
		return true
	}
	for _, tag := range modalTags {
		if tag == "" || core.Open(tag) {
			return true
		}
	}
	return false
}
shell.SetMouseCapture(func(action tview.MouseAction, event *tcell.EventMouse) (tview.MouseAction, *tcell.EventMouse) {
	if blocking() {
		return tview.MouseConsumed, nil
	}
	return action, event
})`);
    for (const m of modals) {
      this
        .block(`${m.overlay}.SetMouseCapture(func(action tview.MouseAction, event *tcell.EventMouse) (tview.MouseAction, *tcell.EventMouse) {
	if errShown {
		return tview.MouseConsumed, nil
	}
	return action, event
})`);
    }

    this.block(CONTROL_GO);

    // Modals follow their open flag
    for (const m of modals) {
      if (!m.tag) continue;
      const open = this.cache(m.overlay, 'Open', 'false');
      this.sync([
        `if o := core.Open(${goStr(m.tag)}); o != ${open} {`,
        `\t${open} = o`,
        '\tif o {',
        `\t\tpages.ShowPage(${goStr(m.node.ident)})`,
        '\t} else {',
        `\t\tpages.HidePage(${goStr(m.node.ident)})`,
        '\t}',
        '}',
      ]);
    }

    // Error dialog, log panel, focus
    this.sync([
      'if unseen := core.UnseenErrors(); len(unseen) > 0 {',
      '\ttext := "Error"',
      '\tfor _, e := range unseen {',
      '\t\ttext += "\\n\\n" + e.Message',
      '\t}',
      '\terrModal.SetText(tview.Escape(text))',
      '\tif !errShown {',
      '\t\terrShown = true',
      '\t\tprevFocus = app.GetFocus()',
      '\t\tpages.ShowPage("errors")',
      '\t\tapp.SetFocus(errModal)',
      '\t}',
      '} else if errShown {',
      '\terrShown = false',
      '\tpages.HidePage("errors")',
      '\tif prevFocus != nil {',
      '\t\tapp.SetFocus(prevFocus)',
      '\t}',
      '}',
    ]);
    this.sync([
      'if visible := core.LogVisible(); visible != logShown {',
      '\tlogShown = visible',
      '\tshell.Clear()',
      `\tshell.AddItem(${rootVar}, 0, 1, false)`,
      '\tif visible {',
      '\t\tshell.AddItem(logView, 8, 0, false)',
      '\t\tlogCount = -1',
      '\t}',
      '}',
      'if entries := core.LogEntries(); logShown && len(entries) != logCount {',
      '\tlogCount = len(entries)',
      '\ttext := ""',
      '\tfor _, e := range entries {',
      '\t\ttext += e.String() + "\\n"',
      '\t}',
      '\tlogView.SetText(text)',
      '\tlogView.ScrollToEnd()',
      '}',
    ]);
    this.sync([
      'key := ""',
      'for _, tag := range modalTags {',
      '\tif tag != "" && core.Open(tag) {',
      '\t\tkey += tag + ","',
      '\t}',
      '}',
      'found, ok := false, false',
      'for _, f := range currentFocus() {',
      '\tif f.p.HasFocus() {',
      '\t\tfound, ok = true, usable(f)',
      '\t}',
      '}',
      'if key != focusKey || (found && !ok) {',
      '\tfocusKey = key',
      '\tif !errShown {',
      '\t\tfocusFirst()',
      '\t}',
      '}',
    ]);

    // Caches, then syncAll
    for (const d of this.decls) w.line(d);
    const tail = [
      '\tsyncAll := func() {',
      '\t\tif syncing {',
      '\t\t\treturn',
      '\t\t}',
      '\t\tsyncing = true',
      '\t\tt.relayout()',
      this.sw.toString().replace(/\n$/, ''),
      '\t\tsyncing = false',
      '\t}',
      '\tt.sync = syncAll',
      '\tcore.Attach(t)',
      '\treturn t',
      '}',
    ].join('\n');
    return w.toString() + tail + '\n';
  }

  private block(text: string): void {
    for (const l of text.split('\n')) this.w.line(l);
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

  /**
   * Children as primitives, in order (radio runs become mutually exclusive groups). Containers
   * that are not a plain Flex wrap their code-named children in a Pages so they can be hidden.
   */
  private placeKids(kids: IRNode[], wrapHideable = false): string[] {
    const out: string[] = [];
    kids.forEach((kid, i) => {
      const placed = this.place(kid);
      const raw = this.decorate(kid, placed);
      let expr = raw;
      if (wrapHideable && this.isApi(kid)) {
        const host = this.claim(`${raw}Host`);
        const hidden = this.cache(host, 'Hidden', 'false');
        this.w.line(`${host} := tview.NewPages().AddPage("c", ${raw}, true, true)`);
        this.sync([
          `if h := core.Hidden(${goStr(kid.tag)}); h != ${hidden} {`,
          `\t${hidden} = h`,
          '\tif h {',
          `\t\t${host}.HidePage("c")`,
          '\t} else {',
          `\t\t${host}.ShowPage("c")`,
          '\t}',
          '}',
        ]);
        expr = host;
      }
      out.push(expr);
      if (kid.type !== 'Radio') return;
      this.radioRun.push({ node: kid, v: placed });
      if (kids[i + 1]?.type !== 'Radio') this.flushRadios();
    });
    return out;
  }

  /**
   * Wraps a widget whose border is not the dominant kind (tview.Borders is global) and adds what
   * tview cannot draw itself (the arrow of a drop-down).
   */
  private decorate(node: IRNode, v: string): string {
    const b = node.style.border;
    const runes =
      b && this.dominant && b.kind !== this.dominant
        ? `[]rune{${BORDER_RUNES[b.kind].map((r) => `'${r}'`).join(', ')}}`
        : '';
    const arrow = node.type === 'Select' && !!b;
    if (!runes && !arrow) return v;
    const d = this.claim(`${v}Decor`);
    this.w.line(`${d} := &decor{Primitive: ${v}${runes ? `, runes: ${runes}` : ''}}`);
    if (arrow) {
      this.w.line(`${d}.after = func(screen tcell.Screen) {`).indent();
      this.w.line(`x, y, width, _ := ${v}.GetInnerRect()`);
      this.w.line('if width > 0 {').indent();
      this.w.line(`screen.SetContent(x+width-1, y, '▼', nil, ${this.styleOf(node)})`);
      this.w.dedent().line('}');
      // The open list is a bordered box under the field, like in the other exports.
      this.w.line(`dropdownPopup(screen, ${v}, ${this.styleOf(node)}, ${this.styleOf(node, '.Reverse(true)')})`);
      this.w.dedent().line('}');
      this.w.line(`shiftPopupMouse(${v})`);
    }
    return d;
  }

  private flushRadios(): void {
    const run = this.radioRun;
    this.radioRun = [];
    if (!run.length) return;
    const w = this.w;
    const group = this.claim(`${run[0].v}Group`);
    w.line(`${group} := []*tview.Checkbox{${run.map((r) => r.v).join(', ')}}`);
    for (const r of run) {
      const api = this.isApi(r.node);
      w.line(`${r.v}.SetChangedFunc(func(checked bool) {`).indent();
      w.line('if syncing {').indent();
      w.line('return');
      w.dedent().line('}');
      // A radio stays selected when it is clicked again: only choosing another one clears it.
      w.line('if !checked {').indent();
      w.line('others := false');
      w.line(`for _, other := range ${group} {`).indent();
      w.line(`if other != ${r.v} && other.IsChecked() {`).indent();
      w.line('others = true');
      w.dedent().line('}');
      w.dedent().line('}');
      w.line('if !others {').indent();
      w.line('syncing = true');
      w.line(`${r.v}.SetChecked(true)`);
      w.line('syncing = false');
      w.line('return');
      w.dedent().line('}');
      w.dedent().line('}');
      w.line('if checked {').indent();
      w.line(`for _, other := range ${group} {`).indent();
      w.line(`if other != ${r.v} {`).indent();
      w.line('other.SetChecked(false)');
      w.dedent().line('}');
      w.dedent().line('}');
      w.dedent().line('}');
      if (api) w.line(`${this.comp(r.node)}.UserSet("checked", checked)`);
      this.emit(this.fire(r.node, 'change', 'checked'));
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
    if (this.isApi(node)) this.ancTags.push(node.tag!);
    const l = node.layout;
    // The screen's border and padding go on an outer Flex around a clipped content view, so a
    // design that is larger than the terminal cannot paint over the border.
    const isRoot = node === this.screen.root;
    if (isRoot) this.noStyle = node;
    let out: string;
    if (l.mode === 'grid') out = this.gridContainer(node, kids);
    else if (l.mode === 'flex' && !l.wrap) out = this.flexContainer(node, kids);
    else out = this.snapshotContainer(node, kids);
    if (this.isApi(node)) this.ancTags.pop();
    if (isRoot) {
      this.noStyle = null;
      const frame = this.claim(`${out}Frame`);
      this.w.line(`${frame} := tview.NewFlex().SetDirection(tview.FlexRow)`);
      this.boxStyle(node, frame);
      const l = node.layout;
      const extraH = l.padding.top + l.padding.bottom + (node.style.border ? 2 : 0);
      const contentH = Math.max(1, this.boxSize(node).h - extraH);
      this.scrollReg = false;
      this.w.line(`scroller := newScrollView(${out}, ${contentH})`);
      this.w.line('scroller.scrollables = scrolls');
      this.w.line('t.scroller = scroller');
      this.w.line(`${frame}.AddItem(scroller, 0, 1, false)`);
      out = frame;
    }
    if (node.type === 'Modal' && this.isApi(node)) {
      const c = this.comp(node);
      const title = this.cache(out, 'Title', goStr(node.text));
      this.sync([
        `if s := ${c}.Str("title"); s != ${title} {`,
        `	${title} = s`,
        `	${out}.SetTitle(tview.Escape(s))`,
        '}',
      ]);
    }
    return out;
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
    if (!kids.some((k) => this.isApi(k))) {
      this.addItems(v, this.justify(items, node));
      return v;
    }
    // Code-named children can be hidden: the items are rebuilt without them.
    const slots = this.claim(`${v}Slots`);
    const fill = this.claim(`${v}Fill`);
    this.w.line(`${slots} := []slot{`).indent();
    kids.forEach((k, i) => {
      const it = items[i];
      this.w.line(
        `{p: ${it.expr}, tag: ${goStr(this.isApi(k) ? k.tag : '')}, fixed: ${it.fixed}, prop: ${it.prop}},`
      );
    });
    this.w.dedent().line('}');
    this.w.line(
      `${fill} := func() { fillFlex(core, ${v}, ${slots}, ${node.layout.gap}, ${goStr(node.layout.justify)}) }`
    );
    this.w.line(`${fill}()`);
    const tags = kids.filter((k) => this.isApi(k)).map((k) => goStr(k.tag));
    this.w.line(
      `t.dyn = append(t.dyn, dynLayout{tags: []string{${tags.join(', ')}}, fill: ${fill}})`
    );
    return v;
  }

  private snapshotContainer(node: IRNode, kids: IRNode[]): string {
    const v = this.varFor(node);
    this.w.line(`${v} := tview.NewFlex().SetDirection(tview.FlexRow)`);
    this.boxStyle(node, v);
    const exprs = this.placeKids(kids, true);
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
    const exprs = this.placeKids(kids, true);

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
    // The editor's height of the tabs is not their content's (the underline row): their own size decides.
    const ownHeight = node.type === 'Tabs';
    const h =
      typeof node.height === 'number'
        ? node.height
        : Math.max(guess.h + (this.isBox(node) ? 0 : own), ownHeight ? 0 : (node.rel?.height ?? 0), 1);
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
        // a bordered button is at least 16 cells wide (the Textual reference)
        return {
          w: node.style.border
            ? Math.max(16 - 2, cellWidth(inlineText(node)) + 4)
            : cellWidth(inlineText(node)) + 4,
          h: 1,
        };
      case 'Checkbox':
        return { w: cellWidth(node.text) + 4, h: 1 };
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
        // every cell has one cell of padding on each side
        for (let c = 0; c < cols; c++)
          w +=
            Math.max(
              cellWidth(node.columns[c] ?? ''),
              ...node.rows.map((r) => cellWidth(r[c] ?? ''))
            ) + 2;
        return { w, h: node.rows.length + (node.columns.length ? 1 : 0) };
      }
      case 'List':
        return { w: widest(node.items.map((i) => i.label)) + 2, h: node.items.length };
      case 'Menu':
        return { w: widest(node.items.map((i) => itemText(i))) + 2, h: node.items.length };
      case 'Tree': {
        const ls = treeLines(node.items);
        return { w: widest(ls.map((l) => l.text)) + 2, h: ls.length };
      }
      case 'Tabs':
        // the labels and an underline row
        return { w: node.items.reduce((a, i) => a + cellWidth(tabText(i)) + 2, 0), h: 2 };
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
    // These take the width of their container unless they have one (Textual: 1fr).
    if (dir === 'column' && FILLS_WIDTH.has(k.type)) return 'fill';
    // Text of a code-named component can change at runtime: it must not be clipped to its design width.
    if (this.isApi(k) && dir === 'column' && GROWING.has(k.type)) return 'fill';
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
    if (this.noStyle === node) return;
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

  /** Lets the root scroll view hand mouse wheel events to a widget that can still scroll. */
  private registerScroll(v: string, type: string): void {
    if (!this.scrollReg) return;
    let can: string;
    if (type === 'Table') {
      can = `func(dir int) bool {
	_, _, _, h := ${v}.GetInnerRect()
	rows := ${v}.GetRowCount()
	if rows <= h {
		return false
	}
	offset, _ := ${v}.GetOffset()
	if dir > 0 {
		return offset+h < rows
	}
	return offset > 0
}`;
    } else if (type === 'Tree') {
      can = `func(dir int) bool {
	_, _, _, h := ${v}.GetInnerRect()
	return ${v}.GetRowCount() > h
}`;
    } else {
      can = `func(dir int) bool {
	_, _, _, h := ${v}.GetInnerRect()
	if ${v}.GetItemCount() <= h {
		return false
	}
	if dir > 0 {
		return ${v}.GetCurrentItem() < ${v}.GetItemCount()-1
	}
	return ${v}.GetCurrentItem() > 0
}`;
    }
    this.w.line(`scrolls = append(scrolls, scrollable{p: ${v}, can: ${can}})`);
  }

  /** tcell style with the design's colours (terminal defaults where it has none). */
  private styleOf(node: IRNode, extra = ''): string {
    const fg = node.style.fg ? color(node.style.fg) : 'tcell.ColorDefault';
    const bg = node.style.bg ? color(node.style.bg) : 'tcell.ColorDefault';
    return `tcell.StyleDefault.Foreground(${fg}).Background(${bg})${extra}`;
  }

  // ── Leaves ──────────────────────────────────────────────────────────────────

  /** `v.setter(func(params) { [guard] body })`; nothing if there is no body. */
  private callback(
    v: string,
    setter: string,
    params: string,
    body: string[],
    guard: boolean
  ): void {
    if (!body.length) return;
    const w = this.w;
    w.line(`${v}.${setter}(func(${params}) {`).indent();
    if (guard) {
      w.line('if syncing {').indent();
      w.line('return');
      w.dedent().line('}');
    }
    for (const l of body) w.line(l);
    w.dedent().line('})');
  }

  private leaf(node: IRNode): string {
    const v = this.varFor(node);
    const w = this.w;
    const fg = node.style.fg;
    const api = this.isApi(node);
    this.stubs(node);
    const c = api && node.type !== 'Spacer' && node.type !== 'Breadcrumb' ? this.comp(node) : '';
    const gate = () => {
      if (api) w.line(`gate(${c}, ${v})`);
    };
    const allStubs = () => this.stubs(node).map((s) => `core.Defer(${s})`);

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
        if (api) {
          const last = this.cache(v, 'Text', goStr(node.text));
          this.sync([
            `if s := ${c}.Str("text"); s != ${last} {`,
            `\t${last} = s`,
            `\t${v}.SetText(${this.styled(node, 'tview.Escape(s)')})`,
            '}',
          ]);
        }
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
        const total = Math.max(1, this.size(node).w - (node.style.border ? 2 : 0) - 5);
        const pct = Math.round(
          Math.max(0, Math.min(1, node.progress.value / node.progress.max)) * 100
        );
        w.line(
          `${v} := tview.NewTextView().SetText(${goStr(`${progressText(node, total)}${`${pct}%`.padStart(5)}`)})`
        );
        if (fg) w.line(`${v}.SetTextColor(${color(fg)})`);
        if (api) {
          const val = this.cache(v, 'Value', `float64(${node.progress.value})`);
          const max = this.cache(v, 'Max', `float64(${node.progress.max})`);
          this.sync([
            `if val, limit := ${c}.Float("value"), ${c}.Float("max"); val != ${val} || limit != ${max} {`,
            `	${val} = val`,
            `	${max} = limit`,
            `	${v}.SetText(progressBar(val, limit, ${total}))`,
            '}',
          ]);
          this.dim(node, v, ['SetTextColor']);
        }
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
        const labelExpr = api ? `${c}.Str("label")` : goStr(label);
        this.block(`t.starters = append(t.starters, func() {
	go func() {
		frames := []string{${frames}}
		for i := 0; !core.Closed(); i++ {
			time.Sleep(100 * time.Millisecond)
			frame := frames[i%len(frames)]
			label := ${labelExpr}
			app.QueueUpdateDraw(func() {
				${v}.SetText(${this.styled(node, 'tview.Escape(frame + " " + label)')})
			})
		}
	}()
})`);
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
        w.line(`${v}.SetFieldStyle(${this.styleOf(node)})`);
        w.line(`${v}.SetPlaceholderTextColor(tcell.ColorGray)`);
        if (node.style.border) w.line(`${v}.SetBorderPadding(0, 0, 2, 2)`);
        if (node.disabled && !api) w.line(`${v}.SetDisabled(true)`);
        gate();
        this.callback(
          v,
          'SetChangedFunc',
          'text string',
          [...(api ? [`${c}.UserSet("value", text)`] : []), ...this.fire(node, 'change', 'text')],
          api
        );
        const submit = this.fire(node, 'submit', `${v}.GetText()`);
        if (submit.length) {
          this.callback(
            v,
            'SetDoneFunc',
            'key tcell.Key',
            ['if key == tcell.KeyEnter {', ...submit.map((l) => `\t${l}`), '}'],
            false
          );
        }
        if (api) {
          const ph = this.cache(v, 'Placeholder', goStr(node.placeholder));
          this.sync([
            `if s := ${c}.Str("value"); s != ${v}.GetText() {`,
            `\t${v}.SetText(s)`,
            '}',
            `if s := ${c}.Str("placeholder"); s != ${ph} {`,
            `\t${ph} = s`,
            `\t${v}.SetPlaceholder(s)`,
            '}',
          ]);
          this.dim(node, v, ['SetFieldTextColor']);
        }
        break;
      }
      case 'Button': {
        w.line(`${v} := tview.NewButton(${esc(inlineText(node))})`);
        w.line(`${v}.SetStyle(${this.styleOf(node)})`);
        w.line(`${v}.SetActivatedStyle(${this.styleOf(node, '.Reverse(true)')})`);
        if (node.disabled && !api) w.line(`${v}.SetDisabled(true)`);
        gate();
        this.callback(v, 'SetSelectedFunc', '', this.fire(node, 'click', 'nil'), false);
        if (api) {
          const label = this.cache(v, 'Label', goStr(node.text));
          this.sync([
            `if s := ${c}.Str("label"); s != ${label} {`,
            `\t${label} = s`,
            `\t${v}.SetLabel(tview.Escape(s))`,
            '}',
          ]);
          this.dim(node, v, ['SetLabelColor']);
        }
        break;
      }
      case 'Checkbox':
      case 'Radio':
      case 'Toggle': {
        const glyph = node.type === 'Toggle' ? '' : node.glyphs.on;
        if (node.type === 'Checkbox') {
          // "[✓] label" / "[ ] label": the label follows the box, so both strings carry it.
          w.line(`${v} := tview.NewCheckbox().SetChecked(${node.checked})`);
          w.line(`${v}.SetCheckedString(${goStr(`[${glyph || 'x'}] `)} + ${esc(node.text)})`);
          w.line(
            `${v}.SetUncheckedString(${goStr(`[${node.glyphs.off || ' '}] `)} + ${esc(node.text)})`
          );
        } else {
          w.line(
            `${v} := tview.NewCheckbox().SetLabel(${esc(node.text)} + " ").SetChecked(${node.checked})`
          );
          if (glyph.trim()) w.line(`${v}.SetCheckedString(${goStr(glyph)})`);
        }
        if (fg) w.line(`${v}.SetLabelColor(${color(fg)})`);
        if (fg && node.type === 'Checkbox') w.line(`${v}.SetFieldTextColor(${color(fg)})`);
        w.line(`${v}.SetActivatedStyle(${this.styleOf(node, '.Reverse(true)')})`);
        if (node.disabled && !api) w.line(`${v}.SetDisabled(true)`);
        gate();
        // Radios get their (mutually exclusive) handler from flushRadios.
        if (node.type !== 'Radio') {
          this.callback(
            v,
            'SetChangedFunc',
            'checked bool',
            [
              ...(api ? [`${c}.UserSet("checked", checked)`] : []),
              ...this.fire(node, 'change', 'checked'),
            ],
            api
          );
        }
        if (api) {
          const label = this.cache(v, 'Label', goStr(node.text));
          this.sync([
            `if b := ${c}.Bool("checked"); b != ${v}.IsChecked() {`,
            `\t${v}.SetChecked(b)`,
            '}',
            `if s := ${c}.Str("label"); s != ${label} {`,
            `\t${label} = s`,
            ...(node.type === 'Checkbox'
              ? [
                  `\t${v}.SetCheckedString(${goStr(`[${glyph || 'x'}] `)} + tview.Escape(s))`,
                  `\t${v}.SetUncheckedString(${goStr(`[${node.glyphs.off || ' '}] `)} + tview.Escape(s))`,
                ]
              : [`\t${v}.SetLabel(tview.Escape(s) + " ")`]),
            '}',
          ]);
          this.dim(node, v, ['SetLabelColor', 'SetFieldTextColor']);
        }
        break;
      }
      case 'Select': {
        const opts = node.options.map(esc).join(', ');
        const pickBody = api
          ? [
              'val := text',
              `if opts := ${c}.List("options"); index >= 0 && index < len(opts) {`,
              '\tval = opts[index]',
              '}',
              `${c}.UserSet("value", val)`,
              ...this.fire(node, 'change', 'val'),
            ]
          : this.fire(node, 'change', 'text');
        let pick = 'nil';
        if (pickBody.length) {
          pick = this.claim(`${v}Pick`);
          w.line(`${pick} := func(text string, index int) {`).indent();
          w.line('if syncing {').indent();
          w.line('return');
          w.dedent().line('}');
          for (const l of pickBody) w.line(l);
          w.dedent().line('}');
        }
        w.line(`${v} := tview.NewDropDown()`);
        w.line(`setDropDownOptions(${v}, []string{${opts}}, ${pick})`);
        w.line(`${v}.SetFieldStyle(${this.styleOf(node)})`);
        w.line(`${v}.SetFocusedStyle(${this.styleOf(node, '.Reverse(true)')})`);
        w.line(
          `${v}.SetListStyles(${this.styleOf(node)}, ${this.styleOf(node, '.Reverse(true)')})`
        );
        if (node.options.length) {
          const idx = Math.max(0, node.options.indexOf(node.value));
          w.line('syncing = true');
          w.line(`${v}.SetCurrentOption(${idx})`);
          w.line('syncing = false');
        }
        if (fg) w.line(`${v}.SetLabelColor(${color(fg)})`);
        // the text is indented by two cells; the arrow is drawn by decor at the right edge
        if (node.style.border) w.line(`${v}.SetBorderPadding(0, 0, 2, 2)`);
        if (node.disabled && !api) w.line(`${v}.SetDisabled(true)`);
        gate();
        if (api) {
          const options = this.cache(
            v,
            'Options',
            `[]string{${node.options.map(goStr).join(', ')}}`
          );
          const last = this.cache(v, 'Value', goStr(node.value));
          this.sync([
            `opts, val := ${c}.List("options"), ${c}.Str("value")`,
            `if !sameStrings(opts, ${options}) {`,
            `\t${options} = opts`,
            '\ttexts := make([]string, len(opts))',
            '\tfor i, o := range opts {',
            '\t\ttexts[i] = tview.Escape(o)',
            '\t}',
            `\tsetDropDownOptions(${v}, texts, ${pick})`,
            `\t${last} = "\\x00"`,
            '}',
            `if val != ${last} {`,
            `\t${last} = val`,
            '\tfor i, o := range opts {',
            '\t\tif o == val {',
            `\t\t\t${v}.SetCurrentOption(i)`,
            '\t\t}',
            '\t}',
            '}',
          ]);
          this.dim(node, v, ['SetLabelColor', 'SetFieldTextColor']);
        }
        break;
      }
      case 'Table': {
        w.line(`${v} := tview.NewTable().SetSelectable(true, false)`);
        w.line(`${v}.SetSelectedStyle(tcell.StyleDefault.Reverse(true))`);
        const cellColor = fg ? `.SetTextColor(${color(fg)})` : '';
        const hasHeader = node.columns.length > 0;
        node.columns.forEach((cn, i) => {
          w.line(
            `${v}.SetCell(0, ${i}, tview.NewTableCell(" " + ${esc(cn)}).SetAttributes(tcell.AttrBold).SetSelectable(false)${cellColor})`
          );
        });
        node.rows.forEach((r, ri) => {
          r.forEach((cell, ci) => {
            w.line(
              `${v}.SetCell(${ri + (hasHeader ? 1 : 0)}, ${ci}, tview.NewTableCell(" " + ${esc(cell)})${cellColor})`
            );
          });
        });
        if (hasHeader) w.line(`${v}.SetFixed(1, 0)`);
        gate();
        this.callback(v, 'SetSelectedFunc', 'row, column int', allStubs(), false);
        if (api) {
          const cols = this.cache(v, 'Columns', `[]string{${node.columns.map(goStr).join(', ')}}`);
          const rows = this.cache(
            v,
            'Rows',
            `[][]string{${node.rows.map((r) => `{${r.map(goStr).join(', ')}}`).join(', ')}}`
          );
          const state = this.cache(v, 'State', 'State("")');
          const orig = fg ? color(fg) : 'tview.Styles.PrimaryTextColor';
          this.sync([
            `cols, rows, st := ${c}.List("columns"), ${c}.Rows("rows"), ${c}.State()`,
            `if !sameStrings(cols, ${cols}) || !sameRows(rows, ${rows}) || st != ${state} {`,
            `\t${cols}, ${rows}, ${state} = cols, rows, st`,
            `\tshade := ${orig}`,
            '\tif st == StateMuted {',
            '\t\tshade = tcell.ColorGray',
            '\t}',
            `\t${v}.Clear()`,
            '\toff := 0',
            '\tif len(cols) > 0 {',
            '\t\toff = 1',
            '\t}',
            '\tfor i, col := range cols {',
            `\t\t${v}.SetCell(0, i, tview.NewTableCell(" " + tview.Escape(col)).SetAttributes(tcell.AttrBold).SetSelectable(false).SetTextColor(shade))`,
            '\t}',
            '\tfor r, row := range rows {',
            '\t\tfor k, cell := range row {',
            `\t\t\t${v}.SetCell(r+off, k, tview.NewTableCell(" " + tview.Escape(cell)).SetTextColor(shade))`,
            '\t\t}',
            '\t}',
            `\t${v}.SetFixed(off, 0)`,
            '}',
          ]);
        }
        break;
      }
      case 'List':
      case 'Menu': {
        w.line(`${v} := tview.NewList().ShowSecondaryText(false)`);
        w.line(`${v}.SetSelectedStyle(tcell.StyleDefault.Reverse(true))`);
        if (fg) w.line(`${v}.SetMainTextColor(${color(fg)})`);
        const stubs = this.stubs(node, 'select');
        const cb = !api && stubs.length === 1 ? stubs[0] : 'nil';
        node.items.forEach((item) => {
          const short = [...item.hotkey].length === 1 ? `rune(${item.hotkey.codePointAt(0)})` : '0';
          const text = node.type === 'List' ? item.label : itemText(item, short === '0');
          w.line(`${v}.AddItem(${esc(text)}, "", ${node.type === 'List' ? '0' : short}, ${cb})`);
        });
        if (!api && stubs.length > 1) {
          this.callback(
            v,
            'SetSelectedFunc',
            'index int, mainText string, secondaryText string, shortcut rune',
            stubs.map((s) => `core.Defer(${s})`),
            false
          );
        }
        if (node.selected > 0 && node.selected < node.items.length)
          w.line(`${v}.SetCurrentItem(${node.selected})`);
        gate();
        if (api) {
          this.callback(
            v,
            'SetSelectedFunc',
            'index int, mainText string, secondaryText string, shortcut rune',
            [
              `${c}.UserSet("selected", index)`,
              ...(node.type === 'List'
                ? [
                    'label := mainText',
                    `if items := ${c}.List("items"); index >= 0 && index < len(items) {`,
                    '\tlabel = items[index]',
                    '}',
                    ...this.fire(node, 'select', 'label'),
                  ]
                : this.fire(node, 'select', 'mainText')),
            ],
            false
          );
          this.callback(
            v,
            'SetChangedFunc',
            'index int, mainText string, secondaryText string, shortcut rune',
            [`${c}.UserSet("selected", index)`],
            true
          );
          const sel = this.cache(v, 'Selected', String(node.selected));
          const lines = [
            `if sel := ${c}.Int("selected"); sel != ${sel} && sel >= 0 && sel < ${v}.GetItemCount() {`,
            `\t${sel} = sel`,
            `\t${v}.SetCurrentItem(sel)`,
            '}',
          ];
          if (node.type === 'List') {
            const items = this.cache(
              v,
              'Items',
              `[]string{${node.items.map((i) => goStr(i.label)).join(', ')}}`
            );
            this.sync([
              `if items := ${c}.List("items"); !sameStrings(items, ${items}) {`,
              `\t${items} = items`,
              `\t${v}.Clear()`,
              '\tfor _, it := range items {',
              `\t\t${v}.AddItem(tview.Escape(it), "", 0, nil)`,
              '\t}',
              `\t${sel} = -1`,
              '}',
            ]);
          }
          this.sync(lines);
          this.dim(node, v, ['SetMainTextColor']);
        }
        break;
      }
      case 'Tree':
        this.tree(node, v, api ? c : '');
        break;
      case 'Tabs':
        this.tabs(node, v, api ? c : '');
        break;
      default:
        w.line(`${v} := tview.NewBox()`);
    }
    this.boxStyle(node, v);
    if (['Table', 'List', 'Menu', 'Tree'].includes(node.type)) this.registerScroll(v, node.type);
    if (FOCUSABLE.has(node.type) && !(node.disabled && !api)) {
      this.focusScopes[this.focusScopes.length - 1].push({
        v,
        tag: api ? node.tag! : '',
        anc: [...this.ancTags].filter((a) => a),
      });
    }
    return v;
  }

  private tree(node: IRNode, v: string, c: string): void {
    const w = this.w;
    const root = this.claim(`${v}Root`);
    w.line(`${root} := tview.NewTreeNode("")`);
    const fg = node.style.fg;
    const add = (parent: string, items: IRItem[]) => {
      for (const item of items) {
        const text = esc(itemText(item, false));
        const col =
          (fg ? `.SetColor(${color(fg)})` : '') +
          '.SetSelectedTextStyle(tcell.StyleDefault.Reverse(true))';
        const ref = `.SetReference(${goStr(item.label)})`;
        if (!item.children.length) {
          w.line(`${parent}.AddChild(tview.NewTreeNode(${text})${ref}${col})`);
          continue;
        }
        const child = this.claim(`${v}Branch`);
        w.line(`${child} := tview.NewTreeNode(${text})${ref}${col}`);
        if (!item.expanded) w.line(`${child}.SetExpanded(false)`);
        add(child, item.children);
        w.line(`${parent}.AddChild(${child})`);
      }
    };
    add(root, node.items);
    w.line(`${v} := tview.NewTreeView().SetRoot(${root}).SetTopLevel(1)`);
    if (node.items.length) w.line(`${v}.SetCurrentNode(${root}.GetChildren()[0])`);
    if (c) w.line(`gate(${c}, ${v})`);
    w.line(`${v}.SetSelectedFunc(func(node *tview.TreeNode) {`).indent();
    w.line('node.SetExpanded(!node.IsExpanded())');
    const fire = this.fire(node, 'select', 'label');
    if (fire.length) {
      w.line('label := ""');
      w.line('if s, ok := node.GetReference().(string); ok {').indent();
      w.line('label = s');
      w.dedent().line('}');
      for (const l of fire) w.line(l);
    }
    w.dedent().line('})');
    if (c) {
      const state = this.cache(v, 'State', 'State("")');
      const orig = node.style.fg ? color(node.style.fg) : 'tview.Styles.PrimaryTextColor';
      this.sync([
        `if st := ${c}.State(); st != ${state} {`,
        `\t${state} = st`,
        `\tshade := ${orig}`,
        '\tif st == StateMuted {',
        '\t\tshade = tcell.ColorGray',
        '\t}',
        `\t${root}.Walk(func(node, parent *tview.TreeNode) bool {`,
        '\t\tnode.SetColor(shade)',
        '\t\treturn true',
        '\t})',
        '}',
      ]);
    }
  }

  private tabs(node: IRNode, v: string, c: string): void {
    const w = this.w;
    const items = node.items.map((i) => goStr(tabText(i)));
    const start = Math.max(0, Math.min(node.selected, Math.max(0, items.length - 1)));
    const fg = node.style.fg ? color(node.style.fg) : 'tcell.ColorDefault';
    w.line(`${v} := newTabBar([]string{${items.join(', ')}}, ${start}, ${fg})`);
    const change = [
      ...(c ? [`${c}.UserSet("active_tab", index)`] : []),
      ...this.fire(node, 'change', 'index'),
    ];
    if (c) w.line(`gate(${c}, ${v})`);
    if (change.length) {
      w.line(`${v}.onChange = func(index int) {`).indent();
      for (const l of change) w.line(l);
      w.dedent().line('}');
    }
    if (c) {
      const state = this.cache(v, 'State', 'State("")');
      const orig = node.style.fg ? color(node.style.fg) : 'tview.Styles.PrimaryTextColor';
      this.sync([
        `if a := ${c}.Int("active_tab"); a != ${v}.active && a >= 0 && a < len(${v}.labels) {`,
        `	${v}.active = a`,
        '}',
        `if st := ${c}.State(); st != ${state} {`,
        `	${state} = st`,
        `	shade := ${orig}`,
        '	if st == StateMuted {',
        '		shade = tcell.ColorGray',
        '	}',
        `	${v}.color = shade`,
        '}',
      ]);
    }
  }
}

// ── Static Go ───────────────────────────────────────────────────────────────────

/** Focus cycling, key handling: part of the body of `newTviewUi`. */
const CONTROL_GO = `currentFocus := func() []focusItem {
	for i := len(modalTags) - 1; i >= 0; i-- {
		if modalTags[i] == "" || core.Open(modalTags[i]) {
			return modalFocus[i]
		}
	}
	return mainFocus
}
usable := func(f focusItem) bool {
	if f.tag == "" {
		return core.Shown(f.anc...)
	}
	return core.Usable(f.tag, f.anc...)
}
focusFirst := func() {
	for _, f := range currentFocus() {
		if usable(f) {
			app.SetFocus(f.p)
			return
		}
	}
}
cycleFocus := func(step int) {
	list := currentFocus()
	if len(list) == 0 {
		return
	}
	pos := -1
	if step < 0 {
		pos = len(list)
	}
	for i, f := range list {
		if f.p.HasFocus() {
			pos = i
		}
	}
	for n := 0; n < len(list); n++ {
		pos = (pos + step + len(list)) % len(list)
		if usable(list[pos]) {
			app.SetFocus(list[pos].p)
			return
		}
	}
}
app.SetInputCapture(func(event *tcell.EventKey) *tcell.EventKey {
	switch event.Key() {
	case tcell.KeyCtrlC:
		app.Stop()
		return nil
	case tcell.KeyCtrlL:
		core.ToggleLog()
		return nil
	case tcell.KeyEscape:
		if errShown {
			core.MarkErrorsSeen()
			return nil
		}
		for i := len(modalTags) - 1; i >= 0; i-- {
			if modalTags[i] != "" && core.Open(modalTags[i]) {
				core.Comp(modalTags[i]).Set("open", false)
				return nil
			}
		}
	case tcell.KeyPgUp, tcell.KeyPgDn, tcell.KeyHome, tcell.KeyEnd:
		if !blocking() {
			switch app.GetFocus().(type) {
			case *tview.InputField, *tview.TextArea, *tview.List, *tview.Table, *tview.TreeView:
				return event
			}
			if scroller.key(event.Key()) {
				return nil
			}
		}
	case tcell.KeyTab:
		if !errShown {
			cycleFocus(1)
			return nil
		}
	case tcell.KeyBacktab:
		if !errShown {
			cycleFocus(-1)
			return nil
		}
	case tcell.KeyRune:
		if event.Rune() == 'q' {
			typing := false
			switch app.GetFocus().(type) {
			case *tview.InputField, *tview.TextArea:
				typing = true
			}
			if !typing {
				app.Stop()
				return nil
			}
		}
	}
	return event
})
app.SetRoot(pages, true)`;

/** Everything of ui_tview.go that does not depend on the design (after the imports). */
const TVIEW_HELPERS_GO = `// testScreen replaces the terminal when it is set (tests run the UI on a tcell simulation screen).
var testScreen tcell.Screen

// slot is one child of a Flex that can be hidden (it has a code name) together with its size.
type slot struct {
	p     tview.Primitive
	tag   string
	fixed int
	prop  int
}

// dynLayout is a Flex that is refilled when one of its code-named children is hidden or shown.
type dynLayout struct {
	tags []string
	last string
	fill func()
}

// focusItem is a control in Tab order together with the code names that decide whether it can
// be focused (its own and those of its containers).
type focusItem struct {
	p   tview.Primitive
	tag string
	anc []string
}

func hiddenKey(core *Core, tags []string) string {
	key := ""
	for _, tag := range tags {
		if core.Hidden(tag) {
			key += "1"
		} else {
			key += "0"
		}
	}
	return key
}

// fillFlex fills f with the slots that are not hidden: gaps, justify and the flexible spacers
// between them.
func fillFlex(core *Core, f *tview.Flex, slots []slot, gap int, justify string) {
	f.Clear()
	var shown []slot
	for _, s := range slots {
		if s.tag == "" || !core.Hidden(s.tag) {
			shown = append(shown, s)
		}
	}
	hasFill := false
	for _, s := range shown {
		if s.prop > 0 {
			hasFill = true
		}
	}
	flexible := func(n int) slot { return slot{prop: n} }
	between := func(sep []slot) []slot {
		var out []slot
		for i, s := range shown {
			if i > 0 {
				out = append(out, sep...)
			}
			out = append(out, s)
		}
		return out
	}
	var gapSlots []slot
	if gap > 0 {
		gapSlots = []slot{{fixed: gap}}
	}
	var out []slot
	switch {
	case hasFill || len(shown) == 0:
		out = between(gapSlots)
	case justify == "center":
		out = append(append([]slot{flexible(1)}, between(gapSlots)...), flexible(1))
	case justify == "end":
		out = append([]slot{flexible(1)}, between(gapSlots)...)
	case justify == "space-between":
		out = between(append(append([]slot{}, gapSlots...), flexible(1)))
	case justify == "space-around":
		out = append(append([]slot{flexible(1)}, between(append(append([]slot{}, gapSlots...), flexible(2)))...), flexible(1))
	default:
		out = append(between(gapSlots), flexible(1))
	}
	for _, s := range out {
		f.AddItem(s.p, s.fixed, s.prop, false)
	}
}

func sameStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func sameRows(a, b [][]string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if !sameStrings(a[i], b[i]) {
			return false
		}
	}
	return true
}

// progressBar draws "████░░░░  50%" with width cells of bar and the percentage in 5 cells.
func progressBar(value, limit float64, width int) string {
	ratio := 0.0
	if limit != 0 {
		ratio = value / limit
	}
	if ratio < 0 {
		ratio = 0
	}
	if ratio > 1 {
		ratio = 1
	}
	filled := int(ratio*float64(width) + 0.5)
	bar := ""
	for i := 0; i < width; i++ {
		if i < filled {
			bar += "█"
		} else {
			bar += "░"
		}
	}
	return fmt.Sprintf("%s%5s", bar, fmt.Sprintf("%d%%", int(ratio*100+0.5)))
}

// decor wraps a primitive that is drawn with border runes other than the global ones (tview.Borders
// is global) and/or with something drawn on top of it.
type decor struct {
	tview.Primitive
	runes []rune // horizontal, vertical, top-left, top-right, bottom-left, bottom-right
	after func(screen tcell.Screen)
}

func (d *decor) Draw(screen tcell.Screen) {
	if len(d.runes) == 6 {
		saved := tview.Borders
		tview.Borders.Horizontal, tview.Borders.HorizontalFocus = d.runes[0], d.runes[0]
		tview.Borders.Vertical, tview.Borders.VerticalFocus = d.runes[1], d.runes[1]
		tview.Borders.TopLeft, tview.Borders.TopLeftFocus = d.runes[2], d.runes[2]
		tview.Borders.TopRight, tview.Borders.TopRightFocus = d.runes[3], d.runes[3]
		tview.Borders.BottomLeft, tview.Borders.BottomLeftFocus = d.runes[4], d.runes[4]
		tview.Borders.BottomRight, tview.Borders.BottomRightFocus = d.runes[5], d.runes[5]
		defer func() { tview.Borders = saved }()
	}
	d.Primitive.Draw(screen)
	if d.after != nil {
		d.after(screen)
	}
}

// dropDownTexts are the options of every drop-down (tview has no getter for them).
var dropDownTexts = map[*tview.DropDown][]string{}

func setDropDownOptions(d *tview.DropDown, texts []string, selected func(text string, index int)) {
	dropDownTexts[d] = texts
	d.SetOptions(texts, selected)
}

// dropdownPopup redraws the open list of a drop-down as a box with a border that starts on the
// bottom border row of the field. tview draws its list borderless right under the field text; the
// highlighted row is read back from what it has just drawn.
func dropdownPopup(screen tcell.Screen, d *tview.DropDown, unsel, sel tcell.Style) {
	if !d.IsOpen() {
		return
	}
	ox, _, ow, _ := d.GetRect()
	ix, iy, _, _ := d.GetInnerRect()
	n := d.GetOptionCount()
	if n == 0 || ow < 3 {
		return
	}
	texts := dropDownTexts[d]
	cur := -1
	for i := 0; i < n && i < len(texts); i++ {
		if _, _, st, _ := screen.GetContent(ix, iy+1+i); st != unsel {
			cur = i
		}
	}
	// Drawn after the whole frame, so that widgets below the field do not paint over it.
	// The border of the field (a decor may have swapped tview.Borders for this widget).
	b := tview.Borders
	frame := [6]rune{b.HorizontalFocus, b.VerticalFocus, b.TopLeftFocus, b.TopRightFocus, b.BottomLeftFocus, b.BottomRightFocus}
	// One popup per drop-down: a frame that is drawn twice (scrolling into view) keeps the last.
	popups[d] = func() {
		drawPopup(screen, ox, ow, iy, texts, cur, unsel, sel, frame)
	}
}

// popups are the open drop-down lists of this frame; the application draws them last.
var popups = map[*tview.DropDown]func(){}

func drawPopups(tcell.Screen) {
	for d, p := range popups {
		p()
		delete(popups, d)
	}
}

func drawPopup(screen tcell.Screen, ox, ow, iy int, texts []string, cur int, unsel, sel tcell.Style, frame [6]rune) {
	n := len(texts)
	put := func(x, y int, r rune, st tcell.Style) { screen.SetContent(x, y, r, nil, st) }
	top, bottom := iy+1, iy+2+n
	for x := ox; x < ox+ow; x++ {
		put(x, top, frame[0], unsel)
		put(x, bottom, frame[0], unsel)
	}
	put(ox, top, frame[2], unsel)
	put(ox+ow-1, top, frame[3], unsel)
	put(ox, bottom, frame[4], unsel)
	put(ox+ow-1, bottom, frame[5], unsel)
	for i := 0; i < n; i++ {
		st := unsel
		if i == cur {
			st = sel
		}
		y := top + 1 + i
		put(ox, y, frame[1], unsel)
		put(ox+ow-1, y, frame[1], unsel)
		runes := []rune(texts[i])
		for x := ox + 1; x < ox+ow-1; x++ {
			r := ' '
			if k := x - (ox + 1); k < len(runes) {
				r = runes[k]
			}
			put(x, y, r, st)
		}
	}
}

// shiftPopupMouse maps clicks on the rows of the box drawn by dropdownPopup (one row lower than
// tview's own list) to the rows of that list; the border rows count as the field.
func shiftPopupMouse(d *tview.DropDown) {
	inner := d.GetMouseCapture()
	d.SetMouseCapture(func(action tview.MouseAction, event *tcell.EventMouse) (tview.MouseAction, *tcell.EventMouse) {
		if event != nil && d.IsOpen() {
			_, iy, _, _ := d.GetInnerRect()
			x, y := event.Position()
			if y > iy+1 {
				event = tcell.NewEventMouse(x, y-1, event.Buttons(), event.Modifiers())
			} else if y == iy+1 {
				event = tcell.NewEventMouse(x, iy, event.Buttons(), event.Modifiers())
			}
		}
		if inner != nil {
			return inner(action, event)
		}
		return action, event
	})
}

// gateable is what every tview widget has: its input can be intercepted.
type gateable interface {
	SetInputCapture(capture func(event *tcell.EventKey) *tcell.EventKey) *tview.Box
	SetMouseCapture(capture func(action tview.MouseAction, event *tcell.EventMouse) (tview.MouseAction, *tcell.EventMouse)) *tview.Box
}

// gate makes a widget ignore the keyboard and the mouse while its component is muted or
// readonly. Muted and readonly components therefore never change and never send events.
func gate(c *Comp, p gateable) {
	blocked := func() bool {
		st := c.State()
		return st == StateMuted || st == StateReadonly
	}
	p.SetInputCapture(func(event *tcell.EventKey) *tcell.EventKey {
		if blocked() {
			return nil
		}
		return event
	})
	p.SetMouseCapture(func(action tview.MouseAction, event *tcell.EventMouse) (tview.MouseAction, *tcell.EventMouse) {
		if blocked() {
			return tview.MouseConsumed, nil
		}
		return action, event
	})
}

// clipScreen forwards only the cells inside a rectangle.
type clipScreen struct {
	tcell.Screen
	x, y, w, h int
}

func (s *clipScreen) inside(x, y int) bool {
	return x >= s.x && x < s.x+s.w && y >= s.y && y < s.y+s.h
}

func (s *clipScreen) SetContent(x, y int, primary rune, combining []rune, style tcell.Style) {
	if s.inside(x, y) {
		s.Screen.SetContent(x, y, primary, combining, style)
	}
}

func (s *clipScreen) SetCell(x, y int, style tcell.Style, ch ...rune) {
	if s.inside(x, y) {
		s.Screen.SetCell(x, y, style, ch...)
	}
}

// scrollable is a widget that scrolls itself with the mouse wheel while it can; can reports
// whether it can still move in a direction (+1 down, -1 up).
type scrollable struct {
	p   tview.Primitive
	can func(dir int) bool
}

// scrollView shows its child in a window and scrolls it vertically when the design is taller
// than the window: mouse wheel (3 rows per notch), PageUp/PageDown/Home/End, and the focused
// widget is scrolled into view. The child is laid out at its full height, shifted by the offset
// and clipped to the window, so mouse hit-testing needs no translation. A thin scrollbar shows
// at the right edge only when there is something to scroll.
type scrollView struct {
	*tview.Box
	child       tview.Primitive
	contentH    int
	offset      int
	maxOffset   int
	pageH       int
	scrollables []scrollable
	focus       func() tview.Primitive
	lastFocus   tview.Primitive
}

func newScrollView(child tview.Primitive, contentH int) *scrollView {
	return &scrollView{Box: tview.NewBox(), child: child, contentH: contentH}
}

func (s *scrollView) clamp() {
	if s.offset > s.maxOffset {
		s.offset = s.maxOffset
	}
	if s.offset < 0 {
		s.offset = 0
	}
}

// scrollBy moves the window by n rows.
func (s *scrollView) scrollBy(n int) {
	s.offset += n
	s.clamp()
}

// key handles PageUp, PageDown, Home and End; it reports whether the key was used.
func (s *scrollView) key(k tcell.Key) bool {
	page := s.pageH - 1
	if page < 1 {
		page = 1
	}
	switch k {
	case tcell.KeyPgUp:
		s.scrollBy(-page)
	case tcell.KeyPgDn:
		s.scrollBy(page)
	case tcell.KeyHome:
		s.offset = 0
	case tcell.KeyEnd:
		s.offset = s.maxOffset
	default:
		return false
	}
	s.clamp()
	return true
}

func (s *scrollView) layout(x, y, w, h int) (int, int) {
	height := s.contentH
	if height < h {
		height = h
	}
	width := w
	if height > h {
		width = w - 1
	}
	s.maxOffset = height - h
	s.pageH = h
	s.clamp()
	s.child.SetRect(x, y-s.offset, width, height)
	return width, height
}

func (s *scrollView) Draw(screen tcell.Screen) {
	x, y, w, h := s.GetRect()
	if w <= 1 || h <= 0 {
		return
	}
	clip := &clipScreen{Screen: screen, x: x, y: y, w: w, h: h}
	s.layout(x, y, w, h)
	s.child.Draw(clip)
	// Bring a newly focused widget into view, then draw again at the new offset.
	if s.focus != nil {
		if f := s.focus(); f != nil && f != s.lastFocus {
			s.lastFocus = f
			if _, fy, _, fh := f.GetRect(); fh > 0 && s.maxOffset > 0 {
				before := s.offset
				if fy < y || fh > h {
					s.offset += fy - y
				} else if fy+fh > y+h {
					s.offset += fy + fh - (y + h)
				}
				s.clamp()
				if s.offset != before {
					s.layout(x, y, w, h)
					s.child.Draw(clip)
				}
			}
		}
	}
	if s.maxOffset > 0 {
		total := s.maxOffset + h
		thumb := h * h / total
		if thumb < 1 {
			thumb = 1
		}
		top := 0
		if s.maxOffset > 0 {
			top = s.offset * (h - thumb) / s.maxOffset
		}
		for row := 0; row < h; row++ {
			ch, style := '░', tcell.StyleDefault.Foreground(tcell.ColorGray)
			if row >= top && row < top+thumb {
				ch, style = '█', tcell.StyleDefault
			}
			screen.SetContent(x+w-1, y+row, ch, nil, style)
		}
	}
}

func (s *scrollView) Focus(delegate func(p tview.Primitive)) { delegate(s.child) }

func (s *scrollView) HasFocus() bool { return s.child.HasFocus() }

func (s *scrollView) Blur() { s.child.Blur() }

func (s *scrollView) InputHandler() func(event *tcell.EventKey, setFocus func(p tview.Primitive)) {
	return s.child.InputHandler()
}

func (s *scrollView) PasteHandler() func(pastedText string, setFocus func(p tview.Primitive)) {
	return s.child.PasteHandler()
}

func (s *scrollView) MouseHandler() func(action tview.MouseAction, event *tcell.EventMouse, setFocus func(p tview.Primitive)) (bool, tview.Primitive) {
	return s.WrapMouseHandler(func(action tview.MouseAction, event *tcell.EventMouse, setFocus func(p tview.Primitive)) (bool, tview.Primitive) {
		x, y := event.Position()
		if !s.InRect(x, y) {
			return false, nil
		}
		if action == tview.MouseScrollUp || action == tview.MouseScrollDown {
			dir := 1
			if action == tview.MouseScrollUp {
				dir = -1
			}
			// A list, table or tree under the pointer scrolls itself until it is at its end.
			for _, sc := range s.scrollables {
				rx, ry, rw, rh := sc.p.GetRect()
				if x >= rx && x < rx+rw && y >= ry && y < ry+rh && sc.can(dir) {
					if handler := s.child.MouseHandler(); handler != nil {
						return handler(action, event, setFocus)
					}
				}
			}
			s.scrollBy(3 * dir)
			return true, nil
		}
		if handler := s.child.MouseHandler(); handler != nil {
			return handler(action, event, setFocus)
		}
		return false, nil
	})
}

// tabBar is the tab strip of a Tabs component: a tab is chosen with a click or with Left/Right.
type tabBar struct {
	*tview.Box
	labels   []string
	active   int
	color    tcell.Color
	spans    [][2]int
	onChange func(index int)
}

func newTabBar(labels []string, active int, color tcell.Color) *tabBar {
	return &tabBar{Box: tview.NewBox(), labels: labels, active: active, color: color}
}

// choose selects a tab on behalf of the user.
func (b *tabBar) choose(index int) {
	if index < 0 || index >= len(b.labels) || index == b.active {
		return
	}
	b.active = index
	if b.onChange != nil {
		b.onChange(index)
	}
}

func (b *tabBar) Draw(screen tcell.Screen) {
	b.Box.DrawForSubclass(screen, b)
	x, y, width, _ := b.GetInnerRect()
	end := x + width
	b.spans = b.spans[:0]
	for i, label := range b.labels {
		text := " " + tview.Escape(label) + " "
		if i == b.active {
			text = "[::r]" + text + "[::-]"
		}
		size := tview.TaggedStringWidth(text)
		if x >= end {
			break
		}
		tview.Print(screen, text, x, y, end-x, tview.AlignLeft, b.color)
		b.spans = append(b.spans, [2]int{x, x + size})
		x += size
	}
	// the underline row: the active tab is marked with a heavy line, the rest is a dim rule
	left, _, _, height := b.GetInnerRect()
	if height < 2 {
		return
	}
	rule := tcell.StyleDefault.Foreground(tcell.ColorGray)
	mark := tcell.StyleDefault.Foreground(b.color)
	for cx := left; cx < end; cx++ {
		style, r := rule, '━'
		if b.active >= 0 && b.active < len(b.spans) {
			span := b.spans[b.active]
			if cx >= span[0] && cx < span[1] {
				style = mark
				if cx == span[0] {
					r = '╸'
				} else if cx == span[1]-1 {
					r = '╺'
				}
			}
		}
		screen.SetContent(cx, y+1, r, nil, style)
	}
}

func (b *tabBar) InputHandler() func(event *tcell.EventKey, setFocus func(p tview.Primitive)) {
	return b.WrapInputHandler(func(event *tcell.EventKey, setFocus func(p tview.Primitive)) {
		switch event.Key() {
		case tcell.KeyLeft:
			b.choose(b.active - 1)
		case tcell.KeyRight:
			b.choose(b.active + 1)
		}
	})
}

func (b *tabBar) MouseHandler() func(action tview.MouseAction, event *tcell.EventMouse, setFocus func(p tview.Primitive)) (bool, tview.Primitive) {
	return b.WrapMouseHandler(func(action tview.MouseAction, event *tcell.EventMouse, setFocus func(p tview.Primitive)) (bool, tview.Primitive) {
		x, y := event.Position()
		if !b.InRect(x, y) {
			return false, nil
		}
		if action == tview.MouseLeftClick || action == tview.MouseLeftDoubleClick {
			setFocus(b)
			for i, span := range b.spans {
				if x >= span[0] && x < span[1] {
					b.choose(i)
					break
				}
			}
			return true, nil
		}
		return action == tview.MouseLeftDown, nil
	})
}

// tviewUi is the tview side of the UI: it draws the store and writes user input back to it.
type tviewUi struct {
	core     *Core
	app      *tview.Application
	sync     func()
	dyn      []dynLayout
	scroller *scrollView
	starters []func()
	pending  atomic.Bool
	running  atomic.Bool
}

// Refresh redraws from the store soon (Renderer). It never blocks and coalesces calls.
func (t *tviewUi) Refresh() {
	if t.core.Closed() || !t.pending.CompareAndSwap(false, true) {
		return
	}
	go t.app.QueueUpdateDraw(func() {
		t.pending.Store(false)
		t.sync()
	})
}

// Stop closes the UI (Renderer).
func (t *tviewUi) Stop() {
	if t.running.Load() {
		t.app.Stop()
	} else {
		t.core.MarkClosed()
	}
}

// relayout refills the containers whose code-named children were hidden or shown.
func (t *tviewUi) relayout() {
	for i := range t.dyn {
		d := &t.dyn[i]
		if key := hiddenKey(t.core, d.tags); key != d.last {
			d.last = key
			d.fill()
		}
	}
}

// run runs the application on the calling goroutine until the UI is closed.
func (t *tviewUi) run() error {
	if testScreen != nil {
		t.app.SetScreen(testScreen)
	}
	t.running.Store(true)
	for _, start := range t.starters {
		start()
	}
	// QueueUpdate waits until the update ran, so it goes through its own goroutine.
	go t.app.QueueUpdate(func() {
		t.sync()
		t.core.SetReady()
	})
	err := t.app.EnableMouse(true).Run()
	t.running.Store(false)
	t.core.MarkClosed()
	return err
}
`;

// ── Files ───────────────────────────────────────────────────────────────────────

const HANDLE_TYPE: Record<string, string> = {
  Screen: 'Container',
  Box: 'Container',
  Grid: 'Container',
  Spacer: 'Container',
  Breadcrumb: 'Container',
  Text: 'Text',
  Spinner: 'Spinner',
  Button: 'Button',
  TextInput: 'Input',
  Checkbox: 'Check',
  Radio: 'Check',
  Toggle: 'Check',
  Select: 'Select',
  ProgressBar: 'Progress',
  Table: 'Table',
  List: 'List',
  Menu: 'Menu',
  Tabs: 'Tabs',
  Tree: 'Tree',
  Modal: 'Modal',
};

function goValue(v: unknown, type: ApiValueType): string {
  switch (type) {
    case 'str':
      return goStr(v);
    case 'int':
      return String(Math.trunc(Number(v) || 0));
    case 'float':
      return `float64(${Number(v) || 0})`;
    case 'bool':
      return v ? 'true' : 'false';
    case 'str_list':
      return `[]string{${((v as string[]) ?? []).map(goStr).join(', ')}}`;
    case 'rows':
      return `[][]string{${((v as string[][]) ?? []).map((r) => `{${r.map(goStr).join(', ')}}`).join(', ')}}`;
  }
}

const statesVar = (n: number) =>
  n >= 4 ? 'StatesAll' : n === 3 ? 'StatesNoReadonly' : 'StatesHideOnly';

/** ui.go: the typed facade (same surface as every Go export). */
function uiGo(handles: ApiHandleModel[]): string {
  const w = new CodeWriter('\t');
  w.block(`// The typed program API of this UI (see ui_runtime.go for what the handles can do).
//
//	ui := NewUi()
//	ui.Start()                              // UI in its own goroutine; returns when it is ready
//	ui.<Name>.OnClick(func(e Event) { ... })
//	ui.Wait()
//
// Generated by TUI Studio. Edit your own program (main.go: program), not this file.`);
  w.line();
  w.line('package main');
  w.line();
  w.wrap(
    'import (',
    () => {
      w.line('"errors"');
      w.line('"time"');
    },
    ')'
  );
  w.line();

  const used = new Set<string>([...BUBBLETEA_RESERVED_UI, 'Ui', 't']);
  const fields = handles.map((h) => {
    let name = apiName(h.tag, 'pascal');
    if (!/^[A-Z]/.test(name)) name = `X${name}`;
    let candidate = name;
    for (let i = 2; used.has(candidate); i++) candidate = `${name}${i}`;
    used.add(candidate);
    return { h, field: candidate };
  });

  w.line('// Ui is the facade of the UI: one typed handle per code name.');
  w.line('type Ui struct {');
  w.indent();
  w.line('*Core');
  w.line('t *tviewUi');
  for (const f of fields) w.line(`${f.field} *${HANDLE_TYPE[f.h.type]}Handle // ${f.h.type}`);
  w.dedent().line('}');
  w.line();
  w.line('// NewUi creates the UI and its handles.');
  w.line('func NewUi() *Ui {');
  w.indent();
  w.line('core := NewCore()');
  w.line('ui := &Ui{Core: core}');
  for (const { h, field } of fields) {
    const entries = h.properties.map((p) => `${goStr(p.name)}: ${goValue(p.initial, p.type)},`);
    if (h.type === 'Modal') entries.push('"open": false,');
    const state =
      h.initialState === 'muted'
        ? 'StateMuted'
        : h.initialState === 'readonly'
          ? 'StateReadonly'
          : h.initialState === 'hidden'
            ? 'StateHidden'
            : 'StateActive';
    const props = entries.length
      ? `map[string]any{\n${entries.map((e) => `\t\t${e}`).join('\n')}\n\t}`
      : 'nil';
    w.line(
      `ui.${field} = New${HANDLE_TYPE[h.type]}Handle(core.Define(${goStr(h.tag)}, ${goStr(h.type)}, ${statesVar(h.states.length)}, ${state}, ${props}))`
    );
  }
  w.line('ui.t = newTviewUi(core)');
  w.line('return ui');
  w.dedent().line('}');
  w.line();
  w.block(`// Start runs the UI in its own goroutine and returns when it is ready (or with an error).
func (u *Ui) Start() error {
	if !u.MarkStarted() {
		return errors.New("ui: already started")
	}
	errc := make(chan error, 1)
	go func() { errc <- u.t.run() }()
	if u.WaitReady(10 * time.Second) {
		return nil
	}
	select {
	case err := <-errc:
		if err != nil {
			return err
		}
	default:
	}
	return errors.New("ui: the UI did not start")
}

// Run runs the UI on the calling goroutine and fn (your program) next to it. It returns when the
// UI is closed.
func (u *Ui) Run(fn func(*Ui)) error {
	if !u.MarkStarted() {
		return errors.New("ui: already started")
	}
	go u.CatchPanics(func() {
		if u.WaitReady(10 * time.Second) {
			fn(u)
		}
	})
	return u.t.run()
}`);
  return w.toString();
}

function generateTview(ir: IRProject): ExportFile[] {
  const screen = ir.start;
  const own = new Set(walkIR(screen.root));
  // Components that are not shown at startup (hidden, inactive tab bodies) are not exported, so they have no handle.
  const handles = buildApiModel(ir).handles.filter((h) => own.has(h.node) && h.node.visible);
  const gen = new TviewGen(screen);
  const body = gen.generate();

  const kind: BorderKind | null = gen.dominant;

  const w = new CodeWriter('\t');
  w.block(`// ${screen.name || screen.ident}: the tview side of the UI (generated by TUI Studio).
//
// Layout: tview.Flex / tview.Grid mirror the design; wrapped and absolute containers are a
// snapshot of the editor positions (nested Flex rows and spacers); modals are overlay pages.
// Components with a code name are drawn from the store of ui_runtime.go: the program writes
// through the handles, this file applies the values (syncAll) and writes user input back.
// Keys: q or Ctrl+C quits, Tab / Shift+Tab moves the focus, Ctrl+L toggles the log panel.`);
  w.line('package main');
  w.line();
  w.line('import (');
  w.indent();
  w.line('"fmt"');
  w.line('"sync/atomic"');
  if (gen.usesTime) w.line('"time"');
  w.line();
  w.line('"github.com/gdamore/tcell/v2"');
  w.line('"github.com/rivo/tview"');
  w.dedent().line(')');
  w.line();
  w.block(TVIEW_HELPERS_GO);
  w.line();
  w.line('// newTviewUi builds the primitives of the design. It runs once, before the UI starts.');
  w.line('func newTviewUi(core *Core) *tviewUi {');
  w.indent();
  w.line('t := &tviewUi{core: core}');
  // tview's own theme is blue/white/yellow; the design decides the colours, everything else is the
  // terminal's own.
  for (const field of [
    'PrimitiveBackgroundColor',
    'ContrastBackgroundColor',
    'MoreContrastBackgroundColor',
    'BorderColor',
    'TitleColor',
    'GraphicsColor',
    'PrimaryTextColor',
    'SecondaryTextColor',
    'TertiaryTextColor',
    'InverseTextColor',
    'ContrastSecondaryTextColor',
  ]) {
    w.line(`tview.Styles.${field} = tcell.ColorDefault`);
  }
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
  w.line('app := tview.NewApplication()');
  w.line('t.app = app');
  w.line('app.SetAfterDrawFunc(drawPopups)');
  w.line('syncing := false');
  const uiTview = `${w.toString()}${body}`;

  const stubs = gen
    .handlerStubs()
    .map(
      (n) =>
        `\n// ${n} is called by the design; fill in what should happen.\nfunc ${n}() {\n\t// TODO\n}\n`
    )
    .join('');
  const main = `// ${screen.name || screen.ident}: generated by TUI Studio (tview exporter).
//
// Run:  go mod tidy && go run .
//
// Files: main.go (this file: your program), ui.go (typed program API: type Ui), ui_tview.go
// (the tview UI), ui_runtime.go (store, events, errors, log: identical for every Go export).
//
// The UI runs on the main goroutine, program() in its own goroutine next to it. Talk to the UI
// through ui: ui.<CodeName>.SetText("..."), ui.<CodeName>.OnClick(func(e Event) { ... }),
// ui.Report(err). Keys: q or Ctrl+C quits, Tab moves the focus, Ctrl+L shows the log.
package main

import (
	"fmt"
	"os"
)

func main() {
	ui := NewUi()
	if err := ui.Run(program); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

// program is your program: it runs in its own goroutine next to the UI. Returning from it does
// not close the UI.
func program(ui *Ui) {
	// your program goes here
}
${stubs}`;
  const goMod = `module ${screen.ident}\n\ngo 1.23\n\nrequire (\n\tgithub.com/gdamore/tcell/v2 ${TCELL_VERSION}\n\tgithub.com/rivo/tview ${TVIEW_VERSION}\n)\n`;
  return [
    { path: 'main.go', content: main },
    { path: 'ui.go', content: uiGo(handles) },
    { path: 'ui_tview.go', content: uiTview },
    { path: GO_RUNTIME_FILENAME, content: GO_RUNTIME_SOURCE },
    { path: 'go.mod', content: goMod },
  ];
}

export const tviewAdapter: ExportAdapter = {
  id: 'tview',
  label: 'tview (Go)',
  language: 'go',
  verification: 'run',
  multiScreen: false,
  generate: ({ ir }) => generateTview(ir),
};
