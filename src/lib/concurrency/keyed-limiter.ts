/**
 * Per-key concurrency limiter: at most `limit` calls of `run(key, fn)` run at
 * once for the same key; the rest wait in memory, first in first out. Calls
 * for different keys never wait on each other.
 *
 * The point is to keep one caller from taking every database connection. A
 * waiting call holds nothing (no pool client, no transaction), so other keys'
 * queries get connections at once. Pure (no I/O), so it is unit-tested
 * directly.
 */

export interface KeyedLimiter {
  run<T>(key: string, fn: () => Promise<T>): Promise<T>;
  /** Calls for `key` currently running or waiting (diagnostics and tests). */
  pending(key: string): number;
}

interface KeyState {
  running: number;
  waiting: Array<() => void>;
}

export function createKeyedLimiter(limit: number): KeyedLimiter {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`createKeyedLimiter: limit must be a positive integer, got ${limit}`);
  }
  const states = new Map<string, KeyState>();

  const acquire = (key: string): Promise<void> => {
    let s = states.get(key);
    if (!s) {
      s = { running: 0, waiting: [] };
      states.set(key, s);
    }
    if (s.running < limit) {
      s.running++;
      return Promise.resolve();
    }
    const state = s;
    return new Promise<void>((resolve) => {
      // The slot is handed over by release(): `running` stays the same.
      state.waiting.push(resolve);
    });
  };

  const release = (key: string): void => {
    const s = states.get(key);
    if (!s) return;
    const next = s.waiting.shift();
    if (next) {
      next();
      return;
    }
    s.running--;
    if (s.running <= 0) states.delete(key);
  };

  return {
    async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      await acquire(key);
      try {
        return await fn();
      } finally {
        release(key);
      }
    },
    pending(key: string): number {
      const s = states.get(key);
      return s ? s.running + s.waiting.length : 0;
    },
  };
}
