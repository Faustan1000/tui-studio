// OpenTUI (React) exporter.
//
// Targets @opentui/core + @opentui/react 0.6.6 on Bun. Elements used: <box>, <text>, <input>,
// <select>, <tab-select> (intrinsic elements of @opentui/react), hooks useKeyboard/useRenderer.
//
// Layout strategy: NATIVE flexbox (Yoga). Containers map flexDirection, gap, padding, justifyContent,
// alignItems and flexWrap one to one; width/height are cells, 'fill' becomes flexGrow (main axis) or
// "100%" (cross axis). Grid containers become a column of row boxes whose cells share the width
// (children fill the cells row by row). Absolute containers place every child with
// position: "absolute" and left/top from the editor's child coordinates. Modals are absolutely
// positioned overlays.
//
// Widgets without a native element (Table, Tree, ProgressBar, Checkbox, Radio, Toggle, Breadcrumb)
// are built from text rows, so they look the same as in every other exporter.

import type { ExportAdapter, ExportFile } from '../adapter';
import {
  inlineText,
  itemText,
  progressText,
  recase,
  toIdent,
  treeLines,
  visibleChildren,
  walkIR,
  type IRNode,
} from '../ir';
import { CodeWriter, jsStr } from '../lang';

const OPENTUI_VERSION = '0.6.6';
const REACT_VERSION = '19.2.0';

const RESERVED = new Set([
  // generated file
  'App',
  'Spinner',
  'SpinnerText',
  'renderer',
  'focus',
  'setFocus',
  'activate',
  'move',
  'FOCUS_ORDER',
  'TEXT_FIELDS',
  'SPINNER_FRAMES',
  'React',
  'useState',
  'useEffect',
  'useRef',
  'useKeyboard',
  'useRenderer',
  'createCliRenderer',
  'createRoot',
  'TextAttributes',
  'process',
  'key',
  // JavaScript
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
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'new',
  'null',
  'return',
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
  'let',
  'static',
  'await',
  'async',
  'of',
  'undefined',
  'NaN',
  'Infinity',
  'arguments',
  'eval',
  'interface',
  'package',
  'private',
  'protected',
  'public',
  'implements',
]);

const STATEFUL = new Set(['TextInput', 'Checkbox', 'Radio', 'Toggle', 'Select']);

interface Ctx {
  used: Set<string>;
  state: Map<string, { value: string; set: string }>;
  stubs: Map<string, string>;
  consts: string[];
  focusOrder: string[];
  textFields: string[];
  cases: string[];
  refs: string[];
  stateDecls: string[];
  screenW: number;
  screenH: number;
  usesAttrs: boolean;
  usesSpinner: boolean;
}

export const opentuiAdapter: ExportAdapter = {
  id: 'opentui',
  label: 'OpenTUI (React)',
  language: 'tsx',
  verification: 'syntax',
  multiScreen: false,
  generate({ ir }) {
    const screen = ir.start;
    const root = screen.root;
    const ctx: Ctx = {
      used: new Set(RESERVED),
      state: new Map(),
      stubs: new Map(),
      consts: [],
      focusOrder: [],
      textFields: [],
      cases: [],
      refs: [],
      stateDecls: [],
      screenW: screen.width,
      screenH: screen.height,
      usesAttrs: false,
      usesSpinner: false,
    };

    // Names of state variables first (radio groups need the setters of their siblings).
    const nodes = walkIR(root).filter((n) => n.visible);
    for (const n of nodes) {
      if (!STATEFUL.has(n.type)) continue;
      const value = unique(ctx, recase(n.ident, 'camel'));
      const set = unique(ctx, 'set' + recase(value, 'pascal'));
      ctx.state.set(n.id, { value, set });
    }

    const jsx = new CodeWriter('  ', 3);
    emit(ctx, jsx, root, null);

    const out = new CodeWriter();
    writeFile(out, ctx, jsx.toString().replace(/\n$/, ''), screen.ident);

    const pkgName = toIdent(screen.ident, 'snake', 'tui_app').replace(/_/g, '-');
    const pkg = {
      name: pkgName,
      version: '0.1.0',
      private: true,
      type: 'module',
      scripts: {
        start: 'bun run src/index.tsx',
        dev: 'bun --watch run src/index.tsx',
        typecheck: 'tsc --noEmit',
      },
      dependencies: {
        '@opentui/core': OPENTUI_VERSION,
        '@opentui/react': OPENTUI_VERSION,
        react: REACT_VERSION,
      },
      devDependencies: {
        '@types/bun': '^1.2.0',
        '@types/react': '^19.2.0',
        typescript: '^5.8.0',
      },
    };
    const tsconfig = {
      compilerOptions: {
        lib: ['ESNext', 'DOM'],
        target: 'ESNext',
        module: 'ESNext',
        moduleResolution: 'bundler',
        jsx: 'react-jsx',
        jsxImportSource: '@opentui/react',
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        allowImportingTsExtensions: true,
        types: ['bun'],
      },
      include: ['src'],
    };
    const files: ExportFile[] = [
      { path: 'src/index.tsx', content: out.toString() },
      { path: 'package.json', content: JSON.stringify(pkg, null, 2) + '\n' },
      { path: 'tsconfig.json', content: JSON.stringify(tsconfig, null, 2) + '\n' },
    ];
    return files;
  },
};

