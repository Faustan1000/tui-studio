//! The API scenario S1..S14 (docs/API_SCENARIO.md) against the generated Ratatui program.
//!
//! The UI runs on its own thread exactly like in `Ui::serve`: the same `App`, the same
//! `run_loop` and the same key handler, but on ratatui's TestBackend and with keys coming from
//! a channel instead of the terminal.

use crate::ui::Ui;
use crate::ui_runtime::{install_hook, Event, State, Value};
use crate::{run_loop, App};
use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use ratatui::crossterm::event::{
    Event as TermEvent, KeyCode, KeyEvent, KeyEventKind, KeyEventState, KeyModifiers, MouseButton,
    MouseEvent, MouseEventKind,
};
use ratatui::style::Modifier;
use ratatui::Terminal;
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, ThreadId};
use std::time::{Duration, Instant};

struct Harness {
    ui: Ui,
    keys: Sender<TermEvent>,
    frame: Arc<Mutex<Buffer>>,
    ui_thread: Arc<Mutex<Option<ThreadId>>>,
}

fn start() -> Harness {
    start_sized(80, 60)
}

fn start_sized(width: u16, height: u16) -> Harness {
    install_hook();
    let ui = Ui::new();
    let (keys, rx) = channel::<TermEvent>();
    let frame = Arc::new(Mutex::new(Buffer::default()));
    let ui_thread = Arc::new(Mutex::new(None));
    let (rt, f, id) = (ui.runtime().clone(), frame.clone(), ui_thread.clone());
    thread::spawn(move || {
        *id.lock().unwrap() = Some(thread::current().id());
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        let mut app = App::new(rt.clone());
        rt.mark_ready();
        let _ = run_loop(
            &mut terminal,
            &mut app,
            |timeout| Ok(rx.recv_timeout(timeout).ok()),
            |buf| *f.lock().unwrap() = buf.clone(),
        );
        rt.mark_closed();
    });
    let h = Harness {
        ui,
        keys,
        frame,
        ui_thread,
    };
    h.ui.runtime().wait_ready(Duration::from_secs(5)).unwrap();
    h.wait_until("first frame", |h| h.frame.lock().unwrap().area.width > 0);
    h
}

impl Harness {
    fn text(&self) -> String {
        let buf = self.frame.lock().unwrap();
        let mut out = String::new();
        for y in 0..buf.area.height {
            for x in 0..buf.area.width {
                out.push_str(buf[(x, y)].symbol());
            }
            out.push('\n');
        }
        out
    }

    /// Whether the cell where `needle` starts is drawn with `modifier`.
    fn has_modifier(&self, needle: &str, modifier: Modifier) -> bool {
        let buf = self.frame.lock().unwrap();
        for y in 0..buf.area.height {
            let row: String = (0..buf.area.width)
                .map(|x| buf[(x, y)].symbol().to_string())
                .collect();
            if let Some(at) = row.find(needle) {
                let x = row[..at].chars().count() as u16;
                return buf[(x, y)].modifier.contains(modifier);
            }
        }
        false
    }

    fn send_key(&self, code: KeyCode, modifiers: KeyModifiers) {
        self.keys
            .send(TermEvent::Key(KeyEvent::new(code, modifiers)))
            .unwrap();
    }

    /// A key the way Windows reports it: a press followed by a release.
    fn windows_key(&self, code: KeyCode) {
        for kind in [KeyEventKind::Press, KeyEventKind::Release] {
            let key = KeyEvent {
                code,
                modifiers: KeyModifiers::NONE,
                kind,
                state: KeyEventState::NONE,
            };
            self.keys.send(TermEvent::Key(key)).unwrap();
        }
    }

    fn click(&self, column: u16, row: u16) {
        for kind in [
            MouseEventKind::Down(MouseButton::Left),
            MouseEventKind::Up(MouseButton::Left),
        ] {
            let m = MouseEvent {
                kind,
                column,
                row,
                modifiers: KeyModifiers::NONE,
            };
            self.keys.send(TermEvent::Mouse(m)).unwrap();
        }
    }

