// Ink (React for the terminal) exporter.
//
// Layout strategy: NATIVE. Ink lays out with Yoga flexbox, so every container maps its design to
// Box props:
//   - flex containers: flexDirection, flexWrap, gap, alignItems, justifyContent, padding per side
//   - Grid: a column of row boxes (rowGap/columnGap); every cell is an equal-width flex cell
//   - absolute containers: children get position="absolute" and marginLeft/marginTop. Ink has no
//     left/top props, but Yoga offsets an absolute child by its margin from the container's
//     inner edge, so the offset is the editor position minus the container's border and padding
//   - Modal: an absolute bordered overlay at its editor position, open at start only if visible
//   - sizes: numbers -> width/height (flexShrink 0), 'fill' -> flexGrow or "100%" depending on the
//     parent's direction, 'auto' -> nothing
// The `rel` snapshot strategy is not used.
//   - The root screen FILLS the terminal: width/height come from stdout columns/rows (design size
//     only if there is no terminal) and follow the 'resize' event; it clips its content.
//
// Mouse (the runtime, src/ui-runtime.ts): SGR mouse reporting (ESC[?1000h ESC[?1006h) is switched
// on for a terminal and off again on exit; the reports are taken out of stdin.read() before Ink
// parses it. Hit-testing is by the elements themselves: every clickable component registers the
// ref of its Box, and the screen position is computed from Yoga (own size plus the sum of
// getComputedLeft/Top up the parentNode chain), so it is right at any terminal size and after
// any re-layout. Lists, menus and tabs register one ref per item. A modal restricts clicks to
// itself, an open error dialog takes the click and closes.
//
// Interactivity is real React state (useState) with focus handled by Ink's useFocus (Tab moves).
// Components with a code name are backed by a store (`src/ui-runtime.ts`, the program API of
// docs/PROGRAM_API.md); the others keep local React state.
// Known limit: tab/menu bodies (`showWhen`) are static at their initial visibility.

import type { ExportAdapter, ExportFile } from '../adapter';
import { apiName, buildApiModel, safeIdent, type ApiHandleModel } from '../api/model';
import { renderFacade } from '../api/facade';
import INK_RUNTIME_SOURCE from '../api/ink/ui-runtime.ts.txt?raw';
import type { ComponentType } from '../../../types';
import {
  inlineText,
  itemText,
  progressText,
  recase,
  treeLines,
  type IRNode,
  type IRScreen,
} from '../ir';
import { CodeWriter, jsStr } from '../lang';

const RESERVED = new Set([
  'abstract',
  'arguments',
  'await',
  'boolean',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'eval',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'undefined',
  'NaN',
  'Infinity',
  // names used by the generated file
  'React',
  'App',
  'Box',
  'Text',
  'TextInput',
  'SelectInput',
  'Spinner',
  'Focusable',
  'Field',
  'Dropdown',
  'Choices',
  'render',
  'useState',
  'useEffect',
  'useInput',
  'useFocus',
  'useApp',
  'exit',
  'typing',
  'ReactNode',
  'TextProps',
  'core',
  'ui',
  'bar',
  'tableLines',
  'Dialog',
  'LogPanel',
  'CoreContext',
  'useBlocked',
  'Ui',
  'UiBase',
  'SPECS',
  'useContext',
  'createContext',
  'useSyncExternalStore',
  'pathToFileURL',
  'ReactElement',
  'ScrollArea',
  'useReveal',
  'LayerContext',
  'ModalBox',
  'measureElement',
]);