// ── File assembly ─────────────────────────────────────────────────────────────

function writeFile(w: CodeWriter, ctx: Ctx, jsx: string, screenIdent: string): void {
  w.line(`// OpenTUI (React) app for the screen "${screenIdent}", generated by TUI Studio.`);
  w.line(
    `// Targets @opentui/core and @opentui/react ${OPENTUI_VERSION} (React ${REACT_VERSION}); needs Bun.`
  );
  w.line('//');
  w.line('// Run:   bun install && bun run src/index.tsx');
  w.line('// Keys:  Tab / Shift+Tab move the focus, Enter or Space activate, q or Ctrl+C quit.');
  w.line('//');
  w.line(
    '// Fill in the handler functions below; they are called by the components that name them.'
  );
  w.line();
  const react = ['useState'];
  if (ctx.refs.length || ctx.usesSpinner) react.push('useEffect');
  if (ctx.refs.length) react.push('useRef');
  w.line(`import { ${react.join(', ')} } from "react";`);
  w.line(
    `import { ${ctx.usesAttrs ? 'TextAttributes, ' : ''}createCliRenderer } from "@opentui/core";`
  );
  w.line('import { createRoot, useKeyboard, useRenderer } from "@opentui/react";');
  w.line();

  if (ctx.stubs.size) {
    w.line('// ── Handlers ──────────────────────────────────────────────────────────────────');
    for (const name of new Set(ctx.stubs.values())) {
      w.line(`function ${name}(_value?: unknown): void {`);
      w.line('  // TODO: implement');
      w.line('}');
      w.line();
    }
  }
  for (const c of ctx.consts) w.block(c);
  if (ctx.consts.length) w.line();

  if (ctx.usesSpinner) {
    w.line('const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];');
    w.line();
    w.line('function SpinnerText(props: { label: string; fg?: string }) {');
    w.line('  const [frame, setFrame] = useState(0);');
    w.line('  useEffect(() => {');
    w.line(
      '    const timer = setInterval(() => setFrame((n) => (n + 1) % SPINNER_FRAMES.length), 80);'
    );
    w.line('    return () => clearInterval(timer);');
    w.line('  }, []);');
    w.line('  return <text fg={props.fg} content={`${SPINNER_FRAMES[frame]} ${props.label}`} />;');
    w.line('}');
    w.line();
  }

  w.line(`const FOCUS_ORDER: string[] = [${ctx.focusOrder.map(jsStr).join(', ')}];`);
  w.line(`const TEXT_FIELDS = new Set<string>([${ctx.textFields.map(jsStr).join(', ')}]);`);
  w.line();
  w.line('function App() {');
  w.indent();
  w.line('const renderer = useRenderer();');
  w.line('const [focus, setFocus] = useState<string>(FOCUS_ORDER[0] ?? "");');
  for (const line of ctx.stateDecls) w.line(line);
  for (const r of ctx.refs) w.block(r);
  w.line();
  w.line('const quit = () => {');
  w.line('  renderer.destroy();');
  w.line('  process.exit(0);');
  w.line('};');
  w.line();
  w.line('const move = (step: number) => {');
  w.line('  if (!FOCUS_ORDER.length) return;');
  w.line('  const at = FOCUS_ORDER.indexOf(focus);');
  w.line('  setFocus(FOCUS_ORDER[(at + step + FOCUS_ORDER.length) % FOCUS_ORDER.length]);');
  w.line('};');
  w.line();
  w.line('const activate = (id: string) => {');
  w.line('  switch (id) {');
  for (const c of ctx.cases) w.block('    ' + c.replace(/\n/g, '\n    '));
  w.line('    default:');
  w.line('      break;');
  w.line('  }');
  w.line('};');
  w.line();
  w.line('useKeyboard((key) => {');
  w.line('  if (key.ctrl && key.name === "c") return quit();');
  w.line('  if (key.name === "tab") return move(key.shift ? -1 : 1);');
  w.line('  if (TEXT_FIELDS.has(focus)) return;');
  w.line('  if (key.name === "q") return quit();');
  w.line('  if (key.name === "return" || key.name === "space") activate(focus);');
  w.line('});');
  w.line();
  w.line('return (');
  w.block(jsx);
  w.line(');');
  w.dedent();
  w.line('}');
  w.line();
  w.line('const renderer = await createCliRenderer({ exitOnCtrlC: false });');
  w.line('createRoot(renderer).render(<App />);');
}