    /// Screen position (column, row) of the first occurrence of `needle` in the frame.
    fn find(&self, needle: &str) -> (u16, u16) {
        let found = {
            let buf = self.frame.lock().unwrap();
            (0..buf.area.height).find_map(|y| {
                let row: Vec<String> = (0..buf.area.width)
                    .map(|x| buf[(x, y)].symbol().to_string())
                    .collect();
                let joined = row.concat();
                joined
                    .find(needle)
                    .map(|at| (joined[..at].chars().count() as u16, y))
            })
        };
        match found {
            Some(pos) => pos,
            None => panic!("{needle:?} is not on screen:
{}", self.text()),
        }
    }

    fn wheel(&self, column: u16, row: u16, down: bool) {
        let kind = if down { MouseEventKind::ScrollDown } else { MouseEventKind::ScrollUp };
        let m = MouseEvent {
            kind,
            column,
            row,
            modifiers: KeyModifiers::NONE,
        };
        self.keys.send(TermEvent::Mouse(m)).unwrap();
    }

    /// Whether some cell in the given screen column shows `symbol` (the scrollbar thumb).
    fn column_has(&self, column: u16, symbol: &str) -> bool {
        let buf = self.frame.lock().unwrap();
        (0..buf.area.height).any(|y| buf[(column, y)].symbol() == symbol)
    }

    fn click_on(&self, needle: &str) {
        let (x, y) = self.find(needle);
        self.click(x, y);
    }

    fn key(&self, code: KeyCode) {
        self.send_key(code, KeyModifiers::NONE);
    }

    fn ctrl(&self, c: char) {
        self.send_key(KeyCode::Char(c), KeyModifiers::CONTROL);
    }

    fn type_str(&self, s: &str) {
        for c in s.chars() {
            self.key(KeyCode::Char(c));
        }
    }

    /// Tab to the n-th control (0 = text input, 1 = button, 2 = checkbox, ...) from no focus.
    fn focus(&self, n: usize) {
        for _ in 0..=n {
            self.key(KeyCode::Tab);
        }
    }

    /// The select field shows `value` (a row with the value and the arrow at its right edge).
    fn select_shows(&self, value: &str) {
        let text = self.text();
        assert!(
            text.lines().any(|l| l.contains(&format!("  {value}")) && l.contains('▼')),
            "the select shows {value}:
{text}"
        );
    }

    fn wait_until(&self, what: &str, cond: impl Fn(&Harness) -> bool) {
        let end = Instant::now() + Duration::from_secs(5);
        while Instant::now() < end {
            if cond(self) {
                return;
            }
            thread::sleep(Duration::from_millis(10));
        }
        panic!("timed out waiting for: {what}\n{}", self.text());
    }

    fn shows(&self, needle: &str) {
        let n = needle.to_string();
        self.wait_until(&format!("frame shows {needle:?}"), move |h| {
            h.text().contains(&n)
        });
    }

    fn hides(&self, needle: &str) {
        let n = needle.to_string();
        self.wait_until(&format!("frame no longer shows {needle:?}"), move |h| {
            !h.text().contains(&n)
        });
    }

    /// Let the UI process what was sent, then return what was queued.
    fn settle(&self) -> Vec<Event> {
        thread::sleep(Duration::from_millis(300));
        self.ui.events().drain()
    }

    fn close_modal(&self) {
        self.ui.confirm.close();
        self.hides("Really?");
    }
}

#[test]
fn s01_start_is_ready_and_running() {
    let h = start();
    assert!(h.ui.ready(), "S1: ready");
    assert!(h.ui.running(), "S1: running");
    h.shows("Ready");
}

#[test]
fn s02_initial_properties_and_states() {
    let h = start();
    assert_eq!(h.ui.status.text(), "Ready", "S2");
    assert_eq!(h.ui.progress.max(), 100.0, "S2");
    assert_eq!(h.ui.progress.value(), 0.0, "S2");
    assert_eq!(h.ui.name_input.value(), "", "S2");
    assert_eq!(h.ui.name_input.placeholder(), "your name", "S2");
    assert_eq!(h.ui.submit_btn.label(), "Send", "S2");
    assert_eq!(h.ui.color.value(), "Red", "S2");
    assert_eq!(h.ui.color.options(), vec!["Red", "Green", "Blue"], "S2");
    assert!(!h.ui.agree.checked(), "S2");
    assert!(!h.ui.confirm.is_open(), "S2: a modal with a code name starts closed");
    for state in [
        h.ui.status.state(),
        h.ui.submit_btn.state(),
        h.ui.panel.state(),
        h.ui.confirm.state(),
    ] {
        assert_eq!(state, State::Active, "S2");
    }
}

#[test]
fn s03_writes_from_another_thread() {
    let h = start();
    h.close_modal();
    let ui = h.ui.clone();
    thread::spawn(move || {
        ui.status.set_text("Working");
        ui.progress.set_value(42.0);
        ui.name_input.set_value("Ada");
        // Read after write returns the written value at once.
        assert_eq!(ui.status.text(), "Working");
        assert_eq!(ui.progress.value(), 42.0);
        assert_eq!(ui.name_input.value(), "Ada");
    })
    .join()
    .expect("S3: writer thread");
    h.shows("Working");
    h.shows("Ada");
    h.shows("42%");
    assert!(h.settle().is_empty(), "S3: writes are no user events");
}

#[test]
fn s04_muted_button_is_dimmed_and_silent() {
    let h = start();
    h.close_modal();
    h.focus(1);
    thread::sleep(Duration::from_millis(300)); // the focus is on the button before it is muted
    h.ui.submit_btn.mute().unwrap();
    h.shows("Send");
    h.wait_until("Send dimmed", |h| h.has_modifier("Send", Modifier::DIM));
    h.key(KeyCode::Enter);
    h.key(KeyCode::Char(' '));
    assert!(h.settle().is_empty(), "S4: muted button fires no event");
    h.ui.submit_btn.active().unwrap();
    h.key(KeyCode::Enter);
    let events = h.settle();
    assert_eq!(events.len(), 1, "S4: active again fires");
}

#[test]
fn s05_hide_and_show_a_box() {
    let h = start();
    h.close_modal();
    h.shows("Inside the panel");
    h.ui.panel.hide().unwrap();
    h.hides("Inside the panel");
    assert_eq!(h.ui.panel.state(), State::Hidden, "S5");
    h.ui.panel.show().unwrap();
    h.shows("Inside the panel");
}

#[test]
fn s06_readonly_input_ignores_typing() {
    let h = start();
    h.close_modal();
    h.ui.name_input.readonly().unwrap();
    assert_eq!(h.ui.name_input.state(), State::Readonly, "S6");
    h.focus(0);
    h.type_str("abc");
    assert!(h.settle().is_empty(), "S6: no event while readonly");
    assert_eq!(h.ui.name_input.value(), "", "S6: value unchanged");
    h.ui.name_input.active().unwrap();
    h.type_str("x");
    h.wait_until("typed value", |h| h.ui.name_input.value() == "x");
    let events = h.settle();
    assert_eq!(events.len(), 1, "S6: change event after active()");
    h.shows("x");
}

#[test]
fn s07_unsupported_state_is_an_error() {
    let h = start();
    let err = h
        .ui
        .submit_btn
        .readonly()
        .expect_err("S7: readonly on a button");
    assert!(err.message.contains("readonly"), "S7: {err}");
    assert_eq!(h.ui.submit_btn.state(), State::Active, "S7: nothing changed");
    assert!(h.ui.status.mute().is_err(), "S7: text cannot be muted");
}

#[test]
fn s08_handlers_run_off_the_ui_thread_and_the_queue_sees_events() {
    let h = start();
    h.close_modal();
    let seen: Arc<Mutex<Vec<(ThreadId, Event)>>> = Arc::default();
    let s = seen.clone();
    h.ui.submit_btn
        .on_click(move |e| s.lock().unwrap().push((thread::current().id(), e.clone())));
    h.focus(1);
    h.key(KeyCode::Enter);
    h.key(KeyCode::BackTab); // back to the text input
    h.type_str("a");
    h.key(KeyCode::Tab);
    h.key(KeyCode::Tab); // checkbox
    h.key(KeyCode::Char(' '));
    h.wait_until("agree toggled", |h| h.ui.agree.checked());

    let click = h
        .ui
        .next_event(Duration::from_secs(3))
        .expect("S8: click in the queue");
    assert_eq!(
        (click.tag.as_str(), click.name.as_str()),
        ("submit_btn", "click"),
        "S8"
    );
    let change = h
        .ui
        .next_event(Duration::from_secs(3))
        .expect("S8: input change");
    assert_eq!(
        (change.tag.as_str(), change.name.as_str()),
        ("name_input", "change"),
        "S8"
    );
    assert_eq!(change.value, Value::Str("a".to_string()), "S8");
    let toggle = h
        .ui
        .next_event(Duration::from_secs(3))
        .expect("S8: checkbox change");
    assert_eq!(
        (toggle.tag.as_str(), toggle.name.as_str()),
        ("agree", "change"),
        "S8"
    );
    assert_eq!(toggle.value, Value::Bool(true), "S8");

    h.wait_until("handler ran", |_| !seen.lock().unwrap().is_empty());
    let (thread_id, event) = seen.lock().unwrap()[0].clone();
    assert_eq!(event.tag, "submit_btn", "S8");
    assert_ne!(
        Some(thread_id),
        *h.ui_thread.lock().unwrap(),
        "S8: handler must not run on the UI thread"
    );
    assert_ne!(
        thread_id,
        thread::current().id(),
        "S8: nor on the test thread"
    );
}

#[test]
fn s09_program_writes_do_not_echo() {
    let h = start();
    h.close_modal();
    h.ui.agree.set_checked(true);
    h.ui.name_input.set_value("by program");
    h.ui.color.set_value("Blue");
    assert!(h.ui.agree.checked(), "S9");
    assert!(h.settle().is_empty(), "S9: no change event");
    h.shows("by program");
}

#[test]
fn s10_report_opens_a_dialog() {
    let h = start();
    h.close_modal();
    h.ui.report("boom");
    h.shows("boom");
    h.shows("Error");
    assert_eq!(h.ui.errors().len(), 1, "S10");
    assert!(h.ui.errors()[0].message.contains("boom"), "S10");
    h.key(KeyCode::Esc);
    h.hides("boom");
    h.ui.report("second");
    h.shows("second");
    h.key(KeyCode::Enter);
    h.hides("second");
    assert_eq!(h.ui.errors().len(), 2, "S10: errors stay recorded");
    assert!(h.ui.running(), "S10: UI keeps running");
}

#[test]
fn s11_a_panicking_handler_is_reported() {
    let h = start();
    h.close_modal();
    h.ui.submit_btn.on_click(|_| panic!("kaboom"));
    h.focus(1);
    h.key(KeyCode::Enter);
    h.shows("kaboom");
    assert!(
        h.ui.errors().iter().any(|e| e.message.contains("kaboom")),
        "S11"
    );
    h.key(KeyCode::Esc);
    h.ui.status.set_text("still alive");
    h.shows("still alive");
    assert!(h.ui.running(), "S11: UI keeps running");
}

#[test]
fn s12_log_panel_toggles_with_ctrl_l() {
    let h = start();
    h.close_modal();
    h.ui.log().info("hello");
    thread::sleep(Duration::from_millis(150));
    assert!(!h.text().contains("hello"), "S12: panel hidden by default");
    h.ctrl('l');
    h.shows("hello");
    h.ctrl('l');
    h.hides("hello");
}

#[test]
fn s13_modal_opens_and_closes() {
    let h = start();
    h.ui.confirm.open();
    h.shows("Really?");
    h.shows("Sure?");
    h.ui.confirm.close();
    h.hides("Really?");
    h.ui.confirm.open();
    h.shows("Really?");
    h.key(KeyCode::Esc); // Esc closes the modal first
    h.hides("Really?");
    assert!(!h.ui.confirm.is_open(), "S13");
    assert!(h.ui.running(), "S13: Esc closed the modal, not the UI");
}

#[test]
fn s14_stop_ends_wait_and_later_calls_are_harmless() {
    let h = start();
    h.ui.stop();
    let (tx, rx) = channel();
    let ui = h.ui.clone();
    thread::spawn(move || {
        ui.wait();
        let _ = tx.send(());
    });
    rx.recv_timeout(Duration::from_secs(3))
        .expect("S14: wait() returns");
    assert!(!h.ui.running(), "S14");
    h.ui.status.set_text("after");
    h.ui.report("after");
    h.ui.log().info("after");
    let _ = h.ui.submit_btn.mute();
    h.ui.stop();
    assert_eq!(h.ui.status.text(), "after", "S14");
}

#[test]
fn quit_key_closes_the_ui() {
    let h = start();
    h.close_modal();
    h.key(KeyCode::Char('q'));
    h.wait_until("UI closed", |h| !h.ui.running());
}

#[test]
fn escape_does_not_quit_while_typing() {
    let h = start();
    h.close_modal();
    h.focus(0);
    h.type_str("q");
    h.wait_until("typed", |h| h.ui.name_input.value() == "q");
    h.key(KeyCode::Esc);
    thread::sleep(Duration::from_millis(200));
    assert!(h.ui.running(), "Esc only unfocuses the input");
    h.key(KeyCode::Esc);
    h.wait_until("quit", |h| !h.ui.running());
}


#[test]
fn s15_mouse_clicks_do_what_the_keys_do() {
    let h = start();
    h.close_modal();
    h.shows("your name");
    // Text input: a click focuses it, typing then edits it.
    h.click_on("your name");
    h.type_str("z");
    h.wait_until("typed after click", |h| h.ui.name_input.value() == "z");
    let change = h.ui.next_event(Duration::from_secs(3)).expect("S15: input change");
    assert_eq!((change.tag.as_str(), change.name.as_str()), ("name_input", "change"), "S15");
    // Button: click event.
    h.click_on("Send");
    let click = h.ui.next_event(Duration::from_secs(3)).expect("S15: click");
    assert_eq!((click.tag.as_str(), click.name.as_str()), ("submit_btn", "click"), "S15");
    // Checkbox toggles.
    h.click_on("I agree");
    h.wait_until("agree toggled", |h| h.ui.agree.checked());
    let toggle = h.ui.next_event(Duration::from_secs(3)).expect("S15: checkbox");
    assert_eq!((toggle.tag.as_str(), toggle.value.clone()), ("agree", Value::Bool(true)), "S15");
    // Select: the click opens the list of options, a click on an option chooses it.
    h.click_on("Red");
    h.shows("Green");
    h.click_on("Green");
    h.wait_until("select changed", |h| h.ui.color.value() == "Green");
    let pick = h.ui.next_event(Duration::from_secs(3)).expect("S15: select");
    assert_eq!((pick.tag.as_str(), pick.value.clone()), ("color", Value::Str("Green".into())), "S15");
    // List row: select event with the row.
    h.click_on("Item 2");
    let sel = h.ui.next_event(Duration::from_secs(3)).expect("S15: list select");
    assert_eq!(
        (sel.tag.as_str(), sel.name.as_str(), sel.value.clone()),
        ("files", "select", Value::Int(1)),
        "S15"
    );
    assert_eq!(h.ui.files.selected(), 1, "S15");
    // Tabs: change event.
    h.click_on("Agent");
    h.wait_until("tab changed", |h| h.ui.pages.active_tab() == 1);
    let tab = h.ui.next_event(Duration::from_secs(3)).expect("S15: tab change");
    assert_eq!(
        (tab.tag.as_str(), tab.name.as_str(), tab.value.clone()),
        ("pages", "change", Value::Int(1)),
        "S15"
    );
    assert!(h.settle().is_empty(), "S15: nothing else was sent");

    // A muted button ignores the click.
    h.ui.submit_btn.mute().unwrap();
    h.wait_until("muted", |h| h.has_modifier("Send", Modifier::DIM));
    h.click_on("Send");
    assert!(h.settle().is_empty(), "S15: muted button fires nothing");
    h.ui.submit_btn.active().unwrap();

    // While the error dialog is open the click only closes it.
    h.ui.report("boom");
    h.shows("boom");
    h.click_on("Send");
    h.hides("boom");
    assert!(h.settle().is_empty(), "S15: the click went to the dialog only");

    // While the modal is open, clicks outside of it are ignored.
    h.ui.confirm.open();
    h.shows("Really?");
    h.click_on("Send");
    assert!(h.settle().is_empty(), "S15: the modal blocks clicks behind it");
    h.ui.confirm.close();
    h.hides("Really?");
    h.click_on("Send");
    assert_eq!(
        h.ui.next_event(Duration::from_secs(3)).map(|e| e.name),
        Some("click".to_string()),
        "S15"
    );
}

#[test]
fn s15_readonly_ignores_clicks() {
    let h = start();
    h.close_modal();
    h.ui.agree.readonly().unwrap();
    h.click_on("I agree");
    assert!(h.settle().is_empty(), "S15: a readonly checkbox ignores the click");
    assert!(!h.ui.agree.checked(), "S15");
    h.ui.agree.active().unwrap();
    h.click_on("I agree");
    h.wait_until("toggled", |h| h.ui.agree.checked());
}

fn assert_fills(h: &Harness, width: u16, height: u16) {
    let buf = h.frame.lock().unwrap();
    let sym = |x: u16, y: u16| buf[(x, y)].symbol().to_string();
    assert_eq!(buf.area.width, width, "S16: frame width");
    assert_eq!(buf.area.height, height, "S16: frame height");
    assert_eq!(sym(0, 0), "┌", "S16: top left");
    assert_eq!(sym(width - 1, 0), "┐", "S16: top right");
    assert_eq!(sym(0, height - 1), "└", "S16: bottom left");
    assert_eq!(sym(width - 1, height - 1), "┘", "S16: bottom right");
    for x in 1..width - 1 {
        assert_eq!(sym(x, 0), "─", "S16: top border at {x}");
        assert_eq!(sym(x, height - 1), "─", "S16: bottom border at {x}");
    }
}

#[test]
fn s16_fills_the_terminal() {
    for (w, h) in [(80, 24), (120, 40), (120, 30)] {
        let ui = start_sized(w, h);
        ui.close_modal();
        ui.shows("Ready");
        assert_fills(&ui, w, h);
    }
}

#[test]
fn s16_content_taller_than_the_terminal_is_cut_not_squeezed() {
    // 24 rows are not enough for the whole design: the controls on top keep their size.
    let h = start_sized(120, 24);
    h.close_modal();
    h.shows("Ready");
    h.shows("your name");
    h.shows("Send");
    h.shows("I agree");
    h.focus(0);
    h.type_str("typed");
    h.wait_until("typed text is visible", |h| h.text().contains("typed"));
}

#[test]
fn s17_windows_event_sequence() {
    let h = start();
    // What Windows delivers at start and between keys.
    h.keys.send(TermEvent::Resize(80, 60)).unwrap();
    h.keys.send(TermEvent::FocusGained).unwrap();
    h.close_modal();
    h.windows_key(KeyCode::Tab);
    h.windows_key(KeyCode::Tab);
    h.windows_key(KeyCode::Tab); // checkbox
    h.windows_key(KeyCode::Char(' '));
    h.wait_until("agree toggled", |h| h.ui.agree.checked());
    thread::sleep(Duration::from_millis(300));
    assert!(h.ui.agree.checked(), "S17: Press + Release must toggle exactly once");
    assert_eq!(h.ui.events().drain().len(), 1, "S17: exactly one change event");
    // Typing: every letter once.
    h.windows_key(KeyCode::BackTab);
    h.windows_key(KeyCode::BackTab);
    h.windows_key(KeyCode::Char('a'));
    h.windows_key(KeyCode::Char('b'));
    h.wait_until("typed ab", |h| h.ui.name_input.value() == "ab");
    thread::sleep(Duration::from_millis(200));
    assert_eq!(h.ui.name_input.value(), "ab", "S17: no doubled letters");
    h.keys.send(TermEvent::FocusLost).unwrap();
    // A held key: repeats of a letter are ignored, repeats of Backspace delete.
    let repeat = |code| {
        let key = KeyEvent {
            code,
            modifiers: KeyModifiers::NONE,
            kind: KeyEventKind::Repeat,
            state: KeyEventState::NONE,
        };
        h.keys.send(TermEvent::Key(key)).unwrap();
    };
    repeat(KeyCode::Char('z'));
    repeat(KeyCode::Backspace);
    h.wait_until("backspace repeat", |h| h.ui.name_input.value() == "a");
    thread::sleep(Duration::from_millis(200));
    assert_eq!(h.ui.name_input.value(), "a", "S17: repeated letters do nothing");
    // Esc leaves the field, q quits (press + release).
    h.windows_key(KeyCode::Esc);
    h.windows_key(KeyCode::Char('q'));
    h.wait_until("quit", |h| !h.ui.running());
}

#[test]
fn the_ui_does_not_start_with_a_dialog_or_an_open_modal() {
    let h = start();
    h.shows("Ready");
    assert!(!h.ui.confirm.is_open(), "a modal with a code name starts closed");
    assert!(h.ui.errors().is_empty(), "no error at start");
    assert!(!h.text().contains("Really?"), "no pop-up at start");
    assert!(!h.text().contains("Enter / Esc"), "no error dialog at start");
}

#[test]
fn fuzz_sizes_do_not_panic() {
    for (w, h) in [(1, 1), (5, 3), (20, 5), (40, 10), (80, 24), (120, 30), (200, 50), (300, 80)] {
        let rt = Ui::new().runtime().clone();
        let mut terminal = Terminal::new(TestBackend::new(w, h)).unwrap();
        let mut app = App::new(rt);
        for _ in 0..3 {
            terminal.draw(|f| crate::ui(f, &mut app)).unwrap();
        }
    }
}

#[test]
fn s18_scrolling() {
    // The design needs more than 24 rows.
    let h = start_sized(80, 24);
    h.close_modal();
    h.shows("Ready");
    assert!(!h.text().contains("Inside the panel"), "S18: the panel is below the fold");
    assert!(h.column_has(79, "█"), "S18: a scrollbar thumb on the right edge");
    // Wheel down: 3 rows per notch.
    for _ in 0..4 {
        h.wheel(10, 10, true);
    }
    h.wait_until("Ready scrolled out", |h| !h.text().contains("Ready"));
    // End shows the bottom, Home the top.
    h.key(KeyCode::End);
    h.shows("Inside the panel");
    thread::sleep(Duration::from_millis(300)); // the last frame is the scrolled one
    // A click after scrolling lands on the widget under the mouse.
    h.click_on("Item 2");
    let sel = h.ui.next_event(Duration::from_secs(3)).expect("S18: list select");
    assert_eq!(
        (sel.tag.as_str(), sel.name.as_str(), sel.value.clone()),
        ("files", "select", Value::Int(1)),
        "S18"
    );
    h.key(KeyCode::Home);
    h.shows("Ready");
    assert!(!h.text().contains("Dashboard"), "S18: the tabs are below the fold");
    // Tab to a widget below the fold scrolls it into view (the list has the focus: Tab goes to
    // the tabs under it).
    h.key(KeyCode::Tab);
    h.shows("Dashboard");
    // Shift+Tab back to the first one brings the top back.
    for _ in 0..6 {
        h.key(KeyCode::BackTab);
    }
    h.shows("your name");
    // Pages.
    h.key(KeyCode::Esc);
    h.key(KeyCode::PageDown);
    h.wait_until("page down", |h| !h.text().contains("your name"));
    h.key(KeyCode::PageUp);
    h.shows("your name");
    // Wheel up.
    h.wheel(10, 10, true);
    h.wheel(10, 10, false);
    h.shows("Ready");
    // The log panel is not scrolled.
    h.ui.log().info("hello");
    h.ctrl('l');
    h.shows("hello");
    assert!(h.ui.running(), "S18");
}

#[test]
fn s18_no_scrollbar_when_everything_fits() {
    let h = start_sized(80, 60);
    h.close_modal();
    h.shows("Inside the panel");
    assert!(!h.column_has(79, "█"), "S18: no scrollbar thumb when nothing scrolls");
    h.wheel(10, 10, true);
    thread::sleep(Duration::from_millis(200));
    h.shows("Ready");
}

#[test]
fn s19_dropdown_keyboard() {
    let h = start();
    h.close_modal();
    h.focus(3);
    h.key(KeyCode::Enter);
    h.shows("Blue");
    // Down + Enter chooses and closes.
    h.key(KeyCode::Down);
    h.key(KeyCode::Enter);
    h.wait_until("chosen", |h| h.ui.color.value() == "Green");
    h.hides("Blue");
    let change = h.ui.next_event(Duration::from_secs(3)).expect("S19: change");
    assert_eq!(
        (change.tag.as_str(), change.name.as_str(), change.value.clone()),
        ("color", "change", Value::Str("Green".into())),
        "S19"
    );
    h.select_shows("Green");
    // Esc closes without a change.
    h.key(KeyCode::Char(' '));
    h.shows("Blue");
    h.key(KeyCode::Down);
    h.key(KeyCode::Esc);
    h.hides("Blue");
    assert!(h.ui.running(), "S19: Esc closed the list, not the UI");
    assert_eq!(h.ui.color.value(), "Green", "S19: unchanged");
    // The same option again is no change.
    h.key(KeyCode::Enter);
    h.shows("Blue");
    h.key(KeyCode::Enter);
    h.hides("Blue");
    assert!(h.settle().is_empty(), "S19: choosing the current value fires nothing");
    // Readonly selects do not open.
    h.ui.color.readonly().unwrap();
    h.key(KeyCode::Enter);
    thread::sleep(Duration::from_millis(200));
    assert!(!h.text().contains("Blue"), "S19: a readonly select does not open");
}

#[test]
fn s19_dropdown_mouse() {
    let h = start();
    h.close_modal();
    h.click_on("Red");
    h.shows("Blue");
    h.click_on("Blue");
    h.wait_until("chosen by click", |h| h.ui.color.value() == "Blue");
    let ev = h.ui.next_event(Duration::from_secs(3)).expect("S19: change");
    assert_eq!((ev.tag.as_str(), ev.value.clone()), ("color", Value::Str("Blue".into())), "S19");
    h.hides("Green");
    // A click outside closes the list and does nothing else.
    h.click_on("Blue");
    h.shows("Green");
    h.click(70, 2);
    h.hides("Green");
    assert_eq!(h.ui.color.value(), "Blue", "S19");
    assert!(h.settle().is_empty(), "S19: no event");
    // A click outside on a button does not press it either.
    h.click_on("Blue");
    h.shows("Green");
    h.click_on("Send");
    h.hides("Green");
    assert!(h.settle().is_empty(), "S19: the click only closed the list");
}

#[test]
fn table_is_formatted_with_a_heading_and_widths_from_the_content() {
    let h = start_sized(80, 60);
    h.close_modal();
    h.shows("Column 1");
    let text = h.text();
    let heading = text.lines().position(|l| l.contains("Column 1  Column 2")).expect("heading row");
    let rows: Vec<&str> = text.lines().collect();
    assert!(rows[heading + 1].contains("Cell 1    Cell 2"), "first row follows the heading");
    assert!(rows[heading + 2].contains("Cell 3    Cell 4"), "second row");
    assert!(h.has_modifier("Column 1", Modifier::BOLD), "heading is bold");
}
