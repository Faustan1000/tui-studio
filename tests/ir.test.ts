import { describe, expect, it } from 'vitest';
import {
  buildIR,
  inlineText,
  itemText,
  progressText,
  recase,
  resolveColor,
  toIdent,
  treeLines,
  walkIR,
} from '../src/utils/export/ir';
import { ALL_TYPES, allComponents, layouts, multiScreen } from './fixtures/designs';
import { mk, screen } from './fixtures/build';

const find = (root: ReturnType<typeof buildIR>['start']['root'], tag: string) =>
  walkIR(root).find((n) => n.tag === tag)!;

describe('IR: structure', () => {
  const ir = buildIR(allComponents());
  const root = ir.start.root;

  it('covers every component type', () => {
    const types = new Set(walkIR(root).map((n) => n.type));
    for (const t of ALL_TYPES) expect(types.has(t), t).toBe(true);
  });

  it('keeps the code name and derives unique identifiers', () => {
    expect(find(root, 'submit_btn').ident).toBe('submit_btn');
    const idents = walkIR(root).map((n) => n.ident);
    expect(new Set(idents).size).toBe(idents.length);
  });

  it('gives every visible node a position from the editor layout', () => {
    for (const n of walkIR(root)) {
      if (n.visible) expect(n.box, `${n.type} ${n.id}`).toBeDefined();
    }
  });

  it('positions children relative to their parent', () => {
    const panel = find(root, 'panel');
    for (const c of panel.children) {
      if (!c.box || !panel.box) continue;
      expect(c.rel!.x).toBe(c.box.x - panel.box.x);
      expect(c.rel!.y).toBe(c.box.y - panel.box.y);
    }
  });

  it('fills defaults', () => {
    const btn = find(root, 'submit_btn');
    expect(btn.text).toBe('Send');
    expect(btn.style.border?.kind).toBe('rounded');
    expect(find(root, 'color').options).toEqual(['Option 1', 'Option 2', 'Option 3']);
    expect(find(root, 'results').rows[0]).toEqual(['Cell 1', 'Cell 2']);
    expect(find(root, 'files').items.map((i) => i.label)).toEqual(['Item 1', 'Item 2', 'Item 3']);
  });
});

describe('IR: visibility', () => {
  it('hidden nodes and their children are not visible', () => {
    const tree = screen('S', undefined, [
      mk('Box', { hidden: true }, [mk('Text', { tag: 'inner' })]),
      mk('Text', { tag: 'outer' }),
    ]);
    const root = buildIR(tree).start.root;
    expect(find(root, 'inner').visible).toBe(false);
    expect(find(root, 'inner').box).toBeUndefined();
    expect(find(root, 'outer').visible).toBe(true);
  });

  it('only the active tab body is visible', () => {
    const home = buildIR(multiScreen()[0]).start.root;
    const bodies = walkIR(home).filter((n) => n.showWhen?.nav === 'tabs1');
    expect(bodies.map((b) => b.visible)).toEqual([true, false]);
    expect(find(home, 'agent_btn').visible).toBe(false);
    expect(find(home, 'dash_text').visible).toBe(true);
  });
});

describe('IR: screens', () => {
  it('builds every screen with unique identifiers', () => {
    const screens = multiScreen().map((root) => ({ id: root.id, root }));
    const ir = buildIR(screens);
    expect(ir.screens.map((s) => s.ident)).toEqual(['home', 'settings', 'about_us']);
    expect(ir.start.ident).toBe('home');
  });

  it('numbers screens that cannot be named', () => {
    const blank = (name: string) => ({ id: 'root', root: screen(name, undefined, []) });
    const ir = buildIR([blank(''), blank('!!')]);
    expect(ir.screens.map((s) => s.ident)).toEqual(['screen_1', 'screen_2']);
  });

  it('links buttons to screens', () => {
    const home = buildIR(multiScreen()[0]).start.root;
    expect(find(home, 'go_settings').opensScreen).toBe('settings');
  });
});

