// OpenTUI (React) exporter.
//
// Targets @opentui/core + @opentui/react 0.6.6 on Bun. Elements used: <box>, <text>, <input>,
// <select>, <tab-select> (intrinsic elements of @opentui/react), hook useKeyboard.
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
//
// Program API (docs/PROGRAM_API.md): src/ui-runtime.tsx (identical for every export) holds the
// store, events, error dialog and log; index.tsx gets a typed facade `Ui` with one handle per code
// name. Components with a code name read their state from the store (useSyncExternalStore) and
// write user input into it; components without one keep local React state.

import type { ExportAdapter, ExportFile } from '../adapter';
import { renderFacade } from '../api/facade';
import { buildApiModel, apiMember, apiName, safeIdent, type ApiHandleModel } from '../api/model';
import RUNTIME_SOURCE from '../api/opentui/ui-runtime.tsx.txt?raw';
import {
  inlineText,
  itemText,
  progressText,
  recase,
  toIdent,
  treeLines,
  walkIR,
  type IRNode,
} from '../ir';
import { CodeWriter, jsStr } from '../lang';

const OPENTUI_VERSION = '0.6.6';
const REACT_VERSION = '19.2.0';

const RESERVED = new Set(
  // generated file
  (
    'App Ui UiCore Handle Spinner SpinnerText ui focus focusId setFocus activate move order sys key ' +
    'tableLines progressBar toOptions SPINNER_FRAMES TEXT_FIELDS React useState useEffect useRef useMemo ' +
    'useKeyboard useSlice createRoot TextAttributes process UiState UiHandler UiEvent ReactNode ' +
    // JavaScript
    'break case catch class const continue debugger default delete do else enum export extends false ' +
    'finally for function if import in instanceof new null return super switch this throw true try ' +
    'typeof var void while with yield let static await async of undefined NaN Infinity arguments eval ' +
    'interface package private protected public implements'
  ).split(' ')
);

/** Members of UiCore/Handle that a code name must not shadow. */
const CORE_MEMBERS = new Set(
  (
    'store errors log ready running renderer root closed closeWaiters queue pending callbacks modals view add ' +
    'start stop wait run markClosed on nextEvent isActive emit defer report addLog installExcepthooks blocked ' +
    'handleKey constructor api'
  ).split(' ')
);

const STATEFUL = new Set(['TextInput', 'Checkbox', 'Radio', 'Toggle', 'Select']);

interface Tagged {
  handle: ApiHandleModel;
  /** Variable holding the slice of the store (`nameInputS`), declared when the node is rendered. */
  sv: string;
}

interface Ctx {
  used: Set<string>;
  /** Local state of components without a code name. */
  state: Map<string, { value: string; set: string }>;
  tagged: Map<string, Tagged>;
  stubs: Map<string, string>;
  consts: string[];
  focusOrder: { id: string; cond: string }[];
  textFields: string[];
  cases: string[];
  hooks: string[];
  screenW: number;
  screenH: number;
  usesAttrs: boolean;
  usesSpinner: boolean;
  usesTable: boolean;
  usesProgress: boolean;
  usesOptions: boolean;
  usesHit: boolean;
  usesTabs: boolean;
  /** Code names (idents) of the tab bars, and the cases of `moveTab`. */
  tabIds: string[];
  tabMoves: string[];
  /** A Select is drawn: the app keeps the state of the open dropdown. */
  dropdown: boolean;
  opens: string[];
  picks: string[];
  usesRef: boolean;
  /** JSX of the popup lists; they are drawn by the runtime above everything else. */
  popups: string[];
}

export const opentuiAdapter: ExportAdapter = {
  id: 'opentui',
  label: 'OpenTUI (React)',
  language: 'tsx',
  verification: 'run',
  multiScreen: false,
  generate({ ir }) {
    const screen = ir.start;
    const root = screen.root;
    const ctx: Ctx = {
      used: new Set(RESERVED),
      state: new Map(),
      tagged: new Map(),
      stubs: new Map(),
      consts: [],
      focusOrder: [],
      textFields: [],
      cases: [],
      hooks: [],
      screenW: screen.width,
      screenH: screen.height,
      usesAttrs: false,
      usesSpinner: false,
      usesTable: false,
      usesProgress: false,
      usesOptions: false,
      usesHit: false,
      usesTabs: false,
      tabIds: [],
      tabMoves: [],
      dropdown: walkIR(root).some((n) => n.type === 'Select' && renderable(n)),
      opens: [],
      picks: [],
      popups: [],
      usesRef: false,
    };

    // The handles of the program API (code names of the first screen).
    const inScreen = new Set(
      walkIR(root)
        .filter(renderable)
        .map((n) => n.id)
    );
    const handles = buildApiModel(ir).handles.filter((h) => inScreen.has(h.node.id));
    for (const h of handles) {
      ctx.tagged.set(h.node.id, { handle: h, sv: '' });
    }

    // Names of state variables first (radio groups need the setters of their siblings).
    for (const n of walkIR(root).filter((n) => renderable(n))) {
      const t = ctx.tagged.get(n.id);
      if (t) t.sv = unique(ctx, recase(n.ident, 'camel') + 'S');
      else if (STATEFUL.has(n.type)) {
        const value = unique(ctx, recase(n.ident, 'camel'));
        const set = unique(ctx, 'set' + recase(value, 'pascal'));
        ctx.state.set(n.id, { value, set });
      }
    }

    const jsx = new CodeWriter('  ', 4);
    emit(ctx, jsx, root, null);

    const out = new CodeWriter();
    writeFile(out, ctx, jsx.toString().replace(/\n$/, ''), screen.ident, handles);

    const pkgName =
      toIdent(screen.ident, 'snake', 'tui_app').replace(/_/g, '-').replace(/-+$/, '') || 'tui-app';
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
      },
      include: ['src'],
    };
    const names = opentuiMembers(handles);
    const files: ExportFile[] = [
      { path: 'src/index.tsx', content: out.toString() },
      { path: 'src/ui-runtime.tsx', content: RUNTIME_SOURCE },
      { path: 'package.json', content: JSON.stringify(pkg, null, 2) + '\n' },
      { path: 'tsconfig.json', content: JSON.stringify(tsconfig, null, 2) + '\n' },
      ...(handles.length
        ? [
            {
              path: 'src/api.ts',
              content: renderFacade({
                lang: 'ts',
                handles,
                uiModule: './index',
                member: (h) => names.get(h)!,
              }).code,
            },
          ]
        : []),
    ];
    return files;
  },
};

/**
 * Whether a node is part of the generated component tree. Hidden nodes with a code name stay in
 * (the program can `show()` them); everything else that is not initially visible does not.
 */
function renderable(node: IRNode): boolean {
  if (node.visible) return true;
  const parent = node.parent;
  if (!parent || !renderable(parent)) return false;
  if (node.showWhen) return false;
  return node.hidden ? !!node.tag : true;
}

function renderableChildren(node: IRNode): IRNode[] {
  return node.children.filter(renderable);
}

// ── File assembly ─────────────────────────────────────────────────────────────

