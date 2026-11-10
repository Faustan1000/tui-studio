// Several screens: only the current one is shown, ui.<Screen>.Show() and the links of buttons
// switch, OnShow callbacks run, open dialogs close, hidden screens take no focus.
// Copied next to the generated multiScreen design by tests/api.tview.test.ts.

package main

import (
	"strings"
	"testing"
	"time"

	"github.com/gdamore/tcell/v2"
)

func TestScreens(t *testing.T) {
	sim := tcell.NewSimulationScreen("UTF-8")
	testScreen = sim
	ui := NewUi()
	shown := make(chan string, 4)
	ui.Settings.OnShow(func(Event) { shown <- "settings" })
	if err := ui.Start(); err != nil {
		t.Fatal(err)
	}
	sim.SetSize(100, 40)
	ui.Log.Debug("resized")
	if !waitFor(shows(sim, "Ready")) {
		t.Fatalf("first screen:\n%s", frame(sim))
	}
	if strings.Contains(frame(sim), "Settings screen") || !ui.Home.IsActive() || ui.Settings.IsActive() {
		t.Fatalf("only the first screen is shown:\n%s", frame(sim))
	}

	ui.Settings.Show()
	if !waitFor(shows(sim, "Settings screen")) || !waitFor(hides(sim, "Ready")) {
		t.Fatalf("after Show():\n%s", frame(sim))
	}
	if !ui.Settings.IsActive() || ui.Home.IsActive() {
		t.Fatal("IsActive does not follow the switch")
	}
	select {
	case <-shown:
	case <-time.After(2 * time.Second):
		t.Fatal("the OnShow callback did not run")
	}
	// the focus is on a control of the new screen, not on one of the hidden screen
	if !waitFor(func() bool { return isInput(ui.t.app.GetFocus()) }) {
		t.Fatalf("focus after the switch: %T", ui.t.app.GetFocus())
	}
	// the screen is live: its input writes to the store, Tab stays on the screen
	typeRune(sim, 'x')
	if ui.NameInput.Value() != "x" {
		t.Fatalf("typed value: %q", ui.NameInput.Value())
	}
	key(sim, tcell.KeyTab)
	if !isButton(ui.t.app.GetFocus()) {
		t.Fatalf("Tab should reach the Back button, focus: %T", ui.t.app.GetFocus())
	}
	key(sim, tcell.KeyTab)
	if !isInput(ui.t.app.GetFocus()) {
		t.Fatalf("Tab should wrap around on this screen, focus: %T", ui.t.app.GetFocus())
	}

	// the link of a button
	drain(ui)
	clickText(t, sim, "Back")
	if !waitFor(shows(sim, "Ready")) || !waitFor(hides(sim, "Settings screen")) {
		t.Fatalf("after the Back button:\n%s", frame(sim))
	}
	if !ui.Home.IsActive() {
		t.Fatal("Home is not active after Back")
	}
	// the link is a button without an event handler: a click on a button of the first screen
	// still reports its event
	if evs := drain(ui); len(eventsOf(evs, "back_btn", "click")) != 1 {
		t.Fatalf("click event of the link button: %+v", evs)
	}
	clickText(t, sim, "Settings")
	if !waitFor(shows(sim, "Settings screen")) {
		t.Fatalf("after the Settings button:\n%s", frame(sim))
	}

	// a screen without a code name is reached by its key
	ui.ShowScreen("about_us")
	if !waitFor(shows(sim, "About")) || !waitFor(hides(sim, "Settings screen")) {
		t.Fatalf("third screen:\n%s", frame(sim))
	}
	// the program keeps writing to components of screens that are not shown
	ui.NameInput.SetValue("kept")
	ui.Settings.Show()
	if !waitFor(shows(sim, "kept")) {
		t.Fatalf("value written while the screen was hidden:\n%s", frame(sim))
	}
}