// ── Names ─────────────────────────────────────────────────────────────────────

function unique(ctx: Ctx, base: string): string {
  let name = base;
  for (let i = 2; ctx.used.has(name); i++) name = `${base}${i}`;
  ctx.used.add(name);
  return name;
}

/** Stub function for an event handler name; the same name always gives the same function. */
function stub(ctx: Ctx, raw: string): string {
  const known = ctx.stubs.get(raw);
  if (known) return known;
  const base = /^[A-Za-z_$][\w$]*$/.test(raw) ? raw : toIdent(raw, 'camel', 'handler');
  const name = unique(ctx, base);
  ctx.stubs.set(raw, name);
  return name;
}

function handlers(ctx: Ctx, node: IRNode, pattern?: RegExp): string[] {
  const out: string[] = [];
  for (const [event, name] of Object.entries(node.events)) {
    if (!name) continue;
    const fn = stub(ctx, name);
    if ((!pattern || pattern.test(event)) && !out.includes(fn)) out.push(fn);
  }
  return out;
}

// ── Props helpers ─────────────────────────────────────────────────────────────

function sAttr(name: string, value: string): string {
  return /^[\w#.%-]+$/.test(value) ? `${name}="${value}"` : `${name}={${jsStr(value)}}`;
}

const JUSTIFY = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  'space-between': 'space-between',
  'space-around': 'space-around',
} as const;
const ALIGN = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  stretch: 'stretch',
} as const;

function isFlowParent(p: IRNode | null): p is IRNode {
  return !!p && p.layout.mode !== 'absolute';
}

function posSize(ctx: Ctx, node: IRNode, parent: IRNode | null, autoHeight?: number): string[] {
  const props: string[] = [];
  if (!parent) {
    return ['width="100%"', 'height="100%"'];
  }
  if (node.type === 'Modal') {
    props.push('position="absolute"');
    // Overlays are centred in the screen (the editor lays them out below the content).
    const bw = typeof node.width === 'number' ? node.width : (node.box?.width ?? 40);
    const bh = typeof node.height === 'number' ? node.height : (node.box?.height ?? 10);
    const left = parent.parent
      ? (node.rel?.x ?? 0)
      : Math.max(0, Math.floor((ctx.screenW - bw) / 2));
    const top = parent.parent
      ? (node.rel?.y ?? 0)
      : Math.max(0, Math.floor((ctx.screenH - bh) / 2));
    props.push(`left={${left}}`, `top={${top}}`);
  } else if (parent.layout.mode === 'absolute') {
    props.push('position="absolute"', `left={${node.layout.x}}`, `top={${node.layout.y}}`);
  }
  const rowParent = isFlowParent(parent) && parent.layout.direction === 'row';
  let grow = false;
  if (typeof node.width === 'number') props.push(`width={${node.width}}`);
  else if (node.width === 'fill') {
    if (rowParent) grow = true;
    else props.push('width="100%"');
  }
  if (typeof node.height === 'number') props.push(`height={${node.height}}`);
  else if (node.height === 'fill') {
    if (isFlowParent(parent) && !rowParent) grow = true;
    else props.push('height="100%"');
  } else if (autoHeight !== undefined) props.push(`height={${autoHeight}}`);
  if (node.type === 'Modal') {
    if (node.width === 'auto' && node.box) props.push(`width={${node.box.width}}`);
    if (node.height === 'auto' && node.box) props.push(`height={${node.box.height}}`);
  }
  if (grow) props.push('flexGrow={1}');
  return props;
}

