"""Screen links (button / menu / list items open a screen) against real Textual."""

import asyncio
import sys
import time
import traceback

sys.path.insert(0, sys.argv[1])  # directory with the generated ui.py

from ui import Ui, MyApp  # noqa: E402
from ui_runtime import StudioScreen  # noqa: E402

failures = []


def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name + (f"   <- {extra}" if extra else ""))
    if not cond:
        failures.append(name)


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


async def main():
    ui = Ui()
    app = MyApp(ui=ui)
    heard = []
    ui.go_settings.on_click(lambda: heard.append("go_settings"))

    async with app.run_test(size=(100, 50)) as pilot:
        for _ in range(100):
            if isinstance(app.screen, StudioScreen):
                break
            await asyncio.sleep(0.02)
        await pilot.pause()
        check("starts on home", ui.current_screen == "home", ui.current_screen)

        # button with a link
        await pilot.click("#go_settings")
        check("button opens the linked screen", await until(lambda: ui.current_screen == "settings"), ui.current_screen)
        check("program still hears the click", await until(lambda: heard == ["go_settings"]), heard)
        await pilot.pause()
        await pilot.pause()

        await pilot.click("#back_btn")
        check("back button opens home again", await until(lambda: ui.current_screen == "home"), ui.current_screen)
        await pilot.pause()
        await pilot.pause()

        # dead link and no link: nothing happens, nothing breaks
        await pilot.click("#go_nowhere")
        await pilot.click("#plain")
        await pilot.pause()
        check("button with a missing target does nothing", ui.current_screen == "home")

        # menu items
        menu = app.screen.query_one("#side")
        menu.focus()
        await pilot.pause()
        await pilot.press("down")  # item 1: no link
        await pilot.press("enter")
        await pilot.pause()
        check("menu item without link stays", ui.current_screen == "home", ui.current_screen)
        await pilot.press("up")
        await pilot.press("enter")  # item 0 -> about (screen without code name)
        check("menu item opens its screen", await until(lambda: ui.current_screen == "_screen_3"), ui.current_screen)
        await pilot.pause()
        await pilot.pause()
        await pilot.click("#about_back")
        check("link back from the third screen", await until(lambda: ui.current_screen == "home"), ui.current_screen)
        await pilot.pause()
        await pilot.pause()

        # list items
        files = app.screen.query_one("#files")
        files.focus()
        await pilot.pause()
        await pilot.press("enter")  # item 0 -> about
        check("list item opens its screen", await until(lambda: ui.current_screen == "_screen_3"), ui.current_screen)

        check("no errors", not ui.errors, [e.message for e in ui.errors])


try:
    asyncio.run(main())
except Exception:
    traceback.print_exc()
    failures.append("crashed")

print()
print("FAILED: " + ", ".join(failures) if failures else "ALL PASSED")
sys.exit(1 if failures else 0)
