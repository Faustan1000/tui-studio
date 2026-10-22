# Program API

The exported UI runs **next to your program**, not inside it. Your program talks to named
components through a small facade, and the UI never blocks it (and the other way round).
Textual (Python) is the reference implementation (`src/utils/export/api/ui_runtime.py`); every
other framework generates the same API in its own idiom.

```python
ui = Ui()
ui.start()                         # UI runs concurrently, returns when it is ready
ui.submit_btn.on_click(handler)    # events
ui.status.text = "Ready"           # properties
ui.name_input.readonly()           # states
ui.report("Connection lost")       # opens an error dialog, goes to the log
ui.wait()                          # block until the UI is closed
```

## What is exposed

Every component with a **code name** (Properties → Code name) becomes a member of `ui`, spelled
as typed in the editor. Components without a code name are not reachable from the program.
`src/utils/export/api/spec.ts` is the single table of states, properties and events per
component; `src/utils/export/api/model.ts` turns a design into the list of handles to generate.

## Naming per language

| Concept        | Python             | TypeScript (Ink/OpenTUI/Blessed) | Go                      | Rust                     |
| -------------- | ------------------ | -------------------------------- | ----------------------- | ------------------------ |
| code name      | `ui.submit_btn`    | `ui.submitBtn`                   | `ui.SubmitBtn`          | `ui.submit_btn`          |
| state          | `.mute()`          | `.mute()`                        | `.Mute()`               | `.mute()`                |
| property read  | `.text`            | `.text`                          | `.Text()`               | `.text()`                |
| property write | `.text = "x"`      | `.text = "x"`                    | `.SetText("x")`         | `.set_text("x")`         |
| event handler  | `.on_click(fn)`    | `.onClick(fn)`                   | `.OnClick(fn)`          | `.on_click(fn)`          |
| event queue    | `ui.next_event()`  | `await ui.nextEvent()`           | `ui.Events()` (channel) | `ui.events()` (receiver) |
| log            | `ui.log.info("x")` | `ui.log.info("x")`               | `ui.Log.Info("x")`      | `ui.log().info("x")`     |

Code names that are keywords of the target language get a trailing `_` (Rust, TypeScript).
Names are never changed otherwise, apart from the case style above.

## Lifecycle

| Python             | Meaning                                                                             |
| ------------------ | ----------------------------------------------------------------------------------- |
| `start()`          | Start the UI concurrently (own thread / goroutine / event loop). Returns when ready |
| `run(main)`        | UI on the current thread, `main(ui)` in a worker; returns when the UI closes        |
| `stop()`           | Close the UI                                                                        |
| `wait()`           | Block until the UI is closed                                                        |
| `ready`, `running` | Flags                                                                               |

Closing the UI (quit key or `stop()`) ends `wait()`. After that handle calls are ignored
without error.

## States

`active` (normal) · `mute` (visible, dimmed, ignores input, fires no events) · `readonly`
(looks normal, the user cannot change it) · `hide` (not shown, not focusable, takes no space).
`.state` returns the current one, `.show()` is `active()` from hidden. Which states a component
supports is in `spec.ts`; an unsupported state (e.g. `readonly` on a button) is an error
(`UiError` / thrown error / returned error / `Err`), never silently ignored.

## Properties

Reading returns the value the user sees, including what the user typed. Writing updates the UI.
**Writing never fires a change event** (no echo): events mean "the user did this".
Types: text, whole number, number, true/false, list of texts, rows (list of lists of texts).

## Events

Names per component are in `spec.ts` (`click`, `change`, `submit`, `select`). Two ways to
consume them, and both can be used together:

1. **Handlers**: `ui.x.on_click(fn)`; several handlers per event are allowed. Handlers run on a
   worker thread/goroutine/microtask, **never on the UI thread**, so a slow handler cannot
   freeze the UI. The handler receives the event (`tag`, `name`, `value`, `time`) or, where the
   language allows, no arguments.
2. **Queue**: `ui.next_event(timeout)` returns the next event of any component, so a program
   can run its own loop.

An event from a muted, readonly or hidden component is never sent.

## Errors and log

- `ui.report(error | message)` opens a **dialog over the UI** with the message and details, adds
  an entry to `ui.errors` and writes to the log. Several reports stack in one dialog. Enter/Esc
  closes it.
- Exceptions inside event handlers and inside the UI are reported automatically. Uncaught
  exceptions of your own program are reported if you call `ui.install_excepthooks()`
  (Python), `ui.installExcepthooks()` (TS), `ui.CatchPanics(...)` (Go), `ui.install_panic_hook()`
  (Rust).
- `ui.log.debug/info/warning/error(msg)`; **Ctrl+L** toggles a log panel at the bottom of every
  screen. Errors are in the log with level `error`/`critical`.

## Threading guarantees

- Every call on `ui` and on any handle is safe from any thread/goroutine.
- Calls are asynchronous: they return immediately; the UI catches up. A read after a write
  returns the written value at once.
- The UI keeps running if your program stops; your program keeps running if the UI is closed.

## Containers and modals

Boxes and grids support `hide()/show()`. A **Modal** has `open()`, `close()`, `is_open` and
`title`; it is shown on top of the UI and closes with Esc.

## Screens

Several screens (`ui.<screen code name>.show()`, links between screens) exist for Textual only
so far; the other frameworks export the first screen. See `ROADMAP.md`.

## Testing the API

`tests/` runs the same scenario against every framework (set values, change states, click,
read events, report an error, read the log). See `docs/EXPORT_ADAPTERS.md` for the layers.
