// The program API of the OpenTUI export, run for real: the generated project is written to
// tests/runtime/.generated/opentui/ (it resolves @opentui/*, react from tests/runtime/node_modules),
// the scenario of docs/API_SCENARIO.md runs against real OpenTUI (its test renderer) under Bun,
// and every generated project is type-checked with tsc.

import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '../src/types';
import { apiDesign } from './fixtures/apiDesign';
import { allComponents, multiScreen, screenLinks } from './fixtures/designs';
import { nastyDesign } from './fixtures/nasty';
import { findBun, hasRuntimeModules, typecheck, writeProject } from './helpers/opentuiProject';

const NL = String.fromCharCode(10);
const bun = findBun();
const modules = hasRuntimeModules();
if (!bun) console.warn('api.opentui.test: bun was not found, the real-OpenTUI scenario is skipped');
if (!modules)
  console.warn(
    'api.opentui.test: tests/runtime/node_modules is missing, skipping (run `npm run test:setup`)'
  );

describe.skipIf(!bun || !modules)('opentui program API against real OpenTUI (Bun)', () => {
  it('passes the scenario S1..S14', () => {
    const dir = writeProject('api', apiDesign());
    copyFileSync(join(__dirname, 'helpers', 'opentui-scenario.ts.txt'), join(dir, 'scenario.ts'));
    const r = spawnSync(bun!, ['scenario.ts'], { cwd: dir, encoding: 'utf8', timeout: 120_000 });
    const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith('RESULTS '));
    expect(line, `no results\n${r.stdout}\n${r.stderr}`).toBeTruthy();
    const results = JSON.parse(line!.slice('RESULTS '.length)) as {
      name: string;
      ok: boolean;
      info?: string;
    }[];
    expect(results.length).toBeGreaterThan(30);
    const failed = results.filter((x) => !x.ok).map((x) => `${x.name}: ${x.info}`);
    expect(failed).toEqual([]);
    for (const step of [
      'S1',
      'S2',
      'S3',
      'S4',
      'S5',
      'S6',
      'S7',
      'S8',
      'S9',
      'S10',
      'S11',
      'S12',
      'S13',
      'S14',
    ]) {
      expect(
        results.some((x) => x.name.startsWith(step + ' ')),
        step
      ).toBe(true);
    }
  }, 180_000);
});

describe.skipIf(!bun || !modules)('opentui frames on short terminals', () => {
  const frames = (name: string, root: ComponentNode, cases: object[]) => {
    const dir = writeProject(`frames-${name}`, root);
    copyFileSync(join(__dirname, 'helpers', 'opentui-frames.ts.txt'), join(dir, 'frames.ts'));
    const r = spawnSync(bun!, ['frames.ts', JSON.stringify(cases)], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 120_000,
    });
    const line = (r.stdout ?? '').split(NL).find((l) => l.startsWith('RESULTS '));
    expect(line, `no results${NL}${r.stdout}${NL}${r.stderr}`).toBeTruthy();
    const results = JSON.parse(line!.slice('RESULTS '.length)) as {
      name: string;
      ok: boolean;
      info?: string;
    }[];
    return results.filter((x) => !x.ok).map((x) => `${x.name}${NL}${x.info}`);
  };

  it('apiDesign keeps every widget at 80x24 and 118x30 (the rest scrolls)', () => {
    const top = ['Ready', 'I agree', 'Send', 'Red', 'Column 1', 'Cell 1'];
    const bottom = ['Cell 3', 'Item 1', 'Dashboard', 'Agent', 'QA Team', 'Inside the panel'];
    expect(
      frames('api', apiDesign(), [
        { width: 80, height: 24, texts: top, scrolled: bottom },
        { width: 118, height: 30, texts: top, scrolled: bottom },
        { width: 118, height: 80, texts: [...top, ...bottom] },
      ])
    ).toEqual([]);
  }, 180_000);

  it('allComponents shows everything it has room for', () => {
    const top = ['Ready', 'Send'];
    const all = [
      ...top,
      'Option',
      'Cell 1',
      'Item 1',
      'Home',
      'Dashboard',
      'Column 1',
      'Documents',
    ];
    expect(
      frames('all', allComponents(), [
        { width: 80, height: 24, texts: top, scrolled: ['Documents'] },
        { width: 118, height: 30, texts: top, scrolled: ['Documents'] },
        { width: 118, height: 90, texts: all },
      ])
    ).toEqual([]);
  }, 180_000);
});

describe.skipIf(!modules)('type-checks the generated OpenTUI project', () => {
  const designs: [string, () => ComponentNode][] = [
    ['api', apiDesign],
    ['all', allComponents],
    ['nasty', nastyDesign],
  ];
  it.each(designs)(
    '%s',
    (name, make) => {
      const dir = writeProject(`check-${name}`, make());
      expect(typecheck(dir) ?? '').toBe('');
      writeFileSync(join(dir, '.checked'), '');
    },
    180_000
  );
});

