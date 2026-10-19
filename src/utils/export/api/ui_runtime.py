"""Runtime for user interfaces exported from TUIStudio (Textual).

This file is generated and identical for every export - do not edit it, edit your own
program instead. It lets your program drive the UI from another thread:

    from ui import Ui

    ui = Ui()
    ui.start()                         # UI runs in its own thread
    ui.submit_btn.on_click(handler)    # events
    ui.status.text = "Ready"           # values
    ui.name_input.readonly()           # states: active / mute / readonly / hide
    ui.report("Connection lost")       # errors open a dialog and go to the log
    ui.wait()                          # block until the UI is closed

Every component with a *code name* in the editor is available as an attribute of `ui`.
"""

from __future__ import annotations

import inspect
import logging
import queue
import sys
import threading
import time
import traceback
from collections import defaultdict, deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, Callable, Iterable, Optional

from rich.markup import escape as _escape
from rich.text import Text
from textual import on
from textual.app import App
from textual.containers import Vertical, VerticalScroll
from textual.screen import ModalScreen, Screen
from textual.widgets import Button, RichLog, Static

__all__ = [
    "ButtonHandle",
    "CheckHandle",
    "ContainerHandle",
    "Event",
    "Handle",
    "InputHandle",
    "ListHandle",
    "LogPanel",
    "MenuHandle",
    "ModalHandle",
    "ProgressHandle",
    "ScreenHandle",
    "SelectHandle",
    "SpinnerHandle",
    "StudioApp",
    "StudioModalScreen",
    "StudioScreen",
    "StudioUi",
    "TableHandle",
    "TabsHandle",
    "TextHandle",
    "TreeHandle",
    "UiError",
]

STATES = ("active", "muted", "readonly", "hidden")
_LEVELS = {"debug": 10, "info": 20, "warning": 30, "error": 40, "critical": 50}
_LEVEL_STYLES = {
    "debug": "dim",
    "info": "cyan",
    "warning": "yellow",
    "error": "bold red",
    "critical": "bold white on red",
}


class UiError(Exception):
    """Raised for misuse of the UI API (unknown state, UI not started, ...)."""


@dataclass(frozen=True)
class Event:
    """A user interaction: which component (`tag`), what happened (`name`), and its value."""

    tag: str
    name: str
    value: Any = None
    time: float = 0.0


@dataclass(frozen=True)
class ErrorEntry:
    time: float
    level: str
    message: str
    details: str = ""
    source: str = ""


# ── Thread bridge ─────────────────────────────────────────────────────────────


class _Bridge:
    """Runs functions on the UI thread without blocking the caller.

    Functions posted from other threads go through a queue that a pump thread feeds to
    `App.call_from_thread`. Calls made on the UI thread itself run immediately.
    """

    def __init__(self, on_error: Callable[[BaseException, str], None]) -> None:
        self._on_error = on_error
        self._queue: "queue.Queue[Optional[Callable[[], Any]]]" = queue.Queue()
        self._app: Optional[App] = None
        self._ui_thread: Optional[int] = None
        self._pump: Optional[threading.Thread] = None
        self._stopped = False

    def attach(self, app: App) -> None:
        """Called on the UI thread once the app is mounted."""
        self._app = app
        self._ui_thread = threading.get_ident()
        self._pump = threading.Thread(target=self._run_pump, name="ui-bridge", daemon=True)
        self._pump.start()

    def on_ui_thread(self) -> bool:
        return self._ui_thread == threading.get_ident()

    def post(self, fn: Callable[[], Any]) -> None:
        def safe() -> None:
            try:
                fn()
            except Exception as exc:  # noqa: BLE001 - reported, never raised into the UI loop
                self._on_error(exc, "ui")

        if self.on_ui_thread():
            safe()
        else:
            self._queue.put(safe)

    def stop(self) -> None:
        self._stopped = True
        self._queue.put(None)

    def _run_pump(self) -> None:
        while True:
            fn = self._queue.get()
            if fn is None or self._stopped:
                return
            try:
                assert self._app is not None
                self._app.call_from_thread(fn)
            except Exception as exc:  # noqa: BLE001 - app may be shutting down
                if not self._stopped:
                    self._on_error(exc, "ui-bridge")


# ── Handles ───────────────────────────────────────────────────────────────────


