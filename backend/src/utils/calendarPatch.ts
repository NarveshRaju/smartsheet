import type { calendar_v3 } from 'googleapis';
import type { CalendarEventData } from '../types/index.js';

export function buildCalendarPatch(event: CalendarEventData): calendar_v3.Schema$Event {
  const boundary = (value: CalendarEventData['start']): calendar_v3.Schema$EventDateTime => {
    if (Boolean(value.date) === Boolean(value.dateTime)) throw new Error('Calendar boundary must contain exactly one of date or dateTime');
    // PATCH merges nested objects. Omission does not clear the previous type.
    return value.date
      ? { date: value.date, dateTime: null, timeZone: null }
      : { date: null, dateTime: value.dateTime, timeZone: value.timeZone };
  };
  if (Boolean(event.start.date) !== Boolean(event.end.date)) throw new Error('Calendar start and end must use the same date type');
  return {
    ...event,
    start: boundary(event.start), end: boundary(event.end),
    description: event.description || '', location: event.location || '',
    attendees: event.attendees || [], status: event.status || 'confirmed',
  };
}