function writeFile(
  w: CodeWriter,
  ctx: Ctx,
  jsx: string,
  screenIdent: string,
  handles: ApiHandleModel[]
): void {
  w.line(`// OpenTUI (React) app for the screen "${screenIdent}", generated by TUI Studio.`);
  w.line(
    `// Targets @opentui/core and @opentui/react ${OPENTUI_VERSION} (React ${REACT_VERSION}); needs Bun.`
  );
  w.line('//');
  w.line('// Run:   bun install && bun run src/index.tsx');
  w.line('// Keys:  Tab / Shift+Tab move the focus, Enter or Space activate, q or Ctrl+C quit,');
  w.line('//        Ctrl+L shows the log panel, Esc closes a dialog.');
  w.line('//');
  w.line('// From your own program (see src/ui-runtime.tsx and PROGRAM_API.md):');
  w.line('//   import { Ui } from "./index";');
  w.line('//   const ui = new Ui();');
  w.line('//   await ui.start();                     // does not block');
  const first = handles[0];
  if (first) {
    const m = member(first);
    w.line(
      `//   ui.${m}.hide();                       // states, properties and events of every code name`
    );
  }
  w.line('//   await ui.wait();');
  w.line('//');
  w.line(
    '// Fill in the handler functions below; they are called by the components that name them.'
  );
  w.line();
  const react = ['useState', 'useMemo'];
  if (ctx.usesRef || ctx.usesSpinner || ctx.dropdown) react.push('useEffect');
  if (ctx.usesRef || ctx.dropdown) react.push('useRef');
  w.line(`import { ${react.join(', ')}, type ReactNode } from "react";`);
  const core = [
    ctx.usesAttrs ? 'TextAttributes' : '',
    ctx.usesRef ? 'type TabSelectRenderable' : '',
    ctx.dropdown ? 'type BoxRenderable, type SelectRenderable' : '',
  ].filter(Boolean);
  if (core.length) w.line(`import { ${core.join(', ')} } from "@opentui/core";`);
  w.line('import { useKeyboard } from "@opentui/react";');
  w.line('import { Handle, UiCore, useSlice, type UiHandler, type UiState } from "./ui-runtime";');
  if (handles.length) w.line('import { Api } from "./api";');
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

  writeFacade(w, ctx, handles);

  if (ctx.usesHit) {
    w.line(
      'type Hit = { x: number; y: number; scrollOffset?: number; setSelectedIndex?(index: number): void };'
    );
    w.line('type MouseAt = { target: unknown; x: number; y: number; stopPropagation(): void };');
    w.line();
    w.line(
      '/** The row of a list under the mouse, or -1 when the click was not on the list itself. */'
    );
    w.line('function rowAt(event: MouseAt): number {');
    w.line('  const list = event.target as Hit | null;');
    w.line('  if (!list || typeof list.setSelectedIndex !== "function") return -1;');
    w.line('  return event.y - list.y + (list.scrollOffset ?? 0);');
    w.line('}');
    w.line();
    w.line('/** The tab under the mouse (tabs are `tabWidth` cells wide), or -1. */');
    w.line('function tabAt(event: MouseAt, tabWidth: number): number {');
    w.line('  const bar = event.target as Hit | null;');
    w.line('  if (!bar || typeof bar.setSelectedIndex !== "function") return -1;');
    w.line('  return Math.floor((event.x - bar.x) / tabWidth);');
    w.line('}');
    w.line();
    w.line('function select(event: MouseAt, index: number): void {');
    w.line('  (event.target as Hit).setSelectedIndex?.(index);');
    w.line('}');
    w.line();
  }
  if (ctx.usesOptions) {
    w.line('function toOptions(labels: string[], prefixes: string[] = []) {');
    w.line(
      '  return labels.map((label, i) => ({ name: (prefixes[i] ?? "") + label, description: "", value: label }));'
    );
    w.line('}');
    w.line();
  }
  if (ctx.usesTable) {
    w.line('/** Header and rows of a table as aligned text lines (columns two cells apart). */');
    w.line('function tableLines(columns: string[], rows: string[][]): string[] {');
    w.line('  const count = Math.max(columns.length, ...rows.map((r) => r.length), 0);');
    w.line('  const cell = (r: string[], i: number) => r[i] ?? "";');
    w.line('  const widths = Array.from({ length: count }, (_, i) =>');
    w.line(
      '    Math.max([...cell(columns, i)].length, ...rows.map((r) => [...cell(r, i)].length), 1)'
    );
    w.line('  );');
    w.line('  const line = (r: string[]) =>');
    w.line(
      '    widths.map((n, i) => cell(r, i) + " ".repeat(n - [...cell(r, i)].length)).join("  ");'
    );
    w.line('  const head = columns.length ? [line(columns)] : [];');
    w.line('  return [...head, ...rows.map(line)];');
    w.line('}');
    w.line();
  }
  if (ctx.usesProgress) {
    w.line('function progressBar(value: number, max: number, width: number): string {');
    w.line('  const ratio = Math.max(0, Math.min(1, max > 0 ? value / max : 0));');
    w.line('  const filled = Math.round(ratio * Math.max(1, width - 5));');
    w.line('  const bar = "█".repeat(filled) + "░".repeat(Math.max(1, width - 5) - filled);');
    w.line('  return `${bar}${`${Math.round(ratio * 100)}%`.padStart(5)}`;');
    w.line('}');
    w.line();
  }
  if (ctx.usesTabs) {
    w.line(
      '/** The line under a tab bar: `╸━━╺` below the active tab (` label ` cells), `━` elsewhere. */'
    );
    w.line('function tabsRule(labels: string[], active: number): string {');
    w.line('  const cells = (l: string) => [...l].length + 2;');
    w.line('  const before = labels.slice(0, active).reduce((n, l) => n + cells(l), 0);');
    w.line('  const own = active >= labels.length ? 0 : cells(labels[active]);');
    w.line(
      '  return "━".repeat(before) + (own >= 2 ? "╸" + "━".repeat(own - 2) + "╺" : "") + "━".repeat(500);'
    );
    w.line('}');
    w.line();
  }
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

  if (ctx.dropdown) {
    w.line(
      `const SELECTS = new Set<string>([${ctx.opens
        .map((c) => c.split('"')[1])
        .map(jsStr)
        .join(', ')}]);`
    );
  }
  w.line(`const TEXT_FIELDS = new Set<string>([${ctx.textFields.map(jsStr).join(', ')}]);`);
  if (ctx.tabMoves.length)
    w.line(`const TABS = new Set<string>([${ctx.tabIds.map(jsStr).join(', ')}]);`);
  w.line();
  w.line('function App({ ui }: { ui: Ui }) {');
  w.indent();
  w.line('const sys = useSlice<{ dialog: unknown[]; scroll: number }>(ui, "$ui");');
  if (ctx.dropdown) {
    w.line('// The open dropdown (one at a time) and its popup list.');
    w.line(
      'const [openSel, setOpenSel] = useState<{ id: string; up: boolean; x: number; y: number; w: number } | null>(null);'
    );
    w.line('const popRef = useRef<SelectRenderable | null>(null);');
    w.line('useEffect(() => {');
    w.line('  setOpenSel(null);');
    w.line('}, [sys.scroll]);');
  }
  w.line('const [focus, setFocus] = useState<string>(' + jsStr(ctx.focusOrder[0]?.id ?? '') + ');');
  for (const line of ctx.hooks) w.block(line);
  w.line();
  if (ctx.focusOrder.length) {
    w.line('const order = ([');
    for (const f of ctx.focusOrder) w.line(`  [${jsStr(f.id)}, ${f.cond}],`);
    w.line('] as [string, boolean][])');
    w.line('  .filter(([, ok]) => ok)');
    w.line('  .map(([id]) => id);');
  } else {
    w.line('const order: string[] = [];');
  }
  w.line('// Nothing has the focus while an error dialog is open.');
  w.line('const focusId = sys.dialog.length === 0 && order.includes(focus) ? focus : "";');
  w.line();
  if (ctx.dropdown) {
    w.line(
      'const dd = openSel && order.includes(openSel.id) && sys.dialog.length === 0 ? openSel : null;'
    );
    w.line('ui.capture = dd !== null;');
    w.line();
    w.line('const closeDropdown = () => setOpenSel(null);');
    w.line('const openDropdown = (id: string) => {');
    w.line('  switch (id) {');
    for (const c of ctx.opens) w.block('    ' + c.replace(/\n/g, '\n    '));
    w.line('    default:');
    w.line('      break;');
    w.line('  }');
    w.line('};');
    w.line('const fieldClick = (id: string) => {');
    w.line('  if (ui.blocked || !order.includes(id)) return;');
    w.line('  setFocus(id);');
    w.line('  openDropdown(id);');
    w.line('};');
    w.line('const pick = (id: string, index: number) => {');
    w.line('  setOpenSel(null);');
    w.line('  switch (id) {');
    for (const c of ctx.picks) w.block('    ' + c.replace(/\n/g, '\n    '));
    w.line('    default:');
    w.line('      break;');
    w.line('  }');
    w.line('};');
    w.line();
  }
  if (ctx.tabMoves.length) {
    w.line('// Left and Right change the tab of a focused tab bar.');
    w.line('const moveTab = (id: string, step: number) => {');
    w.line('  switch (id) {');
    for (const c of ctx.tabMoves) w.block('    ' + c.replace(/\n/g, '\n    '));
    w.line('    default:');
    w.line('      break;');
    w.line('  }');
    w.line('};');
    w.line();
  }
  w.line('const move = (step: number) => {');
  w.line('  if (!order.length) return;');
  w.line('  const at = order.indexOf(focusId);');
  w.line('  setFocus(order[(at + step + order.length) % order.length]);');
  w.line('};');
  w.line();
  w.line('// Mouse: a click focuses and activates; nothing behind an error dialog reacts.');
  w.line('const focusOn = (id: string) => {');
  w.line('  if (!ui.blocked && order.includes(id)) setFocus(id);');
  w.line('};');
  w.line('const click = (id: string) => {');
  w.line('  if (ui.blocked || !order.includes(id)) return;');
  w.line('  setFocus(id);');
  w.line('  activate(id);');
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
  if (ctx.dropdown) {
    w.line(
      '// The popup lists are drawn by the runtime above the whole UI (and below error dialogs).'
    );
    w.line('const popups = (');
    w.line('  <>');
    for (const p of ctx.popups) w.block(p.replace(/\n$/, '').replace(/^/gm, '    '));
    w.line('  </>');
    w.line(');');
    w.line('useEffect(() => {');
    w.line('  ui.setOverlay(popups);');
    w.line('});');
    w.line('useEffect(() => () => ui.setOverlay(null), []);');
    w.line();
  }
  w.line('useKeyboard((key) => {');
  if (ctx.dropdown) {
    w.line('  if (dd && !key.ctrl) {');
    w.line('    // Up, Down and Enter are handled by the popup list itself.');
    w.line('    const list = popRef.current;');
    w.line('    if (key.name === "escape" || key.name === "tab") closeDropdown();');
    w.line(
      '    else if (key.name === "space" || key.name === " ") pick(dd.id, list?.getSelectedIndex() ?? 0);'
    );
    w.line('    else if (key.name === "home") list?.setSelectedIndex(0);');
    w.line(
      '    else if (key.name === "end") list?.setSelectedIndex(Math.max(0, (list?.options.length ?? 1) - 1));'
    );
    w.line('    return;');
    w.line('  }');
    w.line('  if (key.name === "down" && SELECTS.has(focusId)) return openDropdown(focusId);');
  }
  w.line('  if (ui.handleKey(key)) return;');
  if (ctx.tabMoves.length)
    w.line(
      '  if ((key.name === "left" || key.name === "right") && TABS.has(focusId)) return moveTab(focusId, key.name === "left" ? -1 : 1);'
    );
  w.line('  if (key.name === "tab") return move(key.shift ? -1 : 1);');
  w.line('  if (TEXT_FIELDS.has(focusId)) return;');
  w.line('  if (key.name === "q") return ui.stop();');
  w.line(
    '  if (key.name === "return" || key.name === "space" || key.name === " ") activate(focusId);'
  );
  w.line('});');
  w.line();
  w.line('return (');
  w.block(jsx);
  w.line(');');
  w.dedent();
  w.line('}');
  w.line();
  w.line('// Started directly (bun run src/index.tsx): show the UI until it is closed.');
  w.line('if ((import.meta as { main?: boolean }).main) {');
  w.line('  const ui = new Ui();');
  w.line('  await ui.start();');
  w.line('  await ui.wait();');
  w.line('  (globalThis as { process?: { exit(code?: number): void } }).process?.exit(0);');
  w.line('}');
}

