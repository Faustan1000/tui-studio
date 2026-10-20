// Shared designs used by the exporter, API and layout tests.

import type { ComponentNode, ComponentType } from '../../src/types';
import { mk, resetIds, screen } from './build';

/** Every component type once, with code names where the program API needs them. */
export function allComponents(): ComponentNode {
  resetIds();
  return screen('Main Screen', 'main', [
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
    mk('Breadcrumb', { tag: 'crumbs' }),
    mk('Grid', { tag: 'cells' }, [mk('Text'), mk('Text')]),
    mk('Box', { tag: 'panel' }, [mk('Spacer'), mk('Text')]),
    mk('Modal', { tag: 'confirm', props: { title: 'Sure?' } }, [
      mk('Button', { tag: 'ok_btn', props: { label: 'OK' } }),
    ]),
  ]);
}

/** Three screens, tab/menu bodies and a screen link. */
export function multiScreen(): ComponentNode[] {
  resetIds();
  const home = screen('Home', 'home', [
    mk('Text', { tag: 'status', props: { content: 'Ready' } }),
    mk('Button', { tag: 'go_settings', props: { label: 'Settings' }, opensScreen: 'settings' }),
    mk('Tabs', { id: 'tabs1', tag: 'pages' }),
    mk('Box', { id: 'tb0', name: 'Dashboard body', showWhen: { nav: 'tabs1', item: 0 } }, [
      mk('Text', { tag: 'dash_text', props: { content: 'Dashboard content' } }),
    ]),
    mk('Box', { id: 'tb1', name: 'Agent body', showWhen: { nav: 'tabs1', item: 1 } }, [
      mk('Text', { tag: 'agent_text', props: { content: 'Agent content' } }),
      mk('Button', { tag: 'agent_btn', props: { label: 'Run' } }),
    ]),
    mk('Menu', {
      id: 'menu1',
      tag: 'side',
      props: { items: [{ label: 'One' }, { label: 'Two' }] },
    }),
    mk('Box', { id: 'mb0', showWhen: { nav: 'menu1', item: 0 } }, [
      mk('Text', { props: { content: 'Menu one body' } }),
    ]),
  ]);
  const settings = screen('Settings', 'settings', [
    mk('Text', { props: { content: 'Settings screen' } }),
    mk('TextInput', { tag: 'name_input' }),
    mk('Button', { tag: 'back_btn', props: { label: 'Back' }, opensScreen: 'home' }),
  ]);
  const about = screen('About us', undefined, [mk('Text', { props: { content: 'About' } })]);
  return [home, settings, about];
}

/** Layout cases: flex row/column with gap, justify and align, grid, absolute, wrap. */
export function layouts(): Record<string, ComponentNode> {
  resetIds();
  const items = (n: number, w = 6, h = 1) =>
    Array.from({ length: n }, (_, i) =>
      mk('Text', { id: `t${i}`, props: { content: `T${i}`, width: w, height: h } })
    );
  const wrap = (layout: Record<string, unknown>, children: ComponentNode[]) =>
    screen('L', undefined, [
      mk('Box', { id: 'box', props: { width: 40, height: 8 }, layout }, children),
    ]);
  return {
    row: wrap({ type: 'flexbox', direction: 'row', gap: 2 }, items(3)),
    column: wrap({ type: 'flexbox', direction: 'column', gap: 1 }, items(3)),
    center: wrap(
      { type: 'flexbox', direction: 'row', justify: 'center', align: 'center' },
      items(2)
    ),
    spaceBetween: wrap({ type: 'flexbox', direction: 'row', justify: 'space-between' }, items(3)),
    wrapped: wrap({ type: 'flexbox', direction: 'row', wrap: true, gap: 1 }, items(8, 8)),
    grid: wrap({ type: 'grid', columns: 2, rows: 2, gap: 1 }, items(4)),
    absolute: wrap(
      { type: 'absolute' },
      items(2).map((c, i) => {
        c.layout = { ...c.layout, x: 3 + i * 10, y: 2 + i } as typeof c.layout;
        return c;
      })
    ),
  };
}

export const ALL_TYPES: ComponentType[] = [
  'Screen',
  'Box',
  'Grid',
  'Spacer',
  'TextInput',
  'Button',
  'Checkbox',
  'Radio',
  'Select',
  'Toggle',
  'Text',
  'Spinner',
  'ProgressBar',
  'Table',
  'List',
  'Tree',
  'Menu',
  'Tabs',
  'Breadcrumb',
  'Modal',
];
