/**
 * behaviorTracker.ts — Phase 1: Frontend Event Dispatcher
 *
 * Collects behavior events and sends them to POST /v1/memory/event in batches.
 * Rules:
 *   - Events are queued in memory; a flush runs every 2 s or when the queue
 *     reaches BATCH_SIZE (10).
 *   - On page unload, the remaining queue is sent via navigator.sendBeacon so
 *     events aren't lost when the tab closes.
 *   - The tracker reads the auth token from localStorage — no prop drilling.
 *   - All network failures are swallowed; telemetry must never break the UI.
 */

const TOKEN_KEY = 'ocr_access_token';
const FLUSH_INTERVAL_MS = 2_000;
const BATCH_SIZE = 10;
const ENDPOINT = '/v1/memory/event';

export interface BehaviorEvent {
  event_type: string;
  metadata?: Record<string, unknown>;
}

// ── Singleton queue ──────────────────────────────────────────────────────────

const queue: BehaviorEvent[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;

function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

async function flushQueue(): Promise<void> {
  if (queue.length === 0) return;

  const token = getToken();
  if (!token) return; // not authenticated — discard

  const batch = queue.splice(0, queue.length); // drain atomically

  // Send each event individually (the backend accepts one event per call).
  // We use individual POSTs so a single bad event doesn't block the rest.
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  for (const event of batch) {
    try {
      // fire-and-forget — don't await, don't block
      fetch(ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify(event),
        keepalive: true, // survives page navigation
      }).catch(() => {
        // swallow silently
      });
    } catch {
      // swallow
    }
  }
}

function flushBeacon(): void {
  if (queue.length === 0) return;

  const token = getToken();
  if (!token) return;

  // sendBeacon doesn't support custom headers, so we POST each event as a
  // Blob with the token embedded in the URL query string — the backend reads
  // it via the Authorization header normally, so this path just tries its best
  // to not lose the events. In practice keepalive fetch above covers most cases.
  for (const event of queue.splice(0, queue.length)) {
    try {
      const blob = new Blob([JSON.stringify(event)], { type: 'application/json' });
      navigator.sendBeacon(`${ENDPOINT}?token=${encodeURIComponent(token)}`, blob);
    } catch {
      // swallow
    }
  }
}

function startFlushInterval(): void {
  if (flushTimer !== null) return;
  flushTimer = setInterval(() => {
    flushQueue().catch(() => {});
  }, FLUSH_INTERVAL_MS);
}

// Register page-unload handler once
if (typeof window !== 'undefined') {
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushBeacon();
    }
  });
  window.addEventListener('beforeunload', () => {
    flushBeacon();
  });
  startFlushInterval();
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Enqueue a behavior event. Returns immediately — network call is async.
 *
 * @param event_type  One of the allowed types defined in behavior.py
 * @param metadata    Arbitrary context; PII fields are scrubbed server-side
 */
export function track(
  event_type: string,
  metadata: Record<string, unknown> = {},
): void {
  queue.push({ event_type, metadata });

  if (queue.length >= BATCH_SIZE) {
    flushQueue().catch(() => {});
  }
}
