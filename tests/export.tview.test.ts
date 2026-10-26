import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '../src/types';
import { buildIR } from '../src/utils/export/ir';
import { tviewAdapter } from '../src/utils/export/exporters/tview';
import { mk, resetIds, screen } from './fixtures/build';
import { allComponents, layouts, multiScreen } from './fixtures/designs';
import { nastyDesign } from './fixtures/nasty';

function files(root: ComponentNode) {
  const ir = buildIR(root);
  return tviewAdapter.generate({ ir, source: [{ id: root.id, root }] });
}
const MINE = ['main.go', 'ui.go', 'ui_tview.go'];
/** The generated Go of the design (main + facade + tview UI), without the shared runtime. */
const mainGo = (root: ComponentNode) =>
  files(root)
    .filter((f) => MINE.includes(f.path))
    .map((f) => f.content)
    .join('\n');
const uiFile = (root: ComponentNode) => files(root).find((f) => f.path === 'ui_tview.go')!.content;

/** Replace string/rune literals and comments by empty ones so structure can be checked. */
function stripLiterals(src: string): string {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\n')
          throw new Error(`newline inside literal near: ${src.slice(i, i + 40)}`);
        if (src[j] === '\\') j++;
        j++;
      }
      if (j >= src.length) throw new Error('unterminated literal');
      out += c + c;
      i = j;
    } else if (c === '`') {
      const j = src.indexOf('`', i + 1);
      if (j < 0) throw new Error('unterminated raw string');
      out += '``';
      i = j;
    } else out += c;
  }
  return out;
}

