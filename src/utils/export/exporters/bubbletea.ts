// Bubble Tea (Go) exporter: bubbletea v1 + lipgloss v1 + bubbles (textinput, spinner, progress, table).
//
// Output: `main.go` (the Bubble Tea `model`), `ui.go` (the typed program API: `type Ui`),
// `ui_runtime.go` (framework-neutral runtime, identical for every export, see
// api/go/ui_runtime.go) and `go.mod`.
//
// Architecture: the state of every component lives in a store (Core in ui_runtime.go). The
// model only draws from it and writes the user's input back; program goroutines write through
// the typed handles and wake the program with a refresh message; handlers run on their own
// goroutine, never in Update/View.
//
// Layout strategies (also stated in the header of the generated file):
//   - flex containers (no wrap): NATIVE. Children are rendered to fixed-size strings and joined
//     with lipgloss.JoinHorizontal / JoinVertical; gaps, padding, justify and align become
//     margins computed from the editor's own layout (`rel`). Containers with a code-named child
//     join at run time so that hiding a child frees its space.
//   - flex with wrap, grid, absolute and unpositioned ("none") containers: SNAPSHOT. Every child
//     is rendered at its `rel` size and drawn at its `rel` position on a cell canvas (`overlay`).
//   - modals: rendered as a box and overlaid, centred, on top of their parent.

import type { ExportAdapter, ExportFile } from '../adapter';
import { renderFacade } from '../api/facade';
import { apiEventMethod, apiName, buildApiModel, type ApiHandleModel } from '../api/model';
import { API_SPEC, type ApiValueType } from '../api/spec';
import { GO_RUNTIME_FILENAME, GO_RUNTIME_SOURCE } from '../api/go/runtime';
import { CodeWriter, goStr } from '../lang';
import {
  itemText,
  inlineText,
  recase,
  treeLines,
  visibleChildren,
  type IRItem,
  type IRNode,
  type IRProject,
  type IRScreen,
} from '../ir';

export const BUBBLETEA_VERSIONS = {
  go: '1.24.2',
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

/**
 * Exported names of `Ui` (its own methods and everything promoted from `Core`). A code name that
 * spells one of them gets a trailing `_`, so a handle can never shadow API. A test keeps this
 * list in sync with ui_runtime.go.
 */
export const BUBBLETEA_RESERVED_UI = [
  'Core',
  'Log',
  'Start',
  'Run',
  'Stop',
  'Wait',
  'WaitTimeout',
  'WaitReady',
  'Ready',
  'Running',
  'Closed',
  'Report',
  'Errors',
  'UnseenErrors',
  'MarkErrorsSeen',
  'LogEntries',
  'LogVisible',
  'ToggleLog',
  'Events',
  'NextEvent',
  'CatchPanics',
  'Defer',
  'Define',
  'Comp',
  'Attach',
  'Renderer',
  'MarkStarted',
  'SetReady',
  'MarkClosed',
  'Hidden',
  'Muted',
  'Open',
  'Shown',
  'Usable',
  'Send',
  'Frame',
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
  /** Key in the store: the code name, or `~ident` for components without one. */
  tag: string;
  /** Has a code name (part of the program API). */
  pub: boolean;
  /** Struct field (bubbles model / cursor of the component). */
  field: string;
  /** `render<Name>` method. */
  method: string;
  /** Extra struct fields. */
  extra: Record<string, string>;
  focusConst?: string;
  /** Tag of the nearest modal above this node ('' if none): clicks are scoped to the open modal. */
  modal: string;
  /** Tags of the containers/modals above this node (without the screen). */
  ancestors: string[];
  api?: ApiHandleModel;
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
  // Same text as the reference (Textual): icon, label, status dot, hotkey.
  return `${i.icon ? `${i.icon} ` : ''}${oneLine(i.label)}${i.status ? ' ●' : ''}${i.hotkey ? ` ${oneLine(i.hotkey)}` : ''}`;
}

/** Widths of the table columns for the initial content (the runtime recomputes them). */
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
        // Buttons are at least 16 cells wide (as in the reference).
        w: Math.max(
          16,
          cellWidth(oneLine(inlineText(n))) + n.layout.padding.left + n.layout.padding.right + bw
        ),
        h: 1 + bh,
      };
    case 'Checkbox':
    case 'Radio':
    case 'Toggle':
    case 'Breadcrumb':
    case 'Spinner':
      return { w: cellWidth(oneLine(inlineText(n))) + bw, h: 1 + bh };
    case 'Select':
      return { w: maxW([...n.options, n.value]) + 6 + bw, h: 1 + bh };
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

/**
 * Visual layout of native flex containers: position (relative to the parent's outer box) and size
 * of each child, laid out the way the reference (Textual) does it. `fillW`: the width is the
 * parent's content width at run time (`w` is only the design-time fallback).
 */
interface VBoxInfo {
  x: number;
  y: number;
  w: number;
  h: number;
  fillW: boolean;
}
const VBOX = new WeakMap<IRNode, VBoxInfo>();

const FILL_TYPES = new Set<string>(['Select', 'List', 'Menu', 'Tree', 'Tabs']);

/** Containers whose children are flowed (stacked) instead of placed at the editor's positions. */
function isFlow(n: IRNode): boolean {
  const l = n.layout;
  return l.mode === 'flex' && !l.wrap && l.justify === 'start' && l.align === 'start';
}

/**
 * Lays out the children of a flow container and returns the size of its content. `availW` is the
 * content width the children may fill (null: unknown, they keep their natural width); `dynamic`:
 * the container is the root, whose content width is only known at run time.
 */
function flowLayout(n: IRNode, availW: number | null, dynamic: boolean): { w: number; h: number } {
  const row = n.layout.direction === 'row';
  const pad = n.layout.padding;
  const b = borderCells(n);
  const gap = Math.max(0, n.layout.gap);
  const x0 = b.left + pad.left;
  const y0 = b.top + pad.top;
  const kids = visibleChildren(n).filter((k) => k.type !== 'Modal');
  let main = 0;
  let cross = 0;
  kids.forEach((k, i) => {
    const fillW =
      !row &&
      (dynamic || availW !== null) &&
      !CONTAINERS.has(k.type) &&
      (k.width === 'fill' || (k.width === 'auto' && FILL_TYPES.has(k.type)));
    let w: number;
    let h: number;
    if (CONTAINERS.has(k.type) && isFlow(k)) {
      const kb = borderCells(k);
      const kp = k.layout.padding;
      const ew = kb.left + kb.right + kp.left + kp.right;
      const eh = kb.top + kb.bottom + kp.top + kp.bottom;
      const inner = flowLayout(k, typeof k.width === 'number' ? k.width - ew : null, false);
      w = typeof k.width === 'number' ? k.width : inner.w + ew;
      h = typeof k.height === 'number' ? k.height : inner.h + eh;
    } else {
      const old = sizeOf(k);
      const nat = natural(k);
      w = typeof k.width === 'number' || !nat ? old.w : nat.w;
      h = typeof k.height === 'number' || !nat ? old.h : nat.h;
      if (fillW && availW !== null) w = availW;
    }
    w = clampSize(w);
    h = clampSize(h);
    const x = row ? x0 + main : x0;
    const y = row ? y0 : y0 + main;
    VBOX.set(k, { x, y, w, h, fillW });
    main += (row ? w : h) + (i < kids.length - 1 ? gap : 0);
    cross = Math.max(cross, row ? h : w);
  });
  return row ? { w: main, h: cross } : { w: cross, h: main };
}

