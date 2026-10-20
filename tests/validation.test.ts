import { describe, expect, it } from 'vitest';
import {
  MAX_SCREENS,
  MAX_TREE_DEPTH,
  MAX_TREE_NODES,
  MAX_TUI_FILE_BYTES,
  parseTuiFile,
} from '../src/utils/tuiValidation';
import type { ComponentNode } from '../src/types';
import { mk, resetIds, screen } from './fixtures/build';
import { multiScreen } from './fixtures/designs';

const THEMES = ['default', 'dracula', 'nord'];
const file = (screens: ComponentNode[], meta: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: '2',
    meta,
    screens: screens.map((tree, i) => ({ id: `s${i + 1}`, tree })),
  });
const parse = (text: string) => parseTuiFile(text, THEMES);

describe('parseTuiFile: formats', () => {
  it('reads a version 2 project', () => {
    resetIds();
    const result = parse(file(multiScreen(), { theme: 'nord', activeScreen: 's2' }));
    expect(result.screens.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
    expect(result.theme).toBe('nord');
    expect(result.activeId).toBe('s2');
  });

  it('still reads version 1 (a single tree)', () => {
    const tree = screen('Old', undefined, [mk('Text')]);
    const result = parse(JSON.stringify({ version: '1', tree }));
    expect(result.screens).toHaveLength(1);
    expect(result.screens[0].tree.name).toBe('Old');
  });

  it('rejects other versions and non-objects', () => {
    expect(() => parse(JSON.stringify({ version: '3', screens: [] }))).toThrow('version');
    expect(() => parse('[]')).toThrow('version');
    expect(() => parse('null')).toThrow('version');
  });

  it('rejects text that is not JSON', () => {
    expect(() => parse('{nope')).toThrow('Not valid JSON');
  });

  it('rejects files that are too large', () => {
    expect(() => parse(' '.repeat(MAX_TUI_FILE_BYTES + 1))).toThrow('too large');
  });
});

describe('parseTuiFile: screens', () => {
  it('needs at least one screen and at most MAX_SCREENS', () => {
    expect(() => parse(JSON.stringify({ version: '2', screens: [] }))).toThrow('no screens');
    const many = Array.from({ length: MAX_SCREENS + 1 }, () => screen('S', undefined, []));
    expect(() => parse(file(many))).toThrow('More than');
  });

  it('a screen must start with a Screen component', () => {
    resetIds();
    expect(() => parse(file([mk('Box', { id: 'root' })]))).toThrow('Screen component');
  });

  it('rejects duplicate screen ids', () => {
    const text = JSON.stringify({
      version: '2',
      screens: [
        { id: 'a', tree: screen('A', undefined, []) },
        { id: 'a', tree: screen('B', undefined, []) },
      ],
    });
    expect(() => parse(text)).toThrow('Duplicate screen id');
  });

  it('drops links to screens that are not in the file', () => {
    resetIds();
    const home = screen('Home', undefined, [
      mk('Button', { id: 'b1', opensScreen: 's2' }),
      mk('Button', { id: 'b2', opensScreen: 'ghost' }),
    ]);
    const other = screen('Other', undefined, []);
    const result = parse(file([home, other]));
    const buttons = result.screens[0].tree.children;
    expect(buttons[0].opensScreen).toBe('s2');
    expect(buttons[1].opensScreen).toBeUndefined();
  });

  it('rejects an unknown theme', () => {
    expect(() => parse(file([screen('S', undefined, [])], { theme: 'neon' }))).toThrow('theme');
  });
});

describe('parseTuiFile: components', () => {
  const withChild = (child: unknown) => {
    const tree = screen('S', undefined, []) as unknown as Record<string, unknown>;
    tree.children = [child];
    return JSON.stringify({ version: '2', screens: [{ id: 's1', tree }] });
  };
  const good = () => JSON.parse(JSON.stringify(mk('Text', { id: 'x' })));

  it('accepts a valid component', () => {
    expect(() => parse(withChild(good()))).not.toThrow();
  });

  it.each([
    ['unknown type', { type: 'Hologram' }, 'Unknown component type'],
    ['missing id', { id: '' }, 'invalid id'],
    ['reserved id', { id: 'root' }, 'reserved'],
    ['props not an object', { props: [] }, '"props" must be an object'],
    ['bad layout', { layout: { type: 'magic' } }, 'invalid layout'],
    ['children not array', { children: {} }, 'children must be an array'],
    ['hidden not boolean', { hidden: 'yes' }, '"hidden" must be a boolean'],
    ['name too long', { name: 'x'.repeat(501) }, 'invalid name'],
    ['tag not text', { tag: 5 }, 'tag must be text'],
    ['tag with space', { tag: 'my button' }, 'invalid code name'],
    ['tag a keyword', { tag: 'class' }, 'keyword'],
    ['link not text', { opensScreen: 5 }, 'invalid screen link'],
    ['showWhen item negative', { showWhen: { nav: 'n', item: -1 } }, 'visible when'],
    ['showWhen without nav', { showWhen: { item: 0 } }, 'visible when'],
  ])('rejects %s', (_name, patch, message) => {
    expect(() => parse(withChild({ ...good(), ...patch }))).toThrow(message);
  });

  it('rejects duplicate ids and duplicate code names across screens', () => {
    resetIds();
    const a = screen('A', undefined, [mk('Text', { id: 'dup' })]);
    const b = screen('B', undefined, [mk('Text', { id: 'dup' })]);
    expect(() => parse(file([a, b]))).toThrow('Duplicate component id');
    const c = screen('C', undefined, [mk('Text', { id: 'c1', tag: 'same' })]);
    const d = screen('D', undefined, [mk('Text', { id: 'd1', tag: 'same' })]);
    expect(() => parse(file([c, d]))).toThrow('already used');
  });

  it('limits depth and node count', () => {
    resetIds();
    let deep = mk('Text');
    for (let i = 0; i < MAX_TREE_DEPTH + 1; i++) deep = mk('Box', {}, [deep]);
    expect(() => parse(file([screen('S', undefined, [deep])]))).toThrow('deeper than');

    const wide = Array.from({ length: MAX_TREE_NODES + 1 }, () => mk('Text'));
    expect(() => parse(file([screen('S', undefined, wide)]))).toThrow('More than');
  });

  it('removes prototype-polluting keys', () => {
    const text =
      '{"version":"1","tree":' +
      JSON.stringify(screen('S', undefined, [])).replace(
        '"props":{',
        '"props":{"__proto__":{"polluted":true},"constructor":1,'
      ) +
      '}';
    const result = parse(text);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(result.screens[0].tree.props)).not.toContain('__proto__');
    expect(Object.keys(result.screens[0].tree.props)).not.toContain('constructor');
  });
});
