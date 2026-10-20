import { describe, expect, it } from 'vitest';
import { exportToFiles } from '../src/utils/export/codeExporter';
import { allComponents, multiScreen } from './fixtures/designs';

describe('textual export', () => {
  it('ships ui.py and the runtime', () => {
    const files = exportToFiles(allComponents(), 'textual');
    expect(files.map((f) => f.path)).toEqual(['ui.py', 'ui_runtime.py']);
  });

  it('exposes every code name as a handle', () => {
    const ui = exportToFiles(allComponents(), 'textual')[0].content;
    for (const tag of ['status', 'name_input', 'submit_btn', 'agree', 'results', 'pages']) {
      expect(ui).toContain(tag);
    }
  });

  it('exports every screen of a project', () => {
    const screens = multiScreen().map((root) => ({ id: root.id, root }));
    const ui = exportToFiles(screens[0].root, 'textual', screens)[0].content;
    expect(ui).toContain('settings');
  });
});
