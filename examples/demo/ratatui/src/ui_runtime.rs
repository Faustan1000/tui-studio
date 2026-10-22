//! Runtime for user interfaces exported from TUIStudio (Rust).
//!
//! This file is generated and identical for every export - do not edit it, edit your own
//! program instead. It keeps the state of every component in one shared store, dispatches
//! events to handlers on their own thread and records errors and log messages. It knows nothing
//! about the terminal framework except a "something changed, redraw" flag (`take_dirty`).
//!
//! ```ignore
//! let ui = Ui::start()?;                       // UI runs in its own thread
//! ui.submit_btn.on_click(|e| println!("{:?}", e.value));
//! ui.status.set_text("Ready");
//! ui.name_input.readonly()?;
//! ui.report("Connection lost");                // opens an error dialog, goes to the log
//! ui.wait();
//! ```
#![allow(dead_code, unused_imports)]

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::error::Error;
use std::fmt;
use std::ops::Deref;
use std::panic::{self, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

// ── Values, states, events ────────────────────────────────────────────────────

/// Normal, dimmed and not interactive, shown but not editable, or not shown at all.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Active,
    Muted,
    Readonly,
    Hidden,
}

impl State {
    pub fn name(self) -> &'static str {
        match self {
            State::Active => "active",
            State::Muted => "muted",
            State::Readonly => "readonly",
            State::Hidden => "hidden",
        }
    }
}

/// A property value: text, whole number, number, true/false, list of texts, rows.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    None,
    Str(String),
    Int(i64),
    Float(f64),
    Bool(bool),
    List(Vec<String>),
    Rows(Vec<Vec<String>>),
}

impl Value {
    pub fn text(s: &str) -> Value {
        Value::Str(s.to_string())
    }

    pub fn list(items: &[&str]) -> Value {
        Value::List(items.iter().map(|s| s.to_string()).collect())
    }

    pub fn rows(rows: &[&[&str]]) -> Value {
        Value::Rows(
            rows.iter()
                .map(|r| r.iter().map(|s| s.to_string()).collect())
                .collect(),
        )
    }
}

impl fmt::Display for Value {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Value::None => write!(f, ""),
            Value::Str(s) => write!(f, "{s}"),
            Value::Int(n) => write!(f, "{n}"),
            Value::Float(n) => write!(f, "{n}"),
            Value::Bool(b) => write!(f, "{b}"),
            Value::List(l) => write!(f, "{l:?}"),
            Value::Rows(r) => write!(f, "{r:?}"),
        }
    }
}

/// A user interaction: which component (`tag`), what happened (`name`) and its value.
#[derive(Clone, Debug)]
pub struct Event {
    pub tag: String,
    pub name: String,
    pub value: Value,
    pub time: f64,
}

/// Misuse of the API (unsupported state, UI not started, ...).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UiError {
    pub message: String,
}

impl UiError {
    pub fn new(message: impl Into<String>) -> UiError {
        UiError {
            message: message.into(),
        }
    }
}

impl fmt::Display for UiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl Error for UiError {}

#[derive(Clone, Debug)]
pub struct ErrorEntry {
    pub time: f64,
    pub message: String,
    pub details: String,
    pub source: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Debug,
    Info,
    Warning,
    Error,
}

impl Level {
    pub fn name(self) -> &'static str {
        match self {
            Level::Debug => "debug",
            Level::Info => "info",
            Level::Warning => "warning",
            Level::Error => "error",
        }
    }
}

#[derive(Clone, Debug)]
pub struct LogEntry {
    pub time: f64,
    pub level: Level,
    pub message: String,
}

fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

// ── Store ─────────────────────────────────────────────────────────────────────

/// What the design contains for one component when the UI starts.
pub struct Seed {
    key: String,
    state: State,
    props: Vec<(String, Value)>,
}

impl Seed {
    pub fn new(key: &str, state: State) -> Seed {
        Seed {
            key: key.to_string(),
            state,
            props: Vec::new(),
        }
    }

    pub fn prop(mut self, name: &str, value: Value) -> Seed {
        self.props.push((name.to_string(), value));
        self
    }
}

#[derive(Clone, Debug)]
struct Entry {
    state: State,
    props: HashMap<String, Value>,
}

