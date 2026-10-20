// Runs the exported Textual app against real Textual (headless). It checks behaviour, not text:
// the program API, threading, screens and links, and that the layout matches the editor.
//
// Needs Python with `pip install textual`. Set TUISTUDIO_PYTHON to use a specific interpreter.
// Without Textual these tests are skipped (the generated code is still syntax-checked elsewhere).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { exportToFiles } from '../src/utils/export/codeExporter';
import {
  linksProject,
  parityProject,
  runtimeProject,
  tabsProject,
  deepProject,
  type Project,
} from './fixtures/textualProjects';

const python = process.env.TUISTUDIO_PYTHON ?? 'python';
const hasTextual =
  spawnSync(python, ['-I', '-c', 'import textual'], { encoding: 'utf8' }).status === 0;
const scripts = resolve(__dirname, 'python');
const dirs: string[] = [];

function generate(project: Project, extra?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'tuistudio-textual-'));
  dirs.push(dir);
  const files = exportToFiles(project.screens[0].root, 'textual', project.screens);
  for (const f of files) writeFileSync(join(dir, f.path), f.content, 'utf8');
  if (extra) writeFileSync(join(dir, 'cases.json'), JSON.stringify(extra), 'utf8');
  return dir;
}

function run(script: string, dir: string) {
  const r = spawnSync(python, ['-I', join(scripts, script), dir], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', NO_COLOR: '1' },
  });
  return { ok: r.status === 0, output: `${r.stdout}\n${r.stderr}`.trim() };
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(!hasTextual)('exported Textual app against real Textual', () => {
  const cases: [string, string, () => string][] = [
    ['mounts and shows every component', 'real_smoke.py', () => generate(runtimeProject())],
    ['mounts a design nested 30 levels deep', 'real_smoke.py', () => generate(deepProject())],
    [
      'program API: states, values, events, error dialog',
      'real_test.py',
      () => generate(runtimeProject()),
    ],
    [
      'program running next to the UI in a thread',
      'real_thread.py',
      () => generate(runtimeProject()),
    ],
    ['screens, tab bodies and menu bodies', 'real_multi.py', () => generate(tabsProject())],
    ['buttons, menu and list items open screens', 'real_links.py', () => generate(linksProject())],
    [
      'layout matches the editor (flex, grid, absolute, wrap, alignment)',
      'parity.py',
      () => {
        const p = parityProject();
        return generate(p, p.cases);
      },
    ],
  ];

  it.each(cases)(
    '%s',
    (_name, script, prepare) => {
      const result = run(script, prepare());
      expect(result.ok, result.output.split('\n').slice(-40).join('\n')).toBe(true);
    },
    150_000
  );
});

describe('python environment', () => {
  it('reports whether the real-Textual tests ran', () => {
    // Visible in the test output: a green run without Textual is not a run against Textual.
    console.info(
      hasTextual ? `real Textual: yes (${python})` : 'real Textual: NOT available, skipped'
    );
    expect(true).toBe(true);
  });
});
