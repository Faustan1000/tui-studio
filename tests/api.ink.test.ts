// The program API of the Ink export, run for real: the generated project is written to
// tests/runtime/.generated/ink/ (it resolves ink, react, ... from tests/runtime/node_modules),
// the scenario of docs/API_SCENARIO.md runs against real Ink (ink-testing-library) in a tsx
// process (tests/helpers/ink-scenario.mjs), layouts are measured in real Ink frames, and every
// generated project is type-checked with tsc.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '../src/types';
import { exportToFiles } from '../src/utils/export/codeExporter';
import { apiDesign } from './fixtures/apiDesign';
import { allComponents, layouts } from './fixtures/designs';
import { nastyDesign } from './fixtures/nasty';

const RUNTIME = resolve(__dirname, 'runtime');
const NODE_MODULES = join(RUNTIME, 'node_modules');
const GENERATED = join(RUNTIME, '.generated', 'ink');
const TSX = join(NODE_MODULES, 'tsx', 'dist', 'cli.mjs');
const installed = existsSync(join(NODE_MODULES, 'ink-testing-library'));

if (!installed) {
  console.warn(
    'api.ink.test: tests/runtime/node_modules is missing, skipping (run `npm run test:setup`)'
  );
}

function generate(name: string, root: ComponentNode): string {
  const dir = join(GENERATED, name);
  rmSync(dir, { recursive: true, force: true });
  for (const f of exportToFiles(root, 'ink')) {
    const target = join(dir, f.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.content, 'utf8');
  }
  return dir;
}

function node(args: string[], cwd: string, timeout = 120_000) {
  return spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout });
}

const FRAME_SCRIPT = [
  "import { render } from 'ink-testing-library';",
  "import { Ui } from './src/app';",
  'let app;',
  'const ui = new Ui({ render: (el) => (app = render(el)) });',
  'await ui.start();',
  "console.log('FRAME_START');",
  'console.log(app.lastFrame());',
  "console.log('FRAME_END');",
  'process.exit(0);',
].join('\n');

/** The first frame real Ink draws for a design, as lines. */
function frameOf(name: string, root: ComponentNode): string[] {
  const dir = generate(`layout-${name}`, root);
  writeFileSync(join(dir, 'frame.mjs'), FRAME_SCRIPT);
  const r = node([TSX, 'frame.mjs'], dir);
  const out = (r.stdout ?? '').replace(/\r/g, '');
  expect(out, r.stderr).toContain('FRAME_END');
  return out.split('FRAME_START\n')[1].split('\nFRAME_END')[0].split('\n');
}

const at = (lines: string[], text: string) => {
  const y = lines.findIndex((l) => l.includes(text));
  return { x: y < 0 ? -1 : lines[y].indexOf(text), y };
};

