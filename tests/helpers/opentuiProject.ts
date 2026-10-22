// Writes a generated OpenTUI project below tests/runtime/.generated so that its imports resolve
// against tests/runtime/node_modules (the real @opentui/core and @opentui/react).

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ComponentNode } from '../../src/types';
import { exportToFiles } from '../../src/utils/export/codeExporter';

export const RUNTIME_DIR = resolve(__dirname, '..', 'runtime');
export const GENERATED_DIR = join(RUNTIME_DIR, '.generated', 'opentui');

/** The bun executable, or null (looks on PATH and in the scoop shims). */
export function findBun(): string | null {
  const candidates = [
    'bun',
    join(process.env.USERPROFILE ?? '', 'scoop', 'shims', 'bun.exe'),
    'bun.exe',
  ];
  for (const c of candidates) {
    const r = spawnSync(c, ['--version'], { encoding: 'utf8' });
    if (r.status === 0) return c;
  }
  return null;
}

export function hasRuntimeModules(): boolean {
  return existsSync(join(RUNTIME_DIR, 'node_modules', '@opentui', 'react'));
}

/** Generate `root` as the OpenTUI project `name` and return its directory. */
export function writeProject(name: string, root: ComponentNode): string {
  const dir = join(GENERATED_DIR, name);
  rmSync(dir, { recursive: true, force: true });
  for (const f of exportToFiles(root, 'opentui')) {
    const target = join(dir, f.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.content, 'utf8');
  }
  return dir;
}

/** Type-check a generated project with the tsc of tests/runtime. Returns the compiler output or null. */
export function typecheck(dir: string): string | null {
  // @types/react comes from the editor's own node_modules (tests/runtime has only the runtime).
  const rootTypes = join(__dirname, '..', '..', 'node_modules', '@types');
  writeFileSync(
    join(dir, 'tsconfig.check.json'),
    JSON.stringify({
      extends: './tsconfig.json',
      compilerOptions: {
        typeRoots: [rootTypes],
        types: ['node'],
        paths: { react: [join(rootTypes, 'react')] },
      },
    })
  );
  const tsc = join(RUNTIME_DIR, 'node_modules', 'typescript', 'bin', 'tsc');
  const r = spawnSync(process.execPath, [tsc, '-p', join(dir, 'tsconfig.check.json')], {
    encoding: 'utf8',
  });
  return r.status === 0 ? null : (r.stdout + r.stderr).trim();
}