function borderProps(node: IRNode, force = false): string[] {
  const b = node.style.border;
  if (!b) return force ? ['border', 'borderStyle="rounded"'] : [];
  const sides = (['top', 'right', 'bottom', 'left'] as const).filter((s) => b[s]);
  const props = [sides.length === 4 ? 'border' : `border={[${sides.map(jsStr).join(', ')}]}`];
  props.push(`borderStyle="${b.kind === 'bold' ? 'heavy' : b.kind}"`);
  if (b.color) props.push(sAttr('borderColor', b.color));
  return props;
}

function paddingProps(node: IRNode): string[] {
  const p = node.layout.padding;
  if (p.top === p.right && p.right === p.bottom && p.bottom === p.left)
    return p.top ? [`padding={${p.top}}`] : [];
  const props: string[] = [];
  if (p.top) props.push(`paddingTop={${p.top}}`);
  if (p.right) props.push(`paddingRight={${p.right}}`);
  if (p.bottom) props.push(`paddingBottom={${p.bottom}}`);
  if (p.left) props.push(`paddingLeft={${p.left}}`);
  return props;
}

function flexProps(node: IRNode): string[] {
  const l = node.layout;
  const props = [`flexDirection="${l.direction}"`];
  if (l.gap) props.push(`gap={${l.gap}}`);
  if (l.justify !== 'start') props.push(`justifyContent="${JUSTIFY[l.justify]}"`);
  props.push(`alignItems="${ALIGN[l.align]}"`);
  if (l.wrap) props.push('flexWrap="wrap"');
  return props;
}

/** Base attribute bits of a node's text style (bold, italic, ...). */
function attrBits(node: IRNode, ctx: Ctx, extra: string[] = []): string[] {
  const s = node.style;
  const bits = [...extra];
  if (s.bold) bits.push('TextAttributes.BOLD');
  if (s.italic) bits.push('TextAttributes.ITALIC');
  if (s.underline) bits.push('TextAttributes.UNDERLINE');
  if (s.strikethrough) bits.push('TextAttributes.STRIKETHROUGH');
  if (node.disabled) bits.push('TextAttributes.DIM');
  if (bits.length) ctx.usesAttrs = true;
  return bits;
}

function attrProp(bits: string[], focusId?: string): string | null {
  const all = [...bits];
  if (focusId) all.push(`(focus === ${jsStr(focusId)} ? TextAttributes.INVERSE : 0)`);
  return all.length ? `attributes={${all.join(' | ')}}` : null;
}

function colorProps(node: IRNode, fgName: string, bgName: string): string[] {
  const props: string[] = [];
  if (node.style.fg) props.push(sAttr(fgName, node.style.fg));
  if (node.style.bg) props.push(sAttr(bgName, node.style.bg));
  return props;
}

function el(w: CodeWriter, tag: string, props: (string | null)[], children?: () => void): void {
  const open = `<${tag}${props
    .filter(Boolean)
    .map((p) => ' ' + p)
    .join('')}`;
  if (!children) {
    w.line(open + ' />');
    return;
  }
  w.line(open + '>');
  w.indent();
  children();
  w.dedent();
  w.line(`</${tag}>`);
}

