// Helpers shared by the scenario tests (copied next to the generated project by
// tests/api.tview.test.ts).

package main

import (
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/gdamore/tcell/v2"
	"github.com/rivo/tview"
)

// frame is what the simulation screen shows right now, one line per row.
func frame(sim tcell.SimulationScreen) string {
	cells, w, h := sim.GetContents()
	var sb strings.Builder
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			c := cells[y*w+x]
			if len(c.Runes) > 0 && c.Runes[0] != 0 {
				sb.WriteRune(c.Runes[0])
			} else {
				sb.WriteByte(' ')
			}
		}
		sb.WriteByte('\n')
	}
	return sb.String()
}

func screenLines(sim tcell.SimulationScreen) []string {
	return strings.Split(frame(sim), string(rune(10)))
}

// find returns the position of the first occurrence of text on the screen.
func find(sim tcell.SimulationScreen, text string) (int, int, bool) {
	for y, line := range screenLines(sim) {
		if i := strings.Index(line, text); i >= 0 {
			return len([]rune(line[:i])), y, true
		}
	}
	return 0, 0, false
}

// findRe is find for a regular expression; the position is that of its first group.
func findRe(sim tcell.SimulationScreen, pattern string) (int, int, bool) {
	re := regexp.MustCompile(pattern)
	for y, line := range screenLines(sim) {
		if m := re.FindStringSubmatchIndex(line); m != nil {
			return len([]rune(line[:m[2]])), y, true
		}
	}
	return 0, 0, false
}

// clickText left-clicks on the first occurrence of text.
func clickText(t *testing.T, sim tcell.SimulationScreen, text string) {
	t.Helper()
	x, y, ok := find(sim, text)
	if !ok {
		t.Fatalf("%q is not on the screen: %s", text, frame(sim))
	}
	click(sim, x+len([]rune(text))/2, y)
}

func waitFor(cond func() bool) bool {
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return cond()
}

func shows(sim tcell.SimulationScreen, text string) func() bool {
	return func() bool { return strings.Contains(frame(sim), text) }
}

func hides(sim tcell.SimulationScreen, text string) func() bool {
	return func() bool { return !strings.Contains(frame(sim), text) }
}

func key(sim tcell.SimulationScreen, k tcell.Key) {
	sim.InjectKey(k, 0, tcell.ModNone)
	time.Sleep(60 * time.Millisecond)
}

func typeRune(sim tcell.SimulationScreen, r rune) {
	sim.InjectKey(tcell.KeyRune, r, tcell.ModNone)
	time.Sleep(60 * time.Millisecond)
}

func click(sim tcell.SimulationScreen, x, y int) {
	// two clicks within tview.DoubleClickInterval are a double click, which widgets ignore
	time.Sleep(tview.DoubleClickInterval + 30*time.Millisecond)
	sim.InjectMouse(x, y, tcell.Button1, tcell.ModNone)
	time.Sleep(30 * time.Millisecond)
	sim.InjectMouse(x, y, tcell.ButtonNone, tcell.ModNone)
	time.Sleep(60 * time.Millisecond)
}

// tabTo presses Tab until the focus is on a primitive for which match is true.
func tabTo(t *testing.T, ui *Ui, sim tcell.SimulationScreen, match func(tview.Primitive) bool) {
	t.Helper()
	for i := 0; i < 12; i++ {
		if match(ui.t.app.GetFocus()) {
			return
		}
		key(sim, tcell.KeyTab)
	}
	t.Fatalf("could not focus the control (focus: %T)", ui.t.app.GetFocus())
}

func isButton(p tview.Primitive) bool { _, ok := p.(*tview.Button); return ok }
func isInput(p tview.Primitive) bool {
	switch p.(type) {
	case *tview.InputField, *tview.TextArea:
		return true
	}
	return false
}
func isCheckbox(p tview.Primitive) bool { _, ok := p.(*tview.Checkbox); return ok }

func drain(ui *Ui) []Event {
	var out []Event
	for {
		ev, ok := ui.NextEvent(250 * time.Millisecond)
		if !ok {
			return out
		}
		out = append(out, ev)
	}
}

func startUi(t *testing.T, w, h int) (*Ui, tcell.SimulationScreen) {
	t.Helper()
	sim := tcell.NewSimulationScreen("UTF-8")
	testScreen = sim
	ui := NewUi()
	if err := ui.Start(); err != nil {
		t.Fatal(err)
	}
	sim.SetSize(w, h)
	ui.Log.Debug("resized") // any write redraws
	waitFor(func() bool { _, cw, ch := sim.GetContents(); return cw == w && ch == h })
	time.Sleep(200 * time.Millisecond)
	return ui, sim
}

func isTable(p tview.Primitive) bool { _, ok := p.(*tview.Table); return ok }

// events of one kind from the queue
func eventsOf(evs []Event, tag, name string) []Event {
	var out []Event
	for _, e := range evs {
		if e.Tag == tag && e.Name == name {
			out = append(out, e)
		}
	}
	return out
}
