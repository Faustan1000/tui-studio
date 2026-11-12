// The generated programs on a real tty: every framework runs the terminal scenario of
// tests/pty/scenario.py in a pseudo-terminal (start, mouse clicks, resize, quit and terminal
// restored). The headless tests cannot show these; see docs/TERMINAL_TESTS.md.
//
// Linux/macOS: runs when python (with pyte) and the framework's toolchain are installed.
// Windows: only with TUISTUDIO_PTY=1 and pywinpty installed (a local try-out; CI uses Linux).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportToFiles } from '../src/utils/export/codeExporter';
import { screenLinks } from './fixtures/designs';

const RUNTIME = resolve(__dirname, 'runtime');
const NODE_MODULES = join(RUNTIME, 'node_modules');
const OUT = join(RUNTIME, '.generated', 'pty');
const SCENARIO = join(__dirname, 'pty', 'scenario.py');
const IS_WINDOWS = process.platform === 'win32';
const enabled = !IS_WINDOWS || process.env.TUISTUDIO_PTY === '1';

const run = (cmd: string, args: string[], cwd: string, timeout = 240_000) =>
  spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout, shell: false });
const has = (cmd: string, args = ['--version']) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return !r.error && r.status === 0;
};

const PYTHON =
  process.env.TUISTUDIO_PYTHON ??
  ['python3', 'python'].find((p) => has(p) && has(p, ['-c', 'import pyte'])) ??
  '';
const ready = enabled && PYTHON !== '';
if (!ready) {
  console.warn(
    'pty tests skipped (need python with pyte; on Windows TUISTUDIO_PTY=1 and pywinpty)'
  );
}

interface Target {
  name: string;
  /** Whether its toolchain is installed. */
  available: boolean;
  /** Writes nothing, builds if needed and returns the command that starts the program. */
  prepare(dir: string): string[];
  quit?: string;
}

const screens = () => screenLinks().map((root) => ({ id: root.tag!, root }));

function generate(name: string): string {
  const all = screens();
  const dir = join(OUT, name);
  rmSync(dir, { recursive: true, force: true });
  for (const f of exportToFiles(all[0].root, name, all)) {
    const target = join(dir, f.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.content, 'utf8');
  }
  return dir;
}

function must(r: ReturnType<typeof run>, what: string) {
  expect(r.status, `${what}\n${r.stdout}\n${r.stderr}`).toBe(0);
}

const exe = (name: string) => (IS_WINDOWS ? `${name}.exe` : name);

const targets: Target[] = [
  {
    name: 'ink',
    available: existsSync(join(NODE_MODULES, 'tsx')) && existsSync(join(NODE_MODULES, 'ink')),
    prepare: () => [process.execPath, join(NODE_MODULES, 'tsx', 'dist', 'cli.mjs'), 'src/app.tsx'],
    quit: 'q,ctrl+c',
  },
  {
    name: 'opentui',
    available: has('bun') && existsSync(join(NODE_MODULES, '@opentui', 'react')),
    prepare: () => ['bun', 'src/index.tsx'],
  },
  {
    name: 'blessed',
    available: existsSync(join(NODE_MODULES, 'blessed')),
    prepare: () => [process.execPath, 'index.js'],
  },
  {
    name: 'bubbletea',
    available: has('go', ['version']),
    prepare: (dir) => {
      must(run('go', ['mod', 'tidy'], dir), 'go mod tidy');
      must(run('go', ['build', '-o', exe('app'), '.'], dir), 'go build');
      return [join(dir, exe('app'))];
    },
  },
  {
    name: 'tview',
    available: has('go', ['version']),
    prepare: (dir) => {
      must(run('go', ['mod', 'tidy'], dir), 'go mod tidy');
      must(run('go', ['build', '-o', exe('app'), '.'], dir), 'go build');
      return [join(dir, exe('app'))];
    },
  },
  {
    name: 'ratatui',
    available: has('cargo'),
    prepare: (dir) => {
      must(run('cargo', ['build', '--quiet'], dir, 540_000), 'cargo build');
      const manifest = readFileSync(join(dir, 'Cargo.toml'), 'utf8');
      const bin = /^name\s*=\s*"([^"]+)"/m.exec(manifest)![1];
      return [join(dir, 'target', 'debug', exe(bin))];
    },
  },
  {
    name: 'textual',
    available: PYTHON !== '' && has(PYTHON, ['-c', 'import textual']),
    prepare: () => [PYTHON, 'ui.py'],
    quit: 'ctrl+q',
  },
];

describe.skipIf(!ready)('generated programs on a real tty', () => {
  for (const t of targets) {
    it.skipIf(!t.available)(
      `${t.name}: start, mouse, resize, quit`,
      () => {
        const dir = generate(t.name);
        const argv = t.prepare(dir);
        const args = [SCENARIO, '--name', t.name, '--cwd', dir, '--quit', t.quit ?? 'ctrl+c,q'];
        for (const a of argv) args.push('--cmd', a);
        const r = run(PYTHON, args, __dirname, 300_000);
        const steps = (r.stdout ?? '')
          .split('\n')
          .filter((l) => l.startsWith('{'))
          .map((l) => JSON.parse(l) as { step: string; ok: boolean; info: string });
        const failed = steps.filter((s) => !s.ok).map((s) => `${s.step}: ${s.info}`);
        expect(failed, `${r.stderr}\n${r.stdout}`).toEqual([]);
        expect(steps.map((s) => s.step)).toEqual(
          expect.arrayContaining(['start', 'mouse: menu item opens a screen', 'quit'])
        );
      },
      600_000
    );
  }
});
