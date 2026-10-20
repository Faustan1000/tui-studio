// Ratatui output. Rust cannot be compiled here, so these are structural checks: a small lexical
// checker (balanced delimiters, used imports, used variables) plus concrete assertions.

import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '../src/types';
import { ratatuiAdapter } from '../src/utils/export/exporters/ratatui';
import { buildIR } from '../src/utils/export/ir';
import { mk, resetIds, screen } from './fixtures/build';
import { allComponents, layouts, multiScreen } from './fixtures/designs';
import { NASTY_STRINGS, nastyDesign } from './fixtures/nasty';

function files(root: ComponentNode) {
  return ratatuiAdapter.generate({ ir: buildIR(root), source: [{ id: root.id, root }] });
}
const rs = (root: ComponentNode) => files(root).find((f) => f.path === 'src/main.rs')!.content;

// ── Lexical checker ───────────────────────────────────────────────────────────

/** Source without comments; string and char literals are reduced to `""` / `''`. Throws on bad nesting. */
function clean(src: string): string {
  let out = '';
  const stack: string[] = [];
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new Error('unterminated block comment');
      i = end + 1;
      out += ' ';
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      if (j >= src.length) throw new Error('unterminated string');
      const body = src.slice(i + 1, j);
      if (/[\r\n]/.test(body)) throw new Error('raw line break inside a string literal');
      out += '""';
      i = j;
      continue;
    }
    if (c === "'") {
      const m = /^'(?:[^'\\]|\\.)'/.exec(src.slice(i, i + 8));
      if (m) {
        out += "''";
        i += m[0].length - 1;
        continue;
      }
    }
    if ('([{'.includes(c)) stack.push(c);
    if (')]}'.includes(c) && stack.pop() !== pairs[c])
      throw new Error(`unbalanced ${c} near: ${out.slice(-60)}`);
    out += c;
  }
  if (stack.length) throw new Error(`unclosed ${stack.join('')}`);
  return out;
}

/** Leaf names imported by the `use` statements. */
function usedNames(code: string): string[] {
  const names: string[] = [];
  const expand = (prefix: string[], text: string) => {
    for (const part of splitTop(text)) {
      const t = part.trim();
      const brace = t.indexOf('{');
      if (brace >= 0) {
        const path = t.slice(0, brace).split('::').filter(Boolean);
        expand([...prefix, ...path], t.slice(brace + 1, t.lastIndexOf('}')));
      } else {
        const segs = t.split('::').filter(Boolean);
        const last = segs[segs.length - 1];
        names.push(
          last === 'self'
            ? segs.length > 1
              ? segs[segs.length - 2]
              : prefix[prefix.length - 1]
            : last
        );
      }
    }
  };
  for (const m of code.matchAll(/^use\s+([^;]+);/gm)) {
    const body = m[1];
    const brace = body.indexOf('{');
    if (brace >= 0)
      expand(
        body.slice(0, brace).split('::').filter(Boolean),
        body.slice(brace + 1, body.lastIndexOf('}'))
      );
    else expand([], body);
  }
  return names;
}

function splitTop(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of text) {
    if (c === '{') depth++;
    if (c === '}') depth--;
    if (c === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Top-level items (fn / impl / struct ...) as separate chunks, `use` lines removed. */
function items(code: string): string[] {
  const body = code.replace(/^use\s+[^;]+;/gm, '');
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of body) {
    cur += c;
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) {
      out.push(cur);
      cur = '';
    }
  }
  return out;
}

function lexicalProblems(src: string): string[] {
  const problems: string[] = [];
  let code: string;
  try {
    code = clean(src);
  } catch (e) {
    return [(e as Error).message];
  }
  const rest = code.replace(/^use\s+[^;]+;/gm, '');
  for (const name of usedNames(code)) {
    if (!new RegExp(`\\b${name}\\b`).test(rest)) problems.push(`unused import ${name}`);
  }
  for (const chunk of items(code)) {
    for (const m of chunk.matchAll(/\blet\s+(?:mut\s+)?([A-Za-z_]\w*)\s*(?::(?!:)|=(?!=))/g)) {
      const name = m[1];
      if (name.startsWith('_')) continue;
      const count = chunk.match(new RegExp(`\\b${name}\\b`, 'g'))?.length ?? 0;
      if (count < 2) problems.push(`unused variable ${name}`);
    }
  }
  if (!/fn main\(\)/.test(code)) problems.push('no main');
  return problems;
}

