// Code generation for the supported TUI frameworks.
//
// The design is resolved once into the export IR (ir.ts) and handed to the adapter of the
// chosen framework (exporters/). This file only dispatches.

import type { ComponentNode } from '../../types';
import { getAdapter, ADAPTERS } from './exporters';
import type { ExportFile } from './adapter';
import { buildIR, type ScreenInput } from './ir';
import { apiReference } from './api/reference';

export type { ExportFile } from './adapter';
export type ExportScreen = ScreenInput;

/** Formats `exportToFiles` knows (UI ids). */
export const CODE_FORMATS = ADAPTERS.map((a) => ({
  id: a.id,
  label: a.label,
  language: a.language,
}));

/**
 * Export a design as the files a project needs: the generated UI plus whatever the framework
 * requires next to it (runtime module, package manifest, ...). `screens` is the whole project;
 * frameworks without multi-screen support export its first screen.
 */
export function exportToFiles(
  root: ComponentNode | null,
  format: string,
  screens?: readonly ExportScreen[]
): ExportFile[] {
  if (!root) return [];
  const adapter = getAdapter(format);
  if (!adapter)
    return [{ path: 'export.txt', content: `// Unsupported export format: ${format}\n` }];

  const source: ScreenInput[] = screens?.length ? [...screens] : [{ id: root.id, root }];
  const used = adapter.multiScreen ? source : source.slice(0, 1);
  const ir = buildIR(used);
  const files = adapter.generate({ ir, source: used });
  const api = apiReference(ir, adapter.id);
  return api ? [...files, { path: 'API.md', content: api }] : files;
}

/** The main file of an export as one string. */
export function exportToCode(
  root: ComponentNode | null,
  format: string,
  screens?: readonly ExportScreen[]
): string {
  return exportToFiles(root, format, screens)[0]?.content ?? '';
}
