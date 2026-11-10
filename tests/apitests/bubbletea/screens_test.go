// Several screens: the first one is shown at start, ui.<Screen>.Show() switches, buttons that
// open a screen switch too, and the OnShow handlers run. Copied next to the generated
// multiScreen design (screens home, settings and one without a code name).

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

var screensAnsi = regexp.MustCompile(`\x1b\[[0-9;]*m`)

func TestScreens(t *testing.T) {
	lipgloss.SetColorProfile(termenv.ANSI)
	ui := NewUi(tea.WithInput(nil), tea.WithOutput(io.Discard), tea.WithoutRenderer())
	var shown atomic.Int32
	ui.Settings.OnShow(func(e Event) {
		if e.Tag == "settings" && e.Name == "show" {
			shown.Add(1)
		}
	})
	if err := ui.Start(); err != nil {
		t.Fatal(err)
	}
	frame := func() string { return screensAnsi.ReplaceAllString(ui.Frame(), "") }
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
	click := func(f, label string) {
		t.Helper()
		for y, l := range strings.Split(f, "\n") {
			if i := strings.Index(l, label); i >= 0 {
				ui.Send(tea.MouseMsg{X: lipgloss.Width(l[:i]), Y: y, Action: tea.MouseActionPress, Button: tea.MouseButtonLeft})
				return
			}
		}
		t.Fatalf("%q is not on the screen:\n%s", label, f)
	}

	// the first screen is shown at start
	f := frame()
	if !has(f, "Ready") || has(f, "Settings screen") || has(f, "About") {
		t.Fatalf("start screen:\n%s", f)
	}
	if !ui.Home.IsActive() || ui.Settings.IsActive() || ui.Screen() != "home" {
		t.Fatalf("active screen at start: %q", ui.Screen())
	}

	// Show() switches; the other screen is not drawn any more
	ui.Settings.Show()
	f = wait("settings screen", func(f string) bool { return has(f, "Settings screen") })
	if has(f, "Ready") || has(f, "Dashboard content") {
		t.Fatalf("the home screen is still drawn:\n%s", f)
	}
	if !ui.Settings.IsActive() || ui.Home.IsActive() {
		t.Fatal("IsActive after Show")
	}
	limit := time.Now().Add(2 * time.Second)
	for shown.Load() == 0 && time.Now().Before(limit) {
		time.Sleep(10 * time.Millisecond)
	}
	if shown.Load() != 1 {
		t.Fatalf("OnShow ran %d times", shown.Load())
	}
	ui.Settings.Show() // already shown: nothing happens
	time.Sleep(50 * time.Millisecond)
	if shown.Load() != 1 {
		t.Fatalf("OnShow ran again for the screen that was shown: %d", shown.Load())
	}

	// the focus moved to the first component of the new screen: typing writes to the store
	key := func(k tea.KeyType) { ui.Send(tea.KeyMsg{Type: k}) }
	ui.Send(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("Ada")})
	wait("typed text", func(string) bool { return ui.NameInput.Value() == "Ada" })

	// the Back button opens the home screen
	click(f, "Back")
	f = wait("home screen again", func(f string) bool { return has(f, "Ready") })
	if has(f, "Settings screen") || !ui.Home.IsActive() {
		t.Fatalf("after Back:\n%s", f)
	}

	// and a button of the home screen opens the settings screen
	click(f, "Settings")
	wait("settings screen through the button", func(f string) bool { return has(f, "Settings screen") })
	if shown.Load() != 2 {
		t.Fatalf("OnShow after the second visit: %d", shown.Load())
	}

	// the keyboard does the same: Tab to Back, Enter
	key(tea.KeyTab)
	key(tea.KeyEnter)
	wait("home screen through the keyboard", func(f string) bool { return has(f, "Ready") })
}
