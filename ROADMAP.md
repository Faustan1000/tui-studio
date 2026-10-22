# Roadmap

What 1.0 contains, what is known to be missing, and what is planned. Items are grouped by area and
roughly ordered by how much they matter. "Run" means the generated program is started against the
real framework in this repository's tests (see `docs/EXPORT_ADAPTERS.md`).

## Status of the export (1.0)

| Framework          | Verified | Layout            | Interactive | Program API | Screens | Tab/menu bodies switch |
| ------------------ | -------- | ----------------- | ----------- | ----------- | ------- | ---------------------- |
| Textual (Python)   | **run**  | native + snapshot | yes         | **yes**     | **yes** | **yes**                |
| Ink (React)        | **run**  | native            | yes         | **yes**     | first   | no                     |
| OpenTUI (React)    | **run**  | native            | yes         | **yes**     | first   | no                     |
| Blessed (Node.js)  | **run**  | snapshot          | yes         | **yes**     | first   | no                     |
| Bubble Tea (Go)    | **run**  | native + snapshot | yes         | **yes**     | first   | no                     |
| tview (Go)         | **run**  | native + snapshot | yes         | **yes**     | first   | no                     |
| Ratatui (Rust)     | **run**  | native + snapshot | yes         | **yes**     | first   | no                     |
| HTML / ANSI / text | -        | editor renderer   | -           | -           | active  | -                      |

