// Visual parity: the demo design rendered by the generated Ratatui program on the TestBackend
// at 100x40 must match Textual's frame (docs/VISUAL_SPEC.md). Skipped without cargo.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ratatuiAdapter } from '../src/utils/export/exporters/ratatui';
import { buildIR } from '../src/utils/export/ir';
import { apiDesign } from './fixtures/apiDesign';

const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
const sep = process.platform === 'win32' ? ';' : ':';
const env = {
  ...process.env,
  PATH: `${process.env.PATH ?? process.env.Path ?? ''}${sep}${[join(home, '.cargo', 'bin'), join(home, 'scoop', 'shims')].join(sep)}`,
  CARGO_TARGET_DIR: join(tmpdir(), 'tuistudio-cargo-target'),
  CARGO_TERM_COLOR: 'never',
};
const hasCargo =
  spawnSync('cargo', ['--version'], { env, encoding: 'utf8', shell: true }).status === 0;

const norm = (s: string) =>
  s
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(!hasCargo)('Ratatui visual parity with Textual', () => {
  it('renders the demo design at 100x40 like the reference', () => {
    const root = apiDesign();
    const dir = mkdtempSync(join(tmpdir(), 'tuistudio-ratatui-vis-'));
    dirs.push(dir);
    for (const f of ratatuiAdapter.generate({
      ir: buildIR(root),
      source: [{ id: root.id, root }],
    })) {
      const path = join(dir, f.path);
      mkdirSync(dirname(path), { recursive: true });
      let content = f.content;
      if (f.path === 'src/main.rs') content += '\n#[cfg(test)]\nmod visual_test;\n';
      writeFileSync(path, content, 'utf8');
    }
    writeFileSync(
      join(dir, 'src', 'visual_test.rs'),
      readFileSync(resolve(__dirname, 'apitests', 'ratatui', 'visual_test.rs'), 'utf8'),
      'utf8'
    );
    const out = join(dir, 'frame.txt');
    const r = spawnSync('cargo', ['test', '--quiet', 'dump_frame_100x40'], {
      cwd: dir,
      env: { ...env, TUISTUDIO_FRAME_OUT: out },
      encoding: 'utf8',
      timeout: 540_000,
      shell: true,
    });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const actual = norm(readFileSync(out, 'utf8'));
    const reference = norm(
      readFileSync(resolve(__dirname, 'visual', 'reference.apiDesign.100x40.txt'), 'utf8')
    );
    // Documented differences (docs/VISUAL_SPEC.md): Textual draws the check mark of a checkbox in
    // both states (dimmed when off), the spec says `[ ] label` for an unchecked one, which is
    // what the design has (checked: false) and what Ratatui draws.
    const accepted: [string, string][] = [['[✓] I agree', '[ ] I agree']];
    let expected = reference;
    for (const [textual, ours] of accepted) {
      expect(expected).toContain(textual);
      expected = expected.replace(textual, ours);
    }
    expect(actual).toBe(expected);
  }, 540_000);
});
