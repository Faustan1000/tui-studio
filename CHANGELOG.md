# Changelog

All notable changes to TUIStudio are documented here.

## [0.3.6] - 2026-02-22

### Added

- **Menu global style** — Style (plain / line / filled) is now a single setting for the whole Menu component, not per-item. All items share the same visual style.
- **Menu item colors for all styles** — Custom Normal and Selected text colors are now available for `plain` and `line` menu items, in addition to the existing background + text colors for `filled` items.
- **Table column insert & delete** — Each column header in the Table editor now shows a `+` button (insert column after) and a trash button (delete column).

### Fixed

- **Tabs active tab bottom line** — The active tab no longer shows the horizontal separator line bleeding through its open bottom gap.

---

## [0.3.5] - 2026-02-21

### Added

- **Menu editor overhaul** — Full content editing for Menu items: label, icon (with glyph picker), hotkey, separator, and per-item style (plain / line / filled). Filled items support custom Normal and Selected background + text colors in a collapsible accordion.
- **Custom canvas size** — New "Custom" option in the canvas size selector. Enter any columns × rows and click Apply.

### Changed

- **Modal moved to Layout group** — Modal is now listed under Layout in the component toolbar (Overlay group removed).
- **Menu selected item** — Replaced the numeric index input with a dropdown showing item labels.
- **Color labels** — Menu item color pickers use compact combined labels ("Normal · Background", "Normal · Text", etc.).

### Fixed

- **Number inputs** — Inputs no longer snap to `0` when cleared mid-edit. A new `NumericInput` component holds local string state while focused and only commits on blur.
- **Breadcrumb height** — Default height is now 1 row instead of 3.

### Removed

- **Popover and Tooltip components** — Removed; not applicable to terminal UIs.
- **Drop Shadow option** — Removed from all components (had no effect in terminal rendering).

---

## [0.3.4] - 2026-02-21

### Changed

- **macOS DMG installer** — Installer now uses `create-dmg` for a styled disk image with background art and proper icon layout.

---

## [0.3.0] - 2026-02-20

### Added

- **Multi-select** — Shift-click components in the Layers panel or on the Canvas to build a multi-selection for batch operations.
- **Group into Box (multi-select)** — Shift-select sibling components, then right-click → "Group into Box" to wrap all selected items into a single Box container.
- **Ungroup** — Right-click any Box with children → "Ungroup" promotes all children to the parent level and removes the container. Works on multiple selected groups at once.
- **Escape to deselect** — Press Esc to clear the current selection.

### Removed

- **"Add to Box"** context menu item (was a duplicate of "Group into Box").
- **Landing page** — removed from the desktop app (not relevant in a native context).

## [0.2.0] - 2026-02-19

### Added

- **Gradient backgrounds** — Background color picker now includes a Gradient tab with angle control (0–360°) and N color stops (add, remove, reposition). Gradients are rendered as discrete character-cell bands in the editor, matching exact terminal ANSI output.
- **ANSI gradient export** — Exported ANSI output uses per-column true-color (`\x1b[48;2;r;g;b]`) background codes so the gradient renders correctly in any true-color terminal.

## [0.1.0] - 2026-02-11

### Added

- **Visual Canvas** — Drag-and-drop components with live ANSI preview at configurable zoom levels.
- **20+ TUI Components** — Screen, Box, Button, TextInput, Checkbox, Radio, Select, Toggle, Text, Spinner, ProgressBar, Table, List, Tree, Menu, Tabs, Breadcrumb, Modal, Popover, Tooltip, Spacer.
- **Layout Engine** — Absolute, Flexbox, and Grid layout modes with full property control.
- **Color Themes** — Dracula, Nord, Solarized Dark/Light, Monokai, Gruvbox, Tokyo Night, Nightfox, Sonokai — all updating the canvas in real-time.
- **Dark / Light Mode** — Toggle between dark and light editor UI; persists across sessions.
- **Layers Panel** — Hierarchical component tree with drag-to-reorder, visibility toggle, lock, and inline rename.
- **Property Panel** — Edit layout, style, and component-specific props for the selected component.
- **Undo / Redo** — Full history for all tree mutations.
- **Save / Load** — `.tui` JSON format via native OS file picker (Chrome/Edge) or browser download (Firefox/Safari).
- **Multi-Framework Export** — Generate code for Ink, BubbleTea, Blessed, Textual, OpenTUI, Tview.
- **Command Palette** — `Cmd/Ctrl+P` for quick component creation, theme switching, and dark/light mode toggle.
- **Settings** — Accent color presets, dark/light mode toggle, and default download folder.
- **Landing Page** — Marketing page with feature carousel.
