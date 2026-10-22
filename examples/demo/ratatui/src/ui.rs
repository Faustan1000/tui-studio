// The program API of the design (src/ui_runtime.rs does the work; this file is generated).
//
//     let ui = Ui::start()?;                  // UI runs in its own thread
//     ui.submit_btn.on_click(|e| { /* ... */ });
//     ui.status.set_text("Ready");
//     ui.wait();

#![allow(dead_code)]

use crate::ui_runtime::{ButtonHandle, CheckHandle, ContainerHandle, ErrorEntry, Event, Events, InputHandle, ListHandle, Log, ModalHandle, ProgressHandle, Runtime, Seed, SelectHandle, State, TableHandle, TabsHandle, TextHandle, UiError, Value, install_hook};
use crate::{read_event, run_loop, App};
use ratatui::crossterm::event::{DisableMouseCapture, EnableMouseCapture};
use ratatui::crossterm::execute;
use std::fmt;
use std::io;
use std::panic::{self, AssertUnwindSafe};
use std::thread;
use std::time::Duration;

/// One typed handle per component with a code name, plus the lifecycle of the UI.
#[derive(Clone)]
pub struct Ui {
    _runtime: Runtime,
    pub status: TextHandle,
    pub name_input: InputHandle,
    pub submit_btn: ButtonHandle,
    pub agree: CheckHandle,
    pub color: SelectHandle,
    pub progress: ProgressHandle,
    pub results: TableHandle,
    pub files: ListHandle,
    pub pages: TabsHandle,
    pub panel: ContainerHandle,
    pub inner: TextHandle,
    pub confirm: ModalHandle,
}

impl Ui {
    /// The state of the UI without a running UI; see `start` and `run`.
    pub fn new() -> Ui {
        let rt = Runtime::new();
        rt.seed(seeds());
        Ui {
            status: TextHandle::new(&rt, "status"),
            name_input: InputHandle::new(&rt, "name_input"),
            submit_btn: ButtonHandle::new(&rt, "submit_btn"),
            agree: CheckHandle::new(&rt, "agree"),
            color: SelectHandle::new(&rt, "color"),
            progress: ProgressHandle::new(&rt, "progress"),
            results: TableHandle::new(&rt, "results"),
            files: ListHandle::new(&rt, "files"),
            pages: TabsHandle::new(&rt, "pages"),
            panel: ContainerHandle::new(&rt, "panel"),
            inner: TextHandle::new(&rt, "inner"),
            confirm: ModalHandle::new(&rt, "confirm"),
            _runtime: rt,
        }
    }

    pub fn runtime(&self) -> &Runtime {
        &self._runtime
    }

    /// Start the UI in its own thread and return when it is ready.
    pub fn start() -> Result<Ui, UiError> {
        let ui = Ui::new();
        let worker = ui.clone();
        thread::Builder::new()
            .name("ui".to_string())
            .spawn(move || {
                let _ = worker.serve();
            })
            .map_err(|e| UiError::new(e.to_string()))?;
        ui._runtime.wait_ready(Duration::from_secs(10))?;
        Ok(ui)
    }

    /// Run the UI on the current thread and `program` in a worker thread; returns when the UI closes.
    pub fn run<F>(&self, program: F) -> Result<(), UiError>
    where
        F: FnOnce(Ui) + Send + 'static,
    {
        self._runtime.install_panic_hook();
        let ui = self.clone();
        thread::Builder::new()
            .name("program".to_string())
            .spawn(move || program(ui))
            .map_err(|e| UiError::new(e.to_string()))?;
        self.serve().map_err(|e| UiError::new(e.to_string()))
    }

    /// The UI loop on the current thread, until the UI is closed.
    pub fn serve(&self) -> io::Result<()> {
        let mut terminal = match ratatui::try_init() {
            Ok(terminal) => terminal,
            Err(e) => {
                self._runtime.mark_failed(&e.to_string());
                return Err(e);
            }
        };
        // Mouse clicks; the capture is switched off again on exit and when the program crashes.
        let _ = execute!(io::stdout(), EnableMouseCapture);
        let screen_hook = panic::take_hook();
        panic::set_hook(Box::new(move |info| {
            let _ = execute!(io::stdout(), DisableMouseCapture);
            screen_hook(info);
        }));
        install_hook();
        self._runtime.mark_ready();
        let mut app = App::new(self._runtime.clone());
        let result = panic::catch_unwind(AssertUnwindSafe(|| {
            run_loop(&mut terminal, &mut app, read_event, |_| {})
        }));
        let _ = execute!(io::stdout(), DisableMouseCapture);
        ratatui::restore();
        self._runtime.mark_closed();
        match result {
            Ok(r) => r,
            Err(_) => Err(io::Error::other("the UI loop panicked")),
        }
    }

    /// Close the UI.
    pub fn stop(&self) {
        self._runtime.stop();
    }

    /// Block until the UI is closed.
    pub fn wait(&self) {
        self._runtime.wait_closed();
    }

    pub fn ready(&self) -> bool {
        self._runtime.is_ready()
    }

    pub fn running(&self) -> bool {
        self._runtime.is_running()
    }

    /// Open the error dialog with `error`; it is added to `errors()` and the log.
    pub fn report(&self, error: impl fmt::Display) {
        self._runtime.report(&error.to_string());
    }

    pub fn errors(&self) -> Vec<ErrorEntry> {
        self._runtime.errors()
    }

    pub fn log(&self) -> Log {
        Log::new(&self._runtime)
    }

    /// The queue of all events of all components (the alternative to handlers).
    pub fn events(&self) -> Events {
        self._runtime.events()
    }

    pub fn next_event(&self, timeout: Duration) -> Option<Event> {
        self._runtime.events().next(timeout)
    }

    /// Report panics of your own threads in the error dialog instead of printing them.
    pub fn install_panic_hook(&self) {
        self._runtime.install_panic_hook();
    }
}

impl Default for Ui {
    fn default() -> Self {
        Ui::new()
    }
}

/// What the design contains when the UI opens.
fn seeds() -> Vec<Seed> {
    vec![
        Seed::new("status", State::Active)
            .prop("text", Value::text("Ready")),
        Seed::new("name_input", State::Active)
            .prop("value", Value::text(""))
            .prop("placeholder", Value::text("your name")),
        Seed::new("submit_btn", State::Active)
            .prop("label", Value::text("Send")),
        Seed::new("agree", State::Active)
            .prop("checked", Value::Bool(false))
            .prop("label", Value::text("I agree")),
        Seed::new("color", State::Active)
            .prop("value", Value::text("Red"))
            .prop("options", Value::list(&["Red", "Green", "Blue"])),
        Seed::new("progress", State::Active)
            .prop("value", Value::Float(0.0))
            .prop("max", Value::Float(100.0)),
        Seed::new("results", State::Active)
            .prop("columns", Value::list(&["Column 1", "Column 2"]))
            .prop("rows", Value::rows(&[&["Cell 1", "Cell 2"], &["Cell 3", "Cell 4"]])),
        Seed::new("files", State::Active)
            .prop("items", Value::list(&["Item 1", "Item 2", "Item 3"]))
            .prop("selected", Value::Int(0)),
        Seed::new("pages", State::Active)
            .prop("active_tab", Value::Int(0)),
        Seed::new("panel", State::Active),
        Seed::new("inner", State::Active)
            .prop("text", Value::text("Inside the panel")),
        Seed::new("confirm", State::Active)
            .prop("title", Value::text("Sure?"))
            .prop("open", Value::Bool(false)),
        Seed::new("_text", State::Active)
            .prop("text", Value::text("Really?")),
    ]
}
