// S15 (mouse) and S16 (fill) of the program API scenario for the apiDesign project, on a tcell
// simulation screen. Copied next to the generated project by tests/api.tview.test.ts.

package main

import (
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gdamore/tcell/v2"
	"github.com/rivo/tview"
)

func TestMouse(t *testing.T) {
	ui, sim := startUi(t, 100, 90)
	defer ui.Stop()
	if !waitFor(shows(sim, "Inside the panel")) {
		t.Fatalf("no first frame:\n%s", frame(sim))
	}
	drain(ui)
	var clicks atomic.Int32
	ui.SubmitBtn.OnClick(func(e Event) { clicks.Add(1) })

	t.Run("S15_click_button_and_input", func(t *testing.T) {
		clickText(t, sim, "Send")
		evs := drain(ui)
		if len(eventsOf(evs, "submit_btn", "click")) != 1 {
			t.Errorf("a click on the button sent %+v", evs)
		}
		if !isButton(ui.t.app.GetFocus()) {
			t.Errorf("the button did not take the focus (%T)", ui.t.app.GetFocus())
		}
		clickText(t, sim, "your name")
		if !isInput(ui.t.app.GetFocus()) {
			t.Errorf("a click on the input did not focus it (%T)", ui.t.app.GetFocus())
		}
		typeRune(sim, 'k')
		if !waitFor(func() bool { return ui.NameInput.Value() == "k" }) {
			t.Errorf("typing after the click: %q", ui.NameInput.Value())
		}
		if len(eventsOf(drain(ui), "name_input", "change")) == 0 {
			t.Errorf("no change event for typing")
		}
	})

	t.Run("S15_click_checkbox", func(t *testing.T) {
		clickText(t, sim, "I agree")
		if !waitFor(func() bool { return ui.Agree.Checked() }) {
			t.Fatalf("the checkbox did not toggle")
		}
		evs := eventsOf(drain(ui), "agree", "change")
		if len(evs) != 1 || evs[0].Value != true {
			t.Errorf("checkbox events: %+v", evs)
		}
		// writing from the program is still silent (S9)
		ui.Agree.SetChecked(false)
		time.Sleep(200 * time.Millisecond)
		if evs := drain(ui); len(evs) != 0 {
			t.Errorf("echo: %+v", evs)
		}
	})

	t.Run("S15_click_select", func(t *testing.T) {
		clickText(t, sim, "Red")
		if !waitFor(shows(sim, "Green")) {
			t.Fatalf("the drop-down did not open:\n%s", frame(sim))
		}
		clickText(t, sim, "Green")
		if !waitFor(func() bool { return ui.Color.Value() == "Green" }) {
			t.Fatalf("option not chosen: %q\n%s", ui.Color.Value(), frame(sim))
		}
		evs := eventsOf(drain(ui), "color", "change")
		if len(evs) == 0 || evs[len(evs)-1].Value != "Green" {
			t.Errorf("select events: %+v", evs)
		}
	})

	t.Run("S15_click_list", func(t *testing.T) {
		clickText(t, sim, "Item 2")
		if !waitFor(func() bool { return ui.Files.Selected() == 1 }) {
			t.Fatalf("list selection = %d", ui.Files.Selected())
		}
		evs := eventsOf(drain(ui), "files", "select")
		if len(evs) == 0 || evs[len(evs)-1].Value != "Item 2" {
			t.Errorf("list events: %+v", evs)
		}
	})

	t.Run("S15_click_table", func(t *testing.T) {
		clickText(t, sim, "Cell 3")
		if !waitFor(func() bool { return isTable(ui.t.app.GetFocus()) }) {
			t.Fatalf("the table did not take the focus (%T)", ui.t.app.GetFocus())
		}
		selected := func() int {
			row := -1
			// the table is only touched on the UI goroutine
			ui.t.app.QueueUpdate(func() {
				if table, ok := ui.t.app.GetFocus().(*tview.Table); ok {
					row, _ = table.GetSelection()
				}
			})
			return row
		}
		if !waitFor(func() bool { return selected() == 2 }) {
			t.Errorf("table row = %d, want 2 (Cell 3)", selected())
		}
	})

	t.Run("S15_click_tabs", func(t *testing.T) {
		clickText(t, sim, "QA Team")
		if !waitFor(func() bool { return ui.Pages.ActiveTab() == 2 }) {
			t.Fatalf("active tab = %d", ui.Pages.ActiveTab())
		}
		evs := eventsOf(drain(ui), "pages", "change")
		if len(evs) != 1 || evs[0].Value != 2 {
			t.Errorf("tab events: %+v", evs)
		}
		clickText(t, sim, "Dashboard")
		if !waitFor(func() bool { return ui.Pages.ActiveTab() == 0 }) {
			t.Errorf("active tab = %d", ui.Pages.ActiveTab())
		}
		drain(ui)
		key(sim, tcell.KeyRight)
		if !waitFor(func() bool { return ui.Pages.ActiveTab() == 1 }) {
			t.Errorf("arrow keys no longer work: %d", ui.Pages.ActiveTab())
		}
		if len(eventsOf(drain(ui), "pages", "change")) != 1 {
			t.Errorf("no event for the arrow key")
		}
		// writing is silent
		ui.Pages.SetActiveTab(2)
		time.Sleep(200 * time.Millisecond)
		if evs := drain(ui); len(evs) != 0 {
			t.Errorf("echo: %+v", evs)
		}
	})

	t.Run("S15_muted_readonly_ignore_clicks", func(t *testing.T) {
		before := clicks.Load()
		ui.SubmitBtn.Mute()
		time.Sleep(150 * time.Millisecond)
		clickText(t, sim, "Send")
		ui.SubmitBtn.Active()
		ui.Agree.Readonly()
		time.Sleep(150 * time.Millisecond)
		was := ui.Agree.Checked()
		clickText(t, sim, "I agree")
		ui.Agree.Active()
		ui.Pages.Mute()
		time.Sleep(150 * time.Millisecond)
		clickText(t, sim, "Dashboard")
		ui.Pages.Active()
		time.Sleep(150 * time.Millisecond)
		evs := drain(ui)
		if clicks.Load() != before || ui.Agree.Checked() != was || ui.Pages.ActiveTab() != 2 || len(evs) != 0 {
			t.Errorf("clicks=%d (was %d) agree=%v tab=%d events=%+v", clicks.Load(), before, ui.Agree.Checked(), ui.Pages.ActiveTab(), evs)
		}
	})

	t.Run("S15_dialogs_take_the_clicks", func(t *testing.T) {
		before := clicks.Load()
		ui.Report("boom")
		if !waitFor(shows(sim, "boom")) {
			t.Fatalf("no dialog")
		}
		clickText(t, sim, "Send")
		if clicks.Load() != before || len(drain(ui)) != 0 {
			t.Errorf("a click behind the error dialog went through")
		}
		clickText(t, sim, "OK")
		if !waitFor(hides(sim, "boom")) {
			t.Errorf("the OK button did not close the dialog:\n%s", frame(sim))
		}
		ui.Confirm.Open()
		if !waitFor(shows(sim, "Really?")) {
			t.Fatalf("no modal")
		}
		clickText(t, sim, "Send")
		time.Sleep(150 * time.Millisecond)
		if clicks.Load() != before {
			t.Errorf("a click behind the modal went through")
		}
		ui.Confirm.Close()
		waitFor(hides(sim, "Really?"))
		clickText(t, sim, "Send")
		if !waitFor(func() bool { return clicks.Load() == before+1 }) {
			t.Errorf("the button does not work after the dialogs closed")
		}
	})
}

func TestFill(t *testing.T) {
	for _, size := range [][2]int{{80, 24}, {120, 40}} {
		w, h := size[0], size[1]
		ui, sim := startUi(t, w, h)
		t.Run("S16_fill_"+strconv.Itoa(w), func(t *testing.T) {
			at := func(x, y int) rune {
				cells, cw, ch := sim.GetContents()
				if cw != w || ch != h {
					return 0
				}
				c := cells[y*cw+x]
				if len(c.Runes) == 0 {
					return ' '
				}
				return c.Runes[0]
			}
			corners := map[[2]int]rune{{0, 0}: '┌', {w - 1, 0}: '┐', {0, h - 1}: '└', {w - 1, h - 1}: '┘'}
			ok := waitFor(func() bool {
				for pos, r := range corners {
					if at(pos[0], pos[1]) != r {
						return false
					}
				}
				return true
			})
			if !ok {
				for pos, r := range corners {
					t.Errorf("%dx%d: cell %v = %q, want %q", w, h, pos, at(pos[0], pos[1]), r)
				}
				t.Logf("frame: %s", frame(sim))
			}
		})
		ui.Stop()
		ui.WaitTimeout(2 * time.Second)
	}
}
