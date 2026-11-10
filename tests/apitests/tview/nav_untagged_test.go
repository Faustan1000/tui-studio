// Tabs without a code name: the selection lives in the UI itself, the bodies still switch.
// Copied next to the generated multiScreen design (tabs and menu untagged).

package main

import (
	"strings"
	"testing"

	"github.com/gdamore/tcell/v2"
)

func TestNavBodiesUntagged(t *testing.T) {
	sim := tcell.NewSimulationScreen("UTF-8")
	testScreen = sim
	ui := NewUi()
	if err := ui.Start(); err != nil {
		t.Fatal(err)
	}
	sim.SetSize(100, 40)
	ui.Log.Debug("resized")
	if !waitFor(shows(sim, "Dashboard content")) || strings.Contains(frame(sim), "Agent content") {
		t.Fatalf("first tab:\n%s", frame(sim))
	}
	clickText(t, sim, "Agent")
	if !waitFor(shows(sim, "Agent content")) || !waitFor(hides(sim, "Dashboard content")) {
		t.Fatalf("after the click:\n%s", frame(sim))
	}
	key(sim, tcell.KeyLeft)
	if !waitFor(shows(sim, "Dashboard content")) || !waitFor(hides(sim, "Agent content")) {
		t.Fatalf("after the key:\n%s", frame(sim))
	}
}
