// Bubble Tea exporter: concrete assertions on the output plus a lexical Go checker (balanced
// brackets, every import used, every local used, no duplicate declarations). The real compiler
// runs in tests/api.bubbletea.test.ts (go vet / go build / go test) when Go is installed.

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

/** Structural checks that stand in for `go build` on one generated file. */
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
    'errors',
    'time',
  ]) {
    if (new RegExp(`(?<![\\w.])${pkg}\\.[A-Z]`).test(body))
      expect(imports.has(pkg), `${pkg} not imported`).toBe(true);
  }

  // Every local that is declared is used again; no duplicate functions or methods.
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

  // The model: unique fields, methods that do not collide with fields, every called method exists.
  const struct = /type model struct \{\n([\s\S]*?)\n\}/.exec(stripped);
  if (!struct) return;
  const fields = [...struct[1].matchAll(/^\s*([a-zA-Z_]\w*(?:, \w+)*)\s+[\w.[\]*]+/gm)].flatMap(
    (m) => m[1].split(', ')
  );
  expect(new Set(fields).size, `duplicate fields in ${fields.join(',')}`).toBe(fields.length);
  const methods = [...stripped.matchAll(/^func \(m \*model\) (\w+)/gm)].map((m) => m[1]);
  expect(new Set(methods).size, 'duplicate methods').toBe(methods.length);
  for (const mth of methods)
    expect(fields, `method ${mth} collides with a field`).not.toContain(mth);
  const called = new Set([...stripped.matchAll(/\bm\.(\w+)[(),]/g)].map((m) => m[1]));
  for (const name of called) {
    if (fields.includes(name)) continue;
    expect(methods, `m.${name} is not defined`).toContain(name);
  }
}

const run = (root: ComponentNode, screens?: { id: string; root: ComponentNode }[]) =>
  exportToFiles(root, 'bubbletea', screens);
