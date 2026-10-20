// Designs for the tests that run the exported Textual app against real Textual (tests/python).
// The Python scripts look up widgets by these code names; change both together.

import { LayoutEngine } from '../../src/utils/layout/engine';
import type { ComponentNode } from '../../src/types';
import { mk, resetIds, screen } from './build';

export interface Project {
  screens: { id: string; root: ComponentNode }[];
}

/** One screen with a component of every kind (tests/python/real_test.py, real_thread.py). */
export function runtimeProject(): Project {
  resetIds();
  const root = mk('Screen', { id: 'root', name: 'Main Screen' }, [
    mk('Text', { tag: 'status', props: { content: 'Ready' } }),
    mk('TextInput', { tag: 'name_input' }),
    mk('Button', { tag: 'submit_btn', props: { label: 'Send' } }),
    mk('Checkbox', { tag: 'agree' }),
    mk('Radio', { tag: 'opt_a', props: { label: 'A' } }),
    mk('Radio', { tag: 'opt_b', props: { label: 'B' } }),
    mk('Select', { tag: 'color' }),
    mk('Toggle', { tag: 'dark' }),
    mk('ProgressBar', { tag: 'progress' }),
    mk('Spinner', { tag: 'busy' }),
    mk('Table', { tag: 'results' }),
    mk('List', { tag: 'files' }),
    mk('Tree', { tag: 'nav_tree' }),
    mk('Menu', { tag: 'main_menu' }),
    mk('Tabs', { tag: 'pages' }),
    mk('Box', { tag: 'panel' }, [mk('Text')]),
    mk('Modal', { tag: 'confirm', props: { title: 'Sure?' } }, [
      mk('Button', { tag: 'ok_btn', props: { label: 'OK' } }),
    ]),
    mk('Text'),
  ]);
  return { screens: [{ id: 'screen-1', root }] };
}

/** Three screens, tab bodies and menu bodies (tests/python/real_multi.py). */
export function tabsProject(): Project {
  resetIds();
  const home = screen('Home', 'home', [
    mk('Text', { tag: 'status', props: { content: 'Ready' } }),
    mk('Button', { tag: 'go_settings', props: { label: 'Settings' } }),
    mk('Tabs', { id: 'tabs1', tag: 'pages' }),
    mk('Box', { id: 'tb0', name: 'Dashboard body', showWhen: { nav: 'tabs1', item: 0 } }, [
      mk('Text', { tag: 'dash_text', props: { content: 'Dashboard content' } }),
    ]),
    mk('Box', { id: 'tb1', name: 'Agent body', showWhen: { nav: 'tabs1', item: 1 } }, [
      mk('Text', { tag: 'agent_text', props: { content: 'Agent content' } }),
      mk('Button', { tag: 'agent_btn', props: { label: 'Run' } }),
    ]),
    mk('Box', { id: 'tb2', name: 'QA body', showWhen: { nav: 'tabs1', item: 2 } }, [
      mk('Text', { props: { content: 'QA content' } }),
    ]),
    mk('Menu', {
      id: 'menu1',
      tag: 'side',
      props: { items: [{ label: 'One' }, { label: 'Two' }] },
    }),
    mk('Box', { id: 'mb0', showWhen: { nav: 'menu1', item: 0 } }, [
      mk('Text', { props: { content: 'Menu one body' } }),
    ]),
    mk('Box', { id: 'mb1', showWhen: { nav: 'menu1', item: 1 } }, [
      mk('Text', { props: { content: 'Menu two body' } }),
    ]),
    mk('Modal', { tag: 'confirm', props: { title: 'Sure?' } }, [
      mk('Text', { tag: 'confirm_text', props: { content: 'Really?' } }),
      mk('Button', { tag: 'ok_btn', props: { label: 'OK' } }),
    ]),
  ]);
  const settings = screen('Settings', 'settings', [
    mk('Text', { props: { content: 'Settings screen' } }),
    mk('TextInput', { tag: 'name_input' }),
    mk('ProgressBar', { tag: 'progress' }),
    mk('Table', { tag: 'results' }),
    mk('Button', { tag: 'back_btn', props: { label: 'Back' } }),
  ]);
  const third = screen('About us', undefined, [
    mk('Text', { props: { content: 'About screen without code name' } }),
  ]);
  return {
    screens: [
      { id: 'screen-1', root: home },
      { id: 'screen-2', root: settings },
      { id: 'screen-3', root: third },
    ],
  };
}