class Handle:
    """One component of the UI. Subclasses add values and events."""

    def __init__(
        self,
        ui: "StudioUi",
        tag: str,
        *,
        states: Iterable[str] = ("active", "hidden"),
        owner: Optional[str] = None,
    ):
        self._ui = ui
        self.tag = tag
        self._owner = owner  # key of the screen (or modal) this component lives on
        self._states = tuple(states)
        self._state = "active"
        ui._register(self)

    def __repr__(self) -> str:
        return f"<{type(self).__name__} {self.tag!r} state={self._state}>"

    # -- states --------------------------------------------------------------

    @property
    def state(self) -> str:
        """One of "active", "muted", "readonly", "hidden"."""
        return self._state

    @state.setter
    def state(self, value: str) -> None:
        self._set_state(value)

    def active(self) -> None:
        """Normal: visible and usable."""
        self._set_state("active")

    def mute(self) -> None:
        """Visible but dimmed and not usable."""
        self._set_state("muted")

    def readonly(self) -> None:
        """Shows its value normally but the user cannot change it."""
        self._set_state("readonly")

    def hide(self) -> None:
        self._set_state("hidden")

    def show(self) -> None:
        """Same as `active()`."""
        self._set_state("active")

    def _set_state(self, value: str) -> None:
        if value not in STATES:
            raise UiError(f"Unknown state {value!r}; use one of {', '.join(STATES)}")
        if value not in self._states:
            raise UiError(
                f"{self.tag!r} ({type(self).__name__}) does not support {value!r}; "
                f"supported: {', '.join(self._states)}"
            )
        self._state = value
        self._ui._bridge.post(self._apply_state)

    def _sync(self) -> None:
        """Bring a freshly mounted widget up to date with everything the program set."""
        self._push()
        if self._state != "active":
            self._apply_state()

    def _push(self) -> None:
        """Send all cached values to the widget (overridden by components with values)."""

    def _apply_state(self) -> None:
        state = self._state
        for widget in self._interactive_widgets():
            widget.disabled = state in ("muted", "readonly")
            widget.set_class(state == "muted", "-muted")
            widget.set_class(state == "readonly", "-readonly")
        for widget in self._display_widgets():
            widget.display = state != "hidden"

    # -- widget access (UI thread only) --------------------------------------

    def _widget(self, widget_id: Optional[str] = None) -> Optional[Any]:
        return self._ui._find(widget_id or self.tag)

    def _interactive_widgets(self) -> list:
        w = self._widget()
        return [w] if w is not None else []

    def _display_widgets(self) -> list:
        return self._interactive_widgets()

    def _do(self, fn: Callable[[Any], Any], widget_id: Optional[str] = None) -> None:
        """Run `fn(widget)` on the UI thread (later, without blocking)."""

        def run() -> None:
            widget = self._widget(widget_id)
            if widget is None:
                # On a screen that is not shown the value is only cached; it is applied
                # when that screen is mounted.
                if self._owner is None or self._owner in self._ui._mounted:
                    self._ui.log.warning(f"{self.tag}: widget not found, change skipped")
                return
            fn(widget)

        self._ui._bridge.post(run)

    # -- events --------------------------------------------------------------

    def _register_callback(self, name: str, fn: Optional[Callable] = None):
        """Use as `h.on_x(fn)` or as a decorator `@h.on_x`."""

        def add(callback: Callable) -> Callable:
            self._ui._add_callback(self.tag, name, callback)
            return callback

        return add if fn is None else add(fn)

    def _on_event(self, name: str, value: Any) -> bool:
        """Called on the UI thread for user interactions; False swallows the event."""
        return True


class ContainerHandle(Handle):
    """Box, Grid, Spacer, Breadcrumb ... - can be shown or hidden."""


class _ValueHandle(Handle):
    """Keeps a cached value and tells user changes apart from echoes of our own updates.

    Textual reports every change of a widget's value, including the ones we cause (initial
    values, our setters, the automatic choice after `set_options`). Those echoes can arrive
    after the cache already moved on, so each programmatic value is remembered for a short
    time and swallowed once when it comes back. A change equal to the cache is an echo too.
    """

    _ECHO_WINDOW = 2.0  # seconds an expected echo stays valid

    def __init__(self, ui: "StudioUi", tag: str, *, value: Any, **kw: Any) -> None:
        super().__init__(ui, tag, **kw)
        self._value = value
        self._expected: list[tuple[Any, float]] = []

    def _expect(self, value: Any) -> None:
        self._expected.append((value, time.monotonic()))

    def _set_value(self, value: Any) -> bool:
        """Remember `value`; returns False when nothing changed."""
        if value == self._value:
            return False
        self._value = value
        self._expect(value)
        return True

    def _on_event(self, name: str, value: Any) -> bool:
        if name != "change":
            return True
        now = time.monotonic()
        self._expected = [(v, t) for v, t in self._expected if now - t < self._ECHO_WINDOW]
        for i, (expected, _t) in enumerate(self._expected):
            if expected == value:
                del self._expected[i]
                return False
        if value == self._value:
            return False
        self._value = value
        return True


class TextHandle(Handle):
    def __init__(self, ui: "StudioUi", tag: str, *, text: str = "", **kw: Any) -> None:
        super().__init__(ui, tag, **kw)
        self._text = text

    @property
    def text(self) -> str:
        return self._text

    @text.setter
    def text(self, value: object) -> None:
        self._text = str(value)
        self._do(lambda w: w.update(self._text))

    def _push(self) -> None:
        self._do(lambda w: w.update(self._text))


class SpinnerHandle(Handle):
    def __init__(self, ui: "StudioUi", tag: str, *, label: str = "Loading...", **kw: Any) -> None:
        super().__init__(ui, tag, **kw)
        self._label = label

    @property
    def label(self) -> str:
        return self._label

    @label.setter
    def label(self, value: object) -> None:
        self._label = str(value)
        self._do(lambda w: setattr(w, "_spinner_text", self._label))

    def _push(self) -> None:
        self._do(lambda w: setattr(w, "_spinner_text", self._label))


