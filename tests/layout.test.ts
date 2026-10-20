// The editor's layout engine: the positions every exporter reproduces.

import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '../src/types';
import { LayoutEngine } from '../src/utils/layout/engine';
import { mk, resetIds, screen } from './fixtures/build';
import { layouts } from './fixtures/designs';

function compute(root: ComponentNode, w = 80, h = 24) {
  const engine = new LayoutEngine();
  engine.calculateLayout(root, w, h, false);
  return (id: string) => {
    const l = engine.getLayout(id);
    if (!l) return undefined;
    return { x: l.x, y: l.y, w: l.width, h: l.height };
  };
}

const text = (id: string, w: number | 'fill' | 'auto' = 6, h: number | 'fill' | 'auto' = 1) =>
  mk('Text', { id, props: { content: id, width: w, height: h } });

/** A fixed 40x8 box without padding or border inside a plain screen. */
function boxed(layout: Record<string, unknown>, children: ComponentNode[], props = {}) {
  resetIds();
  return screen('S', undefined, [
    mk(
      'Box',
      {
        id: 'box',
        props: { width: 40, height: 8, ...props },
        layout: { padding: 0, gap: 0, ...layout },
        style: { border: false },
      },
      children
    ),
  ]);
}

describe('flex rows and columns', () => {
  it('lays a row out left to right with the gap between items', () => {
    const at = compute(layouts().row);
    const [a, b, c] = ['t0', 't1', 't2'].map((id) => at(id)!);
    expect(b.x - a.x).toBe(a.w + 2);
    expect(c.x - b.x).toBe(b.w + 2);
    expect([a.y, b.y, c.y]).toEqual([a.y, a.y, a.y]);
  });

  it('lays a column out top to bottom with the gap between items', () => {
    const at = compute(layouts().column);
    const [a, b, c] = ['t0', 't1', 't2'].map((id) => at(id)!);
    expect(b.y - a.y).toBe(a.h + 1);
    expect(c.y - b.y).toBe(b.h + 1);
    expect(a.x).toBe(b.x);
  });

  it('puts padding between the container edge and its children', () => {
    const at = compute(boxed({ type: 'flexbox', direction: 'row', padding: 3 }, [text('a')]));
    expect(at('a')!.x - at('box')!.x).toBe(3);
    expect(at('a')!.y - at('box')!.y).toBe(3);
  });

  it('shares the free space between "fill" children', () => {
    const at = compute(
      boxed({ type: 'flexbox', direction: 'row' }, [
        text('a', 10),
        text('b', 'fill'),
        text('c', 'fill'),
      ])
    );
    expect(at('a')!.w).toBe(10);
    expect(at('b')!.w).toBe(15);
    expect(at('c')!.w).toBe(15);
    expect(at('c')!.x).toBe(at('box')!.x + 25);
  });

  it('stays inside the container for fixed sizes', () => {
    const at = compute(layouts().row);
    const box = at('box')!;
    for (const id of ['t0', 't1', 't2']) {
      const c = at(id)!;
      expect(c.x).toBeGreaterThanOrEqual(box.x);
      expect(c.x + c.w).toBeLessThanOrEqual(box.x + box.w);
    }
  });
});

describe('justify', () => {
  const row = (justify: string) =>
    compute(boxed({ type: 'flexbox', direction: 'row', justify }, [text('a'), text('b')]));

  it('start', () => {
    const at = row('start');
    expect(at('a')!.x).toBe(at('box')!.x);
    expect(at('b')!.x).toBe(at('box')!.x + 6);
  });

  it('end', () => {
    const at = row('end');
    expect(at('b')!.x + at('b')!.w).toBe(at('box')!.x + 40);
  });

  it('center', () => {
    const at = row('center');
    // 40 - 12 = 28 free cells, 14 on each side
    expect(at('a')!.x).toBe(at('box')!.x + 14);
  });

  it('space-between puts the first at the start and the last at the end', () => {
    const at = row('space-between');
    expect(at('a')!.x).toBe(at('box')!.x);
    expect(at('b')!.x + 6).toBe(at('box')!.x + 40);
  });

  it('space-around leaves equal space around every item', () => {
    const at = row('space-around');
    // 28 free cells / 2 items = 14 per item, 7 on each side
    expect(at('a')!.x - at('box')!.x).toBe(7);
    expect(at('b')!.x - (at('a')!.x + 6)).toBe(14);
  });
});

