//! Several screens: the first one is shown at startup, `ui.settings.show()` and a button that
//! opens a screen switch between them. Runs the generated multi-screen design headless on
//! ratatui's TestBackend (same loop as `Ui::serve`).

use crate::ui::Ui;
use crate::ui_runtime::install_hook;
use crate::{run_loop, App};
use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use ratatui::crossterm::event::{
    Event as TermEvent, KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
use ratatui::Terminal;
use std::sync::mpsc::{channel, Sender};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

struct Harness {
    ui: Ui,
    keys: Sender<TermEvent>,
    frame: Arc<Mutex<Buffer>>,
}

fn start() -> Harness {
    install_hook();
    let ui = Ui::new();
    let (keys, rx) = channel::<TermEvent>();
    let frame = Arc::new(Mutex::new(Buffer::default()));
    let (rt, f) = (ui.runtime().clone(), frame.clone());
    thread::spawn(move || {
        let mut terminal = Terminal::new(TestBackend::new(100, 40)).unwrap();
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
    let h = Harness { ui, keys, frame };
    h.ui.runtime().wait_ready(Duration::from_secs(5)).unwrap();
    h.until("first frame", |h| h.frame.lock().unwrap().area.width > 0);
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

    fn until(&self, what: &str, cond: impl Fn(&Harness) -> bool) {
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
        self.until(&format!("frame shows {needle:?}"), move |h| h.text().contains(&n));
    }

    fn hides(&self, needle: &str) {
        let n = needle.to_string();
        self.until(&format!("frame hides {needle:?}"), move |h| !h.text().contains(&n));
    }

    fn click_on(&self, needle: &str) {
        let text = self.text();
        let (y, line) = text
            .lines()
            .enumerate()
            .find(|(_, l)| l.contains(needle))
            .unwrap_or_else(|| panic!("{needle:?} is not on screen:\n{text}"));
        let x = line[..line.find(needle).unwrap()].chars().count() as u16;
        for kind in [MouseEventKind::Down(MouseButton::Left), MouseEventKind::Up(MouseButton::Left)] {
            let m = MouseEvent { kind, column: x, row: y as u16, modifiers: KeyModifiers::NONE };
            self.keys.send(TermEvent::Mouse(m)).unwrap();
        }
    }

    fn key(&self, code: KeyCode) {
        self.keys.send(TermEvent::Key(KeyEvent::new(code, KeyModifiers::NONE))).unwrap();
    }
}

#[test]
fn screens_switch_with_show_and_with_a_button() {
    let h = start();
    h.shows("Ready");
    assert!(!h.text().contains("Settings screen"), "{}", h.text());
    assert!(h.ui.home.is_active());
    assert!(!h.ui.settings.is_active());

    // through the program API
    let shown = Arc::new(AtomicUsize::new(0));
    let counter = shown.clone();
    h.ui.settings.on_show(move |_| {
        counter.fetch_add(1, Ordering::SeqCst);
    });
    h.ui.settings.show();
    h.shows("Settings screen");
    h.hides("Ready");
    assert!(h.ui.settings.is_active());
    assert!(!h.ui.home.is_active());
    h.until("on_show handler", |_| shown.load(Ordering::SeqCst) == 1);

    // the button of the screen opens the screen it links to
    h.click_on("Back");
    h.shows("Ready");
    h.hides("Settings screen");
    assert!(h.ui.home.is_active());

    // with the mouse: the button of the first screen opens the second
    h.click_on("Settings");
    h.shows("Settings screen");
    h.hides("Ready");
    h.until("on_show handler again", |_| shown.load(Ordering::SeqCst) == 2);

    // with the keyboard: the controls of this screen are the text input and the button
    h.key(KeyCode::Tab);
    h.key(KeyCode::Tab);
    h.key(KeyCode::Enter);
    h.shows("Ready");
    h.hides("Settings screen");
}
