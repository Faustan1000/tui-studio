"""Runs a program in a pseudo-terminal and reads its screen through a terminal emulator.

The headless tests of this repository drive each framework through its own test hooks. This
driver does what a person does: it starts the real program on a real tty (POSIX `pty`; on Windows
`pywinpty`/ConPTY, for trying it out locally), sends keys and SGR mouse reports as bytes, and
reads what a terminal would show (`pyte`). It also answers the queries some libraries send at
startup (cursor position, device attributes, colours), because they wait for a reply.

    term = Term(["node", "index.js"], cwd="project", cols=100, rows=30)
    term.wait_for("Home screen")
    term.click_on("Open about")
    term.resize(60, 16)
    code = term.quit()
"""

from __future__ import annotations

import os
import re
import sys
import threading
import time
from typing import Optional

import pyte

WINDOWS = sys.platform == "win32"

# Variables of the machine that runs the tests, not of a terminal.
HOST_ONLY_VARS = {
    "CI",
    "CONTINUOUS_INTEGRATION",
    "GITHUB_ACTIONS",
    "GITHUB_ACTION",
    "BUILD_NUMBER",
    "RUN_ID",
    "COLUMNS",
    "LINES",
    "NO_COLOR",
}

if not WINDOWS:
    import fcntl
    import pty
    import signal
    import struct
    import subprocess
    import termios
else:  # pragma: no cover - only for trying the driver out on Windows
    import winpty  # type: ignore  # pywinpty

KEYS = {
    "enter": "\r",
    "tab": "\t",
    "shift+tab": "\x1b[Z",
    "esc": "\x1b",
    "backspace": "\x7f",
    "up": "\x1b[A",
    "down": "\x1b[B",
    "right": "\x1b[C",
    "left": "\x1b[D",
    "home": "\x1b[H",
    "end": "\x1b[F",
    "pageup": "\x1b[5~",
    "pagedown": "\x1b[6~",
    "space": " ",
    "ctrl+c": "\x03",
    "ctrl+q": "\x11",
    "ctrl+l": "\x0c",
}


