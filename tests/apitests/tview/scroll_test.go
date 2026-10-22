// S17 (scrolling) and S18 (style) of the program API scenario for the apiDesign project, on a
// tcell simulation screen. Copied next to the generated project by tests/api.tview.test.ts.

package main

import (
	"strconv"
	"testing"
	"time"

	"github.com/gdamore/tcell/v2"
)

func wheel(sim tcell.SimulationScreen, x, y int, down bool) {
	button := tcell.WheelDown
	if !down {
		button = tcell.WheelUp
	}
	sim.InjectMouse(x, y, button, tcell.ModNone)
	sim.InjectMouse(x, y, tcell.ButtonNone, tcell.ModNone)
	time.Sleep(40 * time.Millisecond)
}

// scrollbar reports whether the scrollbar is drawn near the right edge.
func scrollbar(sim tcell.SimulationScreen) bool {
	cells, w, h := sim.GetContents()
	for y := 1; y < h-1; y++ {
		for x := w - 6; x < w-1; x++ {
			c := cells[y*w+x]
			if len(c.Runes) > 0 && (c.Runes[0] == '█' || c.Runes[0] == '░') {
				return true
			}
		}
	}
	return false
}

func isTabBar(p interface{}) bool { _, ok := p.(*tabBar); return ok }

func TestScroll(t *testing.T) {
	for _, size := range [][2]int{{80, 24}, {120, 30}} {
		w, h := size[0], size[1]
		ui, sim := startUi(t, w, h)
		t.Run("S17_scroll_"+strconv.Itoa(w), func(t *testing.T) {
			if !waitFor(shows(sim, "Ready")) {
				t.Fatalf("no first frame:\n%s", frame(sim))
			}
			if !waitFor(hides(sim, "Inside the panel")) {
				t.Fatalf("the whole design is visible, nothing to scroll:\n%s", frame(sim))
			}
			if !scrollbar(sim) {
				t.Errorf("no scrollbar although the design is taller than the screen")
			}
			// the mouse wheel scrolls the root: 3 rows per notch
			px, py := w-10, h/2
			notches := 0
			for ; notches < 60 && !strContains(frame(sim), "Inside the panel"); notches++ {
				wheel(sim, px, py, true)
			}
			if !waitFor(shows(sim, "Inside the panel")) {
				t.Fatalf("the wheel never reached the bottom (%d notches):\n%s", notches, frame(sim))
			}
			for i := 0; i < 80 && !strContains(frame(sim), "Ready"); i++ {
				wheel(sim, px, py, false)
			}
			if !waitFor(shows(sim, "Ready")) {
				t.Fatalf("wheel up did not return to the top:\n%s", frame(sim))
			}

			// keys scroll when no input has focus
			tabTo(t, ui, sim, isButton)
			key(sim, tcell.KeyEnd)
			if !waitFor(shows(sim, "Inside the panel")) {
				t.Errorf("End did not scroll to the bottom:\n%s", frame(sim))
			}
			key(sim, tcell.KeyHome)
			if !waitFor(shows(sim, "Ready")) {
				t.Errorf("Home did not scroll to the top")
			}
			for i := 0; i < 20 && !strContains(frame(sim), "Inside the panel"); i++ {
				key(sim, tcell.KeyPgDn)
			}
			if !waitFor(shows(sim, "Inside the panel")) {
				t.Errorf("PageDown never reached the bottom")
			}
			for i := 0; i < 20 && !strContains(frame(sim), "Ready"); i++ {
				key(sim, tcell.KeyPgUp)
			}
			if !waitFor(shows(sim, "Ready")) {
				t.Errorf("PageUp never reached the top")
			}

			// a click after scrolling hits the widget that is under the pointer
			key(sim, tcell.KeyEnd)
			waitFor(shows(sim, "QA Team"))
			drain(ui)
			clickText(t, sim, "QA Team")
			if !waitFor(func() bool { return ui.Pages.ActiveTab() == 2 }) {
				t.Errorf("a click on a scrolled widget missed (tab %d)", ui.Pages.ActiveTab())
			}

			// Tab brings the focused widget into view
			key(sim, tcell.KeyHome)
			waitFor(shows(sim, "Ready"))
			key(sim, tcell.KeyTab) // away from the tab bar, which was clicked above
			for i := 0; i < 12 && !isTabBar(ui.t.app.GetFocus()); i++ {
				key(sim, tcell.KeyTab)
			}
			if !waitFor(shows(sim, "Dashboard")) {
				t.Errorf("Tab did not scroll the tab bar into view:\n%s", frame(sim))
			}
		})
		ui.Stop()
		ui.WaitTimeout(2 * time.Second)
	}

	t.Run("S17_no_scrollbar_when_it_fits", func(t *testing.T) {
		ui, sim := startUi(t, 100, 90)
		defer ui.Stop()
		if !waitFor(shows(sim, "Inside the panel")) {
			t.Fatalf("the design does not fit 100x90:\n%s", frame(sim))
		}
		time.Sleep(100 * time.Millisecond)
		if scrollbar(sim) {
			t.Errorf("a scrollbar is drawn although everything fits")
		}
		wheel(sim, 90, 40, true)
		if !strContains(frame(sim), "Ready") {
			t.Errorf("the wheel scrolled a design that fits")
		}
	})
}

func strContains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

// S18: the widgets use the terminal's colours, not tview's blue theme.
func TestStyle(t *testing.T) {
	ui, sim := startUi(t, 100, 90)
	defer ui.Stop()
	if !waitFor(shows(sim, "Inside the panel")) {
		t.Fatalf("no first frame:\n%s", frame(sim))
	}
	time.Sleep(150 * time.Millisecond)
	cells, w, _ := sim.GetContents()
	for _, text := range []string{"your name", "Send", "I agree", "Red", "Item 1", "Cell 1", "Dashboard"} {
		x, y, ok := find(sim, text)
		if !ok {
			t.Errorf("%q not on the screen", text)
			continue
		}
		for dx := 0; dx < len([]rune(text))+3; dx++ {
			_, bg, _ := cells[y*w+x+dx].Style.Decompose()
			if bg == tcell.ColorBlue || bg == tcell.ColorGreen || bg == tcell.ColorNavy {
				t.Errorf("%q has the background %v (tview's default theme) at +%d", text, bg, dx)
				break
			}
		}
	}
}
