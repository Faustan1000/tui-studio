// Textual (Python) exporter.
//
// Each component type gets its own emitter in EMITTERS so elements can be added
// one at a time. Types without an emitter fall back to a generic container
// (if they have children) or a placeholder Static widget.

import type { ComponentNode, ComponentType } from '../../../types';
import { THEMES } from '../../../stores/themeStore';

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
  /** Generated widget subclasses (module level, before the App class). */
  classes: string[];
  /** Dedupe key -> generated class name. */
  classNames: Map<string, string>;
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
  return 'n_' + node.id.replace(/[^a-zA-Z0-9_]/g, '_');
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

/** CSS declarations shared by all components (size, colors, border). */
function commonDeclarations(node: ComponentNode, ctx: Ctx): string[] {
  const d: string[] = [];
  const w = cssSize(node.props.width);
  const h = cssSize(node.props.height);
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

/** Register a Textual message handler bound to one widget. */
function addHandler(
  ctx: Ctx,
  node: ComponentNode,
  message: string,
  rawName: unknown,
  fallback: string
) {
  const name = methodName(typeof rawName === 'string' && rawName ? rawName : fallback, ctx);
  ctx.handlers.push(
    `${IND}@on(${message}, "#${widgetId(node)}")\n` +
      `${IND}def ${name}(self, event: ${message}) -> None:\n` +
      `${IND}${IND}pass\n`
  );
  needImport(ctx, 'textual', 'on');
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

function emitChildren(node: ComponentNode, indent: number, ctx: Ctx): string {
  const horizontal = node.layout.direction === 'row';
  let out = '';
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child.type === 'Radio') {
      const group = [child];
      while (node.children[i + 1]?.type === 'Radio') group.push(node.children[++i]);
      out += emitRadioGroup(group, horizontal, indent, ctx);
    } else {
      out += emitNode(child, indent, ctx);
    }
  }
  return out;
}

