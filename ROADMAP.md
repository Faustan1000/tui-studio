# Roadmap

What 1.0 contains, what is known to be missing, and what is planned. Items are grouped by area and
roughly ordered by how much they matter. "Verified" means how the generated code is checked in
this repository (see `docs/EXPORT_ADAPTERS.md`).

## Status of the export (1.0)

| Framework          | Verified                | Layout            | Interactive | Program API | Screens | Tab/menu bodies switch |
| ------------------ | ----------------------- | ----------------- | ----------- | ----------- | ------- | ---------------------- |
| Textual (Python)   | **run** against Textual | native + snapshot | yes         | **yes**     | **yes** | **yes**                |
| Ink (React)        | syntax                  | native            | yes         | no          | first   | no                     |
| OpenTUI (React)    | syntax                  | native            | yes         | no          | first   | no                     |
| Blessed (Node.js)  | syntax + fake `blessed` | snapshot          | yes         | no          | first   | no                     |
| Bubble Tea (Go)    | structure only          | native + snapshot | yes         | no          | first   | no                     |
| tview (Go)         | structure only          | native + snapshot | yes         | no          | first   | no                     |
| Ratatui (Rust)     | structure only          | native + snapshot | yes         | no          | first   | no                     |
| HTML / ANSI / text | -                       | editor renderer   | -           | -           | active  | -                      |

"first" = only the first screen of a project is exported.
"Structure only" = brackets, imports and unused variables are checked; the code was **never
compiled** because no Go or Rust toolchain was available. The first real build may need small
fixes (see the unconfirmed API calls below).

## Before calling the other exporters finished

These are the gaps that keep Ink, OpenTUI, Blessed, Bubble Tea, tview and Ratatui from the level
Textual has.

- **Compile and run the generated code** for each framework in CI (Node + Bun, Go, Rust). This
  is the single most valuable item: it turns "plausible" into "works". API names the exporters'
  authors could not confirm without a toolchain:
  - Ink: pinned versions, `SelectInput` props, margin-based `position="absolute"`.
  - OpenTUI: Yoga value names (`flex-start`, ...), key event names, `tab-select` `selectedIndex`.
  - Blessed: `listbar`/`listtable`/`progressbar` options, semi-private `_render`/`clearPos`.
  - Bubble Tea: `table`/`progress`/`spinner`/`textinput` method signatures, `lipgloss` width rules.
  - tview: several `SetDisabled`/`SetSelectedFunc` calls, tcell version pin.
  - Ratatui: `Table::row_highlight_style`, `Frame::set_cursor_position`, `ratatui::crossterm`.
- **Tab and menu bodies that switch at run time** in every framework except Textual. Today only
  the initially active body is exported.
- **Screens and screen links** in all frameworks except Textual (`opensScreen`, menu/list item
  links are ignored or left as a comment).
- **The program API** (named components, active/muted/readonly/hidden, events, error dialog and
  log) for the other frameworks. `src/utils/export/api/spec.ts` already describes it neutrally;
  Textual's `ui_runtime.py` is the reference implementation.
- **Intrinsic sizes in the IR.** The editor's layout engine reports width 1 for content-sized
  widgets (text, checkbox, select, ...). Bubble Tea, tview and Ratatui each work around it with
  their own measuring helper; this belongs in `ir.ts` once.
- **Hot spots per framework**
  - Blessed: only `line` borders (double/rounded/bold become single), no italic/strikethrough,
    tree cannot expand.
  - tview: border style is global, not per component; focus/blur/key events are stubs only.
  - Ratatui: tree expand/collapse, horizontal scrolling in text inputs.
  - Ink: container background colour is not exported.
  - Bubble Tea: menu hotkeys are shown but not bound.

## Layout fidelity

- **Responsive behaviour.** Wrap containers and unequal-size alignment are positioned from the
  editor's design size (Textual, and the "snapshot" strategy elsewhere). They do not reflow when
  the terminal is resized.
- **`Align: stretch`** is not implemented, neither in the editor engine nor in any export.
- Per-child alignment, flex-grow/shrink per child and min/max sizes in the editor.
- The root Screen aligns unequal children as a group (Textual limitation).
- Parity harness (editor vs. real framework) exists only for Textual. Extend it to Ink/OpenTUI
  (Yoga) once they can be started in tests.

## Editor

- **Components:** multi-line text area, scrollable view, log/rich text, slider, date picker,
  chart/sparkline, footer/help bar, toast notifications, command palette.
- **Events and key bindings** per screen and per component, instead of handler names only.
- **Screens:** add/remove/rename/reorder are not part of undo/redo; copy and paste components
  between screens; screen templates.
- **Theme tokens** that map to each framework's own theming (Textual themes, Ratatui styles).
- **Import** of existing code (reverse direction) is not planned for 1.x.

## Quality and project

- **CI** (GitHub Actions): `npm test`, lint, build; a job with Python + Textual for the real
  Textual suites; jobs with Go/Rust/Node/Bun once the exporters are compiled in tests.
- **Editor end-to-end tests** with Playwright (already a dev dependency).
- **`.tui` format policy:** version 2 is current; document the migration rule for version 3 and
  keep reading older versions.
- **Bundle size:** the main chunk is above 500 kB; split the editor panels and the export code.
- **Windows console driver** (`real_console.py`, thread and main mode) is a manual check and not
  part of `npm test`.
- Versioning: `package.json` still says `0.0.1`; set it to `1.0.0` when the release is cut, and
  move the changelog entry from "Unreleased".

## Done in 1.0

- Export on a shared IR with one adapter per framework and a conformance suite for all of them.
- Textual: every component, program API (thread, states, events, error dialog, log), multiple
  screens, screen links, tab/menu bodies, flex/grid/absolute/wrap layout verified against the
  editor, nesting depth beyond Python's 20-block limit.
- Test suite: unit tests for validation, code names, navigation, screen links, layout engine,
  store and IR; per-framework output tests; real-Textual tests (skipped without Textual).
