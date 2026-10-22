// Visual consistency (docs/VISUAL_SPEC.md): the demo design (tests/fixtures/apiDesign.ts) drawn by
// real Ink at 100x40 cells must equal Textual's frame (tests/visual/reference.apiDesign.100x40.txt),
// cell by cell on the text. The documented differences are applied below, nothing else is ignored.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportToFiles } from '../src/utils/export/codeExporter';
import { apiDesign } from './fixtures/apiDesign';

const RUNTIME = resolve(__dirname, 'runtime');
const NODE_MODULES = join(RUNTIME, 'node_modules');
const GENERATED = join(RUNTIME, '.generated', 'ink', 'visual');
const TSX = join(NODE_MODULES, 'tsx', 'dist', 'cli.mjs');
const REFERENCE = join(__dirname, 'visual', 'reference.apiDesign.100x40.txt');
const installed = existsSync(join(NODE_MODULES, 'ink-testing-library'));

if (!installed) {
  console.warn(
    'visual.ink.test: tests/runtime/node_modules is missing, skipping (run `npm run test:setup`)'
  );
}

const COLS = 100;
const ROWS = 40;

/** The first frame real Ink draws for the demo design on a COLSxROWS terminal. */
function inkFrame(): string[] {
  rmSync(GENERATED, { recursive: true, force: true });
  for (const f of exportToFiles(apiDesign(), 'ink')) {
    const target = join(GENERATED, f.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.content, 'utf8');
  }
  copyFileSync(join(__dirname, 'helpers', 'ink-frame.mjs'), join(GENERATED, 'frame.mjs'));
  const r = spawnSync(process.execPath, [TSX, 'frame.mjs', String(COLS), String(ROWS)], {
    cwd: GENERATED,
    encoding: 'utf8',
    timeout: 120_000,
  });
  const out = (r.stdout ?? '').replace(/\r/g, '');
  expect(out, r.stderr).toContain('FRAME_END');
  return out.split('FRAME_START\n')[1].split('\nFRAME_END')[0].split('\n');
}

const trim = (lines: string[]) => lines.map((l) => l.replace(/\s+$/, ''));

describe.skipIf(!installed)('ink looks like the Textual reference (100x40)', () => {
  it('draws the demo design cell by cell like Textual', () => {
    const reference = trim(readFileSync(REFERENCE, 'utf8').split(/\r?\n/).slice(0, ROWS));
    const frame = trim(inkFrame());
    expect(frame).toHaveLength(ROWS);
    expect(reference).toHaveLength(ROWS);

    // Accepted difference 1: Textual's checkbox always draws its inner glyph (see the comment of
    // emitToggle in the Textual exporter), so the unchecked demo checkbox shows "[✓]" there.
    // The spec says "[ ] label" for unchecked, which is what Ink draws.
    const box = reference.findIndex((l) => l.includes('[✓] I agree'));
    expect(box, 'the checkbox is in the reference').toBeGreaterThan(0);
    reference[box] = reference[box].replace('[✓]', '[ ]');

    // Accepted difference 3: the glyph of the underline under Tabs (one row of ─, ━ or ▔).
    const tabs = reference.findIndex((l) => l.includes('⌂ Dashboard'));
    const underline = /^│ [╸╺─━▔]+ *│$/;
    expect(reference[tabs + 1]).toMatch(underline);
    expect(frame[tabs + 1]).toMatch(underline);
    const same = '│ ' + '━'.repeat(COLS - 4) + ' │';
    reference[tabs + 1] = same;
    frame[tabs + 1] = frame[tabs + 1].replace(/[╸╺─━▔]/g, '━');

    const diff: string[] = [];
    for (let y = 0; y < ROWS; y++) {
      if (reference[y] !== frame[y]) {
        diff.push(`row ${y}\n  textual: ${reference[y]}\n  ink:     ${frame[y]}`);
      }
    }
    expect(diff.join('\n')).toBe('');
  }, 150_000);
});
