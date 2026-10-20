import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '../src/types';
import { buildIR, walkIR } from '../src/utils/export/ir';
import type { IRNode } from '../src/utils/export/ir';
import {
  BLESSED_VERSION,
  blessedAdapter,
  blessedPlacement,
} from '../src/utils/export/exporters/blessed';
import { mk, resetIds, screen } from './fixtures/build';
import { allComponents, layouts } from './fixtures/designs';
import { NASTY_STRINGS, nastyDesign } from './fixtures/nasty';
import { assertParses } from './helpers/syntax';

function generate(root: ComponentNode) {
  const ir = buildIR(root);
  const files = blessedAdapter.generate({ ir, source: [{ id: root.id, root }] });
  const get = (p: string) => files.find((f) => f.path === p)!.content;
  return { ir, files, index: get('index.js'), pkg: get('package.json') };
}

// ── A recording stand-in for the blessed module ──────────────────────────────

interface Rec {
  kind: string;
  opts: Record<string, any>;
  parent: Rec | null;
  events: string[];
  keys: string[];
}

interface Run {
  created: Rec[];
  screenRec: Rec;
  intervals: number;
}

/** Runs the generated program against a fake `blessed` that only records constructor calls. */
function run(code: string): Run {
  const created: Rec[] = [];
  let intervals = 0;
  const wrap = (rec: Rec): Rec => {
    const noop = () => proxy;
    const proxy: Rec = new Proxy(rec, {
      get(t, p) {
        if (p in t) return (t as unknown as Record<string | symbol, unknown>)[p];
        if (p === 'on') return (ev: string) => (t.events.push(ev), proxy);
        if (p === 'key') return (k: string[]) => (t.keys.push(...k), proxy);
        if (p === 'getValue') return () => String(t.opts.value ?? '');
        if (p === 'width') return t.opts.width;
        if (p === 'style') return t.opts.style ?? {};
        if (p === 'visible') return true;
        return noop;
      },
    });
    return proxy;
  };
  const make =
    (kind: string) =>
    (opts: Record<string, any> = {}) => {
      const rec = wrap({ kind, opts, parent: (opts.parent as Rec) ?? null, events: [], keys: [] });
      created.push(rec);
      return rec;
    };
  const fake = new Proxy({}, { get: (_t, kind: string) => make(kind) });
  const proc = { exit() {}, on() {} };
  const fn = new Function('require', 'process', 'setInterval', 'setImmediate', code);
  fn(
    (name: string) => {
      if (name !== 'blessed') throw new Error(`unexpected require ${name}`);
      return fake;
    },
    proc,
    () => {
      intervals++;
      return 0;
    },
    () => 0
  );
  const screenRec = created.find((c) => c.kind === 'screen')!;
  // The fake screen has no parent: children name it through `parent: screen`.
  return { created: created.filter((c) => c !== screenRec), screenRec, intervals };
}

/** Absolute position blessed gives a widget when autoPadding is off: parent's outer origin + left/top. */
function absRect(
  rec: Rec,
  screenRec: Rec
): { x: number; y: number; width: number; height: number } {
  let x = 0;
  let y = 0;
  for (let r: Rec | null = rec; r && r !== screenRec; r = r.parent) {
    x += Number(r.opts.left ?? 0);
    y += Number(r.opts.top ?? 0);
  }
  return { x, y, width: rec.opts.width, height: rec.opts.height };
}

const key = (r: { x: number; y: number; width: number; height: number }) =>
  `${r.x},${r.y},${r.width},${r.height}`;

/** The root fills the design size; every other widget sits at the box the editor computed. */
function expectedBoxes(root: IRNode, size: { width: number; height: number }): string[] {
  return walkIR(root)
    .filter((n) => n.visible && n.type !== 'Spacer' && n.box)
    .map((n) =>
      n === root
        ? key({ x: 0, y: 0, ...size })
        : key({ ...n.box!, width: Math.max(1, n.box!.width), height: Math.max(1, n.box!.height) })
    );
}

