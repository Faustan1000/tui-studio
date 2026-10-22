//! Dumps the first frame at 100x40 on ratatui's TestBackend (tests/visual.ratatui.test.ts diffs it).

use crate::ui::Ui;
use crate::ui_runtime::install_hook;
use crate::{run_loop, App};
use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use ratatui::crossterm::event::Event as TermEvent;
use ratatui::Terminal;
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

#[test]
fn dump_frame_100x40() {
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
    ui.runtime().wait_ready(Duration::from_secs(5)).unwrap();
    let end = Instant::now() + Duration::from_secs(5);
    while frame.lock().unwrap().area.width == 0 && Instant::now() < end {
        thread::sleep(Duration::from_millis(10));
    }
    thread::sleep(Duration::from_millis(200));
    let buf = frame.lock().unwrap();
    let mut out = String::new();
    for y in 0..buf.area.height {
        for x in 0..buf.area.width {
            out.push_str(buf[(x, y)].symbol());
        }
        out.push('\n');
    }
    drop(keys);
    std::fs::write(std::env::var("TUISTUDIO_FRAME_OUT").unwrap(), out).unwrap();
}
