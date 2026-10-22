// Textual (Python) exporter.
//
// Each component type gets its own emitter in EMITTERS so elements can be added
// one at a time. Types without an emitter fall back to a generic container
// (if they have children) or a placeholder Static widget.

import type { ComponentNode, ComponentType } from '../../../types';
import { THEMES } from '../../../stores/themeStore';
import { API_SPEC } from '../api/spec';
import { bodiesOf, navActiveIndex } from '../../navBodies';
import { LayoutEngine } from '../../layout/engine';
import type { ComputedLayout } from '../../layout/types';

interface Ctx {
  /** Collected CSS rules, in document order. */
  css: string[];
  /** ANSI name -> hex for the screen's theme. */
  palette: Record<string, string>;
  /** Generated event handler methods (class body, already indented). */
  handlers: string[];
  /** Python imports needed by the generated code: module -> names. */
  imports: Map<string, Set<string>>;
  /** Statements for the generated on_mount method (widget state set after mounting). */
  mount: string[];
  /** Nesting depth of the `with` blocks being written (Python allows 20 per function). */
  depth: number;
  /** Helper compose methods for deep subtrees, written into the class being built. */
  parts: string[];
  /** Counter for the names of those helper methods (never reset, so names stay unique). */
  partSeq: number;
  /** Generated widget subclasses (module level, before the App class). */
  classes: string[];
  /** Dedupe key -> generated class name. */
  classNames: Map<string, string>;
  /** App key bindings: [key, action, description]. */
  bindings: [string, string, string][];
  /** Generated App action methods (class body, already indented). */
  actions: string[];
  /** Components with a code name: they become attributes of the generated `Ui` class. */
  handles: { tag: string; cls: string; args: string }[];
  /** Screen (or modal) that is being emitted: its key, and the root of its tree. */
  owner: string;
  root: ComponentNode;
  /** Generated screen classes (module level, after the widget classes). */
  screenClasses: string[];
  /** Project screen id -> key of its generated Screen class (its code name). */
  screenKeys: Map<string, string>;
  /**
   * Positions the editor's layout engine computes for the screen being exported. Used where
   * Textual has no equivalent (wrapping, aligning children of different sizes).
   */
  layoutOf: (id: string) => ComputedLayout | undefined;
}

/** A screen of the project: its id (used by links) and the root of its component tree. */
export interface ExportScreen {
  id: string;
  root: ComponentNode;
}

type Emitter = (node: ComponentNode, indent: number, ctx: Ctx) => string;

const IND = '    ';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Python string literal (JSON string syntax is valid Python). */
export function pyStr(s: unknown): string {
  return JSON.stringify(String(s ?? ''));
}

/** Widget id that is valid in Textual CSS (must not start with a digit). */
export function widgetId(node: ComponentNode): string {
  return node.tag ?? '_n_' + node.id.replace(/[^a-zA-Z0-9_]/g, '_');
}

