import { describe, expect, it } from 'vitest';
import {
  bodiesOf,
  collectNavElements,
  isNavElement,
  isShownByNav,
  navActiveIndex,
  navItemLabels,
  remapShowWhen,
} from '../src/utils/navBodies';
import { linkedScreens, treeLinksTo, withoutScreenLinks } from '../src/utils/screenLinks';
import {
  cloneNode,
  countNodes,
  findNodeById,
  findParentNode,
  flattenTree,
  getAncestors,
  getDescendants,
  getTreeDepth,
} from '../src/utils/treeUtils';
import { mk, resetIds, screen } from './fixtures/build';
import { multiScreen } from './fixtures/designs';

describe('navigation bodies', () => {
  const home = multiScreen()[0];
  const byId = flattenTree(home);

  it('recognises navigation elements', () => {
    expect(isNavElement(mk('Tabs'))).toBe(true);
    expect(isNavElement(mk('Menu'))).toBe(true);
    expect(isNavElement(mk('List'))).toBe(true);
    expect(isNavElement(mk('Box'))).toBe(false);
    expect(collectNavElements(home).map((n) => n.id)).toEqual(['tabs1', 'menu1']);
  });

  it('reads the active item and the labels', () => {
    const tabs = byId.get('tabs1')!;
    expect(navActiveIndex(tabs)).toBe(0);
    expect(navItemLabels(tabs)).toEqual(['Dashboard', 'Agent', 'QA Team']);
    expect(navItemLabels(byId.get('menu1')!)).toEqual(['One', 'Two']);
    expect(navActiveIndex(mk('Menu', { props: { selectedIndex: -4 } }))).toBe(0);
    expect(navItemLabels(mk('Menu', { props: { items: ['', { label: '' }] } }))).toEqual([
      'Item 1',
      'Item 2',
    ]);
  });

  it('shows only the body of the active item', () => {
    expect(isShownByNav(byId.get('tb0')!, byId)).toBe(true);
    expect(isShownByNav(byId.get('tb1')!, byId)).toBe(false);
    byId.get('tabs1')!.props.activeTab = 1;
    expect(isShownByNav(byId.get('tb0')!, byId)).toBe(false);
    expect(isShownByNav(byId.get('tb1')!, byId)).toBe(true);
    byId.get('tabs1')!.props.activeTab = 0;
  });

  it('always shows components without a body link or with a missing nav element', () => {
    expect(isShownByNav(mk('Text'), byId)).toBe(true);
    expect(isShownByNav(mk('Text', { showWhen: { nav: 'gone', item: 3 } }), byId)).toBe(true);
    expect(isShownByNav(mk('Text', { showWhen: { nav: 'tb0', item: 3 } }), byId)).toBe(true);
  });

  it('groups bodies by item', () => {
    const groups = bodiesOf(home, 'tabs1');
    expect([...groups.keys()]).toEqual([0, 1]);
    expect(groups.get(1)![0].id).toBe('tb1');
    expect(bodiesOf(null, 'x').size).toBe(0);
  });

  it('remaps showWhen after cloning', () => {
    const copy = cloneNode(home);
    const idMap = new Map([['tabs1', 'tabs-copy']]);
    remapShowWhen(copy, idMap);
    const bodies = flattenTree(copy);
    expect([...bodies.values()].find((n) => n.showWhen?.nav === 'tabs-copy')).toBeDefined();
    expect([...bodies.values()].find((n) => n.showWhen?.nav === 'tabs1')).toBeUndefined();
    // menu bodies are untouched
    expect([...bodies.values()].find((n) => n.showWhen?.nav === 'menu1')).toBeDefined();
  });
});

describe('screen links', () => {
  resetIds();
  const tree = screen('S', undefined, [
    mk('Button', { id: 'b', opensScreen: 'target' }),
    mk('Menu', {
      id: 'm',
      props: { items: [{ label: 'A', screen: 'one' }, { label: 'B' }, 'plain'] },
    }),
    mk('Box', {}, [mk('List', { id: 'l', props: { items: [{ label: 'C', screen: 'target' }] } })]),
  ]);

  it('lists the screens a component links to', () => {
    expect(linkedScreens(tree.children[0])).toEqual(['target']);
    expect(linkedScreens(tree.children[1])).toEqual(['one']);
    expect(linkedScreens(tree)).toEqual([]);
  });

  it('finds links anywhere in the tree', () => {
    expect(treeLinksTo(tree, 'target')).toBe(true);
    expect(treeLinksTo(tree, 'one')).toBe(true);
    expect(treeLinksTo(tree, 'nowhere')).toBe(false);
  });

  it('removes links without touching the original', () => {
    const cleaned = withoutScreenLinks(tree, (id) => id === 'target');
    expect(cleaned.children[0].opensScreen).toBeUndefined();
    const items = cleaned.children[2].children[0].props.items as { screen?: string }[];
    expect(items[0].screen).toBeUndefined();
    // the menu link to "one" stays, and the original tree is unchanged
    expect(linkedScreens(cleaned.children[1])).toEqual(['one']);
    expect(tree.children[0].opensScreen).toBe('target');
  });

  it('shares nodes that did not change', () => {
    const cleaned = withoutScreenLinks(tree, (id) => id === 'target');
    expect(cleaned.children[1]).toBe(tree.children[1]);
  });
});

describe('tree utilities', () => {
  resetIds();
  const tree = screen('S', undefined, [
    mk('Box', { id: 'a' }, [mk('Text', { id: 'a1' }), mk('Text', { id: 'a2' })]),
    mk('Box', { id: 'b' }),
  ]);

  it('finds nodes and parents', () => {
    expect(findNodeById(tree, 'a2')?.id).toBe('a2');
    expect(findNodeById(tree, 'zzz')).toBeNull();
    expect(findNodeById(null, 'a')).toBeNull();
    expect(findParentNode(tree, 'a2')?.id).toBe('a');
    expect(findParentNode(tree, 'root')).toBeNull();
  });

  it('lists ancestors and descendants', () => {
    expect(getAncestors(tree, 'a2').map((n) => n.id)).toEqual(['root', 'a']);
    expect(getDescendants(tree.children[0]).map((n) => n.id)).toEqual(['a1', 'a2']);
  });

  it('counts and measures', () => {
    expect(countNodes(tree)).toBe(5);
    expect(countNodes(null)).toBe(0);
    expect(getTreeDepth(tree)).toBeGreaterThanOrEqual(2);
    expect(flattenTree(tree).size).toBe(5);
  });

  it('clones deeply without sharing nodes', () => {
    const copy = cloneNode(tree.children[0]);
    expect(copy).toEqual(tree.children[0]);
    expect(copy).not.toBe(tree.children[0]);
    expect(copy.children[0]).not.toBe(tree.children[0].children[0]);
    copy.props.width = 99;
    expect(tree.children[0].props.width).not.toBe(99);
  });
});
