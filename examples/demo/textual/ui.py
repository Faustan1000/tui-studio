from rich.text import Text as RichText
from textual import on
from textual.app import ComposeResult
from textual.containers import Vertical
from textual.renderables.bar import Bar as BarRenderable
from textual.widgets import Button, Checkbox, DataTable, Input, Label, ListItem, ListView, ProgressBar, Select, Static, Tab, Tabs
from ui_runtime import ButtonHandle, CheckHandle, ContainerHandle, InputHandle, ListHandle, LogPanel, ModalHandle, ProgressHandle, ScreenHandle, SelectHandle, StudioApp, StudioModalScreen, StudioScreen, StudioUi, TableHandle, TabsHandle, TextHandle


class StudioCheckbox(Checkbox):
    BUTTON_LEFT = "["
    BUTTON_INNER = "✓"
    BUTTON_RIGHT = "]"


class StudioBarRenderable(BarRenderable):
    def __rich_console__(self, console, options):
        width = int(self.width or options.max_width)
        filled = max(0, min(width, round(self.highlight_range[1])))
        bar = RichText(end="")
        bar.append("█" * filled, style=console.get_style(self.highlight_style))
        bar.append("░" * (width - filled), style=console.get_style(self.background_style))
        yield bar


class StudioProgressBar(ProgressBar):
    # BAR_RENDERABLE needs Textual 6.0 or newer (older versions draw their own thin bar).
    BAR_RENDERABLE = StudioBarRenderable


class StudioModal1(StudioModalScreen):
    KEY = "confirm"
    BINDINGS = [("escape", "dismiss", "Close")]

    def compose(self) -> ComposeResult:
        with Vertical(id="confirm") as dialog:
            dialog.border_title = self.app.ui["confirm"].title
            yield Static("Really?", markup=False, id="_n_id_12")


class DemoScreen(StudioScreen):
    KEY = "demo"

    def compose(self) -> ComposeResult:
        yield LogPanel(id="_ui_log")
        yield Static("Ready", markup=False, id="status")
        yield Input(placeholder="your name", id="name_input")
        yield Button("Send", id="submit_btn")
        yield StudioCheckbox("I agree", id="agree")
        yield Select([("Red", "Red"), ("Green", "Green"), ("Blue", "Blue")], allow_blank=False, value="Red", id="color")
        yield StudioProgressBar(total=100, show_eta=False, id="progress")
        yield DataTable(id="results")
        yield ListView(
            ListItem(Label("• Item 1  [dim]1[/dim]")),
            ListItem(Label("• Item 2  [dim]2[/dim]")),
            ListItem(Label("• Item 3  [dim]3[/dim]")),
            initial_index=0, id="files",
        )
        yield Tabs(
            Tab("⌂ Dashboard", id="pages__0"),
            Tab("Agent ● ^1", id="pages__1"),
            Tab("QA Team ^2", id="pages__2"),
            active="pages__0", id="pages",
        )
        with Vertical(id="panel"):
            yield Static("Inside the panel", markup=False, id="inner")

    def on_mount(self) -> None:
        self.query_one("#progress", StudioProgressBar).update(progress=0)
        results = self.query_one("#results", DataTable)
        results.add_columns("Column 1", "Column 2")
        results.add_rows([("Cell 1", "Cell 2",), ("Cell 3", "Cell 4",)])


