/**
 * Tiny external stores for `useSyncExternalStore`. Server snapshot is always the
 * initial value, so persisted client state never causes a hydration mismatch.
 */
type Listener = () => void;

export type Store<T> = {
  subscribe: (listener: Listener) => () => void;
  getSnapshot: () => T;
  getServerSnapshot: () => T;
  set: (next: T | ((prev: T) => T)) => void;
};

export function createStore<T>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<Listener>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
    getServerSnapshot: () => initial,
    set(next) {
      state = typeof next === "function" ? (next as (prev: T) => T)(state) : next;
      listeners.forEach((l) => l());
    },
  };
}

/** Same, persisted to localStorage and kept in sync across tabs. */
export function createPersistentStore<T>(key: string, initial: T, sanitize: (raw: unknown) => T): Store<T> {
  let state = initial;
  let loaded = false;
  const listeners = new Set<Listener>();

  function load() {
    if (loaded || typeof window === "undefined") return;
    loaded = true;
    try {
      const raw = window.localStorage.getItem(key);
      if (raw) state = sanitize(JSON.parse(raw));
    } catch {
      // blocked or corrupted storage: start from the initial value
    }
  }

  function onStorage(event: StorageEvent) {
    if (event.key !== key) return;
    try {
      state = event.newValue ? sanitize(JSON.parse(event.newValue)) : initial;
    } catch {
      state = initial;
    }
    listeners.forEach((l) => l());
  }

  return {
    subscribe(listener) {
      load();
      if (listeners.size === 0) window.addEventListener("storage", onStorage);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) window.removeEventListener("storage", onStorage);
      };
    },
    getSnapshot() {
      load();
      return state;
    },
    getServerSnapshot: () => initial,
    set(next) {
      load();
      state = typeof next === "function" ? (next as (prev: T) => T)(state) : next;
      try {
        window.localStorage.setItem(key, JSON.stringify(state));
      } catch {
        // storage full or blocked: keep the in-memory state
      }
      listeners.forEach((l) => l());
    },
  };
}
