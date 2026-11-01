// Percentage sizes (20%) in the export: native where the framework has them, otherwise the
// cells of the design plus a warning.

import { describe, expect, it } from 'vitest';
import { exportToFiles, exportWarnings } from '../src/utils/export/codeExporter';
import { ADAPTERS } from '../src/utils/export/exporters';
import { buildIR } from '../src/utils/export/ir';
import { mk, resetIds, screen } from './fixtures/build';

const design = () => {
  resetIds();
  return screen('S', undefined, [
    mk('Menu', { id: 'bar', props: { width: '100%', items: ['A', 'B'] } }),
    mk('Button', { id: 'half', props: { label: 'Go', width: '50%' } }),
  ]);
};
const plain = () => {
  resetIds();
  return screen('S', undefined, [mk('Button', { props: { label: 'Go', width: 20 } })]);
};
const main = (format: string, root = design()) => exportToFiles(root, format)[0].content;

describe('percentage sizes in the export IR', () => {
  it('keeps the percentage and the cells the editor lays out for it', () => {
    const ir = buildIR(design());
    const find = (id: string) => ir.start.root.children.find((c) => c.id === id)!;
    const bar = find('bar');
    const half = find('half');
    expect(bar.widthPct).toBe(100);
    expect(half.widthPct).toBe(50);
    expect(half.heightPct).toBeUndefined();
    expect(half.width).toBe(half.box!.width);
    expect(half.width).toBeGreaterThan(1);
    expect(bar.width as number).toBeGreaterThan(half.width as number);
  });

  it('does not touch fixed sizes', () => {
    const ir = buildIR(plain());
    expect(ir.start.root.children[0].widthPct).toBeUndefined();
    expect(ir.start.root.children[0].width).toBe(20);
  });
});

describe('percentage sizes per framework', () => {
  it('Ink writes them as percentages', () => {
    const code = main('ink');
    expect(code).toContain('width="100%"');
    expect(code).toContain('width="50%"');
  });

  it('OpenTUI writes them as percentages', () => {
    const code = main('opentui');
    expect(code).toContain('width="100%"');
    expect(code).toContain('width="50%"');
  });

  it('Textual writes them as CSS percentages', () => {
    const code = main('textual');
    expect(code).toContain('width: 100%;');
    expect(code).toContain('width: 50%;');
  });

  it('every framework exports a design with percentages', () => {
    for (const a of ADAPTERS) {
      expect(() => exportToFiles(design(), a.id), a.id).not.toThrow();
      expect(main(a.id).length, a.id).toBeGreaterThan(100);
    }
  });

  it('only the frameworks without percentages warn about them', () => {
    for (const a of ADAPTERS) {
      const warnings = exportWarnings(design(), a.id);
      if (a.percentSizes === 'fixed') {
        expect(warnings, a.id).toHaveLength(1);
        expect(warnings[0], a.id).toContain(a.label);
      } else {
        expect(warnings, a.id).toEqual([]);
      }
      expect(exportWarnings(plain(), a.id), a.id).toEqual([]);
    }
    expect(
      ADAPTERS.filter((a) => a.percentSizes === 'native')
        .map((a) => a.id)
        .sort()
    ).toEqual(['ink', 'opentui', 'textual']);
  });
});