static NO_VALUE: Value = Value::None;
const MAX_LOG: usize = 500;

/// All component state, keyed by code name (components without one use an internal key).
#[derive(Default)]
pub struct Store {
    entries: HashMap<String, Entry>,
    pending: Vec<ErrorEntry>,
    errors: Vec<ErrorEntry>,
    log: Vec<LogEntry>,
    log_visible: bool,
}

impl Store {
    pub fn value(&self, key: &str, prop: &str) -> &Value {
        self.entries
            .get(key)
            .and_then(|e| e.props.get(prop))
            .unwrap_or(&NO_VALUE)
    }

    pub fn text(&self, key: &str, prop: &str) -> &str {
        match self.value(key, prop) {
            Value::Str(s) => s.as_str(),
            _ => "",
        }
    }

    pub fn boolean(&self, key: &str, prop: &str) -> bool {
        matches!(self.value(key, prop), Value::Bool(true))
    }

    pub fn int(&self, key: &str, prop: &str) -> i64 {
        match self.value(key, prop) {
            Value::Int(n) => *n,
            Value::Float(n) => *n as i64,
            _ => 0,
        }
    }

    pub fn float(&self, key: &str, prop: &str) -> f64 {
        match self.value(key, prop) {
            Value::Float(n) => *n,
            Value::Int(n) => *n as f64,
            _ => 0.0,
        }
    }

    pub fn list(&self, key: &str, prop: &str) -> &[String] {
        match self.value(key, prop) {
            Value::List(l) => l.as_slice(),
            _ => &[],
        }
    }

    pub fn rows(&self, key: &str, prop: &str) -> &[Vec<String>] {
        match self.value(key, prop) {
            Value::Rows(r) => r.as_slice(),
            _ => &[],
        }
    }

    /// Components that were never seeded are active.
    pub fn state(&self, key: &str) -> State {
        self.entries
            .get(key)
            .map(|e| e.state)
            .unwrap_or(State::Active)
    }

    pub fn shown(&self, key: &str) -> bool {
        self.state(key) != State::Hidden
    }

    pub fn muted(&self, key: &str) -> bool {
        self.state(key) == State::Muted
    }

    /// Can take the keyboard focus: active or read-only.
    pub fn focusable(&self, key: &str) -> bool {
        matches!(self.state(key), State::Active | State::Readonly)
    }

    pub fn modal_open(&self, key: &str) -> bool {
        self.shown(key) && self.boolean(key, "open")
    }

    /// Errors that were reported and not closed yet (shown in the dialog).
    pub fn pending(&self) -> &[ErrorEntry] {
        &self.pending
    }

    pub fn log(&self) -> &[LogEntry] {
        &self.log
    }

    pub fn log_visible(&self) -> bool {
        self.log_visible
    }
}

// ── Runtime ───────────────────────────────────────────────────────────────────

pub type Handler = Arc<dyn Fn(&Event) + Send + Sync>;

#[derive(Default)]
struct Life {
    ready: bool,
    failed: Option<String>,
    closed: bool,
}

struct Inner {
    store: Mutex<Store>,
    handlers: Mutex<HashMap<(String, String), Vec<Handler>>>,
    dispatch: Sender<Event>,
    queue_tx: Sender<Event>,
    queue_rx: Arc<Mutex<Receiver<Event>>>,
    life: Mutex<Life>,
    changed: Condvar,
    dirty: AtomicBool,
}

/// Shared by the UI loop, the event thread and the program; cheap to clone.
#[derive(Clone)]
pub struct Runtime {
    inner: Arc<Inner>,
}

thread_local! {
    static IN_HANDLER: Cell<bool> = const { Cell::new(false) };
    static LAST_PANIC: RefCell<Option<String>> = const { RefCell::new(None) };
}

static REPORTER: Mutex<Option<Runtime>> = Mutex::new(None);

fn payload_text(p: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = p.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = p.downcast_ref::<String>() {
        s.clone()
    } else {
        "panic".to_string()
    }
}

