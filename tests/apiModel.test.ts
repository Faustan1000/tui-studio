import { describe, expect, it } from 'vitest';
import {
  apiEventMethod,
  apiMember,
  apiName,
  buildApiModel,
  safeIdent,
} from '../src/utils/export/api/model';
import { API_SPEC } from '../src/utils/export/api/spec';
import { buildIR } from '../src/utils/export/ir';
import { mk, resetIds, screen } from './fixtures/build';
import { allComponents, multiScreen } from './fixtures/designs';
import { ALL_TYPES } from './fixtures/designs';

const handle = (tag: string) =>
  buildApiModel(buildIR(allComponents())).handles.find((h) => h.tag === tag)!;

describe('api spec', () => {
  it('covers every component type', () => {
    for (const t of ALL_TYPES) expect(API_SPEC[t], t).toBeDefined();
  });

  it('property and event names are snake_case and unique per component', () => {
    for (const [type, spec] of Object.entries(API_SPEC)) {
      const names = [...spec.properties.map((p) => p.name), ...spec.events.map((e) => e.name)];
      expect(new Set(names).size, type).toBe(names.length);
      for (const n of names) expect(n, type).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });

  it('never offers readonly where the user cannot edit anything', () => {
    for (const t of ['Button', 'ProgressBar'] as const) {
      expect(API_SPEC[t].states).not.toContain('readonly');
    }
  });
});

describe('api model', () => {
  const model = buildApiModel(buildIR(allComponents()));

  it('has a handle for every component with a code name', () => {
    expect(model.handles.map((h) => h.tag)).toEqual([
      'status',
      'name_input',
      'submit_btn',
      'agree',
      'opt_a',
      'opt_b',
      'color',
      'dark',
      'progress',
      'busy',
      'results',
      'files',
      'nav_tree',
      'main_menu',
      'pages',
      'crumbs',
      'cells',
      'panel',
      'confirm',
      'ok_btn',
    ]);
  });

  it('leaves out components without a code name and the screen root', () => {
    resetIds();
    const tree = screen('S', 'only_screen', [mk('Text'), mk('Button', { tag: 'go' })]);
    const m = buildApiModel(buildIR(tree));
    expect(m.handles.map((h) => h.tag)).toEqual(['go']);
    expect(m.screens.map((s) => s.tag)).toEqual(['only_screen']);
  });

  it('takes initial values from the design', () => {
    expect(handle('status').properties).toEqual([{ name: 'text', type: 'str', initial: 'Ready' }]);
    expect(handle('submit_btn').properties[0].initial).toBe('Send');
    expect(handle('files').properties.find((p) => p.name === 'items')!.initial).toEqual([
      'Item 1',
      'Item 2',
      'Item 3',
    ]);
    expect(handle('progress').properties.map((p) => [p.name, p.initial])).toEqual([
      ['value', 0],
      ['max', 100],
    ]);
    expect(handle('agree').properties.find((p) => p.name === 'checked')!.initial).toBe(false);
    expect(handle('pages').properties[0]).toMatchObject({ name: 'active_tab', initial: 0 });
    expect(handle('results').properties.find((p) => p.name === 'rows')!.initial).toEqual([
      ['Cell 1', 'Cell 2'],
      ['Cell 3', 'Cell 4'],
    ]);
  });

  it('knows the events and the handler name typed in the editor', () => {
    expect(handle('submit_btn').events).toEqual([{ name: 'click', editorHandler: 'handleClick' }]);
    expect(handle('name_input').events.map((e) => e.name)).toEqual(['change', 'submit']);
    expect(handle('status').events).toEqual([]);
  });

  it('starts hidden or muted as designed', () => {
    resetIds();
    const tree = screen('S', undefined, [
      mk('Text', { tag: 'secret', hidden: true }),
      mk('Button', { tag: 'off', props: { disabled: true } }),
      mk('Button', { tag: 'on' }),
    ]);
    const states = Object.fromEntries(
      buildApiModel(buildIR(tree)).handles.map((h) => [h.tag, h.initialState])
    );
    expect(states).toEqual({ secret: 'hidden', off: 'muted', on: 'active' });
  });

  it('collects handles of all screens', () => {
    const screens = multiScreen().map((root, i) => ({ id: `s${i}`, root }));
    const m = buildApiModel(buildIR(screens));
    expect(m.screens.map((s) => s.tag)).toEqual(['home', 'settings']);
    expect(m.handles.map((h) => h.tag)).toContain('back_btn');
  });
});

describe('api names', () => {
  it('re-cases code names and keeps the typed capitalisation', () => {
    expect(apiName('submit_btn', 'snake')).toBe('submit_btn');
    expect(apiName('submit_btn', 'camel')).toBe('submitBtn');
    expect(apiName('submit_btn', 'pascal')).toBe('SubmitBtn');
    expect(apiName('Name_input', 'camel')).toBe('nameInput');
    expect(apiName('okBtn', 'pascal')).toBe('OkBtn');
    expect(apiName('name2_x', 'camel')).toBe('name2X');
    expect(apiName('end_', 'camel')).toBe('end_');
  });

  it('builds member and event names', () => {
    expect(apiMember('active_tab', 'camel')).toBe('activeTab');
    expect(apiMember('active_tab', 'pascal', 'set')).toBe('SetActiveTab');
    expect(apiMember('text', 'snake', 'set')).toBe('set_text');
    expect(apiEventMethod('click', 'camel')).toBe('onClick');
    expect(apiEventMethod('click', 'pascal')).toBe('OnClick');
    expect(apiEventMethod('click', 'snake')).toBe('on_click');
  });

  it('protects keywords per language', () => {
    expect(safeIdent('type', 'rust')).toBe('type_');
    expect(safeIdent('type', 'go')).toBe('type_');
    expect(safeIdent('type', 'ts')).toBe('type');
    expect(safeIdent('class', 'ts')).toBe('class_');
    expect(safeIdent('ok', 'go')).toBe('ok');
  });
});
