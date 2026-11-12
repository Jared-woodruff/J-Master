// Where the saved settings go. zustand's persist hands its storage the
// settings after EVERY state change, and the store changes with every
// meter frame (about 46 a second, playing or not): written straight
// through, that was a JSON.stringify and a synchronous localStorage write
// 46 times a second for as long as the app was open.
//
// Here a hand-over whose settings are the same values as the last one is
// dropped on the spot (a meter frame changes none of them). A real change
// is written a moment later, once, however many follow it in that moment,
// and anything still waiting is flushed when the window goes away.
import type { PersistStorage, StorageValue } from 'zustand/middleware';

const WRITE_AFTER_MS = 400;

/** Same keys, each the same value or the very same object (the store never edits one in place). */
function sameValues(a: object | null, b: object | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if ((a as Record<string, unknown>)[k] !== (b as Record<string, unknown>)[k]) return false;
  }
  return true;
}

export function debouncedStorage<S>(): PersistStorage<S> {
  let due: { name: string; value: StorageValue<S> } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSeen: object | null = null;
  let lastWritten: string | null = null;

  const flush = (): void => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!due) return;
    const { name, value } = due;
    due = null;
    try {
      const text = JSON.stringify(value);
      if (text === lastWritten) return;
      localStorage.setItem(name, text);
      lastWritten = text;
    } catch { /* storage full or unavailable: the session carries on unsaved */ }
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
  }

  return {
    getItem: (name) => {
      try {
        const text = localStorage.getItem(name);
        if (!text) return null;
        lastWritten = text;
        return JSON.parse(text) as StorageValue<S>;
      } catch {
        return null;   // unreadable settings start over rather than stop the app
      }
    },
    setItem: (name, value) => {
      const state = value.state as unknown as object;
      if (sameValues(state, lastSeen)) return;
      lastSeen = state;
      due = { name, value };
      // Not restarted by later changes: the write happens within the
      // window even while changes keep coming.
      if (!timer) timer = setTimeout(flush, WRITE_AFTER_MS);
    },
    removeItem: (name) => {
      due = null;
      lastSeen = null;
      lastWritten = null;
      try { localStorage.removeItem(name); } catch { /* nothing to remove */ }
    },
    /** For tests and for a deliberate save point. */
    flush,
  } as PersistStorage<S> & { flush: () => void };
}
