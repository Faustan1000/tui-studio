import { describe, expect, it } from 'vitest';
import { exportToFiles } from '../src/utils/export/codeExporter';
import { mk, resetIds, screen } from './fixtures/build';
import { allComponents, layouts } from './fixtures/designs';
import { nastyDesign } from './fixtures/nasty';
import { assertParses } from './helpers/syntax';

const app = (root = allComponents()) =>
  exportToFiles(root, 'ink').find((f) => f.path === 'src/app.tsx')!.content;
const one = (child: ReturnType<typeof mk>) => app(screen('S', undefined, [child]));

describe('ink export', () => {
  it('ships app, package.json and tsconfig', () => {
    const files = exportToFiles(allComponents(), 'ink');
    expect(files.map((f) => f.path)).toEqual(['src/app.tsx', 'package.json', 'tsconfig.json']);
    const pkg = JSON.parse(files[1].content);
    expect(pkg.type).toBe('module');
    expect(pkg.scripts.start).toContain('tsx');
    for (const d of ['ink', 'react', 'ink-text-input', 'ink-select-input', 'ink-spinner']) {
      expect(pkg.dependencies[d], d).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(() => JSON.parse(files[2].content)).not.toThrow();
  });

  it('only lists packages it uses', () => {
    resetIds();
    const files = exportToFiles(screen('S', undefined, [mk('Text')]), 'ink');
    const pkg = JSON.parse(files[1].content);
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['ink', 'react']);
    expect(files[0].content).not.toContain('ink-text-input');
  });

  it('uses code names for state and event handlers once', () => {
    resetIds();
    const out = app(
      screen('S', undefined, [
        mk('Checkbox', { tag: 'agree_box' }),
        mk('Button', { events: { onClick: 'handleClick' } }),
        mk('Button', { events: { onClick: 'handleClick' } }),
      ])
    );
    expect(out).toContain('const [agreeBox, setAgreeBox] = useState(false)');
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
    expect(abs).toContain('marginLeft={3}');
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
    expect(out).toContain('<Field value={name_input}'.replace('name_input', 'nameInput'));
    expect(out).toContain('useState<string | null>');
    expect(out).toContain('<Dropdown');
    expect(out).toContain('<Choices');
    expect(out).toContain('<Spinner type="dots" />');
    expect(out).toContain('import SelectInput from "ink-select-input"');
    expect(out).toContain('const [confirmOpen, setConfirmOpen] = useState(true)');
    expect(out).toContain('if (input === "q" && !typing) exit();');
  });

  it('renders table and progress as text', () => {
    const out = one(mk('Table', { props: { columns: ['A', 'Bee'], rows: [['1', '2']] } }));
    expect(out).toContain('"A │ Bee"');
    const p = one(mk('ProgressBar', { props: { value: 50, max: 100, width: 10 } }));
    expect(p).toContain('█████░░░░░ 50%');
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
        else expect(() => JSON.parse(f.content)).not.toThrow();
      }
    }
  });
});