/** Cheap structural checks for Go code we cannot compile here. */
function checkGo(src: string): void {
  const code = stripLiterals(src);
  const stack: string[] = [];
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  for (const ch of code) {
    if ('([{'.includes(ch)) stack.push(ch);
    else if (ch in pairs) expect(stack.pop(), `unbalanced ${ch}`).toBe(pairs[ch]);
  }
  expect(stack, 'unclosed brackets').toEqual([]);

  // every import is referenced
  const imports = [...src.matchAll(/^\s*(?:\w+\s+)?"([\w./-]+)"$/gm)]
    .map((m) => m[1])
    .filter((p) => !p.includes('"'));
  const importBlock = src.slice(
    src.indexOf('import ('),
    src.indexOf(')\n', src.indexOf('import ('))
  );
  for (const m of importBlock.matchAll(/"([^"]+)"/g)) {
    const pkg = m[1].includes('tcell') ? 'tcell' : m[1].split('/').pop()!;
    const body = code.slice(code.indexOf(')\n', code.indexOf('import (')));
    expect(body, `import ${m[1]} unused`).toMatch(new RegExp(`\\b${pkg}\\.`));
  }
  expect(imports.length).toBeGreaterThan(0);
  // time is imported only when used
  if (!src.includes('"time"')) expect(code).not.toMatch(/\btime\./);

  // every `:=` variable is used at least once more
  const seen = new Map<string, number>();
  for (const m of code.matchAll(/^\s*([A-Za-z_][\w]*(?:\s*,\s*[A-Za-z_][\w]*)*)\s*:=/gm)) {
    for (const name of m[1].split(',').map((s) => s.trim())) {
      if (name === '_') continue;
      seen.set(name, (seen.get(name) ?? 0) + 1);
    }
  }
  for (const m of code.matchAll(/\bfor\s+(\w+),\s*(\w+)\s*:=\s*range/g)) {
    // range variables: counted as declarations too
    for (const name of [m[1], m[2]]) if (name !== '_') seen.set(name, (seen.get(name) ?? 0) + 1);
  }
  for (const [name, decls] of seen) {
    const uses = (code.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length;
    expect(uses, `variable ${name} declared but not used`).toBeGreaterThan(decls);
  }
  // top-level structure
  expect(code).toMatch(/^package main$/m);
  expect(code).not.toMatch(/\bundefined\b|NaN|\[object/);
}

const allDesigns = (): [string, ComponentNode][] => [
  ['allComponents', allComponents()],
  ['nasty', nastyDesign()],
  ...Object.entries(layouts()),
  ...multiScreen().map((r, i) => [`multi${i}`, r] as [string, ComponentNode]),
];

describe('tview export', () => {
  it('ships main.go and go.mod', () => {
    expect(files(allComponents()).map((f) => f.path)).toEqual([
      'main.go',
      'ui.go',
      'ui_tview.go',
      'ui_runtime.go',
      'go.mod',
      'api.go',
    ]);
  });

  it('is structurally valid Go for every fixture', () => {
    for (const [name, root] of allDesigns()) {
      try {
        for (const f of files(root)) if (MINE.includes(f.path)) checkGo(f.content);
      } catch (e) {
        throw new Error(`${name}: ${(e as Error).message}`);
      }
    }
  });

  it('writes a parseable go.mod with pinned versions', () => {
    const mod = files(allComponents()).find((f) => f.path === 'go.mod')!.content;
    expect(mod).toMatch(/^module main_$/m);
    expect(mod).toMatch(/^go 1\.\d+$/m);
    expect(mod).toMatch(/github\.com\/rivo\/tview v\d+\.\d+\.\d+/);
    expect(mod).toMatch(/github\.com\/gdamore\/tcell\/v2 v\d+\.\d+\.\d+/);
    expect(mainGo(allComponents())).toContain('go mod tidy && go run .');
  });

  it('maps every component type to its tview widget', () => {
    const out = mainGo(allComponents());
    for (const needle of [
      'tview.NewTextView()',
      'tview.NewInputField()',
      'tview.NewButton(',
      'tview.NewCheckbox()',
      'tview.NewDropDown()',
      'tview.NewTable()',
      'tview.NewList()',
      'tview.NewTreeView()',
      'tview.NewTreeNode(',
      'tview.NewFlex()',
      'tview.NewGrid()',
      'tview.NewPages()',
      'tview.NewBox()',
      'SetInputCapture',
      'app.EnableMouse(true).Run()',
    ]) {
      expect(out, needle).toContain(needle);
    }
    // user code names become variables
    for (const v of [
      'status',
      'nameInput',
      'submitBtn',
      'agree',
      'results',
      'files',
      'navTree',
      'mainMenu',
      'crumbs',
      'confirm',
    ]) {
      expect(out, v).toMatch(new RegExp(`\\b${v} := `));
    }
    // modal is an overlay page, radios are mutually exclusive
    expect(out).toContain('pages.AddPage("confirm"');
    expect(out).toContain('other.SetChecked(false)');
    expect(out).toContain('[]*tview.Checkbox{optA, optB}');
  });

  it('animates spinners with a goroutine and imports time only then', () => {
    const out = mainGo(allComponents());
    expect(out).toContain('"time"');
    expect(out).toContain('app.QueueUpdateDraw');
    resetIds();
    const plain = uiFile(screen('P', undefined, [mk('Text', { props: { content: 'hi' } })]));
    expect(plain).not.toContain('"time"');
  });

  it('escapes user strings', () => {
    const out = mainGo(nastyDesign());
    expect(out).toContain(`tview.Escape("it's")`);
    expect(out).toContain('"back\\\\slash"');
    expect(out).toContain('new\\nline');
    expect(out).toContain('ünïcödé');
    // dynamic-colour text always goes through tview.Escape
    for (const m of out.matchAll(
      /NewTextView\(\)\.SetDynamicColors\(true\)[^\n]*SetText\(([^\n]*)\)$/gm
    )) {
      expect(m[1]).toContain('tview.Escape(');
    }
  });

  it('turns events into deduplicated stubs', () => {
    resetIds();
    const root = screen('S', undefined, [
      mk('Button', { tag: 'first', props: { label: 'A' }, events: { onClick: 'handleClick' } }),
      mk('Button', { tag: 'second', props: { label: 'B' }, events: { onClick: 'handleClick' } }),
      mk('TextInput', { tag: 'third', events: { onChange: 'on-change!' } }),
      mk('Text', { tag: 'func', props: { content: 'x' } }),
    ]);
    const out = mainGo(root);
    expect(out.match(/^func handleClick\(\) \{$/gm)).toHaveLength(1);
    expect(out).toContain('first.SetSelectedFunc(func() {');
    expect(out).toContain('func handlerOnChange() {');
    expect(out).toContain('func_ := ');
    checkGo(out);
  });

  it('maps layouts natively and as snapshots', () => {
    const L = layouts();
    const row = mainGo(L.row);
    expect(row).toContain('SetDirection(tview.FlexColumn)');
    expect(row).toMatch(/AddItem\(nil, 2, 0, false\)/); // gap
    const column = mainGo(L.column);
    expect(column).toContain('SetDirection(tview.FlexRow)');
    expect(column).toMatch(/AddItem\(nil, 1, 0, false\)/);
    // centre: flexible spacers on both sides
    expect(mainGo(L.center).match(/AddItem\(nil, 0, 1, false\)/g)!.length).toBeGreaterThanOrEqual(
      2
    );
    // space-between: flexible spacers between items
    expect(
      mainGo(L.spaceBetween).match(/AddItem\(nil, 0, 1, false\)/g)!.length
    ).toBeGreaterThanOrEqual(2);
    // grid
    const grid = mainGo(L.grid);
    expect(grid).toContain('tview.NewGrid().SetGap(1, 1)');
    expect(grid).toMatch(/SetColumns\(\d+, \d+\)/);
    expect(grid).toMatch(/AddItem\(\w+, 1, 1, 1, 1, 0, 0, false\)/);
    // wrap and absolute: nested rows
    expect(mainGo(L.wrapped)).toMatch(/\w+Row2 := tview\.NewFlex/);
    expect(mainGo(L.absolute)).toMatch(/Row1 := tview\.NewFlex/);
    for (const name of ['row', 'wrapped', 'absolute']) expect(mainGo(L[name])).toContain('T0');
  });

  it('applies colours, borders and padding', () => {
    resetIds();
    const root = screen('S', undefined, [
      mk(
        'Box',
        {
          tag: 'card',
          style: {
            border: true,
            borderStyle: 'double',
            borderColor: '#112233',
            backgroundColor: '#445566',
          },
          layout: { type: 'flexbox', padding: { top: 1, right: 2, bottom: 1, left: 2 } },
        },
        [
          mk('Text', {
            props: { content: 'hello' },
            style: { color: '#ff0000', bold: true, underline: true },
          }),
        ]
      ),
    ]);
    (root.style as { border?: boolean }).border = false;
    const out = mainGo(root);
    expect(out).toContain('card.SetBorder(true)');
    expect(out).toContain('card.SetBorderColor(tcell.GetColor("#112233"))');
    expect(out).toContain('card.SetBackgroundColor(tcell.GetColor("#445566"))');
    expect(out).toContain('card.SetBorderPadding(1, 1, 2, 2)');
    expect(out).toContain("tview.Borders.TopLeft = '╔'");
    expect(out).toContain('"[::bu]" + tview.Escape("hello") + "[::-]"');
    expect(out).toContain('SetTextColor(tcell.GetColor("#ff0000"))');
    checkGo(out);
  });

  it('generates the typed program API from the code names', () => {
    const ui = files(allComponents()).find((f) => f.path === 'ui.go')!.content;
    for (const field of [
      'Status *TextHandle',
      'NameInput *InputHandle',
      'SubmitBtn *ButtonHandle',
      'Agree *CheckHandle',
      'Results *TableHandle',
      'Confirm *ModalHandle',
    ]) {
      expect(ui, field).toContain(field);
    }
    expect(ui).toContain('core.Define("status", "Text"');
    expect(ui).toContain('"open": false');
    expect(ui).toContain('func (u *Ui) Start() error');
    expect(ui).toContain('func (u *Ui) Run(fn func(*Ui)) error');
    const tv = uiFile(allComponents());
    // user input is written back to the store and reported as an event, off the UI goroutine
    expect(tv).toContain('submitBtnC.Emit("click", nil)');
    expect(tv).toContain('nameInputC.UserSet("value", text)');
    expect(tv).toContain('if syncing {');
    expect(tv).toContain('gate(submitBtnC, submitBtn)');
    expect(tv).toContain('core.ToggleLog()');
    expect(tv).toContain('go t.app.QueueUpdateDraw(');
    expect(files(allComponents()).map((f) => f.path)).toContain('ui_runtime.go');
  });

  it('only exports visible components', () => {
    resetIds();
    const out = mainGo(
      screen('S', undefined, [
        mk('Text', { props: { content: 'SHOWN' } }),
        mk('Text', { hidden: true, props: { content: 'GONE' } }),
      ])
    );
    expect(out).toContain('SHOWN');
    expect(out).not.toContain('GONE');
  });
});
