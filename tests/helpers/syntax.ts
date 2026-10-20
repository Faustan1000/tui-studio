// Syntax checks for generated code. They parse only; they never run the generated program.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transformSync } from 'esbuild';

/** Throws with the parser message if `code` is not valid. `loader`: js, jsx, ts or tsx. */
export function assertParses(code: string, loader: 'js' | 'jsx' | 'ts' | 'tsx', label = 'code') {
  try {
    transformSync(code, { loader, logLevel: 'silent' });
  } catch (e) {
    const err = e as { errors?: { text: string; location?: { line: number } }[] };
    const first = err.errors?.[0];
    throw new Error(`${label} does not parse: ${first?.text} (line ${first?.location?.line})`);
  }
}

let pythonCmd: string | null | undefined;

/** The python executable on this machine, or null. */
export function findPython(): string | null {
  if (pythonCmd !== undefined) return pythonCmd;
  for (const cmd of ['python', 'python3']) {
    const r = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
    if (r.status === 0) return (pythonCmd = cmd);
  }
  return (pythonCmd = null);
}

/** Compile Python source without running it. Returns an error text or null. */
export function pythonSyntaxError(code: string): string | null {
  const python = findPython();
  if (!python) return null;
  const dir = mkdtempSync(join(tmpdir(), 'tuistudio-py-'));
  try {
    const file = join(dir, 'check.py');
    writeFileSync(file, code, 'utf8');
    const r = spawnSync(
      python,
      [
        '-I',
        '-c',
        'import sys;compile(open(sys.argv[1],encoding="utf8").read(),sys.argv[1],"exec")',
        file,
      ],
      {
        encoding: 'utf8',
      }
    );
    return r.status === 0 ? null : r.stderr.trim().split('\n').slice(-3).join(' | ');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
