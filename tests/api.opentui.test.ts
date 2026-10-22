// The program API of the OpenTUI export, run for real: the generated project is written to
// tests/runtime/.generated/opentui/ (it resolves @opentui/*, react from tests/runtime/node_modules),
// the scenario of docs/API_SCENARIO.md runs against real OpenTUI (its test renderer) under Bun,
// and every generated project is type-checked with tsc.

import { spawnSync } from 'node:child_process';
import { copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '../src/types';
import { apiDesign } from './fixtures/apiDesign';
import { allComponents } from './fixtures/designs';
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