// ── Program API facade ────────────────────────────────────────────────────────

const TS_TYPE = {
  str: 'string',
  int: 'number',
  float: 'number',
  bool: 'boolean',
  str_list: 'string[]',
  rows: 'string[][]',
};
const COERCE: Record<string, (v: string) => string> = {
  str: (v) => `String(${v})`,
  int: (v) => `Math.trunc(Number(${v}))`,
  float: (v) => `Number(${v})`,
  bool: (v) => `Boolean(${v})`,
  str_list: (v) => `[...${v}].map(String)`,
  rows: (v) => `[...${v}].map((r) => [...r].map(String))`,
};
const STATE_NAME = {
  active: 'active',
  muted: 'muted',
  readonly: 'readonly',
  hidden: 'hidden',
} as const;

function member(h: ApiHandleModel): string {
  return safeIdent(apiName(h.tag, 'camel'), 'ts');
}

function lit(v: unknown): string {
  if (typeof v === 'string') return jsStr(v);
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '0';
  if (typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(lit).join(', ')}]`;
  return 'null';
}

/** Initial values of a handle: what the user sees when the UI opens. */
function initialValues(h: ApiHandleModel): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of h.properties) out[p.name] = p.initial;
  if (h.type === 'Select' && !out.value) out.value = (out.options as string[])[0] ?? '';
  if (h.type === 'Modal') out.open = false;
  return out;
}

/** Member of `ui` per handle: camelCase, keywords and clashes with the core get a `_`. */
function opentuiMembers(handles: ApiHandleModel[]): Map<ApiHandleModel, string> {
  const used = new Set(CORE_MEMBERS);
  const names = new Map<ApiHandleModel, string>();
  for (const h of handles) {
    let m = member(h);
    while (used.has(m)) m += '_';
    used.add(m);
    names.set(h, m);
  }
  return names;
}

function writeFacade(w: CodeWriter, ctx: Ctx, handles: ApiHandleModel[]): void {
  const classNames = new Map<ApiHandleModel, string>();
  const members = opentuiMembers(handles);
  for (const h of handles) {
    classNames.set(h, unique(ctx, recase(members.get(h)!.replace(/_$/, ''), 'pascal') + 'Handle'));
  }

  w.line('// ── Program API ───────────────────────────────────────────────────────────────');
  w.line(
    '// One typed handle per code name; `ui.<name>` below. Writing a property never fires an event.'
  );
  w.line();
  for (const h of handles) {
    const cls = classNames.get(h)!;
    const states = h.states.map((s) => jsStr(STATE_NAME[s])).join(', ');
    w.line(`class ${cls} extends Handle {`);
    w.indent();
    w.line('constructor(ui: UiCore) {');
    w.line(`  super(ui, ${jsStr(h.tag)}, ${jsStr(h.type)}, [${states}]);`);
    w.line('}');
    for (const p of h.properties) {
      const name = apiMember(p.name, 'camel');
      const type = TS_TYPE[p.type];
      w.line(`get ${name}(): ${type} {`);
      w.line(`  return this._get(${jsStr(p.name)}) as ${type};`);
      w.line('}');
      w.line(`set ${name}(value: ${type}) {`);
      w.line(`  this._set(${jsStr(p.name)}, ${COERCE[p.type]('value')});`);
      w.line('}');
    }
    for (const e of h.events) {
      const method = apiMember(e.name, 'camel', 'on');
      w.line(`${method}(handler: UiHandler): () => void {`);
      w.line(`  return this._on(${jsStr(e.name)}, handler);`);
      w.line('}');
    }
    if (h.type === 'Modal') {
      w.line('get isOpen(): boolean {');
      w.line('  return Boolean(this._get("open"));');
      w.line('}');
      w.line('open(): void {');
      w.line('  this._set("open", true);');
      w.line('}');
      w.line('close(): void {');
      w.line('  this._set("open", false);');
      w.line('}');
    }
    w.dedent();
    w.line('}');
    w.line();
  }

  w.line('export class Ui extends UiCore {');
  w.indent();
  for (const h of handles) w.line(`readonly ${members.get(h)}: ${classNames.get(h)};`);
  if (handles.length) w.line('/** Flat methods over the components (see api.ts). */').line('readonly api: Api;');
  w.line('constructor() {');
  w.indent();
  w.line('super();');
  for (const h of handles) {
    const init = Object.entries({ state: h.initialState, ...initialValues(h) })
      .map(([k, v]) => `${/^[A-Za-z_]\w*$/.test(k) ? k : jsStr(k)}: ${lit(v)}`)
      .join(', ');
    w.line(`this.${members.get(h)} = this.add(new ${classNames.get(h)}(this), { ${init} });`);
  }
  if (handles.length) w.line('this.api = new Api(this);');
  w.dedent();
  w.line('}');
  w.line('protected view(): ReactNode {');
  w.line('  return <App ui={this} />;');
  w.line('}');
  w.dedent();
  w.line('}');
  w.line();
  void ctx;
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

/** `ui.emit(tag, name, value, [stubs])` as a statement. */
function emitCall(node: IRNode, ctx: Ctx, name: string, value: string, stubs: string[]): string {
  const tag = ctx.tagged.get(node.id)?.handle.tag;
  return `ui.emit(${tag === undefined ? 'null' : jsStr(tag)}, ${jsStr(name)}, ${value}, [${stubs.join(', ')}]);`;
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

function posSize(
  ctx: Ctx,
  node: IRNode,
  parent: IRNode | null,
  autoHeight?: number,
  autoWidth?: number,
  fillAuto = false
): string[] {
  const props: string[] = [];
  if (!parent) {
    return ['width="100%"', 'minHeight="100%"'];
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
    props.push(`left={${left}}`, `top={${top}}`, 'zIndex={10}');
  } else if (parent.layout.mode === 'absolute') {
    props.push('position="absolute"', `left={${node.layout.x}}`, `top={${node.layout.y}}`);
  }
  const rowParent = isFlowParent(parent) && parent.layout.direction === 'row';
  let grow = false;
  if (typeof node.width === 'number') props.push(`width={${node.width}}`);
  else if (node.width === 'fill') {
    if (rowParent) grow = true;
    else props.push('width="100%"');
  } else if (fillAuto) {
    // Selection widgets without a width take the whole width of their parent (like Textual).
    if (rowParent) grow = true;
    else props.push('width="100%"');
  } else if (autoWidth !== undefined) props.push(`width={${autoWidth}}`);
  if (typeof node.height === 'number') props.push(`height={${node.height}}`);
  else if (node.height === 'fill') {
    if (isFlowParent(parent) && !rowParent) grow = true;
    else props.push('height="100%"');
  } else if (autoHeight !== undefined) props.push(`height={${autoHeight}}`);
  if (node.type === 'Modal') {
    if (node.width === 'auto' && node.box) props.push(`width={${node.box.width}}`);
    if (node.height === 'auto' && node.box) props.push(`height={${node.box.height}}`);
  }
  // Fixed and content-sized boxes keep their size; the root clips what does not fit.
  props.push(grow ? 'flexGrow={1}' : 'flexShrink={0}');
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

function sv(ctx: Ctx, node: IRNode): string | null {
  return ctx.tagged.get(node.id)?.sv ?? null;
}

/** Base attribute bits of a node's text style (bold, italic, ...), plus dimming while muted. */
function attrBits(node: IRNode, ctx: Ctx, extra: string[] = []): string[] {
  const s = node.style;
  const bits = [...extra];
  if (s.bold) bits.push('TextAttributes.BOLD');
  if (s.italic) bits.push('TextAttributes.ITALIC');
  if (s.underline) bits.push('TextAttributes.UNDERLINE');
  if (s.strikethrough) bits.push('TextAttributes.STRIKETHROUGH');
  if (node.disabled) bits.push('TextAttributes.DIM');
  const v = sv(ctx, node);
  if (v) bits.push(`(${v}.state === "muted" ? TextAttributes.DIM : 0)`);
  if (bits.length) ctx.usesAttrs = true;
  return bits;
}

function attrProp(bits: string[], focusId?: string): string | null {
  const all = [...bits];
  if (focusId) all.push(`(focusId === ${jsStr(focusId)} ? TextAttributes.INVERSE : 0)`);
  return all.length ? `attributes={${all.join(' | ')}}` : null;
}

function colorProps(node: IRNode, fgName: string, bgName: string): string[] {
  const props: string[] = [];
  if (node.style.fg) props.push(sAttr(fgName, node.style.fg));
  if (node.style.bg) props.push(sAttr(bgName, node.style.bg));
  return props;
}

/** Colours of a widget that has no `attributes` (input, select): dimmed grey while muted. */
function widgetColors(ctx: Ctx, node: IRNode): string[] {
  const v = sv(ctx, node);
  const props: string[] = [];
  if (v) {
    const fg = node.style.fg ? jsStr(node.style.fg) : '"#ffffff"';
    props.push(`textColor={${v}.state === "muted" ? "#808080" : ${fg}}`);
    if (node.style.bg) props.push(sAttr('backgroundColor', node.style.bg));
    return props;
  }
  return colorProps(node, 'textColor', 'backgroundColor');
}

/** Expression of a string property: the store value for code-named nodes, else the literal. */
function textExpr(ctx: Ctx, node: IRNode, prop: string, literal: string): string {
  const v = sv(ctx, node);
  return v ? `${v}.${prop}` : jsStr(literal);
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
  /** Width in cells when the node has none (selection widgets have no intrinsic width). */
  autoWidth?: number;
  /** Always use an outer <box> that carries position and size. */
  forceWrap?: boolean;
  /** Without an explicit width the widget fills the width of its parent. */
  fill?: boolean;
  /** Extra props of the outer <box> (bordered widgets only). */
  outerExtra?: string[];
  /** Elements drawn on top of the widget, inside the outer <box> (bordered widgets only). */
  after?: () => void;
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
    el(
      w,
      o.tag,
      [...posSize(ctx, node, parent, o.autoHeight, o.autoWidth, o.fill), ...o.props],
      o.children
    );
    return;
  }
  const outer = [
    ...posSize(
      ctx,
      node,
      parent,
      undefined,
      o.autoWidth !== undefined ? o.autoWidth + (node.style.border ? 2 : 0) : undefined,
      o.fill
    ),
    ...borderProps(node),
    ...(o.outerExtra ?? []),
  ];
  if (aligned) {
    outer.push(
      'flexDirection="row"',
      `justifyContent="${align === 'center' ? 'center' : 'flex-end'}"`
    );
  }
  // Clicks anywhere in the bordered area count, so the handler sits on the outer box.
  const isMouse = (p: string | null) => !!p && p.startsWith('onMouseDown=');
  outer.push(...(o.props.filter(isMouse) as string[]));
  el(w, 'box', outer, () => {
    const inner: (string | null)[] = o.props.filter((p) => !isMouse(p));
    if (!aligned) inner.unshift('flexGrow={1}');
    if (o.autoHeight !== undefined && node.height === 'auto')
      inner.unshift(`height={${o.autoHeight}}`);
    el(w, o.tag, inner, o.children);
    o.after?.();
  });
}

// ── Focus ─────────────────────────────────────────────────────────────────────

/** Condition under which a node (and its ancestors with code names) is reachable by the user. */
function reachable(ctx: Ctx, node: IRNode): string {
  const parts: string[] = [];
  for (let n: IRNode | null = node; n; n = n.parent) {
    const t = ctx.tagged.get(n.id);
    if (!t || !n.parent) continue;
    if (n === node) parts.push(`${t.sv}.state === "active"`);
    else parts.push(guard(t));
  }
  return parts.length ? parts.join(' && ') : 'true';
}

function guard(t: Tagged): string {
  return t.handle.type === 'Modal'
    ? `${t.sv}.open && ${t.sv}.state !== "hidden"`
    : `${t.sv}.state !== "hidden"`;
}

function focusable(ctx: Ctx, node: IRNode): void {
  if (node.disabled) return;
  ctx.focusOrder.push({ id: node.ident, cond: reachable(ctx, node) });
}

/** Declare the store slice of a code-named node (once). */
function declareSlice(ctx: Ctx, node: IRNode): void {
  const t = ctx.tagged.get(node.id);
  if (!t) return;
  const fields = [`state: UiState`];
  for (const p of t.handle.properties) fields.push(`${p.name}: ${TS_TYPE[p.type]}`);
  if (t.handle.type === 'Modal') fields.push('open: boolean');
  ctx.hooks.push(`const ${t.sv} = useSlice<{ ${fields.join('; ')} }>(ui, ${jsStr(t.handle.tag)});`);
}

// ── Emission ──────────────────────────────────────────────────────────────────

function emit(ctx: Ctx, w: CodeWriter, node: IRNode, parent: IRNode | null): void {
  const t = ctx.tagged.get(node.id);
  if (t && parent) {
    declareSlice(ctx, node);
    w.line(`{${guard(t)} && (`);
    w.indent();
    emitNode(ctx, w, node, parent);
    w.dedent();
    w.line(')}');
    return;
  }
  emitNode(ctx, w, node, parent);
}

function emitNode(ctx: Ctx, w: CodeWriter, node: IRNode, parent: IRNode | null): void {
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
        props: [
          ...colorProps(node, 'fg', 'bg'),
          attrProp(bits),
          `content={${textExpr(ctx, node, 'text', node.text)}}`,
        ],
      });
    }
    case 'Spinner': {
      ctx.usesSpinner = true;
      const fg = node.style.fg ? ` fg=${jsStr(node.style.fg)}` : '';
      const label = textExpr(ctx, node, 'label', node.text || 'Loading...');
      return el(w, 'box', posSize(ctx, node, parent), () => {
        w.line(`<SpinnerText label={${label}}${fg} />`);
      });
    }
    case 'ProgressBar': {
      const width = typeof node.width === 'number' ? node.width : (node.box?.width ?? 20);
      const bits = attrBits(node, ctx);
      const v = sv(ctx, node);
      // The bar fills what is left of the box after the border; the percentage takes 5 cells.
      const inner = Math.max(6, width - (node.style.border ? 2 : 0));
      let content: string;
      if (v) {
        ctx.usesProgress = true;
        content = `progressBar(${v}.value, ${v}.max, ${inner})`;
      } else {
        const pct = Math.round(
          Math.max(0, Math.min(1, node.progress.value / node.progress.max)) * 100
        );
        const barWidth = Math.max(1, inner - 5);
        content = jsStr(`${progressText(node, barWidth)}${`${pct}%`.padStart(5)}`);
      }
      return leaf(ctx, w, node, parent, {
        tag: 'text',
        props: [...colorProps(node, 'fg', 'bg'), attrProp(bits), `content={${content}}`],
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
      return dropdown(ctx, w, node, parent);
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
  // A click that no widget used closes an open dropdown.
  if (!parent && ctx.dropdown) props.push('onMouseDown={() => closeDropdown()}');
  if (node.type === 'Modal') {
    props.push(...borderProps(node, true));
    const v = sv(ctx, node);
    if (v) props.push(`title={${v}.title}`, 'titleAlignment="center"');
    else if (node.text) props.push(`title={${jsStr(node.text)}}`, 'titleAlignment="center"');
    props.push(sAttr('backgroundColor', node.style.bg ?? '#000000'));
  } else {
    props.push(...borderProps(node));
    if (node.style.bg) props.push(sAttr('backgroundColor', node.style.bg));
  }
  props.push(...flexProps(node), ...paddingProps(node));
  const kids = renderableChildren(node);
  if (!kids.length) return el(w, 'box', props);
  el(w, 'box', props, () => kids.forEach((c) => emit(ctx, w, c, node)));
}

function grid(ctx: Ctx, w: CodeWriter, node: IRNode, parent: IRNode | null): void {
  const l = node.layout;
  const cols = Math.max(1, l.columns);
  const kids = renderableChildren(node);
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
      const rowProps = [
        'flexDirection="row"',
        'flexGrow={1}',
        'flexShrink={0}',
        'alignItems="flex-start"',
      ];
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

// ── State accessors (store for code-named nodes, React state otherwise) ──────

function getChecked(ctx: Ctx, node: IRNode): string {
  const v = sv(ctx, node);
  return v ? `${v}.checked` : ctx.state.get(node.id)!.value;
}

function setChecked(ctx: Ctx, node: IRNode, expr: string): string {
  const t = ctx.tagged.get(node.id);
  return t
    ? `ui.store.patch(${jsStr(t.handle.tag)}, { checked: ${expr} });`
    : `${ctx.state.get(node.id)!.set}(${expr});`;
}

function textInput(ctx: Ctx, w: CodeWriter, node: IRNode, parent: IRNode | null): void {
  const t = ctx.tagged.get(node.id);
  const v = sv(ctx, node);
  const focusableNode = !node.disabled;
  if (focusableNode) {
    focusable(ctx, node);
    ctx.textFields.push(node.ident);
  }
  const onInput = handlers(ctx, node, /change|input/i);
  const onSubmit = handlers(ctx, node, /submit|enter/i);
  let valueExpr: string;
  let write: string;
  let guardLine = '';
  if (t) {
    valueExpr = `${v}.value`;
    write = `ui.store.patch(${jsStr(t.handle.tag)}, { value });`;
    guardLine = `if (!ui.isActive(${jsStr(t.handle.tag)}) || ui.store.get(${jsStr(t.handle.tag)}).value === value) return; `;
  } else {
    const st = ctx.state.get(node.id)!;
    ctx.hooks.push(`const [${st.value}, ${st.set}] = useState(${jsStr(node.value)});`);
    valueExpr = st.value;
    write = `${st.set}(value);`;
  }
  const props: (string | null)[] = [
    `value={${valueExpr}}`,
    `placeholder={${textExpr(ctx, node, 'placeholder', node.placeholder)}}`,
    ...widgetColors(ctx, node),
    focusableNode ? `focused={focusId === ${jsStr(node.ident)}}` : null,
    focusableNode ? `onMouseDown={() => focusOn(${jsStr(node.ident)})}` : null,
    `onInput={(value: string) => { ${guardLine}${write} ${emitCall(node, ctx, 'change', 'value', onInput)} }}`,
  ];
  if (t || onSubmit.length) {
    props.push(
      `onSubmit={(submitted: unknown) => { const value = typeof submitted === "string" ? submitted : ${valueExpr}; ${emitCall(node, ctx, 'submit', 'value', onSubmit)} }}`
    );
  }
  // Textual indents the text of an input by two cells inside its border.
  leaf(ctx, w, node, parent, {
    tag: 'input',
    props,
    outerExtra: node.style.border ? ['paddingLeft={2}'] : [],
  });
}

function button(ctx: Ctx, w: CodeWriter, node: IRNode, parent: IRNode | null): void {
  const t = ctx.tagged.get(node.id);
  const fns = handlers(ctx, node);
  if (!node.disabled) {
    focusable(ctx, node);
    const guardLine = t ? `if (!ui.isActive(${jsStr(t.handle.tag)})) break;\n` : '';
    ctx.cases.push(
      `case ${jsStr(node.ident)}:\n  ${guardLine}${emitCall(node, ctx, 'click', 'null', fns)}\n  break;`
    );
  }
  const props = [...posSize(ctx, node, parent), ...borderProps(node)];
  if (node.style.bg) props.push(sAttr('backgroundColor', node.style.bg));
  // Like Textual's Button: at least 16 cells wide, the label centred.
  if (node.width === 'auto') props.push('minWidth={16}');
  props.push(
    'flexDirection="row"',
    'justifyContent="center"',
    'paddingLeft={1}',
    'paddingRight={1}'
  );
  if (!node.disabled) props.push(`onMouseDown={() => click(${jsStr(node.ident)})}`);
  const bits = attrBits(node, ctx);
  let label = jsStr(inlineText(node));
  if (t) {
    const left = node.iconLeft ? `${node.iconLeft} ` : '';
    const right = node.iconRight ? ` ${node.iconRight}` : '';
    label = `${left ? jsStr(left) + ' + ' : ''}${t.sv}.label${right ? ' + ' + jsStr(right) : ''}`;
  }
  el(w, 'box', props, () => {
    el(w, 'text', [
      ...(node.style.fg ? [sAttr('fg', node.style.fg)] : []),
      attrProp(bits, node.disabled ? undefined : node.ident),
      `content={${label}}`,
    ]);
  });
  if (!node.disabled) ctx.usesAttrs = true;
}

function toggleLike(ctx: Ctx, w: CodeWriter, node: IRNode, parent: IRNode | null): void {
  const t = ctx.tagged.get(node.id);
  if (!t) {
    const st = ctx.state.get(node.id)!;
    ctx.hooks.push(
      `const [${st.value}, ${st.set}] = useState(${node.checked ? 'true' : 'false'});`
    );
  }
  const checked = getChecked(ctx, node);
  const on = inlineText({ ...node, checked: true, text: '' });
  const off = inlineText({ ...node, checked: false, text: '' });
  const fns = handlers(ctx, node);
  if (!node.disabled) {
    focusable(ctx, node);
    const guardLine = t ? `if (!ui.isActive(${jsStr(t.handle.tag)})) break;\n` : '';
    let body: string;
    if (node.type === 'Radio') {
      const sibs = (node.parent?.children ?? []).filter(
        (c) => c !== node && c.type === 'Radio' && renderable(c)
      );
      const clear = sibs.map((s) => setChecked(ctx, s, 'false'));
      body = [
        `if (${checked}) break;`,
        setChecked(ctx, node, 'true'),
        ...clear,
        emitCall(node, ctx, 'change', 'true', fns),
      ].join('\n');
    } else {
      body = [
        `const next = !${checked};`,
        setChecked(ctx, node, 'next'),
        emitCall(node, ctx, 'change', 'next', fns),
      ].join('\n');
    }
    ctx.cases.push(
      `case ${jsStr(node.ident)}: {\n  ${guardLine}${body.replace(/\n/g, '\n  ')}\n  break;\n}`
    );
  }
  const bits = attrBits(node, ctx);
  if (!node.disabled) ctx.usesAttrs = true;
  leaf(ctx, w, node, parent, {
    tag: 'text',
    props: [
      ...colorProps(node, 'fg', 'bg'),
      attrProp(bits, node.disabled ? undefined : node.ident),
      `content={(${checked} ? ${jsStr(on)} : ${jsStr(off)}) + ${textExpr(ctx, node, 'label', node.text)}}`,
      ...(node.disabled ? [] : [`onMouseDown={() => click(${jsStr(node.ident)})}`]),
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
  const t = ctx.tagged.get(node.id);
  const tag = t ? jsStr(t.handle.tag) : '';
  const focusableNode = !node.disabled;
  if (focusableNode) focusable(ctx, node);
  const fns = handlers(ctx, node);
  const id = jsStr(node.ident);
  // Only a change made while the widget has the focus comes from the user.
  const userGuard = `if (focusId !== ${id}) return;`;
  const props: (string | null)[] = ['showDescription={false}'];
  // A list shows its labels from the first cell on; the selected row is marked by colour only.
  // OpenTUI's select indents its rows by one cell. Starting it on the border cell removes the
  // indent; the left border is drawn again on top of it (the selection bar would hide it).
  const leftBorder = node.type === 'List' && node.style.border?.left ? node.style.border : null;
  if (node.type === 'List') props.push('showSelectionIndicator={false}');
  if (leftBorder) props.push('marginLeft={-1}');
  let count: number;
  if (node.type === 'Select') {
    if (t) {
      ctx.usesOptions = true;
      const opts = unique(ctx, recase(node.ident, 'camel') + 'Opts');
      ctx.hooks.push(
        `const ${opts} = useMemo(() => toOptions(${t.sv}.options), [${t.sv}.options]);`
      );
      props.push(
        `options={${opts}}`,
        `selectedIndex={Math.max(0, ${t.sv}.options.indexOf(${t.sv}.value))}`
      );
      props.push(
        `onChange={(index: number) => { ${userGuard} const value = ${t.sv}.options[index] ?? ""; ` +
          `if (ui.store.get(${tag}).value === value) return; ui.store.patch(${tag}, { value }); ` +
          `${emitCall(node, ctx, 'change', 'value', fns)} }}`
      );
    } else {
      const st = ctx.state.get(node.id)!;
      const idx = Math.max(0, node.options.indexOf(node.value));
      ctx.hooks.push(`const [${st.value}, ${st.set}] = useState(${idx});`);
      props.push(
        `options={${optionsConst(ctx, node, node.options)}}`,
        `selectedIndex={${st.value}}`
      );
      props.push(
        `onChange={(index: number) => { ${st.set}(index); ${emitCall(node, ctx, 'change', 'index', fns)} }}`
      );
    }
    count = node.options.length;
  } else if (node.type === 'List') {
    count = node.items.length;
    if (t) {
      ctx.usesOptions = true;
      const opts = unique(ctx, recase(node.ident, 'camel') + 'Opts');
      ctx.hooks.push(`const ${opts} = useMemo(() => toOptions(${t.sv}.items), [${t.sv}.items]);`);
      props.push(`options={${opts}}`, `selectedIndex={${t.sv}.selected}`);
      props.push(
        `onChange={(index: number) => { ${userGuard} if (ui.store.get(${tag}).selected !== index) ui.store.patch(${tag}, { selected: index }); }}`
      );
      props.push(
        `onSelect={(index: number) => { ${userGuard} ui.store.patch(${tag}, { selected: index }); ${emitCall(node, ctx, 'select', 'index', fns)} }}`
      );
    } else {
      props.push(
        `options={${optionsConst(
          ctx,
          node,
          node.items.map((i) => i.label)
        )}}`
      );
      if (node.selected > 0) props.push(`selectedIndex={${node.selected}}`);
      if (fns.length)
        props.push(
          `onSelect={(index: number) => { ${emitCall(node, ctx, 'select', 'index', fns)} }}`
        );
    }
  } else {
    count = node.items.length;
    props.push(
      `options={${optionsConst(
        ctx,
        node,
        node.items.map((i) => itemText(i, true))
      )}}`
    );
    if (t) {
      props.push(`selectedIndex={${t.sv}.selected}`);
      props.push(
        `onChange={(index: number) => { ${userGuard} if (ui.store.get(${tag}).selected !== index) ui.store.patch(${tag}, { selected: index }); }}`
      );
      props.push(
        `onSelect={(index: number) => { ${userGuard} ui.store.patch(${tag}, { selected: index }); ${emitCall(node, ctx, 'select', 'index', fns)} }}`
      );
    } else {
      if (node.selected > 0) props.push(`selectedIndex={${node.selected}}`);
      if (fns.length)
        props.push(
          `onSelect={(index: number) => { ${emitCall(node, ctx, 'select', 'index', fns)} }}`
        );
    }
  }
  if (focusableNode) props.push(`focused={focusId === ${id}}`);
  props.push(mouseSelect(ctx, node, tag, id));
  props.push(...widgetColors(ctx, node));
  const texts = node.type === 'Select' ? node.options : node.items.map((i) => itemText(i, true));
  const autoWidth = Math.max(12, ...texts.map((t) => [...t].length + 4));
  leaf(ctx, w, node, parent, {
    tag: 'select',
    props,
    autoHeight: Math.max(1, Math.min(count, 8)),
    autoWidth: node.type === 'List' ? undefined : autoWidth,
    fill: node.type === 'List',
    after: leftBorder
      ? () => {
          const rows =
            typeof node.height === 'number'
              ? Math.max(1, node.height - 2)
              : Math.max(1, Math.min(count, 8));
          const glyph =
            { single: '│', rounded: '│', double: '║', bold: '┃' }[leftBorder.kind] ?? '│';
          el(
            w,
            'text',
            [
              'position="absolute"',
              'left={-1}',
              'top={0}',
              sAttr('fg', leftBorder.color || '#ffffff'),
              `content={${jsStr(Array(rows).fill(glyph).join('\n'))}}`,
            ],
            undefined
          );
        }
      : undefined,
  });
}

/**
 * Select as a dropdown: a one-line field with the current value; the options are a popup list
 * (absolute, above the content) that is open only while the user chooses.
 */
/** Width of the popup list when the field could not be measured. */
function outerWidthFor(node: IRNode): number {
  const inner = Math.max(10, ...node.options.map((x) => [...x].length + 4));
  return typeof node.width === 'number' ? node.width : inner + 2;
}

function dropdown(ctx: Ctx, w: CodeWriter, node: IRNode, parent: IRNode | null): void {
  const t = ctx.tagged.get(node.id);
  const tag = t ? jsStr(t.handle.tag) : '';
  const id = jsStr(node.ident);
  const enabled = !node.disabled;
  if (enabled) focusable(ctx, node);
  const fns = handlers(ctx, node);
  const fieldRef = unique(ctx, recase(node.ident, 'camel') + 'Field');
  ctx.hooks.push(`const ${fieldRef} = useRef<BoxRenderable | null>(null);`);
  ctx.usesHit = true;

  const n = node.options.length;
  let current: string;
  let label: string;
  let count: string;
  let options: string;
  let popup: string;
  if (t) {
    ctx.usesOptions = true;
    options = unique(ctx, recase(node.ident, 'camel') + 'Opts');
    ctx.hooks.push(
      `const ${options} = useMemo(() => toOptions(${t.sv}.options), [${t.sv}.options]);`
    );
    current = `Math.max(0, ${t.sv}.options.indexOf(${t.sv}.value))`;
    label = `${t.sv}.value`;
    count = `${t.sv}.options.length`;
    popup = `Math.max(1, Math.min(${count}, 6))`;
    ctx.picks.push(
      `case ${id}: {\n  const value = ${t.sv}.options[index];\n  if (value == null || ui.store.get(${tag}).value === value) break;\n  ui.store.patch(${tag}, { value });\n  ${emitCall(node, ctx, 'change', 'value', fns)}\n  break;\n}`
    );
  } else {
    const st = ctx.state.get(node.id)!;
    ctx.hooks.push(
      `const [${st.value}, ${st.set}] = useState(${Math.max(0, node.options.indexOf(node.value))});`
    );
    options = optionsConst(ctx, node, node.options);
    current = st.value;
    label = `${options}[${st.value}]?.name ?? ""`;
    count = String(n);
    popup = String(Math.max(1, Math.min(n, 6)));
    ctx.picks.push(
      `case ${id}: {\n  if (${st.value} === index) break;\n  ${st.set}(index);\n  ${emitCall(node, ctx, 'change', 'index', fns)}\n  break;\n}`
    );
  }
  const guard = t ? `if (!ui.isActive(${tag})) break;\n  ` : '';
  if (enabled) ctx.cases.push(`case ${id}:\n  ${guard}openDropdown(${id});\n  break;`);
  ctx.opens.push(
    `case ${id}:\n  return setOpenSel({ id, up: (${fieldRef}.current?.y ?? 0) + 3 + ${popup} + 2 > (ui.renderer?.height ?? 24), x: ${fieldRef}.current?.x ?? 0, y: ${fieldRef}.current?.y ?? 0, w: ${fieldRef}.current?.width ?? ${outerWidthFor(node)} });`
  );

  // Without a width the field fills its parent; label left, arrow right, two cells of padding.
  const props = [
    ...posSize(ctx, node, parent, undefined, undefined, true),
    ...borderProps(node),
    'flexDirection="row"',
    'justifyContent="space-between"',
    'paddingLeft={2}',
    'paddingRight={2}',
  ];
  if (!node.style.border) props.push('border', 'borderStyle="single"');
  props.push(`ref={${fieldRef}}`);
  if (enabled) {
    props.push(`onMouseDown={(event: MouseAt) => { event.stopPropagation(); fieldClick(${id}); }}`);
  }
  const bits = attrBits(node, ctx);
  ctx.usesAttrs = true;
  el(w, 'box', props, () => {
    el(w, 'text', [
      ...(node.style.fg ? [sAttr('fg', node.style.fg)] : []),
      attrProp(bits, enabled ? node.ident : undefined),
      `content={${label}}`,
    ]);
    el(w, 'text', [
      ...(node.style.fg ? [sAttr('fg', node.style.fg)] : []),
      attrProp(bits, enabled ? node.ident : undefined),
      'content="▼"',
    ]);
  });
  const pw = new CodeWriter('  ', 0);
  pw.line(`{dd?.id === ${id} && (`);
  pw.indent();
  el(
    pw,
    'box',
    [
      'position="absolute"',
      'left={dd.x}',
      `top={dd.up ? dd.y - (${popup} + 2) : dd.y + 3}`,
      'width={dd.w}',
      `height={${popup} + 2}`,
      'zIndex={20}',
      'border',
      'borderStyle="single"',
      'backgroundColor="#000000"',
      `onMouseDown={(event: MouseAt) => { event.stopPropagation(); const i = rowAt(event); if (i >= 0 && i < ${count}) pick(${id}, i); }}`,
    ],
    () => {
      el(pw, 'select', [
        'ref={popRef}',
        'focused',
        `options={${options}}`,
        `selectedIndex={${current}}`,
        'showDescription={false}',
        'flexGrow={1}',
        `onSelect={(index: number) => pick(${id}, index)}`,
      ]);
    }
  );
  pw.dedent();
  pw.line(')}');
  ctx.popups.push(pw.toString());
}

/** Click on an item of a select/list/menu: focus the widget and choose the row under the mouse. */
function mouseSelect(ctx: Ctx, node: IRNode, tag: string, id: string): string {
  ctx.usesHit = true;
  const t = ctx.tagged.get(node.id);
  const fns = handlers(ctx, node);
  const total = node.type === 'Select' ? node.options.length : node.items.length;
  const len =
    t && node.type === 'Select'
      ? `${t.sv}.options.length`
      : t && node.type === 'List'
        ? `${t.sv}.items.length`
        : String(total);
  const head = `focusOn(${id}); if (ui.blocked${t ? ` || !ui.isActive(${tag})` : ''}) return; const i = rowAt(event); if (i < 0 || i >= ${len}) return; select(event, i);`;
  let body = '';
  if (node.type === 'Select') {
    if (t) {
      body = ` const value = ${t.sv}.options[i]; if (ui.store.get(${tag}).value === value) return; ui.store.patch(${tag}, { value }); ${emitCall(node, ctx, 'change', 'value', fns)}`;
    }
  } else {
    if (t) body = ` ui.store.patch(${tag}, { selected: i }); `;
    body += emitCall(node, ctx, 'select', 'i', fns);
  }
  return `onMouseDown={(event: MouseAt) => { ${head}${body} }}`;
}

/** Label of a tab: icon, label, status dot and hotkey (as Textual's Tabs shows it). */
function tabLabel(i: IRNode['items'][number]): string {
  return `${i.icon ? i.icon + ' ' : ''}${i.label || 'Tab'}${i.status ? ' ●' : ''}${i.hotkey ? ' ' + i.hotkey : ''}`;
}

/**
 * Tab bar: one row of ` label ` cells (the active one bold) and a rule below it with `╸━╺` under
 * the active tab, the width of the parent. Built from text because OpenTUI's tab-select has
 * equally wide tabs only.
 */
function tabs(ctx: Ctx, w: CodeWriter, node: IRNode, parent: IRNode | null): void {
  const t = ctx.tagged.get(node.id);
  const tag = t ? jsStr(t.handle.tag) : '';
  const labels = unique(ctx, recase(node.ident, 'camel') + 'Tabs');
  ctx.consts.push(`const ${labels} = [${node.items.map((i) => jsStr(tabLabel(i))).join(', ')}];`);
  const focusableNode = !node.disabled;
  if (focusableNode) focusable(ctx, node);
  const fns = handlers(ctx, node);
  const id = jsStr(node.ident);
  const count = node.items.length;
  ctx.usesTabs = true;
  ctx.usesAttrs = true;

  // Index of the active tab, and how to change it.
  let current: string;
  let setIndex: (expr: string) => string;
  if (t) {
    current = `${t.sv}.active_tab`;
    setIndex = (e) =>
      `if (${current} === ${e}) return; ui.store.patch(${tag}, { active_tab: ${e} }); ${emitCall(node, ctx, 'change', e, fns)}`;
  } else {
    const idx = unique(ctx, recase(node.ident, 'camel') + 'Index');
    const set = unique(ctx, 'set' + recase(idx, 'pascal'));
    ctx.hooks.push(
      `const [${idx}, ${set}] = useState(${Math.min(Math.max(node.selected, 0), Math.max(0, count - 1))});`
    );
    current = idx;
    setIndex = (e) =>
      `if (${idx} === ${e}) return; ${set}(${e}); ${emitCall(node, ctx, 'change', e, fns)}`;
  }
  if (focusableNode) {
    ctx.tabIds.push(node.ident);
    const guardLine = t ? `if (!ui.isActive(${tag})) return;\n  ` : '';
    ctx.tabMoves.push(
      `case ${id}: {\n  ${guardLine}const next = Math.max(0, Math.min(${count} - 1, ${current} + step));\n  ${setIndex('next')}\n  return;\n}`
    );
  }

  const bits = attrBits(node, ctx);
  const attr = (tabIsActive: string) =>
    `attributes={${[
      ...bits,
      `(${tabIsActive} ? TextAttributes.BOLD : 0)`,
      ...(focusableNode
        ? [`(${tabIsActive} && focusId === ${id} ? TextAttributes.INVERSE : 0)`]
        : []),
    ].join(' | ')}}`;
  const click = t
    ? `focusOn(${id}); if (ui.blocked || !ui.isActive(${tag})) return; ${setIndex('i')}`
    : `focusOn(${id}); if (ui.blocked) return; ${setIndex('i')}`;
  const props = [
    ...posSize(ctx, node, parent, node.style.border ? 4 : 2, undefined, true),
    ...borderProps(node),
    'flexDirection="column"',
  ];
  if (node.style.bg) props.push(sAttr('backgroundColor', node.style.bg));
  el(w, 'box', props, () => {
    el(w, 'box', ['flexDirection="row"', 'height={1}', 'flexShrink={0}'], () => {
      w.line(`{${labels}.map((label, i) => (`);
      w.line(
        `  <text key={i} ${[...colorProps(node, 'fg', 'bg'), attr(`i === ${current}`)].join(' ')} content={\` \${label} \`} onMouseDown={() => { ${click} }} />`
      );
      w.line('))}');
    });
    el(w, 'box', ['height={1}', 'width="100%"', 'overflow="hidden"', 'flexShrink={0}'], () => {
      el(w, 'text', [
        ...colorProps(node, 'fg', 'bg'),
        ...(node.disabled ? ['attributes={TextAttributes.DIM}'] : []),
        `content={tabsRule(${labels}, ${current})}`,
      ]);
    });
  });
}

function table(ctx: Ctx, w: CodeWriter, node: IRNode, parent: IRNode | null): void {
  const v = sv(ctx, node);
  const fg = node.style.fg ? [sAttr('fg', node.style.fg)] : [];
  const bits = attrBits(node, ctx);
  ctx.usesAttrs = true;
  const props = [
    ...posSize(ctx, node, parent),
    ...borderProps(node),
    'flexDirection="column"',
    'paddingLeft={1}',
    'paddingRight={1}',
  ];
  if (node.style.bg) props.push(sAttr('backgroundColor', node.style.bg));
  if (v) {
    ctx.usesTable = true;
    return el(w, 'box', props, () => {
      w.line(`{tableLines(${v}.columns, ${v}.rows).map((line, i) => (`);
      w.line(
        `  <text key={i} ${[...fg, attrProp([...bits, `(i === 0 && ${v}.columns.length ? TextAttributes.BOLD : 0)`])].join(' ')} content={line} />`
      );
      w.line('))}');
    });
  }
  const cols = Math.max(node.columns.length, ...node.rows.map((r) => r.length), 0);
  const cell = (r: string[], i: number) => r[i] ?? '';
  const widths = Array.from({ length: cols }, (_, i) =>
    Math.max([...cell(node.columns, i)].length, ...node.rows.map((r) => [...cell(r, i)].length), 1)
  );
  const line = (r: string[]) =>
    widths.map((n, i) => cell(r, i) + ' '.repeat(n - [...cell(r, i)].length)).join('  ');
  el(w, 'box', props, () => {
    if (node.columns.length) {
      el(w, 'text', [
        ...fg,
        attrProp([...bits, 'TextAttributes.BOLD']),
        `content={${jsStr(line(node.columns))}}`,
      ]);
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