/** Resolve a color name / hex into something Textual CSS understands. */
export function cssColor(value: unknown, ctx: Ctx): string | null {
  if (typeof value !== 'string' || value === '' || value === 'default') return null;
  if (/^#[0-9a-fA-F]{3,8}$/.test(value)) return value;
  if (ctx.palette[value]) return ctx.palette[value];
  if (/^[a-zA-Z]+$/.test(value)) return value.toLowerCase();
  return null;
}

const BORDER_STYLES: Record<string, string> = {
  single: 'solid',
  double: 'double',
  rounded: 'round',
  bold: 'heavy',
  hidden: 'hidden',
};

function cssSize(v: unknown): string | null {
  if (typeof v === 'number') return String(Math.round(v));
  if (v === 'fill') return '1fr';
  if (v === 'auto') return 'auto';
  return null;
}

/** Box spacing as CSS shorthand. Numbers apply to all sides (rows, columns). */
function cssSpacing(p: unknown): string | null {
  if (typeof p === 'number' && p > 0) return String(p);
  if (p && typeof p === 'object') {
    const { top = 0, right = 0, bottom = 0, left = 0 } = p as Record<string, number>;
    if (top || right || bottom || left) return `${top} ${right} ${bottom} ${left}`;
  }
  return null;
}

function borderDeclaration(node: ComponentNode, ctx: Ctx): string | null {
  if (!node.style.border) return null;
  const kind = BORDER_STYLES[node.style.borderStyle ?? 'single'] ?? 'solid';
  const color = cssColor(node.style.borderColor, ctx);
  return `border: ${kind}${color ? ' ' + color : ''};`;
}

/** Components whose height the editor's layout engine always takes from their content. */
const SINGLE_LINE_TYPES: ReadonlySet<string> = new Set([
  'Button',
  'TextInput',
  'Checkbox',
  'Radio',
  'Toggle',
  'Select',
  'Spinner',
  'ProgressBar',
  'Text',
  'Breadcrumb',
]);

/** CSS declarations shared by all components (size, colors, border). */
function commonDeclarations(node: ComponentNode, ctx: Ctx): string[] {
  const d: string[] = [];
  const w = cssSize(node.props.width);
  // The editor gives these a one-line (or bordered) natural height unless it is a number.
  const h =
    SINGLE_LINE_TYPES.has(node.type) && typeof node.props.height !== 'number'
      ? null
      : cssSize(node.props.height);
  if (w) d.push(`width: ${w};`);
  if (h) d.push(`height: ${h};`);
  if (typeof node.props.minWidth === 'number') d.push(`min-width: ${node.props.minWidth};`);
  if (typeof node.props.maxWidth === 'number') d.push(`max-width: ${node.props.maxWidth};`);
  if (typeof node.props.minHeight === 'number') d.push(`min-height: ${node.props.minHeight};`);
  if (typeof node.props.maxHeight === 'number') d.push(`max-height: ${node.props.maxHeight};`);

  const fg = cssColor(node.style.color, ctx);
  const bg = cssColor(node.style.backgroundColor, ctx);
  if (fg) d.push(`color: ${fg};`);
  if (bg) d.push(`background: ${bg};`);
  const textStyle = [
    node.style.bold && 'bold',
    node.style.italic && 'italic',
    node.style.underline && 'underline',
    node.style.strikethrough && 'strike',
  ].filter(Boolean);
  if (textStyle.length) d.push(`text-style: ${textStyle.join(' ')};`);

  const border = borderDeclaration(node, ctx);
  if (border) d.push(border);
  const padding = cssSpacing(node.layout.padding);
  if (padding) d.push(`padding: ${padding};`);
  const margin = cssSpacing(node.layout.margin);
  if (margin) d.push(`margin: ${margin};`);
  if (node.hidden) d.push('display: none;');
  return d;
}

/** Turn an editor handler name (e.g. "handleChange") into a unique Python method name. */
function methodName(raw: string, ctx: Ctx): string {
  const base =
    raw
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/[^a-zA-Z0-9_]/g, '_')
      .toLowerCase()
      .replace(/^(\d)/, '_$1') || 'handler';
  const used = new Set(ctx.handlers.map((h) => /def (\w+)\(/.exec(h)?.[1]));
  let name = base;
  for (let i = 2; used.has(name); i++) name = `${base}_${i}`;
  return name;
}

/** How a Textual message is reported to the program through `Ui._emit`. */
const EVENT_API: Record<string, { name: string; value?: string }> = {
  'Button.Pressed': { name: 'click' },
  'Input.Changed': { name: 'change', value: 'event.value' },
  'Input.Submitted': { name: 'submit', value: 'event.value' },
  'Checkbox.Changed': { name: 'change', value: 'event.value' },
  'RadioButton.Changed': { name: 'change', value: 'event.value' },
  'Switch.Changed': { name: 'change', value: 'event.value' },
  'Select.Changed': {
    name: 'change',
    value: 'None if event.value == Select.BLANK else event.value',
  },
  'ListView.Selected': { name: 'select', value: 'event.list_view.index' },
  'OptionList.OptionSelected': { name: 'select', value: 'event.option_index' },
  'Tabs.TabActivated': { name: 'change', value: 'int(event.tab.id.rsplit("__", 1)[-1])' },
  'Tree.NodeSelected': { name: 'select', value: 'str(event.node.label)' },
};

/** Selected item of a navigation message, used to switch the bodies of that item. */
const NAV_INDEX: Record<string, string> = {
  'Tabs.TabActivated': 'int(event.tab.id.rsplit("__", 1)[-1])',
  'OptionList.OptionHighlighted': 'event.option_index',
  'ListView.Highlighted': 'event.list_view.index',
};

/**
 * Register a Textual message handler bound to one widget. For components with a code name
 * it forwards the interaction to the program (`ui.<tag>.on_<event>`); others stay stubs.
 * `bodies` (a Python dict literal) makes the handler show the body of the selected item.
 */
function addHandler(
  ctx: Ctx,
  node: ComponentNode,
  message: string,
  rawName: unknown,
  fallback: string,
  bodies?: string | null,
  after: string[] = []
) {
  const name = methodName(typeof rawName === 'string' && rawName ? rawName : fallback, ctx);
  const api = EVENT_API[message];
  const lines: string[] = [];
  if (bodies && NAV_INDEX[message]) {
    lines.push(`self.show_bodies(${bodies}, ${NAV_INDEX[message]})`);
  }
  if (node.tag && api) {
    lines.push(
      `self.ui._emit(${pyStr(node.tag)}, ${pyStr(api.name)}${api.value ? ', ' + api.value : ''})`
    );
  }
  // Screen links run last, so the program hears about the interaction before the switch.
  lines.push(...after);
  if (lines.length === 0) lines.push('pass');
  ctx.handlers.push(
    `${IND}@on(${message}, "#${widgetId(node)}")\n` +
      `${IND}def ${name}(self, event: ${message}) -> None:\n` +
      lines.map((l) => `${IND}${IND}${l}\n`).join('')
  );
  needImport(ctx, 'textual', 'on');
}

/** Statements that open the screen a button links to (none when it links nowhere). */
function buttonLink(node: ComponentNode, ctx: Ctx): string[] {
  const key = node.opensScreen ? ctx.screenKeys.get(node.opensScreen) : undefined;
  return key ? [`self.ui.show_screen(${pyStr(key)})`] : [];
}

/**
 * Statements for the items of a Menu/List that open a screen, picked by the index of the
 * chosen item (none when no item links anywhere).
 */
function itemLinks(node: ComponentNode, ctx: Ctx, indexExpr: string): string[] {
  const items = Array.isArray(node.props.items) ? node.props.items : [];
  const targets: string[] = [];
  items.forEach((item, i) => {
    const screen = item && typeof item === 'object' ? (item as { screen?: string }).screen : '';
    const key = screen ? ctx.screenKeys.get(screen) : undefined;
    if (key) targets.push(`${i}: ${pyStr(key)}`);
  });
  if (targets.length === 0) return [];
  return [
    `target = {${targets.join(', ')}}.get(${indexExpr})`,
    'if target:',
    `${IND}self.ui.show_screen(target)`,
  ];
}

/** Widget that is shown/hidden to show/hide `node` (a toggle's label belongs to its group). */
function bodyWidgetId(node: ComponentNode): string {
  const id = widgetId(node);
  return node.type === 'Toggle' && node.props.label ? `${id}__group` : id;
}

/**
 * Bodies of a navigation element as a Python dict `{item: [widget ids]}`, or null when it has
 * none. Bodies of items that are not selected at the start are hidden by CSS.
 */
function bodyGroups(nav: ComponentNode, ctx: Ctx): string | null {
  const groups = bodiesOf(ctx.root, nav.id);
  for (const [item, nodes] of groups) {
    for (const body of nodes) {
      if (item !== navActiveIndex(nav)) {
        ctx.css.push(`#${bodyWidgetId(body)} {\n    display: none;\n}`);
      }
    }
  }
  if (groups.size === 0) return null;
  const entries = [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([item, nodes]) => `${item}: [${nodes.map((n) => pyStr(bodyWidgetId(n))).join(', ')}]`);
  return `{${entries.join(', ')}}`;
}

/** Record a Python import so only what the generated code uses is imported. */
function needImport(ctx: Ctx, module: string, name: string) {
  if (!ctx.imports.has(module)) ctx.imports.set(module, new Set());
  ctx.imports.get(module)!.add(name);
}

function renderImports(ctx: Ctx): string {
  return [...ctx.imports.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([module, names]) => `from ${module} import ${[...names].sort().join(', ')}`)
    .join('\n');
}

function addRule(ctx: Ctx, node: ComponentNode, declarations: string[]) {
  if (declarations.length === 0) return;
  ctx.css.push(`#${widgetId(node)} {\n${declarations.map((l) => `    ${l}`).join('\n')}\n}`);
}

// ── Emitters ──────────────────────────────────────────────────────────────────

// ── How containers arrange their children ─────────────────────────────────────

interface FlexPlan {
  horizontal: boolean;
  gap: number;
  justify: string;
  align: string;
}

/**
 * Arrangement of a container's children, following the editor's layout engine: a flexbox
 * defaults to a row, "none" stacks vertically with one empty line in between.
 */
function flexPlan(node: ComponentNode): FlexPlan {
  const l = node.layout;
  if (l.type === 'flexbox') {
    return {
      horizontal: (l.direction ?? 'row') === 'row',
      gap: typeof l.gap === 'number' ? l.gap : 0,
      justify: String(l.justify ?? 'start'),
      align: String(l.align ?? 'start'),
    };
  }
  return { horizontal: false, gap: l.type === 'none' ? 1 : 0, justify: 'start', align: 'start' };
}

/** Only a container with a fixed size along its main axis has free space to distribute. */
function hasFreeSpace(node: ComponentNode, ctx: Ctx, horizontal: boolean): boolean {
  if (node === ctx.root) return true; // a screen fills the terminal
  const size = horizontal ? node.props.width : node.props.height;
  return typeof size === 'number' || size === 'fill';
}

/** "space-between" / "space-around" need free space; the editor ignores them otherwise. */
function spreadMode(node: ComponentNode, ctx: Ctx): 'between' | 'around' | null {
  if (node.layout.type !== 'flexbox' || isWrap(node)) return null;
  const { horizontal, justify } = flexPlan(node);
  if (justify !== 'space-between' && justify !== 'space-around') return null;
  if (!hasFreeSpace(node, ctx, horizontal)) return null;
  return justify === 'space-between' ? 'between' : 'around';
}

/**
 * Cross-axis alignment of every child by its own margin. This is exact when the container
 * and all children have a fixed cross size; otherwise the group alignment of Textual is used
 * (which is only exact when the children are equally large).
 */
function alignByMargin(node: ComponentNode, ctx: Ctx): boolean {
  if (node.layout.type !== 'flexbox' || isWrap(node) || node === ctx.root) return false;
  const { horizontal, align } = flexPlan(node);
  if (align !== 'center' && align !== 'end') return false;
  // A container that follows the terminal size cannot be placed from the editor's size.
  const size = node.props[horizontal ? 'height' : 'width'];
  if (typeof size !== 'number' && size !== 'auto' && size !== undefined) return false;
  if (!ctx.layoutOf(node.id)) return false;
  // Bodies of other tabs have no position; they are hidden anyway.
  const kids = node.children.filter(
    (c) => c.type !== 'Modal' && !(c.showWhen && !ctx.layoutOf(c.id))
  );
  return kids.length > 0 && kids.every((c) => c.type !== 'Radio' && ctx.layoutOf(c.id));
}

/** A flexbox that wraps: Textual cannot, so its children are placed from the editor's layout. */
function isWrap(node: ComponentNode): boolean {
  return node.layout.type === 'flexbox' && node.layout.wrap === true;
}

/**
 * Place a child exactly where the editor's layout engine put it, inside its container.
 * Offsets count from inside the border and padding of the container.
 */
function snapshotRule(
  child: ComponentNode,
  parent: ComponentNode,
  widgetIdOfChild: string,
  ctx: Ctx
) {
  const lk = ctx.layoutOf(child.id);
  const lc = ctx.layoutOf(parent.id);
  if (!lk || !lc) return;
  const pad = typeof parent.layout.padding === 'number' ? parent.layout.padding : 0;
  const border = parent.style.border ? 1 : 0;
  const x = Math.floor(lk.x - lc.x - pad - border);
  const y = Math.floor(lk.y - lc.y - pad - border);
  const lines = [
    'position: absolute;',
    `offset: ${x} ${y};`,
    `width: ${Math.round(lk.width)};`,
    `height: ${Math.round(lk.height)};`,
  ];
  ctx.css.push(`#${widgetIdOfChild} {\n${lines.map((l) => `    ${l}`).join('\n')}\n}`);
}

/** Selector id of the widget that holds a node's children (a screen is a widget with its key). */
function containerId(node: ComponentNode, ctx: Ctx): string {
  return node === ctx.root ? ctx.owner : widgetId(node);
}

/**
 * Declarations for the container itself (alignment of its children) plus the CSS rules for
 * the gap between children and for the flexible spacers used by space-between/around.
 * Textual has no `gap`, so the gap becomes a margin on every child but the last.
 */
function flexDeclarations(node: ComponentNode, ctx: Ctx): string[] {
  if (node.layout.type !== 'flexbox' && node.layout.type !== 'none') return [];
  if (isWrap(node)) return []; // the children are placed one by one (see snapshotRule)
  const { horizontal, gap, justify, align } = flexPlan(node);
  const selector = `#${containerId(node, ctx)}`;
  const decl: string[] = [];

  // Textual aligns the whole group of children, not each child on its own.
  const axisValue = (onHorizontalAxis: boolean, v: string) =>
    v === 'center'
      ? onHorizontalAxis
        ? 'center'
        : 'middle'
      : onHorizontalAxis
        ? 'right'
        : 'bottom';
  if (justify === 'center' || justify === 'end') {
    decl.push(
      `${horizontal ? 'align-horizontal' : 'align-vertical'}: ${axisValue(horizontal, justify)};`
    );
  }
  if ((align === 'center' || align === 'end') && !alignByMargin(node, ctx)) {
    decl.push(
      `${horizontal ? 'align-vertical' : 'align-horizontal'}: ${axisValue(!horizontal, align)};`
    );
  }

  const spread = spreadMode(node, ctx);
  if (gap > 0 && !spread && !alignByMargin(node, ctx)) {
    const side = horizontal ? 'margin-right' : 'margin-bottom';
    ctx.css.push(`${selector} > * {\n    ${side}: ${gap};\n}`);
    ctx.css.push(`${selector} > *:last-child {\n    ${side}: 0;\n}`);
    ctx.css.push(`${selector} > LogPanel {\n    margin: 0;\n}`);
  }
  if (spread) {
    const along = horizontal ? 'width' : 'height';
    const across = horizontal ? 'height' : 'width';
    ctx.css.push(`${selector} > ._sp1 {\n    ${along}: 1fr;\n    ${across}: 1;\n}`);
    ctx.css.push(`${selector} > ._sp2 {\n    ${along}: 2fr;\n    ${across}: 1;\n}`);
  }
  return decl;
}

/** Widget that a child contributes to its parent (the group for radios and labelled toggles). */
function topWidgetId(child: ComponentNode): string {
  return bodyWidgetId(child);
}

/**
 * Place a child at its x/y of an absolute layout. Textual measures offsets from inside the
 * container's border and padding, the editor from its outer edge plus (numeric) padding.
 */
function absoluteRule(
  child: ComponentNode,
  parent: ComponentNode,
  widgetIdOfChild: string,
  ctx: Ctx
) {
  const pad = typeof parent.layout.padding === 'number' ? parent.layout.padding : 0;
  const border = parent.style.border ? 1 : 0;
  const cssPad = (side: 'left' | 'top') => {
    const p = parent.layout.padding;
    if (typeof p === 'number') return p;
    return p && typeof p === 'object' ? ((p as Record<string, number>)[side] ?? 0) : 0;
  };
  const x =
    (typeof child.layout.x === 'number' ? child.layout.x : 0) + pad - border - cssPad('left');
  const y =
    (typeof child.layout.y === 'number' ? child.layout.y : 0) + pad - border - cssPad('top');
  const lines = ['position: absolute;', `offset: ${x} ${y};`];
  if (child.props.width === 'fill') lines.push('width: 100%;');
  if (child.props.height === 'fill') lines.push('height: 100%;');
  ctx.css.push(`#${widgetIdOfChild} {\n${lines.map((l) => `    ${l}`).join('\n')}\n}`);
}

function emitChildren(node: ComponentNode, indent: number, ctx: Ctx): string {
  const plan = flexPlan(node);
  const sp = IND.repeat(indent);
  const units: { code: string; top: string; node: ComponentNode }[] = [];
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child.type === 'Radio') {
      const group = [child];
      while (node.children[i + 1]?.type === 'Radio') group.push(node.children[++i]);
      const code = emitRadioGroup(group, plan.horizontal, indent, ctx);
      units.push({ code, top: `${widgetId(group[0])}__group`, node: group[0] });
    } else {
      units.push({ code: emitNode(child, indent, ctx), top: topWidgetId(child), node: child });
    }
  }
  // Modals produce no widget in place.
  const shown = units.filter((u) => u.code);

  if (node.layout.type === 'absolute') {
    shown.forEach((u) => absoluteRule(u.node, node, u.top, ctx));
  }

  if (isWrap(node)) {
    shown.forEach((u) => snapshotRule(u.node, node, u.top, ctx));
  }

  if (alignByMargin(node, ctx)) {
    // Align every child by its own margin, from the position the editor gives it. Offsets
    // count from inside the container's border and padding.
    const lc = ctx.layoutOf(node.id)!;
    const pad = typeof node.layout.padding === 'number' ? node.layout.padding : 0;
    const border = node.style.border ? 1 : 0;
    const crossProp = plan.horizontal ? 'height' : 'width';
    // Textual keeps one margin per widget (a second rule replaces it), so the gap to the
    // next child has to be part of the same declaration.
    const gap = spreadMode(node, ctx) ? 0 : plan.gap;
    const placed = shown.filter((u) => ctx.layoutOf(u.node.id));
    placed.forEach((u, i) => {
      const lk = ctx.layoutOf(u.node.id)!;
      const offset = plan.horizontal ? lk.y - lc.y : lk.x - lc.x;
      const align = Math.max(0, Math.floor(offset - pad - border));
      const after = i < placed.length - 1 ? gap : 0;
      // margin: top right bottom left
      const margin = plan.horizontal ? `${align} ${after} 0 0` : `0 0 ${after} ${align}`;
      const lines = [`margin: ${margin};`];
      // Without a fixed size the child must have the size the editor computed for it.
      if (typeof u.node.props[crossProp] !== 'number') {
        lines.push(`${crossProp}: ${Math.round(plan.horizontal ? lk.height : lk.width)};`);
      }
      ctx.css.push(`#${u.top} {\n${lines.map((l) => `    ${l}`).join('\n')}\n}`);
    });
  }

  const spread = spreadMode(node, ctx);
  if (!spread || shown.length === 0) return shown.map((u) => u.code).join('');
  needImport(ctx, 'textual.widgets', 'Static');
  const spacer = (weight: 0 | 1 | 2) => `${sp}yield Static("", classes="_sp${weight}")\n`;
  let out = spread === 'around' ? spacer(1) : '';
  shown.forEach((u, i) => {
    out += u.code;
    if (i < shown.length - 1) out += spacer(spread === 'around' ? 2 : 1);
  });
  out += spread === 'around' ? spacer(1) : '';
  // The editor takes the gaps out of the free space but does not add them between the items,
  // so they end up after the last one.
  const trailing = plan.gap * (shown.length - 1);
  if (trailing > 0) {
    const along = plan.horizontal ? 'width' : 'height';
    const across = plan.horizontal ? 'height' : 'width';
    ctx.css.push(
      `#${containerId(node, ctx)} > ._sp0 {\n    ${along}: ${trailing};\n    ${across}: 1;\n}`
    );
    out += spacer(0);
  }
  return out;
}