interface LeafOpts {
  tag: string;
  props: (string | null)[];
  /** Height in cells when the node has none (select lists, ...). */
  autoHeight?: number;
  /** Always use an outer <box> that carries position and size. */
  forceWrap?: boolean;
  children?: () => void;
}

/**
 * A leaf element. When it has a border or needs alignment, an outer <box> carries position, size
 * and border and the element fills it; otherwise the element carries position and size itself.
 */
function leaf(ctx: Ctx, w: CodeWriter, node: IRNode, parent: IRNode | null, o: LeafOpts): void {
  const align = node.textAlign;
  const aligned = align !== 'left' && node.type === 'Text';
  if (!node.style.border && !aligned && !o.forceWrap) {
    el(w, o.tag, [...posSize(ctx, node, parent, o.autoHeight), ...o.props], o.children);
    return;
  }
  const outer = [...posSize(ctx, node, parent), ...borderProps(node)];
  if (aligned) {
    outer.push(
      'flexDirection="row"',
      `justifyContent="${align === 'center' ? 'center' : 'flex-end'}"`
    );
  }
  el(w, 'box', outer, () => {
    const inner: (string | null)[] = [...o.props];
    if (!aligned) inner.unshift('flexGrow={1}');
    if (o.autoHeight !== undefined && node.height === 'auto')
      inner.unshift(`height={${o.autoHeight}}`);
    el(w, o.tag, inner, o.children);
  });
}

// ── Emission ──────────────────────────────────────────────────────────────────

function emit(ctx: Ctx, w: CodeWriter, node: IRNode, parent: IRNode | null): void {
  switch (node.type) {
    case 'Screen':
    case 'Box':
    case 'Modal':
      if (node.layout.mode === 'grid' && node.type !== 'Modal') return grid(ctx, w, node, parent);
      return container(ctx, w, node, parent);
    case 'Grid':
      return grid(ctx, w, node, parent);
    case 'Spacer': {
      const props = posSize(ctx, node, parent);
      if (node.width === 'auto' && node.height === 'auto') props.push('flexGrow={1}');
      return el(w, 'box', props);
    }
    case 'Text': {
      const bits = attrBits(node, ctx);
      return leaf(ctx, w, node, parent, {
        tag: 'text',
        props: [...colorProps(node, 'fg', 'bg'), attrProp(bits), `content={${jsStr(node.text)}}`],
      });
    }
    case 'Spinner': {
      ctx.usesSpinner = true;
      const fg = node.style.fg ? ` fg=${jsStr(node.style.fg)}` : '';
      const props = posSize(ctx, node, parent);
      return el(w, 'box', props, () => {
        w.line(`<SpinnerText label={${jsStr(node.text || 'Loading...')}}${fg} />`);
      });
    }
    case 'ProgressBar': {
      const width = typeof node.width === 'number' ? node.width : (node.box?.width ?? 20);
      const pct = Math.round(
        Math.max(0, Math.min(1, node.progress.value / node.progress.max)) * 100
      );
      const barWidth = Math.max(1, width - 5);
      const bits = attrBits(node, ctx);
      return leaf(ctx, w, node, parent, {
        tag: 'text',
        props: [
          ...colorProps(node, 'fg', 'bg'),
          attrProp(bits),
          `content={${jsStr(`${progressText(node, barWidth)} ${String(pct).padStart(3)}%`)}}`,
        ],
      });
    }
    case 'Breadcrumb': {
      const bits = attrBits(node, ctx);
      return leaf(ctx, w, node, parent, {
        tag: 'text',
        props: [
          ...colorProps(node, 'fg', 'bg'),
          attrProp(bits),
          `content={${jsStr(inlineText(node))}}`,
        ],
      });
    }
    case 'TextInput':
      return textInput(ctx, w, node, parent);
    case 'Button':
      return button(ctx, w, node, parent);
    case 'Checkbox':
    case 'Radio':
    case 'Toggle':
      return toggleLike(ctx, w, node, parent);
    case 'Select':
    case 'List':
    case 'Menu':
      return selectList(ctx, w, node, parent);
    case 'Tabs':
      return tabs(ctx, w, node, parent);
    case 'Table':
      return table(ctx, w, node, parent);
    case 'Tree':
      return tree(ctx, w, node, parent);
    default:
      return;
  }
}

