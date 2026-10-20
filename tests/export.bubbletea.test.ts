// Bubble Tea exporter. There is no Go toolchain in the test environment, so besides concrete
// assertions on the output the generated Go is checked lexically: balanced brackets, every
// import used, every declared variable used, no duplicate declarations.

import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '../src/types';
import { exportToFiles } from '../src/utils/export/codeExporter';
import {
  bubbleteaAdapter,
  BUBBLETEA_VERSIONS,
  cellWidth,
  handlerName,
} from '../src/utils/export/exporters/bubbletea';
import { mk, resetIds, screen } from './fixtures/build';
import { allComponents, layouts, multiScreen } from './fixtures/designs';
import { nastyDesign } from './fixtures/nasty';

// ── Go lexical helpers ────────────────────────────────────────────────────────

/** Source with comments removed and the inside of string/rune literals blanked. */
function stripGo(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
    } else if (c === '"' || c === "'" || c === '`') {
      out += c;
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\' && c !== '`') i++;
        if (src[i] === '\n' && c !== '`') throw new Error('line break inside a string literal');
        i++;
      }
      out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function assertBalanced(stripped: string): void {
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const stack: string[] = [];
  for (const ch of stripped) {
    if ('([{'.includes(ch)) stack.push(ch);
    else if (ch in pairs) expect(stack.pop(), `unbalanced ${ch}`).toBe(pairs[ch]);
  }
  expect(stack, 'unclosed brackets').toEqual([]);
}

/** Import block: alias (explicit or last path segment) -> path. */
function importsOf(src: string): Map<string, string> {
  const block = /import \(([\s\S]*?)\n\)/.exec(src);
  expect(block, 'import block').not.toBeNull();
  const out = new Map<string, string>();
  for (const line of block![1].split('\n')) {
    const m = /^\s*(?:(\w+)\s+)?"([^"]+)"\s*$/.exec(line);
    if (!m) continue;
    out.set(m[1] ?? m[2].split('/').pop()!, m[2]);
  }
  return out;
}

function functionsOf(stripped: string): { head: string; body: string }[] {
  const out: { head: string; body: string }[] = [];
  const re = /^func [^\n]*\{\n([\s\S]*?)\n\}$/gm;
  for (let m = re.exec(stripped); m; m = re.exec(stripped))
    out.push({ head: m[0].split('\n')[0], body: m[0] });
  return out;
}

const count = (text: string, name: string) =>
  text.match(new RegExp(`(?<![\\w.])${name}(?!\\w)`, 'g'))?.length ?? 0;

