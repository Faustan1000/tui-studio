"""The thread question: does `ui.start()` work from a background thread with real Textual?

Runs headless by default (pure threading semantics). With --real it uses the real terminal
driver instead (needs an actual console).
"""

import sys
import threading
import time

sys.path.insert(0, sys.argv[1])  # directory with the generated ui.py

from ui import Ui  # noqa: E402

real = "--real" in sys.argv
options = {} if real else {"headless": True}

failures = []


def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name + (f"   <- {extra}" if extra and not cond else ""))
    if not cond:
        failures.append(name)


def eventually(fn, timeout=3.0):
    end = time.time() + timeout
    while time.time() < end:
        try:
            if fn():
                return True
        except Exception:
            pass
        time.sleep(0.02)
    return False


main_thread = threading.get_ident()
ui = Ui()
try:
    ui.start(timeout=15, **options)
except Exception as exc:  # noqa: BLE001
    print("START FAILED:", repr(exc))
    sys.exit(2)

from ui_runtime import StudioScreen  # noqa: E402
eventually(lambda: isinstance(ui._app.screen, StudioScreen))
check("start() from main thread, UI is ready", ui.ready and ui.running)
check("UI runs on another thread", ui._bridge._ui_thread != main_thread)

# writes from the main thread, reads from the UI thread's widgets
ui.status.text = "from main thread"
ui.progress.value = 33
ui.name_input.value = "typed by program"
ui.panel.hide()
time.sleep(0.5)


def widget_value(wid, attr):
    box = {}

    def read():
        box["v"] = getattr(ui._find(wid), attr)

    ui._app.call_from_thread(read)
    return box["v"]


check("progress updated across threads", widget_value("progress", "progress") == 33)
check("input updated across threads", widget_value("name_input", "value") == "typed by program")
check("container hidden across threads", widget_value("panel", "display") is False)

got = []
ui.submit_btn.on_click(lambda e: got.append(threading.current_thread().name))
ui._app.call_from_thread(lambda: ui._find("submit_btn").press())
check("click event reaches callback in worker thread", eventually(lambda: got and got[0].startswith("ui-events")), got)

ui.report("boom from main thread")
check("report from main thread is stored", eventually(lambda: any(e.message == "boom from main thread" for e in ui.errors)))
time.sleep(0.4)
check("error dialog shown (on UI thread)", type(ui._app.screen).__name__ == "ErrorScreen", type(ui._app.screen).__name__)

for i in range(200):
    ui.progress.value = i % 100
time.sleep(0.5)
check("200 rapid updates did not hang or error", ui.running and len([e for e in ui.errors if e.level == "critical"]) == 0)

ui.stop()
check("stop() ends the UI thread", ui.wait(5) and eventually(lambda: not ui._thread.is_alive()))

print()
print("FAILED: " + ", ".join(failures) if failures else "ALL PASSED")
sys.exit(1 if failures else 0)
