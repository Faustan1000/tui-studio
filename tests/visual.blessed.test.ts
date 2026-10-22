// Visual parity of the Blessed export with the Textual reference (docs/VISUAL_SPEC.md): the demo
// design is rendered at 100x40 in real blessed (headless) and diffed cell by cell with
// tests/visual/reference.apiDesign.100x40.txt.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { apiDesign } from './fixtures/apiDesign';
import {
  HAS_BLESSED,
  SKIP_REASON,
  frame,
  loadProject,
  makeTerm,
  tick,
} from './helpers/blessedHeadless';

const REF = resolve(__dirname, 'visual', 'reference.apiDesign.100x40.txt');
const lines = (text: string) => text.split(/\r?\n/).map((l) => l.trimEnd());

/** Rows of the blessed frame that are not part of the comparison (see ACCEPTED below). */
function normalise(got: string[], want: string[]): void {
  // Accepted difference 2: the demo checkbox is unchecked, Textual always draws the check mark
  // of its glyph (`[✓]`) and only colours it differently; blessed draws `[ ]`.
  for (let i = 0; i < want.length; i++) want[i] = want[i].replace('[✓] I agree', '[ ] I agree');
  // Accepted difference 3: the rule under the tabs may use any of these glyphs.
  const rule = /[─━▔╸╺]/g;
  for (const rows of [got, want]) {
    const i = rows.findIndex((l) => /^│ [╸─━▔]/.test(l));
    if (i >= 0) rows[i] = rows[i].replace(rule, '━');
  }
}

describe.skipIf(!HAS_BLESSED)(
  `blessed visual parity with Textual${HAS_BLESSED ? '' : ` (SKIPPED: ${SKIP_REASON})`}`,
  () => {
    let ui: any;
    afterAll(() => ui?.stop());

    it('renders the demo design at 100x40 like the reference', async () => {
      const mod = loadProject(apiDesign(), 'visual').mod;
      const term = makeTerm(100, 40);
      ui = new mod.Ui(term.options);
      await ui.start();
      await tick(100);
      const got = lines(frame(ui.screen));
      const want = lines(readFileSync(REF, 'utf8'));
      while (want.length && want[want.length - 1] === '') want.pop();
      // The reference keeps its blank rows at the bottom: pad the blessed frame the same way.
      normalise(got, want);
      while (got.length < want.length) got.push('');
      if (process.env.DUMP_FRAME) writeFileSync(process.env.DUMP_FRAME, got.join('\n'));
      const diffs: string[] = [];
      for (let i = 0; i < Math.max(got.length, want.length); i++) {
        if ((got[i] ?? '') !== (want[i] ?? '')) {
          diffs.push(`row ${i}\n  want ${want[i]}\n  got  ${got[i]}`);
        }
      }
      expect(diffs.join('\n')).toBe('');
    });
  }
);
