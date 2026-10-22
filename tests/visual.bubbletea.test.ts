// Visual consistency (docs/VISUAL_SPEC.md): the demo design rendered by the generated Bubble Tea
// program at 100x40 cells is compared, as text, with the Textual frame stored in
// tests/visual/reference.apiDesign.100x40.txt. Skipped when `go` is not installed.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportToFiles } from '../src/utils/export/codeExporter';
import { apiDesign } from './fixtures/apiDesign';
import { findGo, runGo, writeProject } from './helpers/go';

const go = findGo();
if (!go) console.warn('visual.bubbletea: `go` is not on PATH, the test is skipped');
const suite = go ? describe : describe.skip;

const trimEnd = (lines: string[]) => lines.map((l) => l.replace(/\s+$/, ''));

/** The View() of the generated program at 100x40, ANSI stripped. */
function renderFrame(): string[] {
  const dump = readFileSync(join(__dirname, 'visual', 'bubbletea_frame_test.go'), 'utf8');
  const dir = writeProject([
    ...exportToFiles(apiDesign(), 'bubbletea'),
    { path: 'frame_test.go', content: dump },
  ]);
  const tidy = runGo(['mod', 'tidy'], dir);
  expect(tidy.output, 'go mod tidy').toBe('');
  const out = join(dir, 'frame.txt');
  process.env.TUISTUDIO_FRAME_OUT = out;
  const r = runGo(['test', '-count=1', '-run', 'TestDumpFrame', './...'], dir);
  expect(r.ok, r.output).toBe(true);
  return readFileSync(out, 'utf8').split('\n');
}

suite('bubbletea visual consistency (real Go)', () => {
  it('draws the demo design like the reference (Textual) at 100x40', () => {
    const reference = readFileSync(
      join(__dirname, 'visual', 'reference.apiDesign.100x40.txt'),
      'utf8'
    )
      .replace(/\r?\n$/, '')
      .split('\n');
    const frame = renderFrame();
    expect(frame.length).toBe(reference.length);
    expect(frame.every((l) => [...l].length === 100)).toBe(true);

    // Accepted difference 2: Textual draws the mark of the unchecked demo checkbox as `[✓]`
    // (it only dims it); the program draws `[ ]` for unchecked, as the spec says.
    const cb = reference.findIndex((l) => l.includes('[✓] I agree'));
    expect(cb).toBeGreaterThan(0);
    expect(frame[cb]).toContain('[ ] I agree');
    frame[cb] = frame[cb].replace('[ ] I agree', '[✓] I agree');

    // Accepted difference 3: the underline under the tabs may be any run of ─ ━ ▔ ╸ ╺.
    const rule = reference.findIndex((l) => l.includes('╸'));
    expect(frame[rule]).toMatch(/^│ [─━▔╸╺]{96} │$/);

    const a = trimEnd(frame);
    const b = trimEnd(reference);
    const diff = a
      .map((l, i) => (l === b[i] ? null : `row ${i}\n  got:  ${l}\n  want: ${b[i]}`))
      .filter(Boolean);
    expect(diff.join('\n')).toBe('');
  }, 600_000);
});
