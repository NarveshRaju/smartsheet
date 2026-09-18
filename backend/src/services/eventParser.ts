import { curateEventWithGroq, validateAiEvent } from './groq.service.js';
import { logger } from '../utils/logger.js';
import type { CalendarEventData, ColumnMapping } from '../types/index.js';



interface ParsedDateTimeResult {
  dateOnly: string; // YYYY-MM-DD
  dateTime?: string; // ISO string
  hasTime: boolean;
  isAllDay: boolean;
}

function isAllDayIndicator(val?: string): boolean {
  if (!val) return false;
  const lower = val.trim().toLowerCase();
  return (
    lower.includes('all day') ||
    lower.includes('allday') ||
    lower.includes('all-day') ||
    lower.includes('all_day') ||
    lower.includes('full day') ||
    lower.includes('fullday') ||
    lower.includes('whole day') ||
    lower === 'true' ||
    lower === 'yes' ||
    lower === 'y'
  );
}

function parseDateComponents(dStr: string): { year: number; month: number; day: number } | null {
  if (!dStr || !dStr.trim()) return null;
  const s = dStr.trim();

  // 1. ISO: YYYY-MM-DD or YYYY/MM/DD
  const isoMatch = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (isoMatch) {
    const year = parseInt(isoMatch[1], 10);
    const month = parseInt(isoMatch[2], 10);
    const day = parseInt(isoMatch[3], 10);
    if (year >= 1900 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { year, month, day };
    }
  }

  // 2. US: MM/DD/YYYY or M/D/YYYY
  const usMatch = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (usMatch) {
    const first = parseInt(usMatch[1], 10);
    const second = parseInt(usMatch[2], 10);
    const year = parseInt(usMatch[3], 10);

    if (first > 12) {
      return { year, month: second, day: first };
    }
    return { year, month: first, day: second };
  }

  // 3. Fallback standard date parse
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return {
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      day: d.getDate(),
    };
  }

  return null;
}

function parseTimeComponents(tStr: string): { hour: number; minute: number; second: number } | null {
  if (!tStr || !tStr.trim()) return null;
  const s = tStr.trim();

  // Match: "10:30:00 AM", "10:30 PM", "10:30am", "14:30", "9 AM", "9pm", "9:00"
  const match = s.match(/(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm)?/i);
  if (!match) return null;

  let hour = parseInt(match[1], 10);
  const minute = match[2] ? parseInt(match[2], 10) : 0;
  const second = match[3] ? parseInt(match[3], 10) : 0;
  const ampm = match[4]?.toLowerCase();

  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  return { hour, minute, second };
}

function parseSmartsheetDateTime(
  dateStr?: string,
  timeStr?: string,
  defaultHour: number = 9,
  defaultMinute: number = 0
): ParsedDateTimeResult | null {
  if (!dateStr || !dateStr.trim()) return null;

  const dStr = dateStr.trim();
  const tStr = timeStr ? timeStr.trim() : '';

  const isAllDay = isAllDayIndicator(tStr) || isAllDayIndicator(dStr);

  const dateComponents = parseDateComponents(dStr);
  if (!dateComponents) {
    logger.warn(`Could not parse date components from "${dateStr}"`);
    return null;
  }

  const { year, month, day } = dateComponents;
  const y = String(year).padStart(4, '0');
  const m = String(month).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  const dateOnly = `${y}-${m}-${d}`;

  if (isAllDay) {
    return {
      dateOnly,
      hasTime: false,
      isAllDay: true,
    };
  }

  // Extract time from timeStr or embedded in dateStr
  let timeComponents = parseTimeComponents(tStr);
  if (!timeComponents) {
    const embeddedMatch = dStr.match(/(?:T|\s+)(\d{1,2}(?::\d{2})?(?::\d{2})?\s*(?:am|pm)?)/i);
    if (embeddedMatch) {
      timeComponents = parseTimeComponents(embeddedMatch[1]);
    }
  }

  const hasTime = Boolean(timeComponents);
  const hour = timeComponents ? timeComponents.hour : defaultHour;
  const minute = timeComponents ? timeComponents.minute : defaultMinute;
  const second = timeComponents ? timeComponents.second : 0;

  const hStr = String(hour).padStart(2, '0');
  const minStr = String(minute).padStart(2, '0');
  const secStr = String(second).padStart(2, '0');

  // Format as floating ISO 8601 string without Z (anchored to calendar timeZone)
  const dateTime = `${dateOnly}T${hStr}:${minStr}:${secStr}`;

  return {
    dateOnly,
    dateTime,
    hasTime,
    isAllDay: false,
  };
}