/// Handler panics are caught and reported, they must not print into the terminal UI. Call this
/// after the terminal was set up (a terminal framework may install its own panic hook).
pub fn install_hook() {
    let prev = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        let text = {
            let msg = payload_text(info.payload());
            match info.location() {
                Some(l) => format!("{msg} ({}:{})", l.file(), l.line()),
                None => msg,
            }
        };
        if IN_HANDLER.with(|c| c.get()) {
            LAST_PANIC.with(|l| *l.borrow_mut() = Some(text));
            return;
        }
        let reporter = REPORTER.lock().ok().and_then(|g| g.clone());
        match reporter {
            Some(rt) => rt.report_full(&format!("panic: {text}"), "", "panic"),
            None => prev(info),
        }
    }));
}

impl Runtime {
    pub fn new() -> Runtime {
        let (dispatch, dispatch_rx) = mpsc::channel::<Event>();
        let (queue_tx, queue_rx) = mpsc::channel::<Event>();
        let inner = Arc::new(Inner {
            store: Mutex::new(Store::default()),
            handlers: Mutex::new(HashMap::new()),
            dispatch,
            queue_tx,
            queue_rx: Arc::new(Mutex::new(queue_rx)),
            life: Mutex::new(Life::default()),
            changed: Condvar::new(),
            dirty: AtomicBool::new(true),
        });
        let weak: Weak<Inner> = Arc::downgrade(&inner);
        let _ = thread::Builder::new()
            .name("ui-events".to_string())
            .spawn(move || {
                // Handlers run here: never on the UI thread, never inside draw or key handling.
                while let Ok(event) = dispatch_rx.recv() {
                    let Some(inner) = weak.upgrade() else { break };
                    Runtime { inner }.dispatch_event(&event);
                }
            });
        Runtime { inner }
    }

    pub fn seed(&self, seeds: Vec<Seed>) {
        let mut st = self.lock();
        for s in seeds {
            st.entries.insert(
                s.key,
                Entry {
                    state: s.state,
                    props: s.props.into_iter().collect(),
                },
            );
        }
        drop(st);
        self.touch();
    }

