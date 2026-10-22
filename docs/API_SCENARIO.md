# API scenario

The scenario every framework's generated program API must pass, run headless against the real
framework (`tests/api.<framework>.test.ts`). It uses the design `apiDesign()` from
`tests/fixtures/apiDesign.ts` (a screen with: `status` Text "Ready", `name_input` TextInput,
`submit_btn` Button "Send", `agree` Checkbox, `color` Select, `progress` ProgressBar,
`results` Table, `files` List, `pages` Tabs, `panel` Box with `inner` Text, `confirm` Modal).

| #   | Step                                                                                    | Expected                                                                                   |
| --- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| S1  | `start()`                                                                               | returns when ready; `ready` and `running` are true                                         |
| S2  | read initial properties and states                                                      | equal the design (`status.text == "Ready"`, `progress.max == 100`, state `active`)         |
| S3  | write `status.text`, `progress.value`, `name_input.value` from another thread/goroutine | read-after-write returns the new value at once; the next rendered frame shows it           |
| S4  | `submit_btn.mute()`                                                                     | still drawn (dimmed); simulated Enter/click fires no event                                 |
| S5  | `panel.hide()` then `panel.show()`                                                      | frame no longer contains `inner`'s text, then contains it again                            |
| S6  | `name_input.readonly()`, simulate typing                                                | value unchanged, no event; `active()` then typing changes the value                        |
| S7  | `submit_btn.readonly()`                                                                 | error (unsupported state), nothing changes                                                 |
| S8  | simulate Enter on `submit_btn`; type into `name_input`; toggle `agree`                  | handlers run **off the UI thread** with `{tag, name, value}`; the queue returns the events |
| S9  | program writes `agree.checked = true`                                                   | no `change` event (no echo)                                                                |
| S10 | `report("boom")`                                                                        | frame shows a dialog with "boom"; `errors` has it; Esc/Enter closes the dialog             |
| S11 | a handler throws                                                                        | reported like S10; the UI keeps running                                                    |
| S12 | `log.info("hello")`, Ctrl+L                                                             | log panel appears and shows "hello"; Ctrl+L again hides it                                 |
| S13 | `confirm.open()` / `close()`                                                            | modal shown / gone                                                                         |
| S14 | `stop()`                                                                                | `wait()` returns; later calls do not throw                                                 |

Textual passes this today (tests/python/real_test.py, real_thread.py).
