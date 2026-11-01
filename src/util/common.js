// Small shared helpers. No dependencies.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** "Round half up" on a non-negative number, robust to float noise (0.5 -> 1, 1.5 -> 2). */
export function roundHalfUp(x) {
  return Math.floor(x + 0.5 + 1e-9);
}

/** +1 for buy, -1 for sell. */
export const sideSign = (side) => (side === 'buy' ? 1 : -1);

export const TERMINAL_STATUSES = new Set(['filled', 'cancelled', 'expired', 'rejected']);

/**
 * Sliding-window rate limiter: at most `limit` acquisitions per `windowMs`.
 * Callers await acquire() before each request.
 */
export class RateLimiter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.stamps = [];
    this.chain = Promise.resolve();
  }

  acquire() {
    // Serialize waiters so ordering is FIFO.
    const next = this.chain.then(async () => {
      for (;;) {
        const now = Date.now();
        while (this.stamps.length && now - this.stamps[0] >= this.windowMs) this.stamps.shift();
        if (this.stamps.length < this.limit) {
          this.stamps.push(now);
          return;
        }
        await sleep(this.windowMs - (now - this.stamps[0]) + 1);
      }
    });
    this.chain = next.catch(() => {});
    return next;
  }
}

/** Fixed-size array that keeps the last N items. */
export class Ring {
  constructor(size) {
    this.size = size;
    this.items = [];
  }
  push(x) {
    this.items.push(x);
    if (this.items.length > this.size) this.items.shift();
  }
  toArray() {
    return this.items.slice();
  }
}

export function percentile(values, p) {
  if (!values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

let tagSeq = 0;
/** Unique, short order tag so we can recognise our own copied orders. */
export function makeCopyTag() {
  tagSeq = (tagSeq + 1) % 1e6;
  return `ct-${Date.now().toString(36)}-${tagSeq.toString(36)}`;
}
export const isCopyTag = (tag) => typeof tag === 'string' && tag.startsWith('ct-');
