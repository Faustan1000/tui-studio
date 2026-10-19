from textual.app import App, ComposeResult
from textual.widgets import Static, Button, Input

class MyApp(App):
    def compose(self) -> ComposeResult:
    yield Static("GSS camera helper")
    yield Static("Tabs")
    yield Static("Tabs")
    yield Static("a large textbox with selectable stuff inside")
    yield Static("Spacer")
    yield Static("img")
    yield Static("Standby")
    yield Static("safe")
    yield Static("setup")
    yield Static("server ok")
    yield Static("camera ok")
    yield Static("status")


    def on_button_pressed(self, event: Button.Pressed) -> None:
        pass

if __name__ == "__main__":
    app = MyApp()
    app.run()
