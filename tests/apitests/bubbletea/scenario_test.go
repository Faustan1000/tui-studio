// The program-API scenario S1..S14 (docs/API_SCENARIO.md) against the real Bubble Tea program,
// run headless: no input, no output, no renderer. Keys are simulated with ui.Send and the
// frame is read with ui.Frame() (the model's View).
//
// This file is copied next to the generated project by tests/api.bubbletea.test.ts.

package main

import (
	"io"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"
)

var faint = regexp.MustCompile(`\x1b\[(?:[0-9]+;)*2(?:;[0-9]+)*m`)

var ansi = regexp.MustCompile("\x1b\\[[0-9;]*m")

func plain(s string) string { return ansi.ReplaceAllString(s, "") }

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out: %s\n%s", what, plain(lastFrame))
}

func key(ui *Ui, k tea.KeyType) { ui.Send(tea.KeyMsg{Type: k}) }

func typeText(ui *Ui, s string) {
	for _, r := range s {
		ui.Send(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
	}
}

func space(ui *Ui) { ui.Send(tea.KeyMsg{Type: tea.KeySpace, Runes: []rune{' '}}) }

// settle returns the frame after every message sent so far has been processed.
var lastFrame string

func settle(ui *Ui) string { lastFrame = ui.Frame(); return plain(lastFrame) }

func drain(ui *Ui) {
	for {
		if _, ok := ui.NextEvent(0); !ok {
			return
		}
	}
}

func noEvent(t *testing.T, ui *Ui, what string) {
	t.Helper()
	if ev, ok := ui.NextEvent(300 * time.Millisecond); ok {
		t.Fatalf("%s: unexpected event %+v", what, ev)
	}
}

var reverse = regexp.MustCompile(`\x1b\[(?:[0-9]+;)*7(?:;[0-9]+)*m`)

// posOf is the cell (column, line) where text is drawn in the current frame.
func posOf(t *testing.T, ui *Ui, text string) (int, int) {
	t.Helper()
	for y, l := range strings.Split(settle(ui), "\n") {
		if i := strings.Index(l, text); i >= 0 {
			return lipgloss.Width(l[:i]), y
		}
	}
	t.Fatalf("%q is not on screen:\n%s", text, plain(lastFrame))
	return 0, 0
}

func click(ui *Ui, x, y int) {
	ui.Send(tea.MouseMsg{X: x, Y: y, Action: tea.MouseActionPress, Button: tea.MouseButtonLeft})
}

// clickOn clicks on the cell where text is drawn (the position comes from the rendered View).
func clickOn(t *testing.T, ui *Ui, text string) {
	t.Helper()
	x, y := posOf(t, ui, text)
	click(ui, x, y)
}

func wantEvent(t *testing.T, ui *Ui, tag, name string, value any) {
	t.Helper()
	ev, ok := ui.NextEvent(2 * time.Second)
	if !ok || ev.Tag != tag || ev.Name != name || ev.Value != value {
		t.Fatalf("want %s.%s = %v, got %+v (%v)", tag, name, value, ev, ok)
	}
}

// checkFill: the frame is exactly w x h, framed by the border and top-left aligned.
func checkFill(t *testing.T, frame string, w, h int) {
	t.Helper()
	lines := strings.Split(frame, "\n")
	if len(lines) != h {
		t.Fatalf("%dx%d: %d lines\n%s", w, h, len(lines), frame)
	}
	for i, l := range lines {
		if lipgloss.Width(l) != w {
			t.Fatalf("%dx%d: line %d is %d wide: %q", w, h, i, lipgloss.Width(l), l)
		}
	}
	if lines[0] != "┌"+strings.Repeat("─", w-2)+"┐" {
		t.Fatalf("%dx%d: top border %q", w, h, lines[0])
	}
	if !strings.HasPrefix(lines[h-1], "└") || !strings.HasSuffix(lines[h-1], "┘") {
		t.Fatalf("%dx%d: bottom border %q", w, h, lines[h-1])
	}
}

func TestScenario(t *testing.T) {
	lipgloss.SetColorProfile(termenv.ANSI)
	ui := NewUi(tea.WithInput(nil), tea.WithOutput(io.Discard), tea.WithoutRenderer())

	t.Run("S01_start", func(t *testing.T) {
		if err := ui.Start(); err != nil {
			t.Fatal(err)
		}
		if !ui.Ready() || !ui.Running() {
			t.Fatalf("ready=%v running=%v", ui.Ready(), ui.Running())
		}
		if err := ui.Start(); err == nil {
			t.Fatal("a second Start must fail")
		}
	})

	t.Run("S02_initial_values", func(t *testing.T) {
		if ui.Status.Text() != "Ready" || ui.Progress.Max() != 100 || ui.Progress.Value() != 0 {
			t.Fatalf("status=%q max=%v", ui.Status.Text(), ui.Progress.Max())
		}
		if ui.NameInput.Placeholder() != "your name" || ui.NameInput.Value() != "" || ui.Agree.Checked() {
			t.Fatal("input/checkbox initial values")
		}
		if got := ui.Color.Options(); len(got) != 3 || got[0] != "Red" {
			t.Fatalf("options %v", got)
		}
		for _, h := range []interface{ State() State }{ui.Status, ui.NameInput, ui.SubmitBtn, ui.Panel, ui.Results} {
			if h.State() != StateActive {
				t.Fatalf("state %v", h.State())
			}
		}
		if ui.Confirm.IsOpen() {
			t.Fatal("the modal starts closed")
		}
		f := settle(ui)
		for _, want := range []string{"Ready", "Send", "I agree", "Red", "your name", "Column 1", "Cell 1", "Item 1", "Inside the panel"} {
			if !strings.Contains(f, want) {
				t.Fatalf("frame lacks %q:\n%s", want, f)
			}
		}
		if strings.Contains(f, "Really?") {
			t.Fatal("closed modal is drawn")
		}
	})

	t.Run("S03_writes_from_another_goroutine", func(t *testing.T) {
		done := make(chan string, 1)
		go func() {
			ui.Status.SetText("from goroutine")
			ui.Progress.SetValue(33)
			ui.NameInput.SetValue("typed")
			ui.Results.SetRows([][]string{{"added", "row"}})
			done <- ui.Status.Text() + "|" + ui.NameInput.Value()
		}()
		if got := <-done; got != "from goroutine|typed" {
			t.Fatalf("read after write: %q", got)
		}
		eventually(t, "frame shows the writes", func() bool {
			f := settle(ui)
			return strings.Contains(f, "from goroutine") && strings.Contains(f, "33%") &&
				strings.Contains(f, "typed") && strings.Contains(f, "added")
		})
		noEvent(t, ui, "writes must not echo")
	})

	t.Run("S04_mute", func(t *testing.T) {
		drain(ui)
		key(ui, tea.KeyTab) // focus: submit_btn
		settle(ui)
		if err := ui.SubmitBtn.Mute(); err != nil {
			t.Fatal(err)
		}
		f := ui.Frame()
		if !strings.Contains(plain(f), "Send") {
			t.Fatal("a muted button is still drawn")
		}
		if !faint.MatchString(f) {
			t.Fatalf("a muted button is dimmed (faint SGR missing): %q", f)
		}
		key(ui, tea.KeyEnter)
		settle(ui)
		noEvent(t, ui, "muted button")
		if err := ui.SubmitBtn.Active(); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("S05_hide_show", func(t *testing.T) {
		if err := ui.Panel.Hide(); err != nil {
			t.Fatal(err)
		}
		eventually(t, "panel hidden", func() bool { return !strings.Contains(settle(ui), "Inside the panel") })
		if err := ui.Panel.Show(); err != nil {
			t.Fatal(err)
		}
		eventually(t, "panel shown", func() bool { return strings.Contains(settle(ui), "Inside the panel") })
		// hiding takes no space: the elements below move up
		row := func(s string) int { return strings.Index(settle(ui), s) }
		before := row("I agree")
		ui.SubmitBtn.Hide()
		eventually(t, "the checkbox moved up", func() bool { return row("I agree") >= 0 && row("I agree") < before })
		ui.SubmitBtn.Show()
		eventually(t, "the checkbox is back", func() bool { return row("I agree") == before })
	})

	t.Run("S06_readonly_input", func(t *testing.T) {
		drain(ui)
		key(ui, tea.KeyShiftTab) // back to name_input
		if err := ui.NameInput.Readonly(); err != nil {
			t.Fatal(err)
		}
		typeText(ui, "x")
		settle(ui)
		if ui.NameInput.Value() != "typed" {
			t.Fatalf("readonly input changed: %q", ui.NameInput.Value())
		}
		noEvent(t, ui, "readonly input")
		ui.NameInput.Active()
		typeText(ui, "q") // q is text here, not quit
		settle(ui)
		if ui.NameInput.Value() != "typedq" || !ui.Running() {
			t.Fatalf("value %q running %v", ui.NameInput.Value(), ui.Running())
		}
		ev, ok := ui.NextEvent(2 * time.Second)
		if !ok || ev.Tag != "name_input" || ev.Name != "change" || ev.Value != "typedq" {
			t.Fatalf("event %+v %v", ev, ok)
		}
	})

	t.Run("S07_unsupported_state", func(t *testing.T) {
		if err := ui.SubmitBtn.Readonly(); err == nil {
			t.Fatal("readonly on a button must be an error")
		}
		if ui.SubmitBtn.State() != StateActive {
			t.Fatal("state changed")
		}
	})

	t.Run("S08_events_off_the_ui_goroutine", func(t *testing.T) {
		drain(ui)
		release := make(chan struct{})
		var got atomic.Value
		ui.SubmitBtn.OnClick(func(e Event) {
			<-release // a slow handler must not freeze the UI
			got.Store(e)
		})
		key(ui, tea.KeyTab) // submit_btn
		key(ui, tea.KeyEnter)
		ev, ok := ui.NextEvent(2 * time.Second)
		if !ok || ev.Tag != "submit_btn" || ev.Name != "click" {
			t.Fatalf("queue: %+v %v", ev, ok)
		}
		if f := settle(ui); !strings.Contains(f, "Send") { // the UI answers while the handler blocks
			t.Fatal("UI frozen by a handler")
		}
		ui.Status.SetText("still responsive")
		eventually(t, "UI updates during a blocked handler", func() bool { return strings.Contains(settle(ui), "still responsive") })
		close(release)
		eventually(t, "handler ran with the event", func() bool {
			e, ok := got.Load().(Event)
			return ok && e.Tag == "submit_btn" && e.Name == "click"
		})
		key(ui, tea.KeyTab) // agree
		space(ui)
		ev, ok = ui.NextEvent(2 * time.Second)
		if !ok || ev.Tag != "agree" || ev.Name != "change" || ev.Value != true {
			t.Fatalf("checkbox event %+v %v", ev, ok)
		}
		if !ui.Agree.Checked() {
			t.Fatal("checkbox not toggled")
		}
	})

	t.Run("S09_no_echo", func(t *testing.T) {
		drain(ui)
		ui.Agree.SetChecked(false)
		ui.Agree.SetChecked(true)
		noEvent(t, ui, "program writes")
	})

	t.Run("S10_report", func(t *testing.T) {
		ui.Report("boom")
		eventually(t, "dialog shows boom", func() bool { return strings.Contains(settle(ui), "boom") })
		if errs := ui.Errors(); len(errs) != 1 || errs[0].Message != "boom" {
			t.Fatalf("errors %+v", errs)
		}
		key(ui, tea.KeyEsc)
		eventually(t, "dialog closed", func() bool { return !strings.Contains(settle(ui), "boom") })
		ui.Report(io.ErrUnexpectedEOF)
		eventually(t, "error value reported", func() bool { return strings.Contains(settle(ui), "unexpected EOF") })
		key(ui, tea.KeyEnter)
		eventually(t, "closed with Enter", func() bool { return !strings.Contains(settle(ui), "unexpected EOF") })
	})

	t.Run("S11_handler_panics", func(t *testing.T) {
		var once atomic.Bool
		ui.Agree.OnChange(func(e Event) {
			if once.CompareAndSwap(false, true) {
				panic("handler exploded")
			}
		})
		space(ui) // agree has the focus
		eventually(t, "panic reported", func() bool {
			for _, e := range ui.Errors() {
				if strings.Contains(e.Message, "handler exploded") {
					return true
				}
			}
			return false
		})
		eventually(t, "dialog shows it", func() bool { return strings.Contains(settle(ui), "exploded") })
		key(ui, tea.KeyEsc)
		eventually(t, "dialog closed", func() bool { return !strings.Contains(settle(ui), "exploded") })
		if !ui.Running() {
			t.Fatal("UI stopped")
		}
		var caught atomic.Bool
		go ui.CatchPanics(func() { caught.Store(true); panic("own goroutine") })
		eventually(t, "CatchPanics reports", func() bool {
			for _, e := range ui.Errors() {
				if strings.Contains(e.Message, "own goroutine") {
					return caught.Load()
				}
			}
			return false
		})
		key(ui, tea.KeyEsc)
		settle(ui)
	})

	t.Run("S12_log_panel", func(t *testing.T) {
		ui.Log.Info("hello", 42)
		if strings.Contains(settle(ui), "hello 42") {
			t.Fatal("log panel must be hidden at first")
		}
		key(ui, tea.KeyCtrlL)
		eventually(t, "log panel shows hello", func() bool { return strings.Contains(settle(ui), "hello 42") })
		if !strings.Contains(settle(ui), "ERROR") { // errors are in the log, too
			t.Fatal("errors are not in the log")
		}
		key(ui, tea.KeyCtrlL)
		eventually(t, "log panel hidden", func() bool { return !strings.Contains(settle(ui), "hello 42") })
	})

	t.Run("S13_modal", func(t *testing.T) {
		ui.Confirm.Open()
		eventually(t, "modal shown", func() bool {
			f := settle(ui)
			return strings.Contains(f, "Sure?") && strings.Contains(f, "Really?")
		})
		if !ui.Confirm.IsOpen() {
			t.Fatal("IsOpen")
		}
		ui.Confirm.Close()
		eventually(t, "modal gone", func() bool { return !strings.Contains(settle(ui), "Really?") })
		ui.Confirm.Open()
		eventually(t, "modal reopened", func() bool { return strings.Contains(settle(ui), "Really?") })
		key(ui, tea.KeyEsc) // Esc closes it
		eventually(t, "Esc closes the modal", func() bool { return !strings.Contains(settle(ui), "Really?") && !ui.Confirm.IsOpen() })
	})

	t.Run("S15_mouse", func(t *testing.T) {
		drain(ui)
		ui.Agree.SetChecked(false)
		ui.Status.SetText("Ready")
		ui.NameInput.SetValue("")
		ui.Results.SetRows([][]string{{"a1", "b1"}, {"a2", "b2"}})

		// button: the same event as Enter in S08
		clickOn(t, ui, "Send")
		wantEvent(t, ui, "submit_btn", "click", nil)

		// checkbox: the same events as Space in S08
		clickOn(t, ui, "I agree")
		wantEvent(t, ui, "agree", "change", true)
		if !ui.Agree.Checked() {
			t.Fatal("checkbox not toggled by the click")
		}
		clickOn(t, ui, "I agree")
		wantEvent(t, ui, "agree", "change", false)

		// text input: the click focuses it, typing goes there
		clickOn(t, ui, "your name")
		typeText(ui, "z")
		wantEvent(t, ui, "name_input", "change", "z")

		// select cycles, list and tabs choose by position
		clickOn(t, ui, "Red") // opens the dropdown
		clickOn(t, ui, "Green")
		wantEvent(t, ui, "color", "change", "Green")
		clickOn(t, ui, "Item 2")
		wantEvent(t, ui, "files", "select", 1)
		if ui.Files.Selected() != 1 {
			t.Fatalf("list selection %d", ui.Files.Selected())
		}
		clickOn(t, ui, "Agent")
		wantEvent(t, ui, "pages", "change", 1)
		if ui.Pages.ActiveTab() != 1 {
			t.Fatalf("active tab %d", ui.Pages.ActiveTab())
		}
		clickOn(t, ui, "Dashboard")
		wantEvent(t, ui, "pages", "change", 0)

		// table: the clicked row gets the selection style
		clickOn(t, ui, "a2")
		eventually(t, "table row selected", func() bool {
			settle(ui)
			var a1, a2 bool
			for _, l := range strings.Split(lastFrame, "\n") {
				if strings.Contains(plain(l), "a1") {
					a1 = reverse.MatchString(l)
				}
				if strings.Contains(plain(l), "a2") {
					a2 = reverse.MatchString(l)
				}
			}
			return a2 && !a1
		})
		clickOn(t, ui, "a1")
		eventually(t, "table row selected again", func() bool {
			settle(ui)
			for _, l := range strings.Split(lastFrame, "\n") {
				if strings.Contains(plain(l), "a1") {
					return reverse.MatchString(l)
				}
			}
			return false
		})

		// muted and readonly components ignore clicks like keys
		ui.SubmitBtn.Mute()
		clickOn(t, ui, "Send")
		noEvent(t, ui, "click on a muted button")
		ui.SubmitBtn.Active()
		ui.NameInput.Readonly()
		clickOn(t, ui, "z")
		typeText(ui, "k")
		settle(ui)
		if ui.NameInput.Value() != "z" {
			t.Fatalf("readonly input changed: %q", ui.NameInput.Value())
		}
		ui.NameInput.Active()
		noEvent(t, ui, "readonly input")

		// the error dialog takes the clicks: widgets behind it stay quiet, a click on it closes it
		sx, sy := posOf(t, ui, "Send")
		ui.Report("dialog box")
		eventually(t, "dialog shown", func() bool { return strings.Contains(settle(ui), "dialog box") })
		click(ui, sx, sy)
		settle(ui)
		noEvent(t, ui, "click behind the dialog")
		if !strings.Contains(settle(ui), "dialog box") {
			t.Fatal("a click outside the dialog closed it")
		}
		clickOn(t, ui, "Enter / Esc")
		eventually(t, "dialog closed by a click", func() bool { return !strings.Contains(settle(ui), "dialog box") })

		// an open modal takes the clicks as well
		ui.Confirm.Open()
		eventually(t, "modal shown", func() bool { return strings.Contains(settle(ui), "Really?") })
		click(ui, sx, sy)
		settle(ui)
		noEvent(t, ui, "click behind the modal")
		ui.Confirm.Close()
		eventually(t, "modal closed", func() bool { return !strings.Contains(settle(ui), "Really?") })
		clickOn(t, ui, "Send")
		wantEvent(t, ui, "submit_btn", "click", nil)
	})

	t.Run("S16_fill", func(t *testing.T) {
		for _, size := range [][2]int{{80, 24}, {120, 40}, {60, 20}} {
			w, h := size[0], size[1]
			ui.Send(tea.WindowSizeMsg{Width: w, Height: h})
			checkFill(t, settle(ui), w, h)
			// with the log panel the frame still has the terminal size
			key(ui, tea.KeyCtrlL)
			checkFill(t, settle(ui), w, h)
			key(ui, tea.KeyCtrlL)
			settle(ui)
		}
		// the layout is anchored top-left and clicks work at any size
		ui.Send(tea.WindowSizeMsg{Width: 120, Height: 40})
		if first := strings.Split(settle(ui), "\n")[2]; !strings.HasPrefix(first, "│ Ready") {
			t.Fatalf("content is not top-left: %q", first)
		}
		clickOn(t, ui, "Send")
		wantEvent(t, ui, "submit_btn", "click", nil)
		clickOn(t, ui, "I agree")
		wantEvent(t, ui, "agree", "change", true)
	})

	t.Run("S17_scroll", func(t *testing.T) {
		wheel := func(x, y int, up bool) {
			b := tea.MouseButtonWheelDown
			if up {
				b = tea.MouseButtonWheelUp
			}
			ui.Send(tea.MouseMsg{X: x, Y: y, Action: tea.MouseActionPress, Button: b})
		}
		drain(ui)
		ui.Status.SetText("Ready")
		for _, size := range [][2]int{{80, 24}, {120, 30}} {
			w, h := size[0], size[1]
			ui.Send(tea.WindowSizeMsg{Width: w, Height: h})
			key(ui, tea.KeyHome)
			f := settle(ui)
			checkFill(t, f, w, h)
			if strings.Contains(f, "Inside the panel") {
				t.Fatalf("%dx%d: the design must be taller than the terminal", w, h)
			}
			if !strings.Contains(f, "▐") {
				t.Fatalf("%dx%d: no scrollbar although the content does not fit", w, h)
			}

			// the wheel scrolls the content by 3 rows per notch
			_, y0 := posOf(t, ui, "Send")
			wheel(10, 3, false)
			if _, y1 := posOf(t, ui, "Send"); y1 != y0-3 {
				t.Fatalf("%dx%d: one notch moved Send from row %d to %d", w, h, y0, y1)
			}
			for i := 0; i < 30; i++ {
				wheel(10, 3, false)
			}
			eventually(t, "the lower widgets are shown", func() bool { return strings.Contains(settle(ui), "Inside the panel") })
			checkFill(t, plain(lastFrame), w, h)
			if strings.Contains(settle(ui), "Ready") {
				t.Fatalf("%dx%d: the top is still shown", w, h)
			}
			for i := 0; i < 40; i++ {
				wheel(10, 3, true)
			}
			eventually(t, "the top is shown again", func() bool {
				f := settle(ui)
				return strings.Contains(f, "Ready") && !strings.Contains(f, "Inside the panel")
			})

			// PageDown / End / PageUp / Home
			key(ui, tea.KeyPgDown)
			if f := settle(ui); strings.Contains(f, "Ready") {
				t.Fatalf("%dx%d: PageDown did not scroll", w, h)
			}
			key(ui, tea.KeyEnd)
			eventually(t, "End shows the bottom", func() bool { return strings.Contains(settle(ui), "Inside the panel") })
			key(ui, tea.KeyPgUp)
			settle(ui)
			key(ui, tea.KeyHome)
			eventually(t, "Home shows the top", func() bool { return strings.Contains(settle(ui), "Ready") })

			// a click after scrolling hits the widget that is drawn there
			drain(ui)
			wheel(10, 3, false)
			clickOn(t, ui, "Send")
			wantEvent(t, ui, "submit_btn", "click", nil)
			key(ui, tea.KeyEnd)
			settle(ui)
			clickOn(t, ui, "Item 2")
			wantEvent(t, ui, "files", "select", 1)
			key(ui, tea.KeyHome)
			settle(ui)

			// Tab to a widget below the fold scrolls it into view
			clickOn(t, ui, "Send")
			wantEvent(t, ui, "submit_btn", "click", nil)
			if w == 80 && strings.Contains(settle(ui), "QA Team") {
				t.Fatal("the tabs must be below the fold at 80x24")
			}
			for i := 0; i < 5; i++ { // agree, color, results, files, pages
				key(ui, tea.KeyTab)
			}
			eventually(t, "Tab scrolled the tabs into view", func() bool { return strings.Contains(settle(ui), "QA Team") })
			for i := 0; i < 5; i++ {
				ui.Send(tea.KeyMsg{Type: tea.KeyShiftTab})
			}
			eventually(t, "Shift+Tab scrolled back to Send", func() bool { return strings.Contains(settle(ui), "Send") })
			key(ui, tea.KeyHome)
			settle(ui)
		}

		// no scrollbar when everything fits
		ui.Send(tea.WindowSizeMsg{Width: 120, Height: 90})
		f := settle(ui)
		checkFill(t, f, 120, 90)
		if strings.Contains(f, "▐") || !strings.Contains(f, "Inside the panel") {
			t.Fatal("a scrollbar although the content fits")
		}
		wheel(10, 3, false)
		if strings.Contains(settle(ui), "▐") {
			t.Fatal("the wheel scrolled content that fits")
		}
	})

	t.Run("S18_dropdown", func(t *testing.T) {
		ui.Send(tea.WindowSizeMsg{Width: 120, Height: 90})
		drain(ui)
		ui.Color.SetValue("Red")
		if f := settle(ui); strings.Contains(f, "Green") || !strings.Contains(f, "Red") || !strings.Contains(f, "▼") {
			t.Fatalf("a closed select shows its value and an arrow only:\n%s", f)
		}
		_, fy := posOf(t, ui, "Red")

		// a click opens the popup under the field; Esc closes it without a change
		clickOn(t, ui, "Red")
		eventually(t, "popup shown", func() bool {
			f := settle(ui)
			return strings.Contains(f, "Green") && strings.Contains(f, "Blue")
		})
		if _, gy := posOf(t, ui, "Green"); gy <= fy {
			t.Fatalf("the popup is not under the field (%d <= %d)", gy, fy)
		}
		key(ui, tea.KeyEsc)
		eventually(t, "popup closed by Esc", func() bool { return !strings.Contains(settle(ui), "Green") })
		noEvent(t, ui, "Esc")

		// Down + Enter choose
		clickOn(t, ui, "Red")
		eventually(t, "popup shown", func() bool { return strings.Contains(settle(ui), "Green") })
		key(ui, tea.KeyDown)
		key(ui, tea.KeyEnter)
		wantEvent(t, ui, "color", "change", "Green")
		eventually(t, "closed with the new value", func() bool {
			f := settle(ui)
			return strings.Contains(f, "Green") && !strings.Contains(f, "Blue")
		})
		if ui.Color.Value() != "Green" {
			t.Fatalf("value %q", ui.Color.Value())
		}

		// Space opens it, a click on a row chooses it
		space(ui)
		eventually(t, "popup shown by Space", func() bool { return strings.Contains(settle(ui), "Blue") })
		clickOn(t, ui, "Blue")
		wantEvent(t, ui, "color", "change", "Blue")
		if ui.Color.Value() != "Blue" {
			t.Fatalf("value %q", ui.Color.Value())
		}

		// choosing the current value is no change
		key(ui, tea.KeyEnter)
		eventually(t, "popup shown by Enter", func() bool { return strings.Contains(settle(ui), "Red") && strings.Contains(settle(ui), "Green") })
		key(ui, tea.KeyEnter)
		eventually(t, "popup closed", func() bool { return !strings.Contains(settle(ui), "Green") })
		noEvent(t, ui, "the same option")

		// a click outside closes it and does not reach the widget behind
		sx, sy := posOf(t, ui, "Send")
		key(ui, tea.KeyEnter)
		eventually(t, "popup shown", func() bool { return strings.Contains(settle(ui), "Green") })
		click(ui, sx, sy)
		eventually(t, "popup closed by a click outside", func() bool { return !strings.Contains(settle(ui), "Green") })
		noEvent(t, ui, "click outside the popup")
		if ui.Color.Value() != "Blue" {
			t.Fatalf("value %q", ui.Color.Value())
		}

		// muted and readonly selects do not open
		ui.Color.Mute()
		clickOn(t, ui, "Blue")
		settle(ui)
		if strings.Contains(settle(ui), "Green") {
			t.Fatal("a muted select opened")
		}
		ui.Color.Active()
	})

	t.Run("S14_stop", func(t *testing.T) {
		drain(ui)
		ui.Stop()
		if !ui.WaitTimeout(3 * time.Second) {
			t.Fatal("Wait did not return")
		}
		ui.Wait()
		if ui.Running() {
			t.Fatal("still running")
		}
		ui.Status.SetText("after close")
		ui.Report("after close")
		ui.SubmitBtn.Mute()
		ui.Send(tea.KeyMsg{Type: tea.KeyEnter})
		if ui.Frame() != "" {
			t.Fatal("frame of a closed UI")
		}
		if _, ok := ui.NextEvent(0); ok {
			t.Fatal("event after close")
		}
	})
}

// The canvas places styled blocks (borders, wide characters) at exact cells.
func TestCanvasPlacement(t *testing.T) {
	lipgloss.SetColorProfile(termenv.ANSI)
	block := lipgloss.NewStyle().Bold(true).Border(lipgloss.NormalBorder()).Render("日本")
	base := strings.Repeat(strings.Repeat(".", 10)+"\n", 4) + strings.Repeat(".", 10)
	raw := overlay(base, 2, 1, block)
	want := []string{
		"..........",
		"..┌────┐..",
		"..│日本│..",
		"..└────┘..",
		"..........",
	}
	if got := strings.Split(plain(raw), "\n"); strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("got\n%s", plain(raw))
	}
	if !strings.Contains(raw, "\x1b[1m") {
		t.Fatal("the style of the block was lost")
	}
	// clipped at the edges, never a panic
	_ = overlay(base, 8, 3, block)
	_ = overlay(base, -3, -1, block)
}