class MyApp(StudioApp):
    CSS = """
    #demo {
        color: #f8f8f2;
        border: solid #f8f8f2;
        padding: 1;
    }

    #status {
        width: auto;
        color: #f8f8f2;
    }

    #name_input {
        width: 20;
        color: #f8f8f2;
        border: solid #f8f8f2;
    }

    #submit_btn {
        width: auto;
        color: #f8f8f2;
        text-style: bold;
        border: round #f8f8f2;
        padding: 0 1;
    }

    #agree {
        border: none;
        height: auto;
        padding: 0;
        color: #f8f8f2;
    }

    #agree > .toggle--button {
        color: #f8f8f2;
    }

    #agree.-on > .toggle--button {
        color: #50fa7b;
    }

    #color {
        width: auto;
    }

    #color > SelectCurrent {
        color: #f8f8f2;
        border: solid #f8f8f2;
    }

    #progress {
        width: 20;
        color: #f8f8f2;
        border: solid #f8f8f2;
        height: auto;
    }

    #progress Bar {
        width: 1fr;
    }

    #progress Bar > .bar--bar,
    #progress Bar > .bar--complete {
        color: #f8f8f2;
    }

    #results {
        width: auto;
        color: #f8f8f2;
        border: solid #f8f8f2;
    }

    #files {
        width: auto;
        height: auto;
        color: #f8f8f2;
        border: solid #f8f8f2;
    }

    #files > ListItem {
        color: #f8f8f2;
    }

    #pages {
        color: #f8f8f2;
    }

    #pages Tab {
        color: #f8f8f2;
    }

    #panel > * {
        margin-bottom: 1;
    }

    #panel > *:last-child {
        margin-bottom: 0;
    }

    #panel > LogPanel {
        margin: 0;
    }

    #panel {
        width: auto;
        height: auto;
        color: #f8f8f2;
        border: solid #f8f8f2;
        padding: 1;
    }

    #inner {
        width: auto;
        color: #f8f8f2;
    }

    ModalScreen {
        align: center middle;
        background: rgba(0, 0, 0, 0.6);
    }

    #confirm {
        width: 40;
        height: 12;
        color: #f8f8f2;
        background: #21222c;
        border: double #f8f8f2;
        padding: 2;
    }

    #_n_id_12 {
        width: auto;
        color: #f8f8f2;
    }
    """

    BINDINGS = [
        ("f1", "show_modal_1", "Sure?"),
    ]

    @on(Input.Changed, "#name_input")
    def handle_change(self, event: Input.Changed) -> None:
        self.ui._emit("name_input", "change", event.value)

    @on(Input.Submitted, "#name_input")
    def on_input_submitted(self, event: Input.Submitted) -> None:
        self.ui._emit("name_input", "submit", event.value)

    @on(Button.Pressed, "#submit_btn")
    def handle_click(self, event: Button.Pressed) -> None:
        self.ui._emit("submit_btn", "click")

    @on(Checkbox.Changed, "#agree")
    def handle_change_2(self, event: Checkbox.Changed) -> None:
        self.ui._emit("agree", "change", event.value)

    @on(Select.Changed, "#color")
    def handle_change_3(self, event: Select.Changed) -> None:
        self.ui._emit("color", "change", None if event.value == Select.BLANK else event.value)

    @on(ListView.Selected, "#files")
    def handle_select(self, event: ListView.Selected) -> None:
        self.ui._emit("files", "select", event.list_view.index)

    @on(Tabs.TabActivated, "#pages")
    def on_tab_activated(self, event: Tabs.TabActivated) -> None:
        self.ui._emit("pages", "change", int(event.tab.id.rsplit("__", 1)[-1]))

    def action_show_modal_1(self) -> None:
        self.push_screen(StudioModal1())


class Ui(StudioUi):
    """Your program's access to the screens and components that have a code name."""

    demo: ScreenHandle
    status: TextHandle
    name_input: InputHandle
    submit_btn: ButtonHandle
    agree: CheckHandle
    color: SelectHandle
    progress: ProgressHandle
    results: TableHandle
    files: ListHandle
    pages: TabsHandle
    panel: ContainerHandle
    inner: TextHandle
    confirm: ModalHandle

    def __init__(self) -> None:
        super().__init__(MyApp, screens={"demo": DemoScreen}, first="demo")
        self.demo = ScreenHandle(self, "demo")
        self.status = TextHandle(self, "status", states=("active", "hidden",), owner="demo", text="Ready")
        self.name_input = InputHandle(self, "name_input", states=("active", "muted", "readonly", "hidden",), owner="demo", value="", placeholder="your name")
        self.submit_btn = ButtonHandle(self, "submit_btn", states=("active", "muted", "hidden",), owner="demo", label="Send")
        self.agree = CheckHandle(self, "agree", states=("active", "muted", "readonly", "hidden",), owner="demo", checked=False, label="I agree")
        self.color = SelectHandle(self, "color", states=("active", "muted", "readonly", "hidden",), owner="demo", value="Red", options=["Red","Green","Blue"])
        self.progress = ProgressHandle(self, "progress", states=("active", "muted", "hidden",), owner="demo", value=0, max=100)
        self.results = TableHandle(self, "results", states=("active", "muted", "readonly", "hidden",), owner="demo", columns=["Column 1","Column 2"], rows=[["Cell 1","Cell 2"],["Cell 3","Cell 4"]])
        self.files = ListHandle(self, "files", states=("active", "muted", "readonly", "hidden",), owner="demo", items=["Item 1","Item 2","Item 3"], selected=0)
        self.pages = TabsHandle(self, "pages", states=("active", "muted", "readonly", "hidden",), owner="demo", active=0)
        self.panel = ContainerHandle(self, "panel", states=("active", "hidden",), owner="demo")
        self.inner = TextHandle(self, "inner", states=("active", "hidden",), owner="demo", text="Inside the panel")
        self.confirm = ModalHandle(self, "confirm", states=("active", "hidden",), owner="demo", screen=StudioModal1, title="Sure?")


if __name__ == "__main__":
    Ui().run()