/** Container used for Box (and as the generic container fallback). */
const emitBox: Emitter = (node, indent, ctx) => {
  const sp = IND.repeat(indent);
  const widget = node.layout.direction === 'row' ? 'Horizontal' : 'Vertical';
  needImport(ctx, 'textual.containers', widget);

  const decl = commonDeclarations(node, ctx);
  // Textual containers default to 1fr; stay content-sized unless a size is set.
  if (!cssSize(node.props.width)) decl.unshift('width: auto;');
  if (!cssSize(node.props.height)) decl.unshift('height: auto;');
  addRule(ctx, node, decl);

  const body = emitChildren(node, indent + 1, ctx);
  return `${sp}with ${widget}(id=${pyStr(widgetId(node))}):\n${body || `${sp}${IND}pass\n`}`;
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
  addHandler(ctx, node, 'Button.Pressed', node.events.onClick, 'on_button_pressed');

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
  const id = `${widgetId(radios[0])}_group`;
  const decl = ['border: none;', 'padding: 0;', 'background: transparent;', 'width: auto;'];
  if (horizontal) decl.push('layout: horizontal;');
  ctx.css.push(`#${id} {\n${decl.map((l) => `    ${l}`).join('\n')}\n}`);
  needImport(ctx, 'textual.widgets', 'RadioSet');
  const body = radios.map((r) => emitRadio(r, indent + 1, ctx)).join('');
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
  rule(`#${id}_group`, [
    ...(cssSize(p.width) ? [] : ['width: auto;']),
    ...(cssSize(p.height) ? [] : ['height: auto;']),
    ...group,
  ]);
  rule(`#${id}`, sw);
  rule(`#${id}_label`, labelLines);

  needImport(ctx, 'textual.containers', 'Horizontal');
  needImport(ctx, 'textual.widgets', 'Label');
  return (
    `${sp}with Horizontal(id=${pyStr(id + '_group')}):\n` +
    `${sp}${IND}yield Switch(${args.join(', ')})\n` +
    `${sp}${IND}yield Label(${pyStr(escapeMarkup(label))}, id=${pyStr(id + '_label')})\n`
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

  addRule(ctx, node, commonDeclarations(node, ctx));
  // The bar stretches to fill the width the editor gives the component.
  if (cssSize(p.width)) ctx.css.push(`#${id} Bar {\n    width: 1fr;\n}`);
  const color = cssColor(node.style.color, ctx);
  if (color) {
    ctx.css.push(`#${id} Bar > .bar--bar,\n#${id} Bar > .bar--complete {\n    color: ${color};\n}`);
  }

  needImport(ctx, 'textual.widgets', 'ProgressBar');
  ctx.mount.push(`self.query_one(${pyStr('#' + id)}, ProgressBar).update(progress=${value})`);
  return `${IND.repeat(indent)}yield ProgressBar(total=${max}, show_eta=False, id=${pyStr(id)})\n`;
};

const EMITTERS: Partial<Record<ComponentType, Emitter>> = {
  Checkbox: emitCheckbox,
  Radio: emitRadio,
  Select: emitSelect,
  Toggle: emitToggleSwitch,
  ProgressBar: emitProgressBar,
  Box: emitBox,
  Text: emitText,
  Spacer: emitSpacer,
  TextInput: emitTextInput,
  Button: emitButton,
};

function emitNode(node: ComponentNode, indent: number, ctx: Ctx): string {
  const emitter = EMITTERS[node.type];
  if (emitter) return emitter(node, indent, ctx);
  if (node.children.length > 0) return emitBox(node, indent, ctx);
  needImport(ctx, 'textual.widgets', 'Static');
  return `${IND.repeat(indent)}yield Static(${pyStr(`[${node.type}]`)}, markup=False)  # TODO: ${node.type} not exported yet\n`;
}

// ── Screen / entry point ──────────────────────────────────────────────────────

function screenRule(root: ComponentNode, ctx: Ctx): string {
  const decl: string[] = [];
  const bg = cssColor(root.style.backgroundColor, ctx);
  const fg = cssColor(root.style.color, ctx);
  if (bg) decl.push(`background: ${bg};`);
  if (fg) decl.push(`color: ${fg};`);
  if (root.layout.direction === 'row') decl.push('layout: horizontal;');
  const border = borderDeclaration(root, ctx);
  if (border) decl.push(border);
  const padding = cssSpacing(root.layout.padding);
  if (padding) decl.push(`padding: ${padding};`);
  return decl.length ? `Screen {\n${decl.map((l) => `    ${l}`).join('\n')}\n}` : '';
}

export function exportToTextual(root: ComponentNode): string {
  const themeName = (root.props.theme as keyof typeof THEMES) || 'default';
  const palette = (THEMES[themeName] ?? THEMES.default) as unknown as Record<string, string>;
  const ctx: Ctx = {
    css: [],
    palette,
    handlers: [],
    imports: new Map(),
    mount: [],
    classes: [],
    classNames: new Map(),
  };
  needImport(ctx, 'textual.app', 'App');
  needImport(ctx, 'textual.app', 'ComposeResult');

  const rootRule = screenRule(root, ctx);
  const body = emitChildren(root, 2, ctx);
  const css = [rootRule, ...ctx.css].filter(Boolean).join('\n\n');
  const indentedCss = css
    .split('\n')
    .map((l) => (l ? IND + l : l))
    .join('\n');

  const handlers = ctx.handlers.length ? '\n' + ctx.handlers.join('\n') : '';
  const mount = ctx.mount.length
    ? `\n${IND}def on_mount(self) -> None:\n${ctx.mount.map((l) => `${IND}${IND}${l}\n`).join('')}`
    : '';
  const compose = body || `${IND}${IND}yield Static("Empty screen")\n`;
  if (!body) needImport(ctx, 'textual.widgets', 'Static');

  const classes = ctx.classes.map((c) => c.trimEnd() + '\n\n\n').join('');

  return `${renderImports(ctx)}


${classes}class MyApp(App):
    CSS = """
${indentedCss}
    """

    def compose(self) -> ComposeResult:
${compose}${mount}${handlers}

if __name__ == "__main__":
    MyApp().run()
`;
}