class Names {
  private used = new Set(RESERVED);
  take(base: string): string {
    let candidate = base || 'value';
    for (let i = 2; this.used.has(candidate); i++) candidate = `${base || 'value'}${i}`;
    this.used.add(candidate);
    return candidate;
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

interface Ctx {
  names: Names;
  /** `const [x, setX] = useState(...)` lines. */
  states: string[];
  /** Raw handler name -> function name. */
  handlers: Map<string, string>;
  radioGroups: Map<string, { state: string; setter: string }>;
  /** Statements that close the modals (Esc). */
  modalStates: string[];
  /** Nodes with a code name (program API handles) by node id. */
  handles: Map<string, ApiHandleModel>;
  uses: {
    focus: boolean;
    field: boolean;
    dropdown: boolean;
    choices: boolean;
    spinner: boolean;
    textProps: boolean;
    bar: boolean;
    table: boolean;
  };
}

// ── Props ─────────────────────────────────────────────────────────────────────

const JUSTIFY: Record<string, string | undefined> = {
  start: undefined,
  center: 'center',
  end: 'flex-end',
  'space-between': 'space-between',
  'space-around': 'space-around',
};
const ALIGN: Record<string, string> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  stretch: 'stretch',
};
const BORDER: Record<string, string> = {
  single: 'single',
  double: 'double',
  rounded: 'round',
  bold: 'bold',
};

/** Text colour/emphasis as JSX attributes. */
function textAttrs(n: IRNode): string {
  const a: string[] = [];
  if (n.style.fg) a.push(`color=${jsStr(n.style.fg)}`);
  if (n.style.bg) a.push(`backgroundColor=${jsStr(n.style.bg)}`);
  if (n.style.bold) a.push('bold');
  if (n.style.italic) a.push('italic');
  if (n.style.underline) a.push('underline');
  if (n.style.strikethrough) a.push('strikethrough');
  return a.length ? ' ' + a.join(' ') : '';
}

/** The same as an object literal (for helper components), or null. */
function textObj(n: IRNode): string | null {
  const a: string[] = [];
  if (n.style.fg) a.push(`color: ${jsStr(n.style.fg)}`);
  if (n.style.bg) a.push(`backgroundColor: ${jsStr(n.style.bg)}`);
  if (n.style.bold) a.push('bold: true');
  if (n.style.italic) a.push('italic: true');
  if (n.style.underline) a.push('underline: true');
  if (n.style.strikethrough) a.push('strikethrough: true');
  return a.length ? `{ ${a.join(', ')} }` : null;
}

function parentDirection(n: IRNode): 'row' | 'column' {
  const p = n.parent;
  if (!p || p.layout.mode === 'grid' || p.layout.mode === 'absolute') return 'column';
  return p.layout.direction;
}

function sizeAttrs(n: IRNode, dir: 'row' | 'column'): string[] {
  const a: string[] = [];
  if (typeof n.width === 'number') a.push(`width={${n.width}}`);
  else if (n.width === 'fill') a.push(dir === 'row' ? 'flexGrow={1}' : 'width="100%"');
  if (typeof n.height === 'number') a.push(`height={${n.height}}`);
  else if (n.height === 'fill') a.push(dir === 'column' ? 'flexGrow={1}' : 'height="100%"');
  a.push('flexShrink={0}');
  return a;
}

function paddingAttrs(n: IRNode): string[] {
  const p = n.layout.padding;
  if (p.top === p.right && p.right === p.bottom && p.bottom === p.left)
    return p.top > 0 ? [`padding={${p.top}}`] : [];
  const a: string[] = [];
  if (p.top) a.push(`paddingTop={${p.top}}`);
  if (p.right) a.push(`paddingRight={${p.right}}`);
  if (p.bottom) a.push(`paddingBottom={${p.bottom}}`);
  if (p.left) a.push(`paddingLeft={${p.left}}`);
  return a;
}

function borderAttrs(n: IRNode, fallback = false): string[] {
  const b =
    n.style.border ??
    (fallback
      ? { kind: 'rounded' as const, color: null, top: true, right: true, bottom: true, left: true }
      : null);
  if (!b) return [];
  const a = [`borderStyle=${jsStr(BORDER[b.kind] ?? 'single')}`];
  if (b.color) a.push(`borderColor=${jsStr(b.color)}`);
  if (!b.top) a.push('borderTop={false}');
  if (!b.right) a.push('borderRight={false}');
  if (!b.bottom) a.push('borderBottom={false}');
  if (!b.left) a.push('borderLeft={false}');
  return a;
}

/** position="absolute" with the editor offset when the node sits in an absolute container (or is a Modal). */
function absoluteAttrs(n: IRNode): string[] {
  const parent = n.parent;
  if (!parent || (parent.layout.mode !== 'absolute' && n.type !== 'Modal')) return [];
  const pb = parent.style.border;
  const pad = parent.layout.padding;
  let x = (n.rel?.x ?? n.layout.x) - (pb?.left ? 1 : 0) - pad.left;
  let y = (n.rel?.y ?? n.layout.y) - (pb?.top ? 1 : 0) - pad.top;
  if (n.type === 'Modal') {
    // The editor lays a modal out in the flow; as an overlay it is centred in its parent.
    const inner = (v: number, border: boolean) => v - (border ? 2 : 0);
    const pw = parent.box ? inner(parent.box.width, !!pb) : 0;
    const ph = parent.box ? inner(parent.box.height, !!pb) : 0;
    const mw = typeof n.width === 'number' ? n.width : n.box?.width;
    const mh = typeof n.height === 'number' ? n.height : n.box?.height;
    x = mw && pw ? Math.floor((pw - mw) / 2) : 0;
    y = mh && ph ? Math.floor((ph - mh) / 2) : 0;
  }
  const a = ['position="absolute"'];
  if (x > 0) a.push(`marginLeft={${x}}`);
  if (y > 0) a.push(`marginTop={${y}}`);
  return a;
}

function flexAttrs(n: IRNode): string[] {
  const l = n.layout;
  if (l.mode === 'grid')
    return ['flexDirection="column"', ...(l.rowGap ? [`rowGap={${l.rowGap}}`] : [])];
  if (l.mode === 'absolute') return [];
  const a = [`flexDirection=${jsStr(l.direction)}`];
  if (l.wrap) a.push('flexWrap="wrap"');
  if (l.gap > 0) a.push(`gap={${l.gap}}`);
  a.push(`alignItems=${jsStr(ALIGN[l.align] ?? 'flex-start')}`);
  const j = JUSTIFY[l.justify];
  if (j) a.push(`justifyContent=${jsStr(j)}`);
  return a;
}

// ── Emitting ──────────────────────────────────────────────────────────────────

function tag(name: string, attrs: string[], selfClose = false): string {
  return `<${name}${attrs.length ? ' ' + attrs.join(' ') : ''}${selfClose ? ' />' : '>'}`;
}

function handlerName(ctx: Ctx, raw: string): string | null {
  let name = ctx.handlers.get(raw);
  if (name) return name;
  const base = raw.replace(/[^A-Za-z0-9_$]/g, '_').replace(/^[0-9]/, '_$&');
  if (!base || /^_*$/.test(base)) return null;
  name = ctx.names.take(base);
  ctx.handlers.set(raw, name);
  return name;
}

/** Calls of the node's event handlers (keys selected by `only`). */
function calls(ctx: Ctx, n: IRNode, only?: RegExp, not?: RegExp): string[] {
  const out: string[] = [];
  for (const [key, raw] of Object.entries(n.events)) {
    if (only && !only.test(key)) continue;
    if (not && not.test(key)) continue;
    const name = handlerName(ctx, raw);
    if (name && !out.includes(`${name}();`)) out.push(`${name}();`);
  }
  return out;
}

function arrow(params: string, stmts: string[]): string {
  return stmts.length ? `(${params}) => { ${stmts.join(' ')} }` : `(${params}) => {}`;
}

/** Statements that run only if `cond` (the store accepted the user's input). */
function guarded(cond: string | null, stmts: string[]): string[] {
  if (!cond) return stmts;
  return stmts.length ? [`if (${cond}) { ${stmts.join(' ')} }`] : [`${cond};`];
}

/** Whether a node is part of the initial design, counting tagged hidden nodes (they can be shown). */
function shown(n: IRNode, ctx: Ctx): boolean {
  if (n.visible) return true;
  if (n.showWhen) return false;
  if (n.hidden && !ctx.handles.has(n.id)) return false;
  return !n.parent || shown(n.parent, ctx);
}

function shownChildren(n: IRNode, ctx: Ctx): IRNode[] {
  return n.children.filter((c) => shown(c, ctx));
}

function emit(n: IRNode, w: CodeWriter, ctx: Ctx, root?: IRScreen): void {
  if (!shown(n, ctx)) return;
  const h = ctx.handles.get(n.id);
  const inner = () => {
    switch (n.type) {
      case 'Screen':
      case 'Box':
      case 'Grid':
      case 'Modal':
        return emitContainer(n, w, ctx, root);
      default:
        return emitLeaf(n, w, ctx);
    }
  };
  if (!h) return inner();
  const t = jsStr(h.tag);
  const gate =
    n.type === 'Modal'
      ? `core.isOpen(${t}) && core.state(${t}) !== "hidden"`
      : `core.state(${t}) !== "hidden"`;
  w.line(`{${gate} && (`).indent();
  inner();
  w.dedent().line(')}');
}

function emitContainer(n: IRNode, w: CodeWriter, ctx: Ctx, root?: IRScreen): void {
  const kids = shownChildren(n, ctx);
  const isModal = n.type === 'Modal';
  const h = ctx.handles.get(n.id);
  const dir = parentDirection(n);
  const attrs: string[] = root ? ['flexDirection="column"'] : [...flexAttrs(n)];
  if (root) attrs.push('width={cols}', 'height={rows}', 'overflow="hidden"');
  else attrs.push(...sizeAttrs(n, dir));
  if (n.style.bg) attrs.push(`backgroundColor=${jsStr(n.style.bg)}`);
  attrs.push(...paddingAttrs(n), ...borderAttrs(n, isModal), ...absoluteAttrs(n));
  const finalAttrs = isModal
    ? [...attrs.filter((x) => !x.startsWith('flexDirection=')), 'flexDirection="column"']
    : attrs;
  const title = isModal ? (h ? `core.str(${jsStr(h.tag)}, "title")` : jsStr(n.text)) : '';

  const body = () => {
    if (isModal) w.line(`<Text bold${textAttrs(n).replace(' bold', '')}>{${title}}</Text>`);
    if (n.layout.mode === 'grid') {
      const cols = n.layout.columns;
      for (let i = 0; i < kids.length; i += cols) {
        const row = kids.slice(i, i + cols);
        w.wrap(
          tag('Box', [
            'flexDirection="row"',
            ...(n.layout.columnGap ? [`columnGap={${n.layout.columnGap}}`] : []),
          ]),
          () => {
            for (let c = 0; c < cols; c++) {
              const cell = row[c];
              if (!cell) w.line('<Box flexGrow={1} flexBasis={0} />');
              else w.wrap('<Box flexGrow={1} flexBasis={0}>', () => emit(cell, w, ctx), '</Box>');
            }
          },
          '</Box>'
        );
      }
    } else {
      for (const c of kids) emit(c, w, ctx);
    }
  };

  const open = () => {
    const el = isModal ? 'ModalBox' : 'Box';
    if (!isModal && !kids.length) w.line(tag(el, finalAttrs, true));
    else if (root) {
      // The content of the screen scrolls inside the frame when it is taller than the terminal.
      w.wrap(
        tag(el, finalAttrs),
        () => w.wrap(tag('ScrollArea', flexAttrs(n)), body, '</ScrollArea>'),
        `</${el}>`
      );
    } else w.wrap(tag(el, finalAttrs), body, `</${el}>`);
  };
  if (isModal && !h) {
    const state = ctx.names.take(`${recase(n.ident, 'camel')}Open`);
    const setter = ctx.names.take(`set${cap(state)}`);
    ctx.states.push(`const [${state}, ${setter}] = useState(true);`);
    ctx.modalStates.push(`${setter}(false);`);
    w.line(`{${state} && (`).indent();
    open();
    w.dedent().line(')}');
  } else {
    if (isModal && h) ctx.modalStates.push(`core.setOpen(${jsStr(h.tag)}, false);`);
    open();
  }
}

/**
 * Components that fill the width of their parent unless they have a size of their own (like
 * Textual's Select, OptionList and Tabs): full width in a column, growing in a row.
 */
const FILLS = new Set<ComponentType>(['Select', 'List', 'Menu', 'Tree', 'Tabs']);

function fillAttrs(n: IRNode): string[] {
  const p = n.parent;
  if (!FILLS.has(n.type) || n.width !== 'auto' || !p || p.layout.mode === 'absolute') return [];
  return [p.layout.mode === 'flex' && p.layout.direction === 'row' ? 'flexGrow={1}' : 'width="100%"'];
}

function dedupeWrap(
  n: IRNode,
  w: CodeWriter,
  extra: string[],
  inner: () => void,
  padding = true
): void {
  const attrs = [
    ...sizeAttrs(n, parentDirection(n)),
    ...fillAttrs(n),
    ...(padding ? paddingAttrs(n) : []),
    ...borderAttrs(n),
    ...absoluteAttrs(n),
    ...extra,
  ];
  if (attrs.length) w.wrap(tag('Box', attrs), inner, '</Box>');
  else inner();
}

function stateName(ctx: Ctx, n: IRNode, suffix = ''): { state: string; setter: string } {
  const state = ctx.names.take(recase(n.ident, 'camel') + suffix);
  return { state, setter: ctx.names.take(`set${cap(state)}`) };
}

function emitLeaf(n: IRNode, w: CodeWriter, ctx: Ctx): void {
  const h = ctx.handles.get(n.id);
  const T = h ? jsStr(h.tag) : '';
  /** Expression reading a property of the handle from the store. */
  const rd = (kind: 'str' | 'num' | 'bool' | 'list' | 'rows', prop: string) =>
    `core.${kind}(${T}, ${jsStr(prop)})`;
  const dimExpr = h ? `core.state(${T}) === "muted"` : n.disabled ? 'true' : '';
  const dimAttr = h ? ` dimColor={${dimExpr}}` : n.disabled ? ' dimColor' : '';
  const ta = textAttrs(n);
  const to = textObj(n);
  /** The Text attributes object for helper components. */
  const props =
    to || dimExpr
      ? `{ ${[to ? to.slice(2, -2) : '', dimExpr ? `dimColor: ${dimExpr}` : ''].filter(Boolean).join(', ')} }`
      : null;
  const staticText = () => w.line(`<Text${ta}${dimAttr}>{${jsStr(inlineText(n))}}</Text>`);
  const focusable = ['Button', 'Checkbox', 'Radio', 'Toggle', 'TextInput', 'Select'];
  if (n.disabled && !h && focusable.includes(n.type)) {
    return dedupeWrap(n, w, [], staticText);
  }
  const wrap = (inner: () => void, extra: string[] = [], padding = true) =>
    dedupeWrap(n, w, extra, inner, padding);
  if (props) ctx.uses.textProps = true;

  switch (n.type) {
    case 'Spacer': {
      const attrs = [...sizeAttrs(n, parentDirection(n)), ...absoluteAttrs(n)];
      if (!attrs.some((a) => /^(width|height|flexGrow)/.test(a))) attrs.unshift('flexGrow={1}');
      w.line(tag('Box', attrs, true));
      return;
    }
    case 'Text': {
      const sized = n.width !== 'auto';
      const justify =
        sized && n.textAlign !== 'left'
          ? [`justifyContent=${jsStr(n.textAlign === 'center' ? 'center' : 'flex-end')}`]
          : [];
      const truncate = sized && !n.wrapText ? ' wrap="truncate-end"' : '';
      const content = h ? rd('str', 'text') : jsStr(n.text);
      return wrap(() => w.line(`<Text${ta}${truncate}>{${content}}</Text>`), justify);
    }
    case 'Button': {
      ctx.uses.focus = true;
      const press = arrow('', guarded(h ? `core.fire(${T}, "click")` : null, calls(ctx, n)));
      const label = h
        ? `${jsStr(` ${n.iconLeft ? n.iconLeft + ' ' : ''}`)} + ${rd('str', 'label')} + ${jsStr(`${n.iconRight ? ' ' + n.iconRight : ''} `)}`
        : jsStr(` ${inlineText(n)} `);
      // Like Textual's Button: the label is centred, at least 16 cells wide with a border (the
      // editor's padding is only the space around the label), one row without a border.
      return wrap(
        () => {
        w.wrap(
          `<Focusable center onPress={${press}}>`,
          () => {
            w.line('{(focused) => (').indent();
            w.line(
              `<Text bold${ta.replace(' bold', '')}${dimAttr} inverse={focused}>{${label}}</Text>`
            );
            w.dedent().line(')}');
          },
          '</Focusable>'
        );
        },
        typeof n.width === 'number' || !n.style.border ? [] : ['minWidth={16}'],
        false
      );
    }
    case 'Checkbox':
    case 'Radio':
    case 'Toggle': {
      ctx.uses.focus = true;
      let isOn: string;
      let press: string;
      if (h) {
        isOn = rd('bool', 'checked');
        const set = `core.user(${T}, "checked", ${n.type === 'Radio' ? 'true' : `!${isOn}`}, "change")`;
        const siblings =
          n.type === 'Radio' && n.parent
            ? shownChildren(n.parent, ctx)
                .filter((c) => c !== n && c.type === 'Radio' && ctx.handles.has(c.id))
                .map((c) => `core.setProp(${jsStr(ctx.handles.get(c.id)!.tag)}, "checked", false);`)
            : [];
        press = arrow('', guarded(set, [...siblings, ...calls(ctx, n)]));
      } else if (n.type === 'Radio') {
        const parent = n.parent;
        const key = parent ? parent.id : 'root';
        let group = ctx.radioGroups.get(key);
        if (!group) {
          group = stateName(ctx, n, 'Choice');
          const first = parent
            ? shownChildren(parent, ctx).find((c) => c.type === 'Radio' && c.checked)
            : undefined;
          ctx.states.push(
            `const [${group.state}, ${group.setter}] = useState<string | null>(${first ? jsStr(recase(first.ident, 'camel')) : 'null'});`
          );
          ctx.radioGroups.set(key, group);
        }
        isOn = `${group.state} === ${jsStr(recase(n.ident, 'camel'))}`;
        press = arrow('', [
          `${group.setter}(${jsStr(recase(n.ident, 'camel'))});`,
          ...calls(ctx, n),
        ]);
      } else {
        const s = stateName(ctx, n);
        ctx.states.push(`const [${s.state}, ${s.setter}] = useState(${n.checked});`);
        isOn = s.state;
        press = arrow('', [`${s.setter}((v) => !v);`, ...calls(ctx, n)]);
      }
      const glyph =
        n.type === 'Toggle'
          ? `${isOn} ? "[ON ]" : "[OFF]"`
          : `${n.type === 'Radio' ? '"(" + ' : '"[" + '}(${isOn} ? ${jsStr(n.glyphs.on)} : ${jsStr(n.glyphs.off)}) + ${n.type === 'Radio' ? '")"' : '"]"'}`;
      const gcol =
        n.style.checkedColor || n.style.uncheckedColor
          ? ` color={${isOn} ? ${n.style.checkedColor ? jsStr(n.style.checkedColor) : 'void 0'} : ${n.style.uncheckedColor ? jsStr(n.style.uncheckedColor) : 'void 0'}}`
          : '';
      const lcol = n.style.labelColor ? ` color=${jsStr(n.style.labelColor)}` : '';
      const label = h ? `" " + ${rd('str', 'label')}` : jsStr(' ' + n.text);
      return wrap(() => {
        w.wrap(
          `<Focusable onPress={${press}}>`,
          () => {
            w.line('{(focused) => (').indent();
            w.line(`<Text${ta}${dimAttr} inverse={focused}>`).indent();
            w.line(`<Text${gcol}>{${glyph}}</Text>`);
            w.line(`<Text${lcol}>{${label}}</Text>`);
            w.dedent().line('</Text>');
            w.dedent().line(')}');
          },
          '</Focusable>'
        );
      });
    }
    case 'TextInput': {
      ctx.uses.field = true;
      ctx.uses.focus = true;
      let value: string;
      let change: string;
      let submit: string | null;
      let placeholder = jsStr(n.placeholder);
      if (h) {
        value = rd('str', 'value');
        placeholder = rd('str', 'placeholder');
        change = arrow(
          'v: string',
          guarded(`core.user(${T}, "value", v, "change")`, calls(ctx, n, /change/i))
        );
        submit = arrow(
          '',
          guarded(`core.fire(${T}, "submit", ${value})`, calls(ctx, n, undefined, /change/i))
        );
      } else {
        const s = stateName(ctx, n);
        ctx.states.push(`const [${s.state}, ${s.setter}] = useState(${jsStr(n.value)});`);
        value = s.state;
        change = arrow('v: string', [`${s.setter}(v);`, ...calls(ctx, n, /change/i)]);
        const sub = calls(ctx, n, undefined, /change/i);
        submit = sub.length ? arrow('', sub) : null;
      }
      return wrap(() =>
        w.line(
          `<Field value={${value}} onChange={${change}}${submit ? ` onSubmit={${submit}}` : ''} placeholder={${placeholder}}${props ? ` textProps={${props}}` : ''} />`
        )
      );
    }
    case 'Select': {
      ctx.uses.dropdown = true;
      ctx.uses.focus = true;
      let value: string;
      let opts: string;
      let change: string;
      if (h) {
        value = rd('str', 'value');
        opts = rd('list', 'options');
        change = arrow(
          'v: string',
          guarded(`core.user(${T}, "value", v, "change")`, calls(ctx, n))
        );
      } else {
        const s = stateName(ctx, n);
        ctx.states.push(
          `const [${s.state}, ${s.setter}] = useState(${jsStr(n.value || n.options[0] || '')});`
        );
        value = s.state;
        opts = `[${n.options.map(jsStr).join(', ')}]`;
        change = arrow('v: string', [`${s.setter}(v);`, ...calls(ctx, n)]);
      }
      return wrap(() =>
        w.line(
          `<Dropdown options={${opts}} value={${value}} onChange={${change}}${h ? ` disabled={core.state(${T}) !== "active"}` : ''}${props ? ` textProps={${props}}` : ''} />`
        )
      );
    }
    case 'List':
    case 'Menu':
    case 'Tabs':
    case 'Tree': {
      ctx.uses.choices = true;
      ctx.uses.focus = true;
      const horizontal = n.type === 'Tabs' || (n.type === 'Menu' && n.layout.direction === 'row');
      const staticLines =
        n.type === 'Tree'
          ? treeLines(n.items).map((l) => l.text)
          : n.type === 'Tabs'
            ? n.items.map(
                (i) =>
                  `${i.icon ? i.icon + ' ' : ''}${i.label}${i.status ? ' ●' : ''}${i.hotkey ? ' ' + i.hotkey : ''}`
              )
            : n.items.map((i) => itemText(i));
      const lines =
        h && n.type === 'List' ? rd('list', 'items') : `[${staticLines.map(jsStr).join(', ')}]`;
      const prop = n.type === 'Tabs' ? 'active_tab' : 'selected';
      let selected: string;
      let select: string;
      let activate: string | null;
      if (h && n.type !== 'Tree') {
        selected = rd('num', prop);
        select =
          n.type === 'Tabs'
            ? arrow(
                'i: number',
                guarded(`core.user(${T}, ${jsStr(prop)}, i, "change")`, calls(ctx, n))
              )
            : arrow('i: number', [`core.user(${T}, ${jsStr(prop)}, i);`]);
        activate =
          n.type === 'Tabs'
            ? null
            : arrow('', guarded(`core.fire(${T}, "select", ${selected})`, calls(ctx, n)));
      } else {
        const s = stateName(ctx, n, n.type === 'Tabs' ? 'Tab' : 'Selected');
        const init = Math.max(0, Math.min(n.selected, Math.max(0, staticLines.length - 1)));
        ctx.states.push(`const [${s.state}, ${s.setter}] = useState(${init});`);
        selected = s.state;
        select =
          n.type === 'Tabs' ? arrow('i: number', [`${s.setter}(i);`, ...calls(ctx, n)]) : s.setter;
        const c = calls(ctx, n);
        activate =
          n.type === 'Tabs'
            ? null
            : h
              ? arrow('i: number', guarded(`core.fire(${T}, "select", i)`, c))
              : c.length
                ? arrow('', c)
                : null;
      }
      return wrap(() =>
        w.line(
          `<Choices lines={${lines}} selected={${selected}} onSelect={${select}}${activate ? ` onActivate={${activate}}` : ''}${horizontal ? ' horizontal' : ''}${n.type === 'Tabs' ? ' tabs' : ''}${h ? ` disabled={core.state(${T}) !== "active"}` : ''}${props ? ` textProps={${props}}` : ''} />`
        )
      );
    }
    case 'Spinner': {
      ctx.uses.spinner = true;
      const label = h
        ? `" " + (${rd('str', 'label')} || "Loading...")`
        : jsStr(' ' + (n.text || 'Loading...'));
      return wrap(() => w.line(`<Text${ta}${dimAttr}><Spinner type="dots" />{${label}}</Text>`));
    }
    case 'ProgressBar': {
      // One row: the bar fills what is left of the box after the border and " 100%".
      const outer = typeof n.width === 'number' ? n.width : 20;
      const width = Math.max(1, outer - (n.style.border ? 2 : 0) - 5);
      if (h) {
        ctx.uses.bar = true;
        return wrap(() =>
          w.line(
            `<Text${ta}${dimAttr}>{bar(${rd('num', 'value')}, ${rd('num', 'max')}, ${width})}</Text>`
          )
        );
      }
      const pct = Math.round(Math.max(0, Math.min(1, n.progress.value / n.progress.max)) * 100);
      return wrap(() =>
        w.line(`<Text${ta}>{${jsStr(`${progressText(n, width)}${`${pct}%`.padStart(5)}`)}}</Text>`)
      );
    }
    case 'Table': {
      if (h) {
        ctx.uses.table = true;
        return wrap(() =>
          w.wrap(
            '<Box flexDirection="column">',
            () => {
              w.line(
                `{tableLines(${rd('list', 'columns')}, ${rd('rows', 'rows')}).map((line, i) => (`
              ).indent();
              w.line(`<Text key={i}${ta}${dimAttr} bold={i === 0}>{line}</Text>`);
              w.dedent().line('))}');
            },
            '</Box>'
          )
        );
      }
      const clean = (s: string) => s.replace(/\s+/g, ' ');
      const cols = n.columns.length ? n.columns.map(clean) : [];
      const rows = n.rows.map((r) => cols.map((_, i) => clean(r[i] ?? '')));
      const widths = cols.map((c, i) =>
        Math.max([...c].length, ...rows.map((r) => [...r[i]].length))
      );
      const fmt = (cells: string[]) =>
        ' ' + cells.map((c, i) => c + ' '.repeat(widths[i] - [...c].length)).join('  ') + ' ';
      return wrap(() => {
        w.wrap(
          '<Box flexDirection="column">',
          () => {
            w.line(`<Text${ta.replace(' bold', '')} bold>{${jsStr(fmt(cols))}}</Text>`);
            for (const r of rows) w.line(`<Text${ta}>{${jsStr(fmt(r))}}</Text>`);
          },
          '</Box>'
        );
      });
    }
    default:
      // Breadcrumb and anything else textual.
      return wrap(() => w.line(`<Text${ta}>{${jsStr(inlineText(n))}}</Text>`));
  }
}

// ── Static pieces of the generated file ───────────────────────────────────────

const CONTEXT = `// The store of the program API; components read it and write the user's input into it.
const CoreContext = createContext<UiCore | null>(null);
// 0 for the screen, 1 inside a modal (while a modal is shown only its components get clicks).
const LayerContext = createContext(0);

/** True while the error dialog is open: the UI behind it does not react to keys. */
function useBlocked(): () => boolean {
  const core = useContext(CoreContext);
  return () => !!core && core.pending.length > 0;
}

// Makes the element behind the returned ref clickable: \`onClick\` gets the cell that was hit.
function useHit(onClick: (x: number, y: number) => void) {
  const core = useContext(CoreContext);
  const layer = useContext(LayerContext);
  const ref = useRef<DOMElement>(null);
  const latest = useRef(onClick);
  latest.current = onClick;
  useEffect(() => core?.addHit({ ref, layer, cb: (x, y) => latest.current(x, y) }), [core, layer]);
  return ref;
}

// Scrolls the screen so that a focused component is in view.
function useReveal(ref: { current: unknown }, active: boolean) {
  const core = useContext(CoreContext);
  useEffect(() => {
    if (!active || !core) return;
    const r = rectOf(ref.current);
    if (r) core.reveal(r.y, r.y + r.height);
  }, [active, core]);
}

// The content of the screen: taller than the terminal it is shifted up (negative margin) inside a
// clipping box; a thin scroll bar shows on the right while there is something to scroll.
function ScrollArea({ children, ...props }: BoxProps & { children?: ReactNode }) {
  const core = useContext(CoreContext);
  const view = useRef<DOMElement>(null);
  const content = useRef<DOMElement>(null);
  useEffect(() => {
    if (!core || !view.current || !content.current) return;
    core.viewRef = view;
    const box = measureElement(view.current);
    core.setMetrics(measureElement(content.current).height, box.height, box.width);
  });
  const offset = core ? core.scroll : 0;
  const rows = core ? core.viewHeight : 0;
  const total = core ? core.contentHeight : 0;
  const thumb = Math.max(1, Math.round((rows * rows) / Math.max(1, total)));
  const top = total > rows ? Math.round((offset / (total - rows)) * (rows - thumb)) : 0;
  return (
    <Box flexGrow={1} flexDirection="row">
      <Box ref={view} flexGrow={1} flexDirection="column" overflow="hidden">
        <Box ref={content} flexShrink={0} minHeight={rows} marginTop={-offset} {...props}>
          {children}
        </Box>
      </Box>
      {total > rows ? (
        <Box flexDirection="column" width={1} flexShrink={0}>
          {Array.from({ length: rows }, (_, i) => (
            <Text key={i} dimColor={i < top || i >= top + thumb}>
              {i >= top && i < top + thumb ? "█" : "│"}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

// A modal: it is centred over the visible screen (not scrolled with the content), its box
// swallows clicks and its components are the only clickable ones.
function ModalBox({ children, ...props }: BoxProps & { children?: ReactNode }) {
  const core = useContext(CoreContext);
  const ref = useRef<DOMElement>(null);
  useEffect(() => core?.addHit({ ref, layer: 1, modal: true, cb: () => {} }), [core]);
  const wide = typeof props.width === "number" ? props.width : 0;
  const high = typeof props.height === "number" ? props.height : 0;
  const scroll = core ? core.scroll : 0;
  const left = core && wide ? Math.max(0, Math.floor((core.viewWidth - wide) / 2)) : (props.marginLeft ?? 0);
  const top = core && high ? Math.max(0, Math.floor((core.viewHeight - high) / 2)) + scroll : (props.marginTop ?? 0) + scroll;
  return (
    <LayerContext.Provider value={1}>
      <Box ref={ref} {...props} marginLeft={left} marginTop={top}>
        {children}
      </Box>
    </LayerContext.Provider>
  );
}
`;

const FOCUSABLE = `// Something Tab can focus; Enter or Space (or a click) presses it.
function Focusable({ onPress, center, children }: { onPress: () => void; center?: boolean; children: (focused: boolean) => ReactNode }) {
  const id = useId();
  const { isFocused, focus } = useFocus({ id });
  const blocked = useBlocked();
  useInput(
    (input, key) => {
      if (blocked()) return;
      if (key.return || input === " ") onPress();
    },
    { isActive: isFocused },
  );
  const ref = useHit(() => {
    focus(id);
    onPress();
  });
  useReveal(ref, isFocused);
  return (
    <Box ref={ref} flexGrow={1} {...(center ? { justifyContent: "center" as const } : {})}>
      {children(isFocused)}
    </Box>
  );
}
`;

const FIELD = `// True while a text field has the focus, so that typing "q" does not quit the app.
let typing = false;

// A one-line text field (the cursor is always at the end); a click focuses it. The text is
// indented by two cells like Textual's Input.
function Field({ value, onChange, onSubmit, placeholder, textProps }: { value: string; onChange: (value: string) => void; onSubmit?: () => void; placeholder: string; textProps?: TextProps }) {
  const id = useId();
  const { isFocused, focus } = useFocus({ id });
  const blocked = useBlocked();
  useEffect(() => {
    typing = isFocused;
    return () => {
      typing = false;
    };
  }, [isFocused]);
  useInput(
    (input, key) => {
      if (blocked()) return;
      if (key.return) onSubmit?.();
      else if (key.backspace || key.delete) onChange([...value].slice(0, -1).join(""));
      else if (key.ctrl || key.meta || key.tab || key.escape || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;
      else if (input) onChange(value + input);
    },
    { isActive: isFocused },
  );
  const ref = useHit(() => focus(id));
  useReveal(ref, isFocused);
  return (
    <Box ref={ref} flexGrow={1} paddingLeft={2}>
      <Text {...textProps}>
        {value ? value : <Text dimColor>{placeholder}</Text>}
        {isFocused ? <Text inverse> </Text> : null}
      </Text>
    </Box>
  );
}
`;

const DROPDOWN = `// Closed it shows the value; Enter or a click opens the list (arrow keys or a click to choose, Esc to close).
function Dropdown({ options, value, onChange, disabled, textProps }: { options: string[]; value: string; onChange: (value: string) => void; disabled?: boolean; textProps?: TextProps }) {
  const id = useId();
  const { isFocused, focus } = useFocus({ id });
  const blocked = useBlocked();
  const [open, setOpen] = useState(false);
  useInput(
    (_input, key) => {
      if (key.return && !disabled && !blocked()) setOpen(true);
    },
    { isActive: isFocused && !open },
  );
  useInput(
    (_input, key) => {
      if (key.escape) setOpen(false);
    },
    { isActive: open },
  );
  const ref = useHit((_x, y) => {
    focus(id);
    if (disabled) return;
    const top = rectOf(ref.current)?.y ?? y;
    if (!open) setOpen(true);
    else if (y - top >= 0 && y - top < options.length) {
      onChange(options[y - top]);
      setOpen(false);
    }
  });
  useReveal(ref, isFocused);
  return (
    <Box ref={ref} flexGrow={1}>
      {open ? (
        <SelectInput
          items={options.map((o) => ({ label: o, value: o }))}
          initialIndex={Math.max(0, options.indexOf(value))}
          onSelect={(item) => {
            onChange(item.value);
            setOpen(false);
          }}
        />
      ) : (
        <Box flexGrow={1} paddingX={2}>
          <Text {...textProps} inverse={isFocused}>
            {value}
          </Text>
          <Box flexGrow={1} />
          <Text {...textProps}>▼</Text>
        </Box>
      )}
    </Box>
  );
}
`;

const CHOICES = `// A list, menu, tree or tab bar: arrow keys move the selection while it has the focus; a click
// selects (and activates) the item under the mouse.
function Choices({ lines, selected, onSelect, onActivate, horizontal, tabs, disabled, textProps }: { lines: string[]; selected: number; onSelect: (index: number) => void; onActivate?: (index: number) => void; horizontal?: boolean; tabs?: boolean; disabled?: boolean; textProps?: TextProps }) {
  const id = useId();
  const { isFocused, focus } = useFocus({ id });
  const blocked = useBlocked();
  const items = useRef<(DOMElement | null)[]>([]);
  useInput(
    (_input, key) => {
      if (!lines.length || disabled || blocked()) return;
      const prev = horizontal ? key.leftArrow : key.upArrow;
      const next = horizontal ? key.rightArrow : key.downArrow;
      if (prev) onSelect((selected + lines.length - 1) % lines.length);
      else if (next) onSelect((selected + 1) % lines.length);
      else if (key.return) onActivate?.(selected);
    },
    { isActive: isFocused },
  );
  const ref = useHit((x, y) => {
    focus(id);
    if (disabled) return;
    const i = items.current.findIndex((el) => {
      const r = rectOf(el);
      return !!r && x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
    });
    if (i < 0 || i >= lines.length) return;
    onSelect(i);
    if (!tabs) onActivate?.(i);
  });
  useReveal(ref, isFocused);
  const entries = lines.map((line, i) => (
    <Box
      key={i}
      ref={(el) => {
        items.current[i] = el;
      }}
    >
      <Text {...textProps} inverse={tabs ? i === selected && isFocused : i === selected} bold={i === selected || textProps?.bold}>
        {tabs ? " " + line + " " : line}
      </Text>
    </Box>
  ));
  if (!tabs) {
    return (
      <Box ref={ref} flexGrow={1} flexDirection={horizontal ? "row" : "column"} gap={horizontal ? 2 : 0}>
        {entries}
      </Box>
    );
  }
  // Tabs sit next to each other (one cell of padding each); the row below is the underline,
  // with the end caps of the active tab.
  const widths = lines.map((l) => [...l].length + 2);
  const before = widths.slice(0, selected).reduce((a, b) => a + b, 0);
  const span = widths[selected] ?? 0;
  const bar = "━";
  return (
    <Box ref={ref} flexGrow={1} flexDirection="column">
      <Box flexDirection="row">{entries}</Box>
      <Box height={1} overflow="hidden">
        <Box flexShrink={0}>
          <Box flexShrink={0}>
            <Text dimColor>{bar.repeat(before)}</Text>
          </Box>
          <Box flexShrink={0}>
            <Text color={textProps?.color}>{span > 1 ? "╸" + bar.repeat(span - 2) + "╺" : bar.repeat(span)}</Text>
          </Box>
          <Box flexShrink={0}>
            <Text dimColor>{bar.repeat(400)}</Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
`;

const BAR = `function bar(value: number, max: number, width: number): string {
  const ratio = Math.max(0, Math.min(1, max ? value / max : 0));
  const filled = Math.round(ratio * width);
  return "█".repeat(filled) + "░".repeat(width - filled) + (Math.round(ratio * 100) + "%").padStart(5);
}
`;

const TABLE = `// Header and rows with every column as wide as its longest cell, separated by two spaces.
function tableLines(columns: string[], rows: string[][]): string[] {
  const clean = (s: string) => s.replace(/\\s+/g, " ");
  const head = columns.map(clean);
  const body = rows.map((r) => head.map((_, i) => clean(r[i] ?? "")));
  const widths = head.map((c, i) => Math.max([...c].length, ...body.map((r) => [...r[i]].length)));
  const fmt = (cells: string[]) => " " + cells.map((c, i) => c + " ".repeat(widths[i] - [...c].length)).join("  ") + " ";
  return [fmt(head), ...body.map(fmt)];
}
`;

const CHROME = `// The error dialog (laid over the UI; Enter, Esc or a click closes it) and the log panel (Ctrl+L).
function Dialog({ entries }: { entries: ErrorEntry[] }) {
  const clip = (s: string) => (s.length > 64 ? s.slice(0, 63) + "…" : s);
  const lines = [" Error ", ...entries.flatMap((e) => e.message.split("\\n").map((l) => " " + clip(l) + " ")), " Enter / Esc: close "];
  const width = Math.max(...lines.map((l) => [...l].length));
  return (
    <Box position="absolute" marginLeft={2} marginTop={1} flexDirection="column" borderStyle="double" borderColor="red">
      {lines.map((l, i) => (
        <Text key={i} bold={i === 0} color={i === 0 ? "red" : void 0}>
          {l + " ".repeat(width - [...l].length)}
        </Text>
      ))}
    </Box>
  );
}

// Bottom of the screen, laid over the UI; every line is padded so that nothing shows through.
function LogPanel({ entries, columns, rows }: { entries: LogEntry[]; columns: number; rows: number }) {
  const inner = Math.max(1, columns - 2);
  const fit = (s: string) => {
    const t = [...s].slice(0, inner).join("");
    return t + " ".repeat(inner - [...t].length);
  };
  const shown = entries.slice(-6);
  return (
    <Box position="absolute" marginTop={Math.max(0, rows - 9)} width={columns} flexDirection="column" borderStyle="single" borderColor="gray">
      <Text bold>{fit(" Log (Ctrl+L closes) ")}</Text>
      {Array.from({ length: 6 }, (_, i) => {
        const e = shown[i];
        return (
          <Text key={i} color={e && e.level === "error" ? "red" : e && e.level === "warning" ? "yellow" : void 0}>
            {fit(e ? " [" + e.level + "] " + e.message.replace(/\\s+/g, " ") : "")}
          </Text>
        );
      })}
    </Box>
  );
}
`;

// ── Project files ─────────────────────────────────────────────────────────────

const UI_BASE_MEMBERS = new Set([
  'api',
  'core',
  'log',
  'ready',
  'running',
  'errors',
  'markReady',
  'start',
  'run',
  'stop',
  'wait',
  'report',
  'nextEvent',
  'installExcepthooks',
  'element',
  'options',
  'closed',
  'app',
  'closeNow',
  'readyNow',
  'readyPromise',
  'close',
]);

const HANDLE_CLASS: Partial<Record<ComponentType, string>> = {
  Screen: 'ContainerHandle',
  Box: 'ContainerHandle',
  Grid: 'ContainerHandle',
  Spacer: 'ContainerHandle',
  Breadcrumb: 'ContainerHandle',
};

function lit(v: unknown): string {
  if (typeof v === 'string') return jsStr(v);
  if (Array.isArray(v)) return `[${v.map(lit).join(', ')}]`;
  return String(v);
}

function generateApp(screen: IRScreen, allHandles: ApiHandleModel[]): string {
  const ctx: Ctx = {
    names: new Names(),
    states: [],
    handlers: new Map(),
    radioGroups: new Map(),
    modalStates: [],
    handles: new Map(allHandles.map((h) => [h.node.id, h])),
    uses: {
      focus: false,
      field: false,
      dropdown: false,
      choices: false,
      spinner: false,
      textProps: false,
      bar: false,
      table: false,
    },
  };
  // Components that are not part of the initial UI (inactive tab/menu bodies) have no handle.
  const handles = allHandles.filter((h) => shown(h.node, ctx));
  ctx.handles = new Map(handles.map((h) => [h.node.id, h]));
  const jsx = new CodeWriter('  ', 2);
  emit(screen.root, jsx, ctx, screen);
  const u = ctx.uses;

  const out = new CodeWriter();
  out.line('// Generated by TUI Studio (Ink).');
  out.line('//');
  out.line(
    '// Run:   npm install && npm start   (Node 18+; Tab moves the focus, q or Ctrl+C quits)'
  );
  out.line(
    '// Layout: native flexbox (Yoga); absolute containers use position="absolute" + margins.'
  );
  out.line(
    '// Edit the handler functions below; they are called when the matching widget is used.'
  );
  out.line('//');
  out.line('// Program API: use this UI from your own code (see ui-runtime.ts):');
  out.line('//   import { Ui } from "./app";');
  out.line('//   const ui = new Ui();');
  out.line('//   await ui.start();                 // the UI runs next to your program');
  out.line(
    '//   ui.log.info("hello");             // Ctrl+L shows the log, ui.report(err) opens a dialog'
  );
  out.line('//   await ui.wait();');
  out.line();
  out.line(
    'import { createContext, useContext, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";'
  );
  out.line('import type { ReactElement, ReactNode } from "react";');
  out.line(
    'import { Box, Text, measureElement, useInput, useFocus, useStdin, useStdout } from "ink";'
  );
  out.line('import type { BoxProps, DOMElement, TextProps } from "ink";');
  if (u.dropdown) out.line('import SelectInput from "ink-select-input";');
  if (u.spinner) out.line('import Spinner from "ink-spinner";');
  out.line('import { pathToFileURL } from "node:url";');
  const classes = [
    ...new Set(handles.map((h) => HANDLE_CLASS[h.type] ?? `${h.type}Handle`)),
  ].sort();
  out.line(
    `import { UiBase, rectOf, ${classes.join(', ')}${classes.length ? ', ' : ''}type ErrorEntry, type HandleSpec, type UiCore, type LogEntry, type UiOptions } from "./ui-runtime";`
  );
  out.line('export * from "./ui-runtime";');
  if (handles.length) out.line('import { Api } from "./api";');
  out.line();
  if (ctx.handlers.size) {
    for (const fn of ctx.handlers.values()) out.line(`function ${fn}() { /* TODO */ }`);
    out.line();
  }
  out.block(CONTEXT).line();
  if (u.focus) out.block(FOCUSABLE).line();
  if (u.field) out.block(FIELD).line();
  if (u.dropdown) out.block(DROPDOWN).line();
  if (u.choices) out.block(CHOICES).line();
  if (u.bar) out.block(BAR).line();
  if (u.table) out.block(TABLE).line();
  out.block(CHROME).line();

  // The facade: one typed handle per code name.
  const memberNames = inkMembers(handles);
  const named = handles.map((h) => [memberNames.get(h)!, h] as const);
  out.line('const SPECS: HandleSpec[] = [').indent();
  for (const h of handles) {
    const props = h.properties
      .map((p) => {
        // A select shows its first option until the user picks one.
        const initial =
          h.type === 'Select' && p.name === 'value' && !p.initial
            ? (h.node.options[0] ?? '')
            : p.initial;
        return `${p.name}: { type: ${jsStr(p.type)}, value: ${lit(initial)} }`;
      })
      .join(', ');
    out.line(
      `{ tag: ${jsStr(h.tag)}, type: ${jsStr(h.type)}, states: [${h.states.map(jsStr).join(', ')}], state: ${jsStr(h.initialState)}, props: { ${props} }${h.type === 'Modal' ? `, open: false` : ''} },`
    );
  }
  out.dedent().line('];');
  out.line();
  out.line('/** The program API of this design: one handle per code name. */');
  out.line('export class Ui extends UiBase {').indent();
  for (const [name, h] of named) {
    out.line(`readonly ${name}: ${HANDLE_CLASS[h.type] ?? `${h.type}Handle`};`);
  }
  if (handles.length) out.line('/** Flat methods over the components (see api.ts). */').line('readonly api: Api;');
  out.line('constructor(options?: UiOptions) {').indent();
  out.line('super(SPECS, options);');
  for (const [name, h] of named) {
    out.line(
      `this.${name} = new ${HANDLE_CLASS[h.type] ?? `${h.type}Handle`}(this.core, ${jsStr(h.tag)});`
    );
  }
  if (handles.length) out.line('this.api = new Api(this);');
  out.dedent().line('}');
  out.line('protected element(): ReactElement {').indent();
  out.line('return <App ui={this} />;');
  out.dedent().line('}');
  out.dedent().line('}');
  out.line();

  out.line('export function App({ ui }: { ui: Ui }) {').indent();
  out.line('const core = ui.core;');
  out.line('useSyncExternalStore(core.subscribe, core.snapshot);');
  out.line('useEffect(() => ui.markReady(), [ui]);');
  out.line('// The root fills the terminal and follows its size.');
  out.line('const { stdout } = useStdout();');
  out.line('const { stdin } = useStdin();');
  out.line(
    `const measure = () => ({ columns: stdout.columns || ${screen.width}, rows: stdout.rows || ${screen.height} });`
  );
  out.line('const [size, setSize] = useState(measure);');
  out.line('const { columns: cols, rows } = size;');
  out.line('useEffect(() => {').indent();
  out.line('const onResize = () => setSize(measure());');
  out.line('onResize();');
  out.line('stdout.on("resize", onResize);');
  out.line('return () => {').indent();
  out.line('stdout.off("resize", onResize);');
  out.dedent().line('};');
  out.dedent().line('}, [stdout]);');
  out.line(
    '// Mouse reporting: clicks are taken out of the input and hit-tested against the elements.'
  );
  out.line('useEffect(() => ui.attachTerminal(stdin, stdout), [ui, stdin, stdout]);');
  for (const s of ctx.states) out.line(s);
  out.line('useInput((input, key) => {').indent();
  out.line('if (core.pending.length) {').indent();
  out.line('// Enter or Esc closes the dialog (after this key has been seen by everything else).');
  out.line('if (key.return || key.escape) setImmediate(() => core.dismissDialog());');
  out.line('return;');
  out.dedent().line('}');
  out.line(`if (input === "q"${u.field ? ' && !typing' : ''}) ui.stop();`);
  out.line('if (key.ctrl && input === "l") core.toggleLog();');
  out.line('// Scrolling: PageUp/PageDown always, Home/End unless a text field has the focus.');
  out.line('if (key.pageUp) core.scrollBy(-Math.max(1, core.viewHeight - 1));');
  out.line('else if (key.pageDown) core.scrollBy(Math.max(1, core.viewHeight - 1));');
  out.line(`else if (${u.field ? '!typing && ' : ''}key.home) core.scrollTo(0);`);
  out.line(`else if (${u.field ? '!typing && ' : ''}key.end) core.scrollTo(core.maxScroll());`);
  if (ctx.modalStates.length) {
    out.line('if (key.escape) {').indent();
    for (const s of ctx.modalStates) out.line(s);
    out.dedent().line('}');
  }
  out.dedent().line('});');
  out.line('return (');
  out.line('  <CoreContext.Provider value={core}>');
  out.line('    <Box flexDirection="column">');
  out.block(jsx.toString().trimEnd().replace(/^/gm, '    '));
  out.line(
    '      {core.logOpen ? <LogPanel entries={core.logEntries} columns={cols} rows={rows} /> : null}'
  );
  out.line('      {core.pending.length ? <Dialog entries={core.pending} /> : null}');
  out.line('    </Box>');
  out.line('  </CoreContext.Provider>');
  out.line(');');
  out.dedent().line('}');
  out.line();
  out.line('// Started directly (npm start): show the UI until it is closed.');
  out
    .line('if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {')
    .indent();
  out.line('const ui = new Ui();');
  out.line('await ui.start();');
  out.line('await ui.wait();');
  out.dedent().line('}');
  return out.toString();
}

function packageJson(screen: IRScreen, app: string): string {
  const slug = screen.ident.replace(/_/g, '-').replace(/^[^a-z0-9]+/, '') || 'app';
  const deps: Record<string, string> = { ink: '6.8.0', react: '19.2.0' };
  if (app.includes('"ink-select-input"')) deps['ink-select-input'] = '6.2.0';
  if (app.includes('"ink-spinner"')) deps['ink-spinner'] = '5.0.0';
  return (
    JSON.stringify(
      {
        name: `tui-${slug}`,
        version: '0.1.0',
        private: true,
        type: 'module',
        scripts: { start: 'tsx src/app.tsx', check: 'tsc' },
        dependencies: deps,
        devDependencies: {
          '@types/node': '22.10.2',
          '@types/react': '19.2.2',
          tsx: '4.20.0',
          typescript: '5.9.3',
        },
      },
      null,
      2
    ) + '\n'
  );
}

const TSCONFIG =
  JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        jsx: 'react-jsx',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        noEmit: true,
        types: ['node'],
      },
      include: ['src'],
    },
    null,
    2
  ) + '\n';