const designs: Record<string, () => ComponentNode> = {
  all: allComponents,
  nasty: nastyDesign,
  home: () => multiScreen()[0],
  empty: () => screen('Empty', undefined, []),
  onlySpacer: () => screen('Spacers', undefined, [mk('Spacer'), mk('Box', {}, [mk('Spacer')])]),
  deep: () => {
    resetIds();
    let deep = mk('Text', { props: { content: 'bottom' } });
    for (let i = 0; i < 25; i++) deep = mk('Box', {}, [deep]);
    return screen('Deep', undefined, [deep]);
  },
};
for (const [name, root] of Object.entries(layouts()))
  designs[`layout ${name}`] = () => layouts()[name] ?? root;

describe('ratatui lexical checks', () => {
  it.each(Object.keys(designs))('%s is well formed', (name) => {
    expect(lexicalProblems(rs(designs[name]()))).toEqual([]);
  });

  it('the checker itself finds mistakes', () => {
    expect(lexicalProblems('use a::B;\nfn main() { let x = 1; }')).toEqual([
      'unused import B',
      'unused variable x',
    ]);
    expect(lexicalProblems('fn main() { let s = "(" ; (')).toEqual(['unclosed {(']);
    expect(lexicalProblems("fn main() { // ( \n /* { */ let _y = '}'; }")).toEqual([]);
  });
});

// ── Project files ─────────────────────────────────────────────────────────────