/** Buttons, menu and list items that open screens (tests/python/real_links.py). */
export function linksProject(): Project {
  resetIds();
  const home = screen('Home', 'home', [
    mk('Text', { tag: 'status', props: { content: 'Home' } }),
    mk('Button', { tag: 'go_settings', props: { label: 'Settings' }, opensScreen: 'screen-2' }),
    mk('Button', { tag: 'go_nowhere', props: { label: 'Dead link' }, opensScreen: 'screen-99' }),
    mk('Button', { tag: 'plain', props: { label: 'No link' } }),
    mk('Menu', {
      tag: 'side',
      props: {
        items: [
          { label: 'Open about', screen: 'screen-3' },
          { label: 'Stay here' },
          { label: 'Open settings', screen: 'screen-2' },
        ],
      },
    }),
    mk('List', {
      tag: 'files',
      props: { items: [{ label: 'a', screen: 'screen-3' }, { label: 'b' }] },
    }),
  ]);
  const settings = screen('Settings', 'settings', [
    mk('Text', { props: { content: 'Settings' } }),
    mk('Button', { tag: 'back_btn', props: { label: 'Back' }, opensScreen: 'screen-1' }),
  ]);
  const about = screen('About us', undefined, [
    mk('Text', { props: { content: 'About' } }),
    mk('Button', { tag: 'about_back', props: { label: 'Home' }, opensScreen: 'screen-1' }),
  ]);
  return {
    screens: [
      { id: 'screen-1', root: home },
      { id: 'screen-2', root: settings },
      { id: 'screen-3', root: about },
    ],
  };
}

// ── Layout parity: editor layout engine vs. real Textual ──────────────────────

export interface ParityCase {
  name: string;
  /** Code name of the generated screen. */
  key: string;
  /** Code name -> [x, y, width, height] as the editor lays it out. */
  expected: Record<string, number[]>;
}

type Dim = number | 'fill' | 'auto';

