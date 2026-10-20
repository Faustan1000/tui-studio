"""Editor layout engine vs. exported Textual app: same positions and sizes?"""

import asyncio
import json
import os
import sys
import time

sys.path.insert(0, sys.argv[1])  # directory with the generated ui.py

from ui import Ui, MyApp  # noqa: E402
from ui_runtime import StudioScreen  # noqa: E402

cases = json.load(open(os.path.join(sys.argv[1], "cases.json"), encoding="utf-8"))
TOL = 1  # whole cells: the editor works with fractions, a terminal cannot


async def settle(app, pilot, ui, key):
    end = time.time() + 3
    while time.time() < end:
        if ui.current_screen == key and isinstance(app.screen, StudioScreen):
            break
        await asyncio.sleep(0.02)
    for _ in range(3):
        await pilot.pause()


async def main():
    ui = Ui()
    app = MyApp(ui=ui)
    bad = 0
    async with app.run_test(size=(80, 24)) as pilot:
        for case in cases:
            ui.show_screen(case["key"]) if ui.current_screen != case["key"] else None
            await settle(app, pilot, ui, case["key"])
            rows = []
            ok = True
            for tag, (ex, ey, ew, eh) in case["expected"].items():
                w = ui._find(tag)
                if w is None:
                    rows.append(f"    {tag}: MISSING")
                    ok = False
                    continue
                r = w.region
                got = (r.x, r.y, r.width, r.height)
                want = (ex, ey, ew, eh)
                exact = all(abs(g - w_) < 0.01 for g, w_ in zip(got, want))
                near = all(abs(g - w_) <= TOL for g, w_ in zip(got, want))
                if not near:
                    ok = False
                rows.append(f"    {tag}: editor {tuple(round(v, 1) for v in want)}  textual {got}  {'=' if exact else ('~' if near else 'DIFF')}")
            print(("PASS " if ok else "FAIL ") + case["name"])
            if not ok or "-v" in sys.argv:
                print("\n".join(rows))
            bad += 0 if ok else 1
    print()
    print(f"{len(cases) - bad}/{len(cases)} cases match the editor (tolerance {TOL} cell)")
    return bad


sys.exit(1 if asyncio.run(main()) else 0)