describe('IR: layout', () => {
  it('describes flex containers', () => {
    const ir = buildIR(layouts().row);
    const box = walkIR(ir.start.root).find((n) => n.id === 'box')!;
    expect(box.layout).toMatchObject({ mode: 'flex', direction: 'row', gap: 2 });
    const xs = box.children.map((c) => c.rel!.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(xs[1] - xs[0]).toBe(6 + 2);
  });

  it('describes grids and absolute positions', () => {
    const grid = walkIR(buildIR(layouts().grid).start.root).find((n) => n.id === 'box')!;
    expect(grid.layout).toMatchObject({ mode: 'grid', columns: 2, rows: 2 });
    const abs = walkIR(buildIR(layouts().absolute).start.root).find((n) => n.id === 'box')!;
    expect(abs.children.map((c) => [c.layout.x, c.layout.y])).toEqual([
      [3, 2],
      [13, 3],
    ]);
  });
});

describe('IR: colours and identifiers', () => {
  const dracula = { red: '#ff5555', green: '#50fa7b' };

  it('resolves names against the palette and expands short hex', () => {
    expect(resolveColor('red', dracula)).toBe('#ff5555');
    expect(resolveColor('#ABC', {})).toBe('#aabbcc');
    expect(resolveColor('#112233', {})).toBe('#112233');
    expect(resolveColor('cyan', {})).toBe('#00ffff');
  });

  it('treats default, empty and unknown as terminal default', () => {
    expect(resolveColor('default', {})).toBeNull();
    expect(resolveColor('', {})).toBeNull();
    expect(resolveColor('not-a-colour', {})).toBeNull();
    expect(resolveColor(undefined, {})).toBeNull();
  });

  it('builds identifiers in each case', () => {
    expect(toIdent('Primary button!', 'snake')).toBe('primary_button');
    expect(toIdent('Primary button', 'camel')).toBe('primaryButton');
    expect(toIdent('primary button', 'pascal')).toBe('PrimaryButton');
    expect(toIdent('9 lives', 'snake')).toBe('_9_lives');
    expect(toIdent('', 'snake', 'thing')).toBe('thing');
    expect(recase('submit_btn', 'camel')).toBe('submitBtn');
    expect(recase('submit_btn', 'pascal')).toBe('SubmitBtn');
  });

  it('disambiguates identical names', () => {
    const tree = screen('S', undefined, [
      mk('Text', { name: 'Same' }),
      mk('Text', { name: 'Same' }),
    ]);
    const idents = walkIR(buildIR(tree).start.root).map((n) => n.ident);
    expect(idents.slice(1)).toEqual(['same', 'same_2']);
  });
});

describe('IR: shared content text', () => {
  const root = buildIR(allComponents()).start.root;

  it('renders simple widgets the same everywhere', () => {
    expect(inlineText(find(root, 'agree'))).toBe('[ ] Option');
    expect(inlineText(find(root, 'opt_a'))).toBe('(○) A');
    expect(inlineText(find(root, 'dark'))).toBe('[OFF] Toggle');
    expect(inlineText(find(root, 'submit_btn'))).toBe('Send');
    expect(inlineText(find(root, 'crumbs'))).toBe('Home / Documents / File');
  });

  it('draws progress bars', () => {
    const bar = find(root, 'progress');
    bar.progress = { value: 50, max: 100 };
    expect(progressText(bar, 10)).toBe('█████░░░░░');
    bar.progress = { value: 500, max: 100 };
    expect(progressText(bar, 4)).toBe('████');
  });

  it('flattens trees and formats items', () => {
    const lines = treeLines(find(root, 'nav_tree').items).map((l) => l.text);
    expect(lines).toEqual(['▾ 📁 Root', '  📄 Child 1', '  ▸ 📁 Child 2', '📁 Root 2']);
    const first = find(root, 'main_menu').items[0];
    expect(itemText(first)).toBe('⌂ Home  ^H');
    expect(itemText(first, false)).toBe('⌂ Home');
  });
});

describe('IR: reserved words and whole cells', () => {
  it('keeps code names that are keywords in a target language usable', () => {
    const tree = screen('S', undefined, [
      mk('Button', { tag: 'func' }),
      mk('Button', { tag: 'type' }),
      mk('Button', { tag: 'fn' }),
      mk('Button', { tag: 'model' }),
      mk('Button', { tag: 'ok' }),
    ]);
    const root = buildIR(tree).start.root;
    expect(root.children.map((c) => c.ident)).toEqual(['func_', 'type_', 'fn_', 'model_', 'ok']);
    // the marker survives re-casing
    expect(root.children.map((c) => recase(c.ident, 'camel'))).toEqual([
      'func_',
      'type_',
      'fn_',
      'model_',
      'ok',
    ]);
    expect(recase('two_words_', 'pascal')).toBe('TwoWords_');
  });

  it('never gives an identifier that is a keyword, even for unnamed components', () => {
    const tree = screen('Screen', undefined, [mk('Box', { name: 'class' })]);
    const idents = walkIR(buildIR(tree).start.root).map((n) => n.ident);
    expect(idents).not.toContain('class');
    expect(idents).not.toContain('screen');
  });

  it('rounds layout boxes to whole cells', () => {
    const ir = buildIR(layouts().center);
    for (const n of walkIR(ir.start.root)) {
      if (!n.box) continue;
      for (const v of [n.box.x, n.box.y, n.box.width, n.box.height]) {
        expect(Number.isInteger(v), `${n.id} ${JSON.stringify(n.box)}`).toBe(true);
      }
    }
  });
});
