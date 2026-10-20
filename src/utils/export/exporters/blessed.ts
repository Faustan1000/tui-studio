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
import type { IRBox, IRNode, IRScreen, IRStyle } from '../ir';
import { CodeWriter, jsStr } from '../lang';

/** Pinned blessed release. */
export const BLESSED_VERSION = '0.1.81';

const FOCUS_COLOR = '#5fafff';
const HINT_COLOR = '#808080';
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
  'focusables',
  'focusIndex',
  'focusAt',
  'quit',
  'overlayOpen',
  'overlayOpenNow',
  'firstStop',
  'modals',
  'showModal',
  'closeTopModal',
  'dropdown',
  'withPlaceholder',
  'setMark',
  'spin',
  'SPINNER_FRAMES',
];

type Helper = 'dropdown' | 'placeholder' | 'mark' | 'spin';

interface Ctx {
  w: CodeWriter;
  used: Set<string>;
  vars: Map<IRNode, string>;
  /** Handler names in first-use order (deduplicated stubs). */
  handlers: Set<string>;
  focusables: string[];
  modals: string[];
  helpers: Set<Helper>;
}

// ── Public helpers (also used by tests) ───────────────────────────────────────

/** The box a node gets in blessed: relative to the parent's outer box, at least 1x1, whole cells. */
export function blessedPlacement(node: IRNode): IRBox {
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
  return { x: n(b.x), y: n(b.y), width: Math.max(1, n(b.width)), height: Math.max(1, n(b.height)) };
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export const blessedAdapter: ExportAdapter = {
  id: 'blessed',
  label: 'Blessed (Node.js)',
  language: 'js',
  verification: 'syntax',
  multiScreen: false,
  generate: ({ ir }): ExportFile[] => {
    const screen = ir.start;
    return [
      { path: 'index.js', content: generateIndex(screen) },
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
    scripts: { start: 'node index.js' },
    dependencies: { blessed: BLESSED_VERSION },
  };
  return JSON.stringify(pkg, null, 2) + '\n';
}

// ── index.js ──────────────────────────────────────────────────────────────────

function generateIndex(screen: IRScreen): string {
  const root = screen.root;
  const ctx: Ctx = {
    w: new CodeWriter('  ', 0),
    used: new Set<string>([...JS_RESERVED, ...FIXED_NAMES]),
    vars: new Map(),
    handlers: new Set(),
    focusables: [],
    modals: [],
    helpers: new Set(),
  };
  collectHandlers(root, ctx);

  // Body first (it decides which helpers are needed), then the file is assembled.
  const rootVar = nameFor(root, ctx);
  emitWidget(
    root,
    'screen',
    { x: 0, y: 0, width: Math.max(1, screen.width), height: Math.max(1, screen.height) },
    ctx,
    rootVar
  );
  emitChildren(root, rootVar, ctx);
  const body = ctx.w.toString();

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
    .line('//')
    .line(
      '// Layout: SNAPSHOT. Every widget is placed at the cell position and size the editor computed for the'
    )
    .line(
      `//         design size ${screen.width}x${screen.height}. left/top are relative to the parent's outer box`
    )
    .line(
      "//         (autoPadding is off, so a parent's border does not shift its children). The layout does"
    )
    .line('//         not reflow when the terminal is resized.')
    .line(
      '// Limits: blessed only knows "line" and "bg" borders (double, rounded and bold are drawn as line),'
    )
    .line('//         and has no italic or strikethrough.')
    .line("'use strict';")
    .line()
    .line("const blessed = require('blessed');")
    .line()
    .line('const screen = blessed.screen({')
    .indent()
    .line('smartCSR: true,')
    .line('fullUnicode: true,')
    .line('autoPadding: false,')
    .line(`title: ${jsStr(screen.name || screen.ident)},`)
    .line("ignoreLocked: ['C-c'],")
    .dedent()
    .line('});')
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

  emitHelpers(out, ctx);
  out
    .line('// ── Widgets ───────────────────────────────────────────────────────────────────')
    .line();
  out.block(body.replace(/\n$/, ''));
  out.line();
  emitInteraction(out, ctx);
  return out.toString();
}

function emitHelpers(out: CodeWriter, ctx: Ctx): void {
  const h = ctx.helpers;
  if (!h.size && !ctx.modals.length) return;
  out
    .line('// ── Helpers ───────────────────────────────────────────────────────────────────')
    .line();
  if (h.has('dropdown') || ctx.modals.length) out.line('let overlayOpen = false;').line();
  if (h.has('dropdown')) {
    out.block(`/** A closed box that opens a list of options below it (Select). */
function dropdown(box, options, selected, onChange) {
  const popup = blessed.list({
    parent: screen,
    hidden: true,
    tags: false,
    keys: true,
    mouse: true,
    items: options,
    border: { type: 'line' },
    width: box.width,
    height: Math.min(Math.max(options.length, 1), 8) + 2,
    style: { fg: box.style.fg, bg: box.style.bg, border: box.style.border, selected: { bold: true, inverse: true } },
  });
  let current = selected;
  function close() {
    overlayOpen = false;
    popup.hide();
    box.focus();
    screen.render();
  }
  function open() {
    popup.left = box.aleft;
    popup.top = box.atop + box.height;
    popup.show();
    popup.setFront();
    popup.select(current);
    popup.focus();
    overlayOpen = true;
    screen.render();
  }
  popup.on('select', (item, index) => {
    current = index;
    box.setContent(options[index] + ' \\u25be');
    close();
    if (onChange) onChange(options[index], index);
  });
  popup.key(['escape'], close);
  box.key(['enter', 'space'], open);
  box.on('click', open);
}
`);
    out.line();
  }
  if (h.has('placeholder')) {
    out.block(`/** Shows \`text\` dimmed while a text field is empty. */
function withPlaceholder(el, text) {
  const fg = el.style.fg;
  let shown = !el.getValue();
  const paint = () => {
    if (shown) {
      el.setValue(text);
      el.style.fg = ${jsStr(HINT_COLOR)};
    } else {
      el.style.fg = fg;
    }
  };
  el.on('focus', () => {
    if (!shown) return;
    shown = false;
    el.clearValue();
    el.style.fg = fg;
  });
  const restore = () => {
    shown = !el.getValue();
    paint();
    screen.render();
  };
  el.on('submit', restore);
  el.on('cancel', restore);
  paint();
}
`);
    out.line();
  }
  if (h.has('mark')) {
    out.block(`/** Replaces blessed's built-in "[x]" / "(*)" marker by the glyphs of the design. */
function setMark(el, on, off) {
  el.render = function () {
    this.clearPos(true);
    this.setContent((this.checked ? on : off) + ' ' + this.text, true);
    return this._render();
  };
}
`);
    out.line();
  }
  if (h.has('spin')) {
    out.block(`const SPINNER_FRAMES = ${JSON.stringify(SPINNER_FRAMES)};

/** Animates a spinner box. */
function spin(el, label) {
  let frame = 0;
  setInterval(() => {
    frame = (frame + 1) % SPINNER_FRAMES.length;
    el.setContent(SPINNER_FRAMES[frame] + ' ' + label);
    screen.render();
  }, 80);
}
`);
    out.line();
  }
  if (ctx.modals.length) {
    out.block(`function showModal(modal) {
  modal.show();
  modal.setFront();
  modal.focus();
  screen.render();
}

function closeTopModal() {
  for (let i = modals.length - 1; i >= 0; i--) {
    if (modals[i].visible) {
      modals[i].hide();
      return true;
    }
  }
  return false;
}
`);
    out.line();
  }
}

function emitInteraction(out: CodeWriter, ctx: Ctx): void {
  const overlay = ctx.helpers.has('dropdown') || ctx.modals.length > 0;
  out
    .line('// ── Keys and focus ────────────────────────────────────────────────────────────')
    .line();
  out
    .line('function quit() {')
    .indent()
    .line('screen.destroy();')
    .line('process.exit(0);')
    .dedent()
    .line('}')
    .line();
  out
    .line('function overlayOpenNow() {')
    .indent()
    .line(overlay ? 'return overlayOpen;' : 'return false;')
    .dedent()
    .line('}')
    .line();
  if (ctx.focusables.length) {
    out.line(`const focusables = [${ctx.focusables.join(', ')}];`);
    out.line('let focusIndex = 0;').line();
    out.line('function focusAt(index) {').indent();
    out.line('focusIndex = (index + focusables.length) % focusables.length;');
    out.line('focusables[focusIndex].focus();');
    out.line('screen.render();');
    out.dedent().line('}').line();
    out.line("focusables.forEach((el, i) => el.on('focus', () => { focusIndex = i; }));");
    out.line("screen.key(['tab'], () => { if (!overlayOpenNow()) focusAt(focusIndex + 1); });");
    out
      .line("screen.key(['S-tab'], () => { if (!overlayOpenNow()) focusAt(focusIndex - 1); });")
      .line();
  }
  if (ctx.modals.length) out.line(`const modals = [${ctx.modals.join(', ')}];`).line();
  out.line("screen.key(['q', 'C-c'], quit);");
  out.line("screen.key(['escape'], () => {").indent();
  out.line('if (overlayOpenNow()) return;');
  if (ctx.modals.length) {
    out
      .line('if (closeTopModal()) {')
      .indent()
      .line('screen.render();')
      .line('return;')
      .dedent()
      .line('}');
  }
  out.line('quit();').dedent().line('});').line();
  if (ctx.focusables.length) {
    // Start on something that is not a text field: a focused text field swallows the q key.
    out.line("const firstStop = focusables.findIndex((el) => el.type !== 'textbox');");
    out.line('focusAt(firstStop < 0 ? 0 : firstStop);');
  }
  out.line('screen.render();');
}

// ── Names ─────────────────────────────────────────────────────────────────────

function oneLine(s: string): string {
  return s.replace(LINE_BREAK_RE, ' ').trim();
}

/** JSON array literal that is also valid JavaScript. */
function jsJson(v: unknown): string {
  return JSON.stringify(v).replace(SEPARATOR_RE, (c) => '\\u' + c.charCodeAt(0).toString(16));
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

function emitChildren(node: IRNode, parentVar: string, ctx: Ctx): void {
  const kids = visibleChildren(node).filter((c) => c.type !== 'Spacer');
  for (let i = 0; i < kids.length; i++) {
    const kid = kids[i];
    if (kid.type === 'Radio') {
      // Consecutive radios form one group (blessed.radioset makes them exclusive).
      let j = i;
      while (j < kids.length && kids[j].type === 'Radio') j++;
      emitRadioGroup(kids.slice(i, j), parentVar, ctx);
      i = j - 1;
      continue;
    }
    emitWidget(kid, parentVar, blessedPlacement(kid), ctx);
    if (kid.children.length) emitChildren(kid, nameFor(kid, ctx), ctx);
  }
}

function emitRadioGroup(radios: IRNode[], parentVar: string, ctx: Ctx): void {
  const boxes = radios.map(blessedPlacement);
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
  w.line();
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
): void {
  const w = ctx.w;
  const v = forcedName ?? nameFor(node, ctx);
  w.line(`// ${node.type}: ${oneLine(node.name || node.type)}`);

  const base = (focus: boolean, extraStyle: string[] = []): string[] => {
    const o = [
      `parent: ${parentVar}`,
      `left: ${box.x}`,
      `top: ${box.y}`,
      `width: ${box.width}`,
      `height: ${box.height}`,
      'tags: false',
    ];
    const b = borderLiteral(node.style);
    if (b) o.push(b);
    o.push(styleLiteral(node.style, { focus: focus && !node.disabled, extra: extraStyle }));
    return o;
  };
  const focusable = () => {
    if (!node.disabled) ctx.focusables.push(v);
  };
  const selectedStyle = 'selected: { bold: true, inverse: true }';

  switch (node.type) {
    case 'Screen':
    case 'Box':
    case 'Grid':
      obj(w, 'box', v, base(false));
      break;

    case 'Modal': {
      const o = base(false);
      if (node.style.border && node.text) o.push(`label: ${jsStr(` ${node.text} `)}`);
      else if (node.text) o.push(`name: ${jsStr(node.text)}`);
      obj(w, 'box', v, o);
      ctx.modals.push(v);
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
      w.line(`spin(${v}, ${jsStr(label)});`);
      ctx.helpers.add('spin');
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
      focusable();
      if (node.opensScreen) {
        w.line(
          `// Opens the screen "${oneLine(node.opensScreen)}" in the editor (single-screen export: wire it in the handler).`
        );
      }
      break;

    case 'TextInput': {
      const o = [...base(true), 'inputOnFocus: true', 'mouse: true', 'keys: true'];
      if (node.value) o.push(`value: ${jsStr(node.value)}`);
      obj(w, 'textbox', v, o);
      focusable();
      wireEvents(node, v, ctx);
      if (node.placeholder) {
        w.line(`withPlaceholder(${v}, ${jsStr(node.placeholder)});`);
        ctx.helpers.add('placeholder');
      }
      w.line();
      return;
    }

    case 'Checkbox':
    case 'Toggle':
      obj(w, 'checkbox', v, [
        ...base(true),
        `text: ${jsStr(node.text)}`,
        `checked: ${node.checked}`,
        'mouse: true',
        'keys: true',
      ]);
      w.line(
        node.type === 'Toggle'
          ? `setMark(${v}, ${jsStr('[ON ]')}, ${jsStr('[OFF]')});`
          : `setMark(${v}, ${jsStr(`[${node.glyphs.on}]`)}, ${jsStr(`[${node.glyphs.off}]`)});`
      );
      ctx.helpers.add('mark');
      focusable();
      break;

    case 'Radio':
      obj(w, 'radiobutton', v, [
        ...base(true),
        `text: ${jsStr(node.text)}`,
        `checked: ${node.checked}`,
        'mouse: true',
        'keys: true',
      ]);
      w.line(`setMark(${v}, ${jsStr(`(${node.glyphs.on})`)}, ${jsStr(`(${node.glyphs.off})`)});`);
      ctx.helpers.add('mark');
      focusable();
      break;

    case 'Select': {
      obj(w, 'box', v, [
        ...base(true),
        `content: ${jsStr(inlineText(node))}`,
        'wrap: false',
        'keyable: true',
        'mouse: true',
      ]);
      const idx = Math.max(0, node.options.indexOf(node.value));
      const names = changeHandlers(node, ctx);
      const cb = names.length
        ? `, (value, index) => { ${names.map((n) => `${n}(${v}, value, index);`).join(' ')} }`
        : '';
      w.line(`dropdown(${v}, ${jsJson(node.options.map(String))}, ${idx}${cb});`);
      ctx.helpers.add('dropdown');
      focusable();
      wireEvents(node, v, ctx);
      w.line();
      return;
    }

    case 'ProgressBar': {
      const ratio = Math.max(0, Math.min(1, node.progress.value / node.progress.max));
      const inner = Math.max(1, box.width - (node.style.border ? 2 : 0));
      obj(w, 'progressbar', v, [
        ...base(false),
        "orientation: 'horizontal'",
        `filled: ${Math.round(ratio * 100)}`,
        "ch: '█'",
        `content: ${jsStr('░'.repeat(inner))}`,
        'wrap: false',
      ]);
      break;
    }

    case 'List':
    case 'Menu': {
      const labels = node.items.map((i) => itemText(i, node.type === 'Menu'));
      obj(w, 'list', v, [
        ...base(true, [selectedStyle]),
        `items: ${strArray(labels)}`,
        'keys: true',
        'mouse: true',
        'interactive: true',
      ]);
      if (node.selected > 0 && node.selected < labels.length)
        w.line(`${v}.select(${node.selected});`);
      focusable();
      break;
    }

    case 'Tree': {
      const labels = treeLines(node.items).map((l) => l.text);
      obj(w, 'list', v, [
        ...base(true, [selectedStyle]),
        `items: ${strArray(labels)}`,
        'keys: true',
        'mouse: true',
        'interactive: true',
      ]);
      focusable();
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
      obj(w, 'listtable', v, [
        ...o,
        `rows: ${jsJson(rows.map((r) => r.map(String)))}`,
        "align: 'left'",
        'noCellBorders: true',
        'keys: true',
        'mouse: true',
        'interactive: true',
      ]);
      focusable();
      break;
    }

    case 'Tabs': {
      const tabs = node.items.map(
        (t) => (t.status ? '● ' : '') + (t.icon ? `${t.icon} ` : '') + t.label
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
      tabs.forEach((t, i) =>
        w.line(
          `{ text: ${jsStr(t)}, prefix: '', callback: () => { ${names.map((n) => `${n}(${v}, ${i});`).join(' ')} } },`
        )
      );
      w.dedent().line('],').dedent().line('});');
      if (node.selected > 0 && node.selected < tabs.length)
        w.line(`${v}.select(${node.selected});`);
      focusable();
      break;
    }

    case 'Spacer':
      return;
  }

  wireEvents(node, v, ctx);
  w.line();
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
