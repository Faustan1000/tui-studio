# Terminal tests

The other tests drive every framework through its own test hooks (Ink's testing library, a tcell
simulation screen, ratatui's `TestBackend`, ...). They cannot show what only a real terminal shows:
that `start()`/`run()` works on a tty, that mouse reports arrive as bytes, that a resize reaches the
program, and that quitting leaves the terminal as it was. `tests/pty.test.ts` covers that.

## How it works

- `tests/pty/ptydriver.py` starts the generated program in a **pseudo-terminal** (POSIX `pty`),
  sends keys and **SGR mouse reports** (`ESC[<0;x;yM`) as bytes, resizes the terminal and reads the
  screen through a terminal emulator (`pyte`). It answers the queries some libraries send at startup
  (cursor position, device attributes, colours) because they wait for a reply.
- `tests/pty/scenario.py` is the scenario, the same for every framework: start on the first screen,
  click a menu item that opens a screen, click the button back, click a tab that opens a screen,
  resize the terminal, quit (Ctrl+C, then `q`) and check that mouse reporting, the alternate screen
  and the cursor were switched back. One JSON line per step.
- `tests/pty.test.ts` exports the `screenLinks()` design for each framework, builds it where needed
  (Go, Rust), runs the scenario and fails with the step and the screen that was shown.

## Running

```bash
pip install -r tests/pty/requirements.txt   # pyte, textual
npm run test:setup                          # the Node/Bun packages of the generated apps
npm run test:pty
```

A framework is skipped when its toolchain is not installed. The CI workflow
(`.github/workflows/ci.yml`) installs all of them on Linux and runs the headless tests and the
terminal tests as separate steps.

On Windows the tests are off by default. `TUISTUDIO_PTY=1` together with `pip install pywinpty`
runs them through ConPTY as a local try-out; the classic console (conhost) does not deliver mouse
reports to Node/Bun, so the mouse steps may fail there. The opt-in
`tests/helpers/winconsole.ps1` test of the Ink app stays for the real Windows console.

## Adding a step

Add it to `scenario.py` (use `term.click_on(text)`, `term.key(name)`, `term.wheel(...)`,
`term.resize(cols, rows)`, `term.wait_for(text)`) and keep it independent of the framework: every
framework draws the same design, so the same texts are on screen.
