// Links to screens: a tab, a menu item and a list item open a screen when the user chooses them,
// a program-side SetActiveTab does not, and a modal of a screen that is not shown stays hidden.
// Copied next to the generated screenLinks design by tests/api.tview.test.ts.

package main

import (
	"strings"
	"testing"

	"github.com/gdamore/tcell/v2"
	"github.com/rivo/tview"
)

func isTabBar(p tview.Primitive) bool { _, ok := p.(*tabBar); return ok }

func startLinks(t *testing.T) (*Ui, tcell.SimulationScreen) {
	t.Helper()
	ui, sim := startUi(t, 100, 40)
	if !waitFor(shows(sim, "Home screen")) {
		t.Fatalf("first screen:\n%s", frame(sim))
	}
	return ui, sim
}

func backHome(t *testing.T, sim tcell.SimulationScreen, button, from string) {
	t.Helper()
	clickText(t, sim, button)
	if !waitFor(shows(sim, "Home screen")) || !waitFor(hides(sim, from)) {
		t.Fatalf("back to Home:\n%s", frame(sim))
	}
}

// focusList presses Tab until the list whose first item contains text has the focus.
func focusList(t *testing.T, ui *Ui, sim tcell.SimulationScreen, text string) {
	t.Helper()
	for i := 0; i < 8; i++ {
		if l, ok := ui.t.app.GetFocus().(*tview.List); ok {
			if txt, _ := l.GetItemText(0); strings.Contains(txt, text) {
				return
			}
		}
		key(sim, tcell.KeyTab)
	}
	t.Fatalf("could not focus the list with %q (focus: %T)", text, ui.t.app.GetFocus())
}

func TestTabLinkKey(t *testing.T) {
	ui, sim := startLinks(t)
	tabTo(t, ui, sim, isTabBar)
	key(sim, tcell.KeyRight)
	if !waitFor(shows(sim, "Settings screen")) || !waitFor(hides(sim, "Home screen")) {
		t.Fatalf("Right on the tab bar:\n%s", frame(sim))
	}
	if !ui.Settings.IsActive() {
		t.Fatal("Settings is not active")
	}
	backHome(t, sim, "Back", "Settings screen")
}

func TestTabLinkClick(t *testing.T) {
	_, sim := startLinks(t)
	clickText(t, sim, "Prefs")
	if !waitFor(shows(sim, "Settings screen")) || !waitFor(hides(sim, "Home screen")) {
		t.Fatalf("click on the tab:\n%s", frame(sim))
	}
	backHome(t, sim, "Back", "Settings screen")
}

func TestTabProgramDoesNotSwitch(t *testing.T) {
	ui, sim := startLinks(t)
	ui.NavTabs.SetActiveTab(1)
	if !waitFor(func() bool { return ui.NavTabs.ActiveTab() == 1 }) {
		t.Fatal("the tab was not selected")
	}
	waitFor(shows(sim, "Settings screen")) // gives a wrong switch time to happen
	if strings.Contains(frame(sim), "Settings screen") || !ui.Home.IsActive() {
		t.Fatalf("SetActiveTab switched the screen:\n%s", frame(sim))
	}
}

func TestMenuLink(t *testing.T) {
	ui, sim := startLinks(t)
	focusList(t, ui, sim, "Open about")
	key(sim, tcell.KeyEnter)
	if !waitFor(shows(sim, "About screen")) || !waitFor(hides(sim, "Home screen")) {
		t.Fatalf("Enter on the menu item:\n%s", frame(sim))
	}
	backHome(t, sim, "Home", "About screen")
	clickText(t, sim, "Open about")
	if !waitFor(shows(sim, "About screen")) {
		t.Fatalf("click on the menu item:\n%s", frame(sim))
	}
}

func TestListLink(t *testing.T) {
	ui, sim := startLinks(t)
	focusList(t, ui, sim, "Go settings")
	key(sim, tcell.KeyEnter)
	if !waitFor(shows(sim, "Settings screen")) || !waitFor(hides(sim, "Home screen")) {
		t.Fatalf("Enter on the list item:\n%s", frame(sim))
	}
	backHome(t, sim, "Back", "Settings screen")
	clickText(t, sim, "Go settings")
	if !waitFor(shows(sim, "Settings screen")) {
		t.Fatalf("click on the list item:\n%s", frame(sim))
	}
}

func TestModalOfOtherScreen(t *testing.T) {
	ui, sim := startLinks(t)
	ui.Confirm.Open()
	waitFor(shows(sim, "Modal body")) // gives a wrong overlay time to appear
	if strings.Contains(frame(sim), "Modal body") || !strings.Contains(frame(sim), "Home screen") {
		t.Fatalf("the modal of another screen is drawn:\n%s", frame(sim))
	}
	ui.Confirm.Close()
	ui.Settings.Show()
	if !waitFor(shows(sim, "Settings screen")) {
		t.Fatalf("Show():\n%s", frame(sim))
	}
	if strings.Contains(frame(sim), "Modal body") {
		t.Fatalf("a closed modal is shown:\n%s", frame(sim))
	}
	ui.Confirm.Open()
	if !waitFor(shows(sim, "Modal body")) {
		t.Fatalf("Open() on the current screen:\n%s", frame(sim))
	}
}
