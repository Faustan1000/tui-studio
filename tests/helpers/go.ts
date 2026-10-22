// Run the Go toolchain on generated projects (tests are skipped when `go` is not on PATH).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

let goCmd: string | null | undefined;

/** The go executable on this machine (PATH, then scoop's shims), or null. */
export function findGo(): string | null {
  if (goCmd !== undefined) return goCmd;
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  for (const cmd of ['go', join(home, 'scoop', 'shims', 'go.exe')]) {
    if (spawnSync(cmd, ['version'], { encoding: 'utf8' }).status === 0) return (goCmd = cmd);
  }
  return (goCmd = null);
}

/** Write files into a fresh temp directory (never inside the repo) and return it. */
export function writeProject(
  files: { path: string; content: string }[],
  prefix = 'tuistudio-go-'
): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  for (const f of files) {
    const target = join(dir, f.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.content);
  }
  return dir;
}

export interface GoResult {
  ok: boolean;
  output: string;
}

/** `go <args>` in `cwd`; output is stdout + stderr. */
export function runGo(args: string[], cwd: string, timeoutMs = 600_000): GoResult {
  const r = spawnSync(findGo()!, args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, GOFLAGS: '-mod=mod', GOTOOLCHAIN: 'local' },
  });
  return { ok: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
