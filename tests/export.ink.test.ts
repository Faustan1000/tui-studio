import { describe, expect, it } from 'vitest';
import { exportToFiles } from '../src/utils/export/codeExporter';
import { mk, resetIds, screen } from './fixtures/build';
import { apiDesign } from './fixtures/apiDesign';
import { allComponents, layouts } from './fixtures/designs';
import { nastyDesign } from './fixtures/nasty';
import { assertParses } from './helpers/syntax';

const app = (root = allComponents()) =>
  exportToFiles(root, 'ink').find((f) => f.path === 'src/app.tsx')!.content;
const one = (child: ReturnType<typeof mk>) => app(screen('S', undefined, [child]));

describe('ink export', () => {
  it('ships app, package.json and tsconfig', () => {
    const files = exportToFiles(allComponents(), 'ink');
    expect(files.map((f) => f.path)).toEqual([
      'src/app.tsx',
      'src/ui-runtime.ts',
      'package.json',
      'tsconfig.json',
    ]);
    const pkg = JSON.parse(files[2].content);
    expect(pkg.type).toBe('module');
    expect(pkg.scripts.start).toContain('tsx');
    for (const d of ['ink', 'react', 'ink-select-input', 'ink-spinner']) {
      expect(pkg.dependencies[d], d).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(() => JSON.parse(files[3].content)).not.toThrow();
    expect(pkg.dependencies).not.toHaveProperty('ink-text-input');
  });

  it('only lists packages it uses', () => {
    resetIds();
    const files = exportToFiles(screen('S', undefined, [mk('Text')]), 'ink');
    const pkg = JSON.parse(files[2].content);
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['ink', 'react']);
    expect(files[0].content).not.toContain('ink-select-input');
  });

  it('uses code names for state and event handlers once', () => {
    resetIds();
    const out = app(
      screen('S', undefined, [
        mk('Checkbox', { name: 'Plain box' }),
        mk('Button', { events: { onClick: 'handleClick' } }),
        mk('Button', { events: { onClick: 'handleClick' } }),
      ])
    );
    expect(out).toContain('const [plainBox, setPlainBox] = useState(false)');
    expect(out.match(/function handleClick\(\) \{ \/\* TODO \*\/ \}/g)).toHaveLength(1);
    expect(out).toContain('handleClick();');
  });

  it('maps layout natively', () => {
    const L = layouts();
    expect(app(L.row)).toMatch(/flexDirection="row" gap=\{2\}/);
    expect(app(L.column)).toMatch(/flexDirection="column" gap=\{1\}/);
    expect(app(L.center)).toContain('justifyContent="center"');
    expect(app(L.center)).toContain('alignItems="center"');
    expect(app(L.spaceBetween)).toContain('justifyContent="space-between"');
    expect(app(L.wrapped)).toContain('flexWrap="wrap"');
    expect(app(L.grid)).toContain('flexBasis={0}');
    expect(app(L.grid)).toContain('rowGap={1}');
    const abs = app(L.absolute);
    expect(abs).toContain('position="absolute"');
    expect(abs).toContain('marginLeft={2}');
    expect(app(L.row)).toContain('width={40} height={8}');
  });

  it('maps fill to flexGrow or percent by parent direction', () => {
    resetIds();
    const out = app(
      screen('S', undefined, [
        mk('Box', { layout: { type: 'flexbox', direction: 'row' } }, [
          mk('Spacer', { props: { width: 'fill' } }),
        ]),
        mk('Box', { props: { width: 'fill', height: 'fill' } }),
      ])
    );
    expect(out).toContain('<Box flexGrow={1} height={1} flexShrink={0} />');
    expect(out).toContain('width="100%" flexGrow={1}');
  });

  it('maps style and borders', () => {
    const out = one(
      mk('Box', {
        style: { border: true, borderStyle: 'rounded', borderColor: '#ff0000', borderTop: false },
      })
    );
    expect(out).toContain('borderStyle="round"');
    expect(out).toContain('borderColor="#ff0000"');
    expect(out).toContain('borderTop={false}');
    const t = one(
      mk('Text', {
        style: { color: '#00ff00', bold: true, italic: true, underline: true, strikethrough: true },
      })
    );
    expect(t).toContain('color="#00ff00" bold italic underline strikethrough');
  });

  it('writes interactive widgets', () => {
    const out = app();
    expect(out).toContain('<Field value={core.str("name_input", "value")}');
    expect(out).toContain('readonly nameInput: TextInputHandle;');
    expect(out).toContain('core.user("opt_a", "checked", true, "change")');
    expect(one(mk('Radio'))).toContain('useState<string | null>');
    expect(out).toContain('<Dropdown');
    expect(out).toContain('<Choices');
    expect(out).toContain('<Spinner type="dots" />');
    expect(out).toContain('import SelectInput from "ink-select-input"');
    expect(out).toContain('core.isOpen("confirm")');
    expect(one(mk('Modal'))).toMatch(/const \[modalOpen, setModalOpen\] = useState\(true\)/);
    expect(out).toContain('if (input === "q" && !typing) ui.stop();');
  });

  it('renders table and progress as text', () => {
    const out = one(mk('Table', { props: { columns: ['A', 'Bee'], rows: [['1', '2']] } }));
    expect(out).toContain('" A  Bee "');
    const p = one(mk('ProgressBar', { props: { value: 50, max: 100, width: 10 } }));
    expect(p).toMatch(/█+░+ +50%/);
  });

  it('keeps hidden modals out and escapes text', () => {
    resetIds();
    const hidden = app(
      screen('S', undefined, [mk('Modal', { hidden: true, props: { title: 'GONE' } })])
    );
    expect(hidden).not.toContain('GONE');
    const out = app(nastyDesign());
    expect(out).toContain('"He said \\"hi\\""'.replace('"He said', '"He said'));
    expect(out).not.toContain('{braces}</');
    assertParses(out, 'tsx');
  });

  it('parses every layout fixture and the full design', () => {
    for (const root of [...Object.values(layouts()), allComponents()]) {
      for (const f of exportToFiles(root, 'ink')) {
        if (f.path.endsWith('.tsx')) assertParses(f.content, 'tsx', f.path);
        else if (f.path.endsWith('.ts')) assertParses(f.content, 'ts', f.path);
        else expect(() => JSON.parse(f.content)).not.toThrow();
      }
    }
  });

  it('ships the same runtime for every design', () => {
    const a = exportToFiles(allComponents(), 'ink').find((f) => f.path === 'src/ui-runtime.ts')!;
    const b = exportToFiles(apiDesign(), 'ink').find((f) => f.path === 'src/ui-runtime.ts')!;
    expect(a.content).toBe(b.content);
    expect(a.content).not.toContain('submit_btn');
  });

  it('generates one typed handle per code name', () => {
    const out = app(apiDesign());
    expect(out).toContain('export class Ui extends UiBase');
    expect(out).toContain('readonly submitBtn: ButtonHandle;');
    expect(out).toContain('this.submitBtn = new ButtonHandle(this.core, "submit_btn");');
    expect(out).toContain('readonly confirm: ModalHandle;');
    expect(out).toContain('core.isOpen("confirm")');
    expect(out).toContain('core.state("panel") !== "hidden"');
  });

  it('keeps tagged hidden components so that show() works, but not untagged ones', () => {
    resetIds();
    const out = app(
      screen('S', undefined, [
        mk('Text', { tag: 'later', hidden: true, props: { content: 'LATER' } }),
        mk('Text', { hidden: true, props: { content: 'NEVER' } }),
      ])
    );
    expect(out).toContain('state: "hidden"');
    expect(out).toContain('core.str("later", "text")');
    expect(out).not.toContain('NEVER');
  });

  it('renames code names that clash with the facade', () => {
    resetIds();
    const out = app(
      screen('S', undefined, [mk('Text', { tag: 'start' }), mk('Text', { tag: 'default' })])
    );
    expect(out).toContain('readonly start_: TextHandle;');
    expect(out).toContain('readonly default_: TextHandle;');
  });
});
