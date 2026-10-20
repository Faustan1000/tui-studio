// Export IR: one resolved, framework-neutral description of a design.
//
// Every exporter used to read raw `ComponentNode` props and re-implement defaults, colours,
// glyphs and layout itself. The IR does that once:
//   - defaults are filled in and props are normalised (items, options, rows, ...)
//   - colours are resolved against the screen theme to hex values
//   - the editor's own layout engine is run once, so every node carries the exact position
//     and size the editor shows (`box`), next to the flex description (`layout`)
//   - what the user sees initially (`visible`) already respects hidden nodes and tab/menu bodies
// A framework exporter then only decides how each kind of node is written in its language.

import type { ComponentNode, ComponentType } from '../../types';
import { THEMES } from '../../stores/themeStore';
import { LayoutEngine } from '../layout/engine';
import { isShownByNav, navActiveIndex } from '../navBodies';
import { flattenTree } from '../treeUtils';

// ── Types ─────────────────────────────────────────────────────────────────────

export type Dim = number | 'fill' | 'auto';
export type BorderKind = 'single' | 'double' | 'rounded' | 'bold';

export interface IRBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface IRSpacing {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface IRBorder {
  kind: BorderKind;
  /** Hex colour or null for the terminal default. */
  color: string | null;
  top: boolean;
  right: boolean;
  bottom: boolean;
  left: boolean;
}

export interface IRStyle {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  border: IRBorder | null;
  /** Colours of checkbox/radio parts (hex or null). */
  checkedColor: string | null;
  uncheckedColor: string | null;
  labelColor: string | null;
}

export interface IRLayout {
  mode: 'flex' | 'grid' | 'absolute' | 'none';
  direction: 'row' | 'column';
  justify: 'start' | 'center' | 'end' | 'space-between' | 'space-around';
  align: 'start' | 'center' | 'end' | 'stretch';
  gap: number;
  wrap: boolean;
  padding: IRSpacing;
  columns: number;
  rows: number;
  columnGap: number;
  rowGap: number;
  /** Position inside an absolute parent (editor `layout.x/y`). */
  x: number;
  y: number;
}

export interface IRItem {
  label: string;
  icon: string;
  hotkey: string;
  expanded: boolean;
  /** Tabs: status dot. */
  status: boolean;
  children: IRItem[];
}

export interface IRNode {
  id: string;
  type: ComponentType;
  /** Editor name ("Primary button"). */
  name: string;
  /** Code name chosen by the user, verbatim. */
  tag?: string;
  /** A unique identifier derived from tag/name that is valid in every supported language. */
  ident: string;
  parent: IRNode | null;
  children: IRNode[];

  /** Hidden by the user (not shown at runtime either). */
  hidden: boolean;
  /** Shown when the design is opened: not hidden, and its tab/menu body is the active one. */
  visible: boolean;
  /** Body of a navigation element: shown only while `nav` has `item` selected. */
  showWhen?: { nav: string; item: number };
  /** Button: id of the screen it opens. */
  opensScreen?: string;
  events: Record<string, string>;

  width: Dim;
  height: Dim;
  layout: IRLayout;
  style: IRStyle;
  /** Position/size in whole screen cells as the editor lays it out; undefined if it is not drawn. */
  box?: IRBox;
  /** Same, relative to the parent's outer box. */
  rel?: IRBox;

  // Normalised content (empty for kinds that do not use it)
  /** Text: content, Button: label, Checkbox/Radio/Toggle: label, Modal: title, Spinner: label. */
  text: string;
  value: string;
  placeholder: string;
  checked: boolean;
  disabled: boolean;
  options: string[];
  items: IRItem[];
  selected: number;
  columns: string[];
  rows: string[][];
  progress: { value: number; max: number };
  separator: string;
  /** Glyphs for checkbox/radio (`on`/`off`). */
  glyphs: { on: string; off: string };
  textAlign: 'left' | 'center' | 'right';
  wrapText: boolean;
  /** Button decoration. */
  iconLeft: string;
  iconRight: string;

