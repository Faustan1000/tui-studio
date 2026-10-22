// The program API scenario (docs/API_SCENARIO.md, S1..S14) against the real tview UI of the
// apiDesign project, headless on a tcell simulation screen. This file is copied next to the
// generated project by tests/api.tview.test.ts and run with `go test`.

package main

import (
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gdamore/tcell/v2"
)

func TestScenario(t *testing.T) {
	sim := tcell.NewSimulationScreen("UTF-8")
	testScreen = sim
	ui := NewUi()

	// S1
	t.Run("S1_start", func(t *testing.T) {
		if err := ui.Start(); err != nil {
			t.Fatal(err)
		}
		if !ui.Ready() || !ui.Running() {
			t.Fatalf("ready=%v running=%v", ui.Ready(), ui.Running())
		}
		sim.SetSize(100, 90)
		ui.Log.Debug("resized") // any write redraws
		if !waitFor(shows(sim, "Inside the panel")) {
			t.Fatalf("the first frame never showed the design:\n%s", frame(sim))
		}
	})

	// S2
	t.Run("S2_initial_values", func(t *testing.T) {
		if ui.Status.Text() != "Ready" {
			t.Errorf("status = %q", ui.Status.Text())
		}
		if ui.Progress.Max() != 100 || ui.Progress.Value() != 0 {
			t.Errorf("progress = %v/%v", ui.Progress.Value(), ui.Progress.Max())
		}
		for name, st := range map[string]State{
			"name_input": ui.NameInput.State(), "submit_btn": ui.SubmitBtn.State(), "agree": ui.Agree.State(),
			"panel": ui.Panel.State(), "pages": ui.Pages.State(),
		} {
			if st != StateActive {
				t.Errorf("%s state = %s", name, st)
			}
		}
		if ui.Color.Options()[0] != "Red" || ui.Agree.Checked() || ui.Agree.Label() != "I agree" {
			t.Errorf("select/checkbox values wrong")
		}
		if !strings.Contains(frame(sim), "Send") || !strings.Contains(frame(sim), "Inside the panel") {
			t.Errorf("design not drawn:\n%s", frame(sim))
		}
	})

	// S3: writes from another goroutine are visible at once and in the next frame
	t.Run("S3_write_from_goroutine", func(t *testing.T) {
		var wg sync.WaitGroup
		wg.Add(1)
		go func() {
			defer wg.Done()
			ui.Status.SetText("Working")
			ui.Progress.SetValue(42)
			ui.NameInput.SetValue("Ada")
			if ui.Status.Text() != "Working" || ui.Progress.Value() != 42 || ui.NameInput.Value() != "Ada" {
				t.Errorf("read after write returned old values")
			}
		}()
		wg.Wait()
		for _, want := range []string{"Working", "42%", "Ada"} {
			if !waitFor(shows(sim, want)) {
				t.Errorf("frame does not show %q:\n%s", want, frame(sim))
			}
		}
	})

	var clicks []Event
	var mu sync.Mutex
	ui.SubmitBtn.OnClick(func(e Event) {
		mu.Lock()
		clicks = append(clicks, e)
		mu.Unlock()
	})
	clickCount := func() int { mu.Lock(); defer mu.Unlock(); return len(clicks) }

	// S4: a muted button is still drawn (dimmed) but cannot be used
	t.Run("S4_mute", func(t *testing.T) {
		drain(ui)
		if err := ui.SubmitBtn.Mute(); err != nil {
			t.Fatal(err)
		}
		time.Sleep(200 * time.Millisecond)
		x, y, ok := find(sim, "Send")
		if !ok {
			t.Fatalf("a muted button must stay visible:\n%s", frame(sim))
		}
		cells, w, _ := sim.GetContents()
		fg, _, _ := cells[y*w+x].Style.Decompose()
		if fg != tcell.ColorGray {
			t.Errorf("muted button is not dimmed (fg %v)", fg)
		}
		click(sim, x+1, y)
		if tabbed := ui.t.app.GetFocus(); isButton(tabbed) {
			t.Errorf("a muted button must not take the focus")
		}
		if evs := drain(ui); len(evs) != 0 || clickCount() != 0 {
			t.Errorf("a muted button sent events: %v", evs)
		}
		if err := ui.SubmitBtn.Active(); err != nil {
			t.Fatal(err)
		}
	})

	// S5
	t.Run("S5_hide_show", func(t *testing.T) {
		if err := ui.Panel.Hide(); err != nil {
			t.Fatal(err)
		}
		if !waitFor(hides(sim, "Inside the panel")) {
			t.Fatalf("hidden panel still drawn:\n%s", frame(sim))
		}
		if err := ui.Panel.Show(); err != nil {
			t.Fatal(err)
		}
		if !waitFor(shows(sim, "Inside the panel")) {
			t.Fatalf("panel did not come back:\n%s", frame(sim))
		}
	})

	// S6
	t.Run("S6_readonly_input", func(t *testing.T) {
		tabTo(t, ui, sim, isInput)
		drain(ui)
		if err := ui.NameInput.Readonly(); err != nil {
			t.Fatal(err)
		}
		time.Sleep(100 * time.Millisecond)
		typeRune(sim, 'x')
		if ui.NameInput.Value() != "Ada" {
			t.Errorf("readonly input changed to %q", ui.NameInput.Value())
		}
		if evs := drain(ui); len(evs) != 0 {
			t.Errorf("readonly input sent events: %v", evs)
		}
		if !strings.Contains(frame(sim), "Ada") || strings.Contains(frame(sim), "Adax") {
			t.Errorf("readonly input shows the typed key:\n%s", frame(sim))
		}
		if err := ui.NameInput.Active(); err != nil {
			t.Fatal(err)
		}
		time.Sleep(100 * time.Millisecond)
		typeRune(sim, 'x')
		if !waitFor(func() bool { return ui.NameInput.Value() == "Adax" }) {
			t.Errorf("active input did not accept typing: %q", ui.NameInput.Value())
		}
		drain(ui)
	})

	// S7
	t.Run("S7_unsupported_state", func(t *testing.T) {
		if err := ui.SubmitBtn.Readonly(); err == nil {
			t.Errorf("readonly on a button must be an error")
		}
		if ui.SubmitBtn.State() != StateActive {
			t.Errorf("state changed to %s", ui.SubmitBtn.State())
		}
	})

	// S8: events from the keyboard; handlers run on their own goroutine
	t.Run("S8_events", func(t *testing.T) {
		slow := make(chan struct{})
		ui.SubmitBtn.OnClick(func(e Event) {
			ui.Status.SetText("in handler")
			select {
			case <-slow:
			case <-time.After(2 * time.Second):
			}
		})
		tabTo(t, ui, sim, isButton)
		key(sim, tcell.KeyEnter)
		if !waitFor(shows(sim, "in handler")) {
			t.Errorf("the UI froze while a handler was running:\n%s", frame(sim))
		}
		close(slow)
		if !waitFor(func() bool { return clickCount() == 1 }) {
			t.Errorf("click handler not called")
		}
		mu.Lock()
		if len(clicks) == 1 && (clicks[0].Tag != "submit_btn" || clicks[0].Name != "click") {
			t.Errorf("event = %+v", clicks[0])
		}
		mu.Unlock()

		tabTo(t, ui, sim, isInput)
		typeRune(sim, 'z')
		tabTo(t, ui, sim, isCheckbox)
		key(sim, tcell.KeyEnter)
		evs := drain(ui)
		var sawClick, sawName, sawAgree bool
		for _, e := range evs {
			switch {
			case e.Tag == "submit_btn" && e.Name == "click":
				sawClick = true
			case e.Tag == "name_input" && e.Name == "change" && e.Value == "Adaxz":
				sawName = true
			case e.Tag == "agree" && e.Name == "change" && e.Value == true:
				sawAgree = true
			}
		}
		if !sawClick || !sawName || !sawAgree {
			t.Errorf("queue = %+v (click %v, name %v, agree %v)", evs, sawClick, sawName, sawAgree)
		}
		if !ui.Agree.Checked() || ui.NameInput.Value() != "Adaxz" {
			t.Errorf("values: agree=%v name=%q", ui.Agree.Checked(), ui.NameInput.Value())
		}
	})

	// S9: writing from the program is not a user event
	t.Run("S9_no_echo", func(t *testing.T) {
		drain(ui)
		ui.Agree.SetChecked(false)
		ui.Agree.SetChecked(true)
		ui.NameInput.SetValue("Grace")
		ui.Color.SetValue("Blue")
		if !waitFor(shows(sim, "Grace")) || !waitFor(shows(sim, "Blue")) {
			t.Errorf("writes not drawn:\n%s", frame(sim))
		}
		if evs := drain(ui); len(evs) != 0 {
			t.Errorf("writes from the program sent events: %+v", evs)
		}
		if ui.Color.Value() != "Blue" || !ui.Agree.Checked() {
			t.Errorf("values wrong")
		}
	})

	// S10
	t.Run("S10_report", func(t *testing.T) {
		ui.Report("boom")
		if !waitFor(shows(sim, "boom")) {
			t.Fatalf("no error dialog:\n%s", frame(sim))
		}
		if errs := ui.Errors(); len(errs) != 1 || errs[0].Message != "boom" {
			t.Errorf("errors = %+v", errs)
		}
		key(sim, tcell.KeyEscape)
		if !waitFor(hides(sim, "boom")) {
			t.Errorf("Esc did not close the dialog:\n%s", frame(sim))
		}
		ui.Report(errors.New("second"))
		if !waitFor(shows(sim, "second")) {
			t.Fatalf("no error dialog for an error value")
		}
		key(sim, tcell.KeyEnter)
		if !waitFor(hides(sim, "second")) {
			t.Errorf("Enter did not close the dialog:\n%s", frame(sim))
		}
		if len(ui.Errors()) != 2 {
			t.Errorf("errors = %d", len(ui.Errors()))
		}
	})

	// S11
	t.Run("S11_handler_panic", func(t *testing.T) {
		before := len(ui.Errors())
		ui.SubmitBtn.OnClick(func(e Event) { panic("handler exploded") })
		tabTo(t, ui, sim, isButton)
		key(sim, tcell.KeyEnter)
		if !waitFor(shows(sim, "handler exploded")) {
			t.Fatalf("panic in a handler not reported:\n%s", frame(sim))
		}
		if len(ui.Errors()) <= before {
			t.Errorf("error not recorded")
		}
		key(sim, tcell.KeyEscape)
		ui.Status.SetText("still alive")
		if !waitFor(shows(sim, "still alive")) {
			t.Errorf("the UI stopped working after a handler panicked:\n%s", frame(sim))
		}
	})

	// S12
	t.Run("S12_log", func(t *testing.T) {
		ui.Log.Info("hello log")
		time.Sleep(100 * time.Millisecond)
		if strings.Contains(frame(sim), "hello log") {
			t.Errorf("log panel must be hidden at first")
		}
		sim.InjectKey(tcell.KeyCtrlL, 0, tcell.ModCtrl)
		if !waitFor(shows(sim, "hello log")) {
			t.Fatalf("Ctrl+L did not show the log:\n%s", frame(sim))
		}
		sim.InjectKey(tcell.KeyCtrlL, 0, tcell.ModCtrl)
		if !waitFor(hides(sim, "hello log")) {
			t.Errorf("Ctrl+L did not hide the log")
		}
	})

	// S13
	t.Run("S13_modal", func(t *testing.T) {
		if ui.Confirm.IsOpen() || strings.Contains(frame(sim), "Really?") {
			t.Fatalf("the modal must start closed")
		}
		ui.Confirm.Open()
		if !waitFor(shows(sim, "Really?")) || !ui.Confirm.IsOpen() {
			t.Fatalf("modal not shown:\n%s", frame(sim))
		}
		if !strings.Contains(frame(sim), "Sure?") {
			t.Errorf("modal title missing")
		}
		ui.Confirm.Close()
		if !waitFor(hides(sim, "Really?")) {
			t.Errorf("modal not closed")
		}
		ui.Confirm.Open()
		waitFor(shows(sim, "Really?"))
		key(sim, tcell.KeyEscape)
		if !waitFor(hides(sim, "Really?")) || ui.Confirm.IsOpen() {
			t.Errorf("Esc did not close the modal (open=%v)", ui.Confirm.IsOpen())
		}
	})

	// S14
	t.Run("S14_stop", func(t *testing.T) {
		ui.Stop()
		if !ui.WaitTimeout(3 * time.Second) {
			t.Fatalf("Wait did not return")
		}
		ui.Status.SetText("after")
		ui.SubmitBtn.Mute()
		ui.Report("late")
		ui.Log.Info("late")
		if ui.Running() {
			t.Errorf("still running")
		}
	})
}