class ButtonHandle(Handle):
    def __init__(self, ui: "StudioUi", tag: str, *, label: str = "", **kw: Any) -> None:
        super().__init__(ui, tag, **kw)
        self._label = label

    @property
    def label(self) -> str:
        return self._label

    @label.setter
    def label(self, value: object) -> None:
        self._label = str(value)
        self._do(lambda w: setattr(w, "label", _escape(self._label)))

    def _push(self) -> None:
        self._do(lambda w: setattr(w, "label", _escape(self._label)))

    def on_click(self, fn: Optional[Callable] = None):
        return self._register_callback("click", fn)


class InputHandle(_ValueHandle):
    def __init__(
        self, ui: "StudioUi", tag: str, *, value: str = "", placeholder: str = "", **kw: Any
    ) -> None:
        super().__init__(ui, tag, value=value, **kw)
        self._placeholder = placeholder

    @property
    def value(self) -> str:
        return self._value

    @value.setter
    def value(self, value: object) -> None:
        text = str(value)
        if self._set_value(text):
            self._do(lambda w: setattr(w, "value", text))

    @property
    def placeholder(self) -> str:
        return self._placeholder

    @placeholder.setter
    def placeholder(self, value: object) -> None:
        self._placeholder = str(value)
        self._do(lambda w: setattr(w, "placeholder", self._placeholder))

    def _push(self) -> None:
        def apply(w: Any) -> None:
            if w.value != self._value:
                w.value = self._value
            w.placeholder = self._placeholder

        self._do(apply)

    def on_change(self, fn: Optional[Callable] = None):
        return self._register_callback("change", fn)

    def on_submit(self, fn: Optional[Callable] = None):
        return self._register_callback("submit", fn)


class CheckHandle(_ValueHandle):
    """Checkbox, Radio and Toggle."""

    def __init__(
        self,
        ui: "StudioUi",
        tag: str,
        *,
        checked: bool = False,
        label: str = "",
        label_id: Optional[str] = None,
        **kw: Any,
    ) -> None:
        super().__init__(ui, tag, value=bool(checked), **kw)
        self._label = label
        self._label_id = label_id

    @property
    def checked(self) -> bool:
        return self._value

    @checked.setter
    def checked(self, value: object) -> None:
        flag = bool(value)
        if self._set_value(flag):
            self._do(lambda w: setattr(w, "value", flag))

    @property
    def label(self) -> str:
        return self._label

    @label.setter
    def label(self, value: object) -> None:
        self._label = str(value)
        text = _escape(self._label)
        if self._label_id:
            self._do(lambda w: w.update(text), self._label_id)
        else:
            self._do(lambda w: setattr(w, "label", text))

    def on_change(self, fn: Optional[Callable] = None):
        return self._register_callback("change", fn)

    def _push(self) -> None:
        def apply(w: Any) -> None:
            if w.value != self._value:
                w.value = self._value

        self._do(apply)
        if self._label_id:
            self._do(lambda w: w.update(_escape(self._label)), self._label_id)
        else:
            self._do(lambda w: setattr(w, "label", _escape(self._label)))

    def _display_widgets(self) -> list:
        # A toggle is a switch plus a label inside a group: hide the whole group.
        # (Radios share one RadioSet, so they must only hide themselves.)
        if self._label_id:
            group = self._widget(f"{self.tag}__group")
            if group is not None:
                return [group]
        return super()._display_widgets()

    def _interactive_widgets(self) -> list:
        widgets = super()._interactive_widgets()
        if self._label_id:
            label = self._widget(self._label_id)
            if label is not None:
                widgets.append(label)
        return widgets


class SelectHandle(_ValueHandle):
    def __init__(
        self,
        ui: "StudioUi",
        tag: str,
        *,
        value: Optional[str] = None,
        options: Iterable[str] = (),
        **kw: Any,
    ) -> None:
        super().__init__(ui, tag, value=value, **kw)
        self._options = [str(o) for o in options]

    @property
    def value(self) -> Optional[str]:
        return self._value

    @value.setter
    def value(self, value: Optional[str]) -> None:
        if value is not None and value not in self._options:
            raise UiError(f"{value!r} is not one of the options of {self.tag!r}")
        if self._set_value(value):
            self._do(lambda w: setattr(w, "value", value if value is not None else w.BLANK))

    @property
    def options(self) -> list:
        return list(self._options)

    @options.setter
    def options(self, values: Iterable[object]) -> None:
        self._options = [str(o) for o in values]
        pairs = [(_escape(o), o) for o in self._options]
        # Textual selects the first option after set_options (we never allow a blank choice
        # while options exist); keep the current value if it is still available.
        keep = self._value if self._value in self._options else None
        previous = self._value
        self._value = keep if keep is not None else (self._options[0] if self._options else None)
        if self._value != previous:
            self._expect(self._value)

        def apply(w: Any) -> None:
            w.set_options(pairs)
            if keep is not None:
                w.value = keep

        self._do(apply)

    def on_change(self, fn: Optional[Callable] = None):
        return self._register_callback("change", fn)

    def _push(self) -> None:
        pairs = [(_escape(o), o) for o in self._options]

        def apply(w: Any) -> None:
            w.set_options(pairs)
            if self._value is not None:
                w.value = self._value

        self._do(apply)


