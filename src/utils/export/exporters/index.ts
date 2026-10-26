// All framework exporters. Add a new framework by writing an `ExportAdapter` and listing it here.

import type { ExportAdapter } from '../adapter';
import { TEXTUAL_RUNTIME_FILENAME, TEXTUAL_RUNTIME_SOURCE } from '../api/textualRuntime';
import { renderFacade } from '../api/facade';
import { buildApiModel } from '../api/model';
import { blessedAdapter } from './blessed';
import { bubbleteaAdapter } from './bubbletea';
import { inkAdapter } from './ink';
import { opentuiAdapter } from './opentui';
import { ratatuiAdapter } from './ratatui';
import { exportToTextual } from './textual';
import { tviewAdapter } from './tview';

const textualAdapter: ExportAdapter = {
  id: 'textual',
  label: 'Textual (Python)',
  language: 'py',
  verification: 'run',
  multiScreen: true,
  generate: ({ ir, source }) => {
    const handles = buildApiModel(ir).handles;
    return [
      { path: 'ui.py', content: exportToTextual(source) },
      { path: TEXTUAL_RUNTIME_FILENAME, content: TEXTUAL_RUNTIME_SOURCE },
      ...(handles.length
        ? [{ path: 'ui_api.py', content: renderFacade({ lang: 'python', handles, member: (h) => h.tag }).code }]
        : []),
    ];
  },
};

export const ADAPTERS: readonly ExportAdapter[] = [
  opentuiAdapter,
  inkAdapter,
  bubbleteaAdapter,
  blessedAdapter,
  textualAdapter,
  ratatuiAdapter,
  tviewAdapter,
];

export function getAdapter(id: string): ExportAdapter | undefined {
  return ADAPTERS.find((a) => a.id === id);
}