function addDaysToDateString(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  const nextY = date.getUTCFullYear();
  const nextM = String(date.getUTCMonth() + 1).padStart(2, '0');
  const nextD = String(date.getUTCDate()).padStart(2, '0');
  return `${nextY}-${nextM}-${nextD}`;
}

function stripZFromDateTime(dt?: string): string | undefined {
  if (!dt) return undefined;
  return dt; // Preserve explicit source offsets.
}

function sanitizeCalendarEventRange(event: CalendarEventData, timezone: string): CalendarEventData {
  if (event.start.date) {
    // All-day event: end.date is exclusive in Google Calendar API
    let endDate = event.end.date || event.start.date;
    if (endDate <= event.start.date) {
      endDate = addDaysToDateString(event.start.date, 1);
    }
    return {
      ...event,
      start: { date: event.start.date, timeZone: timezone },
      end: { date: endDate, timeZone: timezone },
    };
  } else if (event.start.dateTime) {
    // Timed event: clean wall-clock datetime string
    let cleanStart = stripZFromDateTime(event.start.dateTime)!;
    let cleanEnd = stripZFromDateTime(event.end.dateTime);

    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(cleanStart)) {
      cleanStart = `${cleanStart}:00`;
    }

    if (!cleanEnd || cleanEnd <= cleanStart) {
      const [datePart, timePart] = cleanStart.split('T');
      if (timePart) {
        const [h, min, s] = timePart.split(':').map(Number);
        let endH = (h || 0) + 1;
        let endDatePart = datePart;
        if (endH >= 24) {
          endH -= 24;
          endDatePart = addDaysToDateString(datePart, 1);
        }
        cleanEnd = `${endDatePart}T${String(endH).padStart(2, '0')}:${String(min || 0).padStart(2, '0')}:${String(s || 0).padStart(2, '0')}`;
      } else {
        cleanEnd = `${cleanStart}`;
      }
    } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(cleanEnd)) {
      cleanEnd = `${cleanEnd}:00`;
    }

    return {
      ...event,
      start: { dateTime: cleanStart, timeZone: timezone },
      end: { dateTime: cleanEnd, timeZone: timezone },
    };
  }
  return event;
}

/**
 * Standard algorithmic row mapper.
 */