function expectPlacementMatchesEditor(root: ComponentNode) {
  const { ir, index } = generate(root);
  assertParses(index, 'js', 'index.js');
  const r = run(index);
  expect(r.screenRec.opts.autoPadding).toBe(false);
  const actual = r.created
    .filter((c) => !(c.kind === 'list' && c.opts.hidden)) // dropdown popups are placed when opened
    .map((c) => key(absRect(c, r.screenRec)));
  const remaining = [...actual];
  for (const want of expectedBoxes(ir.start.root, ir.start)) {
    const i = remaining.indexOf(want);
    expect(i, `no widget at ${want}`).toBeGreaterThanOrEqual(0);
    remaining.splice(i, 1);
  }
  // Only radio groups add widgets of their own.
  const groups = r.created.filter((c) => c.kind === 'radioset').length;
  expect(remaining.length).toBe(groups);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('blessed adapter', () => {
  it('declares itself', () => {
    expect(blessedAdapter).toMatchObject({
      id: 'blessed',
      language: 'js',
      verification: 'syntax',
      multiScreen: false,
    });
  });

  it('writes index.js and a pinned package.json', () => {
    const { files, pkg, index } = generate(allComponents());
    expect(files.map((f) => f.path)).toEqual(['index.js', 'package.json']);
    const json = JSON.parse(pkg);
    expect(json.dependencies.blessed).toBe(BLESSED_VERSION);
    expect(json.dependencies.blessed).toMatch(/^\d+\.\d+\.\d+$/);
    expect(json.scripts.start).toBe('node index.js');
    expect(json.name).toMatch(/^[a-z0-9-]+$/);
    expect(index).toContain("require('blessed')");
    expect(index).toMatch(/npm install && npm start/);
    expect(index).toMatch(/SNAPSHOT/);
    assertParses(index, 'js', 'index.js');
  });

  it('uses the real widget for every component type', () => {
    const { index } = generate(allComponents());
    const r = run(index);
    const kinds = r.created.map((c) => c.kind);
    for (const k of [
      'box',
      'textbox',
      'button',
      'checkbox',
      'radioset',
      'radiobutton',
      'list',
      'listtable',
      'progressbar',
      'listbar',
    ]) {
      expect(kinds, k).toContain(k);
    }
    const input = r.created.find((c) => c.kind === 'textbox')!;
    expect(input.opts.inputOnFocus).toBe(true);
    expect(r.created.filter((c) => c.kind === 'radiobutton')).toHaveLength(2);
    // Select: a closed box plus a hidden popup list; List, Menu and Tree are lists.
    expect(r.created.filter((c) => c.kind === 'list' && c.opts.hidden)).toHaveLength(1);
    expect(r.created.filter((c) => c.kind === 'list' && !c.opts.hidden)).toHaveLength(3);
    expect(r.intervals).toBe(1); // the spinner
    const table = r.created.find((c) => c.kind === 'listtable')!;
    expect(table.opts.rows[0]).toEqual(expect.arrayContaining(['Column 1']));
    const modal = r.created.find((c) => c.opts.label === ' Sure? ')!;
    expect(modal.opts.border).toMatchObject({ type: 'line' });
  });

  it('never lets blessed parse user text as tags', () => {
    const r = run(generate(nastyDesign()).index);
    expect(r.created.length).toBeGreaterThan(10);
    for (const c of r.created) expect(c.opts.tags, c.kind).toBe(false);
  });

  it('escapes text so it arrives unchanged', () => {
    const { index } = generate(nastyDesign());
    assertParses(index, 'js', 'index.js');
    const r = run(index);
    const seen = new Set<string>();
    const collect = (v: unknown) => {
      if (typeof v === 'string') seen.add(v);
      else if (Array.isArray(v)) v.forEach(collect);
    };
    for (const c of r.created) {
      collect(c.opts.content);
      collect(c.opts.items);
      collect(c.opts.rows);
      collect(c.opts.value);
      collect(c.opts.text);
    }
    for (const s of [
      "it's",
      'back\\slash',
      '<angle> & ampersand',
      '${dollar} `tick`',
      '%s %d {} {0}',
    ]) {
      expect(
        [...seen].some((x) => x.includes(s)),
        s
      ).toBe(true);
    }
    expect(NASTY_STRINGS.length).toBeGreaterThan(0);
    // The line break of 'new\nline' is escaped inside the literal, never raw.
    expect(index).toContain('new\\nline');
    expect(index).not.toContain('new\nline');
  });

  it('keeps line and paragraph separators out of string literals', () => {
    resetIds();
    const tree = screen('S', undefined, [mk('Text', { props: { content: 'a b c' } })]);
    const { index } = generate(tree);
    assertParses(index, 'js', 'index.js');
    expect(index).not.toContain(' ');
    expect(index).not.toContain(' ');
  });

  it('places every widget exactly where the editor does', () => {
    expectPlacementMatchesEditor(allComponents());
  });

  it('places widgets of every layout fixture at the editor positions', () => {
    for (const [name, root] of Object.entries(layouts())) {
      expect(() => expectPlacementMatchesEditor(root), name).not.toThrow();
      const { index } = generate(root);
      expect(index, name).toContain('T0');
    }
  });

  it('uses the IR rel values as left/top', () => {
    const { ir, index } = generate(layouts().row);
    const r = run(index);
    const texts = walkIR(ir.start.root).filter((n) => n.type === 'Text');
    expect(texts.length).toBe(3);
    for (const t of texts) {
      const rec = r.created.find((c) => c.opts.content === t.text)!;
      const rel = blessedPlacement(t);
      expect(rec.opts.left).toBe(rel.x);
      expect(rec.opts.top).toBe(rel.y);
      expect(rec.opts.width).toBe(rel.width);
      expect(rec.opts.height).toBe(rel.height);
      expect(t.rel).toBeDefined();
      expect(rel).toEqual(t.rel);
    }
  });

  it('keeps children of bordered, padded boxes where the editor puts them', () => {
    resetIds();
    const tree = screen('S', undefined, [
      mk(
        'Box',
        {
          props: { width: 30, height: 8 },
          style: { border: true, borderStyle: 'double' },
          layout: { type: 'flexbox', direction: 'column', padding: 1 },
        },
        [
          mk('Text', { props: { content: 'INNER', width: 10, height: 1 } }),
          mk('Box', { props: { width: 12, height: 4 }, style: { border: true } }, [
            mk('Text', { props: { content: 'DEEP', width: 4, height: 1 } }),
          ]),
        ]
      ),
    ]);
    const { ir, index } = generate(tree);
    const r = run(index);
    const nodes = walkIR(ir.start.root);
    const inner = nodes.find((n) => n.text === 'INNER')!;
    const deep = nodes.find((n) => n.text === 'DEEP')!;
    const outer = nodes.find((n) => n.type === 'Box')!;
    // The child sits one cell in from the border plus the padding: that is part of rel.
    expect(inner.rel!.x).toBeGreaterThan(0);
    expect(inner.rel!.y).toBeGreaterThan(0);
    const innerRec = r.created.find((c) => c.opts.content === 'INNER')!;
    const deepRec = r.created.find((c) => c.opts.content === 'DEEP')!;
    expect(innerRec.opts.left).toBe(inner.rel!.x);
    expect(innerRec.opts.top).toBe(inner.rel!.y);
    // blessed with autoPadding off: parent outer origin + left/top equals the editor's cell.
    expect(absRect(innerRec, r.screenRec)).toEqual({
      x: inner.box!.x,
      y: inner.box!.y,
      width: 10,
      height: 1,
    });
    expect(absRect(deepRec, r.screenRec)).toMatchObject({ x: deep.box!.x, y: deep.box!.y });
    expect(outer.style.border).not.toBeNull();
    expect(index).toContain('autoPadding: false');
    expect(index).toContain("border: { type: 'line' }");
  });

  it('writes colours and text styles as hex', () => {
    resetIds();
    const tree = screen('S', undefined, [
      mk('Text', {
        props: { content: 'Styled' },
        style: { color: '#ff0000', backgroundColor: '#00ff00', bold: true, underline: true },
      }),
    ]);
    const r = run(generate(tree).index);
    const t = r.created.find((c) => c.opts.content === 'Styled')!;
    expect(t.opts.style).toMatchObject({
      fg: '#ff0000',
      bg: '#00ff00',
      bold: true,
      underline: true,
    });
  });

  it('uses the code names for variables and dedupes handler stubs', () => {
    resetIds();
    const tree = screen('S', 'main', [
      mk('Button', {
        tag: 'save_btn',
        props: { label: 'Save' },
        events: { onClick: 'handleSave' },
      }),
      mk('Button', {
        tag: 'send_btn',
        props: { label: 'Send' },
        events: { onClick: 'handleSave', onFocus: 'handleFocus' },
      }),
      mk('Checkbox', { tag: 'agree', events: { onChange: 'on-agree' } }),
      mk('Text', { tag: 'blessed', props: { content: 'clash' } }),
    ]);
    const { index } = generate(tree);
    assertParses(index, 'js', 'index.js');
    expect(index).toContain('const saveBtn = blessed.button(');
    expect(index).toContain('const sendBtn = blessed.button(');
    expect(index).toContain('const agree = blessed.checkbox(');
    expect(index.match(/function handleSave\(/g)).toHaveLength(1);
    expect(index).toContain('function handleFocus(');
    expect(index).toContain('function on_agree(');
    expect(index.match(/\.on\("press"/g)).toHaveLength(2);
    expect(index).toContain('["check", "uncheck"]'.replace(/"/g, "'"));
    // A code name that collides with a reserved name still produces valid code.
    expect(index).toMatch(/const blessed_ = blessed\.box\(/);
    const r = run(index);
    expect(
      r.created.filter((c) => c.kind === 'button').every((c) => c.events.includes('press'))
    ).toBe(true);
  });

  it('wires quit keys, focus order and tab switching', () => {
    const { index } = generate(allComponents());
    expect(index).toContain("screen.key(['q', 'C-c'], quit)");
    expect(index).toContain("screen.key(['escape']");
    expect(index).toContain("screen.key(['tab']");
    expect(index).toContain("screen.key(['S-tab']");
    expect(index).toMatch(/const focusables = \[nameInput, submitBtn,/);
    expect(index).toContain('blessed.listbar(');
    expect(index).toContain('inputOnFocus: true');
    expect(index).toContain('function closeTopModal()');
  });

  it('leaves out hidden nodes and spacers', () => {
    resetIds();
    const tree = screen('S', undefined, [
      mk('Text', { props: { content: 'SHOWN' } }),
      mk('Text', { hidden: true, props: { content: 'GONE' } }),
      mk('Spacer'),
    ]);
    const { index } = generate(tree);
    expect(index).toContain('SHOWN');
    expect(index).not.toContain('GONE');
    expect(run(index).created.filter((c) => c.opts.content === 'SHOWN')).toHaveLength(1);
  });

  it('handles an empty screen', () => {
    const { index } = generate(screen('Empty', undefined, []));
    assertParses(index, 'js', 'index.js');
    expect(() => run(index)).not.toThrow();
  });
});