  /** Original props, for anything not normalised above. */
  props: Record<string, unknown>;
}

export interface IRScreen {
  id: string;
  name: string;
  tag?: string;
  /** Unique identifier for the screen, e.g. `settings`. */
  ident: string;
  theme: string;
  /** Design size in cells (root props, else 80x24). */
  width: number;
  height: number;
  root: IRNode;
  /** Modals of the screen: overlays that are laid over the screen content. */
  modals: IRNode[];
}

export interface IRProject {
  screens: IRScreen[];
  /** Screen shown at startup. */
  start: IRScreen;
}

export interface ScreenInput {
  id: string;
  root: ComponentNode;
}

// ── Public API ────────────────────────────────────────────────────────────────

export const DEFAULT_SCREEN_SIZE = { width: 80, height: 24 };

/** Build the IR for one or more screens (the first one is the start screen). */
export function buildIR(input: ComponentNode | readonly ScreenInput[]): IRProject {
  const given: ScreenInput[] = Array.isArray(input)
    ? [...(input as readonly ScreenInput[])]
    : [{ id: (input as ComponentNode).id, root: input as ComponentNode }];
  const usedScreenIdents = new Set<string>();
  const screens = given.map((s, i) => buildScreen(s, i, usedScreenIdents));
  return { screens, start: screens[0] };
}

/** All nodes of a screen, depth first, root first. */
export function walkIR(node: IRNode): IRNode[] {
  const out: IRNode[] = [];
  const visit = (n: IRNode) => {
    out.push(n);
    n.children.forEach(visit);
  };
  visit(node);
  return out;
}

/** Children that are initially shown. */
export function visibleChildren(node: IRNode): IRNode[] {
  return node.children.filter((c) => c.visible);
}

// ── Building ──────────────────────────────────────────────────────────────────

function buildScreen(input: ScreenInput, index: number, usedIdents: Set<string>): IRScreen {
  const root = input.root;
  const theme = typeof root.props.theme === 'string' ? root.props.theme : 'default';
  const palette =
    (THEMES as unknown as Record<string, Record<string, string>>)[theme] ??
    (THEMES.default as unknown as Record<string, string>);
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && v > 0 ? v : fallback);
  const width = num(root.props.width, DEFAULT_SCREEN_SIZE.width);
  const height = num(root.props.height, DEFAULT_SCREEN_SIZE.height);

  // The editor's own engine, in its own instance so the canvas is not disturbed.
  const engine = new LayoutEngine();
  engine.calculateLayout(root, width, height, false);

  const byId = new Map<string, ComponentNode>();
  flattenTree(root).forEach((n) => byId.set(n.id, n));

  const usedNodeIdents = new Set<string>();
  const ctx: BuildCtx = { palette, engine, byId, usedNodeIdents };
  const ir = buildNode(root, null, true, ctx);
  relativeBoxes(ir);

  const ident = uniqueIdent(
    root.tag ?? (root.name || `screen ${index + 1}`),
    'snake',
    usedIdents,
    `screen_${index + 1}`
  );
  return {
    id: input.id,
    name: root.name,
    tag: root.tag,
    ident,
    theme,
    width,
    height,
    root: ir,
    modals: walkIR(ir).filter((n) => n.type === 'Modal'),
  };
}

interface BuildCtx {
  palette: Record<string, string>;
  engine: LayoutEngine;
  byId: ReadonlyMap<string, ComponentNode>;
  usedNodeIdents: Set<string>;
}

function buildNode(
  node: ComponentNode,
  parent: IRNode | null,
  parentVisible: boolean,
  ctx: BuildCtx
): IRNode {
  const p = node.props;
  const visible = parentVisible && !node.hidden && isShownByNav(node, ctx.byId);
  const layout = ctx.engine.getLayout(node.id);

  const ir: IRNode = {
    id: node.id,
    type: node.type,
    name: node.name,
    tag: node.tag,
    ident: uniqueIdent(
      node.tag ?? (node.name || node.type),
      'snake',
      ctx.usedNodeIdents,
      node.type.toLowerCase()
    ),
    parent,
    children: [],
    hidden: !!node.hidden,
    visible,
    showWhen: node.showWhen,
    opensScreen: node.opensScreen,
    events: Object.fromEntries(
      Object.entries(node.events ?? {}).filter(([, v]) => typeof v === 'string')
    ) as Record<string, string>,
    width: dim(p.width),
    height: dim(p.height),
    layout: buildLayout(node),
    style: buildStyle(node, ctx.palette),
    // Whole cells: the editor works with fractions (centering an odd gap), a terminal cannot.
    box:
      layout && visible
        ? {
            x: Math.round(layout.x),
            y: Math.round(layout.y),
            width: Math.max(0, Math.round(layout.width)),
            height: Math.max(0, Math.round(layout.height)),
          }
        : undefined,
    text: textOf(node),
    value: str(p.value),
    placeholder: str(p.placeholder),
    checked: !!(p.checked ?? p.value === true),
    disabled: !!p.disabled,
    options: strList(p.options),
    items: itemsOf(node),
    selected: int(p.selectedIndex, 0),
    columns: strList(p.columns),
    rows: rowsOf(p.rows),
    progress: { value: num(p.value, 0), max: num(p.max, 100) || 100 },
    separator: typeof p.separator === 'string' ? p.separator : ' / ',
    glyphs: glyphsOf(node),
    textAlign: p.align === 'center' || p.align === 'right' ? p.align : 'left',
    wrapText: !!p.wrap,
    iconLeft: p.iconLeftEnabled && typeof p.iconLeft === 'string' ? p.iconLeft : '',
    iconRight: p.iconRightEnabled && typeof p.iconRight === 'string' ? p.iconRight : '',
    props: { ...p },
  };
  if (node.type === 'Tabs') ir.selected = navActiveIndex(node);
  ir.children = node.children.map((c) => buildNode(c, ir, visible, ctx));
  return ir;
}