class ProgressHandle(Handle):
    def __init__(
        self, ui: "StudioUi", tag: str, *, value: float = 0, max: float = 100, **kw: Any
    ) -> None:
        super().__init__(ui, tag, **kw)
        self._progress = value
        self._max = max

    @property
    def value(self) -> float:
        return self._progress

    @value.setter
    def value(self, value: float) -> None:
        self._progress = min(max(0, value), self._max)
        self._do(lambda w: w.update(progress=self._progress))

    @property
    def max(self) -> float:
        return self._max

    @max.setter
    def max(self, value: float) -> None:
        if value <= 0:
            raise UiError("max must be greater than 0")
        self._max = value
        self._progress = min(self._progress, value)
        self._do(lambda w: w.update(total=self._max, progress=self._progress))

    def _push(self) -> None:
        self._do(lambda w: w.update(total=self._max, progress=self._progress))


class TableHandle(Handle):
    def __init__(
        self,
        ui: "StudioUi",
        tag: str,
        *,
        columns: Iterable[str] = (),
        rows: Iterable[Iterable[object]] = (),
        **kw: Any,
    ) -> None:
        super().__init__(ui, tag, **kw)
        self._columns = [str(c) for c in columns]
        self._rows = [list(r) for r in rows]

    @property
    def columns(self) -> list:
        return list(self._columns)

    @columns.setter
    def columns(self, values: Iterable[object]) -> None:
        self._columns = [str(c) for c in values]
        self._refill()

    @property
    def rows(self) -> list:
        return [list(r) for r in self._rows]

    @rows.setter
    def rows(self, values: Iterable[Iterable[object]]) -> None:
        self._rows = [list(r) for r in values]
        self._refill()

    def add_row(self, *cells: object) -> None:
        self._rows.append(list(cells))
        self._do(lambda w: w.add_row(*self._cells(cells)))

    def clear(self) -> None:
        self._rows = []
        self._do(lambda w: w.clear())

    def _cells(self, row: Iterable[object]) -> list:
        row = list(row)
        return [_escape(str(row[i])) if i < len(row) else "" for i in range(len(self._columns))]

    def _push(self) -> None:
        self._refill()

    def _refill(self) -> None:
        def fill(w: Any) -> None:
            w.clear(columns=True)
            w.add_columns(*[_escape(c) for c in self._columns])
            for row in self._rows:
                w.add_row(*self._cells(row))

        self._do(fill)


class ListHandle(Handle):
    def __init__(
        self,
        ui: "StudioUi",
        tag: str,
        *,
        items: Iterable[str] = (),
        selected: int = 0,
        **kw: Any,
    ) -> None:
        super().__init__(ui, tag, **kw)
        self._items = [str(i) for i in items]
        self._selected = selected

    @property
    def items(self) -> list:
        return list(self._items)

    @items.setter
    def items(self, values: Iterable[object]) -> None:
        from textual.widgets import Label, ListItem

        self._items = [str(v) for v in values]
        self._selected = min(self._selected, max(0, len(self._items) - 1))

        def fill(w: Any) -> None:
            w.clear()
            w.extend([ListItem(Label(_escape(i))) for i in self._items])
            if self._items:
                w.index = self._selected

        self._do(fill)

    @property
    def selected(self) -> int:
        return self._selected

    @selected.setter
    def selected(self, index: int) -> None:
        self._selected = index
        self._do(lambda w: setattr(w, "index", index))

    def _push(self) -> None:
        self.items = self._items

    def on_select(self, fn: Optional[Callable] = None):
        return self._register_callback("select", fn)

    def _on_event(self, name: str, value: Any) -> bool:
        if name == "select" and isinstance(value, int):
            self._selected = value
        return True


class MenuHandle(Handle):
    def __init__(self, ui: "StudioUi", tag: str, *, selected: int = 0, **kw: Any) -> None:
        super().__init__(ui, tag, **kw)
        self._selected = selected

    @property
    def selected(self) -> int:
        return self._selected

    @selected.setter
    def selected(self, index: int) -> None:
        self._selected = index
        self._do(lambda w: setattr(w, "highlighted", index))

    def _push(self) -> None:
        index = self._selected
        self._do(lambda w: setattr(w, "highlighted", index))

    def on_select(self, fn: Optional[Callable] = None):
        return self._register_callback("select", fn)

    def _on_event(self, name: str, value: Any) -> bool:
        if name == "select" and isinstance(value, int):
            self._selected = value
        return True


class TabsHandle(_ValueHandle):
    def __init__(self, ui: "StudioUi", tag: str, *, active: int = 0, **kw: Any) -> None:
        super().__init__(ui, tag, value=active, **kw)

    @property
    def active_tab(self) -> int:
        """Index of the active tab."""
        return self._value

    @active_tab.setter
    def active_tab(self, index: int) -> None:
        if self._set_value(index):
            self._do(lambda w: setattr(w, "active", f"{self.tag}__{index}"))

    def _push(self) -> None:
        index = self._value
        self._do(lambda w: setattr(w, "active", f"{self.tag}__{index}"))

    def on_change(self, fn: Optional[Callable] = None):
        return self._register_callback("change", fn)


class TreeHandle(Handle):
    def on_select(self, fn: Optional[Callable] = None):
        return self._register_callback("select", fn)


