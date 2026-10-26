// The program API of the Bubble Tea export against the real toolchain: the project of the API
// design is generated, the Go scenario (tests/apitests/bubbletea, S1..S14) is run headless, and
// the other designs are vetted and built. Skipped when `go` is not installed. The first run
// downloads the Go modules (`go mod tidy`).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '../src/types';
import { exportToFiles } from '../src/utils/export/codeExporter';
import { BUBBLETEA_RESERVED_UI } from '../src/utils/export/exporters/bubbletea';
import { GO_RUNTIME_SOURCE } from '../src/utils/export/api/go/runtime';
import { apiDesign } from './fixtures/apiDesign';
import { allComponents, layouts } from './fixtures/designs';
import { nastyDesign } from './fixtures/nasty';
import { findGo, runGo, writeProject } from './helpers/go';

const go = findGo();
if (!go) console.warn('api.bubbletea: `go` is not on PATH, the Go tests are skipped');
const suite = go ? describe : describe.skip;

const scenario = readFileSync(join(__dirname, 'apitests', 'bubbletea', 'scenario_test.go'), 'utf8');
const gen = (root: ComponentNode) => exportToFiles(root, 'bubbletea');

function prepare(files: { path: string; content: string }[]): string {
  const dir = writeProject(files);
  const tidy = runGo(['mod', 'tidy'], dir);
  expect(tidy.output, 'go mod tidy').toBe('');
  return dir;
}

describe('runtime source', () => {
  it('is framework-neutral and shipped with every export', () => {
    expect(GO_RUNTIME_SOURCE).not.toMatch(/bubbletea|tview|tcell|lipgloss/);
    expect(gen(apiDesign()).find((f) => f.path === 'ui_runtime.go')!.content).toBe(
      GO_RUNTIME_SOURCE
    );
    expect(gen(allComponents()).map((f) => f.path)).toEqual([
      'main.go',
      'ui.go',
      'api.go',
      'ui_runtime.go',
      'go.mod',
      'API.md',
    ]);
  });

  it('lists every exported name of Ui / Core as reserved', () => {
    const ui = gen(apiDesign()).find((f) => f.path === 'ui.go')!.content;
    const names = [
      ...GO_RUNTIME_SOURCE.matchAll(/^func \(\w+ \*Core\) ([A-Z]\w*)/gm),
      ...ui.matchAll(/^func \(\w+ \*Ui\) ([A-Z]\w*)/gm),
    ].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(20);
    for (const n of names) expect(BUBBLETEA_RESERVED_UI, n).toContain(n);
    expect(BUBBLETEA_RESERVED_UI).toContain('Log');
  });
});

suite('bubbletea program API (real Go)', () => {
  it('runs the scenario S1..S14 headless', () => {
    const dir = prepare([...gen(apiDesign()), { path: 'scenario_test.go', content: scenario }]);
    const vet = runGo(['vet', './...'], dir);
    expect(vet.output, 'go vet').toBe('');
    const test = runGo(['test', '-count=1', '-v', './...'], dir);
    expect(test.ok, test.output).toBe(true);
    for (let i = 1; i <= 18; i++) {
      const step = `S${String(i).padStart(2, '0')}_`;
      expect(test.output, step).toMatch(new RegExp(`--- PASS: TestScenario/${step}`));
    }
    expect(test.output).toMatch(/--- PASS: TestCanvasPlacement/);
  }, 600_000);

  it('vets and builds the other designs', () => {
    const designs: Record<string, ComponentNode> = {
      allComponents: allComponents(),
      nasty: nastyDesign(),
      ...Object.fromEntries(Object.entries(layouts()).map(([k, v]) => [`layout_${k}`, v])),
    };
    // Layout fixtures are generated together so that the module cache is hit once.
    for (const [name, root] of Object.entries(designs)) {
      const dir = prepare(gen(root));
      const vet = runGo(['vet', './...'], dir);
      expect(vet.output, `${name}: go vet`).toBe('');
      const build = runGo(['build', './...'], dir);
      expect(build.output, `${name}: go build`).toBe('');
    }
  }, 1_200_000);
});
