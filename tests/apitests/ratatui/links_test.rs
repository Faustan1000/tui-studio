//! Links of items to screens, against real ratatui (TestBackend): tab items switch screens when
//! the user picks them (never when the program sets the active tab), menu and list items too,
//! and a modal of another screen never draws over the current one.

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

    /// The frame must not show `needle` for a while (a wrong switch needs time to appear).
    fn never_shows(&self, needle: &str) {
        for _ in 0..15 {
            assert!(!self.text().contains(needle), "{needle:?} is shown:\n{}", self.text());
            thread::sleep(Duration::from_millis(20));
        }
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

    fn back_home(&self) {
        self.click_on("Back");
        self.shows("Home screen");
    }
}

#[test]
fn tab_item_links_switch_screens_only_for_the_user() {
    let h = start();
    h.shows("Home screen");

    // the program setting the active tab does not switch screens
    h.ui.nav_tabs.set_active_tab(1);
    h.never_shows("Settings screen");
    h.ui.nav_tabs.set_active_tab(0);
    h.never_shows("Settings screen");

    // with the keyboard: Tab focuses the tabs, Right chooses 'Prefs'
    h.key(KeyCode::Tab);
    thread::sleep(Duration::from_millis(60));
    h.key(KeyCode::Right);
    h.shows("Settings screen");
    h.back_home();

    // with the mouse
    h.click_on("Prefs");
    h.shows("Settings screen");
    h.hides("Home screen");
    h.back_home();
}

#[test]
fn menu_item_links_open_screens() {
    let h = start();
    h.shows("Open about");
    h.click_on("Open about");
    h.shows("About screen");
    h.click_on("Home");
    h.shows("Home screen");

    // with the keyboard: Tab to the menu, Enter on its first item
    for _ in 0..8 {
        if h.text().contains("About screen") {
            break;
        }
        h.key(KeyCode::Tab);
        h.key(KeyCode::Enter);
        thread::sleep(Duration::from_millis(60));
    }
    h.shows("About screen");
}

#[test]
fn list_item_links_open_screens() {
    let h = start();
    h.shows("Go settings");
    h.click_on("Go settings");
    h.shows("Settings screen");
    h.back_home();
}

#[test]
fn modal_of_another_screen_does_not_draw() {
    let h = start();
    h.shows("Home screen");
    h.ui.confirm.open();
    h.never_shows("Modal body");

    h.ui.settings.show();
    h.shows("Settings screen");
    h.ui.confirm.open();
    h.shows("Modal body");
}
