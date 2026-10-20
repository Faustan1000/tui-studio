// Every export adapter must pass the same checks. A new framework is "done" when this suite is
// green for it; framework-specific details are tested in tests/export.<framework>.test.ts.

import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '../src/types';
import { exportToFiles } from '../src/utils/export/codeExporter';
import { ADAPTERS } from '../src/utils/export/exporters';
import { mk, resetIds, screen } from './fixtures/build';
import { allComponents, layouts, multiScreen } from './fixtures/designs';
import { NASTY_STRINGS, nastyDesign } from './fixtures/nasty';
import { assertParses, pythonSyntaxError } from './helpers/syntax';

const text = (files: { content: string }[]) => files.map((f) => f.content).join('\n');

function parses(path: string, content: string) {
  if (/\.(tsx|jsx|ts|js|mjs|cjs)$/.test(path)) {
    const loader = path.endsWith('x')
      ? path.endsWith('.tsx')
        ? 'tsx'
        : 'jsx'
      : path.endsWith('ts')
        ? 'ts'
        : 'js';
    assertParses(content, loader, path);
  } else if (path.endsWith('.py')) {
    expect(pythonSyntaxError(content), path).toBeNull();
  } else if (path.endsWith('.json')) {
    expect(() => JSON.parse(content), path).not.toThrow();
  }
}

describe.each(ADAPTERS.map((a) => [a.id, a] as const))('adapter %s', (id, adapter) => {
  const run = (root: ComponentNode, screens?: { id: string; root: ComponentNode }[]) =>
    exportToFiles(root, id, screens);

  it('exports every component type', () => {
    const files = run(allComponents());
    expect(files.length).toBeGreaterThan(0);
    const out = text(files);
    expect(out).not.toContain('not implemented');
    for (const bad of ['undefined', '[object Object]', 'NaN']) expect(out, bad).not.toContain(bad);
    for (const label of [
      'Send',
      'Ready',
      'Sure?',
      'Cell 1',
      'Item 1',
      'Home',
      'Dashboard',
      'Column 1',
      'Documents',
    ]) {
      expect(out, label).toContain(label);
    }
  });

  it('produces files with unique, relative paths', () => {
    const paths = run(allComponents()).map((f) => f.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const p of paths) expect(p).toMatch(/^[\w.-]+(\/[\w.-]+)*$/);
  });

  it('is deterministic', () => {
    expect(run(allComponents())).toEqual(run(allComponents()));
  });

  it('survives text that breaks naive generators', () => {
    const files = run(nastyDesign());
    for (const f of files) parses(f.path, f.content);
    // The strings are data, not code: raw line breaks must never end up inside a string.
    expect(text(files)).toContain('ünïcödé');
  });

  it('exports an empty screen, deep nesting and unusual sizes', () => {
    expect(() => run(screen('Empty', undefined, []))).not.toThrow();
    resetIds();
    let deep = mk('Text', { props: { content: 'bottom' } });
    for (let i = 0; i < 25; i++) deep = mk('Box', {}, [deep]);
    const files = run(screen('Deep', undefined, [deep]));
    expect(text(files)).toContain('bottom');
    for (const f of files) parses(f.path, f.content);
    const sized = screen('Sized', undefined, [
      mk('Box', { props: { width: 0, height: -3 } }, [mk('Text', { props: { width: 9999 } })]),
      mk('Spacer', { props: { width: 'fill', height: 'fill' } }),
    ]);
    expect(() => run(sized)).not.toThrow();
  });

  it('leaves out hidden components', () => {
    resetIds();
    const tree = screen('S', undefined, [
      mk('Text', { props: { content: 'VISIBLE_TEXT' } }),
      mk('Text', { hidden: true, props: { content: 'SECRET_HIDDEN' } }),
      mk('Box', { hidden: true }, [mk('Text', { props: { content: 'SECRET_CHILD' } })]),
    ]);
    const out = text(run(tree));
    expect(out).toContain('VISIBLE_TEXT');
    // Textual keeps hidden components (display: none) so the program can show them later.
    if (id === 'textual') return;
    expect(out).not.toContain('SECRET_HIDDEN');
    expect(out).not.toContain('SECRET_CHILD');
  });

  it('exports every layout kind', () => {
    for (const [name, root] of Object.entries(layouts())) {
      const files = run(root);
      const out = text(files);
      expect(out, name).toContain('T0');
      for (const f of files) parses(f.path, f.content);
    }
  });

  it('parses everywhere it can', () => {
    for (const f of run(allComponents())) parses(f.path, f.content);
  });

  it('handles the screens of a project as declared', () => {
    const screens = multiScreen().map((root) => ({ id: root.id, root }));
    const out = text(run(screens[0].root, screens));
    expect(out).toContain('Ready');
    if (adapter.multiScreen) {
      expect(out).toContain('Settings screen');
    } else {
      // The first screen only; tab bodies that are not active are not part of the output.
      expect(out).not.toContain('Settings screen');
      expect(out).not.toContain('Agent content');
    }
  });

  it('declares how it is verified', () => {
    expect(['run', 'syntax', 'snapshot']).toContain(adapter.verification);
    expect(adapter.language.length).toBeGreaterThan(0);
  });
});

describe('format list', () => {
  it('has unique ids', () => {
    const ids = ADAPTERS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps the strings used by the nasty fixture distinct', () => {
    expect(new Set(NASTY_STRINGS).size).toBe(NASTY_STRINGS.length);
  });
});