    /// The store, locked. Hold it briefly (one frame) and never call other runtime methods.
    pub fn lock(&self) -> MutexGuard<'_, Store> {
        self.inner.store.lock().unwrap_or_else(|e| e.into_inner())
    }

    // -- redraw wake-up --------------------------------------------------------

    /// Something changed: the UI loop should redraw.
    pub fn touch(&self) {
        self.inner.dirty.store(true, Ordering::SeqCst);
    }

    /// True once after every change (the UI loop polls this).
    pub fn take_dirty(&self) -> bool {
        self.inner.dirty.swap(false, Ordering::SeqCst)
    }

    // -- values ----------------------------------------------------------------

    pub fn get(&self, key: &str, prop: &str) -> Value {
        self.lock().value(key, prop).clone()
    }

    pub fn get_text(&self, key: &str, prop: &str) -> String {
        self.lock().text(key, prop).to_string()
    }

    pub fn get_bool(&self, key: &str, prop: &str) -> bool {
        self.lock().boolean(key, prop)
    }

    pub fn get_int(&self, key: &str, prop: &str) -> i64 {
        self.lock().int(key, prop)
    }

    pub fn get_list(&self, key: &str, prop: &str) -> Vec<String> {
        self.lock().list(key, prop).to_vec()
    }

    pub fn get_rows(&self, key: &str, prop: &str) -> Vec<Vec<String>> {
        self.lock().rows(key, prop).to_vec()
    }

    /// The program writes a value. Never fires an event (no echo).
    pub fn set(&self, key: &str, prop: &str, value: Value) {
        {
            let mut st = self.lock();
            let entry = st.entries.entry(key.to_string()).or_insert_with(|| Entry {
                state: State::Active,
                props: HashMap::new(),
            });
            entry.props.insert(prop.to_string(), value);
        }
        self.touch();
    }

    pub fn state(&self, key: &str) -> State {
        self.lock().state(key)
    }

    pub fn modal_open(&self, key: &str) -> bool {
        self.lock().modal_open(key)
    }

    /// Change the state; `supported` lists what the component allows.
    pub fn set_state(&self, key: &str, state: State, supported: &[State]) -> Result<(), UiError> {
        if !supported.contains(&state) {
            let names: Vec<&str> = supported.iter().map(|s| s.name()).collect();
            return Err(UiError::new(format!(
                "{key:?} does not support {:?}; supported: {}",
                state.name(),
                names.join(", ")
            )));
        }
        {
            let mut st = self.lock();
            let entry = st.entries.entry(key.to_string()).or_insert_with(|| Entry {
                state: State::Active,
                props: HashMap::new(),
            });
            entry.state = state;
        }
        self.touch();
        Ok(())
    }

    // -- user input (called by the UI) ----------------------------------------

    /// Whether the user may change or trigger the component right now.
    pub fn accepts(&self, key: &str) -> bool {
        self.lock().state(key) == State::Active
    }

    /// The user changed a value. Ignored (false) unless the component is active.
    pub fn user_set(&self, key: &str, prop: &str, value: Value, event: Option<&str>) -> bool {
        {
            let mut st = self.lock();
            let Some(entry) = st.entries.get_mut(key) else {
                return false;
            };
            if entry.state != State::Active {
                return false;
            }
            entry.props.insert(prop.to_string(), value.clone());
        }
        self.touch();
        if let Some(name) = event {
            self.emit(key, name, value);
        }
        true
    }

    /// The user triggered something (click, submit, select). Only active components send events.
    pub fn user_emit(&self, key: &str, name: &str, value: Value) -> bool {
        if !self.accepts(key) {
            return false;
        }
        self.emit(key, name, value);
        true
    }

    // -- events ----------------------------------------------------------------

    pub fn on(&self, key: &str, name: &str, handler: Handler) {
        let mut hs = self.inner.handlers.lock().unwrap_or_else(|e| e.into_inner());
        hs.entry((key.to_string(), name.to_string()))
            .or_default()
            .push(handler);
    }

    pub fn emit(&self, key: &str, name: &str, value: Value) {
        let event = Event {
            tag: key.to_string(),
            name: name.to_string(),
            value,
            time: now(),
        };
        let _ = self.inner.queue_tx.send(event.clone());
        let _ = self.inner.dispatch.send(event);
    }

    pub fn events(&self) -> Events {
        Events {
            rx: self.inner.queue_rx.clone(),
        }
    }

    fn dispatch_event(&self, event: &Event) {
        let handlers: Vec<Handler> = {
            let hs = self.inner.handlers.lock().unwrap_or_else(|e| e.into_inner());
            hs.get(&(event.tag.clone(), event.name.clone()))
                .cloned()
                .unwrap_or_default()
        };
        for handler in handlers {
            IN_HANDLER.with(|c| c.set(true));
            let result = panic::catch_unwind(AssertUnwindSafe(|| handler(event)));
            IN_HANDLER.with(|c| c.set(false));
            if let Err(payload) = result {
                let detail = LAST_PANIC
                    .with(|l| l.borrow_mut().take())
                    .unwrap_or_else(|| payload_text(payload.as_ref()));
                self.report_full(
                    &format!("Handler for {}.{} failed: {}", event.tag, event.name, detail),
                    &detail,
                    "handler",
                );
            }
        }
    }

    // -- errors and log --------------------------------------------------------

    pub fn report(&self, message: &str) {
        self.report_full(message, "", "program");
    }

    pub fn report_full(&self, message: &str, details: &str, source: &str) {
        let entry = ErrorEntry {
            time: now(),
            message: message.to_string(),
            details: details.to_string(),
            source: source.to_string(),
        };
        {
            let mut st = self.lock();
            st.pending.push(entry.clone());
            st.errors.push(entry);
        }
        self.log_add(Level::Error, message);
    }

    pub fn errors(&self) -> Vec<ErrorEntry> {
        self.lock().errors.clone()
    }

    pub fn has_pending(&self) -> bool {
        !self.lock().pending.is_empty()
    }

    /// Close the error dialog (the errors stay in `errors()` and the log).
    pub fn dismiss_errors(&self) {
        self.lock().pending.clear();
        self.touch();
    }

    pub fn log_add(&self, level: Level, message: &str) {
        {
            let mut st = self.lock();
            st.log.push(LogEntry {
                time: now(),
                level,
                message: message.to_string(),
            });
            if st.log.len() > MAX_LOG {
                st.log.remove(0);
            }
        }
        self.touch();
    }

    pub fn log_entries(&self) -> Vec<LogEntry> {
        self.lock().log.clone()
    }

    pub fn toggle_log(&self) {
        {
            let mut st = self.lock();
            st.log_visible = !st.log_visible;
        }
        self.touch();
    }

    /// Route panics of any thread to the error dialog (see `Ui::install_panic_hook`).
    pub fn install_panic_hook(&self) {
        if let Ok(mut r) = REPORTER.lock() {
            *r = Some(self.clone());
        }
        install_hook();
    }

    // -- lifecycle -------------------------------------------------------------

    pub fn mark_ready(&self) {
        let mut life = self.inner.life.lock().unwrap_or_else(|e| e.into_inner());
        life.ready = true;
        self.inner.changed.notify_all();
    }

    pub fn mark_failed(&self, why: &str) {
        let mut life = self.inner.life.lock().unwrap_or_else(|e| e.into_inner());
        life.failed = Some(why.to_string());
        life.closed = true;
        self.inner.changed.notify_all();
    }

    pub fn mark_closed(&self) {
        let mut life = self.inner.life.lock().unwrap_or_else(|e| e.into_inner());
        life.closed = true;
        self.inner.changed.notify_all();
        drop(life);
        self.touch();
    }

    pub fn is_ready(&self) -> bool {
        self.inner.life.lock().map(|l| l.ready).unwrap_or(false)
    }

    pub fn is_closed(&self) -> bool {
        self.inner.life.lock().map(|l| l.closed).unwrap_or(true)
    }

    pub fn is_running(&self) -> bool {
        self.inner
            .life
            .lock()
            .map(|l| l.ready && !l.closed)
            .unwrap_or(false)
    }

    /// Blocks until the UI is ready; an error when it could not start or `timeout` passed.
    pub fn wait_ready(&self, timeout: Duration) -> Result<(), UiError> {
        let life = self.inner.life.lock().unwrap_or_else(|e| e.into_inner());
        let (life, _) = self
            .inner
            .changed
            .wait_timeout_while(life, timeout, |l| !l.ready && l.failed.is_none())
            .unwrap_or_else(|e| e.into_inner());
        if let Some(why) = &life.failed {
            return Err(UiError::new(format!("the UI could not start: {why}")));
        }
        if life.ready {
            Ok(())
        } else {
            Err(UiError::new("the UI did not become ready in time"))
        }
    }

    /// Blocks until the UI is closed.
    pub fn wait_closed(&self) {
        let life = self.inner.life.lock().unwrap_or_else(|e| e.into_inner());
        let _guard = self
            .inner
            .changed
            .wait_while(life, |l| !l.closed)
            .unwrap_or_else(|e| e.into_inner());
    }

    pub fn stop(&self) {
        self.mark_closed();
    }
}