describe('ratatui project', () => {
  it('writes src/main.rs and Cargo.toml', () => {
    const f = files(allComponents());
    expect(f.map((x) => x.path)).toEqual(['src/main.rs', 'Cargo.toml']);
    const cargo = f[1].content;
    expect(cargo).toMatch(
      /^\[package\]\nname = "[a-z_][a-z0-9_]*"\nversion = "0\.1\.0"\nedition = "2021"/
    );
    expect(cargo).toMatch(/\[dependencies\][\s\S]*ratatui = "0\.29\.0"/);
    expect(cargo).toMatch(/crossterm = "0\.28\.\d+"/);
    expect(
      cargo.split('\n').every((l) => l === '' || /^(\[[\w.]+\]|[#\w-]+ = ".*"|#.*)$/.test(l))
    ).toBe(true);
  });

  it('names the crate after the screen', () => {
    resetIds();
    const cargo = files(screen('Settings Page', undefined, []))[1].content;
    expect(cargo).toContain('name = "settings_page"');
  });

  it('explains how to run and which strategy each container uses', () => {
    const out = rs(allComponents());
    expect(out.split('\n')[0]).toMatch(/^\/\/ /);
    expect(out).toContain('cargo run');
    expect(out).toMatch(/\/\/\s+panel: native column/);
    expect(out).toMatch(/\/\/\s+cells: native grid 2x2/);
    expect(out).toMatch(/\/\/\s+confirm: modal overlay/);
    const abs = rs(layouts().absolute);
    expect(abs).toMatch(/\/\/\s+box: snapshot \(absolute/);
  });

  it('uses the modern API', () => {
    const out = rs(allComponents());
    for (const s of [
      'ratatui::init()',
      'ratatui::restore()',
      'frame.area()',
      'KeyEventKind::Press',
      'fn ui(frame: &mut Frame, app: &mut App)',
    ]) {
      expect(out, s).toContain(s);
    }
    expect(out).not.toContain('frame.size()');
  });

  it('never uses Color::Reset for a resolved colour', () => {
    expect(rs(allComponents())).not.toContain('Color::Reset');
  });
});

// ── Components ────────────────────────────────────────────────────────────────

describe('ratatui components', () => {
  const out = rs(allComponents());

  it('keeps state per interactive component, named after the code names', () => {
    for (const s of [
      'name_input_value: String,',
      'name_input_cursor: usize,',
      'agree_checked: bool,',
      'opt_a_checked: bool,',
      'dark_checked: bool,',
      'color_index: usize,',
      'files_state: ListState,',
      'nav_tree_state: ListState,',
      'main_menu_state: ListState,',
      'results_state: TableState,',
      'pages_tab: usize,',
      'confirm_open: bool,',
    ]) {
      expect(out, s).toContain(s);
    }
  });

  it('renders each widget kind', () => {
    for (const s of [
      'Paragraph::new("Ready")',
      'Paragraph::new("Send")',
      'Span::styled("Enter text..."',
      'frame.set_cursor_position(',
      'format!("[{}] {}", if app.agree_checked',
      'format!("({}) {}", if app.opt_a_checked',
      'format!("{} {}", if app.dark_checked { "[ON ]" } else { "[OFF]" }',
      '"Option 1", "Option 2"',
      'Gauge::default()',
      'SPINNER_FRAMES[app.tick % SPINNER_FRAMES.len()]',
      'Table::new(RESULTS_ROWS',
      '"Cell 1"',
      'List::new(FILES_ITEMS.to_vec())',
      'List::new(NAV_TREE_ITEMS.to_vec())',
      'List::new(MAIN_MENU_ITEMS.to_vec())',
      'Tabs::new(PAGES_TABS.to_vec())',
      '"Home / Documents / File"',
      'frame.render_stateful_widget(',
      '&mut app.files_state',
    ]) {
      expect(out, s).toContain(s);
    }
  });

  it('draws the modal last, over the screen, with Clear and a title', () => {
    const modal = out.indexOf('if app.confirm_open {');
    expect(modal).toBeGreaterThan(out.indexOf('let panel_area'));
    const after = out.slice(modal);
    expect(after).toContain('centered(area, 40, 12)');
    expect(after).toContain('frame.render_widget(Clear,');
    expect(after).toContain('.title("Sure?")');
    expect(after).toContain('BorderType::Double');
  });

  it('maps borders, colours and modifiers', () => {
    const out = rs(
      screen('S', undefined, [
        mk('Text', {
          props: { content: 'styled' },
          style: {
            color: '#112233',
            backgroundColor: '#aabbcc',
            bold: true,
            italic: true,
            underline: true,
            strikethrough: true,
          },
        }),
        mk('Box', {
          name: 'Named',
          style: {
            border: true,
            borderStyle: 'rounded',
            borderColor: '#ff0000',
            borderLeft: false,
            borderRight: false,
          },
        }),
        mk('Box', { style: { border: true, borderStyle: 'bold' } }, [mk('Text')]),
      ])
    );
    expect(out).toContain('Color::Rgb(17, 34, 51)');
    expect(out).toContain('.bg(Color::Rgb(170, 187, 204))');
    expect(out).toContain(
      'Modifier::BOLD | Modifier::ITALIC | Modifier::UNDERLINED | Modifier::CROSSED_OUT'
    );
    expect(out).toContain('Borders::TOP | Borders::BOTTOM');
    expect(out).toContain('BorderType::Rounded');
    expect(out).toContain('BorderType::Thick');
    expect(out).toContain('Color::Rgb(255, 0, 0)');
    expect(out).toContain('.title("Named")');
    // Unnamed boxes get no title.
    expect(out.match(/\.title\(/g)).toHaveLength(1);
  });

  it('applies padding with Block::padding', () => {
    expect(out).toContain('.padding(Padding::new(1, 1, 1, 1))');
  });

  it('leaves out hidden components and Spacers', () => {
    resetIds();
    const o = rs(
      screen('S', undefined, [
        mk('Text', { props: { content: 'SHOWN' } }),
        mk('Text', { hidden: true, props: { content: 'GONE' } }),
        mk('Spacer'),
      ])
    );
    expect(o).toContain('SHOWN');
    expect(o).not.toContain('GONE');
    expect(o).not.toContain('spacer_area');
  });

  it('skips tab bodies that are not active', () => {
    const o = rs(multiScreen()[0]);
    expect(o).toContain('Dashboard content');
    expect(o).not.toContain('Agent content');
  });
});

// ── Focus and keys ────────────────────────────────────────────────────────────

describe('ratatui keyboard handling', () => {
  const out = rs(allComponents());

  it('cycles the focus with Tab and BackTab', () => {
    expect(out).toContain('KeyCode::Tab =>');
    expect(out).toContain('KeyCode::BackTab =>');
    expect(out).toContain('const FOCUS_COUNT: usize = 13;');
    expect(out).toContain('(i + step) % FOCUS_COUNT');
    expect(out).toContain('(i + FOCUS_COUNT - step) % FOCUS_COUNT');
  });

  it('does not quit while a text input has focus; Esc unfocuses it', () => {
    expect(out).toContain('matches!(self.focus, Some(F_NAME_INPUT))');
    expect(out).toContain("KeyCode::Char('q') if !typing");
    expect(out).toMatch(/KeyCode::Esc => \{\s+if typing \{\s+self\.focus = None;/);
  });

  it('edits text, toggles, moves in lists and tabs', () => {
    for (const s of [
      'self.name_input_value.insert(at, c);',
      'self.name_input_value.remove(at);',
      'self.agree_checked = !self.agree_checked;',
      'self.opt_a_checked = true;',
      'self.opt_b_checked = false;',
      'self.files_state.select(Some(i.saturating_sub(1)));',
      'self.results_state.select(',
      'self.pages_tab = self.pages_tab.saturating_sub(1);',
      'if self.color_index + 1 < COLOR_OPTIONS.len()',
    ]) {
      expect(out, s).toContain(s);
    }
  });

  it('only focuses the controls of an open modal', () => {
    expect(out).toContain('F_OK_BTN => self.confirm_open,');
    expect(out).toContain('if self.confirm_open {\n                    self.confirm_open = false;');
  });

  it('writes deduplicated handler stubs and calls them', () => {
    expect(out.match(/fn handle_change\(&mut self\) \{ \/\* TODO \*\/ \}/g)).toHaveLength(1);
    expect(out).toContain('fn handle_click(&mut self) { /* TODO */ }');
    expect(out).toContain('self.handle_click();');
  });

  it('turns odd handler names into valid, non-clashing methods', () => {
    resetIds();
    const o = rs(
      screen('S', undefined, [
        mk('Button', { events: { onClick: 'type' } }),
        mk('Button', { events: { onClick: 'on key' } }),
        mk('Button', { events: { onClick: 'doIt' } }),
        mk('Button', { events: { onClick: 'do_it' } }),
      ])
    );
    expect(o).toContain('fn type_handler(&mut self)');
    expect(o).toContain('fn on_key_handler(&mut self)');
    expect(o.match(/fn do_it\(&mut self\)/g)).toHaveLength(1);
    expect(lexicalProblems(o)).toEqual([]);
  });

  it('has no focus machinery when nothing can take focus', () => {
    resetIds();
    const o = rs(screen('S', undefined, [mk('Text'), mk('ProgressBar')]));
    expect(o).not.toContain('FOCUS_COUNT');
    expect(o).not.toContain('focus_next');
    expect(o).toContain('self.quit = true;');
  });

  it('animates spinners only when there are some', () => {
    expect(out).toContain('event::poll(Duration::from_millis(100))');
    resetIds();
    const o = rs(screen('S', undefined, [mk('Text')]));
    expect(o).not.toContain('poll(');
    expect(o).not.toContain('Duration');
  });
});

// ── Escaping ──────────────────────────────────────────────────────────────────

describe('ratatui escaping', () => {
  const out = rs(nastyDesign());

  it('writes user text as Rust string literals', () => {
    expect(out).toContain('"He said \\"hi\\""');
    expect(out).toContain('"back\\\\slash"');
    expect(out).toContain('"new\\nline"');
    expect(out).toContain('"tab\\there"');
    expect(out).toContain('"{braces} and {{double}}"');
    expect(out).toContain('"ünïcödé ✓ 日本語 🔥"');
    expect(out).toContain('"/* comment */ // line"');
  });

  it('keeps user text out of format strings', () => {
    // `{}` inside user labels must only ever be an argument, never part of the template.
    for (const m of out.matchAll(/format!\("([^"]*)"/g))
      expect(m[1]).toMatch(/^[[(]?\{\}[\])]? ?(\{\})?( ▾)?$/);
  });

  it('survives every nasty string in every component', () => {
    for (const s of NASTY_STRINGS)
      expect(
        out.includes(
          s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t')
        )
      ).toBe(true);
  });

  it('never puts a raw line break into a string', () => {
    expect(() => clean(out)).not.toThrow();
  });
});

// ── Layout ────────────────────────────────────────────────────────────────────

describe('ratatui layout', () => {
  const L = layouts();

  it('row: horizontal Layout with spacing and Length constraints', () => {
    const o = rs(L.row);
    expect(o).toContain('.direction(Direction::Horizontal)');
    expect(o).toContain('.spacing(2)');
    expect(o).toContain(
      '.constraints([Constraint::Length(6), Constraint::Length(6), Constraint::Length(6)])'
    );
    expect(o).toContain('.flex(Flex::Start)');
  });

  it('column: vertical Layout with spacing 1', () => {
    const o = rs(L.column);
    expect(o).toContain('.direction(Direction::Vertical)');
    expect(o).toContain('.spacing(1)');
    expect(o).toContain('Constraint::Length(1), Constraint::Length(1), Constraint::Length(1)');
  });

  it('justify and align', () => {
    const c = rs(L.center);
    expect(c).toContain('.flex(Flex::Center)');
    expect(c).toMatch(
      /aligned\(box_cells\[0\], 6, u16::MAX, 0, 1\)|aligned\(box_cells\[0\], u16::MAX, 1, 0, 1\)/
    );
    expect(c).toContain('fn aligned(');
    expect(rs(L.spaceBetween)).toContain('.flex(Flex::SpaceBetween)');
  });

  it('fill and auto sizes', () => {
    resetIds();
    const o = rs(
      screen('S', undefined, [
        mk('Box', { props: { height: 'fill' } }, [
          mk('Text', { props: { width: 'fill', height: 2 } }),
        ]),
        mk('Text', { props: { content: 'wide text here' } }),
      ])
    );
    expect(o).toContain('Constraint::Fill(1)');
    expect(o).toContain('aligned(s_cells[1], 14, u16::MAX, 0, 0)');
  });

  it('grid: nested row and column Layouts', () => {
    const o = rs(L.grid);
    expect(o).toContain('let box_rows = Layout::default()');
    expect(o).toContain('let box_row0 = Layout::default()');
    expect(o).toContain('let box_row1 = Layout::default()');
    expect(o).toContain('.constraints([Constraint::Fill(1), Constraint::Fill(1)])');
    expect(o).toContain('box_row1[1]');
  });

  it('wrap and absolute: snapshot with clamp_rect', () => {
    const abs = rs(L.absolute);
    expect(abs.match(/clamp_rect\(box_area, \d+, \d+, 6, 1\)/g)).toHaveLength(2);
    expect(abs).toContain('fn clamp_rect(parent: Rect, x: u16, y: u16, w: u16, h: u16) -> Rect');
    expect(abs).toContain('.intersection(parent)');
    const wrapped = rs(L.wrapped);
    expect(wrapped).toMatch(/\/\/\s+box: snapshot \(wrapping flex/);
    expect(wrapped.match(/clamp_rect\(box_area/g)!.length).toBe(8);
  });

  it('emits helpers only when they are used', () => {
    const o = rs(screen('S', undefined, [mk('Text')]));
    expect(o).not.toContain('fn clamp_rect');
    expect(o).not.toContain('fn centered');
    expect(o).not.toContain('fn focus_style');
  });
});