class ModalHandle(Handle):
    """A dialog: `open()` shows it, `close()` (or Escape) hides it."""

    def __init__(
        self, ui: "StudioUi", tag: str, *, screen: Callable[[], Any], title: str = "", **kw: Any
    ) -> None:
        super().__init__(ui, tag, **kw)
        self._screen_factory = screen
        self._title = title
        self._screen: Any = None

    @property
    def title(self) -> str:
        return self._title

    @title.setter
    def title(self, value: object) -> None:
        self._title = str(value)
        self._do(lambda w: setattr(w, "border_title", self._title))

    @property
    def is_open(self) -> bool:
        return self._screen is not None

    def open(self) -> None:
        def push() -> None:
            if self._screen is not None:
                return
            screen = self._screen_factory()
            self._screen = screen
            self._ui._app.push_screen(screen, lambda _result: setattr(self, "_screen", None))

        self._ui._bridge.post(push)

    def close(self) -> None:
        def pop() -> None:
            screen, self._screen = self._screen, None
            if screen is not None and screen in self._ui._app.screen_stack:
                screen.dismiss()

        self._ui._bridge.post(pop)

    def _apply_state(self) -> None:
        if self._state == "hidden":
            self.close()


class ScreenHandle:
    """One screen of the UI: `ui.settings.show()` switches to it."""

    def __init__(self, ui: "StudioUi", tag: str) -> None:
        self._ui = ui
        self.tag = tag
        ui._register(self)

    def __repr__(self) -> str:
        return f"<ScreenHandle {self.tag!r} active={self.is_active}>"

    @property
    def is_active(self) -> bool:
        return self._ui.current_screen == self.tag

    def show(self) -> None:
        """Switch to this screen (closes open dialogs)."""
        self._ui.show_screen(self.tag)

    def on_show(self, fn: Optional[Callable] = None):
        """Called (in a worker thread) every time this screen has been shown."""

        def add(callback: Callable) -> Callable:
            self._ui._add_callback(self.tag, "show", callback)
            return callback

        return add if fn is None else add(fn)

    def _on_event(self, name: str, value: Any) -> bool:
        return True


class StudioScreen(Screen):
    """Base class of the generated screens. Each one has a `KEY` (its code name)."""

    KEY = ""

    def __init__(self) -> None:
        super().__init__(id=self.KEY)

    def on_mount(self) -> None:
        # Runs after the generated subclass filled its tables and trees.
        self.app.ui._screen_ready(self.KEY, self, modal=False)

    def on_unmount(self) -> None:
        self.app.ui._screen_gone(self.KEY)


class StudioModalScreen(ModalScreen):
    """Base class of the generated dialogs (Modal components)."""

    KEY = ""

    def on_mount(self) -> None:
        self.app.ui._screen_ready(self.KEY, self, modal=True)

    def on_unmount(self) -> None:
        self.app.ui._screen_gone(self.KEY)


# ── Error dialog and log panel ────────────────────────────────────────────────


class LogPanel(RichLog):
    """Log shown at the bottom of the screen (toggle with Ctrl+L)."""

    DEFAULT_CSS = """
    LogPanel {
        dock: bottom;
        height: 12;
        display: none;
        border-top: solid $accent;
    }
    LogPanel.-shown {
        display: block;
    }
    """

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(wrap=True, markup=False, highlight=False, **kwargs)

    def on_mount(self) -> None:
        # Every screen has its own panel: it shows the history and keeps the shown/hidden state.
        self.set_class(self.app.ui._log_shown, "-shown")
        for entry in self.app.ui._log_history:
            self.write(_format_entry(entry))


class ErrorScreen(ModalScreen):
    """Dialog that shows the newest error; older ones are listed in the log."""

    BINDINGS = [("escape", "close", "Close"), ("enter", "close", "Close")]

    DEFAULT_CSS = """
    ErrorScreen {
        align: center middle;
        background: rgba(0, 0, 0, 0.6);
    }
    ErrorScreen > Vertical {
        width: 70%;
        max-width: 100;
        height: auto;
        max-height: 80%;
        border: heavy $error;
        background: $surface;
        padding: 1 2;
    }
    ErrorScreen #err_title {
        text-style: bold;
        color: $error;
    }
    ErrorScreen VerticalScroll {
        height: auto;
        max-height: 14;
        margin-top: 1;
    }
    ErrorScreen #err_details {
        text-style: dim;
    }
    ErrorScreen #err_more {
        margin-top: 1;
        text-style: dim;
    }
    ErrorScreen Button {
        margin-top: 1;
    }
    """

    def __init__(self, ui: "StudioUi") -> None:
        super().__init__()
        self._ui = ui

    def compose(self):
        with Vertical():
            yield Static(id="err_title", markup=False)
            yield Static(id="err_text", markup=False)
            with VerticalScroll():
                yield Static(id="err_details", markup=False)
            yield Static(id="err_more", markup=False)
            yield Button("Close", id="err_close", variant="error")

    def on_mount(self) -> None:
        self.refresh_entries()

    def refresh_entries(self) -> None:
        unseen = self._ui._unseen_errors()
        if not unseen or not self.is_attached:
            return
        try:
            self.query_one("#err_title", Static)
        except Exception:  # noqa: BLE001 - not composed yet; on_mount refreshes with all errors
            return
        latest = unseen[-1]
        self.query_one("#err_title", Static).update(
            f"{latest.level.upper()}" + (f" - {latest.source}" if latest.source else "")
        )
        self.query_one("#err_text", Static).update(latest.message)
        self.query_one("#err_details", Static).update(latest.details)
        more = len(unseen) - 1
        self.query_one("#err_more", Static).update(
            f"+{more} more - see the log (Ctrl+L)" if more > 0 else "Details are in the log (Ctrl+L)"
        )

    @on(Button.Pressed, "#err_close")
    def _close_pressed(self) -> None:
        self.action_close()

    def action_close(self) -> None:
        self._ui._mark_errors_seen()
        self.dismiss()


