// Tab and menu bodies switch at run time: only the body of the selected item is part of the UI,
// for tabs with a code name (selection from the store) and without (selection kept in the UI).
// Copied next to the generated multiScreen design by tests/api.tview.test.ts.

package main

import (
	"strings"
	"testing"

	"github.com/gdamore/tcell/v2"
)

func TestNavBodies(t *testing.T) {
	sim := tcell.NewSimulationScreen("UTF-8")
	testScreen = sim
	ui := NewUi()
	if err := ui.Start(); err != nil {
		t.Fatal(err)
	}
	sim.SetSize(100, 40)
	ui.Log.Debug("resized")
	if !waitFor(shows(sim, "Dashboard content")) {
		t.Fatalf("first body:\n%s", frame(sim))
	}
	if strings.Contains(frame(sim), "Agent content") || !strings.Contains(frame(sim), "Menu one body") {
		t.Fatalf("first tab:\n%s", frame(sim))
	}
	ui.Pages.SetActiveTab(1)
	if !waitFor(shows(sim, "Agent content")) || !waitFor(hides(sim, "Dashboard content")) {
		t.Fatalf("second tab:\n%s", frame(sim))
	}
	// the control of the new body is part of the focus order and can be clicked
	drain(ui)
	clickText(t, sim, "Run")
	evs := drain(ui)
	if len(eventsOf(evs, "agent_btn", "click")) != 1 {
		t.Fatalf("click on the button of the second body: %+v", evs)
	}
	// the user switches with the mouse: the body follows
	clickText(t, sim, "Dashboard")
	if !waitFor(shows(sim, "Dashboard content")) || !waitFor(hides(sim, "Agent content")) {
		t.Fatalf("after the click:\n%s", frame(sim))
	}
}
