// Runs a generated Blessed project against the real library without a terminal.

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ComponentNode } from '../../src/types';
import { exportToFiles } from '../../src/utils/export/codeExporter';

export const RUNTIME_DIR = resolve(__dirname, '..', 'runtime');
export const HAS_BLESSED = existsSync(join(RUNTIME_DIR, 'node_modules', 'blessed', 'package.json'));
export const SKIP_REASON = 'tests/runtime/node_modules is missing: run `npm run test:setup`';

/** Write the generated project to tests/runtime/.generated/blessed/<name>/ and load it. */
export function loadProject(
  root: ComponentNode,
  name: string
): { dir: string; mod: any; files: Record<string, string> } {
  const dir = join(RUNTIME_DIR, '.generated', 'blessed', name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const files: Record<string, string> = {};
  for (const f of exportToFiles(root, 'blessed')) {
    mkdirSync(dirname(join(dir, f.path)), { recursive: true });
    writeFileSync(join(dir, f.path), f.content, 'utf8');
    files[f.path] = f.content;
  }
  const req = createRequire(join(dir, 'index.js'));
  return { dir, mod: req(join(dir, 'index.js')), files };
}

export interface Term {
  input: PassThrough;
  output: PassThrough;
  options: Record<string, unknown>;
  /** Send keys as the terminal would. */
  type(keys: string): Promise<void>;
}

export function makeTerm(cols = 80, rows = 24): Term {
  const input: any = new PassThrough();
  const output: any = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  output.isTTY = true;
  output.columns = cols;
  output.rows = rows;
  output.on('data', () => undefined);
  return {
    input,
    output,
    options: { input, output, terminal: 'xterm', smartCSR: false },
    type: async (keys: string) => {
      input.write(keys);
      await tick(30);
    },
  };
}

export const tick = (ms = 20) => new Promise<void>((r) => setTimeout(r, ms));

/** The characters of the blessed screen buffer, one string per row. */
export function frame(screen: any): string {
  return screen.lines
    .map((line: any[]) =>
      line
        .map((c) => c[1])
        .join('')
        .trimEnd()
    )
    .join('\n');
}

/** A left click at a 0-based cell, as an xterm SGR mouse report (what blessed enables). */
export async function click(term: Term, x: number, y: number): Promise<void> {
  const esc = String.fromCharCode(27);
  term.input.write(`${esc}[<0;${x + 1};${y + 1}M`);
  await tick(15);
  term.input.write(`${esc}[<0;${x + 1};${y + 1}m`);
  await tick(40);
}

/** Change the size of the fake terminal and tell blessed. */
export async function resize(term: Term, cols: number, rows: number): Promise<void> {
  const out = term.output as unknown as { columns: number; rows: number };
  out.columns = cols;
  out.rows = rows;
  term.output.emit('resize');
  await tick(60);
}

/** One notch of the mouse wheel at a 0-based cell (xterm SGR report). */
export async function wheel(term: Term, x: number, y: number, down: boolean): Promise<void> {
  const esc = String.fromCharCode(27);
  term.input.write(`${esc}[<${down ? 65 : 64};${x + 1};${y + 1}M`);
  await tick(25);
}