/** Member of `ui` per handle: camelCase, keywords and clashes with the base class get a `_`. */
function inkMembers(handles: ApiHandleModel[]): Map<ApiHandleModel, string> {
  const used = new Set<string>();
  const names = new Map<ApiHandleModel, string>();
  for (const h of handles) {
    let name = safeIdent(apiName(h.tag, 'camel'), 'ts');
    while (UI_BASE_MEMBERS.has(name) || used.has(name)) name += '_';
    used.add(name);
    names.set(h, name);
  }
  return names;
}

export const inkAdapter: ExportAdapter = {
  id: 'ink',
  label: 'Ink (React)',
  language: 'tsx',
  verification: 'run',
  multiScreen: false,
  generate: ({ ir }): ExportFile[] => {
    const handles = buildApiModel(ir).handles;
    const app = generateApp(ir.start, handles);
    const names = inkMembers(handles);
    return [
      { path: 'src/app.tsx', content: app },
      { path: 'src/ui-runtime.ts', content: INK_RUNTIME_SOURCE },
      { path: 'package.json', content: packageJson(ir.start, app) },
      { path: 'tsconfig.json', content: TSCONFIG },
      ...(handles.length
        ? [
            {
              path: 'src/api.ts',
              content: renderFacade({ lang: 'ts', handles, member: (h) => names.get(h)! }).code,
            },
          ]
        : []),
    ];
  },
};
