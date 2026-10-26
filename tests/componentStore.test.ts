import { beforeEach, describe, expect, it } from 'vitest';
import { createScreenRoot, useComponentStore } from '../src/stores/componentStore';
import type { ComponentNode } from '../src/types';
import { linkedScreens } from '../src/utils/screenLinks';
import { flattenTree } from '../src/utils/treeUtils';
import { mk, resetIds } from './fixtures/build';

const store = () => useComponentStore.getState();

/** Component data the way the palette adds it (no id). */
function data(type: Parameters<typeof mk>[0], over: Parameters<typeof mk>[1] = {}) {
  const { id: _id, ...rest } = mk(type, over);
  void _id;
  return rest;
}

function freshProject() {
  resetIds();
  useComponentStore.setState({
    root: null,
    components: new Map(),
    screens: [],
    activeScreenId: '',
    history: [],
    historyIndex: -1,
  });
  store().setRoot(createScreenRoot('Main'));
}

beforeEach(freshProject);

describe('components', () => {
  it('adds, updates and removes components', () => {
    const id = store().addComponent('root', data('Text', { props: { content: 'Hi' } }));
    expect(store().root!.children).toHaveLength(1);
    expect(store().getComponent(id)?.props.content).toBe('Hi');

    store().updateProps(id, { content: 'Bye' });
    expect(store().getComponent(id)?.props.content).toBe('Bye');

    store().removeComponent(id);
    expect(store().root!.children).toHaveLength(0);
    expect(store().getComponent(id)).toBeUndefined();
  });

  it('inserts at an index', () => {
    const a = store().addComponent('root', data('Text'));
    const b = store().addComponent('root', data('Text'));
    const c = store().addComponent('root', data('Text'), 1);
    expect(store().root!.children.map((n) => n.id)).toEqual([a, c, b]);
  });

  it('moves a component into another container', () => {
    const box = store().addComponent('root', data('Box'));
    const text = store().addComponent('root', data('Text'));
    store().moveComponent(text, box);
    expect(
      store()
        .getChildren(box)
        .map((n) => n.id)
    ).toEqual([text]);
    expect(store().getParent(text)?.id).toBe(box);
  });

  it('refuses to add to a parent that does not exist', () => {
    expect(store().addComponent('missing', data('Text'))).toBe('');
  });

  it('does not mutate earlier tree versions (history stays intact)', () => {
    const before = store().root!;
    store().addComponent('root', data('Text'));
    expect(before.children).toHaveLength(0);
    expect(store().root).not.toBe(before);
  });
});

describe('history', () => {
  it('undoes and redoes', () => {
    const id = store().addComponent('root', data('Text'));
    store().updateProps(id, { content: 'changed' });
    store().undo();
    expect(store().getComponent(id)?.props.content).not.toBe('changed');
    store().undo();
    expect(store().root!.children).toHaveLength(0);
    store().redo();
    expect(store().root!.children).toHaveLength(1);
  });

  it('drops redo steps after a new change', () => {
    store().addComponent('root', data('Text'));
    store().undo();
    store().addComponent('root', data('Button'));
    store().redo();
    expect(store().root!.children.map((n) => n.type)).toEqual(['Button']);
  });

  it('keeps at most maxHistorySize steps', () => {
    for (let i = 0; i < store().maxHistorySize + 10; i++)
      store().addComponent('root', data('Text'));
    expect(store().history.length).toBeLessThanOrEqual(store().maxHistorySize);
  });
});

describe('code names', () => {
  it('a pasted component gets a generic tag when its tag is already used', () => {
    const first = store().addComponent('root', data('Button', { tag: 'save' }));
    const second = store().addComponent('root', data('Button', { tag: 'save' }));
    expect(store().getComponent(first)?.tag).toBe('save');
    expect(store().getComponent(second)?.tag).toMatch(/^[a-z0-9_]+_button\d+$/);
  });

  it('a component without a tag gets a generic one, free and per type', () => {
    const a = store().addComponent('root', data('Button'));
    const b = store().addComponent('root', data('Button'));
    const t = store().addComponent('root', data('Spinner'));
    const tags = [a, b, t].map((id) => store().getComponent(id)?.tag);
    expect(tags[0]).not.toBe(tags[1]);
    expect(tags[0]).toMatch(/_button1$/);
    expect(tags[1]).toMatch(/_button2$/);
    expect(tags[2]).toMatch(/_spinner1$/);
  });

  it('layout containers stay unnamed until the user names them', () => {
    const box = store().addComponent('root', data('Box'));
    expect(store().getComponent(box)?.tag).toBeUndefined();
  });

  it('tags are unique across screens', () => {
    store().addComponent('root', data('Button', { tag: 'save' }));
    store().addScreen('Other');
    const id = store().addComponent('root', data('Button', { tag: 'save' }));
    expect(store().getComponent(id)?.tag).toMatch(/_button\d+$/);
  });

  it('duplicates get fresh tags and never reuse the original ones', () => {
    const box = store().addComponent('root', data('Box', { tag: 'panel' }));
    store().addComponent(box, data('Text', { tag: 'inner' }));
    const copy = store().duplicateComponent(box)!;
    const nodes = [...flattenTree(store().getComponent(copy)!).values()];
    const inner = nodes.find((n) => n.type === 'Text')!;
    expect(nodes.find((n) => n.type === 'Box')!.tag).toBeUndefined();
    expect(inner.tag).toMatch(/_text\d+$/);
    expect(inner.tag).not.toBe('inner');
    expect(store().getComponent(box)?.tag).toBe('panel');
  });

  it('duplicated tab bodies follow the duplicated tabs', () => {
    const wrapper = store().addComponent('root', data('Box'));
    const tabs = store().addComponent(wrapper, data('Tabs'));
    store().addComponent(wrapper, data('Box', { showWhen: { nav: tabs, item: 1 } }));
    const copy = store().duplicateComponent(wrapper)!;
    const nodes = [...flattenTree(store().getComponent(copy)!).values()];
    const copiedTabs = nodes.find((n) => n.type === 'Tabs')!;
    const body = nodes.find((n) => n.showWhen)!;
    expect(copiedTabs.id).not.toBe(tabs);
    expect(body.showWhen!.nav).toBe(copiedTabs.id);
  });
});

