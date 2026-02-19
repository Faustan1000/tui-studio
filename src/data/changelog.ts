export interface ChangelogChange {
  type: 'feature' | 'improvement' | 'fix';
  description: string;
}

export interface ChangelogRelease {
  version: string;
  date: string;
  changes: ChangelogChange[];
}

export const CHANGELOG: ChangelogRelease[] = [
  {
    version: '0.2.0',
    date: '2026-02-19',
    changes: [
      {
        type: 'feature',
        description:
          'Gradient backgrounds — Background picker now has a Gradient tab with angle control and N color stops (add, remove, reposition).',
      },
      {
        type: 'feature',
        description:
          'CLI-accurate gradient rendering — Editor displays gradients as discrete character-cell bands, matching exact ANSI true-color terminal output.',
      },
    ],
  },
  {
    version: '0.1.0',
    date: '2026-02-11',
    changes: [
      { type: 'feature', description: 'Visual canvas with drag-and-drop and live ANSI preview.' },
      { type: 'feature', description: '20+ TUI components: Screen, Box, Button, TextInput, Checkbox, Radio, Select, Toggle, Text, Spinner, ProgressBar, Table, List, Tree, Menu, Tabs, Breadcrumb, Modal, Popover, Tooltip, Spacer.' },
      { type: 'feature', description: 'Layout engine: Absolute, Flexbox, and Grid modes.' },
      { type: 'feature', description: '8 color themes (Dracula, Nord, Solarized, Monokai, Gruvbox, Tokyo Night, Nightfox, Sonokai) updating the canvas in real-time.' },
      { type: 'feature', description: 'Dark / Light mode toggle, persists across sessions.' },
      { type: 'feature', description: 'Layers panel with drag-to-reorder, visibility, lock, and inline rename.' },
      { type: 'feature', description: 'Property panel for layout, style, and component-specific props.' },
      { type: 'feature', description: 'Full undo / redo history.' },
      { type: 'feature', description: 'Save / Load .tui files via OS file picker or browser download.' },
      { type: 'feature', description: 'Multi-framework export: Ink, BubbleTea, Blessed, Textual, OpenTUI, Tview.' },
      { type: 'feature', description: 'Command Palette (Cmd/Ctrl+P) for quick component creation, theme switching, and mode toggle.' },
      { type: 'feature', description: 'Settings: accent color presets, dark/light toggle, default download folder.' },
    ],
  },
];