/** Python allows 20 nested blocks per function; deeper subtrees move into their own method. */
const MAX_NESTING = 12;

/** Children of a container, written inside its `with` block (`indent` = the block's indent). */
function nestedBody(node: ComponentNode, indent: number, ctx: Ctx): string {
  const sp = IND.repeat(indent + 1);
  if (ctx.depth < MAX_NESTING) {
    ctx.depth++;
    const body = emitChildren(node, indent + 1, ctx);
    ctx.depth--;
    return body || `${sp}pass\n`;
  }
  const name = `_part_${++ctx.partSeq}`;
  const outer = ctx.depth;
  ctx.depth = 0;
  const inner = emitChildren(node, 2, ctx);
  ctx.depth = outer;
  ctx.parts.push(
    `${IND}def ${name}(self) -> ComposeResult:\n` +
      (inner || `${IND}${IND}return\n${IND}${IND}yield\n`)
  );
  return `${sp}yield from self.${name}()\n`;
}

/** Container used for Box (and as the generic container fallback). */
const emitBox: Emitter = (node, indent, ctx) => {
  // A box laid out as a grid is a Textual grid.
  if (node.layout.type === 'grid') return emitGrid(node, indent, ctx);

  const sp = IND.repeat(indent);
  const widget = flexPlan(node).horizontal ? 'Horizontal' : 'Vertical';
  needImport(ctx, 'textual.containers', widget);

  const decl = commonDeclarations(node, ctx);
  // Textual containers default to 1fr; stay content-sized unless a size is set.
  if (!cssSize(node.props.width)) decl.unshift('width: auto;');
  if (!cssSize(node.props.height)) decl.unshift('height: auto;');
  decl.push(...flexDeclarations(node, ctx));
  const own = isWrap(node) ? ctx.layoutOf(node.id) : undefined;
  if (own) {
    // All children are placed absolutely, so the container needs the size the editor gives it.
    for (const [prop, value] of [
      ['width', own.width],
      ['height', own.height],
    ] as const) {
      const at = decl.indexOf(`${prop}: auto;`);
      if (at >= 0) decl.splice(at, 1, `${prop}: ${Math.round(value)};`);
    }
  }
  addRule(ctx, node, decl);

  const body = nestedBody(node, indent, ctx);
  return `${sp}with ${widget}(id=${pyStr(widgetId(node))}):\n${body}`;
};

/** Text label. Static fills the width by default, so size to content unless set. */
const emitText: Emitter = (node, indent, ctx) => {
  const decl = commonDeclarations(node, ctx);
  if (!cssSize(node.props.width)) decl.unshift('width: auto;');
  const align = node.props.align;
  if (align === 'center' || align === 'right') decl.push(`text-align: ${align};`);
  addRule(ctx, node, decl);
  needImport(ctx, 'textual.widgets', 'Static');
  const content = pyStr(node.props.content ?? '');
  return `${IND.repeat(indent)}yield Static(${content}, markup=False, id=${pyStr(widgetId(node))})\n`;
};

/** Empty space of a fixed size (or flexible with 'fill'). */
const emitSpacer: Emitter = (node, indent, ctx) => {
  const decl = commonDeclarations(node, ctx).filter(
    (l) => !l.startsWith('width:') && !l.startsWith('height:')
  );
  decl.unshift(`height: ${cssSize(node.props.height) ?? '1'};`);
  decl.unshift(`width: ${cssSize(node.props.width) ?? '1'};`);
  addRule(ctx, node, decl);
  needImport(ctx, 'textual.widgets', 'Static');
  return `${IND.repeat(indent)}yield Static("", id=${pyStr(widgetId(node))})\n`;
};