const file = (root: ComponentNode, path: string) => run(root).find((f) => f.path === path)!.content;
const mainGo = (root: ComponentNode) => file(root, 'main.go');
const uiGo = (root: ComponentNode) => file(root, 'ui.go');
const checkAll = (root: ComponentNode) => {
  for (const f of run(root)) if (f.path.endsWith('.go')) checkGo(f.content);
};

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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('bubbletea adapter', () => {
  it('declares itself', () => {
    expect(bubbleteaAdapter).toMatchObject({
      id: 'bubbletea',
      label: 'Bubble Tea (Go)',
      language: 'go',
      multiScreen: false,
      verification: 'run',
    });
  });

  it('writes main.go, ui.go, ui_runtime.go and a go.mod with pinned versions', () => {
    const files = run(allComponents());
    expect(files.map((f) => f.path)).toEqual(['main.go', 'ui.go', 'ui_runtime.go', 'go.mod']);
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
    expect(src).toContain('// your program goes here');
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
      expect(() => checkAll(root), name).not.toThrow();
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
    expect(() =>
      checkGo(base.replace('m.pull()\n\treturn m', 'm.missing()\n\treturn m'))
    ).toThrow();
  });

  describe('components', () => {
    const src = mainGo(allComponents());
    const ui = uiGo(allComponents());

    it('keeps bubbles widgets and cursors in the model, everything else in the store', () => {
      for (const field of [
        'ui *Ui',
        'nameInput textinput.Model',
        'progress progress.Model',
        'busy spinner.Model',
        'results table.Model',
        'resultsVer uint64',
        'navTree int',
        'navTreeOpen []bool',
      ]) {
        expect(src, field).toMatch(
          new RegExp(`^\\s+${field.replace(/[[\]*]/g, '\\$&').replace(/ /g, '\\s+')}\\b`, 'm')
        );
      }
      expect(src).not.toMatch(/^\s+agree bool/m); // checkboxes live in the store
    });

    it('implements the Bubble Tea interface', () => {
      expect(src).toContain('func (m *model) Init() tea.Cmd {');
      expect(src).toContain('func (m *model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {');
      expect(src).toContain('func (m *model) View() string {');
      expect(src).toContain('case tea.WindowSizeMsg:');
      expect(src).toContain('case tea.KeyMsg:');
      expect(src).toContain('case refreshMsg:');
      expect(src).toContain('case frameMsg:');
      expect(src).toContain('case spinner.TickMsg:');
      expect(src).toContain('return tea.Batch(m.initialFocus(), textinput.Blink, m.busy.Tick)');
      expect(src).toContain('m.ui.SetReady()');
      expect(ui).toContain('tea.NewProgram(newModel(u), u.opts...)');
      expect(ui).toContain('tea.WithAltScreen()');
    });

    it('cycles the focus ring in tree order, skips unusable components, quits on q / ctrl+c', () => {
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
      expect(src).toContain('if m.focusable(i) {');
      // modals: the button inside is only usable while the modal is open
      expect(src).toContain('return m.ui.Usable("ok_btn", "confirm")');
      expect(src).toContain('return m.ui.Usable("name_input")');
    });

    it('TextInput uses bubbles/textinput and writes the typed value to the store', () => {
      expect(src).toContain('m.nameInput = textinput.New()');
      expect(src).toContain('m.nameInput, cmd = m.nameInput.Update(msg)');
      expect(src).toContain('c.UserSet("value", after)');
      expect(src).toContain('c.Emit("change", after)');
      expect(src).toContain('c.Emit("submit", m.nameInput.Value())');
      expect(src).toContain('return m.nameInput.Focus()');
      expect(src).toContain('m.nameInput.Blur()');
      expect(src).toContain('m.nameInput.SetValue(v)'); // program writes reach the widget
      expect(ui).toContain('"placeholder": "Enter text...",');
    });

    it('Button, Checkbox, Radio, Toggle, Select send events from the store', () => {
      expect(src).toContain('c.Emit("click", nil)');
      expect(src).toContain('lipgloss.RoundedBorder()');
      expect(src).toContain('v := !c.Bool("checked")');
      expect(src).toContain('c.Emit("change", v)');
      expect(src).toContain('+ line(c.Str("label"))');
      // Radios of a group deselect each other.
      expect(src).toMatch(/case focusOptA:[\s\S]*?m\.c\("opt_b"\)\.UserSet\("checked", false\)/);
      expect(src).toMatch(/case focusOptB:[\s\S]*?m\.c\("opt_a"\)\.UserSet\("checked", false\)/);
      expect(src).toContain('mark = "[ON ]"');
      expect(src).toContain('m.openDropdown(c.Tag())'); // Enter / Space / Down open the popup
      expect(ui).toContain('"options": []string{"Option 1", "Option 2", "Option 3"},');
    });

    it('Text, Spinner, ProgressBar, Breadcrumb', () => {
      expect(src).toContain('content := c.Str("text")');
      expect(src).toContain('growW(content, 5)'); // auto-sized text grows with its content
      expect(src).toContain('m.busy.Spinner = spinner.MiniDot');
      expect(src).toContain('label = "Loading..."');
      expect(src).toContain(
        'progress.New(progress.WithSolidFill("#f8f8f2"), progress.WithWidth(18))'
      );
      expect(src).toContain('m.progress.ViewAs(ratio(c.Float("value"), c.Float("max")))');
      expect(src).toContain('"Home / Documents / File"');
      expect(ui).toContain('"value": float64(0),');
      expect(ui).toContain('"max": float64(100),');
    });

    it('Table uses bubbles/table and follows the store', () => {
      expect(ui).toContain('"columns": []string{"Column 1", "Column 2"},');
      expect(ui).toContain('[][]string{{"Cell 1", "Cell 2"}, {"Cell 3", "Cell 4"}}');
      expect(src).toContain('table.WithStyles(tableStyles("#f8f8f2")),');
      expect(src).toContain('syncTable(&m.results, c.List("columns"), c.Rows("rows"))');
      expect(src).toContain('m.results, cmd = m.results.Update(msg)');
      expect(src).toContain('func tableStyles(fg string) table.Styles {');
      expect(src).toContain('func syncTable(t *table.Model, cols []string, rows [][]string) {');
    });

    it('List, Menu, Tree and Tabs keep their selection in the store (tree: in the model)', () => {
      expect(src).toContain(
        'c.UserSet("selected", moveCursor(c.Int("selected"), 1, len(c.List("items"))))'
      );
      expect(src).toContain('c.UserSet("selected", moveCursor(c.Int("selected"), -1, 3))'); // menu
      expect(src).toContain('[]string{"Item 1", "Item 2", "Item 3"}'); // lists show labels only
      expect(src).toContain('c.Emit("select", c.Int("selected"))');
      expect(src).toContain('m.navTree = treeKey(m.navTreeNodes(), m.navTreeOpen, m.navTree, key)');
      expect(src).toContain('{label: "📁 Root", depth: 0, parent: -1, kids: true},');
      expect(src).toContain('m.navTreeOpen = []bool{true, true, false, true, false}');
      expect(src).toContain('c.UserSet("active_tab", next)');
      expect(src).toContain('next = min(cur+1, 2)');
      expect(src).toContain(
        'tabsView([]string{"⌂ Dashboard", "Agent ● ^1", "QA Team ^2"}, c.Int("active_tab")'
      );
    });

    it('Grid, Box, Spacer, Modal', () => {
      expect(src).toContain('cv := newCanvas(1, 3)'); // grid: snapshot
      expect(src).toContain('lipgloss.DoubleBorder()');
      expect(src).toContain(
        'overlay(out, 2, 0, lipgloss.NewStyle().Bold(true).MaxWidth(36).Render(" " + line(c.Str("title")) + " "))'
      );
      expect(src).toContain('if m.ui.Open("confirm") {');
      expect(src).toContain('out = overlay(out, mx, my, m.renderConfirm(mx, my))'); // in View, not scrolled
      expect(src).toContain('m.c("confirm").UserSet("open", false)'); // esc closes it
      // tagged modals start closed (like the Textual export), untagged ones open
      expect(ui).toContain('"open": false,');
      resetIds();
      expect(uiGo(screen('S', undefined, [mk('Modal', {}, [mk('Text')])]))).toContain(
        '"open": true,'
      );
    });

    it('has the error dialog, the log panel and the refresh plumbing', () => {
      expect(src).toContain('case "ctrl+l":\n\t\tm.ui.ToggleLog()');
      expect(src).toContain('if len(m.ui.UnseenErrors()) > 0 {');
      expect(src).toContain('m.ui.MarkErrorsSeen()');
      expect(src).toContain('out, m.dlg = withDialog(out, errorDialog(errs, w))');
      expect(src).toContain('logPanel(m.ui.LogEntries()');
      expect(ui).toContain('func (r *teaRenderer) Refresh() {');
      expect(ui).toMatch(/select \{\n\tcase r\.wake <- struct\{\}\{\}:\n\tdefault:/); // never blocks
    });

    it('fills the terminal: the root takes its size from the window, top-left, no centring', () => {
      expect(src).toMatch(/func \(m \*model\) renderMain_\(ox, oy, w, h int\) string \{/);
      expect(src).toContain('iw, ih := max(w-2, 1), max(h-2, 1)');
      expect(src).toContain('w, h = m.winW, m.winH');
      expect(src).toContain('out := m.renderMain_(0, 0, w, h)');
      expect(src).toContain('out = frame(out, m.winW, m.winH, lipgloss.Left, lipgloss.Top)');
      expect(src).not.toMatch(/lipgloss\.Place\(m\.winW/);
      expect(src).not.toContain('lipgloss.Center, lipgloss.Center, out');
      // modals are centred over the root at its real size
      expect(src).toContain('mx, my := max((w-40)/2, 0), max((h-12)/2, 0)');
      expect(src).not.toMatch(/func \(m \*model\) renderMain_[\s\S]*?overlay\(out, mx, my/);
    });

    it('is clickable: mouse tracking, a rectangle per interactive component, scoped clicks', () => {
      expect(ui).toContain('tea.WithMouseCellMotion()');
      expect(src).toMatch(
        /case tea\.MouseMsg:\n\t\tprev := m\.focus\n\t\tcmd := m\.updateMouse\(msg\)/
      );
      expect(src).toContain('m.hits = m.hits[:0]');
      // every focusable component records where it was drawn
      for (const f of [
        'focusNameInput',
        'focusSubmitBtn',
        'focusAgree',
        'focusColor',
        'focusFiles',
        'focusPages',
      ]) {
        expect(src, f).toMatch(
          new RegExp(`return m\\.reg\\(${f}, "[^"]+", "[^"]*", ox, oy, st\\.Render\\(`)
        );
      }
      expect(src).toContain('return m.reg(focusOkBtn, "ok_btn", "confirm", ox, oy, st.Render(');
      // clicks: the dialog first, then the open modal, then the UI
      expect(src).toContain('if left && m.dlg.contains(msg.X, msg.Y) {');
      expect(src).toContain('if h.modal != scope || !h.contains(msg.X, msg.Y) {');
      expect(src).toContain('if c.State() != StateActive || !m.focusable(h.focus) {');
      // rows, tabs and options are chosen by position
      expect(src).toContain('c.UserSet("selected", moveCursor(ry-1, 0, len(c.List("items"))))');
      expect(src).toContain('tabAt([]string{"⌂ Dashboard", "Agent ● ^1", "QA Team ^2"}, rx-0)');
      expect(src).toContain('tableRowAt(&m.results, ry-1-1)');
      expect(src).toContain(
        'm.navTree = moveCursor(ry-0, 0, len(treeVisible(m.navTreeNodes(), m.navTreeOpen)))'
      );
      expect(src).toContain(
        'tea.Batch(cmd, m.updateFocused(tea.KeyMsg{Type: tea.KeyEnter}, "enter"))'
      );
      expect(src).toContain('func (m *model) wheel(h hit, up bool) (tea.Cmd, bool) {');
      // a design without interactive components still generates the handlers
      resetIds();
      expect(() => checkAll(screen('S', undefined, [mk('Text')]))).not.toThrow();
    });

    it('scrolls the root content: tall render, visible window, click rectangles in screen coordinates', () => {
      expect(src).toContain('start := len(m.hits)');
      expect(src).toContain('content = m.scrollWindow(content, start, oy+1, iw, ih)');
      expect(src).toContain(
        'func (m *model) scrollWindow(content string, start, top, iw, ih int) string {'
      );
      expect(src).toContain('r.scrolls, r.y0, r.fh = true, r.y, r.h');
      expect(src).toContain('y0, y1 := max(r.y-m.scroll, top), min(r.y-m.scroll+r.h, top+ih)');
      expect(src).toContain('bar[i] = "▐"'); // the thin scrollbar is only drawn when scrollMax > 0
      expect(src).toContain('if m.scrollMax == 0 {\n\t\treturn content\n\t}');
      // wheel: 3 rows per notch, but lists under the pointer scroll first
      expect(src).toContain('m.scrollBy(-3)');
      expect(src).toContain('m.scrollBy(3)');
      expect(src).toContain('if cmd, moved := m.wheel(h, up); moved {');
      expect(src).toContain('func (m *model) wheel(h hit, up bool) (tea.Cmd, bool) {');
      // PageUp/PageDown/Home/End unless a text input has the focus
      expect(src).toContain(
        'case "pgup", "pgdown", "home", "end":\n\t\tif !m.typing() && m.activeModal() == "" {'
      );
      // focusing scrolls the widget into view
      expect(src).toMatch(/if m\.focus != prev \{\n\t\t\tm\.reveal\(\)/);
      expect(src).toContain('func (m *model) reveal() {');
      // a canvas root is as tall as its content
      resetIds();
      const abs = mainGo(
        screen('S', undefined, [
          mk('Box', { props: { width: 10, height: 3 }, layout: { type: 'absolute' } }, []),
        ])
      );
      expect(abs).toContain('func (m *model) renderS(ox, oy, w, h int) string {');
    });

    it('Select is a dropdown: popup under the field, rows in the click registry', () => {
      expect(src).toContain('func (m *model) openDropdown(tag string) {');
      expect(src).toContain(
        'if key == "enter" || key == " " || key == "down" {\n\t\t\tm.openDropdown(c.Tag())'
      );
      expect(src).toContain('if m.ddTag != "" {\n\t\tm.dropdownKey(key)\n\t\treturn m, nil');
      expect(src).toContain('case "esc":\n\t\tm.ddTag = ""');
      expect(src).toContain('out = m.dropdownOverlay(out)');
      expect(src).toContain(
        'm.hits = append(m.hits, hit{focus: anchor.focus, tag: m.ddTag, modal: anchor.modal, opt: -1'
      );
      expect(src).toContain('m.ddChoose(h.opt - 1)');
      expect(src).toContain('m.ddTag = "" // a click outside closes it without a change');
      expect(src).toContain('if i < 0 || i >= len(opts) || opts[i] == c.Str("value") {'); // no event without a change
      expect(src).toContain('m.openDropdown(h.tag)'); // a click opens it
      // the dropdown is under the error dialog (View draws the dialog last)
      expect(src.indexOf('out = m.dropdownOverlay(out)')).toBeLessThan(
        src.indexOf('withDialog(out')
      );
      // designs without a select have no dropdown code
      resetIds();
      expect(mainGo(screen('S', undefined, [mk('Text')]))).not.toContain('openDropdown');
    });

    it('wires the editor event handlers as deduplicated stubs off the UI goroutine', () => {
      for (const name of ['handleChange', 'handleClick', 'handleSelect']) {
        expect(
          src.match(new RegExp(`^func \\(m \\*model\\) ${name}\\(\\) \\{$`, 'gm')),
          name
        ).toHaveLength(1);
      }
      expect(src).toMatch(/func \(m \*model\) handleClick\(\) \{\n\t\/\/ TODO: implement\n\}/);
      expect(src).toMatch(/case focusSubmitBtn:[\s\S]*?m\.ui\.Defer\(m\.handleClick\)/);
      expect(src).toMatch(
        /case focusAgree:[\s\S]*?c\.Emit\("change", v\)\n\t\t\tm\.ui\.Defer\(m\.handleChange\)/
      );
      expect(src).not.toMatch(/^\t+m\.handle\w+\(\)$/m); // never called directly in Update
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
      expect(mainGo(styled)).toContain(
        'lipgloss.NewStyle().Foreground(lipgloss.Color("#ff0000")).Background(lipgloss.Color("#00ff00")).Bold(true).Italic(true).Underline(true).Strikethrough(true).BorderStyle(lipgloss.DoubleBorder()).BorderForeground(lipgloss.Color("#0000ff")).BorderTop(false).BorderRight(true).BorderBottom(true).BorderLeft(false)'
      );
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
      const root = screen('S', undefined, [
        mk('TextInput', { tag: 'present' }),
        mk('TextInput', { tag: 'gone', hidden: true }),
      ]);
      expect(mainGo(root)).toContain('present textinput.Model');
      expect(mainGo(root) + uiGo(root)).not.toContain('gone');
      expect(uiGo(root)).toContain('ui.Present = NewInputHandle(core.Define("present"');
    });

    it('components that start muted are in the ring but not usable', () => {
      resetIds();
      const root = screen('S', undefined, [
        mk('Button', { tag: 'a', props: { label: 'A' } }),
        mk('Button', { tag: 'b', props: { label: 'B', disabled: true } }),
      ]);
      expect(mainGo(root)).toContain('focusB');
      expect(uiGo(root)).toMatch(/Define\("b", "Button", StatesNoReadonly, StateMuted,/);
      expect(mainGo(root)).toContain('if m.ui.Muted("b") {\n\t\tst = st.Faint(true)');
    });
  });

  describe('program API (ui.go)', () => {
    it('has one typed handle per code name in PascalCase and none for unnamed components', () => {
      const ui = uiGo(allComponents());
      for (const [field, type] of [
        ['Status', 'TextHandle'],
        ['NameInput', 'InputHandle'],
        ['SubmitBtn', 'ButtonHandle'],
        ['Agree', 'CheckHandle'],
        ['Dark', 'CheckHandle'],
        ['Color', 'SelectHandle'],
        ['Progress', 'ProgressHandle'],
        ['Busy', 'SpinnerHandle'],
        ['Results', 'TableHandle'],
        ['Files', 'ListHandle'],
        ['NavTree', 'TreeHandle'],
        ['MainMenu', 'MenuHandle'],
        ['Pages', 'TabsHandle'],
        ['Panel', 'ContainerHandle'],
        ['Confirm', 'ModalHandle'],
      ]) {
        expect(ui, field).toMatch(new RegExp(`\\t${field} \\*${type} // `));
        expect(ui).toContain(`ui.${field} = New${type}(core.Define(`);
      }
      // the Grid's untagged Text children are defined internally, without a handle
      expect(ui).toContain('core.Define("~text"');
      expect(ui).toMatch(/Start\(\) error \{/);
      expect(ui).toMatch(/Run\(fn func\(\*Ui\)\) error \{/);
    });

    it('keeps names that are API (Stop, Log, ...) and Go keywords out of the way', () => {
      resetIds();
      const ui = uiGo(
        screen('S', undefined, [
          mk('Text', { tag: 'stop' }),
          mk('Text', { tag: 'log' }),
          mk('Text', { tag: 'type' }),
          mk('Text', { tag: 'a_b' }),
          mk('Text', { tag: 'aB' }),
        ])
      );
      expect(ui).toMatch(/\tStop_ \*TextHandle/);
      expect(ui).toMatch(/\tLog_ \*TextHandle/);
      expect(ui).toMatch(/\tType \*TextHandle/);
      expect(ui).toMatch(/\tAB \*TextHandle/);
      expect(ui).toMatch(/\tAB_ \*TextHandle/);
      expect(() => checkGo(ui)).not.toThrow();
    });

    it('uses the model of the API for initial values', () => {
      resetIds();
      const ui = uiGo(
        screen('S', undefined, [
          mk('Select', { tag: 's', props: { options: ['a', 'b'], value: 'b' } }),
          mk('List', {
            tag: 'l',
            props: { items: [{ label: 'x' }, { label: 'y' }], selectedIndex: 1 },
          }),
          mk('Checkbox', { tag: 'c', props: { checked: true, label: 'L' } }),
          mk('ProgressBar', { tag: 'p', props: { value: 40, max: 80 } }),
        ])
      );
      expect(ui).toContain('"value": "b",');
      expect(ui).toContain('"items": []string{"x", "y"},');
      expect(ui).toContain('"selected": 1,');
      expect(ui).toContain('"checked": true,');
      expect(ui).toContain('"value": float64(40),');
      expect(ui).toContain('"max": float64(80),');
    });

    it('containers with a code-named child join at run time so that hiding frees the space', () => {
      resetIds();
      const root = screen('S', undefined, [
        mk('Text', { tag: 'a', props: { content: 'A' } }),
        mk('Text', { props: { content: 'B' } }),
      ]);
      const src = mainGo(root);
      expect(src).toMatch(/flexJoin\(false, ox\+\d+, oy\+\d+, \[\]flexItem\{/);
      expect(src).toContain('{m.renderA, 1, 1, m.ui.Hidden("a")},');
      expect(src).toMatch(/\{m\.renderText, \d+, \d+, false\},/);
      expect(() => checkAll(root)).not.toThrow();
    });
  });

  describe('layout', () => {
    const l = layouts();
    const out = (name: string) => mainGo(l[name]);

    it('flex row and column are native: joins with margins from the editor layout', () => {
      const row = out('row');
      expect(row).toMatch(/flexJoin\(true, ox\+\d+, oy\+\d+, \[\]flexItem\{/);
      expect(row).toContain('{m.renderText, 1, 1, false},');
      expect(row).toContain('{m.renderText2, 2, 1, false},'); // gap 2
      expect(row).toContain('{m.renderText3, 2, 1, false},');
      expect(row).not.toContain('newCanvas(38');
      const col = out('column');
      expect(col).toMatch(/renderBox\(ox, oy int\) string \{\n\tcontent := flexJoin\(false, /);
      expect(col).toContain('{m.renderText2, 1, 1, false},'); // gap 1
    });

    it('justify and align become offsets', () => {
      const center = out('center');
      const offsets = [...center.matchAll(/\{m\.renderText2?, (\d+), (\d+), false\}/g)].map((m) => [
        +m[1],
        +m[2],
      ]);
      expect(offsets.length).toBe(2);
      expect(offsets[0][0] + offsets[0][1]).toBeGreaterThan(0);
      const between = [
        ...out('spaceBetween').matchAll(/\{m\.renderText\d?, (\d+), 0, false\}/g),
      ].map((m) => +m[1]);
      expect(between.length).toBe(3);
      expect(between[1]).toBeGreaterThan(0);
      expect(between[1]).toBe(between[2]); // 3 items of 6 cells in 38: equal gaps
    });

    it('wrap, grid and absolute are snapshots on a cell canvas', () => {
      for (const name of ['wrapped', 'grid', 'absolute']) {
        const o = out(name);
        expect(o, name).toContain('cv := newCanvas(38, 6)');
        expect(o, name).toMatch(/cv\.put\(\d+, \d+, m\.renderText\(ox\+/);
        expect(o, name).toContain('content := cv.String()');
      }
      const abs = [...out('absolute').matchAll(/cv\.put\((\d+), (\d+), m\.renderText2?\(ox/g)].map(
        (m) => [+m[1], +m[2]]
      );
      expect(abs[1][0] - abs[0][0]).toBe(10);
      expect(abs[1][1] - abs[0][1]).toBe(1);
      const ys = new Set([...out('wrapped').matchAll(/cv\.put\(\d+, (\d+),/g)].map((m) => m[1]));
      expect(ys.size).toBeGreaterThan(1);
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
      const root = nastyDesign();
      const src = mainGo(root) + uiGo(root);
      expect(src).toContain('"He said \\"hi\\""');
      expect(src).toContain('"back\\\\slash"');
      expect(src).toContain('"new\\nline"'); // kept in the store, flattened when drawn
      expect(src).toContain('"{braces} and {{double}}"');
      expect(src).toContain('${dollar} `tick`');
      expect(src).toContain('%s %d {} {0}');
      expect(src).toContain('"/* comment */ // line"');
      expect(src).toContain('ünïcödé ✓ 日本語 🔥');
      expect(() => stripGo(src)).not.toThrow();
    });

    it('wide characters count two cells, combining marks none', () => {
      expect(cellWidth('abc')).toBe(3);
      expect(cellWidth('日本')).toBe(4);
      expect(cellWidth('e\u0301')).toBe(1);
    });

    it('turns handler names into Go identifiers', () => {
      expect(handlerName('handleClick')).toBe('handleClick');
      expect(handlerName('on-save now')).toBe('onSaveNow');
      expect(handlerName('Submit')).toBe('submit');
      expect(handlerName('9lives')).toBe('handle9lives');
      expect(handlerName('')).toBe('handler');
    });

    it('avoids Go keywords and name clashes in the model', () => {
      resetIds();
      const root = screen('S', undefined, [
        mk('TextInput', { tag: 'type' }),
        mk('TextInput', { tag: 'focus' }),
        mk('TextInput', { tag: 'x_1' }),
        mk('TextInput', { tag: 'x1' }),
        mk('Button', { tag: 'b', events: { onClick: 'type', onFocus: 'View' } }),
      ]);
      const src = mainGo(root);
      expect(() => checkAll(root)).not.toThrow();
      expect(src).not.toMatch(/^\s+type textinput\.Model$/m);
      expect(src).toMatch(/^\ttype_ textinput\.Model$/m);
      expect(src).toMatch(/^\tfocus2 textinput\.Model$/m);
      expect(src).toContain('func (m *model) type2() {');
      expect(src).toContain('func (m *model) view() {');
    });
  });

  it('exports only the first screen (single-screen adapter)', () => {
    const screens = multiScreen().map((root) => ({ id: root.id, root }));
    const files = run(screens[0].root, screens);
    const out = files.map((f) => f.content).join('\n');
    expect(out).toContain('"Ready"');
    expect(out).not.toContain('Settings screen');
    expect(out).not.toContain('Agent content');
    expect(out).toContain('// This button opens another screen');
  });
});
