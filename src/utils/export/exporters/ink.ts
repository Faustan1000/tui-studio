// Ink (React for the terminal) exporter.
//
// Layout strategy: NATIVE. Ink lays out with Yoga flexbox, so every container maps its design to
// Box props:
//   - flex containers: flexDirection, flexWrap, gap, alignItems, justifyContent, padding per side
//   - Grid: a column of row boxes (rowGap/columnGap); every cell is an equal-width flex cell
//   - absolute containers: children get position="absolute" and marginLeft/marginTop. Ink has no
//     left/top props, but Yoga offsets an absolute child by its margin from the container's
//     inner edge, so the offset is the editor position minus the container's border
//   - Modal: an absolute bordered overlay at its editor position, open at start only if visible
//   - sizes: numbers -> width/height (flexShrink 0), 'fill' -> flexGrow or "100%" depending on the
//     parent's direction, 'auto' -> nothing
// The `rel` snapshot strategy is not used.
//
// Interactivity is real React state (useState) with focus handled by Ink's useFocus (Tab moves).
// Known limits: Ink 5 has no background colour for Box, so only Text backgrounds are exported;
// tab/menu bodies (`showWhen`) are static at their initial visibility.

import type { ExportAdapter, ExportFile } from '../adapter';
import {
  inlineText,
  itemText,
  progressText,
  recase,
  treeLines,
  visibleChildren,
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
  modalStates: string[];
  uses: {
    focus: boolean;
    field: boolean;
    dropdown: boolean;
    choices: boolean;
    spinner: boolean;
    textProps: boolean;
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
  if (typeof n.width === 'number' || typeof n.height === 'number') a.push('flexShrink={0}');
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
  let x = (n.rel?.x ?? n.layout.x) - (pb?.left ? 1 : 0);
  let y = (n.rel?.y ?? n.layout.y) - (pb?.top ? 1 : 0);
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

function emit(n: IRNode, w: CodeWriter, ctx: Ctx, root?: IRScreen): void {
  if (!n.visible) return;
  switch (n.type) {
    case 'Screen':
    case 'Box':
    case 'Grid':
    case 'Modal':
      return emitContainer(n, w, ctx, root);
    default:
      return emitLeaf(n, w, ctx);
  }
}

function emitContainer(n: IRNode, w: CodeWriter, ctx: Ctx, root?: IRScreen): void {
  const kids = visibleChildren(n);
  const isModal = n.type === 'Modal';
  const dir = parentDirection(n);
  const attrs: string[] = [...flexAttrs(n)];
  if (root) attrs.push(`width={${root.width}}`, `height={${root.height}}`);
  else attrs.push(...sizeAttrs(n, dir));
  attrs.push(...paddingAttrs(n), ...borderAttrs(n, isModal), ...absoluteAttrs(n));
  const finalAttrs = isModal
    ? [...attrs.filter((x) => !x.startsWith('flexDirection=')), 'flexDirection="column"']
    : attrs;

  const body = () => {
    if (isModal) w.line(`<Text bold${textAttrs(n).replace(' bold', '')}>{${jsStr(n.text)}}</Text>`);
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
    if (!isModal && !kids.length) w.line(tag('Box', finalAttrs, true));
    else w.wrap(tag('Box', finalAttrs), body, '</Box>');
  };
  if (isModal) {
    const state = ctx.names.take(`${recase(n.ident, 'camel')}Open`);
    const setter = ctx.names.take(`set${cap(state)}`);
    ctx.states.push(`const [${state}, ${setter}] = useState(true);`);
    ctx.modalStates.push(setter);
    w.line(`{${state} && (`).indent();
    open();
    w.dedent().line(')}');
  } else open();
}

function dedupeWrap(n: IRNode, w: CodeWriter, extra: string[], inner: () => void): void {
  const attrs = [
    ...sizeAttrs(n, parentDirection(n)),
    ...paddingAttrs(n),
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
  const ta = textAttrs(n);
  const to = textObj(n);
  const dim = n.disabled ? ' dimColor' : '';
  const staticText = () => w.line(`<Text${ta}${dim}>{${jsStr(inlineText(n))}}</Text>`);
  const focusable = ['Button', 'Checkbox', 'Radio', 'Toggle', 'TextInput', 'Select'];
  if (n.disabled && focusable.includes(n.type)) {
    return dedupeWrap(n, w, [], staticText);
  }
  const wrap = (inner: () => void, extra: string[] = []) => dedupeWrap(n, w, extra, inner);

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
      return wrap(() => w.line(`<Text${ta}${truncate}>{${jsStr(n.text)}}</Text>`), justify);
    }
    case 'Button': {
      ctx.uses.focus = true;
      const press = arrow('', calls(ctx, n));
      return wrap(() => {
        w.wrap(
          `<Focusable onPress={${press}}>`,
          () => {
            w.line('{(focused) => (').indent();
            w.line(
              `<Text bold${ta.replace(' bold', '')} inverse={focused}>{${jsStr(` ${inlineText(n)} `)}}</Text>`
            );
            w.dedent().line(')}');
          },
          '</Focusable>'
        );
      });
    }
    case 'Checkbox':
    case 'Radio':
    case 'Toggle': {
      ctx.uses.focus = true;
      let state: string;
      let isOn: string;
      let press: string;
      if (n.type === 'Radio') {
        const parent = n.parent;
        const key = parent ? parent.id : 'root';
        let group = ctx.radioGroups.get(key);
        if (!group) {
          group = stateName(ctx, n, 'Choice');
          const first = parent
            ? visibleChildren(parent).find((c) => c.type === 'Radio' && c.checked)
            : undefined;
          ctx.states.push(
            `const [${group.state}, ${group.setter}] = useState<string | null>(${first ? jsStr(recase(first.ident, 'camel')) : 'null'});`
          );
          ctx.radioGroups.set(key, group);
        }
        state = group.state;
        isOn = `${state} === ${jsStr(recase(n.ident, 'camel'))}`;
        press = arrow('', [
          `${group.setter}(${jsStr(recase(n.ident, 'camel'))});`,
          ...calls(ctx, n),
        ]);
      } else {
        const s = stateName(ctx, n);
        ctx.states.push(`const [${s.state}, ${s.setter}] = useState(${n.checked});`);
        state = s.state;
        isOn = state;
        press = arrow('', [`${s.setter}((v) => !v);`, ...calls(ctx, n)]);
      }
      const glyph =
        n.type === 'Toggle'
          ? `${isOn} ? "[ON ]" : "[OFF]"`
          : `${n.type === 'Radio' ? '"(" + ' : '"[" + '}(${isOn} ? ${jsStr(n.glyphs.on)} : ${jsStr(n.glyphs.off)}) + ${n.type === 'Radio' ? '")"' : '"]"'}`;
      const gcol =
        n.style.checkedColor || n.style.uncheckedColor
          ? ` color={${isOn} ? ${n.style.checkedColor ? jsStr(n.style.checkedColor) : 'undefined'} : ${n.style.uncheckedColor ? jsStr(n.style.uncheckedColor) : 'undefined'}}`
          : '';
      const lcol = n.style.labelColor ? ` color=${jsStr(n.style.labelColor)}` : '';
      return wrap(() => {
        w.wrap(
          `<Focusable onPress={${press}}>`,
          () => {
            w.line('{(focused) => (').indent();
            w.line(`<Text${ta} inverse={focused}>`).indent();
            w.line(`<Text${gcol}>{${glyph}}</Text>`);
            w.line(`<Text${lcol}>{${jsStr(' ' + n.text)}}</Text>`);
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
      const s = stateName(ctx, n);
      ctx.states.push(`const [${s.state}, ${s.setter}] = useState(${jsStr(n.value)});`);
      const change = arrow('v: string', [`${s.setter}(v);`, ...calls(ctx, n, /change/i)]);
      const submit = calls(ctx, n, undefined, /change/i);
      return wrap(() =>
        w.line(
          `<Field value={${s.state}} onChange={${change}}${submit.length ? ` onSubmit={${arrow('', submit)}}` : ''} placeholder={${jsStr(n.placeholder)}} />`
        )
      );
    }
    case 'Select': {
      ctx.uses.dropdown = true;
      ctx.uses.focus = true;
      if (to) ctx.uses.textProps = true;
      const s = stateName(ctx, n);
      ctx.states.push(
        `const [${s.state}, ${s.setter}] = useState(${jsStr(n.value || n.options[0] || '')});`
      );
      const opts = `[${n.options.map(jsStr).join(', ')}]`;
      const change = arrow('v: string', [`${s.setter}(v);`, ...calls(ctx, n)]);
      return wrap(() =>
        w.line(
          `<Dropdown options={${opts}} value={${s.state}} onChange={${change}}${to ? ` textProps={${to}}` : ''} />`
        )
      );
    }
    case 'List':
    case 'Menu':
    case 'Tabs':
    case 'Tree': {
      ctx.uses.choices = true;
      ctx.uses.focus = true;
      if (to) ctx.uses.textProps = true;
      const s = stateName(ctx, n, n.type === 'Tabs' ? 'Tab' : 'Selected');
      const lines =
        n.type === 'Tree'
          ? treeLines(n.items).map((l) => l.text)
          : n.type === 'Tabs'
            ? n.items.map((i) => itemText(i, false) + (i.status ? ' ●' : ''))
            : n.items.map((i) => itemText(i));
      const init = Math.max(0, Math.min(n.selected, Math.max(0, lines.length - 1)));
      ctx.states.push(`const [${s.state}, ${s.setter}] = useState(${init});`);
      const horizontal = n.type === 'Tabs' || (n.type === 'Menu' && n.layout.direction === 'row');
      const select =
        n.type === 'Tabs'
          ? arrow('i: number', [`${s.setter}(i);`, ...calls(ctx, n)])
          : `${s.setter}`;
      const activate =
        n.type === 'Tabs'
          ? ''
          : calls(ctx, n).length
            ? ` onActivate={${arrow('', calls(ctx, n))}}`
            : '';
      return wrap(() =>
        w.line(
          `<Choices lines={[${lines.map(jsStr).join(', ')}]} selected={${s.state}} onSelect={${select}}${activate}${horizontal ? ' horizontal' : ''}${n.type === 'Tabs' ? ' tabs' : ''}${to ? ` textProps={${to}}` : ''} />`
        )
      );
    }
    case 'Spinner': {
      ctx.uses.spinner = true;
      return wrap(() =>
        w.line(
          `<Text${ta}><Spinner type="dots" />{${jsStr(' ' + (n.text || 'Loading...'))}}</Text>`
        )
      );
    }
    case 'ProgressBar': {
      const width = typeof n.width === 'number' ? n.width : 20;
      const pct = Math.round(Math.max(0, Math.min(1, n.progress.value / n.progress.max)) * 100);
      return wrap(() =>
        w.line(`<Text${ta}>{${jsStr(`${progressText(n, width)} ${pct}%`)}}</Text>`)
      );
    }
    case 'Table': {
      const clean = (s: string) => s.replace(/\s+/g, ' ');
      const cols = n.columns.length ? n.columns.map(clean) : [];
      const rows = n.rows.map((r) => cols.map((_, i) => clean(r[i] ?? '')));
      const widths = cols.map((c, i) =>
        Math.max([...c].length, ...rows.map((r) => [...r[i]].length))
      );
      const fmt = (cells: string[]) =>
        cells.map((c, i) => c + ' '.repeat(widths[i] - [...c].length)).join(' │ ');
      return wrap(() => {
        w.wrap(
          '<Box flexDirection="column">',
          () => {
            w.line(`<Text${ta.replace(' bold', '')} bold>{${jsStr(fmt(cols))}}</Text>`);
            w.line(`<Text${ta}>{${jsStr(widths.map((x) => '─'.repeat(x)).join('─┼─'))}}</Text>`);
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

const FOCUSABLE = `// Something Tab can focus; Enter or Space presses it.
function Focusable({ onPress, children }: { onPress: () => void; children: (focused: boolean) => ReactNode }) {
  const { isFocused } = useFocus();
  useInput(
    (input, key) => {
      if (key.return || input === " ") onPress();
    },
    { isActive: isFocused },
  );
  return <>{children(isFocused)}</>;
}
`;

const FIELD = `// True while a text field has the focus, so that typing "q" does not quit the app.
let typing = false;

function Field({ value, onChange, onSubmit, placeholder }: { value: string; onChange: (value: string) => void; onSubmit?: () => void; placeholder: string }) {
  const { isFocused } = useFocus();
  useEffect(() => {
    typing = isFocused;
    return () => {
      typing = false;
    };
  }, [isFocused]);
  return <TextInput value={value} onChange={onChange} onSubmit={onSubmit} placeholder={placeholder} focus={isFocused} />;
}
`;

const DROPDOWN = `// Closed it shows the value; Enter opens the list (arrow keys, Enter to choose, Esc to close).
function Dropdown({ options, value, onChange, textProps }: { options: string[]; value: string; onChange: (value: string) => void; textProps?: TextProps }) {
  const { isFocused } = useFocus();
  const [open, setOpen] = useState(false);
  useInput(
    (_input, key) => {
      if (key.return) setOpen(true);
    },
    { isActive: isFocused && !open },
  );
  useInput(
    (_input, key) => {
      if (key.escape) setOpen(false);
    },
    { isActive: open },
  );
  if (open) {
    return (
      <SelectInput
        items={options.map((o) => ({ label: o, value: o }))}
        initialIndex={Math.max(0, options.indexOf(value))}
        onSelect={(item) => {
          onChange(item.value);
          setOpen(false);
        }}
      />
    );
  }
  return (
    <Text {...textProps} inverse={isFocused}>
      {value + " ▾"}
    </Text>
  );
}
`;

const CHOICES = `// A list, menu, tree or tab bar: arrow keys move the selection while it has the focus.
function Choices({ lines, selected, onSelect, onActivate, horizontal, tabs, textProps }: { lines: string[]; selected: number; onSelect: (index: number) => void; onActivate?: (index: number) => void; horizontal?: boolean; tabs?: boolean; textProps?: TextProps }) {
  const { isFocused } = useFocus();
  useInput(
    (_input, key) => {
      if (!lines.length) return;
      const prev = horizontal ? key.leftArrow : key.upArrow;
      const next = horizontal ? key.rightArrow : key.downArrow;
      if (prev) onSelect((selected + lines.length - 1) % lines.length);
      else if (next) onSelect((selected + 1) % lines.length);
      else if (key.return) onActivate?.(selected);
    },
    { isActive: isFocused },
  );
  return (
    <Box flexDirection={horizontal ? "row" : "column"} gap={horizontal ? 2 : 0}>
      {lines.map((line, i) => (
        <Text key={i} {...textProps} inverse={tabs ? i === selected : i === selected && isFocused} bold={i === selected || textProps?.bold}>
          {tabs ? " " + line + " " : (i === selected ? "› " : "  ") + line}
        </Text>
      ))}
    </Box>
  );
}
`;

// ── Project files ─────────────────────────────────────────────────────────────

function generateApp(screen: IRScreen): string {
  const ctx: Ctx = {
    names: new Names(),
    states: [],
    handlers: new Map(),
    radioGroups: new Map(),
    modalStates: [],
    uses: {
      focus: false,
      field: false,
      dropdown: false,
      choices: false,
      spinner: false,
      textProps: false,
    },
  };
  const jsx = new CodeWriter('  ', 1);
  emit(screen.root, jsx, ctx, screen);
  const u = ctx.uses;
  if (u.dropdown || u.choices) u.textProps = true;

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
  out.line();
  out.line(
    `import { ${['useState', u.field ? 'useEffect' : ''].filter(Boolean).join(', ')} } from "react";`
  );
  if (u.focus) out.line('import type { ReactNode } from "react";');
  out.line(
    `import { Box, Text, render, useApp, useInput${u.focus ? ', useFocus' : ''} } from "ink";`
  );
  if (u.textProps) out.line('import type { TextProps } from "ink";');
  if (u.field) out.line('import TextInput from "ink-text-input";');
  if (u.dropdown) out.line('import SelectInput from "ink-select-input";');
  if (u.spinner) out.line('import Spinner from "ink-spinner";');
  out.line();
  if (ctx.handlers.size) {
    for (const fn of ctx.handlers.values()) out.line(`function ${fn}() { /* TODO */ }`);
    out.line();
  }
  if (u.focus) out.block(FOCUSABLE).line();
  if (u.field) out.block(FIELD).line();
  if (u.dropdown) out.block(DROPDOWN).line();
  if (u.choices) out.block(CHOICES).line();
  out.line('function App() {').indent();
  out.line('const { exit } = useApp();');
  for (const s of ctx.states) out.line(s);
  out.line('useInput((input, key) => {').indent();
  out.line(`if (input === "q"${u.field ? ' && !typing' : ''}) exit();`);
  if (ctx.modalStates.length) {
    out.line('if (key.escape) {').indent();
    for (const s of ctx.modalStates) out.line(`${s}(false);`);
    out.dedent().line('}');
  } else out.line('void key;');
  out.dedent().line('});');
  out.line('return (');
  out.block(jsx.toString().trimEnd());
  out.line(');');
  out.dedent().line('}');
  out.line();
  out.line('render(<App />);');
  return out.toString();
}

function packageJson(screen: IRScreen, app: string): string {
  const slug = screen.ident.replace(/_/g, '-').replace(/^[^a-z0-9]+/, '') || 'app';
  const deps: Record<string, string> = { ink: '5.2.1', react: '18.3.1' };
  if (app.includes('"ink-text-input"')) deps['ink-text-input'] = '6.0.0';
  if (app.includes('"ink-select-input"')) deps['ink-select-input'] = '6.0.0';
  if (app.includes('"ink-spinner"')) deps['ink-spinner'] = '5.0.0';
  return (
    JSON.stringify(
      {
        name: `tui-${slug}`,
        version: '0.1.0',
        private: true,
        type: 'module',
        scripts: { start: 'tsx src/app.tsx' },
        dependencies: deps,
        devDependencies: {
          '@types/node': '22.10.2',
          '@types/react': '18.3.12',
          tsx: '4.19.2',
          typescript: '5.7.2',
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
      },
      include: ['src'],
    },
    null,
    2
  ) + '\n';

export const inkAdapter: ExportAdapter = {
  id: 'ink',
  label: 'Ink (React)',
  language: 'tsx',
  verification: 'syntax',
  multiScreen: false,
  generate: ({ ir }): ExportFile[] => {
    const app = generateApp(ir.start);
    return [
      { path: 'src/app.tsx', content: app },
      { path: 'package.json', content: packageJson(ir.start, app) },
      { path: 'tsconfig.json', content: TSCONFIG },
    ];
  },
};
