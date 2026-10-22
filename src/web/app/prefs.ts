// Per-browser preferences in localStorage. Every access is guarded: storage
// can be unavailable (private mode, blocked site data) and the UI must still work.
const PREFIX = 'kd2.';

export function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(PREFIX + key);
    return v == null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown): void {
  try {
    if (value === undefined) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Preferences are a convenience only.
  }
}
