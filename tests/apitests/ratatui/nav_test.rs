//! Tab and menu bodies switch at run time: only the body of the selected item is drawn, whether
//! the tab is chosen with the mouse, the keyboard or through the program API. Runs the generated
//! multi-screen design headless on ratatui's TestBackend (same loop as `Ui::serve`).

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
fn nav_bodies_follow_the_selected_item() {
    let h = start();
    h.shows("Dashboard content");
    assert!(!h.text().contains("Agent content"), "{}", h.text());
    assert!(h.text().contains("Menu one body"), "{}", h.text());

    // through the program API
    h.ui.pages.set_active_tab(1);
    h.shows("Agent content");
    h.hides("Dashboard content");

    // with the mouse
    h.click_on("Dashboard");
    h.shows("Dashboard content");
    h.hides("Agent content");

    // with the keyboard: Tab to the tab bar is not needed, a click focuses it, then arrows move
    h.key(KeyCode::Right);
    h.shows("Agent content");
    h.hides("Dashboard content");

    // the control inside the new body can be clicked
    h.click_on("Run");
    // (the tab changes of the clicks above come first)
    let mut clicked = false;
    while let Some(ev) = h.ui.next_event(Duration::from_secs(3)) {
        if (ev.tag.as_str(), ev.name.as_str()) == ("agent_btn", "click") {
            clicked = true;
            break;
        }
    }
    assert!(clicked, "no click event from the button of the body");
    assert_eq!(h.ui.pages.active_tab(), 1);
}
