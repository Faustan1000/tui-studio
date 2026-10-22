// The generated Ratatui project against the real toolchain: `cargo check` for the fixtures and
// `cargo test` for the API scenario S1..S14 (docs/API_SCENARIO.md), which drives the UI headless
// on ratatui's TestBackend (tests/apitests/ratatui/scenario_test.rs).
//
// Needs `cargo` on PATH (and network access the first time, for the crates). Skipped otherwise.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ComponentNode } from '../src/types';
import { ratatuiAdapter } from '../src/utils/export/exporters/ratatui';
import { buildIR } from '../src/utils/export/ir';
import { apiDesign } from './fixtures/apiDesign';
import { allComponents, layouts } from './fixtures/designs';
import { nastyDesign } from './fixtures/nasty';

const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
const extraPath = [join(home, '.cargo', 'bin'), join(home, 'scoop', 'shims')].join(
  process.platform === 'win32' ? ';' : ':'
);
const sep = process.platform === 'win32' ? ';' : ':';
const env = {
  ...process.env,
  PATH: `${process.env.PATH ?? process.env.Path ?? ''}${sep}${extraPath}`,
  CARGO_TARGET_DIR: join(tmpdir(), 'tuistudio-cargo-target'),
  CARGO_TERM_COLOR: 'never',
};

const hasCargo =
  spawnSync('cargo', ['--version'], { env, encoding: 'utf8', shell: true }).status === 0;
if (!hasCargo) console.warn('cargo is not on PATH: the Ratatui tests against Rust are skipped');

const dirs: string[] = [];
afterAll(() => {
  if (!process.env.TUISTUDIO_KEEP)
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function project(root: ComponentNode, withScenario = false): string {
  const dir = mkdtempSync(join(tmpdir(), 'tuistudio-ratatui-'));
  dirs.push(dir);
  const files = ratatuiAdapter.generate({
    ir: buildIR(root),
    source: [{ id: root.id, root }],
  });
  for (const f of files) {
    const path = join(dir, f.path);
    mkdirSync(dirname(path), { recursive: true });
    let content = f.content;
    if (withScenario && f.path === 'src/main.rs') content += '\n#[cfg(test)]\nmod scenario_test;\n';
    writeFileSync(path, content, 'utf8');
  }
  if (withScenario) {
    writeFileSync(
      join(dir, 'src', 'scenario_test.rs'),
      readFileSync(resolve(__dirname, 'apitests', 'ratatui', 'scenario_test.rs'), 'utf8'),
      'utf8'
    );
  }
  return dir;
}

function cargo(dir: string, args: string[]) {
  const r = spawnSync('cargo', args, {
    cwd: dir,
    env,
    encoding: 'utf8',
    timeout: 540_000,
    shell: true,
  });
  return { ok: r.status === 0, output: `${r.stdout}\n${r.stderr}` };
}

describe.skipIf(!hasCargo)('generated Ratatui project against cargo', () => {
  const fixtures: [string, () => ComponentNode][] = [
    ['apiDesign', apiDesign],
    ['allComponents', allComponents],
    ['nasty strings', nastyDesign],
    ...Object.entries(layouts()).map(
      ([k]) => [`layout ${k}`, () => layouts()[k]] as [string, () => ComponentNode]
    ),
  ];

  it.each(fixtures)(
    'cargo check: %s',
    (_name, make) => {
      const r = cargo(project(make()), ['check', '--quiet']);
      expect(r.output.match(/^error.*$/gm) ?? [], r.output).toEqual([]);
      expect(r.ok, r.output).toBe(true);
    },
    540_000
  );

  it('cargo test: API scenario S1..S14 on the TestBackend', () => {
    const r = cargo(project(apiDesign(), true), ['test', '--quiet', '--', '--test-threads=4']);
    // Every step of the scenario must be reported as passed.
    const out = r.output;
    expect(r.ok, out).toBe(true);
    const passed = out.match(/test result: ok\. (\d+) passed; 0 failed/);
    expect(Number(passed?.[1] ?? 0), out).toBeGreaterThanOrEqual(16);
  }, 540_000);
});

describe('ratatui adapter', () => {
  it('is verified by running it', () => {
    expect(ratatuiAdapter.verification).toBe('run');
  });
});
