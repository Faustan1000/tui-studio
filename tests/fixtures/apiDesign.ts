// The design of the API scenario (docs/API_SCENARIO.md).

import type { ComponentNode } from '../../src/types';
import { mk, resetIds, screen } from './build';

export function apiDesign(): ComponentNode {
  resetIds();
  return screen('API demo', 'demo', [
    mk('Text', { tag: 'status', props: { content: 'Ready' } }),
    mk('TextInput', { tag: 'name_input', props: { placeholder: 'your name' } }),
    mk('Button', { tag: 'submit_btn', props: { label: 'Send' } }),
    mk('Checkbox', { tag: 'agree', props: { label: 'I agree' } }),
    mk('Select', { tag: 'color', props: { options: ['Red', 'Green', 'Blue'] } }),
    mk('ProgressBar', { tag: 'progress' }),
    mk('Table', { tag: 'results' }),
    mk('List', { tag: 'files' }),
    mk('Tabs', { tag: 'pages' }),
    mk('Box', { tag: 'panel' }, [
      mk('Text', { tag: 'inner', props: { content: 'Inside the panel' } }),
    ]),
    mk('Modal', { tag: 'confirm', props: { title: 'Sure?' } }, [
      mk('Text', { props: { content: 'Really?' } }),
    ]),
  ]);
}
