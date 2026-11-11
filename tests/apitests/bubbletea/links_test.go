// Links to screens: a tab, a menu item and a list item open a screen when the USER chooses them
// (key or click), not when the program does; a modal of another screen is never drawn.
// Copied next to the generated screenLinks design (home, settings, about).

package main

import (
	"io"
	"regexp"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"
)

var linksAnsi = regexp.MustCompile(`\x1b\[[0-9;]*m`)

func TestLinks(t *testing.T) {
	lipgloss.SetColorProfile(termenv.ANSI)
	ui := NewUi(tea.WithInput(nil), tea.WithOutput(io.Discard), tea.WithoutRenderer())
	if err := ui.Start(); err != nil {
		t.Fatal(err)
	}
	frame := func() string { return linksAnsi.ReplaceAllString(ui.Frame(), "") }
	wait := func(what string, cond func(f string) bool) string {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			if f := frame(); cond(f) {
				return f
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatalf("timed out: %s\n%s", what, frame())
		return ""
	}
	has := func(f, s string) bool { return strings.Contains(f, s) }
	click := func(label string) {
		t.Helper()
		f := frame()
		for y, l := range strings.Split(f, "\n") {
			if i := strings.Index(l, label); i >= 0 {
				ui.Send(tea.MouseMsg{X: lipgloss.Width(l[:i]), Y: y, Action: tea.MouseActionPress, Button: tea.MouseButtonLeft})
				return
			}
		}
		t.Fatalf("%q is not on the screen:\n%s", label, f)
	}
	key := func(k tea.KeyType) { ui.Send(tea.KeyMsg{Type: k}) }
	home := func() {
		t.Helper()
		ui.Home.Show()
		wait("home screen", func(f string) bool { return has(f, "Home screen") })
	}

	wait("home screen at start", func(f string) bool { return has(f, "Home screen") })

	// the program selecting a tab does not follow the link
	ui.NavTabs.SetActiveTab(1)
	time.Sleep(100 * time.Millisecond)
	if f := frame(); !has(f, "Home screen") || has(f, "Settings screen") {
		t.Fatalf("SetActiveTab switched the screen:\n%s", f)
	}
	ui.NavTabs.SetActiveTab(0)

	// the user: Right arrow on the focused tabs
	key(tea.KeyRight)
	f := wait("settings through the tab key", func(f string) bool { return has(f, "Settings screen") })
	if has(f, "Home screen") {
		t.Fatalf("home still drawn:\n%s", f)
	}
	click("Back")
	wait("home through Back", func(f string) bool { return has(f, "Home screen") })

	// a click on the tab
	ui.NavTabs.SetActiveTab(0)
	time.Sleep(50 * time.Millisecond)
	click("Prefs")
	wait("settings through the tab click", func(f string) bool { return has(f, "Settings screen") })
	click("Back")
	wait("home again", func(f string) bool { return has(f, "Home screen") })

	// the menu item: click, then keyboard
	click("Open about")
	wait("about through the menu click", func(f string) bool { return has(f, "About screen") })
	click("Home")
	wait("home after about", func(f string) bool { return has(f, "Home screen") })
	key(tea.KeyTab)
	key(tea.KeyEnter)
	wait("about through the menu key", func(f string) bool { return has(f, "About screen") })
	home()

	// the list item
	click("Go settings")
	wait("settings through the list click", func(f string) bool { return has(f, "Settings screen") })
	click("Back")
	wait("home after the list", func(f string) bool { return has(f, "Home screen") })

	// a modal of a screen that is not shown is not drawn
	ui.Confirm.Open()
	time.Sleep(100 * time.Millisecond)
	if f := frame(); has(f, "Modal body") || !has(f, "Home screen") {
		t.Fatalf("modal of another screen:\n%s", f)
	}
	ui.Confirm.Close()
	ui.Settings.Show()
	wait("settings screen", func(f string) bool { return has(f, "Settings screen") })
	ui.Confirm.Open()
	wait("modal on its own screen", func(f string) bool { return has(f, "Modal body") })
}