describe.skipIf(!modules)('opentui tab/menu bodies', () => {
  it('type-checks a design with switching bodies and draws every body behind a gate', () => {
    const dir = writeProject('nav-bodies', multiScreen()[0]);
    expect(typecheck(dir)).toBeNull();
    const app = readFileSync(join(dir, 'src', 'index.tsx'), 'utf8');
    expect(app).toContain('Dashboard content');
    expect(app).toContain('Agent content');
    expect(app).toMatch(/\.active_tab === 1 && \(/);
    expect(app).toMatch(/\.selected === 0 && \(/);
  }, 180_000);
});

describe.skipIf(!bun || !modules)('opentui screens in real OpenTUI (Bun)', () => {
  it('shows one screen at a time, switches with show() and through a button link', () => {
    const screens = multiScreen().map((root) => ({ id: root.tag ?? 'about', root }));
    const dir = writeProject('screens', screens[0].root, screens);
    expect(typecheck(dir) ?? '').toBe('');
    writeFileSync(
      join(dir, 'screens.ts'),
      [
        "import { createTestRenderer } from '@opentui/core/testing';",
        "import { Ui } from './src/index';",
        'const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));',
        'const setup = await createTestRenderer({ width: 100, height: 40, exitOnCtrlC: false });',
        'const ui = new Ui();',
        'await ui.start({ renderer: setup.renderer });',
        'const frame = async () => { await sleep(150); await setup.renderOnce(); return setup.captureCharFrame(); };',
        'const first = await frame();',
        'ui.settings.show();',
        'const second = await frame();',
        'const active = ui.settings.isActive;',
        // the first control (the text field) has the focus: Tab to the Back button, press Enter
        'setup.mockInput.pressTab();',
        'await sleep(100);',
        'setup.mockInput.pressEnter();',
        'const third = await frame();',
        "console.log('SCREENS ' + JSON.stringify({ first, second, third, active }));",
        'ui.stop();',
        'process.exit(0);',
      ].join(NL)
    );
    const r = spawnSync(bun!, ['screens.ts'], { cwd: dir, encoding: 'utf8', timeout: 120_000 });
    const line = (r.stdout ?? '').split(NL).find((l) => l.startsWith('SCREENS '));
    expect(line, `${r.stdout}${NL}${r.stderr}`).toBeTruthy();
    const { first, second, third, active } = JSON.parse(line!.slice(8)) as Record<string, any>;
    expect(first).toContain('Ready');
    expect(first).not.toContain('Settings screen');
    expect(second).toContain('Settings screen');
    expect(second).not.toContain('Ready');
    expect(active).toBe(true);
    expect(third, `back button: ${third}`).toContain('Ready');
  }, 180_000);
  it('tab, menu and list items open their screens; modals stay on their own screen', () => {
    const screens = screenLinks().map((root) => ({ id: root.tag!, root }));
    const dir = writeProject('screen-links', screens[0].root, screens);
    expect(typecheck(dir) ?? '').toBe('');
    writeFileSync(
      join(dir, 'links.ts'),
      [
        "import { createTestRenderer } from '@opentui/core/testing';",
        "import { Ui } from './src/index';",
        'const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));',
        'const setup = await createTestRenderer({ width: 100, height: 40, exitOnCtrlC: false });',
        'const ui: any = new Ui();',
        'await ui.start({ renderer: setup.renderer });',
        'const frame = async () => { await sleep(150); await setup.renderOnce(); return setup.captureCharFrame(); };',
        'const key = async (fn: () => void) => { fn(); await sleep(100); };',
        'const out: Record<string, string> = {};',
        'out.home = await frame();',
        // the program sets the tab: no screen change
        'ui.navTabs.activeTab = 1;',
        'out.program = await frame();',
        'ui.navTabs.activeTab = 0;',
        'await frame();',
        // the user selects the tab: first control (the tab bar) has the focus
        'await key(() => setup.mockInput.pressArrow("right"));',
        'out.tabKey = await frame();',
        'await key(() => setup.mockInput.pressTab());',
        'await key(() => setup.mockInput.pressEnter());',
        'out.back = await frame();',
        // menu: next control after the tabs
        'await key(() => setup.mockInput.pressTab());',
        'await key(() => setup.mockInput.pressEnter());',
        'out.menu = await frame();',
        'await key(() => setup.mockInput.pressTab());',
        'await key(() => setup.mockInput.pressEnter());',
        'out.menuBack = await frame();',
        // list: the third control of the home screen (its focus starts on the tabs again)
        'await key(() => setup.mockInput.pressTab());',
        'await key(() => setup.mockInput.pressTab());',
        'await key(() => setup.mockInput.pressEnter());',
        'out.list = await frame();',
        'ui.home.show();',
        'await frame();',
        // modal of the settings screen while the home screen is shown
        'ui.confirm.open();',
        'out.modalAway = await frame();',
        'ui.settings.show();',
        'await frame();',
        'ui.confirm.open();',
        'out.modalHere = await frame();',
        "console.log('LINKS ' + JSON.stringify(out));",
        'ui.stop();',
        'process.exit(0);',
      ].join(NL)
    );
    const r = spawnSync(bun!, ['links.ts'], { cwd: dir, encoding: 'utf8', timeout: 120_000 });
    const line = (r.stdout ?? '').split(NL).find((l) => l.startsWith('LINKS '));
    expect(line, `${r.stdout}${NL}${r.stderr}`).toBeTruthy();
    const o = JSON.parse(line!.slice(6)) as Record<string, string>;
    expect(o.home).toContain('Home screen');
    expect(o.program, 'program sets the tab').toContain('Home screen');
    expect(o.tabKey, 'tab chosen with the arrow key').toContain('Settings screen');
    expect(o.back, 'Back button').toContain('Home screen');
    expect(o.menu, 'menu item').toContain('About screen');
    expect(o.menuBack, 'About back').toContain('Home screen');
    expect(o.list, 'list item').toContain('Settings screen');
    expect(o.modalAway).not.toContain('Modal body');
    expect(o.modalHere).toContain('Modal body');
  }, 180_000);
});
