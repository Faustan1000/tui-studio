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
const file = (root: ComponentNode, path: string) =>
  files(root).find((f) => f.path === path)!.content;
/** main.rs and ui.rs together (what the design turns into; the runtime is a fixed file). */
const rs = (root: ComponentNode) => `${file(root, 'src/main.rs')}\n${file(root, 'src/ui.rs')}`;
const sources = (root: ComponentNode) => ['src/main.rs', 'src/ui.rs'].map((p) => file(root, p));

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

function lexicalProblems(src: string, needMain = false): string[] {
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
  if (needMain && !/fn main\(\)/.test(code)) problems.push('no main');
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
    const [main, ui] = sources(designs[name]());
    expect(lexicalProblems(main, true)).toEqual([]);
    expect(lexicalProblems(ui)).toEqual([]);
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
    expect(f.map((x) => x.path)).toEqual([
      'src/main.rs',
      'src/ui.rs',
      'src/ui_runtime.rs',
      'Cargo.toml',
      'src/api.rs',
    ]);
    const cargo = f[3].content;
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
    const cargo = file(screen('Settings Page', undefined, []), 'Cargo.toml');
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
      'ratatui::try_init()',
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

  it('keeps the UI-only state in App and everything else in the store', () => {
    for (const x of [
      'name_input_cursor: usize,',
      'files_state: ListState,',
      'nav_tree_state: ListState,',
      'main_menu_state: ListState,',
      'results_state: TableState,',
      'rt: Runtime,',
    ]) {
      expect(out, x).toContain(x);
    }
    for (const x of [
      'Seed::new("name_input", State::Active)',
      '.prop("value", Value::text(""))',
      'Seed::new("agree", State::Active)',
      '.prop("checked", Value::Bool(false))',
      'Seed::new("color", State::Active)',
      '.prop("options", Value::list(&["Option 1", "Option 2", "Option 3"]))',
      'Seed::new("pages", State::Active)',
      '.prop("active_tab", Value::Int(0))',
      'Seed::new("confirm", State::Active)',
      '.prop("open", Value::Bool(false))',
      'Seed::new("progress", State::Active)',
      '.prop("max", Value::Float(100.0))',
    ]) {
      expect(out, x).toContain(x);
    }
  });

  it('renders each widget kind', () => {
    for (const s of [
      'Paragraph::new(st.text("status", "text"))',
      'Paragraph::new(st.text("submit_btn", "label"))',
      'Span::styled(st.text("name_input", "placeholder")',
      'frame.set_cursor_position(',
      'format!("[{}] {}", if st.boolean("agree", "checked")',
      'format!("({}) {}", if st.boolean("opt_a", "checked")',
      'format!("{} {}", if st.boolean("dark", "checked") { "[ON ]" } else { "[OFF]" }',
      '"Option 1", "Option 2"',
      'Span::styled("█".repeat(',
      'SPINNER_FRAMES[(app.tick / 3) % SPINNER_FRAMES.len()]',
      'Table::new(results_rows.iter()',
      '"Cell 1"',
      'List::new(files_items.to_vec())',
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
    const modal = out.indexOf('if st.modal_open("confirm") {');
    expect(modal).toBeGreaterThan(out.indexOf('let panel_area'));
    const after = out.slice(modal);
    expect(after).toContain('centered(area, 40, 12)');
    expect(after).toContain('frame.render_widget(Clear,');
    expect(after).toContain('.title(st.text("confirm", "title"))');
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
    // Unnamed boxes get no title (the log panel and the error dialog have their own).
    expect(out.match(/\.title\("Named"\)/g)).toHaveLength(1);
    expect(out).not.toContain('.title("Box")');
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

  it('edits text, toggles, moves in lists and tabs through the store', () => {
    for (const x of [
      'v.insert(at, c);',
      'v.remove(at);',
      'self.rt.user_set("name_input", "value", Value::Str(v), Some("change"));',
      'self.rt.user_emit("name_input", "submit", Value::Str(v));',
      'self.rt.user_set("agree", "checked", Value::Bool(on), Some("change"));',
      'self.rt.user_set("opt_a", "checked", Value::Bool(true), Some("change"))',
      'self.rt.set("opt_b", "checked", Value::Bool(false));',
      'self.rt.user_set("files", "selected"',
      'self.rt.user_emit("files", "select"',
      'self.rt.user_set("pages", "active_tab"',
      'self.results_state.select(Some(next));',
      'self.rt.user_emit("submit_btn", "click", Value::None);',
      'self.open_dropdown(F_COLOR, "color");',
      'self.rt.user_set(key, "value", Value::Str(option.clone()), Some("change"));',
    ]) {
      expect(out, x).toContain(x);
    }
  });

  it('opens the error dialog, toggles the log with Ctrl+L and ignores input meanwhile', () => {
    expect(out).toContain('self.rt.toggle_log();');
    expect(out).toContain('if self.rt.has_pending() {');
    expect(out).toContain('self.rt.dismiss_errors();');
    expect(out).toContain('fn render_errors(frame: &mut Frame, st: &Store, full: Rect)');
    expect(out).toContain('fn render_log(frame: &mut Frame, st: &Store, area: Rect)');
  });

  it('only focuses the controls of an open modal', () => {
    expect(out).toContain('F_OK_BTN => st.focusable("ok_btn") && st.modal_open("confirm"),');
    expect(out).toContain('if self.rt.modal_open("confirm") {');
    expect(out).toContain('self.rt.set("confirm", "open", Value::Bool(false));');
  });

  it('writes deduplicated handler stubs and registers them', () => {
    expect(out.match(/fn handle_change\(_event: &Event\) \{ \/\* TODO \*\/ \}/g)).toHaveLength(1);
    expect(out).toContain('fn handle_click(_event: &Event) { /* TODO */ }');
    expect(out).toContain('ui.submit_btn.on_click(handle_click);');
    expect(out).toContain('ui.name_input.on_change(handle_change);');
    expect(out).toContain('ui.agree.on_change(handle_change);');
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
    expect(o).toContain('fn type_handler(_event: &Event)');
    expect(o).toContain('fn on_key(_event: &Event)');
    expect(o.match(/fn do_it\(_event: &Event\)/g)).toHaveLength(1);
    expect(o).toContain('Arc::new(type_handler)');
    expect(lexicalProblems(o)).toEqual([]);
  });

  it('has no focus machinery when nothing can take focus', () => {
    resetIds();
    const o = rs(screen('S', undefined, [mk('Text'), mk('ProgressBar')]));
    expect(o).not.toContain('FOCUS_COUNT');
    expect(o).not.toContain('focus_next');
    expect(o).toContain('self.quit = true;');
  });

  it('ticks the spinner from the idle loop and only has the frames when needed', () => {
    expect(out).toContain('SPINNER_FRAMES');
    expect(out).toContain('None => app.on_tick(),');
    resetIds();
    const o = rs(screen('S', undefined, [mk('Text')]));
    expect(o).not.toContain('SPINNER_FRAMES');
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
      expect(m[1]).toMatch(/^([[(]?\{\}[\])]? ?(\{\})?( ▾)?|\{:>7\} \{\}| {2}\{\}| {2}\{\}\{\}▼ {2})$/);
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
    expect(o).not.toContain('fn focus_style');
    expect(o).not.toContain('fn slots');
  });
});

describe('ratatui mouse and terminal events', () => {
  const out = rs(allComponents());

  it('captures the mouse and gives it back on exit and in the panic hook', () => {
    expect(out).toContain('execute!(io::stdout(), EnableMouseCapture)');
    expect(out.match(/DisableMouseCapture\)/g)!.length).toBeGreaterThanOrEqual(2);
  });

  it('hit-tests left clicks against the rectangles drawn this frame', () => {
    expect(out).toContain('app.hits.clear();');
    expect(out).toContain(
      'app.hits.push(Hit { rect: name_input_area, focus: F_NAME_INPUT, modal: false, scrolls: true });'
    );
    expect(out).toContain('MouseEventKind::Down(MouseButton::Left)');
    expect(out).toContain('F_OK_BTN');
    expect(out).toMatch(
      /Hit \{ rect: ok_btn_area, focus: F_OK_BTN, modal: true, scrolls: false \}/
    );
    // The error dialog gets the click first.
    expect(out.indexOf('self.rt.dismiss_errors();')).toBeLessThan(
      out.indexOf('let hit = self.hits.iter().rev().copied()')
    );
  });

  it('handles presses, repeats of navigation keys and ignores releases', () => {
    expect(out).toContain('KeyEventKind::Press => self.on_key(key)');
    expect(out).toContain('KeyEventKind::Repeat');
    expect(out).toContain('app.on_event(event)');
  });

  it('cuts fixed-size content at the terminal edge instead of squeezing it', () => {
    expect(out).toMatch(/let \w+_virt = Rect \{ height:/);
    expect(out).toContain('.intersection(');
  });

  it('starts modals with a code name closed', () => {
    expect(out).toContain('Seed::new("confirm", State::Active)');
    expect(out).toContain('.prop("open", Value::Bool(false))');
  });
});

describe('ratatui select, scrolling and table', () => {
  const out = rs(allComponents());

  it('opens a list of options under the select and draws it above everything but the dialogs', () => {
    expect(out).toContain('fn open_dropdown(&mut self, focus: usize, key: &str)');
    expect(out).toContain('fn dropdown_key(&mut self, key: KeyEvent)');
    expect(out).toContain('fn click_dropdown(&mut self, m: MouseEvent)');
    expect(out).toContain(
      'fn dropdown_area(field: Rect, count: usize, widest: usize, bounds: Rect) -> Rect'
    );
    const popup = out.indexOf('if app.dropdown == Some(F_COLOR)');
    expect(popup).toBeGreaterThan(out.indexOf('if st.modal_open("confirm") {'));
    expect(popup).toBeLessThan(out.indexOf('render_errors(frame, &st, full);'));
    expect(out.slice(popup)).toContain('frame.render_widget(Clear, popup);');
    // Only a different option is a change; Esc and clicks outside close without one.
    expect(out).toContain('if *option != self.rt.get_text(key, "value")');
    expect(out).toContain('KeyCode::Esc | KeyCode::Tab | KeyCode::BackTab => self.dropdown = None');
    expect(out).toContain('format!("  {}{}▼  ", color_value,');
  });

  it('scrolls the screen content on an off-screen canvas', () => {
    expect(out).toContain('struct Canvas');
    expect(out).toContain('cv.blit(frame, ');
    expect(out).toMatch(/app\.scroll_max = \w+_need\.saturating_sub\(/);
    expect(out).toContain('Scrollbar::new(ScrollbarOrientation::VerticalRight)');
    expect(out).toContain('MouseEventKind::ScrollDown');
    expect(out).toContain('self.scroll_by(3);');
    expect(out).toContain('KeyCode::PageDown');
    expect(out).toContain('KeyCode::End if !typing');
    expect(out).toContain('self.reveal(next);');
    expect(out).toContain('self.reveal(hit.focus);');
    // Children are drawn on the canvas, the dialog and the log are not.
    expect(out).toContain('cv.render_widget(');
    expect(out).toMatch(/frame\.render_widget\(Clear, \w+_area\)/);
  });

  it('only scrolls a column of fixed-size children', () => {
    const o = rs(screen('S', undefined, [mk('Box', { props: { height: 'fill' } }, [mk('Text')])]));
    expect(o).not.toContain('struct Canvas');
    expect(o).not.toContain('scroll_by');
  });

  it('formats a table: widths from the content, bold heading, all rows shown', () => {
    expect(out).toContain('.column_spacing(2)');
    expect(out).toMatch(/Constraint::Length\(\*w as u16\)/);
    expect(out).toContain('.header(results_head)');
    // Its height holds the heading (1 row), the rows and the border.
    resetIds();
    const o = rs(
      screen('S', undefined, [
        mk('Table', {
          props: {
            columns: ['A', 'B'],
            rows: [
              ['1', '2'],
              ['3', '4'],
              ['5', '6'],
            ],
          },
        }),
        mk('Text'),
      ])
    );
    expect(o).toContain('Constraint::Length(6)');
  });
});