impl Default for Runtime {
    fn default() -> Self {
        Runtime::new()
    }
}

/// The queue of every event of every component (the alternative to handlers).
#[derive(Clone)]
pub struct Events {
    rx: Arc<Mutex<Receiver<Event>>>,
}

impl Events {
    /// The next event, or None when none arrives within `timeout`.
    pub fn next(&self, timeout: Duration) -> Option<Event> {
        let rx = self.rx.lock().unwrap_or_else(|e| e.into_inner());
        rx.recv_timeout(timeout).ok()
    }

    pub fn try_next(&self) -> Option<Event> {
        let rx = self.rx.lock().unwrap_or_else(|e| e.into_inner());
        rx.try_recv().ok()
    }

    /// Everything that is queued right now.
    pub fn drain(&self) -> Vec<Event> {
        let rx = self.rx.lock().unwrap_or_else(|e| e.into_inner());
        rx.try_iter().collect()
    }
}

/// `ui.log().info("...")`
#[derive(Clone)]
pub struct Log {
    rt: Runtime,
}

impl Log {
    pub fn new(rt: &Runtime) -> Log {
        Log { rt: rt.clone() }
    }

    pub fn debug(&self, message: impl AsRef<str>) {
        self.rt.log_add(Level::Debug, message.as_ref());
    }

    pub fn info(&self, message: impl AsRef<str>) {
        self.rt.log_add(Level::Info, message.as_ref());
    }

    pub fn warning(&self, message: impl AsRef<str>) {
        self.rt.log_add(Level::Warning, message.as_ref());
    }

    pub fn error(&self, message: impl AsRef<str>) {
        self.rt.log_add(Level::Error, message.as_ref());
    }

