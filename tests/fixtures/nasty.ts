// Text that breaks naive code generators: quotes, backslashes, braces, angle brackets,
// template syntax, shell/format characters and line breaks.

import type { ComponentNode } from '../../src/types';
import { mk, resetIds, screen } from './build';

export const NASTY_STRINGS = [
  'He said "hi"',
  "it's",
  'back\\slash',
  'new\nline',
  '{braces} and {{double}}',
  '<angle> & ampersand',
  '${dollar} `tick`',
  '%s %d {} {0}',
  '/* comment */ // line',
  'tab\there',
  'ünïcödé ✓ 日本語 🔥',
];

/** One of each text-bearing component, all filled with nasty strings. */
export function nastyDesign(): ComponentNode {
  resetIds();
  const n = NASTY_STRINGS;
  return screen(n[0], undefined, [
    mk('Text', { props: { content: n[1] } }),
    mk('Button', { props: { label: n[2] } }),
    mk('TextInput', { props: { placeholder: n[3], value: n[4] } }),
    mk('Checkbox', { props: { label: n[5] } }),
    mk('Radio', { props: { label: n[6] } }),
    mk('Toggle', { props: { label: n[7] } }),
    mk('Select', { props: { options: [n[8], n[9]], value: n[8] } }),
    mk('Table', { props: { columns: [n[0], n[1]], rows: [[n[2], n[3]]] } }),
    mk('List', { props: { items: [{ label: n[4], icon: n[5], hotkey: n[6] }] } }),
    mk('Tree', { props: { items: [{ label: n[7], children: [{ label: n[8], children: [] }] }] } }),
    mk('Menu', { props: { items: [{ label: n[9], icon: '', hotkey: n[10] }] } }),
    mk('Tabs', { props: { tabs: [{ label: n[10] }, { label: n[0] }] } }),
    mk('Breadcrumb', { props: { items: [{ label: n[1] }, { label: n[2] }], separator: n[3] } }),
    mk('Modal', { props: { title: n[4] } }, [mk('Text', { props: { content: n[5] } })]),
  ]);
}
