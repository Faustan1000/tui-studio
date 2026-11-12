<img src="public/logo-tui-studio_light.svg" alt="TUIStudio" width="64" />

**this is a fork from jalonsogo/tui-studio**

# TUIStudio

**Visual design tool for building Terminal User Interfaces**

![Status](https://img.shields.io/badge/status-alpha-orange)

A Figma-like visual editor for designing Terminal UI applications. Drag-and-drop components onto a live canvas, edit properties visually, and export to multiple TUI frameworks.

<img width="400" height="400" alt="Computer" src="public/screenshot-tokyo-night.png" />

## Features

- **Visual Canvas** — Drag-and-drop components with live ANSI preview at configurable zoom levels
- **20 TUI Components** — Screen, Box, Grid, Spacer, Text, Button, TextInput, Checkbox, Radio, Select, Toggle, Spinner, ProgressBar, Table, List, Tree, Menu, Tabs, Breadcrumb, Modal
- **Layout Engine** — Absolute, Flexbox, and Grid layout modes with full property control; sizes in cells, `auto`, `fill` or percent
- **Color Themes** — Dracula, Nord, Solarized Dark/Light, Monokai, Gruvbox, Tokyo Night, Nightfox, Sonokai — all updating the canvas in real-time
- **Dark / Light Mode** — Toggle between dark and light editor UI; persists across sessions
- **Screens and links** — Several screens per project; buttons and menu, list and tab items can open a screen
- **Layers Panel** — Hierarchical component tree with drag-to-reorder, visibility toggle, lock, and inline rename
- **Property Panel** — Edit layout, style, and component-specific props for the selected component
- **Undo / Redo** — Full history for all tree mutations
- **Save / Load** — `.tui` JSON format via native OS file picker (Chrome/Edge) or browser download (Firefox/Safari)
- **Multi-Framework Export** — Complete, runnable programs for Textual, Ink, OpenTUI, Blessed, Bubble Tea, tview and Ratatui (plus HTML), with several screens, mouse support, scrolling and an API to drive the UI from your own code — see [Using the export](#using-the-export)
- **Command Palette** — `Cmd/Ctrl+P` for quick component creation, theme switching, and dark/light mode toggle
- **Gradient Backgrounds** — Add linear gradients to any element background with angle control and N color stops; rendered as discrete character-cell bands matching real ANSI terminal output
- **Settings** — Accent color presets, dark/light mode toggle, and default download folder

## Star History

<a href="https://www.star-history.com/?repos=Faustan1000%2Ftui-studio&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=Faustan1000/tui-studio&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=Faustan1000/tui-studio&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=Faustan1000/tui-studio&type=date&legend=top-left" />
 </picture>
</a>

## Quick Start

```bash
git clone https://github.com/Faustan1000/tui-studio.git
cd tui-studio
npm install
npm run dev
```

Open `http://localhost:5173`.

## Keyboard Shortcuts

| Action          | Shortcut                          |
| --------------- | --------------------------------- |
| Command Palette | `Cmd/Ctrl+P`                      |
| Save            | `Cmd/Ctrl+S`                      |
| Open            | `Cmd/Ctrl+O`                      |
| Export          | `Cmd/Ctrl+E`                      |
| Copy            | `Cmd/Ctrl+C`                      |
| Paste           | `Cmd/Ctrl+V`                      |
| Delete          | `Backspace` / `Delete`            |
| Undo            | `Cmd/Ctrl+Z`                      |
| Redo            | `Cmd/Ctrl+Shift+Z` / `Cmd/Ctrl+Y` |

**Component hotkeys** (when not typing):

| Key | Component | Key | Component   |
| --- | --------- | --- | ----------- |
| `b` | Button    | `t` | Tabs        |
| `r` | Box       | `l` | List        |
| `k` | Checkbox  | `e` | Tree        |
| `a` | Radio     | `m` | Menu        |
| `s` | Select    | `i` | TextInput   |
| `o` | Toggle    | `p` | ProgressBar |
| `n` | Spinner   | `y` | Text        |
| `j` | Spacer    |     |             |

## File Format

Projects are saved as `.tui` files (JSON). Version 2 holds all screens of a project:

```json
{
  "version": "2",
  "meta": {
    "name": "My Project",
    "theme": "dracula",
    "activeScreen": "screen-1",
    "savedAt": "..."
  },
  "screens": [{ "id": "screen-1", "tree": { "type": "Screen", "children": [] } }]
}
```

## Using the export

TUIStudio does not only draw a picture of your design: **the export is a complete program** for the
framework you pick, with the layout, colours, focus handling, mouse support, several screens and a
small API so that your own code can drive the UI.

### 1. Design for export

- **Code names.** Give every component your program needs to read or change a _Code name_
  (Properties panel). It becomes the member name in the exported code (`ui.submit_btn`,
  `ui.submitBtn`, `ui.SubmitBtn` ... depending on the language). Components without a code name are
  drawn but cannot be reached from your program.
- **Screens.** A project can have several screens (screen list in the left sidebar); the first one is
  shown at startup. A _Button_ can open a screen (Properties → _Opens screen_), and so can the
  items of a _Menu_, a _List_ and _Tabs_ (_Items open a screen_). A screen with a code name gets
  `ui.<screen>.show()`.
- **Bodies.** For _Tabs_, _Menu_ and _List_ you can create a body per item: the content is shown only
  while that item is selected, in the editor and in the export (also when your program selects the
  item).
- **Sizes.** `auto`, a number of cells, `fill` or a percentage like `20%`, plus min/max sizes. A
  percentage follows the terminal size in Textual, Ink and OpenTUI; Blessed, Bubble Tea, tview and
  Ratatui export it as the cells of the design size (the export panel tells you).
- **Event handlers.** Components with events get stub functions in the exported code
  (`handleClick`, `handleChange` ...) for you to fill in.

### 2. Export

Press `Cmd/Ctrl+E` (or the export button). _Code_ mode shows every file of the export; copy a file or
save them all (to your download folder). The other modes give a preview, plain or ANSI text of the
current screen, and an HTML page.

From the command line, for example in a script or CI:

```bash
node scripts/export-project.mjs examples/demo/demo.tui out ink ratatui   # the frameworks are optional
```

`examples/demo/` contains a demo project and its export for every framework (regenerate with
`npm run examples`).

### 3. Run it

Each export is a folder with everything needed. `API.md` in it lists every code name, property, state
and event with the exact spelling for that language.

| Framework                                                | Needs        | Start (inside the folder)                      |
| -------------------------------------------------------- | ------------ | ---------------------------------------------- |
| [Textual](https://github.com/Textualize/textual)         | Python 3.9+  | `pip install "textual>=6"` then `python ui.py` |
| [Ink](https://github.com/vadimdemedes/ink)               | Node.js 20+  | `npm install && npm start`                     |
| [OpenTUI](https://opentui.js.org/)                       | Bun 1.2+     | `bun install && bun start`                     |
| [Blessed](https://github.com/chjj/blessed)               | Node.js 18+  | `npm install && npm start`                     |
| [Bubble Tea](https://github.com/charmbracelet/bubbletea) | Go 1.24+     | `go mod tidy && go run .`                      |
| [tview](https://github.com/rivo/tview)                   | Go 1.23+     | `go mod tidy && go run .`                      |
| [Ratatui](https://ratatui.rs/)                           | Rust (cargo) | `cargo run`                                    |
| HTML                                                     | a browser    | open the file (current screen only)            |

Keys in the exported program: `Tab` / `Shift+Tab` move the focus, `Enter` or `Space` activates,
`Ctrl+L` shows the log, `q` or `Ctrl+C` quits (Textual: `Ctrl+Q`; `q` not while a text field has
focus). The mouse works (click, wheel; PageUp/PageDown/Home/End scroll). Node-based programs (Ink,
Blessed, OpenTUI) get mouse input only in terminals that send VT mouse reports, such as Windows
Terminal or VS Code; the classic Windows console window does not deliver them, use the keyboard
there.

### 4. Drive the UI from your program

The exported UI runs **next to your program** and never blocks it. In Go and Rust your code goes into
the generated `main` file; in the other languages you import the generated `Ui`:

```python
# Python (Textual)
from ui import Ui

ui = Ui()
ui.start()                                    # the UI runs concurrently
ui.submit_btn.on_click(lambda e: print("clicked", e.value))
ui.status.text = "Ready"                      # writing never fires a change event
ui.name_input.readonly()                      # states: mute, readonly, hide, show
ui.report("Connection lost")                  # error dialog over the UI, also in the log
ui.wait()                                     # until the user quits
```

```ts
// TypeScript (Ink, OpenTUI, Blessed)
const ui = new Ui();
await ui.start();
ui.submitBtn.onClick(() => (ui.status.text = 'Sent'));
ui.settings.show(); // switch to the screen with the code name "settings"
await ui.wait();
```

```go
// Go (Bubble Tea, tview): the function you fill in, in main.go
func program(ui *Ui) {
	ui.SubmitBtn.OnClick(func(e Event) { ui.Status.SetText("Sent") })
	ui.Progress.SetValue(42)
}
```

```rust
// Rust (Ratatui): the function you fill in, in src/main.rs
fn program(ui: Ui) {
    ui.submit_btn.on_click(|e| println!("clicked {:?}", e.value));
    ui.status.set_text("Ready");
}
```

States, properties, events, the event queue, error dialog, log, screens and the threading rules are
the same in every language: see [docs/PROGRAM_API.md](docs/PROGRAM_API.md).

### 5. What to expect

| Framework  | Layout                        | Notes                                                                        |
| ---------- | ----------------------------- | ---------------------------------------------------------------------------- |
| Textual    | native + snapshot             | the reference: every other export is compared with it cell by cell           |
| Ink        | native flexbox (Yoga)         |                                                                              |
| OpenTUI    | native flexbox                |                                                                              |
| Blessed    | snapshot of the editor layout | fixed positions: siblings do not move when a body of another height is shown |
| Bubble Tea | native + snapshot             |                                                                              |
| tview      | native + snapshot             | one border style per screen (`tview.Borders` is global)                      |
| Ratatui    | native + snapshot             |                                                                              |

Content taller than the terminal scrolls (mouse wheel, PageUp/PageDown, the focus moves it into
view). Known gaps per framework and what is planned are in [ROADMAP.md](ROADMAP.md).

## Development and tests

```bash
npm test            # unit tests and every exporter, run headless against the real libraries
npm run test:setup  # once: installs the Node/Bun packages the generated apps run with
npm run test:pty    # every generated program in a real pseudo-terminal (docs/TERMINAL_TESTS.md)
```

The tests need the toolchains of the frameworks you want checked (Go, Rust, Bun, Python with
Textual); a framework whose toolchain is missing is skipped.
[docs/EXPORT_ADAPTERS.md](docs/EXPORT_ADAPTERS.md) describes how an exporter is built and tested,
[docs/TERMINAL_TESTS.md](docs/TERMINAL_TESTS.md) the terminal tests. The GitHub Actions workflow
(`.github/workflows/ci.yml`) runs everything on Linux.

## Tech Stack

- **React 19**, TypeScript 5.8, Vite 7
- **Zustand 5** — state management
- **Tailwind CSS** — editor UI styling
- **Lucide React** — icons

## Commands

```bash
npm run dev      # Start dev server
npm run build    # TypeScript compile + production build
npm run lint     # ESLint
npm test         # tests (see Development and tests)
npm run preview  # Preview production build
```

---

**Issues**: [GitHub Issues](https://github.com/Faustan1000/tui-studio/issues)

## LOLcense

For {root} sake I'm a designer. Mostly all the code has been written by Claude and ad latere.
