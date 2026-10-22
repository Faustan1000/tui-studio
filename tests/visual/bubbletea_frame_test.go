// Dumps the View() of the generated Bubble Tea program at 100x40 to $TUISTUDIO_FRAME_OUT.
// Copied next to the generated project by tests/visual.bubbletea.test.ts.

package main

import (
	"io"
	"os"
	"regexp"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"
)

var ansiRe = regexp.MustCompile(`\[[0-9;]*m`)

func TestDumpFrame(t *testing.T) {
	lipgloss.SetColorProfile(termenv.ANSI)
	ui := NewUi(tea.WithInput(nil), tea.WithOutput(io.Discard), tea.WithoutRenderer())
	if err := ui.Start(); err != nil {
		t.Fatal(err)
	}
	ui.Send(tea.WindowSizeMsg{Width: 100, Height: 40})
	frame := ui.Frame()
	frame = ansiRe.ReplaceAllString(frame, "")
	if err := os.WriteFile(os.Getenv("TUISTUDIO_FRAME_OUT"), []byte(frame), 0o644); err != nil {
		t.Fatal(err)
	}
}