/** Structural checks that stand in for `go build`. */
function checkGo(src: string): void {
  const stripped = stripGo(src);
  assertBalanced(stripped);
  expect(stripped).toMatch(/^package main$/m);

  // Every import is referenced; nothing is imported twice.
  const imports = importsOf(src);
  const importCount = (src.match(/^\s+(?:\w+ )?"[^"]+"$/gm) ?? []).length;
  expect(imports.size).toBe(importCount);
  const body = stripped.replace(/import \([\s\S]*?\n\)/, '');
  for (const alias of imports.keys())
    expect(body, `import ${alias} unused`).toMatch(new RegExp(`\\b${alias}\\.`));
  // ... and every package that is used is imported.
  for (const pkg of [
    'textinput',
    'spinner',
    'progress',
    'table',
    'strings',
    'fmt',
    'os',
    'lipgloss',
  ]) {
    if (new RegExp(`(?<![\\w.])${pkg}\\.[A-Z]`).test(body))
      expect(imports.has(pkg), `${pkg} not imported`).toBe(true);
  }

  // Every local that is declared is used again; no duplicate package-level functions.
  const seen = new Set<string>();
  for (const fn of functionsOf(stripped)) {
    const sig = /^func (?:\(\w+ \*?(\w+)\) )?(\w+)/.exec(fn.head)!;
    const key = `${sig[1] ?? ''}.${sig[2]}`;
    expect(seen.has(key), `duplicate ${key}`).toBe(false);
    seen.add(key);
    const afterHead = fn.body.slice(fn.head.length);
    const declared = new Set<string>();
    for (const m of afterHead.matchAll(/([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*:=/g)) {
      m[1].split(',').forEach((n) => declared.add(n.trim()));
    }
    for (const m of afterHead.matchAll(/\bvar (\w+) /g)) declared.add(m[1]);
    for (const name of declared) {
      if (name === '_') continue;
      expect(
        count(afterHead, name),
        `${name} declared and not used in: ${fn.head}`
      ).toBeGreaterThanOrEqual(2);
    }
  }

  // Struct fields and consts are unique.
  const struct = /type model struct \{\n([\s\S]*?)\n\}/.exec(stripped);
  expect(struct).not.toBeNull();
  const fields = [...struct![1].matchAll(/^\s*([a-zA-Z_]\w*(?:, \w+)*) [\w.[\]*]+/gm)].flatMap(
    (m) => m[1].split(', ')
  );
  expect(new Set(fields).size, `duplicate fields in ${fields.join(',')}`).toBe(fields.length);
  const methods = [...stripped.matchAll(/^func \(m \*model\) (\w+)/gm)].map((m) => m[1]);
  expect(new Set(methods).size, 'duplicate methods').toBe(methods.length);
  for (const mth of methods)
    expect(fields, `method ${mth} collides with a field`).not.toContain(mth);
  // Every method that is called on the model exists.
  const called = new Set([...stripped.matchAll(/\bm\.(\w+)\(/g)].map((m) => m[1]));
  for (const name of called) {
    if (fields.includes(name)) continue; // m.field.Method() is matched as m.field(
    expect(methods, `m.${name}() is not defined`).toContain(name);
  }
}

function goModOf(files: { path: string; content: string }[]) {
  const mod = files.find((f) => f.path === 'go.mod')!.content;
  const module = /^module (\S+)$/m.exec(mod);
  const go = /^go (\d+\.\d+(?:\.\d+)?)$/m.exec(mod);
  const requires = [...mod.matchAll(/^\t(\S+) (v\d+\.\d+\.\d+)$/gm)].map((m) => [m[1], m[2]]);
  return {
    module: module?.[1],
    go: go?.[1],
    requires: Object.fromEntries(requires) as Record<string, string>,
  };
}

const run = (root: ComponentNode, screens?: { id: string; root: ComponentNode }[]) =>
  exportToFiles(root, 'bubbletea', screens);
const mainGo = (root: ComponentNode) => run(root).find((f) => f.path === 'main.go')!.content;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('bubbletea adapter', () => {
  it('declares itself', () => {
    expect(bubbleteaAdapter).toMatchObject({
      id: 'bubbletea',
      label: 'Bubble Tea (Go)',
      language: 'go',
      multiScreen: false,
      verification: 'snapshot',
    });
  });

  it('writes main.go and a go.mod with pinned versions', () => {
    const files = run(allComponents());
    expect(files.map((f) => f.path)).toEqual(['main.go', 'go.mod']);
    const mod = goModOf(files);
    expect(mod.module).toBe('tuistudio/main');
    expect(mod.go).toBe(BUBBLETEA_VERSIONS.go);
    expect(mod.requires).toEqual({
      'github.com/charmbracelet/bubbles': BUBBLETEA_VERSIONS.bubbles,
      'github.com/charmbracelet/bubbletea': BUBBLETEA_VERSIONS.bubbletea,
      'github.com/charmbracelet/lipgloss': BUBBLETEA_VERSIONS.lipgloss,
    });
    const src = files[0].content;
    expect(src).toContain('go mod tidy');
    expect(src).toContain('go run .');
    expect(src).toMatch(/Layout strategy per container kind/);
    expect(src).toMatch(/snapshot/);
  });

  it('is structurally valid Go for every fixture', () => {
    const designs: Record<string, ComponentNode> = {
      all: allComponents(),
      nasty: nastyDesign(),
      home: multiScreen()[0],
      empty: screen('Empty', undefined, []),
      ...layouts(),
    };
    resetIds();
    let deep = mk('Text', { props: { content: 'bottom' } });
    for (let i = 0; i < 25; i++) deep = mk('Box', {}, [deep]);
    designs.deep = screen('Deep', undefined, [deep]);
    for (const [name, root] of Object.entries(designs)) {
      expect(() => checkGo(mainGo(root)), name).not.toThrow();
    }
  });

  it('the lexical checker catches what it is for', () => {
    const base = mainGo(allComponents());
    expect(() => checkGo(base)).not.toThrow();
    expect(() => checkGo(base.replace('"strings"\n', ''))).toThrow();
    expect(() => checkGo(base + '\n}')).toThrow();
    expect(() => checkGo(base.replace('"os"\n', '"os"\n\t"time"\n'))).toThrow();
    expect(() =>
      checkGo(
        base.replace(
          'return m, nil\n}\n\nfunc (m *model) updateKey',
          'x := 1\n}\n\nfunc (m *model) updateKey'
        )
      )
    ).toThrow();
    expect(() => checkGo(base.replace('m.handleChange()', 'm.handleMissing()'))).toThrow();
  });

  describe('components', () => {
    const src = mainGo(allComponents());

    it('has a model with a field per component, named from the code names', () => {
      for (const field of [
        'nameInput textinput.Model',
        'agree bool',
        'optA bool',
        'optB bool',
        'color int',
        'colorOpts []string',
        'dark bool',
        'progress progress.Model',
        'busy spinner.Model',
        'results table.Model',
        'files int',
        'navTree int',
        'navTreeOpen []bool',
        'mainMenu int',
        'pages int',
        'confirm bool',
      ]) {
        expect(src, field).toMatch(new RegExp(`^\\s+${field.replace(/[[\]]/g, '\\$&')}\\b`, 'm'));
      }
    });

    it('implements the Bubble Tea interface', () => {
      expect(src).toContain('func (m *model) Init() tea.Cmd {');
      expect(src).toContain('func (m *model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {');
      expect(src).toContain('func (m *model) View() string {');
      expect(src).toContain('case tea.WindowSizeMsg:');
      expect(src).toContain('case tea.KeyMsg:');
      expect(src).toContain('case spinner.TickMsg:');
      expect(src).toContain('tea.NewProgram(newModel(), tea.WithAltScreen())');
      expect(src).toContain('return tea.Batch(m.applyFocus(), textinput.Blink, m.busy.Tick)');
    });

    it('cycles the focus ring in tree order and quits on q / ctrl+c', () => {
      const ring = [...src.matchAll(/^\t(focus\w+)( = iota)?$/gm)].map((m) => m[1]);
      expect(ring).toEqual([
        'focusNameInput',
        'focusSubmitBtn',
        'focusAgree',
        'focusOptA',
        'focusOptB',
        'focusColor',
        'focusDark',
        'focusResults',
        'focusFiles',
        'focusNavTree',
        'focusMainMenu',
        'focusPages',
        'focusOkBtn',
        'focusCount',
      ]);
      expect(src).toContain('case "tab":\n\t\treturn m, m.moveFocus(1)');
      expect(src).toContain('case "shift+tab":\n\t\treturn m, m.moveFocus(-1)');
      expect(src).toContain('case "ctrl+c":\n\t\treturn m, tea.Quit');
      expect(src).toContain('case "q":\n\t\tif !m.typing() {');
      expect(src).toMatch(
        /func \(m \*model\) typing\(\) bool \{\n\tswitch m\.focus \{\n\tcase focusNameInput:\n\t\treturn true/
      );
    });

    it('TextInput uses bubbles/textinput', () => {
      expect(src).toContain('m.nameInput = textinput.New()');
      expect(src).toContain('m.nameInput.Placeholder = "Enter text..."');
      expect(src).toContain('m.nameInput, cmd = m.nameInput.Update(msg)');
      expect(src).toContain('return m.nameInput.Focus()');
      expect(src).toContain('m.nameInput.Blur()');
      expect(src).toContain('m.nameInput.View()');
    });

    it('Button, Checkbox, Radio, Toggle, Select', () => {
      expect(src).toContain('frame("Send", 6, 1, lipgloss.Center, lipgloss.Center)');
      expect(src).toContain('lipgloss.RoundedBorder()');
      expect(src).toContain('m.agree = !m.agree');
      expect(src).toContain('label := "[" + mark + "]" + " Option"');
      // Radios of a group deselect each other.
      expect(src).toMatch(/case focusOptA:[\s\S]*?m\.optB = false\n\t\t\tm\.optA = true/);
      expect(src).toMatch(/case focusOptB:[\s\S]*?m\.optA = false\n\t\t\tm\.optB = true/);
      expect(src).toContain('m.dark = !m.dark');
      expect(src).toContain('mark = "[ON ]"');
      expect(src).toContain('m.colorOpts = []string{"Option 1", "Option 2", "Option 3"}');
      expect(src).toContain('m.color = (m.color + 1) % n');
      expect(src).toContain('current + " ▾"');
    });

    it('Text, Spinner, ProgressBar, Breadcrumb', () => {
      expect(src).toContain('frame("Ready", 5, 1, lipgloss.Left, lipgloss.Top)');
      expect(src).toContain('m.busy.Spinner = spinner.MiniDot');
      expect(src).toContain('m.busy.View() + " " + "Loading..."');
      expect(src).toContain(
        'm.progress = progress.New(progress.WithSolidFill("#f8f8f2"), progress.WithWidth(18))'
      );
      expect(src).toContain('m.progress.ViewAs(m.progressValue)');
      expect(src).toContain('"Home / Documents / File"');
    });

    it('Table uses bubbles/table with rows padded to the column count', () => {
      expect(src).toContain('{Title: "Column 1", Width: 8},');
      expect(src).toContain('{"Cell 1", "Cell 2"},');
      expect(src).toContain('table.WithStyles(tableStyles("#f8f8f2")),');
      expect(src).toContain('m.results, cmd = m.results.Update(msg)');
      expect(src).toContain('func tableStyles(fg string) table.Styles {');

      resetIds();
      const ragged = screen('R', undefined, [
        mk('Table', { props: { columns: ['A', 'B'], rows: [['1'], ['1', '2', '3']] } }),
      ]);
      const out = mainGo(ragged);
      expect(out).toContain('{"1", ""},');
      expect(out).toContain('{"1", "2"},');
      expect(out).not.toContain('"3"');
    });

    it('List, Menu, Tree and Tabs keep a cursor / index', () => {
      expect(src).toContain('m.files = moveCursor(m.files, 1, 3)');
      expect(src).toContain('m.mainMenu = moveCursor(m.mainMenu, -1, 3)');
      expect(src).toContain('"• Item 1  1"');
      expect(src).toContain('m.navTree = treeKey(m.navTreeNodes(), m.navTreeOpen, m.navTree, key)');
      expect(src).toContain('{label: "📁 Root", depth: 0, parent: -1, kids: true},');
      expect(src).toContain('m.navTreeOpen = []bool{true, true, false, true, false}');
      expect(src).toContain('case "left", "h":\n\t\t\tif m.pages > 0 {\n\t\t\t\tm.pages--');
      expect(src).toContain('if m.pages < 2 {');
      expect(src).toContain('tabsView([]string{"⌂ Dashboard", "● Agent", "QA Team"}');
    });

    it('Grid, Box, Spacer, Modal', () => {
      expect(src).toContain('c := newCanvas(1, 3)'); // grid: snapshot
      expect(src).toMatch(
        /func \(m \*model\) renderPanel\(\) string \{\n\tcontent := lipgloss\.JoinVertical/
      );
      expect(src).toContain('m.renderSpacer()');
      expect(src).toContain('lipgloss.DoubleBorder()');
      expect(src).toContain(
        'out = overlay(out, 2, 0, lipgloss.NewStyle().Bold(true).MaxWidth(36).Render(" Sure? "))'
      );
      expect(src).toMatch(
        /if m\.confirm \{\n\t\tout = overlay\(out, \d+, \d+, m\.renderConfirm\(\)\)/
      );
      expect(src).toContain('m.confirm = false'); // esc closes it
    });

    it('wires the event handlers as deduplicated stubs', () => {
      for (const name of ['handleChange', 'handleClick', 'handleSelect']) {
        expect(
          src.match(new RegExp(`^func \\(m \\*model\\) ${name}\\(\\) \\{$`, 'gm')),
          name
        ).toHaveLength(1);
      }
      expect(src).toMatch(/func \(m \*model\) handleClick\(\) \{\n\t\/\/ TODO: implement\n\}/);
      // called where the event happens
      expect(src).toMatch(
        /case focusSubmitBtn:\n\t\tif key == "enter" \|\| key == " " \{\n\t\t\tm\.handleClick\(\)/
      );
      expect(src).toMatch(
        /case focusAgree:[\s\S]*?m\.agree = !m\.agree\n\t\t\tm\.handleChange\(\)/
      );
      expect(src).toMatch(/case focusFiles:[\s\S]*?case "enter", " ":\n\t\t\tm\.handleSelect\(\)/);
    });

    it('uses the colours and border flags of the design', () => {
      expect(src).toContain('lipgloss.Color("#f8f8f2")');
      expect(src).toContain(
        '.BorderTop(true).BorderRight(true).BorderBottom(true).BorderLeft(true)'
      );
      resetIds();
      const styled = screen('S', undefined, [
        mk('Box', {
          props: { width: 20, height: 5 },
          style: {
            color: '#ff0000',
            backgroundColor: '#00ff00',
            bold: true,
            italic: true,
            underline: true,
            strikethrough: true,
            border: true,
            borderStyle: 'double',
            borderColor: '#0000ff',
            borderTop: false,
            borderLeft: false,
          },
        }),
      ]);
      const out = mainGo(styled);
      expect(out).toContain(
        'lipgloss.NewStyle().Foreground(lipgloss.Color("#ff0000")).Background(lipgloss.Color("#00ff00")).Bold(true).Italic(true).Underline(true).Strikethrough(true).BorderStyle(lipgloss.DoubleBorder()).BorderForeground(lipgloss.Color("#0000ff")).BorderTop(false).BorderRight(true).BorderBottom(true).BorderLeft(false)'
      );
      // thick and rounded borders
      for (const [style, fn] of [
        ['bold', 'ThickBorder'],
        ['rounded', 'RoundedBorder'],
        ['single', 'NormalBorder'],
      ]) {
        resetIds();
        const o = mainGo(
          screen('S', undefined, [mk('Box', { style: { border: true, borderStyle: style } })])
        );
        expect(o, style).toContain(`lipgloss.${fn}()`);
      }
    });

    it('only exports visible components', () => {
      resetIds();
      const out = mainGo(
        screen('S', undefined, [
          mk('TextInput', { tag: 'shown' }),
          mk('TextInput', { tag: 'gone', hidden: true }),
        ])
      );
      expect(out).toContain('shown textinput.Model');
      expect(out).not.toContain('gone');
    });

    it('leaves disabled components out of the focus ring', () => {
      resetIds();
      const out = mainGo(
        screen('S', undefined, [
          mk('Button', { tag: 'a', props: { label: 'A' } }),
          mk('Button', { tag: 'b', props: { label: 'B', disabled: true } }),
        ])
      );
      expect(out).toContain('focusA = iota');
      expect(out).not.toContain('focusB');
      expect(out).toContain('.Faint(true)');
    });
  });

  describe('layout', () => {
    const l = layouts();
    const out = (name: string) => mainGo(l[name]);

    it('flex row and column are native: joins with margins from the editor layout', () => {
      const row = out('row');
      expect(row).toContain('lipgloss.JoinHorizontal(lipgloss.Top,');
      expect(row).toContain('shift(m.renderText(), 0, 0),');
      expect(row).toContain('shift(m.renderText2(), 2, 0),'); // gap 2
      expect(row).toContain('shift(m.renderText3(), 2, 0),');
      expect(row).not.toContain('newCanvas(38');
      const col = out('column');
      expect(col).toMatch(
        /renderBox\(\) string \{\n\tcontent := lipgloss\.JoinVertical\(lipgloss\.Left,/
      );
      expect(col).toContain('shift(m.renderText2(), 0, 1),'); // gap 1
    });

    it('justify and align become offsets', () => {
      const center = out('center');
      const offsets = [...center.matchAll(/shift\(m\.renderText2?\(\), (\d+), (\d+)\)/g)].map(
        (m) => [+m[1], +m[2]]
      );
      expect(offsets.length).toBe(2);
      expect(offsets[0][0] + offsets[0][1]).toBeGreaterThan(0);
      const between = [
        ...out('spaceBetween').matchAll(/shift\(m\.renderText\d?\(\), (\d+), 0\)/g),
      ].map((m) => +m[1]);
      expect(between.length).toBe(3);
      expect(between[1]).toBeGreaterThan(0);
      expect(between[1]).toBe(between[2]); // 3 items of 6 cells in 38: equal gaps
    });

    it('wrap, grid and absolute are snapshots on a cell canvas', () => {
      for (const name of ['wrapped', 'grid', 'absolute']) {
        const o = out(name);
        expect(o, name).toContain('c := newCanvas(38, 6)');
        expect(o, name).toMatch(/c\.put\(\d+, \d+, m\.renderText\(\)\)/);
        expect(o, name).toContain('content := c.String()');
        expect(o, name).not.toMatch(/JoinHorizontal\(lipgloss\.Top,\n\t\tshift/);
      }
      const abs = [...out('absolute').matchAll(/c\.put\((\d+), (\d+), m\.renderText2?\(\)\)/g)].map(
        (m) => [+m[1], +m[2]]
      );
      expect(abs[1][0] - abs[0][0]).toBe(10);
      expect(abs[1][1] - abs[0][1]).toBe(1);
      // wrapped: eight 8-wide items in 38 cells -> several rows
      const ys = new Set([...out('wrapped').matchAll(/c\.put\(\d+, (\d+),/g)].map((m) => m[1]));
      expect(ys.size).toBeGreaterThan(1);
      // The canvas helper and overlay are part of the file.
      expect(out('grid')).toContain('func overlay(base string, x, y int, block string) string {');
    });

    it('states the strategy per container kind in the header', () => {
      const head = out('row').split('package main')[0];
      expect(head).toMatch(/flex containers: native/);
      expect(head).toMatch(/wrap, grid, absolute.*snapshot/s);
      expect(head).toMatch(/modals: overlaid/);
    });
  });

  describe('text', () => {
    it('escapes every user string', () => {
      const src = mainGo(nastyDesign());
      expect(src).toContain('"He said \\"hi\\""');
      expect(src).toContain('"back\\\\slash"');
      expect(src).toContain('"new line"'); // placeholders and cells are single-line
      expect(src).toContain('"{braces} and {{double}}"');
      expect(src).toContain('${dollar} `tick`');
      expect(src).toContain('%s %d {} {0}');
      expect(src).toContain('"/* comment */ // line"');
      expect(src).toContain('ünïcödé ✓ 日本語 🔥');
      // No raw line break ever ends up inside a string literal (stripGo throws on those).
      expect(() => stripGo(src)).not.toThrow();
    });

    it('wide characters count two cells, combining marks none', () => {
      expect(cellWidth('abc')).toBe(3);
      expect(cellWidth('日本')).toBe(4);
      expect(cellWidth('é')).toBe(1);
    });

    it('turns handler names into Go identifiers', () => {
      expect(handlerName('handleClick')).toBe('handleClick');
      expect(handlerName('on-save now')).toBe('onSaveNow');
      expect(handlerName('Submit')).toBe('submit');
      expect(handlerName('9lives')).toBe('handle9lives');
      expect(handlerName('')).toBe('handler');
    });

    it('avoids Go keywords and name clashes', () => {
      resetIds();
      const src = mainGo(
        screen('S', undefined, [
          mk('Checkbox', { tag: 'type' }),
          mk('Checkbox', { tag: 'focus' }),
          mk('Checkbox', { tag: 'x_1' }),
          mk('Checkbox', { tag: 'x1' }),
          mk('Button', { tag: 'b', events: { onClick: 'type', onFocus: 'View' } }),
        ])
      );
      expect(() => checkGo(src)).not.toThrow();
      expect(src).not.toMatch(/^\s+type bool$/m);
      expect(src).toMatch(/^\ttype_ bool$/m);
      expect(src).toMatch(/^\tfocus2 bool$/m);
      expect(src).toContain('func (m *model) type2() {');
      expect(src).toContain('func (m *model) view() {');
    });
  });

  it('exports only the first screen (single-screen adapter)', () => {
    const screens = multiScreen().map((root) => ({ id: root.id, root }));
    const out = run(screens[0].root, screens)[0].content;
    expect(out).toContain('"Ready"');
    expect(out).not.toContain('Settings screen');
    expect(out).not.toContain('Agent content');
    expect(out).toContain('// This button opens another screen');
  });
});
