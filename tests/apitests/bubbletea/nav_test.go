// Tab and menu bodies switch at run time: only the body of the selected item is drawn, also when
// the selection is set through the program API. Copied next to the generated multiScreen design.

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

var navAnsi = regexp.MustCompile(`\x1b\[[0-9;]*m`)

func TestNavBodies(t *testing.T) {
	lipgloss.SetColorProfile(termenv.ANSI)
	ui := NewUi(tea.WithInput(nil), tea.WithOutput(io.Discard), tea.WithoutRenderer())
	if err := ui.Start(); err != nil {
		t.Fatal(err)
	}
	frame := func() string { return navAnsi.ReplaceAllString(ui.Frame(), "") }
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

	f := frame()
	if !has(f, "Dashboard content") || has(f, "Agent content") || !has(f, "Menu one body") {
		t.Fatalf("first tab:\n%s", f)
	}
	ui.Pages.SetActiveTab(1)
	f = wait("second tab body", func(f string) bool { return has(f, "Agent content") })
	if has(f, "Dashboard content") || !has(f, "Run") {
		t.Fatalf("second tab:\n%s", f)
	}
	// the button of the new body is drawn where it can be clicked
	for y, l := range strings.Split(f, "\n") {
		if i := strings.Index(l, "Run"); i >= 0 {
			ui.Send(tea.MouseMsg{X: lipgloss.Width(l[:i]), Y: y, Action: tea.MouseActionPress, Button: tea.MouseButtonLeft})
			break
		}
	}
	if ev, ok := ui.NextEvent(2 * time.Second); !ok || ev.Tag != "agent_btn" {
		t.Fatalf("click on the button of the second body: %+v %v", ev, ok)
	}
	ui.Pages.SetActiveTab(0)
	f = wait("first tab body again", func(f string) bool { return has(f, "Dashboard content") })
	if has(f, "Agent content") {
		t.Fatal("the body of the other tab is still drawn")
	}
}