/** `rel`: position relative to the parent's box. */
function relativeBoxes(node: IRNode): void {
  for (const c of node.children) {
    if (c.box && node.box) {
      c.rel = {
        x: c.box.x - node.box.x,
        y: c.box.y - node.box.y,
        width: c.box.width,
        height: c.box.height,
      };
    }
    relativeBoxes(c);
  }
}

function buildLayout(node: ComponentNode): IRLayout {
  const l = node.layout ?? { type: 'none' };
  const mode =
    l.type === 'flexbox'
      ? 'flex'
      : l.type === 'grid'
        ? 'grid'
        : l.type === 'absolute'
          ? 'absolute'
          : 'none';
  return {
    mode,
    direction: l.direction === 'row' ? 'row' : 'column',
    justify: (l.justify as IRLayout['justify']) ?? 'start',
    align: (l.align as IRLayout['align']) ?? 'start',
    gap: nonNeg(l.gap),
    wrap: !!l.wrap,
    padding: spacing(l.padding),
    columns: Math.max(1, int(l.columns, 1)),
    rows: Math.max(1, int(l.rows, 1)),
    columnGap: nonNeg(l.columnGap ?? l.gap),
    rowGap: nonNeg(l.rowGap ?? l.gap),
    x: int(l.x, 0),
    y: int(l.y, 0),
  };
}

function buildStyle(node: ComponentNode, palette: Record<string, string>): IRStyle {
  const s = node.style ?? {};
  const kind = (BORDER_KINDS as Record<string, BorderKind | undefined>)[s.borderStyle ?? 'single'];
  const sides = {
    top: s.borderTop !== false,
    right: s.borderRight !== false,
    bottom: s.borderBottom !== false,
    left: s.borderLeft !== false,
  };
  return {
    fg: resolveColor(s.color, palette),
    bg: resolveColor(s.backgroundColor, palette),
    bold: !!s.bold,
    italic: !!s.italic,
    underline: !!s.underline,
    strikethrough: !!s.strikethrough,
    border:
      s.border && kind ? { kind, color: resolveColor(s.borderColor, palette), ...sides } : null,
    checkedColor: resolveColor(s.checkedColor ?? s.selectedColor, palette),
    uncheckedColor: resolveColor(s.uncheckedColor ?? s.unselectedColor, palette),
    labelColor: resolveColor(s.labelColor, palette),
  };
}

const BORDER_KINDS: Record<string, BorderKind | undefined> = {
  single: 'single',
  double: 'double',
  rounded: 'rounded',
  round: 'rounded',
  bold: 'bold',
  hidden: undefined,
};

// ── Normalisers ───────────────────────────────────────────────────────────────

