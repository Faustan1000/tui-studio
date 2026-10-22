// The program API of the tview export, run for real: the generated Go project is written to a
// temp directory, `go vet` and `go build` check every fixture, and the scenario of
// docs/API_SCENARIO.md (tests/apitests/tview/scenario_test.go) runs with `go test` against the
// real tview application on a tcell simulation screen. Skipped when Go is not installed
// (set TUISTUDIO_GO to a go binary to override the lookup). `go mod tidy` downloads tview.

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ComponentNode } from '../src/types';
import { exportToFiles } from '../src/utils/export/codeExporter';
import { apiDesign } from './fixtures/apiDesign';
import { allComponents, layouts } from './fixtures/designs';
import { nastyDesign } from './fixtures/nasty';

const GO = process.env.TUISTUDIO_GO || 'go';
const ENV = {
  ...process.env,
  PATH: [process.env.PATH ?? '', join(homedir(), 'scoop', 'shims')].join(delimiter),
  GOFLAGS: '-mod=mod',
};

function run(args: string[], cwd: string, timeout = 240_000) {
  return spawnSync(GO, args, { cwd, env: ENV, encoding: 'utf8', timeout });
}

const hasGo = !run(['version'], tmpdir(), 15_000).error;
if (!hasGo) console.warn('api.tview.test: Go is not installed, skipping (set TUISTUDIO_GO)');

const ROOT = mkdtempSync(join(tmpdir(), 'tuistudio-tview-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function generate(name: string, root: ComponentNode): string {
  const dir = join(ROOT, name);
  rmSync(dir, { recursive: true, force: true });
  for (const f of exportToFiles(root, 'tview')) {
    const target = join(dir, f.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.content, 'utf8');
  }
  const tidy = run(['mod', 'tidy'], dir);
  expect(tidy.status, `go mod tidy\n${tidy.stdout}\n${tidy.stderr}`).toBe(0);
  return dir;
}

describe.skipIf(!hasGo)('tview program API against real tview', () => {
  const GO_TESTS = resolve(__dirname, 'apitests', 'tview');
  const copyTests = (dir: string, names: string[]) => {
    for (const n of names) copyFileSync(join(GO_TESTS, n), join(dir, n));
  };

  it('passes the scenario S1..S14 on a simulation screen', () => {
    const dir = generate('api', apiDesign());
    copyTests(dir, ['helpers_test.go', 'scenario_test.go', 'mouse_test.go', 'scroll_test.go']);
    const vet = run(['vet', './...'], dir);
    expect(vet.status, `go vet\n${vet.stdout}\n${vet.stderr}`).toBe(0);
    const r = run(['test', '-count=1', '-timeout', '200s', '-v', './...'], dir);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    const steps = Array.from({ length: 14 }, (_, i) => `S${i + 1}`);
    for (const step of steps) {
      expect(out, step).toMatch(new RegExp(`--- PASS: TestScenario/${step}_`));
    }
    // S15: a left click on every interactive component; S16: the screen is filled
    for (const name of [
      'click_button_and_input',
      'click_checkbox',
      'click_select',
      'click_list',
      'click_table',
      'click_tabs',
      'muted_readonly_ignore_clicks',
      'dialogs_take_the_clicks',
    ]) {
      expect(out, name).toMatch(new RegExp(`--- PASS: TestMouse/S15_${name}`));
    }
    expect(out).toMatch(/--- PASS: TestFill\/S16_fill_80/);
    expect(out).toMatch(/--- PASS: TestFill\/S16_fill_120/);
    // S17: scrolling (wheel, keys, click and Tab after scrolling, scrollbar only when needed); S18: style
    expect(out).toMatch(/--- PASS: TestScroll\/S17_scroll_80/);
    expect(out).toMatch(/--- PASS: TestScroll\/S17_scroll_120/);
    expect(out).toMatch(/--- PASS: TestScroll\/S17_no_scrollbar_when_it_fits/);
    expect(out).toMatch(/--- PASS: TestStyle/);
    expect(out).not.toMatch(/--- FAIL/);
  }, 400_000);

  it('S15: clicks on radio, toggle, menu, tree, table and list (allComponents)', () => {
    const dir = generate('all_mouse', allComponents());
    copyTests(dir, ['helpers_test.go', 'mouse_all_test.go']);
    const r = run(['test', '-count=1', '-timeout', '120s', '-v', './...'], dir);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    for (const name of [
      'click_radio',
      'click_toggle',
      'click_menu',
      'click_tree',
      'click_table_and_list',
    ]) {
      expect(out, name).toMatch(new RegExp(`--- PASS: TestMouseAll/S15_${name}`));
    }
  }, 300_000);

  describe('go vet and go build', () => {
    const designs: [string, () => ComponentNode][] = [
      ['api', apiDesign],
      ['all', allComponents],
      ['nasty', nastyDesign],
      ...Object.keys(layouts()).map(
        (k) => [`layout_${k}`, () => layouts()[k]] as [string, () => ComponentNode]
      ),
    ];
    for (const [name, make] of designs) {
      it(`compiles ${name}`, () => {
        const dir = generate(`build_${name}`, make());
        const vet = run(['vet', './...'], dir);
        expect(vet.status, `go vet\n${vet.stdout}\n${vet.stderr}`).toBe(0);
        const build = run(['build', '-o', join(dir, 'app.bin'), '.'], dir);
        expect(build.status, `go build\n${build.stdout}\n${build.stderr}`).toBe(0);
      }, 300_000);
    }
  });
});
