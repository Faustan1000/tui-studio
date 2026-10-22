// Visual parity of the OpenTUI export with the Textual reference (docs/VISUAL_SPEC.md): the demo
// design is rendered at 100x40 by real OpenTUI (its test renderer, under Bun) and diffed cell by cell.

import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { apiDesign } from './fixtures/apiDesign';
import { findBun, hasRuntimeModules, writeProject } from './helpers/opentuiProject';

const REF = resolve(__dirname, 'visual', 'reference.apiDesign.100x40.txt');
const bun = findBun();
const modules = hasRuntimeModules();
if (!bun || !modules)
  console.warn('visual.opentui.test: bun or tests/runtime/node_modules is missing, skipping');

/**
 * Accepted differences (docs/VISUAL_SPEC.md): Textual always draws the inner glyph of a checkbox
 * (`[✓]`, dimmed when off), OpenTUI shows `[ ]` for an unchecked one.
 */
const ACCEPTED: [string, string][] = [['[✓] I agree', '[ ] I agree']];

describe.skipIf(!bun || !modules)('opentui visual parity with Textual', () => {
  it('renders the demo design at 100x40 like the reference', () => {
    const dir = writeProject('visual', apiDesign());
    copyFileSync(join(__dirname, 'helpers', 'opentui-visual.ts.txt'), join(dir, 'visual.ts'));
    const r = spawnSync(bun!, ['visual.ts'], { cwd: dir, encoding: 'utf8', timeout: 120_000 });
    const out = (r.stdout ?? '').split(/\r?\n/);
    const from = out.indexOf('FRAME-BEGIN');
    const to = out.indexOf('FRAME-END');
    expect(from >= 0 && to > from, `no frame\n${r.stdout}\n${r.stderr}`).toBe(true);
    const got = out.slice(from + 1, to).map((l) => l.trimEnd());
    const want = readFileSync(REF, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trimEnd());
    for (const rows of [got, want]) while (rows.length && rows[rows.length - 1] === '') rows.pop();
    if (process.env.DUMP_FRAME) writeFileSync(process.env.DUMP_FRAME, got.join('\n'));
    const accepted = want.map((l) => {
      for (const [from, to] of ACCEPTED) if (l.includes(from)) return l.replace(from, to);
      return l;
    });
    const diffs: string[] = [];
    for (let i = 0; i < Math.max(got.length, accepted.length); i++) {
      if ((got[i] ?? '') !== (accepted[i] ?? ''))
        diffs.push(`row ${i}\n  want ${accepted[i]}\n  got  ${got[i]}`);
    }
    expect(diffs.join('\n')).toBe('');
  }, 180_000);
});
