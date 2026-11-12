"""The terminal scenario: one real program on a real tty, driven like a user.

The same design (`screenLinks()` in tests/fixtures/designs.ts: three screens that link to each
other through tab, menu, list and button) is exported for every framework and run through these
steps. They cover what the headless tests cannot: the program starts on a tty, mouse reports
arrive as bytes, a resize reaches the program, and quitting leaves the terminal as it was.

    python scenario.py --name ink --cwd DIR --cmd node --cmd tsx.mjs --cmd src/app.tsx

Prints one JSON line per step ({"step", "ok", "info"}) and exits 0 when every step passed.
"""

from __future__ import annotations

import argparse
import json
import sys
import time

from ptydriver import Term

STARTUP = 60.0  # the first start can compile or load a lot
SETTLE = 0.5  # after a screen has appeared, before the next click


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    ap.add_argument("--cwd", required=True)
    ap.add_argument("--cmd", action="append", required=True, help="one argv element per use")
    ap.add_argument("--quit", default="ctrl+c,q", help="keys that quit, tried in order")
    ap.add_argument("--cols", type=int, default=100)
    ap.add_argument("--rows", type=int, default=30)
    args = ap.parse_args()

    results: list[dict] = []
    term: Term | None = None

    def step(name: str, ok: bool, info: str = "") -> bool:
        results.append({"step": name, "ok": bool(ok), "info": "" if ok else info})
        print(json.dumps(results[-1]), flush=True)
        return bool(ok)

    def screen_info() -> str:
        return "\n" + term.text() if term else ""

    try:
        term = Term(args.cmd, args.cwd, args.cols, args.rows)
        if not step("start", term.wait_for("Home screen", STARTUP, settle=SETTLE), "no first frame" + screen_info()):
            raise SystemExit(finish(term, results, args))

        # Mouse: a click on the menu item that links to the About screen, and on the way back.
        term.click_on("Open about")
        step("mouse: menu item opens a screen", term.wait_for("About screen", 8, settle=SETTLE), screen_info())
        if "About screen" in term.text():
            term.click_on("Home")
            step("mouse: button returns", term.wait_for("Home screen", 8, settle=SETTLE), screen_info())

        # Mouse on the tab bar.
        if "Home screen" in term.text():
            term.click_on("Prefs")
            step("mouse: tab opens a screen", term.wait_for("Settings screen", 8, settle=SETTLE), screen_info())
            if "Settings screen" in term.text():
                term.click_on("Back")
                step("mouse: back from settings", term.wait_for("Home screen", 8, settle=SETTLE), screen_info())

        # A resize reaches the program, which redraws inside the new size.
        term.resize(60, 16)
        redrawn = term.wait_for("Home screen", 8, settle=SETTLE)
        wide = [line for line in term.lines() if len(line) > 60]
        step("resize: redraws inside the new size", redrawn and not wide, screen_info())
        term.resize(args.cols, args.rows)
        term.wait_for("Home screen", 5)
    except SystemExit:
        pass
    except Exception as exc:  # noqa: BLE001 - report, never hang the CI job
        step("scenario", False, f"{type(exc).__name__}: {exc}{screen_info()}")
    return finish(term, results, args)


def finish(term: Term | None, results: list[dict], args: argparse.Namespace) -> int:
    if term is not None:
        keys = tuple(k for k in args.quit.split(",") if k)
        try:
            exited = term.quit(keys)
        except Exception as exc:  # noqa: BLE001 - a bad key name must not hide the other results
            results.append({"step": "quit", "ok": False, "info": f"{type(exc).__name__}: {exc}"})
            print(json.dumps(results[-1]), flush=True)
            term.kill()
            return 1
        results.append({"step": "quit", "ok": exited, "info": "" if exited else "still running after " + args.quit})
        print(json.dumps(results[-1]), flush=True)
        if exited:
            left = term.restored()
            results.append(
                {"step": "terminal restored", "ok": not left, "info": "" if not left else "left on: " + ", ".join(left)}
            )
            print(json.dumps(results[-1]), flush=True)
        else:
            term.kill()
        time.sleep(0.1)
    return 0 if results and all(r["ok"] for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