describe.skipIf(!installed)('ink program API against real Ink', () => {
  it('passes the scenario S1..S14', () => {
    const dir = generate('api', apiDesign());
    copyFileSync(join(__dirname, 'helpers', 'ink-scenario.mjs'), join(dir, 'scenario.mjs'));
    const r = node([TSX, 'scenario.mjs'], dir);
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

  it.each([
    ['allComponents', allComponents],
    ['nasty', nastyDesign],
  ] as [string, () => ComponentNode][])(
    'fills the terminal at 80x24 and 120x40 (%s)',
    (name, make) => {
      const dir = generate(`fill-${name}`, make());
      copyFileSync(join(__dirname, 'helpers', 'ink-scenario.mjs'), join(dir, 'scenario.mjs'));
      const r = node([TSX, 'scenario.mjs', 'fill'], dir);
      const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith('RESULTS '));
      expect(line, `no results\n${r.stdout}\n${r.stderr}`).toBeTruthy();
      const results = JSON.parse(line!.slice('RESULTS '.length)) as {
        name: string;
        ok: boolean;
        info?: string;
      }[];
      expect(results.filter((x) => !x.ok).map((x) => `${x.name}: ${x.info}`)).toEqual([]);
      expect(results.filter((x) => x.name.startsWith('S16')).length).toBeGreaterThanOrEqual(9);
    },
    120_000
  );

  // Opt-in (TUISTUDIO_REALCONSOLE=1, opens a console window): the same app in a REAL Windows console (tests/helpers/winconsole.ps1). A terminal that reports
  // the mouse as text (Windows Terminal) hands the report over key by key, so that is what is
  // injected: Esc and then the characters of the report.
  const winconsole = join(__dirname, 'helpers', 'winconsole.ps1');
  it.skipIf(
    process.platform !== 'win32' || !existsSync(winconsole) || !process.env.TUISTUDIO_REALCONSOLE
  )(
    'clicks and scrolls in a real console',
    () => {
      const dir = generate('real', apiDesign());
      const report = (button: number, x: number, y: number) =>
        `esc,t:[<${button};${x + 1};${y + 1}M,wait:250`;
      const steps = [
        'wait:300',
        'dump',
        report(0, 4, 11), // the checkbox
        'dump',
        report(65, 10, 10),
        report(65, 10, 10),
        report(65, 10, 10),
        'dump',
        report(64, 10, 10),
        'dump',
      ].join(',');
      const r = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          winconsole,
          '-Exe',
          process.execPath,
          '-Args',
          `"${TSX}" src/app.tsx`,
          '-WorkDir',
          dir,
          '-Pause',
          '8',
          '-Cols',
          '100',
          '-Rows',
          '24',
          '-Settle',
          '6',
          '-Quiet',
          '-Steps',
          steps,
        ],
        { encoding: 'utf8', timeout: 120_000 }
      );
      const out = (r.stdout ?? '') + (r.stderr ?? '');
      expect(out, 'the console could not be attached').not.toMatch(/attach failed/);
      const dumps = out.split(/^=== dump .*===$/m).slice(1);
      expect(dumps.length, out).toBe(4);
      expect(dumps[0]).toContain('[ ] I agree');
      expect(dumps[1], 'the click reached the app').toContain('[✓] I agree');
      expect(dumps[2], 'three wheel notches scroll 9 rows').not.toContain('Ready');
      expect(dumps[3], 'one notch back up').toContain('Item 1');
      expect(out).toContain('still running');
    },
    150_000
  );

  describe('layout in real Ink', { timeout: 90_000 }, () => {
    it('absolute children sit at the editor offset', () => {
      const lines = frameOf('absolute', layouts().absolute);
      const corner = lines.findIndex((l) => l.includes('┌', 2));
      const box = { x: lines[corner].indexOf('┌', 2), y: corner };
      const t0 = at(lines, 'T0');
      const t1 = at(lines, 'T1');
      expect([t0.x - box.x, t0.y - box.y]).toEqual([4, 3]);
      expect([t1.x - box.x, t1.y - box.y]).toEqual([14, 4]);
    });

    it('rows and columns use the gap, grids put cells next to each other', () => {
      const row = frameOf('row', layouts().row);
      const [a, b] = [at(row, 'T0'), at(row, 'T1')];
      expect(a.y).toBe(b.y);
      expect(b.x - a.x).toBe(6 + 2);
      const col = frameOf('column', layouts().column);
      expect(at(col, 'T1').y - at(col, 'T0').y).toBe(2);
      const grid = frameOf('grid', layouts().grid);
      expect(at(grid, 'T1').y).toBe(at(grid, 'T0').y);
      expect(at(grid, 'T2').y).toBeGreaterThan(at(grid, 'T0').y);
    });

    it('spaces children evenly', () => {
      const between = frameOf('between', layouts().spaceBetween);
      const xs = ['T0', 'T1', 'T2'].map((t) => at(between, t).x);
      expect(xs[1] - xs[0]).toBe(xs[2] - xs[1]);
      const wrapped = frameOf('wrapped', layouts().wrapped);
      expect(at(wrapped, 'T7').y).toBeGreaterThan(at(wrapped, 'T0').y);
    });
  });

  describe('type-checks the generated project', () => {
    const designs: [string, () => ComponentNode][] = [
      ['api', apiDesign],
      ['all', allComponents],
      ['nasty', nastyDesign],
    ];
    it.each(designs)(
      '%s',
      (name, make) => {
        const dir = generate(`check-${name}`, make());
        // @types/react comes from the editor's own node_modules (tests/runtime has only the runtime).
        const types = join(__dirname, '..', 'node_modules', '@types');
        writeFileSync(
          join(dir, 'tsconfig.check.json'),
          JSON.stringify({
            extends: './tsconfig.json',
            compilerOptions: {
              typeRoots: [types],
              types: ['node'],
              paths: { react: [join(types, 'react')] },
            },
          })
        );
        const r = node(
          [join(NODE_MODULES, 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.check.json'],
          dir
        );
        expect(`${r.stdout}${r.stderr}`.trim()).toBe('');
      },
      120_000
    );
  });
});
