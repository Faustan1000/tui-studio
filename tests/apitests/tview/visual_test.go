// Visual parity: writes the frame of the design at 100x40 cells to $TUISTUDIO_FRAME_OUT
// (tests/visual.tview.test.ts diffs it against the Textual reference).

package main

import (
	"os"
	"strings"
	"testing"
)

func TestVisualFrame(t *testing.T) {
	out := os.Getenv("TUISTUDIO_FRAME_OUT")
	if out == "" {
		t.Skip("TUISTUDIO_FRAME_OUT not set")
	}
	_, sim := startUi(t, 100, 40)
	if !waitFor(shows(sim, "Ready")) {
		t.Fatalf("no first frame:\n%s", frame(sim))
	}
	lines := strings.Split(strings.TrimRight(frame(sim), "\n"), "\n")
	if err := os.WriteFile(out, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}
