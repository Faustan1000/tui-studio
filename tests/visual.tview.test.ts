// Visual consistency (docs/VISUAL_SPEC.md): the demo design drawn by the generated tview program
// at 100x40 cells (tcell simulation screen) is compared, as text, with the Textual frame stored in
// tests/visual/reference.apiDesign.100x40.txt. Skipped when `go` is not installed.

import { copyFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportToFiles } from '../src/utils/export/codeExporter';
import { apiDesign } from './fixtures/apiDesign';
import { findGo, runGo, writeProject } from './helpers/go';

const go = findGo();
if (!go) console.warn('visual.tview: `go` is not on PATH, the test is skipped');
const suite = go ? describe : describe.skip;

const trimEnd = (lines: string[]) => lines.map((l) => l.replace(/\s+$/, ''));

function renderFrame(): string[] {
  const dir = writeProject(exportToFiles(apiDesign(), 'tview'));
  const tests = resolve(__dirname, 'apitests', 'tview');
  for (const n of ['helpers_test.go', 'visual_test.go']) copyFileSync(join(tests, n), join(dir, n));
  const tidy = runGo(['mod', 'tidy'], dir);
  expect(tidy.output, 'go mod tidy').toBe('');
  const out = join(dir, 'frame.txt');
  process.env.TUISTUDIO_FRAME_OUT = out;
  const r = runGo(['test', '-count=1', '-run', 'TestVisualFrame', './...'], dir);
  expect(r.ok, r.output).toBe(true);
  return readFileSync(out, 'utf8')
    .replace(/\r?\n$/, '')
    .split('\n');
}

suite('tview visual consistency (real Go)', () => {
  it('draws the demo design like the reference (Textual) at 100x40', () => {
    const reference = readFileSync(
      join(__dirname, 'visual', 'reference.apiDesign.100x40.txt'),
      'utf8'
    )
      .replace(/\r?\n$/, '')
      .split('\n');
    // Accepted difference: Textual always draws the check mark of its checkbox glyph (it only dims
    // it), so the unchecked demo checkbox reads `[✓]` there; the spec says `[ ]` for unchecked.
    const cb = reference.findIndex((l) => l.includes('[✓] I agree'));
    expect(cb).toBeGreaterThan(0);
    reference[cb] = reference[cb].replace('[✓]', '[ ]');
    const frame = renderFrame();
    expect(frame.length).toBe(reference.length);
    const a = trimEnd(frame);
    const b = trimEnd(reference);
    const diff = a
      .map((l, i) => (l === b[i] ? null : `row ${i}\n  got:  ${l}\n  want: ${b[i]}`))
      .filter(Boolean);
    expect(diff.join('\n')).toBe('');
  }, 600_000);
});
