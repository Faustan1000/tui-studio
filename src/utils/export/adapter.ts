// What a framework exporter looks like. Every exporter is an `ExportAdapter` that is registered
// in `exporters/index.ts`; `codeExporter.ts` only dispatches to the registry.
//
// The shared work is done before an adapter runs (see ir.ts): defaults, colours, glyphs and the
// editor's layout are already resolved. An adapter decides how each kind of node is written in
// its framework and which project files (entry point, manifest, ...) it needs.

import type { ComponentNode } from '../../types';
import type { IRProject, ScreenInput } from './ir';

export interface ExportFile {
  path: string;
  content: string;
}

export interface AdapterInput {
  /** Resolved design (all screens; `ir.start` is the first one). */
  ir: IRProject;
  /** The unresolved screens, for adapters that still work on the editor's tree (Textual). */
  source: ScreenInput[];
}

/**
 * - run: the generated program is started against the real framework in tests
 * - syntax: the generated code is parsed/compiled in tests, but not run
 * - snapshot: only compared with stored expectations (no toolchain available)
 */
export type Verification = 'run' | 'syntax' | 'snapshot';

export interface ExportAdapter {
  /** Key used by the UI and `exportToFiles` (e.g. `ink`). */
  id: string;
  label: string;
  /** File extension of the main file without the dot (`tsx`, `go`, ...). */
  language: string;
  verification: Verification;
  /** Whether every screen of a project is exported (otherwise only the first). */
  multiScreen: boolean;
  generate(input: AdapterInput): ExportFile[];
}

export type { ComponentNode };
