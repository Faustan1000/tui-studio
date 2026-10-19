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

function addRule(ctx: Ctx, node: ComponentNode, declarations: string[]) {
  if (declarations.length === 0) return;
  ctx.css.push(`#${widgetId(node)} {\n${declarations.map((l) => `    ${l}`).join('\n')}\n}`);
}

// ── Emitters ──────────────────────────────────────────────────────────────────

function emitChildren(node: ComponentNode, indent: number, ctx: Ctx): string {
  return node.children.map((c) => emitNode(c, indent, ctx)).join('');
}

/** Container used for Box (and as the generic container fallback). */
const emitBox: Emitter = (node, indent, ctx) => {
  const sp = IND.repeat(indent);
  const widget = node.layout.direction === 'row' ? 'Horizontal' : 'Vertical';

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
  return `${IND.repeat(indent)}yield Static("", id=${pyStr(widgetId(node))})\n`;
};

const EMITTERS: Partial<Record<ComponentType, Emitter>> = {
  Box: emitBox,
  Text: emitText,
  Spacer: emitSpacer,
  // Existing simple widgets (to be reworked one by one).
  Button: (node, indent, ctx) => {
    addRule(ctx, node, commonDeclarations(node, ctx));
    return `${IND.repeat(indent)}yield Button(${pyStr(node.props.label ?? 'Button')}, id=${pyStr(widgetId(node))})\n`;
  },
  TextInput: (node, indent, ctx) => {
    addRule(ctx, node, commonDeclarations(node, ctx));
    const value = node.props.value ? `value=${pyStr(node.props.value)}, ` : '';
    return `${IND.repeat(indent)}yield Input(${value}placeholder=${pyStr(node.props.placeholder ?? '')}, id=${pyStr(widgetId(node))})\n`;
  },
};

function emitNode(node: ComponentNode, indent: number, ctx: Ctx): string {
  const emitter = EMITTERS[node.type];
  if (emitter) return emitter(node, indent, ctx);
  if (node.children.length > 0) return emitBox(node, indent, ctx);
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
  const ctx: Ctx = { css: [], palette };

  const rootRule = screenRule(root, ctx);
  const body = emitChildren(root, 2, ctx);
  const css = [rootRule, ...ctx.css].filter(Boolean).join('\n\n');
  const indentedCss = css
    .split('\n')
    .map((l) => (l ? IND + l : l))
    .join('\n');

  return `from textual.app import App, ComposeResult
from textual.containers import Horizontal, Vertical
from textual.widgets import Button, Input, Static


class MyApp(App):
    CSS = """
${indentedCss}
    """

    def compose(self) -> ComposeResult:
${body || `${IND}${IND}yield Static("Empty screen")\n`}
    def on_button_pressed(self, event: Button.Pressed) -> None:
        pass


if __name__ == "__main__":
    MyApp().run()
`;
}
