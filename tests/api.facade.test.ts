import { describe, expect, it } from 'vitest';
import { exportToFiles } from '../src/utils/export/codeExporter';
import { apiDesign } from './fixtures/apiDesign';
import { allComponents } from './fixtures/designs';

const FRAMEWORKS: Record<string, { file: string; wired: RegExp; method: string }> = {
  textual: { file: 'ui_api.py', wired: /self\.api = Api\(self\)/, method: 'def submit_btn_was_clicked' },
  ink: { file: 'src/api.ts', wired: /this\.api = new Api\(this\)/, method: 'submitBtnWasClicked()' },
  opentui: { file: 'src/api.ts', wired: /this\.api = new Api\(this\)/, method: 'submitBtnWasClicked()' },
  blessed: { file: 'api.js', wired: /this\.api = new Api\(this\)/, method: 'submitBtnWasClicked()' },
  bubbletea: { file: 'api.go', wired: /ui\.Api = newApi\(ui\)/, method: 'SubmitBtnWasClicked()' },
  tview: { file: 'api.go', wired: /ui\.Api = newApi\(ui\)/, method: 'SubmitBtnWasClicked()' },
  ratatui: { file: 'src/api.rs', wired: /api: Api::new\(&rt\)/, method: 'pub fn submit_btn_was_clicked' },
};

describe('flat Api facade (ui.api)', () => {
  for (const [id, f] of Object.entries(FRAMEWORKS)) {
    it(`${id}: ships ${f.file}, wired into Ui, with one method per action`, () => {
      const files = exportToFiles(apiDesign(), id);
      const api = files.find((x) => x.path === f.file);
      expect(api, f.file).toBeDefined();
      expect(api!.content).toContain(f.method);
      const joined = files.map((x) => x.content).join('\n');
      expect(joined).toMatch(f.wired);
      expect(files.find((x) => x.path === 'API.md')!.content).toContain('ui.api');
    });
  }

  it('is left out when no component has a code name', () => {
    const files = exportToFiles(allComponents(), 'ink');
    const bare = exportToFiles({ ...allComponents(), children: [] }, 'ink');
    expect(files.some((x) => x.path === 'src/api.ts')).toBe(true);
    expect(bare.some((x) => x.path === 'src/api.ts')).toBe(false);
  });
});