export function dim(v: unknown): Dim {
  if (typeof v === 'number' && v > 0) return Math.round(v);
  if (v === 'fill' || v === 'fill_container') return 'fill';
  return 'auto';
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function int(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback;
}

function nonNeg(v: unknown): number {
  return Math.max(0, int(v, 0));
}

function strList(v: unknown): string[] {
  return Array.isArray(v)
    ? v.map((x) => str(typeof x === 'object' && x ? (x as { label?: unknown }).label : x))
    : [];
}

function rowsOf(v: unknown): string[][] {
  return Array.isArray(v) ? v.map((r) => (Array.isArray(r) ? r.map(str) : [])) : [];
}

function spacing(p: unknown): IRSpacing {
  if (typeof p === 'number') {
    const n = Math.max(0, Math.round(p));
    return { top: n, right: n, bottom: n, left: n };
  }
  if (p && typeof p === 'object') {
    const o = p as Record<string, unknown>;
    return {
      top: nonNeg(o.top),
      right: nonNeg(o.right),
      bottom: nonNeg(o.bottom),
      left: nonNeg(o.left),
    };
  }
  return { top: 0, right: 0, bottom: 0, left: 0 };
}

function textOf(node: ComponentNode): string {
  const p = node.props;
  switch (node.type) {
    case 'Text':
      return str(p.content);
    case 'Modal':
      return str(p.title);
    case 'Spinner':
      return str(p.label);
    case 'Button':
    case 'Checkbox':
    case 'Radio':
    case 'Toggle':
      return str(p.label);
    default:
      return '';
  }
}

function glyphsOf(node: ComponentNode): { on: string; off: string } {
  const p = node.props;
  switch (node.type) {
    case 'Checkbox':
      return { on: str(p.checkedIcon) || '✓', off: str(p.uncheckedIcon) || ' ' };
    case 'Radio':
      return { on: str(p.selectedIcon) || '●', off: str(p.unselectedIcon) || '○' };
    case 'Toggle':
      return { on: 'ON ', off: 'OFF' };
    default:
      return { on: '', off: '' };
  }
}

function itemsOf(node: ComponentNode): IRItem[] {
  const raw = node.type === 'Tabs' ? node.props.tabs : node.props.items;
  return Array.isArray(raw) ? raw.map(toItem) : [];
}

function toItem(raw: unknown): IRItem {
  if (typeof raw === 'string') {
    return { label: raw, icon: '', hotkey: '', expanded: false, status: false, children: [] };
  }
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    label: str(o.label),
    icon: str(o.icon),
    hotkey: str(o.hotkey),
    expanded: o.expanded !== false,
    status: !!o.status,
    children: Array.isArray(o.children) ? o.children.map(toItem) : [],
  };
}

// ── Colours ───────────────────────────────────────────────────────────────────

const NAMED_FALLBACK: Record<string, string> = {
  black: '#000000',
  red: '#ff0000',
  green: '#00ff00',
  yellow: '#ffff00',
  blue: '#0000ff',
  magenta: '#ff00ff',
  cyan: '#00ffff',
  white: '#ffffff',
  gray: '#808080',
  grey: '#808080',
};

/** Resolve a colour name or hex against the screen palette to `#rrggbb`; null = terminal default. */
export function resolveColor(value: unknown, palette: Record<string, string>): string | null {
  if (typeof value !== 'string' || value === '' || value === 'default' || value === 'transparent') {
    return null;
  }
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(value)) {
    return ('#' + [...value.slice(1)].map((c) => c + c).join('')).toLowerCase();
  }
  const fromPalette = palette[value];
  if (fromPalette) return resolveColor(fromPalette, {});
  return NAMED_FALLBACK[value.toLowerCase()] ?? null;
}

// ── Identifiers ───────────────────────────────────────────────────────────────

export type IdentStyle = 'snake' | 'camel' | 'pascal';

const WORD_RE = /[A-Za-z0-9]+/g;

/** Convert any text into an identifier in the given case. Never empty, never starts with a digit. */
export function toIdent(text: string, style: IdentStyle, fallback = 'item'): string {
  const words = (text.match(WORD_RE) ?? []).map((w) => w.toLowerCase());
  let base: string;
  if (!words.length) base = fallback;
  else if (style === 'snake') base = words.join('_');
  else {
    const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
    base =
      style === 'pascal' ? words.map(cap).join('') : words[0] + words.slice(1).map(cap).join('');
  }
  return /^[0-9]/.test(base) ? (style === 'snake' ? '_' : 'n') + base : base;
}

/**
 * Words that cannot (or should not) be used as a variable name in the target languages:
 * keywords of JS/TS, Go and Rust, plus names the generated programs use themselves.
 * Identifiers that hit this list get a trailing underscore.
 */