function container(ctx: Ctx, w: CodeWriter, node: IRNode, parent: IRNode | null): void {
  const props: string[] = [...posSize(ctx, node, parent)];
  if (node.type === 'Modal') {
    props.push(...borderProps(node, true));
    if (node.text) props.push(`title={${jsStr(node.text)}}`, 'titleAlignment="center"');
    props.push(sAttr('backgroundColor', node.style.bg ?? '#000000'));
  } else {
    props.push(...borderProps(node));
    if (node.style.bg) props.push(sAttr('backgroundColor', node.style.bg));
  }
  props.push(...flexProps(node), ...paddingProps(node));
  const kids = visibleChildren(node);
  if (!kids.length) return el(w, 'box', props);
  el(w, 'box', props, () => kids.forEach((c) => emit(ctx, w, c, node)));
}

function grid(ctx: Ctx, w: CodeWriter, node: IRNode, parent: IRNode | null): void {
  const l = node.layout;
  const cols = Math.max(1, l.columns);
  const kids = visibleChildren(node);
  const props = [...posSize(ctx, node, parent), ...borderProps(node)];
  if (node.style.bg) props.push(sAttr('backgroundColor', node.style.bg));
  props.push('flexDirection="column"');
  if (l.rowGap) props.push(`gap={${l.rowGap}}`);
  props.push(...paddingProps(node));
  const rows: IRNode[][] = [];
  for (let i = 0; i < kids.length; i += cols) rows.push(kids.slice(i, i + cols));
  const rowCount = Math.max(l.rows, rows.length);
  const cellWidth = `${Math.floor(100 / cols)}%`;
  el(w, 'box', props, () => {
    for (let r = 0; r < rowCount; r++) {
      const row = rows[r] ?? [];
      const rowProps = ['flexDirection="row"', 'flexGrow={1}', 'alignItems="flex-start"'];
      if (l.columnGap) rowProps.push(`gap={${l.columnGap}}`);
      el(w, 'box', rowProps, () => {
        for (let c = 0; c < cols; c++) {
          const cell = row[c];
          const cellProps = [`width="${cellWidth}"`, 'flexGrow={1}', 'flexDirection="column"'];
          if (!cell) return el(w, 'box', cellProps);
          el(w, 'box', cellProps, () => emitInCell(ctx, w, cell, node));
        }
      });
    }
  });
}

/** A grid cell is a plain column; the child fills it unless it has its own size. */
function emitInCell(ctx: Ctx, w: CodeWriter, cell: IRNode, grid: IRNode): void {
  const cellParent = {
    ...grid,
    layout: { ...grid.layout, mode: 'flex' as const, direction: 'column' as const },
  };
  emit(ctx, w, cell, cellParent);
}

function textInput(ctx: Ctx, w: CodeWriter, node: IRNode, parent: IRNode | null): void {
  const st = ctx.state.get(node.id)!;
  const focusable = !node.disabled;
  if (focusable) {
    ctx.focusOrder.push(node.ident);
    ctx.textFields.push(node.ident);
  }
  ctx.stateDecls.push(`const [${st.value}, ${st.set}] = useState(${jsStr(node.value)});`);
  const onInput = handlers(ctx, node, /change|input/i);
  const onSubmit = handlers(ctx, node, /submit|enter/i);
  const props: (string | null)[] = [
    `value={${st.value}}`,
    `placeholder={${jsStr(node.placeholder)}}`,
    ...colorProps(node, 'textColor', 'backgroundColor'),
    focusable ? `focused={focus === ${jsStr(node.ident)}}` : null,
    `onInput={(value: string) => {\n${[`${st.set}(value);`, ...onInput.map((f) => `${f}(value);`)].join('\n')}\n}}`,
  ];
  if (onSubmit.length)
    props.push(
      `onSubmit={(value: string) => {\n${onSubmit.map((f) => `${f}(value);`).join('\n')}\n}}`
    );
  leaf(ctx, w, node, parent, { tag: 'input', props: flat(props), autoHeight: undefined });
}