/** Outer size in cells: the editor's size, grown to the content for auto-sized widgets. */
function sizeOf(n: IRNode): { w: number; h: number } {
  const v = VBOX.get(n);
  if (v) return { w: v.w, h: v.h };
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

// ── Program API: values and handle types ──────────────────────────────────────

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

function statesVar(n: number): string {
  return n >= 4 ? 'StatesAll' : n === 3 ? 'StatesNoReadonly' : 'StatesHideOnly';
}

// ── Generator ─────────────────────────────────────────────────────────────────

class Gen {
  readonly infos = new Map<IRNode, Info>();
  readonly order: Info[] = [];
  readonly members = new Namer([
    ...GO_KEYWORDS,
    'ui',
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
    'focusable',
    'initialFocus',
    'pull',
    'c',
    'reg',
    'click',
    'wheel',
    'updateMouse',
    'activeModal',
    'focusOn',
    'hits',
    'dlg',
    'scroll',
    'scrollMax',
    'viewH',
    'contentY',
    'ddTag',
    'ddCur',
    'scrollWindow',
    'scrollBy',
    'scrollKey',
    'reveal',
    'openDropdown',
    'dropdownKey',
    'ddChoose',
    'selectChanged',
    'dropdownOverlay',
  ]);
  readonly pkg = new Namer([
    ...GO_KEYWORDS,
    'main',
    'program',
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
    'treeLabel',
    'menuRows',
    'tabsView',
    'selectRow',
    'tableStyles',
    'syncTable',
    'accent',
    'focusCount',
    'hit',
    'stripANSI',
    'tableRowAt',
    'tabAt',
    'logPanelHeight',
    'flexItem',
    'flexJoin',
    'line',
    'growW',
    'growH',
    'cycle',
    'selectCurrent',
    'ratio',
    'listLines',
    'errorDialog',
    'logPanel',
    'withDialog',
    'clip',
    'refreshMsg',
    'frameMsg',
    'teaRenderer',
    'Ui',
    'NewUi',
    'tea',
    'lipgloss',
    'strings',
    'fmt',
    'os',
    'textinput',
    'spinner',
    'progress',
    'table',
    'errors',
    'time',
  ]);
  /** raw handler name -> method name */
  readonly handlers = new Map<string, string>();
  readonly focusables: Info[] = [];
  readonly modalTags = new Set<string>();
  uses = { textinput: false, spinner: false, progress: false, table: false };
  private readonly apiByNode = new Map<IRNode, ApiHandleModel>();

  constructor(
    readonly screen: IRScreen,
    readonly project: IRProject
  ) {
    this.register(screen.root, []);
    if (isFlow(screen.root)) flowLayout(screen.root, null, true);
    this.buildApi();
    this.collectHandlers();
  }

  private register(n: IRNode, ancestors: string[]): void {
    if (!n.visible) return;
    const camel = recase(n.ident, 'camel');
    const pascal = recase(n.ident, 'pascal');
    const info: Info = {
      node: n,
      tag: n.tag ?? `~${n.ident}`,
      pub: n.tag !== undefined && n !== this.screen.root,
      field: this.members.take(camel),
      method: this.members.take(`render${pascal}`),
      extra: {},
      ancestors,
      modal: [...ancestors].reverse().find((t) => this.modalTags.has(t)) ?? '',
    };
    this.infos.set(n, info);
    this.order.push(info);
    if (n.type === 'Modal') this.modalTags.add(info.tag);
    const f = info.field;
    if (n.type === 'Tree') {
      info.extra.open = this.members.take(`${f}Open`);
      info.extra.nodes = this.members.take(`${f}Nodes`);
    }
    if (n.type === 'Table') info.extra.ver = this.members.take(`${f}Ver`);
    if (n.type === 'TextInput') this.uses.textinput = true;
    if (n.type === 'Spinner') this.uses.spinner = true;
    if (n.type === 'ProgressBar') this.uses.progress = true;
    if (n.type === 'Table') this.uses.table = true;
    if (FOCUSABLE.has(n.type)) {
      info.focusConst = this.pkg.take(`focus${pascal}`);
      this.focusables.push(info);
    }
    if (CONTAINERS.has(n.type)) {
      const below = n === this.screen.root ? ancestors : [...ancestors, info.tag];
      visibleChildren(n).forEach((c) => this.register(c, below));
    }
  }

  /** The program API of every node: the shared API model run over clones that all have a tag. */
  private buildApi(): void {
    const nodes = this.order.filter((i) => i.node !== this.screen.root).map((i) => i.node);
    const clones = nodes.map(
      (n) => ({ ...n, tag: n.tag ?? `~${n.ident}`, children: [] }) as IRNode
    );
    const root = { ...this.screen.root, children: clones } as IRNode;
    const screen = { ...this.screen, root, tag: undefined } as IRScreen;
    const model = buildApiModel({ screens: [screen], start: screen } as IRProject);
    nodes.forEach((n, i) => {
      this.apiByNode.set(n, model.handles[i]);
      this.infos.get(n)!.api = model.handles[i];
    });
  }

  private collectHandlers(): void {
    for (const info of this.order) {
      for (const raw of Object.values(info.node.events)) {
        if (!raw || this.handlers.has(raw)) continue;
        this.handlers.set(raw, this.members.take(handlerName(raw)));
      }
    }
  }

  /** `m.ui.Defer(m.handleX)` statements for the event classes of a node (they run off the UI goroutine). */
  calls(n: IRNode, ...classes: string[]): string[] {
    const out: string[] = [];
    for (const cls of classes) {
      for (const [event, raw] of Object.entries(n.events)) {
        if (!EVENT_CLASSES[cls].includes(event)) continue;
        const stmt = `m.ui.Defer(m.${this.handlers.get(raw)})`;
        if (!out.includes(stmt)) out.push(stmt);
      }
    }
    return out;
  }

  info(n: IRNode): Info {
    return this.infos.get(n)!;
  }

  /** `m.c("tag")`: the store entry of a component. */
  comp(info: Info): string {
    return `m.c(${goStr(info.tag)})`;
  }

  // ── Files ───────────────────────────────────────────────────────────────────

  generate(): ExportFile[] {
    return [
      { path: 'main.go', content: this.mainGo() },
      { path: 'ui.go', content: this.uiGo() },
      ...this.apiFile(),
      { path: GO_RUNTIME_FILENAME, content: GO_RUNTIME_SOURCE },
      { path: 'go.mod', content: this.goMod() },
    ];
  }

  private apiFile(): ExportFile[] {
    const fields = this.pubFields();
    if (!fields.length) return [];
    const handles = fields.map((f) => f.info.api!);
    const byHandle = new Map(handles.map((h, i) => [h, fields[i].field] as const));
    return [
      {
        path: 'api.go',
        content: renderFacade({ lang: 'go', handles, member: (h) => byHandle.get(h)! }).code,
      },
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

  // ── ui.go: the typed facade ─────────────────────────────────────────────────

  /** Handles by code name, with the field of `Ui` that holds each. */
  private pubFields(): { info: Info; field: string }[] {
    const used = new Set<string>([...BUBBLETEA_RESERVED_UI, 'Api']);
    const handles: { info: Info; field: string }[] = [];
    for (const info of this.order) {
      if (!info.pub) continue;
      let field = apiName(info.tag, 'pascal');
      if (!/^[A-Z]/.test(field)) field = `X${field}`;
      while (used.has(field)) field += '_';
      used.add(field);
      handles.push({ info, field });
    }
    return handles;
  }

  private uiGo(): string {
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
        w.line();
        w.line('tea "github.com/charmbracelet/bubbletea"');
      },
      ')'
    );
    w.line();

    const handles = this.pubFields();

    w.line('// Ui is the facade of the UI: one typed handle per code name.');
    w.line('type Ui struct {');
    w.indent();
    w.line('*Core');
    w.line('opts []tea.ProgramOption');
    if (handles.length) w.line('// Api: flat methods over the components (api.go).').line('Api *Api');
    for (const h of handles)
      w.line(`${h.field} *${HANDLE_TYPE[h.info.node.type]}Handle // ${h.info.node.type}`);
    w.dedent();
    w.line('}');
    w.line();

    w.line(
      '// NewUi creates the UI and its handles. Without options it runs on the alternate screen.'
    );
    w.line('func NewUi(opts ...tea.ProgramOption) *Ui {');
    w.indent();
    w.line('if len(opts) == 0 {');
    w.indent()
      .line('opts = []tea.ProgramOption{tea.WithAltScreen(), tea.WithMouseCellMotion()}')
      .dedent();
    w.line('}');
    w.line('core := NewCore()');
    w.line('ui := &Ui{Core: core, opts: opts}');
    for (const info of this.order) {
      if (info.node === this.screen.root) continue;
      const handle = handles.find((h) => h.info === info);
      const def = this.defineCall(info);
      if (handle) w.line(`ui.${handle.field} = New${HANDLE_TYPE[info.node.type]}Handle(${def})`);
      else w.line(def);
    }
    if (handles.length) w.line('ui.Api = newApi(ui)');
    w.line('return ui');
    w.dedent();
    w.line('}');
    w.line();

    w.block(String.raw`// Start runs the UI in its own goroutine and returns when it is ready (or with an error).
func (u *Ui) Start() error {
	if !u.MarkStarted() {
		return errors.New("ui: already started")
	}
	errc := make(chan error, 1)
	go func() { errc <- u.runProgram() }()
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
	return u.runProgram()
}

func (u *Ui) runProgram() error {
	p := tea.NewProgram(newModel(u), u.opts...)
	r := &teaRenderer{p: p, wake: make(chan struct{}, 1), done: make(chan struct{})}
	u.Attach(r)
	go r.pump()
	_, err := p.Run()
	close(r.done)
	u.MarkClosed()
	return err
}

// Send delivers a Bubble Tea message to the UI (tests use it to simulate keys).
func (u *Ui) Send(msg tea.Msg) {
	if r, ok := u.Renderer().(*teaRenderer); ok && !u.Closed() {
		r.p.Send(msg)
	}
}

// Frame returns what the UI currently shows ("" if it is not running).
func (u *Ui) Frame() string {
	r, ok := u.Renderer().(*teaRenderer)
	if !ok || u.Closed() {
		return ""
	}
	reply := make(chan string, 1)
	r.p.Send(frameMsg{reply: reply})
	select {
	case s := <-reply:
		return s
	case <-time.After(2 * time.Second):
		return ""
	}
}

// refreshMsg wakes the program after another goroutine changed the store.
type refreshMsg struct{}

// frameMsg asks the program for its current View.
type frameMsg struct{ reply chan string }

// teaRenderer connects the runtime to Bubble Tea. Refresh must never block (it can be called
// from Update), so wake-ups are coalesced and sent by a separate goroutine.
type teaRenderer struct {
	p    *tea.Program
	wake chan struct{}
	done chan struct{}
}

func (r *teaRenderer) Refresh() {
	select {
	case r.wake <- struct{}{}:
	default:
	}
}

func (r *teaRenderer) Stop() { go r.p.Quit() }

func (r *teaRenderer) pump() {
	for {
		select {
		case <-r.wake:
			r.p.Send(refreshMsg{})
		case <-r.done:
			return
		}
	}
}`);
    return w.toString();
  }

  private defineCall(info: Info): string {
    const n = info.node;
    const api = info.api!;
    const entries: string[] = [];
    for (const p of api.properties)
      entries.push(`${goStr(p.name)}: ${goValue(p.initial, p.type)},`);
    if (n.type === 'Modal') entries.push(`"open": ${info.pub ? 'false' : 'true'},`);
    const spec = API_SPEC[n.type];
    const state =
      api.initialState === 'muted'
        ? 'StateMuted'
        : api.initialState === 'readonly'
          ? 'StateReadonly'
          : api.initialState === 'hidden'
            ? 'StateHidden'
            : 'StateActive';
    const props = entries.length
      ? `map[string]any{\n${entries.map((e) => `\t\t${e}`).join('\n')}\n\t}`
      : 'nil';
    return `core.Define(${goStr(info.tag)}, ${goStr(n.type)}, ${statesVar(spec.states.length)}, ${state}, ${props})`;
  }

  // ── main.go ─────────────────────────────────────────────────────────────────

  private mainGo(): string {
    const w = new CodeWriter('\t');
    this.header(w);
    this.imports(w);
    this.consts(w);
    this.modelStruct(w);
    this.newModel(w);
    this.initUpdate(w);
    this.focusCode(w);
    this.mouseCode(w);
    if (this.hasSelect()) this.dropdownCode(w);
    this.pullCode(w);
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
// Files: main.go (the Bubble Tea model), ui.go (typed program API: type Ui), ui_runtime.go
// (runtime, identical for every export, do not edit), go.mod.
//
// Keys: tab / shift+tab move the focus, arrows / enter / space operate the focused component,
// esc closes modals and the error dialog, ctrl+l shows the log, q or ctrl+c quits (q is typed
// into a focused text input instead).
//
// Program API: put your program into program() below. It runs in its own goroutine next to the
// UI and talks to the components by code name, e.g. ui.SubmitBtn.OnClick(...), ui.Status.SetText(...).
// Handlers run on their own goroutine, never in Update/View. See ui_runtime.go for the handles.
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
// Event handlers (handleXxx) are stubs for you to fill in; they run on the handler goroutine.`);
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
    w.line('ui         *Ui // the store and the program API');
    w.line('winW, winH int // terminal size');
    w.line('focus      int // index into the focus ring');
    w.line('hits       []hit // rectangles of the interactive components, filled by View (mouse)');
    w.line('dlg        hit   // rectangle of the error dialog (zero if none)');
    w.line('scroll     int   // rows the root content is scrolled by');
    w.line('scrollMax  int   // largest scroll offset (content height - view height)');
    w.line('viewH      int   // height of the scrolled area');
    w.line('contentY   int   // screen row where the scrolled area starts');
    w.line('ddTag      string // select whose dropdown is open ("" if none)');
    w.line('ddCur      int   // highlighted option of that dropdown');
    for (const info of this.order) {
      const f = info.field;
      switch (info.node.type) {
        case 'TextInput':
          w.line(`${f} textinput.Model`);
          break;
        case 'Spinner':
          w.line(`${f} spinner.Model`);
          break;
        case 'ProgressBar':
          w.line(`${f} progress.Model`);
          break;
        case 'Table':
          w.line(`${f} table.Model`);
          w.line(`${info.extra.ver} uint64 // store version last copied into the table`);
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
    w.line('// c is the store entry of a component.');
    w.line('func (m *model) c(tag string) *Comp { return m.ui.Comp(tag) }');
    w.line();
  }

  private newModel(w: CodeWriter): void {
    w.line('func newModel(ui *Ui) *model {');
    w.indent();
    w.line('m := &model{ui: ui}');
    for (const info of this.order) {
      const n = info.node;
      const f = info.field;
      const d = dims(n);
      switch (n.type) {
        case 'TextInput':
          w.line(`m.${f} = textinput.New()`);
          w.line(`m.${f}.Prompt = ""`);
          w.line(`m.${f}.Width = ${Math.max(1, d.iw - 3)}`);
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
          break;
        }
        case 'Table':
          w.line(`m.${f} = table.New(`);
          w.indent();
          w.line(`table.WithStyles(tableStyles(${goStr(n.style.fg ?? '')})),`);
          w.line(`table.WithHeight(${d.ih}),`);
          w.line('table.WithFocused(false),');
          w.dedent();
          w.line(')');
          break;
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
    w.line('m.pull()');
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
    if (this.focusables.length) cmds.push('m.initialFocus()');
    if (this.uses.textinput) cmds.push('textinput.Blink');
    for (const info of this.order)
      if (info.node.type === 'Spinner') cmds.push(`m.${info.field}.Tick`);
    w.line('func (m *model) Init() tea.Cmd {');
    w.indent();
    w.line('m.ui.SetReady()');
    w.line(cmds.length ? `return tea.Batch(${cmds.join(', ')})` : 'return nil');
    w.dedent();
    w.line('}');
    w.line();

    w.line('func (m *model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {');
    w.indent();
    w.line('m.pull()');
    w.line('switch msg := msg.(type) {');
    w.line('case tea.WindowSizeMsg:');
    w.indent();
    w.line('m.winW, m.winH = msg.Width, msg.Height');
    w.line('return m, nil');
    w.dedent();
    w.line('case refreshMsg:');
    w.indent().line('return m, nil').dedent();
    w.line('case frameMsg:');
    w.indent();
    w.line('msg.reply <- m.View()');
    w.line('return m, nil');
    w.dedent();
    w.line('case tea.KeyMsg:');
    w.indent();
    w.line('prev := m.focus');
    w.line('next, cmd := m.updateKey(msg)');
    w.line('if m.focus != prev {');
    w.indent().line('m.reveal()').dedent();
    w.line('}');
    w.line('return next, cmd');
    w.dedent();
    w.line('case tea.MouseMsg:');
    w.indent();
    w.line('prev := m.focus');
    w.line('cmd := m.updateMouse(msg)');
    w.line('if m.focus != prev {');
    w.indent().line('m.reveal()').dedent();
    w.line('}');
    w.line('return m, cmd');
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
    w.line('case "ctrl+l":');
    w.indent().line('m.ui.ToggleLog()').line('return m, nil').dedent();
    w.line('}');
    w.line('// The error dialog takes every key until it is closed.');
    w.line('if len(m.ui.UnseenErrors()) > 0 {');
    w.indent();
    w.line('if key == "enter" || key == "esc" {');
    w.indent().line('m.ui.MarkErrorsSeen()').dedent();
    w.line('}');
    w.line('return m, nil');
    w.dedent();
    w.line('}');
    if (this.hasSelect()) {
      w.line('// An open dropdown takes the keys until it is closed.');
      w.line('if m.ddTag != "" {');
      w.indent().line('m.dropdownKey(key)').line('return m, nil').dedent();
      w.line('}');
    }
    w.line('switch key {');
    w.line('case "tab":');
    w.indent().line('return m, m.moveFocus(1)').dedent();
    w.line('case "shift+tab":');
    w.indent().line('return m, m.moveFocus(-1)').dedent();
    w.line('case "pgup", "pgdown", "home", "end":');
    w.indent();
    w.line('if !m.typing() && m.activeModal() == "" {');
    w.indent().line('m.scrollKey(key)').line('return m, nil').dedent();
    w.line('}');
    w.dedent();
    if (modals.length) {
      w.line('case "esc":');
      w.indent();
      modals.forEach((mo) => w.line(`m.${'c'}(${goStr(mo.tag)}).UserSet("open", false)`));
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
      for (const i of inputs) {
        w.line(`case ${i.focusConst}:`);
        w.indent()
          .line(`return ${this.comp(i)}.State() == StateActive`)
          .dedent();
      }
      w.line('}');
    }
    w.line('return false');
    w.dedent();
    w.line('}');
    w.line();

    // Key handling per focused component.
    w.line('// updateFocused handles a key for the focused component. Muted, readonly and hidden');
    w.line('// components ignore the user (and send no events).');
    w.line('func (m *model) updateFocused(msg tea.KeyMsg, key string) tea.Cmd {');
    w.indent();
    if (this.focusables.length) {
      w.line('if !m.focusable(m.focus) {');
      w.indent().line('return nil').dedent();
      w.line('}');
      w.line('switch m.focus {');
      for (const info of this.focusables) {
        w.line(`case ${info.focusConst}:`);
        w.indent();
        w.line(`c := ${this.comp(info)}`);
        w.line('if c.State() != StateActive {');
        w.indent().line('return nil').dedent();
        w.line('}');
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
        w.line(`before := m.${f}.Value()`);
        w.line('var cmd tea.Cmd');
        w.line(`m.${f}, cmd = m.${f}.Update(msg)`);
        w.line(`if after := m.${f}.Value(); after != before {`);
        w.indent();
        w.line('c.UserSet("value", after)');
        w.line('c.Emit("change", after)');
        emit(this.calls(n, 'change'));
        w.dedent();
        w.line('}');
        w.line('if key == "enter" {');
        w.indent();
        w.line(`c.Emit("submit", m.${f}.Value())`);
        emit(this.calls(n, 'select'));
        w.dedent();
        w.line('}');
        w.line('return cmd');
        break;
      }
      case 'Button': {
        w.line('if key == "enter" || key == " " {');
        w.indent();
        if (n.opensScreen)
          w.line('// This button opens another screen; only the start screen is exported.');
        w.line('c.Emit("click", nil)');
        emit(this.calls(n, 'click', 'select'));
        w.dedent();
        w.line('}');
        break;
      }
      case 'Checkbox':
      case 'Toggle': {
        w.line('if key == "enter" || key == " " {');
        w.indent();
        w.line('v := !c.Bool("checked")');
        w.line('c.UserSet("checked", v)');
        w.line('c.Emit("change", v)');
        emit(this.calls(n, 'change', 'click'));
        w.dedent();
        w.line('}');
        break;
      }
      case 'Radio': {
        w.line('if key == "enter" || key == " " {');
        w.indent();
        for (const sib of n.parent?.children ?? []) {
          if (sib !== n && sib.type === 'Radio' && this.infos.has(sib)) {
            w.line(`${this.comp(this.info(sib))}.UserSet("checked", false)`);
          }
        }
        w.line('c.UserSet("checked", true)');
        w.line('c.Emit("change", true)');
        emit(this.calls(n, 'change', 'click'));
        w.dedent();
        w.line('}');
        break;
      }
      case 'Select': {
        w.line('if key == "enter" || key == " " || key == "down" {');
        w.indent().line('m.openDropdown(c.Tag())').dedent();
        w.line('}');
        break;
      }
      case 'List':
      case 'Menu': {
        const count = n.type === 'List' ? 'len(c.List("items"))' : String(n.items.length);
        w.line('switch key {');
        w.line('case "up", "k":');
        w.indent().line(`c.UserSet("selected", moveCursor(c.Int("selected"), -1, ${count}))`);
        emit(this.calls(n, 'change'));
        w.dedent();
        w.line('case "down", "j":');
        w.indent().line(`c.UserSet("selected", moveCursor(c.Int("selected"), 1, ${count}))`);
        emit(this.calls(n, 'change'));
        w.dedent();
        w.line('case "enter", " ":');
        w.indent().line('c.Emit("select", c.Int("selected"))');
        emit(this.calls(n, 'select', 'click'));
        w.dedent();
        w.line('}');
        break;
      }
      case 'Tree': {
        w.line(`m.${f} = treeKey(m.${info.extra.nodes}(), m.${info.extra.open}, m.${f}, key)`);
        w.line('if key == "enter" {');
        w.indent();
        w.line(
          `c.Emit("select", treeLabel(m.${info.extra.nodes}(), m.${info.extra.open}, m.${f}))`
        );
        emit(this.calls(n, 'select', 'click'));
        w.dedent();
        w.line('}');
        break;
      }
      case 'Tabs': {
        const last = Math.max(0, n.items.length - 1);
        w.line('cur := c.Int("active_tab")');
        w.line('next := cur');
        w.line('switch key {');
        w.line('case "left", "h":');
        w.indent().line('next = max(cur-1, 0)').dedent();
        w.line('case "right", "l":');
        w.indent().line(`next = min(cur+1, ${last})`).dedent();
        w.line('}');
        w.line('if next != cur {');
        w.indent();
        w.line('c.UserSet("active_tab", next)');
        w.line('c.Emit("change", next)');
        emit(this.calls(n, 'change', 'select'));
        w.dedent();
        w.line('}');
        break;
      }
      case 'Table': {
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
    w.line('// moveFocus goes to the next component (d = 1) or the previous one (d = -1) that the');
    w.line('// user can use: hidden, muted and closed-modal components are skipped.');
    w.line('func (m *model) moveFocus(d int) tea.Cmd {');
    w.indent();
    if (count) {
      w.line('i := m.focus');
      w.line('for k := 0; k < focusCount; k++ {');
      w.indent();
      w.line('i = (i + d + focusCount) % focusCount');
      w.line('if m.focusable(i) {');
      w.indent().line('return m.setFocus(i)').dedent();
      w.line('}');
      w.dedent();
      w.line('}');
    }
    w.line('return nil');
    w.dedent();
    w.line('}');
    w.line();

    w.line('func (m *model) focusable(i int) bool {');
    w.indent();
    if (count) {
      w.line('switch i {');
      for (const info of this.focusables) {
        const anc = info.ancestors.map(goStr);
        w.line(`case ${info.focusConst}:`);
        w.indent()
          .line(`return m.ui.Usable(${[goStr(info.tag), ...anc].join(', ')})`)
          .dedent();
      }
      w.line('}');
    }
    w.line('return false');
    w.dedent();
    w.line('}');
    w.line();

    w.line('func (m *model) initialFocus() tea.Cmd {');
    w.indent();
    if (count) {
      w.line('if !m.focusable(m.focus) {');
      w.indent().line('return m.moveFocus(1)').dedent();
      w.line('}');
      w.line('return m.applyFocus()');
    } else {
      w.line('return nil');
    }
    w.dedent();
    w.line('}');
    w.line();

    // Blur actions
    const blur = this.focusables
      .map((i) => {
        const lines: string[] = [];
        if (i.node.type === 'TextInput') lines.push(`m.${i.field}.Blur()`);
        if (i.node.type === 'Table') lines.push(`m.${i.field}.Blur()`);
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
        if (i.node.type === 'Table') lines.push(`m.${i.field}.Focus()`);
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

  /** Mouse: left click on the rectangles View registered; the wheel scrolls lists. */
  private mouseCode(w: CodeWriter): void {
    const modals = this.order.filter((i) => i.node.type === 'Modal');
    w.line(
      '// activeModal is the open modal on top ("" if none): while one is open, clicks only reach it.'
    );
    w.line('func (m *model) activeModal() string {');
    w.indent();
    if (modals.length) {
      w.line('top := ""');
      for (const mo of modals) {
        w.line(`if m.ui.Open(${goStr(mo.tag)}) {`);
        w.indent()
          .line(`top = ${goStr(mo.tag)}`)
          .dedent();
        w.line('}');
      }
      w.line('return top');
    } else w.line('return ""');
    w.dedent();
    w.line('}');
    w.line();

    w.line('// focusOn moves the focus to component i (no-op if it has it already).');
    w.line('func (m *model) focusOn(i int) tea.Cmd {');
    w.indent();
    w.line('if i == m.focus {');
    w.indent().line('return nil').dedent();
    w.line('}');
    w.line('return m.setFocus(i)');
    w.dedent();
    w.line('}');
    w.line();

    w.line(
      '// updateMouse handles a mouse message: the error dialog first, then an open dropdown, then the'
    );
    w.line(
      '// open modal, then the UI. The wheel scrolls a list under the pointer, else the root content.'
    );
    w.line('func (m *model) updateMouse(msg tea.MouseMsg) tea.Cmd {');
    w.indent();
    w.line('left := msg.Action == tea.MouseActionPress && msg.Button == tea.MouseButtonLeft');
    w.line('if len(m.ui.UnseenErrors()) > 0 {');
    w.indent();
    w.line('if left && m.dlg.contains(msg.X, msg.Y) {');
    w.indent().line('m.ui.MarkErrorsSeen()').dedent();
    w.line('}');
    w.line('return nil');
    w.dedent();
    w.line('}');
    if (this.hasSelect()) {
      w.line('if m.ddTag != "" {');
      w.indent();
      w.line('if left {');
      w.indent();
      w.line('for i := len(m.hits) - 1; i >= 0; i-- {');
      w.indent();
      w.line('h := m.hits[i]');
      w.line('if h.opt == 0 || !h.contains(msg.X, msg.Y) {');
      w.indent().line('continue').dedent();
      w.line('}');
      w.line('if h.opt > 0 {');
      w.indent().line('m.ddChoose(h.opt - 1)').dedent();
      w.line('}');
      w.line('return nil');
      w.dedent();
      w.line('}');
      w.line('m.ddTag = "" // a click outside closes it without a change');
      w.dedent();
      w.line('}');
      w.line('return nil');
      w.dedent();
      w.line('}');
    }
    w.line('up := msg.Button == tea.MouseButtonWheelUp');
    w.line(
      'wheel := msg.Action == tea.MouseActionPress && (up || msg.Button == tea.MouseButtonWheelDown)'
    );
    w.line('if !left && !wheel {');
    w.indent().line('return nil').dedent();
    w.line('}');
    w.line('scope := m.activeModal()');
    w.line('for i := len(m.hits) - 1; i >= 0; i-- {');
    w.indent();
    w.line('h := m.hits[i]');
    w.line('if h.modal != scope || !h.contains(msg.X, msg.Y) {');
    w.indent().line('continue').dedent();
    w.line('}');
    w.line('if wheel {');
    w.indent();
    w.line('if cmd, moved := m.wheel(h, up); moved {');
    w.indent().line('return cmd').dedent();
    w.line('}');
    w.line('break');
    w.dedent();
    w.line('}');
    w.line('return m.click(h, msg.X-h.x, msg.Y-h.y)');
    w.dedent();
    w.line('}');
    w.line('if wheel && scope == "" {');
    w.indent();
    w.line('if up {');
    w.indent().line('m.scrollBy(-3)').dedent();
    w.line('} else {');
    w.indent().line('m.scrollBy(3)').dedent();
    w.line('}');
    w.dedent();
    w.line('}');
    w.line('return nil');
    w.dedent();
    w.line('}');
    w.line();

    // wheel: lists, menus, trees and tables scroll first; at their end (or elsewhere) the root does
    const scrollable = this.focusables.filter((f) =>
      ['List', 'Menu', 'Tree', 'Table'].includes(f.node.type)
    );
    w.line(
      '// wheel moves the cursor of the list under the pointer; moved is false when it did not'
    );
    w.line('// (not a list, or already at its end), so the caller scrolls the root instead.');
    w.line('func (m *model) wheel(h hit, up bool) (tea.Cmd, bool) {');
    w.indent();
    if (scrollable.length) {
      w.line('c := m.c(h.tag)');
      w.line('if c.State() != StateActive || !m.focusable(h.focus) {');
      w.indent().line('return nil, false').dedent();
      w.line('}');
      w.line('pos := func() int {');
      w.indent();
      w.line('switch h.focus {');
      for (const f of scrollable) {
        w.line(`case ${f.focusConst}:`);
        w.indent();
        if (f.node.type === 'Tree') w.line(`return m.${f.field}`);
        else if (f.node.type === 'Table') w.line(`return m.${f.field}.Cursor()`);
        else w.line('return c.Int("selected")');
        w.dedent();
      }
      w.line('}');
      w.line('return -1');
      w.dedent();
      w.line('}');
      w.line('before := pos()');
      w.line('if before < 0 {');
      w.indent().line('return nil, false').dedent();
      w.line('}');
      w.line('k := tea.KeyMsg{Type: tea.KeyDown}');
      w.line('if up {');
      w.indent().line('k = tea.KeyMsg{Type: tea.KeyUp}').dedent();
      w.line('}');
      w.line('old := m.focus');
      w.line('m.focus = h.focus');
      w.line('cmd := m.updateFocused(k, k.String())');
      w.line('m.focus = old');
      w.line('return cmd, pos() != before');
    } else {
      w.line('return nil, false');
    }
    w.dedent();
    w.line('}');
    w.line();

    // click
    w.line(
      '// click focuses the component under the pointer and does what Enter does (a row, a tab'
    );
    w.line(
      '// or an option is chosen by position). Muted, readonly and hidden components ignore it.'
    );
    w.line('func (m *model) click(h hit, rx, ry int) tea.Cmd {');
    w.indent();
    if (this.focusables.length) {
      w.line('c := m.c(h.tag)');
      w.line('if c.State() != StateActive || !m.focusable(h.focus) {');
      w.indent().line('return nil').dedent();
      w.line('}');
      w.line('cmd := m.focusOn(h.focus)');
      w.line('switch h.focus {');
      for (const info of this.focusables) {
        const n = info.node;
        const bc = borderCells(n);
        const enter = 'tea.Batch(cmd, m.updateFocused(tea.KeyMsg{Type: tea.KeyEnter}, "enter"))';
        w.line(`case ${info.focusConst}:`);
        w.indent();
        switch (n.type) {
          case 'TextInput':
            w.line('return cmd');
            break;
          case 'Select':
            w.line('m.openDropdown(h.tag)');
            w.line('return cmd');
            break;
          case 'List':
          case 'Menu': {
            const count = n.type === 'List' ? 'len(c.List("items"))' : String(n.items.length);
            w.line(`c.UserSet("selected", moveCursor(ry-${bc.top}, 0, ${count}))`);
            w.line(`return ${enter}`);
            break;
          }
          case 'Tree':
            w.line(
              `m.${info.field} = moveCursor(ry-${bc.top}, 0, len(treeVisible(m.${info.extra.nodes}(), m.${info.extra.open})))`
            );
            w.line(`return ${enter}`);
            break;
          case 'Table':
            w.line(`if r := tableRowAt(&m.${info.field}, ry-${bc.top}-1); r >= 0 {`);
            w.indent().line(`m.${info.field}.SetCursor(r)`).dedent();
            w.line('}');
            w.line(`return ${enter}`);
            break;
          case 'Tabs': {
            const labels = n.items.map((i) => goStr(tabLabel(i)));
            w.line(
              `if i := tabAt([]string{${labels.join(', ')}}, rx-${bc.left}); i >= 0 && i != c.Int("active_tab") {`
            );
            w.indent();
            w.line('c.UserSet("active_tab", i)');
            w.line('c.Emit("change", i)');
            this.calls(n, 'change', 'select').forEach((l) => w.line(l));
            w.dedent();
            w.line('}');
            w.line('return cmd');
            break;
          }
          default:
            w.line(`return ${enter}`);
        }
        w.dedent();
      }
      w.line('}');
    }
    w.line('return nil');
    w.dedent();
    w.line('}');
    w.line();
  }

  private hasSelect(): boolean {
    return this.focusables.some((f) => f.node.type === 'Select');
  }

  /** The dropdown of a Select: opens under the field, Up/Down/click choose, Esc/outside closes. */
  private dropdownCode(w: CodeWriter): void {
    const sels = this.focusables.filter((f) => f.node.type === 'Select');
    w.line('// openDropdown shows the options of a select under its field.');
    w.line('func (m *model) openDropdown(tag string) {');
    w.indent();
    w.line('c := m.c(tag)');
    w.line('opts := c.List("options")');
    w.line('if len(opts) == 0 {');
    w.indent().line('return').dedent();
    w.line('}');
    w.line('m.ddTag, m.ddCur = tag, 0');
    w.line('for i, o := range opts {');
    w.indent();
    w.line('if o == c.Str("value") {');
    w.indent().line('m.ddCur = i').dedent();
    w.line('}');
    w.dedent();
    w.line('}');
    w.dedent();
    w.line('}');
    w.line();
    w.line('// dropdownKey: Up/Down move, Enter or Space choose, Esc closes.');
    w.line('func (m *model) dropdownKey(key string) {');
    w.indent();
    w.line('n := len(m.c(m.ddTag).List("options"))');
    w.line('switch key {');
    w.line('case "up", "k":');
    w.indent().line('m.ddCur = max(m.ddCur-1, 0)').dedent();
    w.line('case "down", "j":');
    w.indent().line('m.ddCur = min(m.ddCur+1, n-1)').dedent();
    w.line('case "enter", " ":');
    w.indent().line('m.ddChoose(m.ddCur)').dedent();
    w.line('case "esc":');
    w.indent().line('m.ddTag = ""').dedent();
    w.line('}');
    w.dedent();
    w.line('}');
    w.line();
    w.line('// ddChoose closes the dropdown and sets the option; only a real change is an event.');
    w.line('func (m *model) ddChoose(i int) {');
    w.indent();
    w.line('tag := m.ddTag');
    w.line('m.ddTag = ""');
    w.line('c := m.c(tag)');
    w.line('opts := c.List("options")');
    w.line('if i < 0 || i >= len(opts) || opts[i] == c.Str("value") {');
    w.indent().line('return').dedent();
    w.line('}');
    w.line('c.UserSet("value", opts[i])');
    w.line('c.Emit("change", opts[i])');
    w.line('m.selectChanged(tag)');
    w.dedent();
    w.line('}');
    w.line();
    w.line('// selectChanged runs the editor handlers of a select whose value changed.');
    w.line('func (m *model) selectChanged(tag string) {');
    w.indent();
    for (const info of sels) {
      const calls = this.calls(info.node, 'change', 'select');
      if (!calls.length) continue;
      w.line(`if tag == ${goStr(info.tag)} {`);
      w.indent();
      calls.forEach((l) => w.line(l));
      w.dedent();
      w.line('}');
    }
    w.dedent();
    w.line('}');
    w.line();
    w.block(String.raw`// dropdownOverlay draws the open dropdown over the frame, under its field (above it if
// there is no room) and registers its rows in the click registry.
func (m *model) dropdownOverlay(out string) string {
	if m.ddTag == "" {
		return out
	}
	opts := m.c(m.ddTag).List("options")
	var anchor hit
	found := false
	for i := len(m.hits) - 1; i >= 0; i-- {
		if m.hits[i].tag == m.ddTag && m.hits[i].opt == 0 && m.hits[i].h > 0 {
			anchor, found = m.hits[i], true
			break
		}
	}
	if !found || len(opts) == 0 {
		m.ddTag = ""
		return out
	}
	inner := max(anchor.w-2, 1)
	for _, o := range opts {
		inner = max(inner, lipgloss.Width(line(o))+2)
	}
	rows := make([]string, len(opts))
	for i, o := range opts {
		st := lipgloss.NewStyle().Width(inner)
		if i == m.ddCur {
			st = st.Reverse(true)
		}
		rows[i] = st.Render(" " + line(o))
	}
	box := lipgloss.NewStyle().Border(lipgloss.NormalBorder()).BorderForeground(accent).Render(strings.Join(rows, "\n"))
	pw, ph := lipgloss.Width(box), lipgloss.Height(box)
	x, y := anchor.x, anchor.y+anchor.h
	if y+ph > lipgloss.Height(out) && anchor.y-ph >= 0 {
		y = anchor.y - ph
	}
	m.hits = append(m.hits, hit{focus: anchor.focus, tag: m.ddTag, modal: anchor.modal, opt: -1, x: x, y: y, w: pw, h: ph})
	for i := range opts {
		m.hits = append(m.hits, hit{focus: anchor.focus, tag: m.ddTag, modal: anchor.modal, opt: i + 1, x: x + 1, y: y + 1 + i, w: pw - 2, h: 1})
	}
	return overlay(out, x, y, box)
}`);
    w.line();
  }

  /** Copy what program goroutines wrote into the stateful bubbles widgets. */
  private pullCode(w: CodeWriter): void {
    w.line('// pull copies changes made through the program API into the bubbles widgets.');
    w.line('func (m *model) pull() {');
    w.indent();
    for (const info of this.order) {
      const n = info.node;
      const f = info.field;
      if (n.type === 'TextInput') {
        w.line('{');
        w.indent();
        w.line(`c := ${this.comp(info)}`);
        w.line(`if v := c.Str("value"); v != m.${f}.Value() {`);
        w.indent().line(`m.${f}.SetValue(v)`).dedent();
        w.line('}');
        w.line(`m.${f}.Placeholder = c.Str("placeholder")`);
        w.dedent();
        w.line('}');
      } else if (n.type === 'Table') {
        w.line('{');
        w.indent();
        w.line(`c := ${this.comp(info)}`);
        w.line(`if v := c.Version(); v != m.${info.extra.ver} {`);
        w.indent();
        w.line(`m.${info.extra.ver} = v`);
        w.line(`syncTable(&m.${f}, c.List("columns"), c.Rows("rows"))`);
        w.dedent();
        w.line('}');
        w.dedent();
        w.line('}');
      }
    }
    w.dedent();
    w.line('}');
    w.line();
  }

  private handlerStubs(w: CodeWriter): void {
    if (!this.handlers.size) return;
    w.line(
      '// Event handlers: fill these in. They run on the handler goroutine (not in Update), so'
    );
    w.line('// change the UI through the program API (m.ui.Status.SetText(...)).');
    for (const name of new Set(this.handlers.values())) {
      w.line(`func (m *model) ${name}() {`);
      w.indent().line('// TODO: implement').dedent();
      w.line('}');
      w.line();
    }
  }

  // ── View ────────────────────────────────────────────────────────────────────

  private view(w: CodeWriter): void {
    const root = this.info(this.screen.root);
    const rd = dims(root.node);
    w.line('func (m *model) View() string {');
    w.indent();
    w.line('m.pull()');
    w.line('m.hits = m.hits[:0]');
    w.line('m.dlg = hit{}');
    w.line(
      '// The root fills the terminal (top-left); before the first size message it has the design size.'
    );
    w.line(`w, h := ${rd.w}, ${rd.h}`);
    w.line('if m.winW > 0 && m.winH > 0 {');
    w.indent().line('w, h = m.winW, m.winH').dedent();
    w.line('}');
    w.line('logOn := m.ui.LogVisible()');
    w.line('if logOn {');
    w.indent().line('h = max(h-logPanelHeight, 3)').dedent();
    w.line('}');
    w.line(`out := m.${root.method}(0, 0, w, h)`);
    // Modals are not scrolled: they are centred over the visible window.
    for (const mo of visibleChildren(root.node).filter(
      (c) => c.type === 'Modal' && this.infos.has(c)
    )) {
      const ms = sizeOf(mo);
      const mi = this.info(mo);
      w.line(`if m.ui.Open(${goStr(mi.tag)}) {`);
      w.indent();
      w.line(`mx, my := max((w-${ms.w})/2, 0), max((h-${ms.h})/2, 0)`);
      w.line(`out = overlay(out, mx, my, m.${mi.method}(mx, my))`);
      w.dedent();
      w.line('}');
    }
    if (this.hasSelect()) w.line('out = m.dropdownOverlay(out)');
    w.line('if logOn {');
    w.indent()
      .line('out = lipgloss.JoinVertical(lipgloss.Left, out, logPanel(m.ui.LogEntries(), w))')
      .dedent();
    w.line('}');
    w.line('if errs := m.ui.UnseenErrors(); len(errs) > 0 {');
    w.indent().line('out, m.dlg = withDialog(out, errorDialog(errs, w))').dedent();
    w.line('}');
    w.line('if m.winW > 0 && m.winH > 0 {');
    w.indent().line('out = frame(out, m.winW, m.winH, lipgloss.Left, lipgloss.Top)').dedent();
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
    const isRoot = n === this.screen.root;
    const b = borderCells(n);
    const kids = visibleChildren(n).filter((c) => c.type !== 'Modal' && this.infos.has(c));
    // The modals of the root are overlaid by View (they do not scroll with the content).
    const modals = isRoot
      ? []
      : visibleChildren(n).filter((c) => c.type === 'Modal' && this.infos.has(c));
    const native = n.layout.mode === 'flex' && !n.layout.wrap;
    const hidden = (k: IRNode) => `m.ui.Hidden(${goStr(this.info(k).tag)})`;
    const showTitle = n.type === 'Modal' && d.w >= 6;
    // The root fills the terminal: its size is a parameter, everything inside keeps its offsets.
    const W = isRoot ? 'w' : String(d.w);
    const H = isRoot ? 'h' : String(d.h);
    const IW = isRoot ? 'iw' : String(d.iw);
    const IH = isRoot ? 'ih' : String(d.ih);
    w.line(
      `func (m *model) ${info.method}(${isRoot ? 'ox, oy, w, h int' : 'ox, oy int'}) string {`
    );
    w.indent();
    if (isRoot) {
      w.line(`iw, ih := max(w-${b.left + b.right}, 1), max(h-${b.top + b.bottom}, 1)`);
    }
    if (showTitle) w.line(`c := ${this.comp(info)}`);
    if (isRoot) w.line('start := len(m.hits)');
    const origin = `ox+${b.left}, oy+${b.top}`;
    if (!kids.length) {
      w.line('content := ""');
    } else if (native) {
      const row = n.layout.direction === 'row';
      let cursor = 0;
      w.line(`content := flexJoin(${row}, ${origin}, []flexItem{`);
      w.indent();
      for (const k of kids) {
        const v = VBOX.get(k);
        const r = v ?? k.rel ?? { x: 0, y: 0, width: 0, height: 0 };
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
        const off = this.info(k).pub ? hidden(k) : 'false';
        if (v?.fillW) {
          // Fills the content width of the parent (the terminal for the root).
          const avail = isRoot
            ? `max(iw-${n.layout.padding.left + n.layout.padding.right}, 1)`
            : String(s.w);
          w.line(
            `{func(x, y int) string { return m.${this.info(k).method}(x, y, ${avail}) }, ${dx}, ${dy}, ${off}},`
          );
        } else w.line(`{m.${this.info(k).method}, ${dx}, ${dy}, ${off}},`);
      }
      w.dedent();
      w.line('})');
    } else {
      // The root canvas is as tall as its content (it scrolls); other canvases have their size.
      const bottom = Math.max(...kids.map((k) => (k.rel?.y ?? 0) - d.bt + sizeOf(k).h), 1);
      w.line(`cv := newCanvas(${IW}, ${isRoot ? `max(${IH}, ${bottom})` : IH})`);
      for (const k of kids) {
        const r = k.rel ?? { x: 0, y: 0, width: 0, height: 0 };
        const x = r.x - d.bl;
        const y = r.y - d.bt;
        const put = `cv.put(${x}, ${y}, m.${this.info(k).method}(ox+${b.left}+${x}, oy+${b.top}+${y}))`;
        if (this.info(k).pub) {
          w.line(`if !${hidden(k)} {`);
          w.indent().line(put).dedent();
          w.line('}');
        } else w.line(put);
      }
      w.line('content := cv.String()');
    }
    if (isRoot) w.line(`content = m.scrollWindow(content, start, oy+${b.top}, iw, ih)`);
    const body = `${styleChain(n)}.Render(frame(content, ${IW}, ${IH}, lipgloss.Left, lipgloss.Top))`;
    if (!modals.length && !showTitle) {
      w.line(`return ${body}`);
    } else {
      w.line(`out := ${body}`);
      if (showTitle) {
        w.line(
          `out = overlay(out, 2, 0, lipgloss.NewStyle().Bold(true).MaxWidth(${d.w - 4}).Render(" " + line(c.Str("title")) + " "))`
        );
      }
      for (const mo of modals) {
        const ms = sizeOf(mo);
        const mi = this.info(mo);
        // centred over this container
        w.line(`if m.ui.Open(${goStr(mi.tag)}) {`);
        w.indent();
        w.line(`mx, my := max((${W}-${ms.w})/2, 0), max((${H}-${ms.h})/2, 0)`);
        w.line(`out = overlay(out, mx, my, m.${mi.method}(ox+mx, oy+my))`);
        w.dedent();
        w.line('}');
      }
      w.line('return out');
    }
    w.dedent();
    w.line('}');
  }

  private leaf(real: CodeWriter, info: Info): void {
    const w = new CodeWriter('	');
    const n = info.node;
    const f = info.field;
    const d = dims(n);
    const fillW = !!VBOX.get(n)?.fillW;
    // A widget that fills its parent gets the outer width as a parameter.
    const IW = fillW ? 'iw' : String(d.iw);
    const focused = info.focusConst ? `m.focus == ${info.focusConst}` : '';
    const frame = (content: string, hpos = 'lipgloss.Left', vpos = 'lipgloss.Top') =>
      `frame(${content}, ${IW}, ${d.ih}, ${hpos}, ${vpos})`;
    // Auto-sized widgets grow with their content (the program can write longer texts).
    const grown = (content: string, hpos = 'lipgloss.Left', vpos = 'lipgloss.Top') => {
      const gw = n.width === 'auto' ? `growW(content, ${IW})` : String(d.iw);
      const gh = n.height === 'auto' ? `growH(content, ${d.ih})` : String(d.ih);
      w.line(`content := ${content}`);
      return `frame(content, ${gw}, ${gh}, ${hpos}, ${vpos})`;
    };
    const cdecl = () => w.line(`c := ${this.comp(info)}`);
    w.line(`func (m *model) ${info.method}(ox, oy${fillW ? ', w' : ''} int) string {`);
    w.indent();
    if (fillW) w.line(`iw := max(w-${d.bl + borderCells(n).right}, 1)`);
    const usesStore = [
      'Text',
      'Button',
      'Checkbox',
      'Radio',
      'Toggle',
      'Select',
      'Spinner',
      'ProgressBar',
      'List',
      'Menu',
      'Tabs',
    ];
    if (usesStore.includes(n.type)) cdecl();
    w.line(`st := ${styleChain(n)}`);
    if (API_SPEC[n.type].states.includes('muted')) {
      w.line(`if m.ui.Muted(${goStr(info.tag)}) {`);
      w.indent().line('st = st.Faint(true)').dedent();
      w.line('}');
    }
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
        w.line('if c.Bool("checked") {');
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
        w.line('if !c.Bool("checked") {');
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
        const text = 'c.Str("text")';
        if (n.wrapText) {
          w.line(
            `return st.Render(${frame(`lipgloss.NewStyle().Width(${IW}).Render(${text})`, HPOS[n.textAlign])})`
          );
        } else {
          w.line(`return st.Render(${grown(text, HPOS[n.textAlign])})`);
        }
        break;
      }
      case 'Button': {
        w.line('// Button: Enter or Space presses it.');
        focusStyle('reverse');
        const left = n.iconLeft ? `${goStr(`${n.iconLeft} `)} + ` : '';
        const right = n.iconRight ? ` + ${goStr(` ${n.iconRight}`)}` : '';
        w.line(
          `return st.Render(${grown(`${left}line(c.Str("label"))${right}`, 'lipgloss.Center', 'lipgloss.Center')})`
        );
        break;
      }
      case 'Checkbox':
      case 'Radio': {
        const [open, close] = n.type === 'Checkbox' ? ['[', ']'] : ['(', ')'];
        stateColors();
        focusStyle('reverse');
        w.line(`mark := ${goStr(n.glyphs.off)}`);
        w.line('if c.Bool("checked") {');
        w.indent()
          .line(`mark = ${goStr(n.glyphs.on)}`)
          .dedent();
        w.line('}');
        w.line(
          `return st.Render(${grown(`${goStr(open)} + mark + ${goStr(close + ' ')} + line(c.Str("label"))`)})`
        );
        break;
      }
      case 'Toggle': {
        stateColors();
        focusStyle('reverse');
        w.line('mark := "[OFF]"');
        w.line('if c.Bool("checked") {');
        w.indent().line('mark = "[ON ]"').dedent();
        w.line('}');
        w.line(`return st.Render(${grown('mark + " " + line(c.Str("label"))')})`);
        break;
      }
      case 'Select': {
        focusStyle('reverse');
        w.line('current := selectCurrent(c.List("options"), c.Str("value"))');
        w.line(`return st.Render(${grown(`selectRow(line(current), ${IW})`)})`);
        break;
      }
      case 'TextInput': {
        focusStyle('reverse');
        w.line(`return st.Render(${frame(`"  " + m.${f}.View()`)})`);
        break;
      }
      case 'Spinner': {
        w.line('label := c.Str("label")');
        w.line('if label == "" {');
        w.indent().line('label = "Loading..."').dedent();
        w.line('}');
        w.line(`return st.Render(${grown(`m.${f}.View() + " " + line(label)`)})`);
        break;
      }
      case 'ProgressBar': {
        w.line(
          `return st.Render(${frame(`m.${f}.ViewAs(ratio(c.Float("value"), c.Float("max")))`)})`
        );
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
        w.line(`return st.Render(${frame(`m.${f}.View()`)})`);
        break;
      }
      case 'List':
      case 'Menu': {
        focusStyle('border-only');
        selectionStyles();
        // Lists show the labels only (as the reference does); menus keep icons and hotkeys.
        const shown = n.items.map((i) =>
          goStr(oneLine(n.type === 'List' ? i.label : itemText(i)))
        );
        if (n.type === 'List') {
          const labels = n.items.map((i) => goStr(oneLine(i.label)));
          w.line(
            `lines := listLines(c.List("items"), []string{${labels.join(', ')}}, []string{${shown.join(', ')}})`
          );
        } else {
          w.line(`lines := []string{${shown.join(', ')}}`);
        }
        w.line(`body := menuRows(lines, c.Int("selected"), ${IW}, lipgloss.NewStyle(), hl)`);
        w.line(`return st.Render(${frame('body')})`);
        break;
      }
      case 'Tree': {
        focusStyle('border-only');
        selectionStyles();
        w.line(
          `body := menuRows(treeRows(m.${info.extra.nodes}(), m.${info.extra.open}), m.${f}, ${IW}, lipgloss.NewStyle(), hl)`
        );
        w.line(`return st.Render(${frame('body')})`);
        break;
      }
      case 'Tabs': {
        focusStyle('border-only');
        selectionStyles();
        const labels = n.items.map((i) => goStr(tabLabel(i)));
        w.line(
          `body := tabsView([]string{${labels.join(', ')}}, c.Int("active_tab"), ${IW}, lipgloss.NewStyle(), hl)`
        );
        w.line(`return st.Render(${frame('body')})`);
        break;
      }
      default:
        w.line(`return st.Render(${frame('""')})`);
    }
    w.dedent();
    w.line('}');
    // Interactive components register the rectangle they were drawn at (for mouse clicks).
    let text = w.toString().replace(/\n$/, '');
    if (info.focusConst) {
      text = text.replace(
        /^\treturn st\.Render\((.*)\)$/gm,
        (_m, expr) =>
          `\treturn m.reg(${info.focusConst}, ${goStr(info.tag)}, ${goStr(info.modal)}, ox, oy, st.Render(${expr}))`
      );
    }
    real.block(text);
  }

  // ── Static parts ────────────────────────────────────────────────────────────

  private helpers(): string {
    const parts: string[] = [HELPERS];
    if (this.uses.table) parts.push(TABLE_HELPERS);
    return parts.join('\n');
  }

  private mainFunc(): string {
    return String.raw`func main() {
	ui := NewUi()
	if err := ui.Run(program); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

// program is your program: it runs in its own goroutine next to the UI (see ui.go for the
// typed handles). Returning from it does not close the UI.
func program(ui *Ui) {
	// your program goes here
}`;
  }
}

const TABLE_HELPERS = String.raw`// syncTable copies columns and rows from the store into a bubbles table.
func syncTable(t *table.Model, cols []string, rows [][]string) {
	n := len(cols)
	if n == 0 {
		for _, r := range rows {
			n = max(n, len(r))
		}
	}
	tc := make([]table.Column, n)
	for i := range tc {
		title := ""
		if i < len(cols) {
			title = line(cols[i])
		}
		tc[i] = table.Column{Title: title, Width: max(1, lipgloss.Width(title))}
	}
	tr := make([]table.Row, len(rows))
	for r, row := range rows {
		cells := make(table.Row, n)
		for i := range cells {
			if i < len(row) {
				cells[i] = line(row[i])
			}
			tc[i].Width = max(tc[i].Width, lipgloss.Width(cells[i]))
		}
		tr[r] = cells
	}
	cur := t.Cursor()
	t.SetCursor(0)
	t.SetRows(nil)
	t.SetColumns(tc)
	t.SetRows(tr)
	t.SetCursor(min(cur, max(len(tr)-1, 0)))
}

// tableRowAt maps a line below the table header to the index of the row drawn there (-1 if none).
func tableRowAt(t *table.Model, row int) int {
	if row < 0 {
		return -1
	}
	lines := strings.Split(stripANSI(t.View()), "\n")
	if row+1 >= len(lines) {
		return -1
	}
	text := lines[row+1]
	best := -1
	for i, r := range t.Rows() {
		pos, ok := 0, true
		for _, cell := range r {
			if cell == "" {
				continue
			}
			k := strings.Index(text[pos:], cell)
			if k < 0 {
				ok = false
				break
			}
			pos += k + len(cell)
		}
		cur := t.Cursor()
		if ok && (best < 0 || max(i-cur, cur-i) < max(best-cur, cur-best)) {
			best = i
		}
	}
	return best
}

func tableStyles(fg string) table.Styles {
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

// growW / growH: an auto-sized widget is at least as big as its content.
func growW(s string, w int) int { return max(w, lipgloss.Width(s)) }
func growH(s string, h int) int { return max(h, lipgloss.Height(s)) }

// line makes a string safe for a single-line widget.
func line(s string) string {
	return strings.NewReplacer("\r\n", " ", "\n", " ", "\r", " ").Replace(s)
}

// frame clips s to w x h cells and pads it to exactly that size.
func frame(s string, w, h int, hpos, vpos lipgloss.Position) string {
	s = lipgloss.NewStyle().MaxWidth(w).MaxHeight(h).Render(s)
	return lipgloss.Place(w, h, hpos, vpos, s)
}

// shift moves a block right by dx cells and down by dy lines (used by the flex layout).
func shift(s string, dx, dy int) string {
	return lipgloss.NewStyle().MarginLeft(dx).MarginTop(dy).Render(s)
}

// flexItem is a child of a flex container: how to draw it at a position, the offset before it
// and whether it is hidden (a hidden child takes no space).
type flexItem struct {
	draw   func(x, y int) string
	dx, dy int
	off    bool
}

// flexJoin draws the visible items one after the other from (ox, oy); the first one keeps the
// container's leading offset. Every item learns the position it is drawn at (mouse clicks).
func flexJoin(row bool, ox, oy int, items []flexItem) string {
	var parts []string
	lead := 0
	if len(items) > 0 {
		lead = items[0].dy
		if row {
			lead = items[0].dx
		}
	}
	x, y := ox, oy
	for _, it := range items {
		if it.off {
			continue
		}
		dx, dy := it.dx, it.dy
		if len(parts) == 0 {
			if row {
				dx = lead
			} else {
				dy = lead
			}
		}
		var s string
		if row {
			s = it.draw(x+dx, oy+dy)
			x += dx + lipgloss.Width(s)
		} else {
			s = it.draw(ox+dx, y+dy)
			y += dy + lipgloss.Height(s)
		}
		parts = append(parts, shift(s, dx, dy))
	}
	if len(parts) == 0 {
		return ""
	}
	if row {
		return lipgloss.JoinHorizontal(lipgloss.Top, parts...)
	}
	return lipgloss.JoinVertical(lipgloss.Left, parts...)
}

// hit is the rectangle an interactive component was drawn at.
type hit struct {
	focus      int
	tag, modal string
	x, y, w, h int  // the visible rectangle on the screen
	y0, fh     int  // row and height in the unscrolled content
	scrolls    bool // part of the scrolled root content
	opt        int  // dropdown: -1 the popup, n the row of option n-1; 0 for components
}

func (r hit) contains(x, y int) bool {
	return x >= r.x && x < r.x+r.w && y >= r.y && y < r.y+r.h
}

// reg records where a component was drawn and returns its drawing unchanged.
func (m *model) reg(focus int, tag, modal string, ox, oy int, s string) string {
	w, h := lipgloss.Width(s), lipgloss.Height(s)
	m.hits = append(m.hits, hit{focus: focus, tag: tag, modal: modal, x: ox, y: oy, w: w, h: h, y0: oy, fh: h})
	return s
}

// scrollWindow shows the part of the root content the user scrolled to: it clamps the offset,
// moves the click rectangles registered since start to screen coordinates and draws a thin
// scrollbar on the right edge when the content does not fit.
func (m *model) scrollWindow(content string, start, top, iw, ih int) string {
	total := lipgloss.Height(content)
	m.viewH, m.contentY = ih, top
	m.scrollMax = max(total-ih, 0)
	m.scroll = min(max(m.scroll, 0), m.scrollMax)
	for i := start; i < len(m.hits); i++ {
		r := &m.hits[i]
		r.scrolls, r.y0, r.fh = true, r.y, r.h
		y0, y1 := max(r.y-m.scroll, top), min(r.y-m.scroll+r.h, top+ih)
		r.y, r.h = y0, max(y1-y0, 0)
	}
	if m.scrollMax == 0 {
		return content
	}
	lines := strings.Split(content, "\n")
	view := strings.Join(lines[m.scroll:min(m.scroll+ih, len(lines))], "\n")
	thumb := max(ih*ih/total, 1)
	pos := m.scroll * (ih - thumb) / m.scrollMax
	bar := make([]string, ih)
	for i := range bar {
		bar[i] = "▕"
		if i >= pos && i < pos+thumb {
			bar[i] = "▐"
		}
	}
	return overlay(frame(view, iw, ih, lipgloss.Left, lipgloss.Top), iw-1, 0, strings.Join(bar, "\n"))
}

func (m *model) scrollBy(d int) {
	m.scroll = min(max(m.scroll+d, 0), m.scrollMax)
}

// scrollKey: PageUp / PageDown scroll by a page, Home / End jump to the top / bottom.
func (m *model) scrollKey(key string) {
	switch key {
	case "pgup":
		m.scrollBy(-max(m.viewH-1, 1))
	case "pgdown":
		m.scrollBy(max(m.viewH-1, 1))
	case "home":
		m.scroll = 0
	case "end":
		m.scroll = m.scrollMax
	}
}

// reveal scrolls the focused component into view (Tab, Shift+Tab, a click).
func (m *model) reveal() {
	for i := len(m.hits) - 1; i >= 0; i-- {
		h := m.hits[i]
		if h.focus != m.focus || !h.scrolls || h.opt != 0 {
			continue
		}
		top := h.y0 - m.contentY
		if top < m.scroll {
			m.scroll = top
		} else if top+h.fh > m.scroll+m.viewH {
			m.scroll = top + h.fh - m.viewH
		}
		m.scroll = min(max(m.scroll, 0), m.scrollMax)
		return
	}
}

// stripANSI removes colour sequences.
func stripANSI(s string) string {
	var b strings.Builder
	rs := []rune(s)
	for i := 0; i < len(rs); i++ {
		if rs[i] == 0x1b && i+1 < len(rs) && rs[i+1] == '[' {
			i += 2
			for i < len(rs) && (rs[i] < 0x40 || rs[i] > 0x7e) {
				i++
			}
			continue
		}
		b.WriteRune(rs[i])
	}
	return b.String()
}

// tabAt is the index of the tab drawn at column x (-1 if none).
func tabAt(labels []string, x int) int {
	pos := 0
	for i, l := range labels {
		w := lipgloss.Width(" " + l + " ")
		if x >= pos && x < pos+w {
			return i
		}
		pos += w
	}
	return -1
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

// withDialog centres a dialog on the frame (the frame grows if the dialog is bigger) and
// returns the rectangle of the dialog.
func withDialog(base, dialog string) (string, hit) {
	w := max(lipgloss.Width(base), lipgloss.Width(dialog))
	h := max(lipgloss.Height(base), lipgloss.Height(dialog))
	base = frame(base, w, h, lipgloss.Left, lipgloss.Top)
	dw, dh := lipgloss.Width(dialog), lipgloss.Height(dialog)
	x, y := (w-dw)/2, (h-dh)/2
	return overlay(base, x, y, dialog), hit{x: x, y: y, w: dw, h: dh}
}

// errorDialog lists the errors that were not shown yet.
func errorDialog(entries []ErrorEntry, total int) string {
	w := min(max(total-4, 30), 60)
	red := lipgloss.Color("#ff5555")
	lines := []string{lipgloss.NewStyle().Bold(true).Foreground(red).Render("Error")}
	for _, e := range entries[max(0, len(entries)-4):] {
		lines = append(lines, lipgloss.NewStyle().Width(w-2).Render(e.Message))
	}
	lines = append(lines, "", lipgloss.NewStyle().Faint(true).Render("Enter / Esc: close"))
	return lipgloss.NewStyle().
		Border(lipgloss.DoubleBorder()).
		BorderForeground(red).
		Padding(0, 1).
		Width(w).
		Render(strings.Join(lines, "\n"))
}

// logPanelHeight is the height of the log panel: a rule, five lines and the border.
const logPanelHeight = 8

// logPanel shows the last log lines under the UI (Ctrl+L).
func logPanel(entries []ErrorEntry, w int) string {
	w = max(w, 24)
	lines := []string{lipgloss.NewStyle().Faint(true).Render("Log (Ctrl+L hides)")}
	for _, e := range entries[max(0, len(entries)-5):] {
		lines = append(lines, clip(line(e.String()), w-2))
	}
	for len(lines) < 6 {
		lines = append(lines, "")
	}
	return lipgloss.NewStyle().Border(lipgloss.NormalBorder()).Width(w - 2).Render(strings.Join(lines, "\n"))
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

// cycle returns the option after (d = 1) or before (d = -1) cur.
func cycle(opts []string, cur string, d int) string {
	i := 0
	for k, o := range opts {
		if o == cur {
			i = k
		}
	}
	return opts[(i+d+len(opts))%len(opts)]
}

// selectCurrent is the option a select shows: its value, else the first option.
func selectCurrent(opts []string, value string) string {
	for _, o := range opts {
		if o == value {
			return value
		}
	}
	if len(opts) > 0 {
		return opts[0]
	}
	return value
}

// ratio is val/limit clamped to 0..1.
func ratio(val, limit float64) float64 {
	if limit <= 0 {
		return 0
	}
	return min(max(val/limit, 0), 1)
}

// listLines shows the design's lines (with icons and hotkeys) until the program replaces the items.
func listLines(items, labels, shown []string) []string {
	if len(items) != len(labels) {
		return items
	}
	for i := range items {
		if items[i] != labels[i] {
			return items
		}
	}
	return shown
}

// menuRows renders one line per entry and highlights the current one.
func menuRows(lines []string, cur, w int, normal, hl lipgloss.Style) string {
	out := make([]string, 0, len(lines))
	for i, l := range lines {
		st := normal
		if i == cur {
			st = hl
		}
		out = append(out, st.Width(w).Render(clip(line(l), w)))
	}
	return strings.Join(out, "\n")
}

// selectRow draws the current option of a dropdown with the arrow at the right edge.
func selectRow(cur string, w int) string {
	left, right := "  "+cur, "▼  "
	return left + strings.Repeat(" ", max(w-lipgloss.Width(left)-lipgloss.Width(right), 1)) + right
}

// tabsView renders the tab labels and a rule under them.
func tabsView(labels []string, active, w int, normal, hl lipgloss.Style) string {
	cells := make([]string, 0, len(labels))
	rule := ""
	for i, l := range labels {
		cell := " " + l + " "
		if i == active {
			cells = append(cells, hl.Render(cell))
			cw := lipgloss.Width(cell)
			rule += "╸" + strings.Repeat("━", max(cw-2, 0)) + "╺"
		} else {
			cells = append(cells, normal.Render(cell))
			rule += strings.Repeat("━", lipgloss.Width(cell))
		}
	}
	rule += strings.Repeat("━", max(0, w-lipgloss.Width(rule)))
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

// treeLabel is the label of the entry under the cursor.
func treeLabel(nodes []treeNode, open []bool, cur int) string {
	vis := treeVisible(nodes, open)
	if cur < 0 || cur >= len(vis) {
		return ""
	}
	return nodes[vis[cur]].label
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
  verification: 'run',
  multiScreen: false,
  generate: ({ ir }) => new Gen(ir.start, ir).generate(),
};

// Re-exported for the tests: how an API event is spelled in Go.
export const goEventMethod = (event: string) => apiEventMethod(event, 'pascal');
