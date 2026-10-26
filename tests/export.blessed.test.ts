// Blessed exporter: generated files, and the generated UI running on real blessed (headless).
// Tests that need the library are skipped with a message when tests/runtime/node_modules is
// missing (`npm run test:setup`).

import { afterAll, describe, expect, it } from 'vitest';
import type { ComponentNode } from '../src/types';
import { exportToFiles } from '../src/utils/export/codeExporter';
import { BLESSED_VERSION, blessedAdapter } from '../src/utils/export/exporters/blessed';
import { buildIR, walkIR } from '../src/utils/export/ir';
import type { IRNode } from '../src/utils/export/ir';
import { mk, resetIds, screen } from './fixtures/build';
import { allComponents, layouts } from './fixtures/designs';
import { nastyDesign } from './fixtures/nasty';
import {
  HAS_BLESSED,
  SKIP_REASON,
  frame,
  loadProject,
  makeTerm,
  tick,
} from './helpers/blessedHeadless';
import { assertParses } from './helpers/syntax';

const files = (root: ComponentNode) => exportToFiles(root, 'blessed');
const indexOf = (root: ComponentNode) => files(root).find((f) => f.path === 'index.js')!.content;
const ENTER = String.fromCharCode(13);
const ESC = String.fromCharCode(27);
const DOWN = ESC + '[B';
const TAB = String.fromCharCode(9);

const started: any[] = [];
afterAll(() => started.forEach((ui) => ui.stop()));

async function boot(root: ComponentNode, name: string, rows = 60) {
  const { mod } = loadProject(root, name);
  const term = makeTerm(100, rows);
  const ui = new mod.Ui(term.options);
  started.push(ui);
  await ui.start();
  await tick(30);
  return { ui, term };
}

/** Every blessed element below the screen. */
function elements(ui: any): any[] {
  const out: any[] = [];
  const walk = (el: any) => {
    for (const c of el.children) {
      out.push(c);
      walk(c);
    }
  };
  walk(ui.screen);
  return out;
}

const rectOf = (el: any) => ({ x: el.aleft, y: el.atop, width: el.width, height: el.height });

const inFloatingModal = (n: IRNode): boolean =>
  n.type === 'Modal' ? !!n.tag : !!n.parent && inFloatingModal(n.parent);

/** The editor's box of every node that is drawn, except the root (it fills the design size). */
function expectedRects(root: IRNode) {
  return (
    walkIR(root)
      // A modal with a code name belongs to the screen (centered), not to the scrolled design.
      .filter((n) => !inFloatingModal(n))
      .filter((n) => n.visible && n.type !== 'Spacer' && n.box && n !== root)
      .map((n) => ({ ...n.box!, auto: n.width === 'auto' }))
  );
}

/**
 * Every drawn node of the design sits where the editor puts it (auto-width ones may be wider).
 * `grows`: the design is a flow (children stacked at their natural size, as Textual does), so only
 * x and the width are compared.
 */
async function expectPlacementMatchesEditor(root: ComponentNode, name: string, grows = false) {
  const ir = buildIR(root);
  const { ui } = await boot(root, name);
  expect(ui.screen.options.autoPadding).toBe(false);
  const rects = elements(ui).map(rectOf);
  // The root draws its own border with one cell of padding inside, so the design sits one cell in.
  const shift = 1;
  for (const raw of expectedRects(ir.start.root)) {
    const want = { ...raw, x: raw.x + shift, y: raw.y + shift };
    const found = rects.some(
      (r) =>
        r.x === want.x &&
        (grows ? true : r.y === want.y) &&
        (grows ? true : r.height === Math.max(1, want.height)) &&
        (want.auto ? r.width >= want.width : r.width === Math.max(1, want.width))
    );
    expect(found, `${name}: no widget at ${JSON.stringify(want)}`).toBe(true);
  }
  ui.stop();
}