/** Single-line input. Textual's Input has a built-in border, so reset it when unbordered. */
const emitTextInput: Emitter = (node, indent, ctx) => {
  const decl = commonDeclarations(node, ctx);
  if (!node.style.border) decl.unshift('border: none;', 'height: 1;');
  addRule(ctx, node, decl);

  const args: string[] = [];
  if (node.props.value) args.push(`value=${pyStr(node.props.value)}`);
  args.push(`placeholder=${pyStr(node.props.placeholder ?? '')}`);
  if (node.props.disabled) args.push('disabled=True');
  args.push(`id=${pyStr(widgetId(node))}`);

  needImport(ctx, 'textual.widgets', 'Input');
  addHandler(ctx, node, 'Input.Changed', node.events.onChange, 'on_input_changed');
  if (node.tag) addHandler(ctx, node, 'Input.Submitted', undefined, 'on_input_submitted');
  return `${IND.repeat(indent)}yield Input(${args.join(', ')})\n`;
};

/**
 * Button. The label combines the optional left/right icons; a "separated" icon
 * (with optional number) gets a "│" divider since Textual cannot draw a split border.
 */
const emitButton: Emitter = (node, indent, ctx) => {
  const p = node.props;
  const iconLeft = p.iconLeftEnabled && p.iconLeft ? String(p.iconLeft) : '';
  const iconRight = p.iconRightEnabled && p.iconRight ? String(p.iconRight) : '';
  const label = String(p.label ?? 'Button');

  let text: string;
  if (p.separated && iconLeft) {
    const left = typeof p.number === 'number' ? `${iconLeft} ${p.number}` : iconLeft;
    text = `${left} │ ${label}${iconRight ? ' ' + iconRight : ''}`;
  } else {
    text = `${iconLeft ? iconLeft + ' ' : ''}${label}${iconRight ? ' ' + iconRight : ''}`;
  }

  // Textual's Button is 3 rows tall with its own padding; the editor's padding
  // is only the space around the label, so replace it.
  const decl = commonDeclarations(node, ctx).filter((l) => !l.startsWith('padding:'));
  if (node.style.border) {
    decl.push('padding: 0 1;');
  } else {
    // Without a border the button is a single line of text.
    const fixedHeight = decl.some((l) => l.startsWith('height:') && l !== 'height: auto;');
    decl.splice(0, decl.length, ...decl.filter((l) => l !== 'height: auto;'));
    decl.unshift('border: none;', 'min-width: 0;', 'padding: 0 1;');
    if (!fixedHeight) decl.unshift('height: 1;');
  }
  addRule(ctx, node, decl);

  needImport(ctx, 'textual.widgets', 'Button');
  addHandler(
    ctx,
    node,
    'Button.Pressed',
    node.events.onClick,
    'on_button_pressed',
    undefined,
    buttonLink(node, ctx)
  );

  const args = [
    // Button labels are Rich markup: escape "[" so user text is shown literally.
    pyStr(text.replace(/\[/g, '\\[')),
  ];
  if (p.disabled) args.push('disabled=True');
  args.push(`id=${pyStr(widgetId(node))}`);
  return `${IND.repeat(indent)}yield Button(${args.join(', ')})\n`;
};

/** Rich markup in labels: escape "[" so user text is shown literally. */
function escapeMarkup(s: string): string {
  return s.replace(/\[/g, '\\[');
}

/**
 * Register (once per distinct look) a subclass of a Textual toggle widget with custom
 * glyphs, and return its class name.
 */
function toggleClass(
  ctx: Ctx,
  base: 'Checkbox' | 'RadioButton',
  glyphs: { left: string; inner: string; right: string }
): string {
  const key = `${base}|${glyphs.left}|${glyphs.inner}|${glyphs.right}`;
  let name = ctx.classNames.get(key);
  if (!name) {
    const count = [...ctx.classNames.keys()].filter((k) => k.startsWith(base + '|')).length;
    name = `Studio${base}${count ? count + 1 : ''}`;
    ctx.classNames.set(key, name);
    ctx.classes.push(
      `class ${name}(${base}):\n` +
        `${IND}BUTTON_LEFT = ${pyStr(glyphs.left)}\n` +
        `${IND}BUTTON_INNER = ${pyStr(glyphs.inner)}\n` +
        `${IND}BUTTON_RIGHT = ${pyStr(glyphs.right)}\n`
    );
  }
  return name;
}

/**
 * Shared emitter for Checkbox and RadioButton (both are Textual ToggleButtons).
 * Rendered like the editor ("[✓] Label" / "(●) Label") by replacing Textual's glyphs via a
 * subclass. Textual always draws the inner glyph (dimmed when off), so a custom "off"
 * icon cannot be shown exactly.
 */
function emitToggle(
  node: ComponentNode,
  indent: number,
  ctx: Ctx,
  kind: {
    base: 'Checkbox' | 'RadioButton';
    brackets: [string, string];
    onIcon: string;
    onColor: string;
    offColor: string;
    message: string;
    handlerFallback: string;
    defaultLabel: string;
  }
): string {
  const p = node.props;
  const showBrackets = p.showBrackets !== false;
  const cls = toggleClass(ctx, kind.base, {
    left: showBrackets ? kind.brackets[0] : '',
    inner: kind.onIcon,
    right: showBrackets ? kind.brackets[1] : '',
  });
  needImport(ctx, 'textual.widgets', kind.base);

  // Single-line, borderless unless the user added a border.
  const labelColor = cssColor(node.style.labelColor, ctx);
  let decl = commonDeclarations(node, ctx);
  if (labelColor)
    decl = decl.filter((l) => !l.startsWith('color:')).concat(`color: ${labelColor};`);
  if (!node.style.border) decl.unshift('border: none;', 'height: auto;', 'padding: 0;');
  addRule(ctx, node, decl);

  const id = widgetId(node);
  const on = cssColor(kind.onColor, ctx);
  const off = cssColor(kind.offColor, ctx);
  if (off) ctx.css.push(`#${id} > .toggle--button {\n    color: ${off};\n}`);
  if (on) ctx.css.push(`#${id}.-on > .toggle--button {\n    color: ${on};\n}`);

  const args = [pyStr(escapeMarkup(String(p.label ?? kind.defaultLabel)))];
  if (p.checked) args.push('value=True');
  if (p.disabled) args.push('disabled=True');
  args.push(`id=${pyStr(id)}`);

  addHandler(ctx, node, kind.message, node.events.onChange, kind.handlerFallback);
  return `${IND.repeat(indent)}yield ${cls}(${args.join(', ')})\n`;
}

const emitCheckbox: Emitter = (node, indent, ctx) =>
  emitToggle(node, indent, ctx, {
    base: 'Checkbox',
    brackets: ['[', ']'],
    onIcon: String(node.props.checkedIcon || '✓'),
    onColor: String(node.style.checkedColor ?? 'green'),
    offColor: String(node.style.uncheckedColor ?? 'white'),
    message: 'Checkbox.Changed',
    handlerFallback: 'on_checkbox_changed',
    defaultLabel: 'Checkbox',
  });

/** A single radio button; emitChildren wraps consecutive radios in a RadioSet. */
const emitRadio: Emitter = (node, indent, ctx) =>
  emitToggle(node, indent, ctx, {
    base: 'RadioButton',
    brackets: ['(', ')'],
    onIcon: String(node.props.selectedIcon || '●'),
    onColor: String(node.style.selectedColor ?? 'green'),
    offColor: String(node.style.unselectedColor ?? 'white'),
    message: 'RadioButton.Changed',
    handlerFallback: 'on_radio_changed',
    defaultLabel: 'Option',
  });

/**
 * Radios are mutually exclusive only inside a RadioSet, so consecutive sibling radios
 * are grouped into one. The set's own border/background are reset to stay flat.
 */
function emitRadioGroup(
  radios: ComponentNode[],
  horizontal: boolean,
  indent: number,
  ctx: Ctx
): string {
  const sp = IND.repeat(indent);
  const id = `${widgetId(radios[0])}__group`;
  const decl = ['border: none;', 'padding: 0;', 'background: transparent;', 'width: auto;'];
  if (horizontal) decl.push('layout: horizontal;');
  ctx.css.push(`#${id} {\n${decl.map((l) => `    ${l}`).join('\n')}\n}`);
  needImport(ctx, 'textual.widgets', 'RadioSet');
  const body = radios
    .map((r) => {
      registerApi(r, ctx);
      return emitRadio(r, indent + 1, ctx);
    })
    .join('');
  return `${sp}with RadioSet(id=${pyStr(id)}):\n${body}`;
}

/**
 * Dropdown. Textual's Select keeps its border/colors on the inner SelectCurrent, so
 * visual declarations go there and sizing stays on the Select itself.
 */
const emitSelect: Emitter = (node, indent, ctx) => {
  const p = node.props;
  const options = (Array.isArray(p.options) ? p.options : []).map((o) => String(o));
  const id = widgetId(node);

  const inner: string[] = [];
  const outer: string[] = [];
  for (const line of commonDeclarations(node, ctx)) {
    (/^(color|background|text-style|border):/.test(line) ? inner : outer).push(line);
  }
  if (!node.style.border) inner.unshift('border: none;');
  if (!cssSize(p.width)) outer.unshift('width: auto;');
  if (outer.length) addRule(ctx, node, outer);
  if (inner.length) {
    ctx.css.push(`#${id} > SelectCurrent {\n${inner.map((l) => `    ${l}`).join('\n')}\n}`);
  }

  needImport(ctx, 'textual.widgets', 'Select');
  const pairs = options.map((o) => `(${pyStr(escapeMarkup(o))}, ${pyStr(o)})`);
  const selected = options.includes(String(p.value ?? '')) ? String(p.value) : options[0];
  const args = [`[${pairs.join(', ')}]`];
  if (selected !== undefined) args.push('allow_blank=False', `value=${pyStr(selected)}`);
  else args.push('prompt="Select"');
  if (p.disabled) args.push('disabled=True');
  args.push(`id=${pyStr(id)}`);

  addHandler(ctx, node, 'Select.Changed', node.events.onChange, 'on_select_changed');
  return `${IND.repeat(indent)}yield Select(${args.join(', ')})\n`;
};

/**
 * Toggle switch. Textual's Switch has no label, so it is paired with a Label inside a
 * Horizontal. Border goes to the Switch, text color/style to the Label, the rest to the group.
 */
const emitToggleSwitch: Emitter = (node, indent, ctx) => {
  const p = node.props;
  const sp = IND.repeat(indent);
  const id = widgetId(node);
  const label = String(p.label ?? '');
  const on = Boolean(p.checked ?? p.value);

  const group: string[] = [];
  const text: string[] = [];
  const sw: string[] = [];
  for (const line of commonDeclarations(node, ctx)) {
    if (/^(color|text-style):/.test(line)) text.push(line);
    else if (line.startsWith('border:')) sw.push(line);
    else group.push(line);
  }
  if (!node.style.border) sw.unshift('border: none;');
  needImport(ctx, 'textual.widgets', 'Switch');

  const args = [];
  if (on) args.push('value=True');
  if (p.disabled) args.push('disabled=True');
  args.push(`id=${pyStr(id)}`);
  addHandler(ctx, node, 'Switch.Changed', node.events.onChange, 'on_switch_changed');

  const rule = (selector: string, lines: string[]) => {
    if (lines.length) ctx.css.push(`${selector} {\n${lines.map((l) => `    ${l}`).join('\n')}\n}`);
  };

  if (!label) {
    rule(`#${id}`, [...group, ...sw]);
    return `${sp}yield Switch(${args.join(', ')})\n`;
  }

  // Bordered switches are 3 rows tall; center the label vertically against them.
  const labelLines = ['margin-left: 1;', ...text];
  labelLines.unshift(node.style.border ? 'height: 3;' : 'height: 1;');
  if (node.style.border) labelLines.push('content-align: left middle;');
  rule(`#${id}__group`, [
    ...(cssSize(p.width) ? [] : ['width: auto;']),
    ...(cssSize(p.height) ? [] : ['height: auto;']),
    ...group,
  ]);
  rule(`#${id}`, sw);
  rule(`#${id}__label`, labelLines);

  needImport(ctx, 'textual.containers', 'Horizontal');
  needImport(ctx, 'textual.widgets', 'Label');
  return (
    `${sp}with Horizontal(id=${pyStr(id + '__group')}):\n` +
    `${sp}${IND}yield Switch(${args.join(', ')})\n` +
    `${sp}${IND}yield Label(${pyStr(escapeMarkup(label))}, id=${pyStr(id + '__label')})\n`
  );
};

/**
 * Progress bar: value/max shown as bar + percentage like the editor. Textual only accepts
 * progress after mounting, so it is set in on_mount.
 */
const emitProgressBar: Emitter = (node, indent, ctx) => {
  const p = node.props;
  const id = widgetId(node);
  const max = typeof p.max === 'number' && p.max > 0 ? p.max : 100;
  const value = typeof p.value === 'number' ? Math.min(max, Math.max(0, p.value)) : 0;

  // Textual's own height is 1 including the border, which leaves no row for the bar.
  const own = commonDeclarations(node, ctx);
  if (!own.some((l) => l.startsWith('height:'))) own.push('height: auto;');
  addRule(ctx, node, own);
  // The bar stretches to fill the width the editor gives the component.
  if (cssSize(p.width)) ctx.css.push(`#${id} Bar {\n    width: 1fr;\n}`);
  const color = cssColor(node.style.color, ctx);
  if (color) {
    ctx.css.push(`#${id} Bar > .bar--bar,\n#${id} Bar > .bar--complete {\n    color: ${color};\n}`);
  }

  needImport(ctx, 'textual.widgets', 'ProgressBar');
  needImport(ctx, 'textual.renderables.bar', 'Bar as BarRenderable');
  needImport(ctx, 'rich.text', 'Text as RichText');
  if (!ctx.classNames.has('StudioProgressBar')) {
    ctx.classNames.set('StudioProgressBar', 'StudioProgressBar');
    ctx.classes.push(PROGRESS_CLASS);
  }
  ctx.mount.push(
    `self.query_one(${pyStr('#' + id)}, StudioProgressBar).update(progress=${value})`
  );
  return `${IND.repeat(indent)}yield StudioProgressBar(total=${max}, show_eta=False, id=${pyStr(id)})\n`;
};

/** The bar has the same glyphs in every export: filled blocks, light shade for the rest. */
const PROGRESS_CLASS = `class StudioBarRenderable(BarRenderable):
    def __rich_console__(self, console, options):
        width = int(self.width or options.max_width)
        filled = max(0, min(width, round(self.highlight_range[1])))
        bar = RichText(end="")
        bar.append("█" * filled, style=console.get_style(self.highlight_style))
        bar.append("░" * (width - filled), style=console.get_style(self.background_style))
        yield bar


class StudioProgressBar(ProgressBar):
    BAR_RENDERABLE = StudioBarRenderable
`;

const SPINNER_CLASS = `class StudioSpinner(Static):
    FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"

    def __init__(self, text: str = "Loading...", **kwargs) -> None:
        super().__init__(markup=False, **kwargs)
        self._spinner_text = text
        self._spinner_frame = 0

    def on_mount(self) -> None:
        self._tick()
        self.set_interval(0.08, self._tick)

    def _tick(self) -> None:
        self.update(self.FRAMES[self._spinner_frame] + " " + self._spinner_text)
        self._spinner_frame = (self._spinner_frame + 1) % len(self.FRAMES)
`;

/** Animated braille spinner with a label (Textual's LoadingIndicator fills its container). */
const emitSpinner: Emitter = (node, indent, ctx) => {
  const decl = commonDeclarations(node, ctx);
  if (!cssSize(node.props.width)) decl.unshift('width: auto;');
  addRule(ctx, node, decl);

  needImport(ctx, 'textual.widgets', 'Static');
  if (!ctx.classNames.has('StudioSpinner')) {
    ctx.classNames.set('StudioSpinner', 'StudioSpinner');
    ctx.classes.push(SPINNER_CLASS);
  }
  const text = String(node.props.label ?? node.props.text ?? 'Loading...');
  return `${IND.repeat(indent)}yield StudioSpinner(${pyStr(text)}, id=${pyStr(widgetId(node))})\n`;
};

// ── Data widgets: List, Table, Tree ───────────────────────────────────────────

interface Item {
  label: string;
  icon: string;
  hotkey: string;
  expanded: boolean;
  children: unknown[];
}

/** Items are either plain strings or { label, icon, hotkey, expanded, children }. */
function toItem(raw: unknown): Item {
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    return {
      label: String(o.label ?? ''),
      icon: o.icon ? String(o.icon) : '',
      hotkey: o.hotkey ? String(o.hotkey) : '',
      expanded: Boolean(o.expanded),
      children: Array.isArray(o.children) ? o.children : [],
    };
  }
  return { label: String(raw ?? ''), icon: '', hotkey: '', expanded: false, children: [] };
}

/** Python identifier fragment for this widget (used for local variable names). */
function pyVar(node: ComponentNode): string {
  return widgetId(node);
}

/** Selectable list. Rendered as a ListView with "icon label  hotkey" rows. */
const emitList: Emitter = (node, indent, ctx) => {
  const p = node.props;
  const id = widgetId(node);
  const items = (Array.isArray(p.items) ? p.items : []).map(toItem);
  const selected = typeof p.selectedIndex === 'number' ? p.selectedIndex : 0;

  const decl = commonDeclarations(node, ctx);
  if (!cssSize(p.width)) decl.unshift('width: auto;');
  if (!cssSize(p.height)) decl.unshift('height: auto;');
  addRule(ctx, node, decl);
  const fg = cssColor(node.style.color, ctx);
  if (fg) ctx.css.push(`#${id} > ListItem {\n    color: ${fg};\n}`);

  needImport(ctx, 'textual.widgets', 'ListView');
  needImport(ctx, 'textual.widgets', 'ListItem');
  needImport(ctx, 'textual.widgets', 'Label');

  const sp = IND.repeat(indent);
  const rows = items.map((it) => {
    let text = escapeMarkup(`${it.icon ? it.icon + ' ' : ''}${it.label}`);
    if (it.hotkey) text += `  [dim]${escapeMarkup(it.hotkey)}[/dim]`;
    return `${sp}${IND}ListItem(Label(${pyStr(text)})),\n`;
  });
  const args =
    items.length && selected >= 0 && selected < items.length ? `initial_index=${selected}, ` : '';

  addHandler(
    ctx,
    node,
    'ListView.Selected',
    node.events.onSelect,
    'on_list_selected',
    undefined,
    itemLinks(node, ctx, 'event.list_view.index')
  );
  const listBodies = bodyGroups(node, ctx);
  if (listBodies) {
    addHandler(ctx, node, 'ListView.Highlighted', undefined, 'on_list_highlighted', listBodies);
  }
  if (!rows.length) return `${sp}yield ListView(id=${pyStr(id)})\n`;
  return `${sp}yield ListView(\n${rows.join('')}${sp}${IND}${args}id=${pyStr(id)},\n${sp})\n`;
};

/** Data table: columns and rows are filled in on_mount (DataTable has no constructor data). */
const emitTable: Emitter = (node, indent, ctx) => {
  const p = node.props;
  const id = widgetId(node);
  const columns = (Array.isArray(p.columns) ? p.columns : []).map((c) => String(c ?? ''));
  const rows = (Array.isArray(p.rows) ? p.rows : []).map((r) => (Array.isArray(r) ? r : []));

  const decl = commonDeclarations(node, ctx);
  if (!cssSize(p.width)) decl.unshift('width: auto;');
  addRule(ctx, node, decl);

  needImport(ctx, 'textual.widgets', 'DataTable');
  const v = pyVar(node);
  const cell = (c: unknown) => pyStr(escapeMarkup(String(c ?? '')));
  ctx.mount.push(`${v} = self.query_one(${pyStr('#' + id)}, DataTable)`);
  if (columns.length) ctx.mount.push(`${v}.add_columns(${columns.map(cell).join(', ')})`);
  if (columns.length && rows.length) {
    const body = rows.map((r) => `(${columns.map((_, i) => cell(r[i])).join(', ')},)`);
    ctx.mount.push(`${v}.add_rows([${body.join(', ')}])`);
  }
  return `${IND.repeat(indent)}yield DataTable(id=${pyStr(id)})\n`;
};

/** Tree with several top-level items: hide Textual's single root and add items under it. */
const emitTree: Emitter = (node, indent, ctx) => {
  const id = widgetId(node);
  const decl = commonDeclarations(node, ctx);
  if (!cssSize(node.props.width)) decl.unshift('width: auto;');
  if (!cssSize(node.props.height)) decl.unshift('height: auto;');
  addRule(ctx, node, decl);

  needImport(ctx, 'textual.widgets', 'Tree');
  const v = pyVar(node);
  ctx.mount.push(`${v} = self.query_one(${pyStr('#' + id)}, Tree)`);
  ctx.mount.push(`${v}.show_root = False`);
  ctx.mount.push(`${v}.root.expand()`);

  let counter = 0;
  const add = (raw: unknown, parent: string) => {
    const it = toItem(raw);
    const label = pyStr(escapeMarkup(`${it.icon ? it.icon + ' ' : ''}${it.label}`));
    if (it.children.length === 0) {
      ctx.mount.push(`${parent}.add_leaf(${label})`);
      return;
    }
    const name = `${v}__${++counter}`;
    ctx.mount.push(`${name} = ${parent}.add(${label}${it.expanded ? ', expand=True' : ''})`);
    it.children.forEach((c) => add(c, name));
  };
  (Array.isArray(node.props.items) ? node.props.items : []).forEach((i) => add(i, `${v}.root`));

  if (node.events.onSelect || node.tag) {
    addHandler(ctx, node, 'Tree.NodeSelected', node.events.onSelect, 'on_tree_selected');
  }
  return `${IND.repeat(indent)}yield Tree(${pyStr('Tree')}, id=${pyStr(id)})\n`;
};

// ── Navigation widgets: Menu, Tabs, Breadcrumb ────────────────────────────────

/** "icon label  hotkey" as Rich markup (hotkey dimmed), with user text escaped. */
function itemMarkup(it: Item): string {
  let text = escapeMarkup(`${it.icon ? it.icon + ' ' : ''}${it.label}`);
  if (it.hotkey) text += `  [dim]${escapeMarkup(it.hotkey)}[/dim]`;
  return text;
}

function indexedRule(ctx: Ctx, selector: string, lines: string[]) {
  ctx.css.push(`${selector} {\n${lines.map((l) => `    ${l}`).join('\n')}\n}`);
}

/**
 * Menu. Vertical menus are an OptionList; horizontal ones (flexbox row) are a row of
 * Labels with the selected entry reversed, since Textual has no menu bar widget.
 */
const emitMenu: Emitter = (node, indent, ctx) => {
  const p = node.props;
  const sp = IND.repeat(indent);
  const id = widgetId(node);
  const items = (Array.isArray(p.items) ? p.items : []).map(toItem);
  const selected = typeof p.selectedIndex === 'number' ? p.selectedIndex : 0;
  const horizontal = node.layout.type === 'flexbox' && node.layout.direction === 'row';

  const decl = commonDeclarations(node, ctx);
  if (!cssSize(p.width)) decl.unshift('width: auto;');
  if (!cssSize(p.height)) decl.unshift('height: auto;');
  addRule(ctx, node, decl);

  if (horizontal) {
    needImport(ctx, 'textual.containers', 'Horizontal');
    needImport(ctx, 'textual.widgets', 'Label');
    const gap = typeof node.layout.gap === 'number' ? node.layout.gap : 0;
    const item = ['padding: 0 1;'];
    if (gap) item.push(`margin-right: ${gap};`);
    if (p.menuStyle === 'filled') item.push('background: #ffffff;', 'color: #000000;');
    indexedRule(ctx, `#${id} > Label`, item);
    indexedRule(ctx, `#${id} > Label.selected`, ['text-style: reverse;']);
    const rows = items.map((it, i) => {
      const cls = i === selected ? ', classes="selected"' : '';
      return `${sp}${IND}yield Label(${pyStr(itemMarkup(it))}${cls})\n`;
    });
    return `${sp}with Horizontal(id=${pyStr(id)}):\n${rows.join('') || `${sp}${IND}pass\n`}`;
  }

  needImport(ctx, 'textual.widgets', 'OptionList');
  needImport(ctx, 'textual.widgets.option_list', 'Option');
  const fg = cssColor(node.style.color, ctx);
  if (fg) indexedRule(ctx, `#${id} > .option-list--option`, [`color: ${fg};`]);
  const options = items.map(
    (it, i) => `${sp}${IND}Option(${pyStr(itemMarkup(it))}, id=${pyStr(`${id}__${i}`)}),\n`
  );
  if (items.length && selected >= 0 && selected < items.length) {
    ctx.mount.push(`self.query_one(${pyStr('#' + id)}, OptionList).highlighted = ${selected}`);
  }
  const menuLinks = itemLinks(node, ctx, 'event.option_index');
  if (node.events.onSelect || node.tag || menuLinks.length) {
    addHandler(
      ctx,
      node,
      'OptionList.OptionSelected',
      node.events.onSelect,
      'on_menu_selected',
      undefined,
      menuLinks
    );
  }
  const menuBodies = bodyGroups(node, ctx);
  if (menuBodies) {
    addHandler(
      ctx,
      node,
      'OptionList.OptionHighlighted',
      undefined,
      'on_menu_highlighted',
      menuBodies
    );
  }
  if (!options.length) return `${sp}yield OptionList(id=${pyStr(id)})\n`;
  return `${sp}yield OptionList(\n${options.join('')}${sp}${IND}id=${pyStr(id)},\n${sp})\n`;
};

/** Tabs bar: "icon label ● hotkey" per tab, active tab preselected. */
const emitTabs: Emitter = (node, indent, ctx) => {
  const p = node.props;
  const sp = IND.repeat(indent);
  const id = widgetId(node);
  const tabs = (Array.isArray(p.tabs) ? p.tabs : []).map((t) => {
    const it = toItem(t);
    const status = Boolean(t && typeof t === 'object' && (t as Record<string, unknown>).status);
    return { it, status };
  });
  const active = typeof p.activeTab === 'number' ? p.activeTab : 0;

  addRule(ctx, node, commonDeclarations(node, ctx));
  const fg = cssColor(node.style.color, ctx);
  if (fg) indexedRule(ctx, `#${id} Tab`, [`color: ${fg};`]);

  needImport(ctx, 'textual.widgets', 'Tabs');
  needImport(ctx, 'textual.widgets', 'Tab');
  const rows = tabs.map(({ it, status }, i) => {
    const icon = it.icon ? it.icon + ' ' : '';
    const hotkey = it.hotkey ? ' ' + it.hotkey : '';
    const text = escapeMarkup(`${icon}${it.label || 'Tab'}${status ? ' ●' : ''}${hotkey}`);
    return `${sp}${IND}Tab(${pyStr(text)}, id=${pyStr(`${id}__${i}`)}),\n`;
  });
  const args: string[] = [];
  if (tabs.length) {
    const index = Math.min(Math.max(active, 0), tabs.length - 1);
    args.push(`active=${pyStr(`${id}__${index}`)}`);
  }
  args.push(`id=${pyStr(id)}`);
  const tabBodies = bodyGroups(node, ctx);
  if (node.events.onChange || node.tag || tabBodies) {
    addHandler(ctx, node, 'Tabs.TabActivated', node.events.onChange, 'on_tab_activated', tabBodies);
  }
  return `${sp}yield Tabs(\n${rows.join('')}${sp}${IND}${args.join(', ')},\n${sp})\n`;
};

/** Breadcrumb trail as one Label: "icon label / icon label" with a dimmed separator. */
const emitBreadcrumb: Emitter = (node, indent, ctx) => {
  const p = node.props;
  const decl = commonDeclarations(node, ctx);
  if (!cssSize(p.width)) decl.unshift('width: auto;');
  addRule(ctx, node, decl);
  needImport(ctx, 'textual.widgets', 'Label');

  const sep = escapeMarkup(String(p.separator ?? '/').trim() || '/');
  const parts = (Array.isArray(p.items) ? p.items : []).map((raw) => {
    const it = toItem(raw);
    return escapeMarkup(`${it.icon ? it.icon + ' ' : ''}${it.label}`);
  });
  const text = parts.join(` [dim]${sep}[/dim] `);
  return `${IND.repeat(indent)}yield Label(${pyStr(text)}, id=${pyStr(widgetId(node))})\n`;
};

// ── Layout widgets: Grid, Modal ───────────────────────────────────────────────

/** CSS grid: children fill the cells in order, like the editor's grid layout. */
const emitGrid: Emitter = (node, indent, ctx) => {
  const sp = IND.repeat(indent);
  const l = node.layout;
  const decl = commonDeclarations(node, ctx);
  decl.push(`grid-size: ${l.columns || 2} ${l.rows || 2};`);
  // Shorthand is "vertical horizontal"; the longhand properties are swapped in Textual.
  if (l.columnGap || l.rowGap) decl.push(`grid-gutter: ${l.rowGap || 0} ${l.columnGap || 0};`);
  addRule(ctx, node, decl);

  needImport(ctx, 'textual.containers', 'Grid');
  const body = nestedBody(node, indent, ctx);
  return `${sp}with Grid(id=${pyStr(widgetId(node))}):\n${body}`;
};

/**
 * Modal dialog. It is an overlay, so it becomes a ModalScreen class that is opened with a
 * function key (F1, F2, ...) and closed with Escape. Its children's on_mount statements
 * run inside the modal, because they cannot be queried while the modal is not shown.
 */
const emitModal: Emitter = (node, _indent, ctx) => {
  if (node.hidden) return '';
  const number = ctx.bindings.filter(([, action]) => action.startsWith('show_modal_')).length + 1;
  const name = `StudioModal${number}`;
  const title = String(node.props.title ?? '');
  const widget =
    flexPlan(node).horizontal && node.layout.type === 'flexbox' ? 'Horizontal' : 'Vertical';

  if (!ctx.classNames.has('modal-css')) {
    ctx.classNames.set('modal-css', 'ModalScreen');
    ctx.css.push(
      'ModalScreen {\n    align: center middle;\n    background: rgba(0, 0, 0, 0.6);\n}'
    );
  }
  const decl = commonDeclarations(node, ctx);
  const padding = cssSpacing(node.layout.padding);
  if (padding && !decl.some((l) => l.startsWith('padding:'))) decl.push(`padding: ${padding};`);
  decl.push(...flexDeclarations(node, ctx));
  addRule(ctx, node, decl);

  // The children belong to the modal: their state is synced when the modal is shown.
  const modalKey = node.tag ?? `_modal_${number}`;
  const outerMount = ctx.mount;
  const outerOwner = ctx.owner;
  const outerParts = ctx.parts;
  const outerDepth = ctx.depth;
  ctx.mount = [];
  ctx.parts = [];
  ctx.depth = 1;
  ctx.owner = modalKey;
  const body = emitChildren(node, 3, ctx);
  const innerMount = ctx.mount;
  const modalParts = ctx.parts;
  ctx.mount = outerMount;
  ctx.parts = outerParts;
  ctx.depth = outerDepth;
  ctx.owner = outerOwner;

  needImport(ctx, 'ui_runtime', 'StudioModalScreen');
  needImport(ctx, 'textual.containers', widget);
  const lines = [
    `class ${name}(StudioModalScreen):`,
    `${IND}KEY = ${pyStr(modalKey)}`,
    `${IND}BINDINGS = [("escape", "dismiss", "Close")]`,
    '',
    `${IND}def compose(self) -> ComposeResult:`,
    `${IND}${IND}with ${widget}(id=${pyStr(widgetId(node))}) as dialog:`,
    // With a code name the title can be changed at runtime (`ui.<tag>.title = ...`).
    ...(title || node.tag
      ? [
          `${IND}${IND}${IND}dialog.border_title = ${
            node.tag ? `self.app.ui[${pyStr(node.tag)}].title` : pyStr(title)
          }`,
        ]
      : []),
  ];
  let code = lines.join('\n') + '\n';
  code += body || (title ? '' : `${IND}${IND}${IND}pass\n`);
  if (innerMount.length) {
    code += `\n${IND}def on_mount(self) -> None:\n${innerMount.map((l) => `${IND}${IND}${l}\n`).join('')}`;
  }
  for (const part of modalParts) code += `\n${part}`;
  ctx.classes.push(code);
  if (node.tag) ctx.classNames.set(`modal:${node.tag}`, name);

  const key = number <= 12 ? `f${number}` : '';
  if (key) ctx.bindings.push([key, `show_modal_${number}`, title || `Modal ${number}`]);
  ctx.actions.push(
    `${IND}def action_show_modal_${number}(self) -> None:\n${IND}${IND}self.push_screen(${name}())\n`
  );
  return '';
};

const EMITTERS: Partial<Record<ComponentType, Emitter>> = {
  Grid: emitGrid,
  Modal: emitModal,
  Checkbox: emitCheckbox,
  Radio: emitRadio,
  Select: emitSelect,
  Toggle: emitToggleSwitch,
  ProgressBar: emitProgressBar,
  Spinner: emitSpinner,
  List: emitList,
  Table: emitTable,
  Tree: emitTree,
  Menu: emitMenu,
  Tabs: emitTabs,
  Breadcrumb: emitBreadcrumb,
  Box: emitBox,
  Text: emitText,
  Spacer: emitSpacer,
  TextInput: emitTextInput,
  Button: emitButton,
};

// ── Program access: handles for components with a code name ───────────────────

const pyList = (items: unknown[]) => JSON.stringify(items.map((i) => String(i ?? '')));
const pyBool = (v: unknown) => (v ? 'True' : 'False');

/**
 * Components with a code name become attributes of the generated `Ui` class, so the
 * program can read/write them, change their state and listen to their events.
 * The runtime classes are in ui_runtime.py; which states a component supports comes from
 * the shared API spec.
 */
function registerApi(node: ComponentNode, ctx: Ctx) {
  const tag = node.tag;
  if (!tag || node.type === 'Screen') return;
  const p = node.props;
  const kw: string[] = [];
  let cls = 'ContainerHandle';

  switch (node.type) {
    case 'Text':
      cls = 'TextHandle';
      kw.push(`text=${pyStr(p.content ?? '')}`);
      break;
    case 'Spinner':
      cls = 'SpinnerHandle';
      kw.push(`label=${pyStr(p.label ?? p.text ?? 'Loading...')}`);
      break;
    case 'Button':
      cls = 'ButtonHandle';
      kw.push(`label=${pyStr(p.label ?? '')}`);
      break;
    case 'TextInput':
      cls = 'InputHandle';
      kw.push(`value=${pyStr(p.value ?? '')}`, `placeholder=${pyStr(p.placeholder ?? '')}`);
      break;
    case 'Checkbox':
    case 'Radio':
      cls = 'CheckHandle';
      kw.push(`checked=${pyBool(p.checked)}`, `label=${pyStr(p.label ?? '')}`);
      break;
    case 'Toggle':
      cls = 'CheckHandle';
      kw.push(`checked=${pyBool(p.checked ?? p.value)}`, `label=${pyStr(p.label ?? '')}`);
      if (p.label) kw.push(`label_id=${pyStr(tag + '__label')}`);
      break;
    case 'Select': {
      cls = 'SelectHandle';
      const options = (Array.isArray(p.options) ? p.options : []).map(String);
      const value = options.includes(String(p.value ?? '')) ? String(p.value) : options[0];
      kw.push(`value=${value === undefined ? 'None' : pyStr(value)}`, `options=${pyList(options)}`);
      break;
    }
    case 'ProgressBar': {
      cls = 'ProgressHandle';
      const max = typeof p.max === 'number' && p.max > 0 ? p.max : 100;
      kw.push(`value=${typeof p.value === 'number' ? p.value : 0}`, `max=${max}`);
      break;
    }
    case 'Table': {
      cls = 'TableHandle';
      const rows = (Array.isArray(p.rows) ? p.rows : []).map((r) => (Array.isArray(r) ? r : []));
      kw.push(
        `columns=${pyList(Array.isArray(p.columns) ? p.columns : [])}`,
        `rows=${JSON.stringify(rows.map((r) => r.map((c) => String(c ?? ''))))}`
      );
      break;
    }
    case 'List': {
      cls = 'ListHandle';
      const items = (Array.isArray(p.items) ? p.items : []).map((i) => toItem(i).label);
      kw.push(
        `items=${pyList(items)}`,
        `selected=${typeof p.selectedIndex === 'number' ? p.selectedIndex : 0}`
      );
      break;
    }
    case 'Tree':
      cls = 'TreeHandle';
      break;
    case 'Menu':
      // A horizontal menu is a row of labels without selection events.
      if (!(node.layout.type === 'flexbox' && node.layout.direction === 'row')) {
        cls = 'MenuHandle';
        kw.push(`selected=${typeof p.selectedIndex === 'number' ? p.selectedIndex : 0}`);
      }
      break;
    case 'Tabs': {
      cls = 'TabsHandle';
      const count = Array.isArray(p.tabs) ? p.tabs.length : 0;
      const active = typeof p.activeTab === 'number' ? p.activeTab : 0;
      kw.push(`active=${Math.min(Math.max(active, 0), Math.max(count - 1, 0))}`);
      break;
    }
    case 'Modal': {
      cls = 'ModalHandle';
      const screen = ctx.classNames.get(`modal:${tag}`);
      if (!screen) return; // hidden modals are not exported
      kw.push(`screen=${screen}`, `title=${pyStr(p.title ?? '')}`);
      break;
    }
    default:
      break;
  }

  const states = API_SPEC[node.type].states.map((s) => pyStr(s)).join(', ');
  ctx.handles.push({
    tag,
    cls,
    args: [`states=(${states},)`, `owner=${pyStr(ctx.owner)}`, ...kw].join(', '),
  });
  needImport(ctx, 'ui_runtime', cls);
}

function emitNode(node: ComponentNode, indent: number, ctx: Ctx): string {
  // Document order for the attributes of `Ui`; a modal needs its generated class first.
  if (node.type !== 'Modal') registerApi(node, ctx);
  const emitter = EMITTERS[node.type];
  let out: string;
  if (emitter) {
    out = emitter(node, indent, ctx);
  } else if (node.children.length > 0) {
    out = emitBox(node, indent, ctx);
  } else {
    needImport(ctx, 'textual.widgets', 'Static');
    out = `${IND.repeat(indent)}yield Static(${pyStr(`[${node.type}]`)}, markup=False)  # TODO: ${node.type} not exported yet\n`;
  }
  if (node.type === 'Modal') registerApi(node, ctx);
  return out;
}

// ── Screen / entry point ──────────────────────────────────────────────────────

/** Textual CSS of a screen's own styles (the screen is a widget with id `key`). */
function screenRule(root: ComponentNode, key: string, ctx: Ctx): string {
  const decl: string[] = [];
  const bg = cssColor(root.style.backgroundColor, ctx);
  const fg = cssColor(root.style.color, ctx);
  if (bg) decl.push(`background: ${bg};`);
  if (fg) decl.push(`color: ${fg};`);
  const l = root.layout;
  if (l.type === 'grid') {
    decl.push('layout: grid;', `grid-size: ${l.columns || 2} ${l.rows || 2};`);
    if (l.columnGap || l.rowGap) decl.push(`grid-gutter: ${l.rowGap || 0} ${l.columnGap || 0};`);
  } else if (flexPlan(root).horizontal && l.type === 'flexbox') {
    decl.push('layout: horizontal;');
  }
  decl.push(...flexDeclarations(root, ctx));
  const border = borderDeclaration(root, ctx);
  if (border) decl.push(border);
  const padding = cssSpacing(root.layout.padding);
  if (padding) decl.push(`padding: ${padding};`);
  return decl.length ? `#${key} {\n${decl.map((l) => `    ${l}`).join('\n')}\n}` : '';
}

/** Python class name for a screen: "Home" -> HomeScreen, unique within the file. */
function screenClassName(root: ComponentNode, index: number, used: Set<string>): string {
  const source = root.tag || root.name;
  const pascal = source
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');
  // A bare "Screen" would shadow Textual's own class name.
  const base = /^[A-Za-z]/.test(pascal) && pascal !== 'Screen' ? pascal : `Screen${index + 1}`;
  let name = base.endsWith('Screen') ? base : `${base}Screen`;
  for (let i = 2; used.has(name); i++) name = `${base}${i}Screen`;
  used.add(name);
  return name;
}

function paletteOf(root: ComponentNode): Record<string, string> {
  const themeName = (root.props.theme as keyof typeof THEMES) || 'default';
  return (THEMES[themeName] ?? THEMES.default) as unknown as Record<string, string>;
}

/**
 * Textual app for one or more screens. Every screen becomes a `Screen` class; the first one
 * is shown at startup and `ui.<screen>.show()` switches between them.
 */
export function exportToTextual(input: ComponentNode | readonly ExportScreen[]): string {
  const given: ExportScreen[] = Array.isArray(input)
    ? [...(input as readonly ExportScreen[])]
    : [{ id: 'screen-1', root: input as ComponentNode }];
  const roots = given.map((s) => s.root);
  const ctx: Ctx = {
    screenKeys: new Map(given.map((s, i) => [s.id, s.root.tag ?? `_screen_${i + 1}`])),
    css: [],
    palette: paletteOf(roots[0]),
    layoutOf: () => undefined,
    handlers: [],
    imports: new Map(),
    mount: [],
    depth: 0,
    parts: [],
    partSeq: 0,
    classes: [],
    classNames: new Map(),
    bindings: [],
    actions: [],
    handles: [],
    owner: '',
    root: roots[0],
    screenClasses: [],
  };
  needImport(ctx, 'textual.app', 'ComposeResult');
  needImport(ctx, 'ui_runtime', 'StudioApp');
  needImport(ctx, 'ui_runtime', 'StudioUi');
  needImport(ctx, 'ui_runtime', 'StudioScreen');
  needImport(ctx, 'ui_runtime', 'LogPanel');

  // One class per screen. Widgets, CSS and handlers are shared by the whole app.
  const usedClassNames = new Set<string>();
  const screens: { key: string; cls: string; tag?: string }[] = [];
  roots.forEach((root, index) => {
    const key = root.tag ?? `_screen_${index + 1}`;
    const cls = screenClassName(root, index, usedClassNames);
    screens.push({ key, cls, tag: root.tag });

    ctx.palette = paletteOf(root);
    ctx.root = root;
    ctx.owner = key;
    // The editor's own layout engine (a separate instance, so the canvas is not disturbed).
    const engine = new LayoutEngine();
    const size = (v: unknown, fallback: number) => (typeof v === 'number' ? v : fallback);
    engine.calculateLayout(root, size(root.props.width, 80), size(root.props.height, 24), false);
    ctx.layoutOf = (id) => engine.getLayout(id);
    const rule = screenRule(root, key, ctx);
    if (rule) ctx.css.push(rule);

    // Tables, trees, ... are filled when this screen is mounted, not when the app starts.
    const outerMount = ctx.mount;
    ctx.mount = [];
    ctx.parts = [];
    ctx.depth = 0;
    const body = emitChildren(root, 2, ctx);
    const mountLines = ctx.mount;
    const screenParts = ctx.parts;
    ctx.mount = outerMount;
    if (!body) needImport(ctx, 'textual.widgets', 'Static');

    let code =
      `class ${cls}(StudioScreen):\n` +
      `${IND}KEY = ${pyStr(key)}\n\n` +
      `${IND}def compose(self) -> ComposeResult:\n` +
      // First, so that the last child of the screen is a real widget (see the gap rules).
      `${IND}${IND}yield LogPanel(id="_ui_log")\n` +
      (body || `${IND}${IND}yield Static("Empty screen")\n`);
    if (mountLines.length) {
      code += `\n${IND}def on_mount(self) -> None:\n${mountLines.map((l) => `${IND}${IND}${l}\n`).join('')}`;
    }
    for (const part of screenParts) code += `\n${part}`;
    ctx.screenClasses.push(code);
  });

  // A screen with a code name can be shown by the program: ui.<tag>.show()
  const screenHandles = screens.filter((s) => s.tag);
  if (screenHandles.length) needImport(ctx, 'ui_runtime', 'ScreenHandle');

  const css = ctx.css.filter(Boolean).join('\n\n');
  const indentedCss = css
    .split('\n')
    .map((l) => (l ? IND + l : l))
    .join('\n');

  const handlers = ctx.handlers.length ? '\n' + ctx.handlers.join('\n') : '';
  const classes = [...ctx.classes, ...ctx.screenClasses]
    .map((c) => c.trimEnd() + '\n\n\n')
    .join('');
  const bindings = ctx.bindings.length
    ? `\n${IND}BINDINGS = [\n${ctx.bindings
        .map(
          ([key, action, text]) =>
            `${IND}${IND}(${pyStr(key)}, ${pyStr(action)}, ${pyStr(text)}),\n`
        )
        .join('')}${IND}]\n`
    : '';
  const actions = ctx.actions.map((a) => '\n' + a).join('');

  const attrs =
    screenHandles.map((s) => `${IND}${s.tag}: ScreenHandle\n`).join('') +
    ctx.handles.map((h) => `${IND}${h.tag}: ${h.cls}\n`).join('');
  const inits =
    screenHandles
      .map((s) => `${IND}${IND}self.${s.tag} = ScreenHandle(self, ${pyStr(s.tag)})\n`)
      .join('') +
    ctx.handles
      .map((h) => `${IND}${IND}self.${h.tag} = ${h.cls}(self, ${pyStr(h.tag)}, ${h.args})\n`)
      .join('');
  const screenMap = screens.map((s) => `${pyStr(s.key)}: ${s.cls}`).join(', ');
  const uiClass =
    `class Ui(StudioUi):\n` +
    `${IND}"""Your program's access to the screens and components that have a code name."""\n\n` +
    `${attrs}${attrs ? '\n' : ''}` +
    `${IND}def __init__(self) -> None:\n` +
    `${IND}${IND}super().__init__(MyApp, screens={${screenMap}}, first=${pyStr(screens[0].key)})\n` +
    inits;

  return `${renderImports(ctx)}


${classes}class MyApp(StudioApp):
    CSS = """
${indentedCss}
    """
${bindings}${handlers}${actions}

${uiClass}

if __name__ == "__main__":
    Ui().run()
`;
}
