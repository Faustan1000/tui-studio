"""Tab, menu and list item links, the back button and a modal of another screen (real Textual)."""

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


def texts(app):
    """All visible text of the screens in the stack (screen text + modal text)."""
    out = []
    for screen in app.screen_stack:
        for w in screen.query("Label, Static"):
            try:
                out.append(str(w.render()))
            except Exception:
                pass
    return "\n".join(out)


async def at(app, ui, key):
    """Wait until `key` is the current screen and is really the one on display."""
    return await until(lambda: ui.current_screen == key and app.screen.id == key)


async def click_to(pilot, app, ui, selector, key):
    """Click `selector` until `key` is on display (a click right after a switch can be lost)."""
    for _ in range(4):
        await settle(pilot)
        await pilot.click(selector)
        if await until(lambda: ui.current_screen == key and app.screen.id == key, 1.0):
            return True
    return False


async def settle(pilot):
    await pilot.pause()
    await pilot.pause()


async def main():
    ui = Ui()
    app = MyApp(ui=ui)
    changes = []

    ui.nav_tabs.on_change(lambda e: changes.append(e.value))

    async with app.run_test(size=(100, 50)) as pilot:
        for _ in range(100):
            if isinstance(app.screen, StudioScreen):
                break
            await asyncio.sleep(0.02)
        await settle(pilot)
        check("starts on home", ui.current_screen == "home", ui.current_screen)
        check("home text is shown", "Home screen" in texts(app))

        # tab with a link: selected by the user
        check("tab item opens its screen", await click_to(pilot, app, ui, "#nav_tabs__1", "settings"), ui.current_screen)
        await settle(pilot)
        check("settings text is shown", "Settings screen" in texts(app))
        check("program hears the tab change", await until(lambda: changes == [1]), changes)

        # back button
        check("back button returns", await click_to(pilot, app, ui, "#back_btn", "home"), (ui.current_screen, app.screen.id))
        await settle(pilot)
        check("home text is back", "Home screen" in texts(app))

        # selecting the tab without a link stays
        await pilot.click("#nav_tabs__0")
        await settle(pilot)
        check("tab without link stays", ui.current_screen == "home", ui.current_screen)

        # the program sets the tab: no switch
        ui.nav_tabs.active_tab = 1
        await settle(pilot)
        await asyncio.sleep(0.3)
        await settle(pilot)
        check("program-set tab does not switch", ui.current_screen == "home", ui.current_screen)
        check("tab is on the set index", ui.nav_tabs.active_tab == 1, ui.nav_tabs.active_tab)
        ui.nav_tabs.active_tab = 0
        await settle(pilot)
        await asyncio.sleep(0.3)
        check("program-set back to 0 does not switch", ui.current_screen == "home", ui.current_screen)

        # the user selects the tab again after the program moved it
        check("user tab after program change opens", await click_to(pilot, app, ui, "#nav_tabs__1", "settings"), ui.current_screen)
        await click_to(pilot, app, ui, "#back_btn", "home")
        await settle(pilot)

        # menu item
        menu = app.screen.query_one("#nav_menu")
        menu.focus()
        await settle(pilot)
        await pilot.press("enter")  # item 0 -> about
        check("menu item opens its screen", await at(app, ui, "about"), ui.current_screen)
        await settle(pilot)
        check("about text is shown", "About screen" in texts(app))
        await click_to(pilot, app, ui, "#about_back", "home")
        await settle(pilot)

        # list item
        lst = app.screen.query_one("#nav_list")
        lst.focus()
        await settle(pilot)
        await pilot.press("enter")  # item 0 -> settings
        check("list item opens its screen", await at(app, ui, "settings"), ui.current_screen)
        await settle(pilot)
        await click_to(pilot, app, ui, "#back_btn", "home")
        await settle(pilot)

        # a modal of another screen must not draw over this one
        ui.confirm.open()
        await settle(pilot)
        await asyncio.sleep(0.3)
        await settle(pilot)
        check("foreign modal is not drawn", "Modal body" not in texts(app), texts(app))
        check("still on home", ui.current_screen == "home", ui.current_screen)
        check("foreign modal is not open", not ui.confirm.is_open)
        check("no screen above home", len(app.screen_stack) == 2 and isinstance(app.screen, StudioScreen), [type(s).__name__ for s in app.screen_stack])

        # on its own screen the modal opens
        ui.show_screen("settings")
        await at(app, ui, "settings")
        await settle(pilot)
        ui.confirm.open()
        await settle(pilot)
        check("modal opens on its own screen", await until(lambda: "Modal body" in texts(app)), texts(app))

        check("no errors", not ui.errors, [e.message for e in ui.errors])


try:
    asyncio.run(main())
except Exception:
    traceback.print_exc()
    failures.append("crashed")

print()
print("FAILED: " + ", ".join(failures) if failures else "ALL PASSED")
sys.exit(1 if failures else 0)