/** Multi-line prop values are collapsed onto one line so each element stays on its own line. */
function flat(props: (string | null)[]): (string | null)[] {
  return props.map((p) => (p ? p.replace(/\n/g, ' ') : p));
}

function button(ctx: Ctx, w: CodeWriter, node: IRNode, parent: IRNode | null): void {
  const fns = handlers(ctx, node);
  if (!node.disabled) {
    ctx.focusOrder.push(node.ident);
    ctx.cases.push(
      `case ${jsStr(node.ident)}:\n  ${fns.map((f) => `${f}();`).join(' ') || 'break;'}\n  break;`
    );
  }
  const props = [...posSize(ctx, node, parent), ...borderProps(node)];
  if (node.style.bg) props.push(sAttr('backgroundColor', node.style.bg));
  props.push('paddingLeft={1}', 'paddingRight={1}');
  const bits = attrBits(node, ctx);
  el(w, 'box', props, () => {
    el(w, 'text', [
      ...(node.style.fg ? [sAttr('fg', node.style.fg)] : []),
      attrProp(bits, node.disabled ? undefined : node.ident),
      `content={${jsStr(inlineText(node))}}`,
    ]);
  });
  if (!node.disabled) ctx.usesAttrs = true;
}

function toggleLike(ctx: Ctx, w: CodeWriter, node: IRNode, parent: IRNode | null): void {
  const st = ctx.state.get(node.id)!;
  ctx.stateDecls.push(
    `const [${st.value}, ${st.set}] = useState(${node.checked ? 'true' : 'false'});`
  );
  const on = inlineText({ ...node, checked: true });
  const off = inlineText({ ...node, checked: false });
  const fns = handlers(ctx, node);
  if (!node.disabled) {
    ctx.focusOrder.push(node.ident);
    let body: string;
    if (node.type === 'Radio') {
      const sibs = (node.parent?.children ?? []).filter(
        (c) => c !== node && c.type === 'Radio' && c.visible
      );
      const clear = sibs.map((s) => `${ctx.state.get(s.id)!.set}(false);`);
      body = [`${st.set}(true);`, ...clear, ...fns.map((f) => `${f}(true);`)].join(' ');
    } else {
      body = [`${st.set}(!${st.value});`, ...fns.map((f) => `${f}(!${st.value});`)].join(' ');
    }
    ctx.cases.push(`case ${jsStr(node.ident)}:\n  ${body}\n  break;`);
  }
  const bits = attrBits(node, ctx);
  if (!node.disabled) ctx.usesAttrs = true;
  leaf(ctx, w, node, parent, {
    tag: 'text',
    props: [
      ...colorProps(node, 'fg', 'bg'),
      attrProp(bits, node.disabled ? undefined : node.ident),
      `content={${st.value} ? ${jsStr(on)} : ${jsStr(off)}}`,
    ],
  });
}

function optionsConst(ctx: Ctx, node: IRNode, labels: string[]): string {
  const name = unique(ctx, recase(node.ident, 'camel') + 'Options');
  const rows = labels.map((l) => `  { name: ${jsStr(l)}, description: "", value: ${jsStr(l)} },`);
  ctx.consts.push(`const ${name} = [\n${rows.join('\n')}\n];`);
  return name;
}

function selectList(ctx: Ctx, w: CodeWriter, node: IRNode, parent: IRNode | null): void {
  const labels =
    node.type === 'Select'
      ? node.options
      : node.items.map((i) => itemText(i, node.type === 'Menu'));
  const options = optionsConst(ctx, node, labels);
  const focusable = !node.disabled;
  if (focusable) ctx.focusOrder.push(node.ident);
  const onChange = handlers(ctx, node);
  const props: (string | null)[] = [`options={${options}}`, 'showDescription={false}'];
  if (node.type === 'Select') {
    const st = ctx.state.get(node.id)!;
    const idx = Math.max(0, node.options.indexOf(node.value));
    ctx.stateDecls.push(`const [${st.value}, ${st.set}] = useState(${idx});`);
    props.push(`selectedIndex={${st.value}}`);
    props.push(
      `onChange={(index: number) => { ${[`${st.set}(index);`, ...onChange.map((f) => `${f}(index);`)].join(' ')} }}`
    );
  } else {
    if (node.selected > 0) props.push(`selectedIndex={${node.selected}}`);
    if (onChange.length)
      props.push(
        `onChange={(index: number) => { ${onChange.map((f) => `${f}(index);`).join(' ')} }}`
      );
  }
  if (focusable) props.push(`focused={focus === ${jsStr(node.ident)}}`);
  props.push(...colorProps(node, 'textColor', 'backgroundColor'));
  leaf(ctx, w, node, parent, {
    tag: 'select',
    props,
    autoHeight: Math.max(1, Math.min(labels.length, 8)),
  });
}