def _format_entry(entry: ErrorEntry) -> Text:
    stamp = time.strftime("%H:%M:%S", time.localtime(entry.time))
    text = Text()
    text.append(f"{stamp} ", style="dim")
    text.append(f"{entry.level.upper():8}", style=_LEVEL_STYLES.get(entry.level, ""))
    if entry.source:
        text.append(f"[{entry.source}] ", style="dim")
    text.append(entry.message)
    return text


# ── App base class ────────────────────────────────────────────────────────────


class StudioApp(App):
    """Base class of the generated app: log panel, error dialog and the link to `StudioUi`."""

    BINDINGS = [("ctrl+l", "toggle_log", "Log")]

    def __init__(self, ui: "StudioUi", **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.ui = ui

    def on_mount(self) -> None:
        self.ui._app_ready(self)
        # Textual keeps an empty default screen at the bottom of the stack (switching the
        # only screen would leave the stack empty), so the first screen goes on top of it.
        if self.ui._first_screen:
            self.push_screen(self.ui._create_screen(self.ui._first_screen))

    def show_bodies(self, groups: "dict[int, list[str]]", index: Optional[int]) -> None:
        """Show the widgets of the selected navigation item, hide those of the others."""
        if index is None:
            return
        for item, widget_ids in groups.items():
            for widget_id in widget_ids:
                widget = self.ui._find(widget_id)
                if widget is not None:
                    widget.display = item == index

    def _log_panel(self) -> Optional["LogPanel"]:
        """The log panel of the screen on display (each screen has its own)."""
        screen = self.ui._live.get(self.ui._current or "") or self.screen
        try:
            return screen.query_one(LogPanel)
        except Exception:  # noqa: BLE001 - no panel mounted (yet)
            return None

    def action_toggle_log(self) -> None:
        self.ui._log_shown = not self.ui._log_shown
        panel = self._log_panel()
        if panel is not None:
            panel.set_class(self.ui._log_shown, "-shown")

    def show_error(self) -> None:
        """Open the error dialog, or refresh it when it is already open."""
        screen = self.screen
        if isinstance(screen, ErrorScreen):
            screen.refresh_entries()
        else:
            self.push_screen(ErrorScreen(self.ui))

    def write_log(self, entry: ErrorEntry) -> None:
        panel = self._log_panel()
        if panel is not None:
            panel.write(_format_entry(entry))


# ── The Ui object ─────────────────────────────────────────────────────────────


class _LogApi:
    """`ui.log.info("...")` - messages go to the log panel (and `ui.errors` for errors)."""

    def __init__(self, ui: "StudioUi") -> None:
        self._ui = ui

    def debug(self, message: object) -> None:
        self._ui.report(str(message), level="debug")

    def info(self, message: object) -> None:
        self._ui.report(str(message), level="info")

    def warning(self, message: object) -> None:
        self._ui.report(str(message), level="warning")

    def error(self, message: object) -> None:
        self._ui.report(str(message), level="error")

    def exception(self, message: object = "") -> None:
        self._ui.report(sys.exc_info()[1] or str(message), level="error")


class _LoggingHandler(logging.Handler):
    def __init__(self, ui: "StudioUi") -> None:
        super().__init__()
        self._ui = ui

    def emit(self, record: logging.LogRecord) -> None:
        level = logging.getLevelName(record.levelno).lower()
        level = level if level in _LEVELS else ("error" if record.levelno >= 40 else "info")
        details = ""
        if record.exc_info:
            details = "".join(traceback.format_exception(*record.exc_info))
        self._ui._report_entry(
            ErrorEntry(record.created, level, record.getMessage(), details, record.name)
        )


class StudioUi:
    """Base class of the generated `Ui`: lifecycle, events, errors and the log."""

    def __init__(
        self,
        app_class: Callable[..., StudioApp],
        *,
        screens: Optional["dict[str, Callable[[], Screen]]"] = None,
        first: Optional[str] = None,
        dialog_levels: Iterable[str] = ("error", "critical"),
    ) -> None:
        self._app_class = app_class
        self._screens: "dict[str, Callable[[], Screen]]" = dict(screens or {})
        self._first_screen = first or next(iter(self._screens), "")
        self._current: Optional[str] = None
        self._log_shown = False
        self._mounted: set[str] = set()
        # Mounted screens and dialogs by key. A new screen is not on Textual's screen stack
        # yet while it is mounting, so components are looked up here first.
        self._live: "dict[str, Any]" = {}
        self._app: Optional[StudioApp] = None
        self._handles: dict[str, Handle] = {}
        self._callbacks: dict[tuple[str, str], list[Callable]] = defaultdict(list)
        self._dialog_levels = set(dialog_levels)
        self._bridge = _Bridge(lambda exc, source: self.report(exc, source=source))
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="ui-events")
        self._ready = threading.Event()
        self._closed = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._failure: Optional[BaseException] = None
        self._run_options: dict[str, Any] = {}
        self._seen_errors = 0
        self._error_count = 0
        self._log_history: deque[ErrorEntry] = deque(maxlen=1000)

        self.events: "queue.Queue[Event]" = queue.Queue(maxsize=1000)
        """Every user interaction, for programs that prefer polling (see `next_event`)."""
        self.errors: deque[ErrorEntry] = deque(maxlen=500)
        """Reported errors and exceptions, oldest first."""
        self.log = _LogApi(self)

    # -- lifecycle -----------------------------------------------------------

    @property
    def ready(self) -> bool:
        return self._ready.is_set()

    @property
    def running(self) -> bool:
        return self._ready.is_set() and not self._closed.is_set()

    def start(self, *, wait: bool = True, timeout: float = 10.0, **run_options: Any) -> None:
        """Run the UI in its own thread; your program keeps the main thread.

        `run_options` go to Textual's `App.run` (for example `headless=True` in tests).
        """
        if self._thread is not None or self._app is not None:
            raise UiError("The UI was already started")
        self._run_options = run_options
        self._thread = threading.Thread(target=self._run_in_thread, name="tui-ui", daemon=True)
        self._thread.start()
        if wait and not self._wait_ready(timeout):
            if self._failure is not None:
                raise UiError(
                    "The UI could not start in a background thread "
                    f"({self._failure!r}). Use `ui.run(main=your_function)` instead."
                ) from self._failure
            raise UiError(f"The UI was not ready after {timeout} seconds")

    def run(self, main: Optional[Callable[["StudioUi"], Any]] = None, **run_options: Any) -> None:
        """Run the UI on the calling (main) thread; `main(ui)` runs in a second thread.

        This is the most robust mode: terminals expect their UI on the main thread.
        Blocks until the UI is closed. `run_options` go to Textual's `App.run`.
        """
        if self._app is not None:
            raise UiError("The UI was already started")
        self._run_options = run_options
        if main is not None:

            def target() -> None:
                self._ready.wait()
                try:
                    main(self)
                except Exception as exc:  # noqa: BLE001
                    self.report(exc, source="main")

            threading.Thread(target=target, name="user-main", daemon=True).start()
        try:
            self._app = self._app_class(ui=self)
            self._app.run(**self._run_options)
        finally:
            self._finish()

    def stop(self) -> None:
        """Close the UI."""
        if self._app is not None and not self._closed.is_set():
            self._bridge.post(lambda: self._app.exit())

    def wait(self, timeout: Optional[float] = None) -> bool:
        """Block until the UI is closed (True) or `timeout` seconds passed (False)."""
        return self._closed.wait(timeout)

    close = stop

    def _run_in_thread(self) -> None:
        try:
            self._app = self._app_class(ui=self)
            self._app.run(**self._run_options)
        except BaseException as exc:  # noqa: BLE001 - surfaced through start()/report()
            self._failure = exc
            if self._ready.is_set():
                self.report(exc, source="ui-thread")
        finally:
            self._finish()

    def _finish(self) -> None:
        self._bridge.stop()
        self._executor.shutdown(wait=False)
        self._closed.set()

    def _wait_ready(self, timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self._ready.wait(0.05):
                return True
            if self._thread is not None and not self._thread.is_alive():
                return self._ready.is_set()
        return False

    # -- screens -------------------------------------------------------------

    @property
    def current_screen(self) -> Optional[str]:
        """Code name of the screen that is shown (None before the UI is up)."""
        return self._current

    def show_screen(self, name: str) -> None:
        """Switch to a screen by its code name. Open dialogs are closed."""
        if name not in self._screens:
            known = ", ".join(self._screens) or "none"
            raise UiError(f"Unknown screen {name!r}; known screens: {known}")

        def switch() -> None:
            app = self._app
            if app is None or self._current == name:
                return
            screen = self._create_screen(name)
            if not any(isinstance(s, StudioScreen) for s in app.screen_stack):
                app.push_screen(screen)  # the first screen is still being set up
                return
            while not isinstance(app.screen, StudioScreen) and len(app.screen_stack) > 1:
                app.pop_screen()
            app.switch_screen(screen)

        self._bridge.post(switch)

    def _create_screen(self, name: str) -> Screen:
        try:
            return self._screens[name]()
        except KeyError:
            raise UiError(f"Unknown screen {name!r}") from None

    def _screen_ready(self, key: str, screen: Any, *, modal: bool) -> None:
        """A screen or dialog was mounted: bring its components up to date."""
        self._mounted.add(key)
        self._live[key] = screen
        if not modal:
            self._current = key
            self._ready.set()  # ready = the first screen is on display
        for handle in list(self._handles.values()):
            if getattr(handle, "_owner", None) == key:
                handle._sync()
        if not modal:
            self._emit(key, "show")

    def _screen_gone(self, key: str) -> None:
        self._mounted.discard(key)
        self._live.pop(key, None)
        if self._current == key:
            self._current = None

    def _app_ready(self, app: StudioApp) -> None:
        self._app = app
        self._bridge.attach(app)

    # -- components ----------------------------------------------------------

    def _register(self, handle: Handle) -> None:
        if handle.tag in self._handles:
            raise UiError(f"Duplicate code name {handle.tag!r}")
        self._handles[handle.tag] = handle

    def __getitem__(self, tag: str) -> Handle:
        try:
            return self._handles[tag]
        except KeyError:
            raise KeyError(f"No component with the code name {tag!r}") from None

    def __contains__(self, tag: object) -> bool:
        return tag in self._handles

    def _find(self, widget_id: str) -> Optional[Any]:
        """Find a widget on any screen (a modal may cover the main screen)."""
        app = self._app
        if app is None:
            return None
        screens = list(reversed(list(self._live.values())))
        screens += [s for s in reversed(list(app.screen_stack)) if s not in screens]
        for screen in screens:
            try:
                return screen.query_one(f"#{widget_id}")
            except Exception:  # noqa: BLE001 - NoMatches / not mounted
                continue
        return None

    # -- events --------------------------------------------------------------

    def on(self, tag: str, name: str, fn: Optional[Callable] = None):
        """`ui.on("submit_btn", "click", fn)` - same as `ui.submit_btn.on_click(fn)`."""
        return self[tag]._register_callback(name, fn)

    def next_event(self, timeout: Optional[float] = None) -> Optional[Event]:
        """Wait for the next user interaction; None after `timeout` seconds."""
        try:
            return self.events.get(timeout=timeout)
        except queue.Empty:
            return None

    def _add_callback(self, tag: str, name: str, fn: Callable) -> None:
        self._callbacks[(tag, name)].append(fn)

    def _emit(self, tag: str, name: str, value: Any = None) -> None:
        """Called by the generated app (UI thread) when the user interacts with `tag`."""
        handle = self._handles.get(tag)
        if handle is not None and not handle._on_event(name, value):
            return
        event = Event(tag, name, value, time.time())
        try:
            self.events.put_nowait(event)
        except queue.Full:
            try:
                self.events.get_nowait()
                self.events.put_nowait(event)
            except (queue.Empty, queue.Full):
                pass
        for callback in list(self._callbacks.get((tag, name), ())):
            try:
                self._executor.submit(self._run_callback, callback, event)
            except RuntimeError:  # executor shut down while closing
                break

    def _run_callback(self, callback: Callable, event: Event) -> None:
        try:
            if _takes_argument(callback):
                callback(event)
            else:
                callback()
        except Exception as exc:  # noqa: BLE001 - a broken handler must not kill the UI
            self.report(exc, source=f"{event.tag}.on_{event.name}")

    # -- errors and log ------------------------------------------------------

    def report(
        self,
        error: "BaseException | str",
        *,
        level: str = "error",
        source: str = "",
    ) -> None:
        """Report an error: it goes to the log and, for errors, opens the error dialog."""
        level = level if level in _LEVELS else "error"
        if isinstance(error, BaseException):
            message = f"{type(error).__name__}: {error}" if str(error) else type(error).__name__
            details = "".join(traceback.format_exception(type(error), error, error.__traceback__))
        else:
            message, details = str(error), ""
        self._report_entry(ErrorEntry(time.time(), level, message, details, source))

    def _report_entry(self, entry: ErrorEntry) -> None:
        if _LEVELS[entry.level] >= _LEVELS["error"]:
            self._record(entry)
        else:
            self._log_history.append(entry)
        if self._app is None or not self._ready.is_set():
            return
        show = entry.level in self._dialog_levels

        def update() -> None:
            try:
                self._app.write_log(entry)
                if show:
                    self._app.show_error()
            except Exception as exc:  # noqa: BLE001
                # Never report a failure of the error display itself through the error
                # display: that would loop forever. Keep it in `errors` only.
                self._record(
                    ErrorEntry(time.time(), "critical", f"Error display failed: {exc!r}", source="ui")
                )

        self._bridge.post(update)

    def _record(self, entry: ErrorEntry) -> None:
        self._log_history.append(entry)
        self.errors.append(entry)
        self._error_count += 1

    def _unseen_errors(self) -> list[ErrorEntry]:
        unseen = self._error_count - self._seen_errors
        return list(self.errors)[-unseen:] if unseen > 0 else []

    def _mark_errors_seen(self) -> None:
        self._seen_errors = self._error_count

    def attach_logging(self, level: int = logging.WARNING, logger: Optional[logging.Logger] = None):
        """Send Python `logging` records of at least `level` to the log panel."""
        handler = _LoggingHandler(self)
        handler.setLevel(level)
        (logger or logging.getLogger()).addHandler(handler)
        return handler

    def install_excepthooks(self) -> None:
        """Report uncaught exceptions of any thread instead of printing over the UI."""

        def hook(args: "threading.ExceptHookArgs") -> None:
            if args.exc_value is not None:
                self.report(args.exc_value, source=args.thread.name if args.thread else "thread")

        def sys_hook(exc_type: type, exc: BaseException, tb: Any) -> None:
            self.report(exc, source="main")

        threading.excepthook = hook
        sys.excepthook = sys_hook


def _takes_argument(callback: Callable) -> bool:
    try:
        params = inspect.signature(callback).parameters.values()
    except (TypeError, ValueError):
        return True
    for p in params:
        if p.kind in (p.VAR_POSITIONAL,):
            return True
        if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD) and p.default is p.empty:
            return True
    return False
