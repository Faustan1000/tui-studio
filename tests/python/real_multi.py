"""Multi-screen + tab bodies against real Textual (headless)."""

import asyncio
import sys
import threading
import time
import traceback

sys.path.insert(0, sys.argv[1])  # directory with the generated ui.py

from textual.widgets import DataTable, Input, ProgressBar, Static  # noqa: E402

from ui import Ui, MyApp  # noqa: E402
from ui_runtime import UiError  # noqa: E402

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


def text_of(w):
    c = getattr(w, "content", None)
    if c is None:
        c = getattr(w, "renderable", "")
    return str(c)


def shown(app, wid):
    try:
        return app.screen.query_one("#" + wid).display
    except Exception:
        return None


async def main() -> None:
    ui = Ui()
    app = MyApp(ui=ui)
    shows = []
    ui.settings.on_show(lambda: shows.append("settings"))
    ui.home.on_show(lambda: shows.append("home"))
    clicks = []
    ui.go_settings.on_click(lambda: ui.settings.show())
    ui.back_btn.on_click(lambda: ui.home.show())
    ui.agent_btn.on_click(lambda: clicks.append("agent"))

    async with app.run_test(size=(100, 60)) as pilot:
        await settle(ui, app, pilot)
        await pilot.pause()
        await pilot.pause()

        check("starts on the first screen", ui.current_screen == "home", ui.current_screen)
        check("home widgets exist", shown(app, "status") is not None)
        check("settings widgets are not mounted yet", shown(app, "name_input") is None)
        check("no errors at startup", not ui.errors, [e.message for e in ui.errors])

        # ---- tab bodies -------------------------------------------------------------
        check("body 0 visible at start", shown(app, "_n_tb0") is True)
        check("body 1 hidden at start", shown(app, "_n_tb1") is False)
        check("body 2 hidden at start", shown(app, "_n_tb2") is False)
        ui.pages.active_tab = 1
        await pilot.pause()
        await pilot.pause()
        check("tab 1: body 1 visible", shown(app, "_n_tb1") is True)
        check("tab 1: body 0 hidden", shown(app, "_n_tb0") is False)
        ui.pages.active_tab = 2
        await pilot.pause()
        await pilot.pause()
        check("tab 2: body 2 visible, others hidden", shown(app, "_n_tb2") is True and shown(app, "_n_tb1") is False and shown(app, "_n_tb0") is False)

        # user clicks a tab
        await pilot.click("#pages__0")
        await pilot.pause()
        await pilot.pause()
        check("clicking a tab switches the body", shown(app, "_n_tb0") is True and shown(app, "_n_tb2") is False)

        # body widgets are reachable through handles while visible
        ui.pages.active_tab = 1
        await pilot.pause()
        await pilot.pause()
        await pilot.click("#agent_btn")
        check("button inside a body works", await until(lambda: clicks == ["agent"]), clicks)
        ui.agent_text.text = "Agent updated"
        await pilot.pause()
        check("text inside a hidden-then-shown body updates", "Agent updated" in text_of(app.screen.query_one("#agent_text", Static)))

        # menu bodies
        check("menu body 0 visible at start", shown(app, "_n_mb0") is True and shown(app, "_n_mb1") is False)
        ui.side.selected = 1
        await pilot.pause()
        await pilot.pause()
        check("menu selection switches the body", shown(app, "_n_mb1") is True and shown(app, "_n_mb0") is False, (shown(app, "_n_mb0"), shown(app, "_n_mb1")))

        # ---- values set for a screen that is not shown ------------------------------
        ui.name_input.value = "typed while away"
        ui.progress.value = 70
        ui.results.rows = [["x", "y"], ["z", "w"], ["q", "r"]]
        ui.status.text = "changed on home"
        await pilot.pause()
        check("setting values of another screen is silent", not ui.errors, [e.message for e in ui.errors])

        # ---- switching screens ------------------------------------------------------
        await pilot.click("#go_settings")
        check("button callback switched the screen", await until(lambda: ui.current_screen == "settings"), ui.current_screen)
        await pilot.pause()
        await pilot.pause()
        check("settings widgets exist now", shown(app, "name_input") is not None)
        check("home widgets are gone", shown(app, "status") is None)
        check("cached input value applied", app.screen.query_one("#name_input", Input).value == "typed while away", app.screen.query_one("#name_input", Input).value)
        check("cached progress applied", app.screen.query_one("#progress", ProgressBar).progress == 70, app.screen.query_one("#progress", ProgressBar).progress)
        check("cached table rows applied", app.screen.query_one("#results", DataTable).row_count == 3, app.screen.query_one("#results", DataTable).row_count)
        check("on_show fired for settings", await until(lambda: "settings" in shows), shows)
        check("is_active reflects the screen", ui.settings.is_active and not ui.home.is_active)

        ui.name_input.readonly()
        await pilot.pause()
        await pilot.click("#back_btn")
        check("back to home", await until(lambda: ui.current_screen == "home"))
        await pilot.pause()
        await pilot.pause()
        check("home text cached while away is shown", "changed on home" in text_of(app.screen.query_one("#status", Static)), text_of(app.screen.query_one("#status", Static)))
        check("tab state survives the round trip", shown(app, "_n_tb1") is True and shown(app, "_n_tb0") is False, (shown(app, "_n_tb0"), shown(app, "_n_tb1")))
        check("menu state survives the round trip", shown(app, "_n_mb1") is True)
        ui.settings.show()
        await pilot.pause()
        await pilot.pause()
        check("readonly state re-applied on the screen", app.screen.query_one("#name_input").disabled is True)
        ui.home.show()
        await pilot.pause()
        await pilot.pause()

        # untagged third screen by key
        ui.show_screen("_screen_3")
        await pilot.pause()
        await pilot.pause()
        check("screen without code name reachable by key", ui.current_screen == "_screen_3", ui.current_screen)
        ui.show_screen("home")
        await pilot.pause()
        await pilot.pause()

        try:
            ui.show_screen("missing")
            check("unknown screen raises", False)
        except UiError:
            check("unknown screen raises", True)

        # ---- modal on a screen, closes on screen switch -----------------------------
        ui.confirm_text.text = "Set before opening"
        ui.confirm.open()
        await pilot.pause()
        await pilot.pause()
        check("modal opens", type(app.screen).__name__ == "StudioModal1", type(app.screen).__name__)
        check("modal text cached before open is shown", "Set before opening" in text_of(app.screen.query_one("#confirm_text", Static)), text_of(app.screen.query_one("#confirm_text", Static)))
        ui.settings.show()
        await pilot.pause()
        await pilot.pause()
        check("showing a screen closes the modal", ui.current_screen == "settings" and type(app.screen).__name__ == "SettingsScreen", type(app.screen).__name__)
        ui.home.show()
        await pilot.pause()
        await pilot.pause()

        check("no errors in the whole run", not ui.errors, [e.message for e in ui.errors])


try:
    asyncio.run(main())
except Exception:
    traceback.print_exc()
    failures.append("crashed")

# ---- switching from another thread (UI in its own thread, headless) ----------------
ui2 = Ui()
ui2.start(timeout=15, headless=True)
t0 = time.time()
ui2.settings.show()
ok = False
while time.time() - t0 < 3:
    if ui2.current_screen == "settings":
        ok = True
        break
    time.sleep(0.05)
check("thread: show() from the program thread switches screens", ok, ui2.current_screen)
ui2.name_input.value = "from main"
time.sleep(0.4)
box = {}


def read():
    box["v"] = ui2._find("name_input").value


ui2._app.call_from_thread(read)
check("thread: value reaches the visible screen", box.get("v") == "from main", box)
ui2.stop()
check("thread: stop", ui2.wait(5))

print()
print("FAILED: " + ", ".join(failures) if failures else "ALL PASSED")
sys.exit(1 if failures else 0)
