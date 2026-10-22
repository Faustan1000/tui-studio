import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '../src/types';
import { exportToFiles } from '../src/utils/export/codeExporter';
import { mk, resetIds, screen } from './fixtures/build';
import { allComponents, layouts } from './fixtures/designs';
import { nastyDesign } from './fixtures/nasty';
import { assertParses } from './helpers/syntax';

const gen = (root: ComponentNode) => exportToFiles(root, 'opentui');
const index = (root: ComponentNode) => gen(root).find((f) => f.path === 'src/index.tsx')!.content;
const one = (node: ComponentNode, over: Partial<ComponentNode> = {}) => {
  resetIds();
  return index(screen('S', undefined, [{ ...node, ...over } as ComponentNode]));
};

describe('opentui export', () => {
  it('ships index.tsx, package.json and tsconfig.json', () => {
    const files = gen(allComponents());
    expect(files.map((f) => f.path)).toEqual([
      'src/index.tsx',
      'src/ui-runtime.tsx',
      'package.json',
      'tsconfig.json',
    ]);
    const pkg = JSON.parse(files[2].content);
    expect(pkg.dependencies['@opentui/core']).toBe('0.6.6');
    expect(pkg.dependencies['@opentui/react']).toBe('0.6.6');
    expect(pkg.dependencies.react).toMatch(/^\d/);
    expect(pkg.scripts.start).toContain('bun run src/index.tsx');
    expect(JSON.parse(files[3].content).compilerOptions.jsxImportSource).toBe('@opentui/react');
  });

  it('explains how to run and uses the real API', () => {
    const out = index(allComponents());
    expect(out).toContain('bun install && bun run src/index.tsx');
    expect(out).toContain('useKeyboard');
    expect(out).toContain('ui.stop()');
    expect(out).toContain('ui.handleKey(key)');
    const runtime = gen(allComponents()).find((f) => f.path === 'src/ui-runtime.tsx')!.content;
    expect(runtime).toContain('createCliRenderer');
    expect(runtime).toContain('createRoot(renderer)');
    expect(runtime).toContain('renderer?.destroy()');
  });

  it('ships the same runtime for every design', () => {
    const runtime = (root: ComponentNode) =>
      gen(root).find((f) => f.path === 'src/ui-runtime.tsx')!.content;
    expect(runtime(allComponents())).toBe(runtime(nastyDesign()));
  });

  it('generates a typed facade with one handle per code name', () => {
    const out = index(allComponents());
    expect(out).toContain('export class Ui extends UiCore');
    expect(out).toContain('readonly submitBtn: SubmitBtnHandle;');
    expect(out).toContain('onClick(handler: UiHandler)');
    expect(out).toContain('set text(value: string)');
    expect(out).toContain('this._set("text", String(value))');
    expect(out).toContain('get activeTab(): number');
    expect(out).toContain('get isOpen(): boolean');
    expect(out).toContain(
      'this.agree = this.add(new AgreeHandle(this), { state: "active", checked: false'
    );
    // Components with a code name read the store; the others keep local state.
    expect(out).toContain(
      'useSlice<{ state: UiState; checked: boolean; label: string }>(ui, "agree")'
    );
    resetIds();
    const plain = index(screen('S', undefined, [mk('Checkbox'), mk('TextInput')]));
    expect(plain).toContain('useState(false)');
    expect(plain).not.toContain('useSlice<{ state');
  });

  it('parses every generated file', () => {
    assertParses(index(allComponents()), 'tsx', 'index.tsx');
    assertParses(index(nastyDesign()), 'tsx', 'nasty');
    for (const f of gen(allComponents()))
      if (f.path.endsWith('.json')) expect(() => JSON.parse(f.content)).not.toThrow();
  });

  it('uses the native elements', () => {
    const out = index(allComponents());
    for (const tag of ['<box', '<text', '<input', '<select'])
      expect(out).toContain(tag);
    expect(out).toContain('onInput=');
    expect(out).toContain('focused={focusId === "name_input"}');
    expect(out).toContain('title={confirmS.title}');
    expect(out).toContain('title: "Sure?"');
    expect(out).toContain('position="absolute"');
  });

  it('keeps code names as state and event names as stubs', () => {
    const out = index(allComponents());
    expect(out).toContain('const nameInputS = useSlice');
    expect(out).toContain('case "submit_btn":');
    expect(out).toContain('ui.emit("submit_btn", "click", null, [handleClick])');
    resetIds();
    const dup = screen('S', undefined, [
      mk('Button', { events: { onClick: 'on save!' } }),
      mk('Button', { events: { onClick: 'on save!' } }),
    ]);
    const o = index(dup);
    expect(o.match(/^function \w+\(_value/gm)).toHaveLength(1);
    expect(o).toContain('function onSave(');
  });

  it('renders widgets with their text', () => {
    const t = one(mk('Table', { props: { columns: ['A', 'B'], rows: [['1', '2']] } }));
    expect(t).toContain('"A  B"');
    expect(t).toContain('"1  2"');
    expect(one(mk('ProgressBar', { props: { value: 50, max: 100, width: 10 } }))).toContain('50%');
    expect(one(mk('Spinner'))).toContain('<SpinnerText');
    expect(
      one(
        mk('Text', {
          props: { content: 'Hi' },
          style: { color: '#ff0000', bold: true, italic: true },
        })
      )
    ).toMatch(
      /fg="#ff0000" attributes=\{TextAttributes\.BOLD \| TextAttributes\.ITALIC\} content=\{"Hi"\}/
    );
  });

  it('maps borders', () => {
    const box = (kind: string) =>
      one(mk('Box', { style: { border: true, borderStyle: kind, borderColor: '#112233' } }));
    expect(box('bold')).toContain('borderStyle="heavy"');
    expect(box('double')).toContain('borderStyle="double"');
    expect(box('rounded')).toContain('borderStyle="rounded"');
    expect(box('single')).toContain('borderColor="#112233"');
  });

  it('maps flex layout natively', () => {
    const L = layouts();
    const row = index(L.row);
    expect(row).toContain('flexDirection="row"');
    expect(row).toContain('gap={2}');
    expect(row).toContain('width={40}');
    const center = index(L.center);
    expect(center).toContain('justifyContent="center"');
    expect(center).toContain('alignItems="center"');
    expect(index(L.spaceBetween)).toContain('justifyContent="space-between"');
    expect(index(L.wrapped)).toContain('flexWrap="wrap"');
    expect(index(L.column)).toContain('flexDirection="column"');
  });

  it('maps padding per side and fill', () => {
    resetIds();
    const out = index(
      screen('S', undefined, [
        mk(
          'Box',
          {
            props: { width: 'fill' },
            layout: {
              type: 'flexbox',
              direction: 'row',
              padding: { top: 1, right: 2, bottom: 0, left: 3 },
            },
          },
          [mk('Spacer', { props: { width: 'fill', height: 'auto' } })]
        ),
      ])
    );
    expect(out).toContain('paddingTop={1}');
    expect(out).toContain('paddingRight={2}');
    expect(out).toContain('paddingLeft={3}');
    expect(out).not.toContain('paddingBottom');
    expect(out).toContain('flexGrow={1}');
  });

  it('builds grids from rows and columns of boxes', () => {
    const out = index(layouts().grid);
    expect(out.match(/flexDirection="row" flexGrow=\{1\}/g)).toHaveLength(2);
    expect(out).toContain('width="50%"');
    expect(out).toContain('gap={1}');
    for (const t of ['T0', 'T1', 'T2', 'T3']) expect(out).toContain(`"${t}"`);
  });

  it('positions absolute children', () => {
    const out = index(layouts().absolute);
    expect(out).toContain('position="absolute" left={3} top={2}');
    expect(out).toContain('position="absolute" left={13} top={3}');
  });

  it('skips hidden nodes', () => {
    resetIds();
    const out = index(
      screen('S', undefined, [mk('Text', { hidden: true, props: { content: 'GONE' } })])
    );
    expect(out).not.toContain('GONE');
  });

  it('escapes user text', () => {
    const out = index(nastyDesign());
    expect(out).toContain('He said \\"hi\\"');
    expect(out).toContain('${dollar} `tick`');
    expect(out).toContain('new' + String.fromCharCode(92) + 'nline');
    expect(out).not.toMatch(/content=\{"[^"\n]*\n/);
  });
});