describe('blessed adapter: files', () => {
  it('declares itself', () => {
    expect(blessedAdapter).toMatchObject({
      id: 'blessed',
      language: 'js',
      verification: 'run',
      multiScreen: false,
    });
  });

  it('writes the project files with a pinned package.json', () => {
    const out = files(allComponents());
    expect(out.map((f) => f.path)).toEqual([
      'index.js',
      'index.d.ts',
      'ui-runtime.js',
      'ui-runtime.d.ts',
      'package.json',
      'api.js',
      'api.d.ts',
      'API.md',
    ]);
    const get = (p: string) => out.find((f) => f.path === p)!.content;
    const json = JSON.parse(get('package.json'));
    expect(json.dependencies.blessed).toBe(BLESSED_VERSION);
    expect(json.dependencies.blessed).toMatch(/^\d+\.\d+\.\d+$/);
    expect(json.scripts.start).toBe('node index.js');
    expect(json.name).toMatch(/^[a-z0-9-]+$/);
    for (const p of ['index.js', 'ui-runtime.js']) assertParses(get(p), 'js', p);
    for (const p of ['index.d.ts', 'ui-runtime.d.ts']) assertParses(get(p), 'ts', p);
    const index = get('index.js');
    expect(index).toContain("require('blessed')");
    expect(index).toMatch(/npm install && npm start/);
    expect(index).toMatch(/SNAPSHOT/);
    expect(index).toMatch(/require\.main === module/);
  });

  it('ships the same runtime for every design', () => {
    const a = files(allComponents()).find((f) => f.path === 'ui-runtime.js')!.content;
    const b = files(screen('Other', undefined, [])).find(
      (f) => f.path === 'ui-runtime.js'
    )!.content;
    expect(a).toBe(b);
  });

  it('keeps line separators out of string literals', () => {
    resetIds();
    const tree = screen('S', undefined, [
      mk('Text', { props: { content: 'a' + String.fromCharCode(0x2028, 0x2029) + 'b' } }),
    ]);
    const index = indexOf(tree);
    assertParses(index, 'js', 'index.js');
    expect(index).not.toContain(String.fromCharCode(0x2028));
    expect(index).not.toContain(String.fromCharCode(0x2029));
  });

  it('escapes user text in the source', () => {
    const index = indexOf(nastyDesign());
    assertParses(index, 'js', 'index.js');
    expect(index).toContain('new' + String.fromCharCode(92) + 'nline');
  });

  it('uses the code names for members and variables and dedupes handler stubs', () => {
    resetIds();
    const tree = screen('S', 'main', [
      mk('Button', {
        tag: 'save_btn',
        props: { label: 'Save' },
        events: { onClick: 'handleSave' },
      }),
      mk('Button', {
        tag: 'send_btn',
        props: { label: 'Send' },
        events: { onClick: 'handleSave', onFocus: 'handleFocus' },
      }),
      mk('Checkbox', { tag: 'agree', events: { onChange: 'on-agree' } }),
      mk('Text', { tag: 'blessed', props: { content: 'clash' } }),
      mk('Text', { tag: 'start', props: { content: 'member clash' } }),
    ]);
    const index = indexOf(tree);
    assertParses(index, 'js', 'index.js');
    expect(index).toContain('const saveBtn = blessed.button(');
    expect(index).toContain('const sendBtn = blessed.button(');
    expect(index).toContain('const agree = blessed.checkbox(');
    expect(index).toContain('this.saveBtn = new Handle(this, "save_btn"');
    expect(index).toContain('this.start_ = new Handle(this, "start"');
    expect(index.match(/function handleSave\(/g)).toHaveLength(1);
    expect(index).toContain('function handleFocus(');
    expect(index).toContain('function on_agree(');
    expect(index.match(/\.on\("press"/g)).toHaveLength(2);
    expect(index).toMatch(/const blessed_ = blessed\.box\(/);
  });

  it('leaves out hidden nodes and spacers', () => {
    resetIds();
    const tree = screen('S', undefined, [
      mk('Text', { props: { content: 'SHOWN' } }),
      mk('Text', { hidden: true, props: { content: 'GONE' } }),
      mk('Spacer'),
    ]);
    const index = indexOf(tree);
    expect(index).toContain('SHOWN');
    expect(index).not.toContain('GONE');
  });

  it('types every handle in index.d.ts', () => {
    const d = files(allComponents()).find((f) => f.path === 'index.d.ts')!.content;
    expect(d).toContain(
      'readonly submitBtn: Handle & { label: string; onClick(fn: Listener): Listener }'
    );
    expect(d).toContain('readonly pages: Handle & { activeTab: number;');
    expect(d).toContain('readonly confirm: Handle & { title: string; open(): void');
  });
});

describe.skipIf(!HAS_BLESSED)(
  `blessed adapter on real blessed${HAS_BLESSED ? '' : ` (SKIPPED: ${SKIP_REASON})`}`,
  () => {
    it('uses the real widget for every component type', async () => {
      const { ui } = await boot(allComponents(), 'all');
      const types = new Set(elements(ui).map((e) => e.type));
      for (const t of [
        'box',
        'textbox',
        'button',
        'checkbox',
        'radio-set',
        'radio-button',
        'list',
        'list-table',
        'listbar',
      ]) {
        expect(types.has(t), t).toBe(true);
      }
      expect(elements(ui).filter((e) => e.type === 'radio-button')).toHaveLength(2);
      expect(elements(ui).filter((e) => e.type === 'textbox')[0].options.inputOnFocus).toBe(true);
      expect(ui._timers.size).toBe(1); // the spinner
      const f = frame(ui.screen);
      for (const s of ['[ ] Option', '(○) B', '[OFF] Toggle', 'Column 1', 'Item 1', 'Dashboard']) {
        expect(f, s).toContain(s);
      }
    });

    it('never lets blessed parse user text as tags', async () => {
      const { ui } = await boot(nastyDesign(), 'nasty');
      for (const el of elements(ui)) {
        if (el.parent && el.parent.type === 'listbar') continue;
        if (el.parent && el.parent._label === el) continue;
        expect(!!el.parseTags, el.type).toBe(false);
      }
      const content = elements(ui)
        .map((e) => e.getContent())
        .join(' ');
      for (const s of ['<angle> & ampersand', '${dollar} `tick`', '%s %d {} {0}', 'ünïcödé']) {
        expect(content, s).toContain(s);
      }
      // Tab labels have `tags` on in blessed itself: braces must survive there too.
      resetIds();
      const braces = screen('S', undefined, [
        mk('Tabs', { props: { tabs: [{ label: '{red-fg}x{/red-fg}' }] } }),
      ]);
      const b = await boot(braces, 'braces');
      expect(frame(b.ui.screen)).toContain('{red-fg}x{/red-fg}');
    });

    it('places every widget exactly where the editor does', async () => {
      await expectPlacementMatchesEditor(allComponents(), 'all-placement', true);
    });

    it('places widgets of every layout fixture at the editor positions', async () => {
      for (const [name, root] of Object.entries(layouts())) {
        // A plain column is stacked like Textual does it (padding of the box adds), not at the
        // editor's slots; its spacing is checked in the layout tests of the flow.
        if (name === 'column') continue;
        await expectPlacementMatchesEditor(root, `layout-${name}`);
      }
    });

    it('uses the IR rel values as left/top', async () => {
      const root = layouts().row;
      const ir = buildIR(root);
      const { ui } = await boot(root, 'rel');
      const texts = walkIR(ir.start.root).filter((n) => n.type === 'Text');
      expect(texts).toHaveLength(3);
      for (const t of texts) {
        const el = elements(ui).find((e) => e.getContent() === t.text)!;
        // Children of a framed container sit in its inner box, one cell in.
        const inset = t.parent!.style.border ? 1 : 0;
        expect(el.position.left).toBe(t.rel!.x - inset);
        expect(el.position.top).toBe(t.rel!.y - inset);
      }
    });

    it('keeps children of bordered, padded boxes where the editor puts them', async () => {
      resetIds();
      const tree = screen('S', undefined, [
        mk(
          'Box',
          {
            props: { width: 30, height: 12 },
            style: { border: true, borderStyle: 'double' },
            layout: { type: 'flexbox', direction: 'column', padding: 1 },
          },
          [
            mk('Text', { props: { content: 'INNER', width: 10, height: 1 } }),
            mk('Box', { props: { width: 12, height: 4 }, style: { border: true } }, [
              mk('Text', { props: { content: 'DEEP', width: 4, height: 1 } }),
            ]),
          ]
        ),
      ]);
      const ir = buildIR(tree);
      const nodes = walkIR(ir.start.root);
      const inner = nodes.find((n) => n.text === 'INNER')!;
      const deep = nodes.find((n) => n.text === 'DEEP')!;
      const { ui } = await boot(tree, 'border');
      const at = (text: string) => elements(ui).find((e) => e.getContent() === text)!;
      expect(inner.rel!.x).toBeGreaterThan(0);
      // The column is laid out like Textual does: the root's padding and the box's own padding add
      // to the editor's position (one cell each).
      const dx = 2;
      expect(rectOf(at('INNER'))).toEqual({
        x: inner.box!.x + dx,
        y: inner.box!.y + dx,
        width: 10,
        height: 1,
      });
      // The frame really shows the text where the widget is.
      const lines = frame(ui.screen).split(String.fromCharCode(10));
      expect(lines[inner.box!.y + dx].slice(inner.box!.x + dx, inner.box!.x + dx + 5)).toBe(
        'INNER'
      );
      const d = rectOf(at('DEEP'));
      expect(lines[d.y].slice(d.x, d.x + 4)).toBe('DEEP');
      expect(deep).toBeTruthy();
    });

    it('writes colours and text styles as hex', async () => {
      resetIds();
      const tree = screen('S', undefined, [
        mk('Text', {
          props: { content: 'Styled' },
          style: { color: '#ff0000', backgroundColor: '#00ff00', bold: true, underline: true },
        }),
      ]);
      const { ui } = await boot(tree, 'style');
      const el = elements(ui).find((e) => e.getContent() === 'Styled')!;
      expect(el.style).toMatchObject({ fg: '#ff0000', bg: '#00ff00', bold: true, underline: true });
    });

    it('moves the focus with Tab and quits with q', async () => {
      const { ui, term } = await boot(allComponents(), 'keys');
      const first = ui.screen.focused;
      expect(first).toBeTruthy();
      expect(first.type).not.toBe('textbox');
      await term.type(TAB);
      expect(ui.screen.focused).not.toBe(first);
      expect(ui.running).toBe(true);
      const other = await boot(allComponents(), 'quit');
      await other.term.type('q');
      expect(other.ui.running).toBe(false);
    });

    it('a Select opens a popup and reports the choice', async () => {
      const { ui, term } = await boot(allComponents(), 'select');
      const events: any[] = [];
      ui.color.onChange((e: any) => events.push(e));
      const box = ui.color._views[0].widget;
      box.focus();
      await term.type(ENTER);
      expect(ui.color._views[0].popup.hidden).toBe(false);
      await term.type(DOWN);
      await term.type(ENTER);
      await tick(40);
      const second = ui.color.options[1];
      expect(ui.color.value).toBe(second);
      expect(frame(ui.screen)).toMatch(new RegExp(second + ' +▼'));
      expect(events).toMatchObject([{ tag: 'color', name: 'change', value: second }]);
      expect(ui.color._views[0].popup.hidden).toBe(true);
    });

    it('List, Tabs, Table and ProgressBar follow the program and the user', async () => {
      const { ui, term } = await boot(allComponents(), 'widgets', 80);
      const picked: any[] = [];
      ui.files.onSelect((e: any) => picked.push(e.value));
      ui.files._views[0].widget.focus();
      await term.type(DOWN);
      await term.type(ENTER);
      await tick(40);
      expect(ui.files.selected).toBe(1);
      expect(picked).toEqual([1]);
      ui.files.items = ['x', 'y', 'z'];
      ui.files.selected = 2;
      await tick(40);
      expect(ui.files._views[0].widget.items.map((i: any) => i.getContent())).toEqual([
        'x',
        'y',
        'z',
      ]);
      expect(ui.files.selected).toBe(2);
      ui.files.mute();
      ui.files._views[0].widget.focus();
      await term.type(DOWN);
      expect(ui.files.selected).toBe(2);
      ui.results.rows = [['Q1', 'Q2']];
      ui.progress.value = 100;
      await tick(40);
      expect(ui.progress._views[0].filled).toBe(100);
      expect(frame(ui.screen)).toMatch(/█+ +100%/);
      expect(ui.results._views[0].widget.rows[1]).toEqual(['Q1', 'Q2']);
      const tabs: any[] = [];
      ui.pages.onChange((e: any) => tabs.push(e.value));
      const bar = ui.pages._views[0].widget;
      bar.focus();
      bar.items[1].emit('click');
      await tick(40);
      expect(tabs).toEqual([1]);
      expect(ui.pages.activeTab).toBe(1);
    });

    it('radio buttons of a group exclude each other and keep the handles in sync', async () => {
      const { ui } = await boot(allComponents(), 'radio');
      ui.optA.checked = true;
      expect(ui.optA.checked).toBe(true);
      const events: any[] = [];
      ui.optB.onChange((e: any) => events.push(e));
      ui.optA.onChange((e: any) => events.push(e));
      ui.optB._views[0].widget.check();
      await tick(30);
      expect(ui.optB.checked).toBe(true);
      expect(ui.optA.checked).toBe(false);
      expect(events.map((e) => [e.tag, e.value]).sort()).toEqual([
        ['opt_a', false],
        ['opt_b', true],
      ]);
    });

    it('a text field shows its placeholder until it is used', async () => {
      const { ui, term } = await boot(allComponents(), 'input');
      const widget = ui.nameInput._views[0].widget;
      expect(ui.nameInput.value).toBe('');
      expect(frame(ui.screen)).toContain(ui.nameInput.placeholder);
      widget.focus();
      await tick(40);
      await term.type('hi');
      await tick(30);
      expect(ui.nameInput.value).toBe('hi');
      expect(frame(ui.screen)).not.toContain(ui.nameInput.placeholder);
      await term.type(ESC);
      expect(ui.nameInput.value).toBe('hi');
    });

    it('handles an empty screen', async () => {
      const { ui } = await boot(screen('Empty', undefined, []), 'empty');
      expect(ui.running).toBe(true);
      ui.stop();
      await ui.wait();
    });
  }
);
