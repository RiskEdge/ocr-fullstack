/**
 * useBehaviorTracker — thin React wrapper around the behaviorTracker singleton.
 *
 * Usage:
 *   const track = useBehaviorTracker({ sourceFilename: 'invoice.pdf' });
 *   track('field_edit', { field_id: 'cost_price', item_index: 2 });
 *
 * The optional `defaults` object is merged into every event's metadata so
 * callers don't have to repeat context like sourceFilename on every call.
 */

import { useCallback } from 'react';
import { track as dispatchEvent } from '@/lib/behaviorTracker';

interface TrackerDefaults {
  sourceFilename?: string;
  [key: string]: unknown;
}

export function useBehaviorTracker(defaults: TrackerDefaults = {}) {
  const track = useCallback(
    (eventType: string, metadata: Record<string, unknown> = {}) => {
      dispatchEvent(eventType, { ...defaults, ...metadata });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [defaults.sourceFilename],
  );

  return track;
}
