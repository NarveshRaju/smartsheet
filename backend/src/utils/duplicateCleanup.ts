import type { calendar_v3 } from 'googleapis';
import type { CalendarEventData } from '../types/index.js';
import { eventFingerprint, sameEvent } from './eventIdentity.js';

type Event = calendar_v3.Schema$Event;
export type ReconciledRow = { eventId: string; data: CalendarEventData } | null;
export interface DuplicateCandidate {
  event: Event & { id: string };
  rowId: string;
  reason: 'same-source-row' | 'removed-source-row' | 'surplus-identical-event';
}

// Plan only after all rows have had a chance to claim their event. A saved survivor
// is required before deleting copies. Failed/ambiguous rows retain their entries.
export function planDuplicateCleanup(
  events: Event[], sheetId: string, rowIds: Set<string>,
  reconciled: Map<string, ReconciledRow>, protectedIds: Set<string>,
  timezone: string, allowUnownedCleanup: boolean,
): DuplicateCandidate[] {
  const survivors = new Map<string, Array<{ rowId: string; data: CalendarEventData }>>();
  for (const [rowId, kept] of reconciled) {
    if (!kept) continue;
    const key = eventFingerprint(kept.data, timezone);
    survivors.set(key, [...(survivors.get(key) || []), { rowId, data: kept.data }]);
  }
  const result: DuplicateCandidate[] = [];
  for (const event of events) {
    if (!event.id || event.status === 'cancelled' || event.recurrence || event.recurringEventId || protectedIds.has(event.id)) continue;
    const tags = event.extendedProperties?.private;
    if (tags?.smartsheetSheetId === sheetId && tags.smartsheetRowId) {
      const rowId = tags.smartsheetRowId;
      if (!rowIds.has(rowId)) {
        result.push({ event: event as Event & { id: string }, rowId, reason: 'removed-source-row' });
      } else if (reconciled.has(rowId) && reconciled.get(rowId)?.eventId !== event.id) {
        result.push({ event: event as Event & { id: string }, rowId, reason: 'same-source-row' });
      }
    } else if (allowUnownedCleanup && !tags?.smartsheetRowId && !tags?.smartsheetSheetId) {
      // Legacy entries without metadata require a complete content match, never
      // merely the same name/day. Other sheets and recurring entries are excluded.
      try {
        const match = survivors.get(eventFingerprint(event, timezone))?.find(kept => sameEvent(event, kept.data, timezone));
        if (match) result.push({ event: event as Event & { id: string }, rowId: match.rowId, reason: 'surplus-identical-event' });
      } catch { /* Unsupported times are not evidence of a duplicate. */ }
    }
  }
  return result;
}