    pub fn entries(&self) -> Vec<LogEntry> {
        self.rt.log_entries()
    }
}

// ── Handles ───────────────────────────────────────────────────────────────────

const ALL: &[State] = &[State::Active, State::Muted, State::Readonly, State::Hidden];
const NO_READONLY: &[State] = &[State::Active, State::Muted, State::Hidden];
const HIDE_ONLY: &[State] = &[State::Active, State::Hidden];

/// What every component has: a state and typed access to its properties and events.
#[derive(Clone)]
pub struct Handle {
    rt: Runtime,
    tag: String,
    states: &'static [State],
}

impl Handle {
    pub fn new(rt: &Runtime, tag: &str, states: &'static [State]) -> Handle {
        Handle {
            rt: rt.clone(),
            tag: tag.to_string(),
            states,
        }
    }

    pub fn tag(&self) -> &str {
        &self.tag
    }

    pub fn state(&self) -> State {
        self.rt.state(&self.tag)
    }

    fn put(&self, state: State) -> Result<(), UiError> {
        self.rt.set_state(&self.tag, state, self.states)
    }

    /// Normal: visible and usable.
    pub fn active(&self) -> Result<(), UiError> {
        self.put(State::Active)
    }

    /// Visible but dimmed; ignores input and sends no events.
    pub fn mute(&self) -> Result<(), UiError> {
        self.put(State::Muted)
    }

    /// Looks normal, the user cannot change it.
    pub fn readonly(&self) -> Result<(), UiError> {
        self.put(State::Readonly)
    }

    pub fn hide(&self) -> Result<(), UiError> {
        self.put(State::Hidden)
    }

    /// Same as `active()`.
    pub fn show(&self) -> Result<(), UiError> {
        self.put(State::Active)
    }

    pub fn get(&self, prop: &str) -> Value {
        self.rt.get(&self.tag, prop)
    }

    /// Writes a property; never fires an event.
    pub fn set(&self, prop: &str, value: Value) {
        self.rt.set(&self.tag, prop, value);
    }

    pub fn on<F>(&self, event: &str, f: F)
    where
        F: Fn(&Event) + Send + Sync + 'static,
    {
        self.rt.on(&self.tag, event, Arc::new(f));
    }

    fn get_str(&self, prop: &str) -> String {
        self.rt.get_text(&self.tag, prop)
    }

    fn get_bool(&self, prop: &str) -> bool {
        self.rt.get_bool(&self.tag, prop)
    }

    fn get_int(&self, prop: &str) -> i64 {
        self.rt.get_int(&self.tag, prop)
    }

    fn get_float(&self, prop: &str) -> f64 {
        match self.rt.get(&self.tag, prop) {
            Value::Float(n) => n,
            Value::Int(n) => n as f64,
            _ => 0.0,
        }
    }

    fn get_list(&self, prop: &str) -> Vec<String> {
        self.rt.get_list(&self.tag, prop)
    }

    fn get_rows(&self, prop: &str) -> Vec<Vec<String>> {
        self.rt.get_rows(&self.tag, prop)
    }
}