describe('screens', () => {
  it('starts with one screen and adds more', () => {
    expect(store().screens).toHaveLength(1);
    const id = store().addScreen('Settings');
    expect(store().screens).toHaveLength(2);
    expect(store().activeScreenId).toBe(id);
    expect(store().root!.name).toBe('Settings');
  });

  it('gives screens unique names', () => {
    store().addScreen('Same');
    store().addScreen('Same');
    const names = store()
      .getScreenRoots()
      .map((s) => s.root.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('keeps the work of each screen when switching', () => {
    const first = store().activeScreenId;
    store().addComponent('root', data('Text', { props: { content: 'on first' } }));
    const second = store().addScreen('Second');
    expect(store().root!.children).toHaveLength(0);
    store().addComponent('root', data('Button'));
    store().switchScreen(first);
    expect(store().root!.children.map((n) => n.type)).toEqual(['Text']);
    store().switchScreen(second);
    expect(store().root!.children.map((n) => n.type)).toEqual(['Button']);
  });

  it('has an own undo history per screen', () => {
    const first = store().activeScreenId;
    store().addComponent('root', data('Text'));
    store().addScreen('Second');
    store().addComponent('root', data('Button'));
    store().undo();
    expect(store().root!.children).toHaveLength(0);
    store().switchScreen(first);
    expect(store().root!.children).toHaveLength(1);
  });

  it('renames, reorders and duplicates', () => {
    const first = store().activeScreenId;
    const second = store().addScreen('Second');
    store().renameScreen(second, 'Renamed');
    store().renameScreen(first, 'Home');
    expect(
      store()
        .getScreenRoots()
        .map((s) => s.root.name)
    ).toEqual(['Home', 'Renamed']);

    store().moveScreen(second, -1);
    expect(store().screens.map((s) => s.id)).toEqual([second, first]);
    store().moveScreen(second, -1); // already first: no-op
    expect(store().screens.map((s) => s.id)).toEqual([second, first]);

    const copy = store().duplicateScreen(first)!;
    expect(store().screens.map((s) => s.id)).toEqual([second, first, copy]);
    expect(
      store()
        .getScreenRoots()
        .find((s) => s.id === copy)!.root.name
    ).toBe('Home Copy');
  });

  it('never removes the last screen', () => {
    store().removeScreen(store().activeScreenId);
    expect(store().screens).toHaveLength(1);
  });

  it('forgets links to a removed screen', () => {
    const home = store().activeScreenId;
    const settings = store().addScreen('Settings');
    store().switchScreen(home);
    const button = store().addComponent('root', data('Button', { opensScreen: settings }));
    const menu = store().addComponent(
      'root',
      data('Menu', { props: { items: [{ label: 'Go', screen: settings }, { label: 'Stay' }] } })
    );
    expect(linkedScreens(store().getComponent(button)!)).toEqual([settings]);

    store().removeScreen(settings);
    expect(store().screens.map((s) => s.id)).toEqual([home]);
    expect(store().getComponent(button)?.opensScreen).toBeUndefined();
    expect(linkedScreens(store().getComponent(menu)!)).toEqual([]);
    expect((store().getComponent(menu)!.props.items as unknown[]).length).toBe(2);
  });

  it('loads a whole project', () => {
    const roots: { id: string; root: ComponentNode }[] = [
      { id: 'a', root: createScreenRoot('A') },
      { id: 'b', root: createScreenRoot('B') },
    ];
    store().loadProject(roots, 'b');
    expect(store().activeScreenId).toBe('b');
    expect(store().root!.name).toBe('B');
    expect(store().screens.map((s) => s.id)).toEqual(['a', 'b']);
    store().loadProject([], 'a'); // empty projects are ignored
    expect(store().screens).toHaveLength(2);
  });
});