"first" = only the first screen of a project is exported.
The program API (`docs/PROGRAM_API.md`) passes the same 14-step scenario (`docs/API_SCENARIO.md`)
in every framework: states, properties without echo, events, error dialog, log panel, lifecycle,
headless against the real library (Textual, Ink, OpenTUI under Bun, blessed, Bubble Tea, tview,
Ratatui's test backend). What is **not** tested anywhere is a real terminal: the tests drive each
framework headless, so `start()`/`run()` on a real tty is only compile-checked for Rust and typed for
OpenTUI's `import.meta.main` entry.

## Next: parity with Textual

- **Scrolling for designs taller than the terminal.** Every framework now fills the terminal and
  cuts what does not fit; only OpenTUI scrolls (wheel, PageUp/PageDown). Add scrolling (or a
  scroll container) to Ink, Blessed, Bubble Tea, tview and Ratatui, and scroll focused widgets
  into view.
- **Mouse in the classic Windows console.** Node (Ink, Blessed) and probably Bun (OpenTUI) get no
  mouse input in conhost; Windows Terminal and VS Code work. Keyboard operation works everywhere.
- **Clicks in real terminals.** All frameworks handle mouse clicks (buttons, checkboxes, radios,
  selects, lists, menus, tabs, text input focus; error dialog and modals capture clicks). This is
  tested by injecting mouse events into the real framework, in a real Windows console only for
  Ratatui. Still to confirm on real terminals: Ink and OpenTUI under Windows (does the terminal
  deliver mouse reports to Node/Bun?), Windows Terminal and ConPTY, tview List/Table/Tree.

- **Screens and screen links** in all frameworks except Textual (`opensScreen`, menu/list item
  links are ignored or left as a comment; `ui.<screen>.show()` does not exist there).
- **Tab and menu bodies that switch at run time**; today only the initially active body is exported
  and components with a code name inside an inactive body get no handle.
- **Real terminal runs** in CI (pty), not only headless drivers.
- **CI** (GitHub Actions): `npm test` with Node, Bun, Go, Rust and Python + Textual installed so the
  whole matrix runs on every push. `npm run test:setup` installs the Node/Bun packages.
- **Intrinsic sizes in the IR.** The editor's layout engine reports width 1 for content-sized
  widgets (text, checkbox, select, ...). Blessed, Bubble Tea, tview and Ratatui each work around it
  with their own measuring helper; this belongs in `ir.ts` once.

## Known differences between the program APIs

- Textual, Bubble Tea, tview and Ratatui run the UI in a real thread/goroutine; in Node/Bun (Ink,
  OpenTUI, Blessed) there is one event loop, so "handlers never on the UI thread" means "after the
  input event, never during render" (`setImmediate`/microtask).
- A **Modal with a code name starts closed** and opens with `open()` (like Textual); a modal without
  a code name is shown from the start.
- Ink replaces `ink-text-input` with its own small text field (cursor always at the end).
- Ratatui: `events()` returns a small wrapper (`next`, `try_next`, `drain`), handlers take any
  `Fn(&Event) + Send + Sync`, redraw is a 30 ms poll, `Ui::start()` needs `install_panic_hook()`.
- Go: handle names that collide with `Ui` members get a trailing `_` (`Stop_`, `Log_`).
- Tree is read-only text in OpenTUI/Ink (no `select` event); List/Menu `select` fires on Enter.
- OpenTUI: Table rows and Tree nodes are not clickable (drawn as static text).
- Bubble Tea: table clicks find the row by its text, identical rows are ambiguous.

## Per-framework gaps

- Blessed: only `line` borders (double/rounded/bold become single), no italic/strikethrough, tree
  cannot expand, `hide()` does not free space (snapshot layout), tables/lists sized at 3 rows show
  only their first entries.
- tview: `tview.Borders` is global, so one border kind applies to the whole screen; hidden children
  in grid/snapshot containers keep their space.
- Ratatui: tree expand/collapse, horizontal scrolling in text inputs, `show()` on components hidden
  in the editor has no visible effect.
- Ink/OpenTUI: tagged `List` shows only labels (icons/hotkeys only on untagged lists).
- Bubble Tea: Table has no API events; Select has no dropdown list (cycles with up/down).
- Pinned versions of `tsx` and `@types/node` in the generated Ink project are not checked against the
  registry.

## Layout fidelity

- **Responsive behaviour.** Wrap containers and unequal-size alignment are positioned from the
  editor's design size (Textual, and the "snapshot" strategy elsewhere). They do not reflow when the
  terminal is resized.
- **`Align: stretch`** is not implemented, neither in the editor engine nor in any export.
- Per-child alignment, flex-grow/shrink per child and min/max sizes in the editor.
- The root Screen aligns unequal children as a group (Textual limitation).
- The editor-vs-framework parity harness exists only for Textual (`tests/python/parity.py`); Ink
  layout is measured in a few cases. Extend it to all frameworks.

## Editor

- **Components:** multi-line text area, scrollable view, log/rich text, slider, date picker,
  chart/sparkline, footer/help bar, toast notifications, command palette.
- **Events and key bindings** per screen and per component, instead of handler names only.
- **Screens:** add/remove/rename/reorder are not part of undo/redo; copy and paste components
  between screens; screen templates.
- **Theme tokens** that map to each framework's own theming (Textual themes, Ratatui styles).
- **Import** of existing code (reverse direction) is not planned for 1.x.

## Quality and project

- **Editor end-to-end tests** with Playwright (already a dev dependency).
- **`.tui` format policy:** version 2 is current; document the migration rule for version 3 and keep
  reading older versions.
- **Bundle size:** the main chunk is above 500 kB; split the editor panels and the export code.
- **Windows console driver** (`real_console.py`, thread and main mode) is a manual check and not part
  of `npm test`.
- Versioning: `package.json` still says `0.0.1`; set it to `1.0.0` when the release is cut, and move
  the changelog entry from "Unreleased".

## Done in 1.0

- Export on a shared IR with one adapter per framework and a conformance suite for all of them.
- **Program API in all seven frameworks** (named components, states, properties, events, error
  dialog, log, lifecycle), one contract, one scenario, tested against the real libraries.
- Textual: every component, multiple screens, screen links, tab/menu bodies, flex/grid/absolute/wrap
  layout verified against the editor, nesting beyond Python's 20-block limit.
- Test suite: unit tests, per-framework output tests, API scenario tests (Node, Bun, Go, Rust,
  Python), real-Textual layout parity.
