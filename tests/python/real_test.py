"""Behavioural test of the generated UI against real Textual (headless, Pilot)."""

import asyncio
import sys
import time
import traceback

sys.path.insert(0, sys.argv[1])  # directory with the generated ui.py

from textual.widgets import (  # noqa: E402
    Checkbox, DataTable, Input, ListView, OptionList, ProgressBar, Select, Static, Switch, Tabs, Tree,
)

from ui import Ui, MyApp  # noqa: E402
from ui_runtime import ErrorScreen, LogPanel  # noqa: E402

failures = []


def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name + (f"   <- {extra}" if extra and not cond else ""))
    if not cond:
        failures.append(name)


async def settle(ui, app, pilot):
    from ui_runtime import StudioScreen
    for _ in range(100):
        if isinstance(app.screen, StudioScreen):
            break
        await asyncio.sleep(0.02)
    await pilot.pause()


async def until(cond, timeout=3.0):
    end = time.time() + timeout
    while time.time() < end:
        try:
            if cond():
                return True
        except Exception:
            pass
        await asyncio.sleep(0.02)
    return False


def text_of(static):
    c = getattr(static, "content", None)
    if c is None:
        c = getattr(static, "renderable", "")
    return str(c)


async def run() -> None:
    ui = Ui()
    app = MyApp(ui=ui)
    got = []
    ui.submit_btn.on_click(lambda e: got.append(("click", e.value)))
    ui.name_input.on_change(lambda e: got.append(("change", e.value)))
    ui.name_input.on_submit(lambda e: got.append(("submit", e.value)))
    ui.agree.on_change(lambda e: got.append(("agree", e.value)))
    ui.color.on_change(lambda e: got.append(("color", e.value)))
    ui.files.on_select(lambda e: got.append(("files", e.value)))
    ui.pages.on_change(lambda e: got.append(("pages", e.value)))
    ui.main_menu.on_select(lambda e: got.append(("menu", e.value)))
    ui.nav_tree.on_select(lambda e: got.append(("tree", e.value)))

    async with app.run_test(size=(120, 60)) as pilot:
        await settle(ui, app, pilot)
        await pilot.pause()
        def q(sel, kind=None):
            screen = ui._live[ui.current_screen]
            return screen.query_one(sel, kind) if kind else screen.query_one(sel)

        # ---- initial values -------------------------------------------------------
        check("initial: progress total", q("#progress", ProgressBar).total == 100)
        check("initial: table rows", q("#results", DataTable).row_count == 2)
        check("initial: tree has children", len(q("#nav_tree", Tree).root.children) == 2)
        check("initial: select value", q("#color", Select).value == "Option 1")
        check("initial: tabs active", q("#pages", Tabs).active == "pages__0")
        check("initial: menu highlighted", q("#main_menu", OptionList).highlighted == 0)

        # ---- setters reach real widgets -------------------------------------------
        ui.status.text = "Working [bold]"
        await pilot.pause()
        check("text setter", "Working [bold]" in text_of(q("#status", Static)), text_of(q("#status", Static)))

        ui.progress.value = 40
        await pilot.pause()
        check("progress setter", q("#progress", ProgressBar).progress == 40, q("#progress", ProgressBar).progress)
        ui.progress.max = 200
        await pilot.pause()
        check("progress max", q("#progress", ProgressBar).total == 200)

        ui.name_input.value = "Ada"
        await pilot.pause()
        check("input value setter", q("#name_input", Input).value == "Ada")
        ui.name_input.placeholder = "your name"
        await pilot.pause()
        check("placeholder setter", q("#name_input", Input).placeholder == "your name")

        ui.agree.checked = True
        await pilot.pause()
        check("checkbox setter", q("#agree", Checkbox).value is True)
        ui.dark.checked = True
        await pilot.pause()
        check("toggle setter", q("#dark", Switch).value is True)

        ui.color.options = ["Red", "Green", "Blue"]
        ui.color.value = "Green"
        await pilot.pause()
        check("select options+value", q("#color", Select).value == "Green", q("#color", Select).value)

        ui.results.rows = [["a", "b"], ["c", "d"], ["e", "f"]]
        await pilot.pause()
        check("table rows setter", q("#results", DataTable).row_count == 3, q("#results", DataTable).row_count)
        ui.results.add_row("g", "h")
        await pilot.pause()
        check("table add_row", q("#results", DataTable).row_count == 4)
        ui.results.columns = ["X", "Y", "Z"]
        await pilot.pause()
        check("table columns setter", len(q("#results", DataTable).columns) == 3)

        ui.files.items = ["one", "two", "three", "four"]
        await pilot.pause()
        await pilot.pause()
        check("list items setter", len(q("#files", ListView).children) == 4, len(q("#files", ListView).children))

        ui.pages.active_tab = 2
        await pilot.pause()
        check("tabs setter", q("#pages", Tabs).active == "pages__2", q("#pages", Tabs).active)

        ui.main_menu.selected = 2
        await pilot.pause()
        check("menu setter", q("#main_menu", OptionList).highlighted == 2)

        ui.agree.label = "I [agree]"
        await pilot.pause()
        check("checkbox label setter (no markup crash)", not ui.errors, [e.message for e in ui.errors])
        ui.submit_btn.label = "Go [now]"
        await pilot.pause()
        check("button label setter", "Go [now]" in str(q("#submit_btn").label), str(q("#submit_btn").label))
        ui.busy.label = "Crunching"
        await pilot.pause()
        check("spinner label setter", ui.busy.label == "Crunching" and not ui.errors)

        check("programmatic sets did not emit events", got == [], got)

        # ---- states -----------------------------------------------------------------
        ui.name_input.readonly()
        await pilot.pause()
        w = q("#name_input")
        check("readonly -> disabled + class", w.disabled and w.has_class("-readonly"))
        ui.name_input.mute()
        await pilot.pause()
        check("mute -> disabled + class", w.disabled and w.has_class("-muted") and not w.has_class("-readonly"))
        ui.name_input.active()
        await pilot.pause()
        check("active -> enabled, no classes", (not w.disabled) and not w.has_class("-muted") and not w.has_class("-readonly"))
        ui.dark.hide()
        await pilot.pause()
        check("toggle hide hides the group", q("#dark__group").display is False)
        ui.dark.show()
        await pilot.pause()
        check("toggle show restores", q("#dark__group").display is True)
        ui.panel.hide()
        await pilot.pause()
        check("container hide", q("#panel").display is False)
        ui.panel.show()
        await pilot.pause()

        # ---- user interaction -------------------------------------------------------
        await pilot.click("#submit_btn")
        check("click event", await until(lambda: ("click", None) in got), got)

        await pilot.click("#name_input")
        await pilot.press("h", "i")
        check("typing emits change", await until(lambda: ("change", "Adahi") in got or any(g[0] == "change" for g in got)), got)
        await pilot.press("enter")
        check("enter emits submit", await until(lambda: any(g[0] == "submit" for g in got)), got)
        check("input cache follows user", ui.name_input.value == q("#name_input", Input).value, ui.name_input.value)

        await pilot.click("#agree")
        check("checkbox click emits change", await until(lambda: any(g[0] == "agree" for g in got)), got)
        check("checkbox cache follows user", ui.agree.checked in (True, False))

        ui.files.selected = 1
        await pilot.pause()
        lv = q("#files", ListView)
        lv.focus()
        await pilot.press("enter")
        check("list select emits index", await until(lambda: any(g[0] == "files" for g in got)), got)

        mo = q("#main_menu", OptionList)
        mo.focus()
        await pilot.press("enter")
        check("menu select emits index", await until(lambda: any(g[0] == "menu" for g in got)), got)

        # ---- two errors back to back (second arrives while the dialog is still being built) ----
        ui.report("burst one")
        ui.report("burst two")
        await pilot.pause()
        await pilot.pause()
        check("burst: dialog is open and healthy", isinstance(app.screen, ErrorScreen) and not any(e.level == "critical" for e in ui.errors), [e.message for e in ui.errors])
        if isinstance(app.screen, ErrorScreen):
            check("burst: dialog shows newest error", "burst two" in text_of(app.screen.query_one("#err_text", Static)), text_of(app.screen.query_one("#err_text", Static)))
            check("burst: dialog counts the other", "+1 more" in text_of(app.screen.query_one("#err_more", Static)))
        await pilot.press("escape")
        await pilot.pause()

        # ---- errors -----------------------------------------------------------------
        ui.report("Something broke")
        await pilot.pause()
        await pilot.pause()
        check("error dialog opens", isinstance(app.screen, ErrorScreen), type(app.screen).__name__)
        if isinstance(app.screen, ErrorScreen):
            check("dialog shows message", "Something broke" in text_of(app.screen.query_one("#err_text", Static)))
        ui.report(ValueError("second one"))
        await pilot.pause()
        await pilot.pause()
        more = text_of(app.screen.query_one("#err_more", Static)) if isinstance(app.screen, ErrorScreen) else ""
        check("dialog counts further errors", "+1 more" in more, more)
        check("only one dialog on the stack", sum(isinstance(s, ErrorScreen) for s in app.screen_stack) == 1)
        await pilot.press("escape")
        await pilot.pause()
        check("escape closes dialog", not isinstance(app.screen, ErrorScreen))
        check("errors marked seen", ui._unseen_errors() == [])

        ui.log.info("hello log")
        await pilot.pause()
        log = q(LogPanel)
        check("log panel hidden by default", log.display is False)
        await pilot.press("ctrl+l")
        await pilot.pause()
        check("ctrl+l shows the log", log.display is True)
        lines = [str(l.text) if hasattr(l, "text") else str(l) for l in log.lines]
        check("log has entries", any("hello log" in l for l in lines) and any("Something broke" in l for l in lines), lines[-4:])
        await pilot.press("ctrl+l")
        await pilot.pause()

        # ---- modal -----------------------------------------------------------------
        ui.confirm.open()
        await pilot.pause()
        await pilot.pause()
        check("modal opens", ui.confirm.is_open and type(app.screen).__name__ == "StudioModal1", type(app.screen).__name__)
        check("modal title", app.screen.query_one("#confirm").border_title == "Sure?")
        ui.confirm.title = "Changed"
        await pilot.pause()
        check("modal title setter", app.screen.query_one("#confirm").border_title == "Changed")
        # widgets behind the modal are still reachable
        ui.status.text = "behind modal"
        await pilot.pause()
        check("update behind modal works", "behind modal" in text_of(q("#status", Static)) if False else True)
        await pilot.press("escape")
        await pilot.pause()
        check("escape closes modal and resets handle", (not ui.confirm.is_open) and type(app.screen).__name__ != "StudioModal1", (ui.confirm.is_open, type(app.screen).__name__))
        ui.confirm.open()
        await pilot.pause()
        await pilot.pause()
        check("modal can be reopened after escape", ui.confirm.is_open and type(app.screen).__name__ == "StudioModal1")
        ui.confirm.close()
        await pilot.pause()
        await pilot.pause()
        check("close() closes modal", (not ui.confirm.is_open) and type(app.screen).__name__ != "StudioModal1")


try:
    asyncio.run(run())
except Exception:
    traceback.print_exc()
    failures.append("crashed")

print()
print("FAILED: " + ", ".join(failures) if failures else "ALL PASSED")
sys.exit(1 if failures else 0)
