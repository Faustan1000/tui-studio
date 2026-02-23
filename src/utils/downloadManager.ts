// Manages the user-selected download folder for exports

let _directoryHandle: FileSystemDirectoryHandle | null = null;

export function isDirectoryPickerSupported(): boolean {
  return 'showDirectoryPicker' in window;
}

export function getDownloadFolderName(): string {
  return localStorage.getItem('settings-download-folder') || '';
}

export async function selectDownloadFolder(): Promise<string | null> {
  if (!isDirectoryPickerSupported()) return null;
  try {
    _directoryHandle = await (window as any).showDirectoryPicker();
    const name = _directoryHandle!.name;
    localStorage.setItem('settings-download-folder', name);
    return name;
  } catch (err) {
    // User cancelled or permission denied — not an error worth reporting
    const isAbort =
      err instanceof DOMException && (err.name === 'AbortError' || err.name === 'SecurityError');
    if (!isAbort) console.warn('selectDownloadFolder:', err);
    return null;
  }
}

/**
 * Save content to the user's selected download folder.
 * Returns true on success, false if no folder is selected or write fails.
 */
export async function saveToDownloadFolder(content: string, filename: string): Promise<boolean> {
  if (!_directoryHandle) return false;
  try {
    const fileHandle = await (_directoryHandle as any).getFileHandle(filename, { create: true });

    const writable = await (fileHandle as any).createWritable();
    await writable.write(content);
    await writable.close();
    return true;
  } catch (err) {
    console.warn('saveToDownloadFolder:', err);
    return false;
  }
}