const RESERVED_WORDS: ReadonlySet<string> = new Set(
  // JS / TS
  (
    'abstract any as async await boolean break case catch class const continue debugger declare default delete do else enum export extends false finally for from function get if implements import in instanceof interface let module namespace new null number of package private protected public readonly return set static string super switch symbol this throw true try type typeof undefined var void while with yield arguments eval ' +
    // Go
    'chan defer fallthrough func go goto map range select struct ' +
    // Rust
    'crate dyn fn loop match mod move mut pub ref self Self trait unsafe use where unit ' +
    // names of generated programs
    'main app model frame area state screen process require console math fmt os strings tea lipgloss tview tcell blessed react ink render root'
  ).split(' ')
);

function uniqueIdent(text: string, style: IdentStyle, used: Set<string>, fallback: string): string {
  let base = toIdent(text, style, fallback);
  if (RESERVED_WORDS.has(base)) base += '_';
  let candidate = base;
  for (let i = 2; used.has(candidate); i++) candidate = `${base}_${i}`;
  used.add(candidate);
  return candidate;
}

/** Re-case an IR identifier (`submit_btn` → `submitBtn` / `SubmitBtn`). */
export function recase(ident: string, style: IdentStyle): string {
  if (style === 'snake') return ident;
  const parts = ident.split('_').filter(Boolean);
  const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
  const joined =
    style === 'pascal' ? parts.map(cap).join('') : parts[0] + parts.slice(1).map(cap).join('');
  // A trailing underscore marks a reserved word (see uniqueIdent) and must survive.
  const out = ident.endsWith('_') ? `${joined}_` : joined;
  return /^[0-9]/.test(out) ? 'n' + out : out;
}

// ── Shared content helpers (the same text in every framework) ─────────────────

/** What a simple widget shows as text, e.g. `[✓] Remember me`, `(●) A`, `[ON ] Dark`. */
export function inlineText(node: IRNode): string {
  switch (node.type) {
    case 'Checkbox':
      return `[${node.checked ? node.glyphs.on : node.glyphs.off}] ${node.text}`;
    case 'Radio':
      return `(${node.checked ? node.glyphs.on : node.glyphs.off}) ${node.text}`;
    case 'Toggle':
      return `${node.checked ? '[ON ]' : '[OFF]'} ${node.text}`;
    case 'Select': {
      const current = node.value || node.options[0] || '';
      return `${current} ▾`;
    }
    case 'Spinner':
      return `⠋ ${node.text || 'Loading...'}`;
    case 'Breadcrumb':
      return node.items.map((i) => (i.icon ? `${i.icon} ` : '') + i.label).join(node.separator);
    case 'Button': {
      const left = node.iconLeft ? `${node.iconLeft} ` : '';
      const right = node.iconRight ? ` ${node.iconRight}` : '';
      return `${left}${node.text}${right}`;
    }
    case 'TextInput':
      return node.value || node.placeholder;
    default:
      return node.text;
  }
}

/** `███░░░ 30%` style bar of `width` cells. */
export function progressText(node: IRNode, width: number): string {
  const ratio = Math.max(0, Math.min(1, node.progress.value / node.progress.max));
  const filled = Math.round(ratio * width);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

/** Flatten a tree into indented lines (`▾ Root`, `  ├─ Child`). */
export function treeLines(
  items: readonly IRItem[]
): { depth: number; text: string; item: IRItem }[] {
  const lines: { depth: number; text: string; item: IRItem }[] = [];
  const walk = (list: readonly IRItem[], depth: number) => {
    for (const item of list) {
      const marker = item.children.length ? (item.expanded ? '▾ ' : '▸ ') : '';
      const icon = item.icon ? `${item.icon} ` : '';
      lines.push({ depth, text: `${'  '.repeat(depth)}${marker}${icon}${item.label}`, item });
      if (item.expanded) walk(item.children, depth + 1);
    }
  };
  walk(items, 0);
  return lines;
}

/** Label of a list/menu entry with its icon and hotkey. */
export function itemText(item: IRItem, withHotkey = true): string {
  const icon = item.icon ? `${item.icon} ` : '';
  const hotkey = withHotkey && item.hotkey ? `  ${item.hotkey}` : '';
  return `${icon}${item.label}${hotkey}`;
}

/** Kinds that hold other nodes. */
export function isContainer(node: IRNode): boolean {
  return (
    node.type === 'Screen' || node.type === 'Box' || node.type === 'Grid' || node.type === 'Modal'
  );
}

/** Whether a node is a navigation element whose bodies other nodes show/hide. */
export function isNavigation(node: IRNode): boolean {
  return node.type === 'Tabs' || node.type === 'Menu' || node.type === 'List';
}