function tabs(ctx: Ctx, w: CodeWriter, node: IRNode, parent: IRNode | null): void {
  const options = optionsConst(
    ctx,
    node,
    node.items.map((i) => itemText(i, false))
  );
  const focusable = !node.disabled;
  if (focusable) ctx.focusOrder.push(node.ident);
  const onChange = handlers(ctx, node);
  const props: (string | null)[] = [`options={${options}}`, 'showDescription={false}'];
  if (node.selected > 0) {
    const ref = unique(ctx, recase(node.ident, 'camel') + 'Ref');
    ctx.refs.push(
      `const ${ref} = useRef<{ setSelectedIndex(index: number): void } | null>(null);\n` +
        `useEffect(() => {\n  ${ref}.current?.setSelectedIndex(${node.selected});\n}, []);`
    );
    props.push(`ref={${ref}}`);
  }
  if (onChange.length)
    props.push(
      `onChange={(index: number) => { ${onChange.map((f) => `${f}(index);`).join(' ')} }}`
    );
  if (focusable) props.push(`focused={focus === ${jsStr(node.ident)}}`);
  props.push(...colorProps(node, 'textColor', 'backgroundColor'));
  leaf(ctx, w, node, parent, { tag: 'tab-select', props, autoHeight: 2 });
}

function table(ctx: Ctx, w: CodeWriter, node: IRNode, parent: IRNode | null): void {
  const cols = Math.max(node.columns.length, ...node.rows.map((r) => r.length), 0);
  const cell = (r: string[], i: number) => r[i] ?? '';
  const widths = Array.from({ length: cols }, (_, i) =>
    Math.max([...cell(node.columns, i)].length, ...node.rows.map((r) => [...cell(r, i)].length), 1)
  );
  const line = (r: string[]) =>
    widths.map((n, i) => cell(r, i) + ' '.repeat(n - [...cell(r, i)].length)).join(' │ ');
  const rule = widths.map((n) => '─'.repeat(n)).join('─┼─');
  const fg = node.style.fg ? [sAttr('fg', node.style.fg)] : [];
  const bits = attrBits(node, ctx);
  const props = [...posSize(ctx, node, parent), ...borderProps(node), 'flexDirection="column"'];
  if (node.style.bg) props.push(sAttr('backgroundColor', node.style.bg));
  ctx.usesAttrs = true;
  el(w, 'box', props, () => {
    if (node.columns.length) {
      el(w, 'text', [
        ...fg,
        attrProp([...bits, 'TextAttributes.BOLD']),
        `content={${jsStr(line(node.columns))}}`,
      ]);
      el(w, 'text', [...fg, `content={${jsStr(rule)}}`]);
    }
    for (const r of node.rows)
      el(w, 'text', [...fg, attrProp(bits), `content={${jsStr(line(r))}}`]);
  });
}

function tree(ctx: Ctx, w: CodeWriter, node: IRNode, parent: IRNode | null): void {
  const fg = node.style.fg ? [sAttr('fg', node.style.fg)] : [];
  const bits = attrBits(node, ctx);
  const props = [...posSize(ctx, node, parent), ...borderProps(node), 'flexDirection="column"'];
  if (node.style.bg) props.push(sAttr('backgroundColor', node.style.bg));
  el(w, 'box', props, () => {
    for (const l of treeLines(node.items))
      el(w, 'text', [...fg, attrProp(bits), `content={${jsStr(l.text)}}`]);
  });
}
