// Access to localStorage that never throws: storage can be blocked, full or hold values that
// another version (or the user) wrote. The app must still start then, with the defaults.

export function getStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function setStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // not persisted; the setting only lasts for this session
  }
}

export function removeStored(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // nothing to remove
  }
}

/** A stored JSON value, or `fallback` if it is missing, not valid JSON or of another type. */
export function readStoredJson<T>(key: string, fallback: T): T {
  const raw = getStored(key);
  if (raw === null) return fallback;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === typeof fallback ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}
