# Demo project

`demo.tui` is a TUI Studio project (open it in the editor with *File → Open*). The folders next to
it are its export for every framework; each is a complete, runnable project.

| Framework | Folder | Needs | Start (inside the folder) |
| --- | --- | --- | --- |
| Textual (Python) | `textual/` | Python 3.9+ | `pip install "textual>=6" && python ui.py` |
| Ink (React) | `ink/` | Node.js 20+ | `npm install && npm start` |
| OpenTUI (React) | `opentui/` | Bun 1.2+ | `bun install && bun start` |
| Blessed (Node.js) | `blessed/` | Node.js 18+ | `npm install && npm start` |
| Bubble Tea (Go) | `bubbletea/` | Go 1.24+ | `go mod tidy && go run .` |
| tview (Go) | `tview/` | Go 1.23+ | `go mod tidy && go run .` |
| Ratatui (Rust) | `ratatui/` | Rust (cargo) | `cargo run` |

Keys: `Tab` / `Shift+Tab` move the focus, `Enter` or `Space` activates, `Ctrl+L` shows the log, `q` or `Ctrl+C` quits (not while a text field has focus). Mouse: click, wheel and PageUp/PageDown/Home/End scroll. Node-based apps (Ink, Blessed, OpenTUI) receive mouse input only in terminals that send VT mouse reports, such as Windows Terminal or VS Code; the classic console window (conhost) delivers none to Node, so use the keyboard there.

Regenerate everything after changing the design or an exporter: `npm run examples`.