describe('align', () => {
  const row = (align: string) =>
    compute(
      boxed({ type: 'flexbox', direction: 'row', align }, [text('a', 6, 2), text('b', 6, 4)])
    );

  it('aligns within the container, not just the tallest child', () => {
    const start = row('start');
    expect(start('a')!.y).toBe(start('box')!.y);
    const end = row('end');
    expect(end('a')!.y + end('a')!.h).toBe(end('box')!.y + 8);
    expect(end('b')!.y + end('b')!.h).toBe(end('box')!.y + 8);
  });

  it('centers children of different heights on the same axis', () => {
    const at = row('center');
    const mid = (id: string) => at(id)!.y + at(id)!.h / 2;
    expect(mid('a')).toBe(mid('b'));
    expect(mid('a')).toBe(at('box')!.y + 4);
  });
});

describe('wrap', () => {
  it('starts a new line when the next item does not fit', () => {
    const at = compute(layouts().wrapped);
    // 40 wide, items 8 + 1 gap: four per line
    const ys = ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7'].map((id) => at(id)!.y);
    expect(new Set(ys.slice(0, 4)).size).toBe(1);
    expect(new Set(ys.slice(4)).size).toBe(1);
    expect(ys[4]).toBeGreaterThan(ys[0]);
    expect(at('t4')!.x).toBe(at('t0')!.x);
  });

  it('does not wrap when wrap is off', () => {
    const items = Array.from({ length: 8 }, (_, i) => text(`t${i}`, 8));
    const at = compute(boxed({ type: 'flexbox', direction: 'row', gap: 1 }, items));
    const ys = items.map((i) => at(i.id)!.y);
    expect(new Set(ys).size).toBe(1);
  });
});

describe('grid', () => {
  it('places children row by row in equal cells', () => {
    const at = compute(layouts().grid);
    const [a, b, c, d] = ['t0', 't1', 't2', 't3'].map((id) => at(id)!);
    expect(a.y).toBe(b.y);
    expect(c.y).toBe(d.y);
    expect(c.y).toBeGreaterThan(a.y);
    expect(a.x).toBe(c.x);
    expect(b.x).toBeGreaterThan(a.x);
  });
});

describe('absolute', () => {
  it('uses the x/y of every child relative to the container content', () => {
    const at = compute(layouts().absolute);
    const box = at('box')!;
    // fixture: t0 at (3, 2), t1 at (13, 3); the box has padding 1
    expect(at('t0')!.x - box.x).toBe(3 + 1);
    expect(at('t0')!.y - box.y).toBe(2 + 1);
    expect(at('t1')!.x - at('t0')!.x).toBe(10);
    expect(at('t1')!.y - at('t0')!.y).toBe(1);
  });
});

describe('visibility', () => {
  it('does not lay out components of inactive tab bodies', () => {
    resetIds();
    const tree = screen('S', undefined, [
      mk('Tabs', { id: 'tabs' }),
      mk('Box', { id: 'b0', showWhen: { nav: 'tabs', item: 0 } }, [text('in0')]),
      mk('Box', { id: 'b1', showWhen: { nav: 'tabs', item: 1 } }, [text('in1')]),
    ]);
    const at = compute(tree);
    expect(at('b0')).toBeDefined();
    expect(at('in0')).toBeDefined();
    expect(at('b1')).toBeUndefined();
  });

  it('is deterministic and does not depend on a previous run', () => {
    const tree = layouts().row;
    const first = compute(tree)('t2');
    const again = compute(tree)('t2');
    expect(again).toEqual(first);
  });
});
