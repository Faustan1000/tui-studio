// The reference of the visual comparison (docs/VISUAL_SPEC.md) is Textual's own frame. This keeps it
// honest: real Textual draws the demo design at 100x40 exactly like tests/visual/reference.*.txt.
// Needs Python with `pip install textual` (TUISTUDIO_PYTHON), otherwise skipped.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { exportToFiles } from '../src/utils/export/codeExporter';
import { apiDesign } from './fixtures/apiDesign';

const python = process.env.TUISTUDIO_PYTHON ?? 'python';
const hasTextual =
  spawnSync(python, ['-I', '-c', 'import textual'], { encoding: 'utf8' }).status === 0;
if (!hasTextual) console.warn('visual.textual: Textual is not installed, the test is skipped');

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe.skipIf(!hasTextual)('textual reference frame', () => {
  it('is what real Textual draws for the demo design', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tuistudio-visual-'));
    dirs.push(dir);
    for (const f of exportToFiles(apiDesign(), 'textual'))
      writeFileSync(join(dir, f.path), f.content);
    const r = spawnSync(python, ['-I', resolve(__dirname, 'python', 'dump_frame.py'), dir], {
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    expect(r.status, r.stderr).toBe(0);
    const trim = (t: string) =>
      t
        .replace(/\r?\n$/, '')
        .split(/\r?\n/)
        .map((l) => l.replace(/\s+$/, ''));
    const reference = trim(
      readFileSync(join(__dirname, 'visual', 'reference.apiDesign.100x40.txt'), 'utf8')
    );
    expect(trim(r.stdout)).toEqual(reference);
  }, 180_000);
});
