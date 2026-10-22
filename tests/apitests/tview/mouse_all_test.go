// S15 for the components that apiDesign does not have (radio, toggle, menu, tree, list, table,
// select) in the allComponents project. Copied next to that project by tests/api.tview.test.ts.

package main

import (
	"testing"
	"time"

	"github.com/rivo/tview"
)

func TestMouseAll(t *testing.T) {
	ui, sim := startUi(t, 100, 130)
	defer ui.Stop()
	if !waitFor(shows(sim, "Ready")) {
		t.Fatalf("no first frame:\n%s", frame(sim))
	}
	drain(ui)
	clickRe := func(t *testing.T, pattern string) {
		t.Helper()
		x, y, ok := findRe(sim, pattern)
		if !ok {
			t.Fatalf("%q is not on the screen:\n%s", pattern, frame(sim))
		}
		click(sim, x, y)
	}

	t.Run("S15_click_radio", func(t *testing.T) {
		clickRe(t, `│ (A)[ ]`)
		if !waitFor(func() bool { return ui.OptA.Checked() }) {
			t.Fatalf("radio A not selected")
		}
		clickRe(t, `│ (B)[ ]`)
		if !waitFor(func() bool { return ui.OptB.Checked() && !ui.OptA.Checked() }) {
			t.Fatalf("radio B did not clear A: a=%v b=%v", ui.OptA.Checked(), ui.OptB.Checked())
		}
		evs := drain(ui)
		if len(eventsOf(evs, "opt_b", "change")) == 0 {
			t.Errorf("events: %+v", evs)
		}
		// clicking the selected radio again keeps it selected
		clickRe(t, `│ (B)[ ]`)
		time.Sleep(200 * time.Millisecond)
		if !ui.OptB.Checked() {
			t.Errorf("a selected radio was cleared by a second click")
		}
		drain(ui)
	})

	t.Run("S15_click_toggle", func(t *testing.T) {
		clickRe(t, `│ (Toggle)[ ]`)
		if !waitFor(func() bool { return ui.Dark.Checked() }) {
			t.Fatalf("toggle did not switch")
		}
		if len(eventsOf(drain(ui), "dark", "change")) != 1 {
			t.Errorf("toggle event missing")
		}
	})

	t.Run("S15_click_menu", func(t *testing.T) {
		clickRe(t, `(Settings)[ ]`)
		evs := eventsOf(drain(ui), "main_menu", "select")
		if len(evs) == 0 {
			t.Fatalf("menu click sent no select event")
		}
		if !waitFor(func() bool { return ui.MainMenu.Selected() == 1 }) {
			t.Errorf("menu selection = %d", ui.MainMenu.Selected())
		}
	})

	t.Run("S15_click_tree", func(t *testing.T) {
		clickRe(t, `(Root 2)`)
		evs := eventsOf(drain(ui), "nav_tree", "select")
		if len(evs) == 0 {
			t.Fatalf("tree click sent no select event")
		}
		// clicking a branch expands/collapses it
		before := frame(sim)
		clickRe(t, `(Root)\s`)
		if !waitFor(func() bool { return frame(sim) != before }) {
			t.Errorf("clicking a branch did not change the tree")
		}
	})

	t.Run("S15_click_table_and_list", func(t *testing.T) {
		clickRe(t, `(Cell 4)`)
		if !waitFor(func() bool { _, ok := ui.t.app.GetFocus().(*tview.Table); return ok }) {
			t.Errorf("table not focused")
		}
		clickRe(t, `(Item 3)`)
		if !waitFor(func() bool { return ui.Files.Selected() == 2 }) {
			t.Errorf("list selected = %d", ui.Files.Selected())
		}
		if len(eventsOf(drain(ui), "files", "select")) == 0 {
			t.Errorf("list click sent no select event")
		}
	})
}