/** The layout cases (column/row gaps, justify, absolute, grid, wrap, alignment). */
export function parityProject(): Project & { cases: ParityCase[] } {
  resetIds();
  let t = 0;
  const txt = (
    w: Dim,
    h: Dim = 1,
    extra: { props?: Record<string, unknown>; layout?: Record<string, unknown> } = {}
  ) =>
    mk('Text', {
      tag: `t${++t}`,
      props: { content: 'x', width: w, height: h, ...(extra.props ?? {}) },
      layout: extra.layout,
      events: {},
    });
  const auto = (content: string) =>
    mk('Text', {
      tag: `t${++t}`,
      props: { content, width: 'auto', height: 'auto' },
      events: {},
    });
  const scr = (
    name: string,
    layout: Record<string, unknown>,
    children: ComponentNode[],
    style: Record<string, unknown> = { border: false }
  ) =>
    mk(
      'Screen',
      {
        id: 'root',
        name,
        props: { width: 80, height: 24, theme: 'dracula' },
        layout,
        style,
        events: {},
      },
      children
    );
  const box = (
    tag: string,
    layout: Record<string, unknown>,
    props: Record<string, unknown>,
    children: ComponentNode[],
    style: Record<string, unknown> = { border: false }
  ) =>
    mk(
      'Box',
      { tag, layout, props: { width: 'auto', height: 'auto', ...props }, style, events: {} },
      children
    );
  const col = (children: ComponentNode[]) =>
    scr(`s${++t}`, { type: 'flexbox', direction: 'column' }, children);

  const roots: { name: string; root: ComponentNode }[] = [];
  const add = (name: string, root: ComponentNode) => roots.push({ name, root });
  const flex = (o: Record<string, unknown>) => ({ type: 'flexbox', ...o });

  add(
    'column gap 1',
    scr('c1', flex({ direction: 'column', gap: 1 }), [txt(10), txt(10), txt(10)])
  );
  add('row gap 2', scr('c2', flex({ direction: 'row', gap: 2 }), [txt(5), txt(8), txt(6)]));
  for (const justify of ['center', 'space-between', 'space-around']) {
    add(
      `column justify ${justify}`,
      col([
        box(
          `box_${justify.replace('-', '_')}`,
          flex({ direction: 'column', justify }),
          { width: 30, height: 11 },
          [txt(10), txt(10), txt(10)]
        ),
      ])
    );
  }
  add(
    'absolute box with border and padding',
    scr('abs2', { type: 'absolute' }, [
      box(
        'abs_box',
        { type: 'absolute', padding: 1, x: 5, y: 2 },
        { width: 30, height: 10 },
        [txt(8, 1, { layout: { x: 2, y: 1 } }), txt(8, 1, { layout: { x: 10, y: 4 } })],
        { border: true, borderStyle: 'single' }
      ),
    ])
  );
  const fill = () => txt(0, 0, { props: { width: 'fill', height: 'fill' } });
  add(
    'grid 2x2 with gaps',
    col([
      box(
        'grid_box',
        { type: 'grid', columns: 2, rows: 2, columnGap: 1, rowGap: 1 },
        { width: 31, height: 9 },
        [fill(), fill(), fill(), fill()]
      ),
    ])
  );
  add(
    'row wrap: 3 items of 8 in 18 columns',
    col([
      box('wrap1', flex({ direction: 'row', wrap: true }), { width: 20, height: 8 }, [
        txt(8),
        txt(8),
        txt(8),
      ]),
    ])
  );
  add(
    'row wrap: five items, gap 2, no padding',
    col([
      box(
        'wrap2',
        flex({ direction: 'row', wrap: true, gap: 2, padding: 0 }),
        { width: 24, height: 9 },
        [txt(7), txt(7), txt(7), txt(7), txt(7)]
      ),
    ])
  );
  add(
    'row wrap with items of different height',
    col([
      box(
        'wrap3',
        flex({ direction: 'row', wrap: true, padding: 0, gap: 1 }),
        { width: 20, height: 9 },
        [txt(9, 1), txt(9, 3), txt(9, 2), txt(9, 1)]
      ),
    ])
  );
  add(
    'column wrap',
    col([
      box(
        'wrap4',
        flex({ direction: 'column', wrap: true, padding: 0, gap: 1 }),
        { width: 24, height: 7 },
        [txt(6, 3), txt(6, 3), txt(6, 3), txt(6, 3)]
      ),
    ])
  );
  add(
    'wrap with border and padding',
    col([
      box(
        'wrap5',
        flex({ direction: 'row', wrap: true, padding: 1, gap: 1 }),
        { width: 24, height: 9 },
        [txt(10), txt(10), txt(10)],
        { border: true, borderStyle: 'single' }
      ),
    ])
  );
  add(
    'auto-sized box that wraps',
    col([
      box('wrap6', flex({ direction: 'row', wrap: true, padding: 0 }), {}, [
        txt(6),
        txt(6),
        txt(6),
      ]),
    ])
  );
  add(
    'screen that wraps',
    scr('wrapscreen', flex({ direction: 'row', wrap: true, gap: 1 }), [
      txt(30),
      txt(30),
      txt(30),
      txt(12),
    ])
  );
  for (const align of ['center', 'end']) {
    add(
      `column align ${align}: numeric sizes differ`,
      col([
        box(`un_${align}`, flex({ direction: 'column', align }), { width: 30, height: 9 }, [
          txt(10),
          txt(6),
          txt(14),
        ]),
      ])
    );
    add(
      `column align ${align}: content-sized texts`,
      col([
        box(`au_${align}`, flex({ direction: 'column', align }), { width: 30, height: 9 }, [
          auto('a much longer line of text'),
          auto('hi'),
          auto('medium length'),
        ]),
      ])
    );
    add(
      `row align ${align}: heights differ`,
      col([
        box(`ra_${align}`, flex({ direction: 'row', align }), { width: 30, height: 9 }, [
          txt(6, 1),
          txt(6, 3),
          txt(6, 5),
        ]),
      ])
    );
    add(
      `auto-sized box, align ${align}`,
      col([
        box(`ab_${align}`, flex({ direction: 'column', align, padding: 0 }), {}, [
          txt(12),
          txt(4),
          txt(8),
        ]),
      ])
    );
  }

  const cases: ParityCase[] = roots.map((c, i) => {
    const engine = new LayoutEngine();
    engine.calculateLayout(c.root, 80, 24, false);
    const expected: Record<string, number[]> = {};
    const walk = (node: ComponentNode) => {
      if (node.tag) {
        const l = engine.getLayout(node.id)!;
        expected[node.tag] = [l.x, l.y, l.width, l.height];
      }
      node.children.forEach(walk);
    };
    walk(c.root);
    return { name: c.name, key: `_screen_${i + 1}`, expected };
  });
  return { screens: roots.map((c, i) => ({ id: `screen-${i + 1}`, root: c.root })), cases };
}

/** 30 nested boxes: Python allows only 20 nested blocks per function (tests/python/real_smoke.py). */
export function deepProject(): Project {
  resetIds();
  let inner = mk('Text', { tag: 'bottom', props: { content: 'bottom' } });
  for (let i = 0; i < 30; i++)
    inner = mk('Box', { tag: i === 0 ? 'innermost' : undefined }, [inner]);
  return { screens: [{ id: 'screen-1', root: screen('Deep', 'deep', [inner]) }] };
}