function mapRowToEventStandard(
  row: any,
  columnMapping: ColumnMapping,
  timezone: string
): CalendarEventData | null {
  const getCellValue = (columnId: string | undefined): string | undefined => {
    if (!columnId || !row.cells[columnId]) return undefined;
    return row.cells[columnId].value?.toString() || row.cells[columnId].displayValue;
  };

  const title = getCellValue(columnMapping.title);
  if (!title) {
    logger.debug(`Row ${row.id}: No title found, skipping`);
    return null;
  }

  const startDateStr = getCellValue(columnMapping.startDate);
  const startTimeStr = getCellValue(columnMapping.startTime);
  const endDateStr = getCellValue(columnMapping.endDate);
  const endTimeStr = getCellValue(columnMapping.endTime);

  // 1. Start Date is strictly mandatory
  if (!startDateStr || !startDateStr.trim()) {
    logger.debug(`Row ${row.id}: Start date is blank (both date and time are mandatory), skipping calendar sync`);
    return null;
  }

  // 2. Start Time is strictly mandatory (must have explicit non-empty time or embedded time/all-day)
  const hasExplicitStartTime = Boolean(startTimeStr && startTimeStr.trim().length > 0);
  const dateHasEmbeddedTime = /\d{1,2}:\d{2}/.test(startDateStr.trim()) || isAllDayIndicator(startDateStr.trim());

  if (!hasExplicitStartTime && !dateHasEmbeddedTime) {
    logger.debug(`Row ${row.id}: Start time is blank (both start date and start time are mandatory), skipping calendar sync`);
    return null;
  }

  const startParsed = parseSmartsheetDateTime(startDateStr, startTimeStr, 9, 0);
  if (!startParsed) {
    logger.debug(`Row ${row.id}: Invalid start date "${startDateStr}", skipping`);
    return null;
  }

  // If start time is neither a specific time nor an all-day event, skip calendar sync
  if (!startParsed.hasTime && !startParsed.isAllDay) {
    logger.debug(`Row ${row.id}: Start time is blank or invalid, skipping calendar sync`);
    return null;
  }

  let endParsed = parseSmartsheetDateTime(endDateStr || startDateStr, endTimeStr, 10, 0);

  let event: CalendarEventData;

  if (startParsed.isAllDay) {
    // All-day event: end.date is exclusive in Google Calendar API
    let endDateOnly = endParsed?.dateOnly || startParsed.dateOnly;
    if (endDateOnly <= startParsed.dateOnly) {
      endDateOnly = addDaysToDateString(startParsed.dateOnly, 1);
    }
    event = {
      summary: title,
      start: { date: startParsed.dateOnly, timeZone: timezone },
      end: { date: endDateOnly, timeZone: timezone },
    };
  } else {
    // Timed event: both start and end MUST be dateTime for Google Calendar
    let endDateTime = endParsed?.hasTime && endParsed?.dateTime ? endParsed.dateTime : undefined;
    const startTimeMs = new Date(startParsed.dateTime!).getTime();
    if (!endDateTime || new Date(endDateTime).getTime() <= startTimeMs) {
      // Default to 1 hour after start if no valid end time is specified
      const [datePart, timePart] = startParsed.dateTime!.split('T');
      if (timePart) {
        const [h, min, s] = timePart.split(':').map(Number);
        let endH = (h || 0) + 1;
        let endDatePart = datePart;
        if (endH >= 24) {
          endH -= 24;
          endDatePart = addDaysToDateString(datePart, 1);
        }
        endDateTime = `${endDatePart}T${String(endH).padStart(2, '0')}:${String(min || 0).padStart(2, '0')}:${String(s || 0).padStart(2, '0')}`;
      } else {
        endDateTime = startParsed.dateTime;
      }
    }

    event = {
      summary: title,
      start: { dateTime: startParsed.dateTime!, timeZone: timezone },
      end: { dateTime: endDateTime!, timeZone: timezone },
    };
  }

  const description = getCellValue(columnMapping.description);
  if (description) event.description = description;

  const location = getCellValue(columnMapping.location);
  if (location) event.location = location;

  const attendee = getCellValue(columnMapping.attendee);
  if (attendee) {
    event.attendees = attendee
      .split(/[,;\s]+/)
      .filter((e) => e.includes('@'))
      .map((email) => ({ email: email.trim() }));
  }

  const status = getCellValue(columnMapping.status);
  if (status) {
    const statusLower = status.toLowerCase();
    if (statusLower.includes('cancel')) {
      event.status = 'cancelled';
    } else if (statusLower.includes('tentative')) {
      event.status = 'tentative';
    } else {
      event.status = 'confirmed';
    }
  }

  return sanitizeCalendarEventRange(event, timezone);
}

/**
 * Map a Smartsheet row to Google Calendar event data.
 * Parse unambiguous structured values locally; defer complex input to validated AI.
 */
export async function mapRowToEvent(
  row: any,
  columnMapping: ColumnMapping,
  timezone: string
): Promise<CalendarEventData | null> {
  const value = (id?: string) => id ? String(row.cells?.[id]?.value ?? row.cells?.[id]?.displayValue ?? '').trim() : '';
  const title = value(columnMapping.title);
  const start = value(columnMapping.startDate);
  const time = value(columnMapping.startTime);
  if (!title || !start || (!time && !/T\d{2}:\d{2}/.test(start) && !isAllDayIndicator(start))) return null;
  const isoDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0,10) === v;
  const simpleTime = (v: string) => isAllDayIndicator(v) || /^(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(v) || /^(?:0?[1-9]|1[0-2])(?::[0-5]\d)?\s*(?:am|pm)$/i.test(v);
  const endDate = value(columnMapping.endDate);
  const endTime = value(columnMapping.endTime);
  if (!time && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?$/.test(start) && !endTime) {
    const normalize = (v: string) => v.replace(/(T\d{2}:\d{2})(?=Z|[+-]|$)/, '$1:00');
    const startTime = normalize(start);
    const end = endDate ? normalize(endDate) : new Date(Date.parse(/Z$|[+-]\d{2}:\d{2}$/.test(startTime) ? startTime : startTime + 'Z') + 3600000).toISOString().replace('.000Z', /Z$|[+-]\d{2}:\d{2}$/.test(startTime) ? 'Z' : '');
    return validateAiEvent({ ...mapRowToEventStandard(row, columnMapping, timezone), summary: title, start: { dateTime: startTime }, end: { dateTime: end } }, timezone);
  }
  if (isoDate(start) && simpleTime(time) && (!endDate || isoDate(endDate)) && (!endTime || simpleTime(endTime))) {
    const parsed = mapRowToEventStandard(row, columnMapping, timezone);
    if (parsed) return parsed;
  }
  return curateEventWithGroq(row, columnMapping, timezone);
}

