// Save and open .tui files

import { useComponentStore } from '../stores/componentStore';
import { parseTuiFile, MAX_TUI_FILE_BYTES } from './tuiValidation';
import { useThemeStore, THEMES } from '../stores/themeStore';
import { useSelectionStore } from '../stores/selectionStore';

/** Build the JSON payload + suggested filename from current store state. */
export function buildTuiData(): { json: string; suggestedName: string } | null {
  const store = useComponentStore.getState();
  const screens = store.getScreenRoots();
  if (screens.length === 0) return null;
  const first = screens[0].root;
  const theme = useThemeStore.getState().currentTheme;
  const data = {
    version: '2',
    meta: {
      name: first.name,
      theme,
      activeScreen: store.activeScreenId,
      savedAt: new Date().toISOString(),
    },
    screens: screens.map((s) => ({ id: s.id, tree: s.root })),
  };
  return {
    json: JSON.stringify(data, null, 2),
    suggestedName: `${first.name.toLowerCase().replace(/\s+/g, '-')}.tui`,
  };
}

/**
 * Save a JSON payload to disk.
 * Must be called directly from a button click so showSaveFilePicker can get
 * the browser's user-activation token. Falls back to a plain download.
 */
export async function saveTuiData(json: string, filename: string): Promise<void> {
  if ('showSaveFilePicker' in window) {
    try {
      const fileHandle = await (window as any).showSaveFilePicker({
        suggestedName: filename,
        startIn: 'downloads',
        types: [{ description: 'TUI Studio File', accept: { 'application/json': ['.tui'] } }],
      });
      const writable = await fileHandle.createWritable();
      await writable.write(json);
      await writable.close();
      return;
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      // fall through to download on unexpected errors
    }
  }
  // Fallback: trigger browser download
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function openTuiFile(): Promise<void> {
  const load = (text: string) => {
    try {
      const { screens, activeId, theme } = parseTuiFile(text, Object.keys(THEMES));
      useComponentStore.getState().loadProject(
        screens.map((s) => ({ id: s.id, root: s.tree })),
        activeId
      );
      if (theme)
        useThemeStore
          .getState()
          .setTheme(theme as Parameters<ReturnType<typeof useThemeStore.getState>['setTheme']>[0]);
      useSelectionStore.getState().clearSelection();
    } catch (err) {
      alert(`Invalid .tui file: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
  };

  if ('showOpenFilePicker' in window) {
    try {
      const [fileHandle] = await (window as any).showOpenFilePicker({
        types: [{ description: 'TUI Studio File', accept: { 'application/json': ['.tui'] } }],
        multiple: false,
      });
      const file = await fileHandle.getFile();
      if (file.size > MAX_TUI_FILE_BYTES) return alert('Invalid .tui file: File is too large');
      load(await file.text());
    } catch (err) {
      if ((err as Error).name !== 'AbortError') alert('Failed to open file');
    }
  } else {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.tui,application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      if (file.size > MAX_TUI_FILE_BYTES) return alert('Invalid .tui file: File is too large');
      load(await file.text());
    };
    input.click();
  }
}