class Term:
    def __init__(
        self,
        argv: list[str],
        cwd: str,
        cols: int = 100,
        rows: int = 30,
        env: Optional[dict[str, str]] = None,
    ) -> None:
        self.cols, self.rows = cols, rows
        self.argv = argv
        self.screen = pyte.Screen(cols, rows)
        self.stream = pyte.Stream(self.screen) if WINDOWS else pyte.ByteStream(self.screen)
        self.raw = bytearray()
        self.exit_code: Optional[int] = None
        self._lock = threading.Lock()
        self._closed = False
        # The program sees what it would see in a person's terminal: no CI variables (Ink then
        # only prints the last frame) and no COLUMNS/LINES (Rich, and so Textual, read them before
        # the real size and would not notice a resize). The size comes from the tty.
        full_env = {k: v for k, v in os.environ.items() if k not in HOST_ONLY_VARS}
        full_env.update({"TERM": "xterm-256color", "COLORTERM": "truecolor", **(env or {})})
        if WINDOWS:  # pragma: no cover
            self._proc = winpty.PtyProcess.spawn(argv, cwd=cwd, env=full_env, dimensions=(rows, cols))
        else:
            self._master, slave = pty.openpty()
            self._set_size(self._master)

            def make_controlling() -> None:
                fcntl.ioctl(0, termios.TIOCSCTTY, 0)

            self._proc = subprocess.Popen(
                argv,
                stdin=slave,
                stdout=slave,
                stderr=slave,
                cwd=cwd,
                env=full_env,
                start_new_session=True,
                preexec_fn=make_controlling,
            )
            os.close(slave)
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

    # ── Output ──────────────────────────────────────────────────────────────

    def _set_size(self, fd: int) -> None:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", self.rows, self.cols, 0, 0))

    def _read_loop(self) -> None:
        while True:
            try:
                if WINDOWS:  # pragma: no cover
                    data = self._proc.read(65536)
                    chunk = data.encode("utf-8", "replace") if isinstance(data, str) else data
                else:
                    chunk = os.read(self._master, 65536)
            except (OSError, EOFError):
                break
            if not chunk:
                break
            with self._lock:
                self.raw += chunk
                self._answer_queries(chunk)
                try:
                    self.stream.feed(chunk.decode("utf-8", "replace") if WINDOWS else chunk)
                except Exception:  # a malformed sequence must not stop the reader
                    pass
        self._closed = True

    _QUERIES = [
        (re.compile(rb"\x1b\[6n"), lambda t: f"\x1b[{t.screen.cursor.y + 1};{t.screen.cursor.x + 1}R"),
        (re.compile(rb"\x1b\[(?:0)?c"), lambda t: "\x1b[?62;c"),
        (re.compile(rb"\x1b\]11;\?(?:\x07|\x1b\\)"), lambda t: "\x1b]11;rgb:0000/0000/0000\x1b\\"),
        (re.compile(rb"\x1b\]10;\?(?:\x07|\x1b\\)"), lambda t: "\x1b]10;rgb:ffff/ffff/ffff\x1b\\"),
        (re.compile(rb"\x1b\[\?996n"), lambda t: "\x1b[?997;1n"),
    ]

    def _answer_queries(self, chunk: bytes) -> None:
        for pattern, reply in self._QUERIES:
            for _ in pattern.finditer(chunk):
                self.send(reply(self))

    def text(self) -> str:
        with self._lock:
            return "\n".join(line.rstrip() for line in self.screen.display)

    def lines(self) -> list[str]:
        return self.text().split("\n")

    def raw_text(self) -> str:
        with self._lock:
            return bytes(self.raw).decode("utf-8", "replace")

    def find(self, needle: str) -> Optional[tuple[int, int]]:
        """Column and row of the first occurrence of `needle` on the screen."""
        for y, line in enumerate(self.lines()):
            x = line.find(needle)
            if x >= 0:
                return x, y
        return None

    def wait_for(self, needle: str, timeout: float = 10.0, settle: float = 0.0) -> bool:
        """Wait until `needle` is on the screen; `settle` waits a little longer once it is, so
        that a click does not arrive before the program has laid the new screen out."""
        end = time.time() + timeout
        while time.time() < end:
            if needle in self.text():
                time.sleep(settle)
                return True
            time.sleep(0.05)
        return needle in self.text()

    def wait_gone(self, needle: str, timeout: float = 10.0) -> bool:
        end = time.time() + timeout
        while time.time() < end:
            if needle not in self.text():
                return True
            time.sleep(0.05)
        return needle not in self.text()

    # ── Input ───────────────────────────────────────────────────────────────

    def send(self, data: str) -> None:
        if self._closed:
            return
        try:
            if WINDOWS:  # pragma: no cover
                self._proc.write(data)
            else:
                os.write(self._master, data.encode("utf-8"))
        except OSError:
            pass

    def type(self, text: str) -> None:
        for ch in text:
            self.send(ch)
            time.sleep(0.02)

    def key(self, name: str) -> None:
        self.send(KEYS[name])
        time.sleep(0.08)

    def mouse(self, x: int, y: int, button: int = 0, release: bool = True) -> None:
        """An SGR mouse report (1006): press, then release. `x`, `y` are 0-based cells."""
        self.send(f"\x1b[<{button};{x + 1};{y + 1}M")
        if release and button < 64:
            time.sleep(0.04)
            self.send(f"\x1b[<{button};{x + 1};{y + 1}m")
        time.sleep(0.15)

    def click(self, x: int, y: int) -> None:
        self.mouse(x, y, 0)

    def click_on(self, needle: str) -> None:
        pos = self.find(needle)
        if pos is None:
            raise AssertionError(f"{needle!r} is not on the screen:\n{self.text()}")
        self.click(pos[0] + min(1, max(0, len(needle) - 1)), pos[1])

    def wheel(self, x: int, y: int, down: bool = True) -> None:
        self.mouse(x, y, 65 if down else 64)

    def resize(self, cols: int, rows: int) -> None:
        self.cols, self.rows = cols, rows
        with self._lock:
            self.screen.resize(rows, cols)
        if WINDOWS:  # pragma: no cover
            self._proc.setwinsize(rows, cols)
        else:
            self._set_size(self._master)  # the kernel sends SIGWINCH to the foreground group

    # ── Lifecycle ───────────────────────────────────────────────────────────

    def alive(self) -> bool:
        if WINDOWS:  # pragma: no cover
            return bool(self._proc.isalive())
        return self._proc.poll() is None

    def wait_exit(self, timeout: float = 5.0) -> bool:
        end = time.time() + timeout
        while time.time() < end:
            if not self.alive():
                self._collect()
                return True
            time.sleep(0.05)
        return not self.alive()

    def _collect(self) -> None:
        if WINDOWS:  # pragma: no cover
            self.exit_code = self._proc.exitstatus
        else:
            self.exit_code = self._proc.returncode
        self._reader.join(timeout=1.0)

    def quit(self, sequences: tuple[str, ...] = ("ctrl+c", "q"), timeout: float = 4.0) -> bool:
        """Ask the program to quit the way a user does; True if it exited."""
        for name in sequences:
            if name == "q":
                self.send("q")
            else:
                self.key(name)
            if self.wait_exit(timeout):
                return True
        return False

    def kill(self) -> None:
        if not self.alive():
            return
        try:
            if WINDOWS:  # pragma: no cover
                self._proc.terminate(force=True)
            else:
                os.killpg(self._proc.pid, signal.SIGKILL)
        except (OSError, ProcessLookupError):
            pass

    def restored(self) -> list[str]:
        """Terminal modes the program switched on and did not switch off again."""
        raw = self.raw_text()
        left_on = []
        for mode in ("1000", "1002", "1003", "1006", "1049", "25"):
            on, off = f"\x1b[?{mode}h", f"\x1b[?{mode}l"
            last_on, last_off = raw.rfind(on), raw.rfind(off)
            if mode == "25":  # the cursor must be visible again
                if last_off > last_on:
                    left_on.append("cursor hidden")
                continue
            if last_on > last_off:
                left_on.append(mode)
        return left_on