macro_rules! handle_type {
    ($(#[$doc:meta])* $name:ident, $states:expr) => {
        $(#[$doc])*
        #[derive(Clone)]
        pub struct $name {
            h: Handle,
        }

        impl $name {
            pub fn new(rt: &Runtime, tag: &str) -> $name {
                $name {
                    h: Handle::new(rt, tag, $states),
                }
            }
        }

        impl Deref for $name {
            type Target = Handle;

            fn deref(&self) -> &Handle {
                &self.h
            }
        }
    };
}

macro_rules! str_prop {
    ($name:ident, $setter:ident, $prop:expr) => {
        pub fn $name(&self) -> String {
            self.h.get_str($prop)
        }

        pub fn $setter(&self, value: impl Into<String>) {
            self.h.set($prop, Value::Str(value.into()));
        }
    };
}

macro_rules! bool_prop {
    ($name:ident, $setter:ident, $prop:expr) => {
        pub fn $name(&self) -> bool {
            self.h.get_bool($prop)
        }

        pub fn $setter(&self, value: bool) {
            self.h.set($prop, Value::Bool(value));
        }
    };
}

macro_rules! int_prop {
    ($name:ident, $setter:ident, $prop:expr) => {
        pub fn $name(&self) -> i64 {
            self.h.get_int($prop)
        }

        pub fn $setter(&self, value: i64) {
            self.h.set($prop, Value::Int(value));
        }
    };
}

macro_rules! float_prop {
    ($name:ident, $setter:ident, $prop:expr) => {
        pub fn $name(&self) -> f64 {
            self.h.get_float($prop)
        }

        pub fn $setter(&self, value: impl Into<f64>) {
            self.h.set($prop, Value::Float(value.into()));
        }
    };
}

macro_rules! list_prop {
    ($name:ident, $setter:ident, $prop:expr) => {
        pub fn $name(&self) -> Vec<String> {
            self.h.get_list($prop)
        }

        pub fn $setter<S: Into<String>>(&self, value: impl IntoIterator<Item = S>) {
            self.h.set(
                $prop,
                Value::List(value.into_iter().map(Into::into).collect()),
            );
        }
    };
}

macro_rules! on_event {
    ($method:ident, $event:expr) => {
        pub fn $method<F>(&self, f: F)
        where
            F: Fn(&Event) + Send + Sync + 'static,
        {
            self.h.on($event, f);
        }
    };
}

handle_type!(
    /// Box, Grid, Spacer, Breadcrumb: can be shown or hidden.
    ContainerHandle,
    HIDE_ONLY
);
handle_type!(TextHandle, HIDE_ONLY);
handle_type!(SpinnerHandle, HIDE_ONLY);
handle_type!(ButtonHandle, NO_READONLY);
handle_type!(InputHandle, ALL);
handle_type!(
    /// Checkbox, Radio and Toggle.
    CheckHandle,
    ALL
);
handle_type!(SelectHandle, ALL);
handle_type!(ProgressHandle, NO_READONLY);
handle_type!(TableHandle, ALL);
handle_type!(ListHandle, ALL);
handle_type!(TreeHandle, ALL);
handle_type!(MenuHandle, ALL);
handle_type!(TabsHandle, ALL);
handle_type!(ModalHandle, HIDE_ONLY);

impl TextHandle {
    str_prop!(text, set_text, "text");
}

impl SpinnerHandle {
    str_prop!(label, set_label, "label");
}

impl ButtonHandle {
    str_prop!(label, set_label, "label");
    on_event!(on_click, "click");
}

impl InputHandle {
    str_prop!(value, set_value, "value");
    str_prop!(placeholder, set_placeholder, "placeholder");
    on_event!(on_change, "change");
    on_event!(on_submit, "submit");
}

impl CheckHandle {
    bool_prop!(checked, set_checked, "checked");
    str_prop!(label, set_label, "label");
    on_event!(on_change, "change");
}

impl SelectHandle {
    str_prop!(value, set_value, "value");
    list_prop!(options, set_options, "options");
    on_event!(on_change, "change");
}

impl ProgressHandle {
    float_prop!(value, set_value, "value");
    float_prop!(max, set_max, "max");
}

impl TableHandle {
    list_prop!(columns, set_columns, "columns");

    pub fn rows(&self) -> Vec<Vec<String>> {
        self.h.get_rows("rows")
    }

    pub fn set_rows<S: Into<String>>(&self, rows: impl IntoIterator<Item = Vec<S>>) {
        self.h.set(
            "rows",
            Value::Rows(
                rows.into_iter()
                    .map(|r| r.into_iter().map(Into::into).collect())
                    .collect(),
            ),
        );
    }
}

impl ListHandle {
    list_prop!(items, set_items, "items");
    int_prop!(selected, set_selected, "selected");
    on_event!(on_select, "select");
}

impl TreeHandle {
    on_event!(on_select, "select");
}

impl MenuHandle {
    int_prop!(selected, set_selected, "selected");
    on_event!(on_select, "select");
}

impl TabsHandle {
    int_prop!(active_tab, set_active_tab, "active_tab");
    on_event!(on_change, "change");
}

impl ModalHandle {
    str_prop!(title, set_title, "title");

    /// Show the modal on top of the UI.
    pub fn open(&self) {
        self.h.set("open", Value::Bool(true));
    }

    pub fn close(&self) {
        self.h.set("open", Value::Bool(false));
    }

    pub fn is_open(&self) -> bool {
        self.h.get_bool("open")
    }
}
