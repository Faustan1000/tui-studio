"""Does the generated app build and mount with real Textual (headless)?"""

import asyncio
import sys
import traceback

sys.path.insert(0, sys.argv[1])  # directory with the generated ui.py

from ui import Ui, MyApp  # noqa: E402


async def main() -> int:
    ui = Ui()
    app = MyApp(ui=ui)
    try:
        async with app.run_test(size=(120, 50)) as pilot:
            from ui_runtime import StudioScreen
            for _ in range(100):
                if isinstance(app.screen, StudioScreen):
                    break
                await asyncio.sleep(0.02)
            await pilot.pause()
            ids = sorted({w.id for w in ui._live[ui.current_screen].query("*") if w.id})
            print("mounted widgets:", len(ids))
            for tag in ["status", "name_input", "submit_btn", "agree", "opt_a", "color", "dark", "progress",
                        "busy", "results", "files", "nav_tree", "main_menu", "pages", "panel"]:
                print(("  ok  " if tag in ids else "  MISSING ") + tag)
            print("ui ready flag:", ui.ready)
            print("errors:", [e.message for e in ui.errors])
    except Exception:
        traceback.print_exc()
        return 1
    return 0


sys.exit(asyncio.run(main()))
