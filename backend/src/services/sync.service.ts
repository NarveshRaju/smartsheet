import { PrismaClient } from '@prisma/client';
import * as googleService from './google.service.js';
import * as smartsheetService from './smartsheet.service.js';
import { curateEventWithGroq, isGroqConfigured } from './groq.service.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import type { CalendarEventData, ColumnMapping, SyncResult } from '../types/index.js';

const prisma = new PrismaClient();

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
    lower === 'all day' ||
    lower === 'allday' ||
    lower === 'all-day' ||
    lower === 'all_day' ||
    lower === 'all day event' ||
    lower === 'full day' ||
    lower === 'whole day' ||
    lower === 'true' ||
    lower === 'yes'
  );
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

  // Check if dateStr itself already contains a time (e.g. 2026-08-18T10:00:00 or 2026-08-18 10:00 AM)
  const dateHasTime = !isAllDay && /\d{1,2}:\d{2}/.test(dStr);
  const hasTime = dateHasTime || (!isAllDay && tStr !== '' && /\d{1,2}:\d{2}/.test(tStr));

  // If time is provided separately and dateStr doesn't have time:
  let combinedStr = dStr;
  if (!dateHasTime && !isAllDay && tStr && /\d{1,2}:\d{2}/.test(tStr)) {
    combinedStr = `${dStr} ${tStr}`;
  }

  // Try standard Date parse
  let parsed = new Date(combinedStr);

  // If invalid, attempt manual component extraction
  if (isNaN(parsed.getTime())) {
    const dateMatch =
      dStr.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/) ||
      dStr.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);

    if (dateMatch) {
      let year = 0, month = 0, day = 0;
      if (dateMatch[1].length === 4) {
        year = parseInt(dateMatch[1], 10);
        month = parseInt(dateMatch[2], 10) - 1;
        day = parseInt(dateMatch[3], 10);
      } else {
        year = parseInt(dateMatch[3], 10);
        month = parseInt(dateMatch[1], 10) - 1;
        day = parseInt(dateMatch[2], 10);
      }

      let hour = defaultHour;
      let minute = defaultMinute;

      const timeSource = !isAllDay ? (tStr || (dateHasTime ? dStr : '')) : '';
      if (timeSource) {
        const timeMatch = timeSource.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/i);
        if (timeMatch) {
          hour = parseInt(timeMatch[1], 10);
          minute = parseInt(timeMatch[2], 10);
          const ampm = timeMatch[4]?.toLowerCase();
          if (ampm === 'pm' && hour < 12) hour += 12;
          if (ampm === 'am' && hour === 12) hour = 0;
        }
      }

      parsed = new Date(year, month, day, hour, minute);
    }
  }

  if (isNaN(parsed.getTime())) {
    logger.warn(`Could not parse date/time from date: "${dateStr}", time: "${timeStr}"`);
    return null;
  }

  const y = parsed.getFullYear();
  const m = String(parsed.getMonth() + 1).padStart(2, '0');
  const d = String(parsed.getDate()).padStart(2, '0');
  const dateOnly = `${y}-${m}-${d}`;

  return {
    dateOnly,
    dateTime: parsed.toISOString(),
    hasTime,
    isAllDay,
  };
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
    return row.cells[columnId].displayValue || row.cells[columnId].value?.toString();
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
    // All-day event: both start and end MUST be date-only for Google Calendar
    const endDateOnly = endParsed?.dateOnly || startParsed.dateOnly;
    event = {
      summary: title,
      start: { date: startParsed.dateOnly, timeZone: timezone },
      end: { date: endDateOnly, timeZone: timezone },
    };
  } else {
    // Timed event: both start and end MUST be dateTime for Google Calendar
    let endDateTime = endParsed?.hasTime && endParsed?.dateTime ? endParsed.dateTime : undefined;
    if (!endDateTime) {
      // Default to 1 hour after start if no end time is specified
      const sDate = new Date(startParsed.dateTime!);
      sDate.setHours(sDate.getHours() + 1);
      endDateTime = sDate.toISOString();
    }

    event = {
      summary: title,
      start: { dateTime: startParsed.dateTime!, timeZone: timezone },
      end: { dateTime: endDateTime, timeZone: timezone },
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

  return event;
}

/**
 * Map a Smartsheet row to Google Calendar event data.
 * If Groq LLM is configured, it uses AI to curate rich event data,
 * otherwise falls back to standard algorithmic mapper.
 */
async function mapRowToEvent(
  row: any,
  columnMapping: ColumnMapping,
  timezone: string
): Promise<CalendarEventData | null> {
  if (isGroqConfigured()) {
    try {
      const aiEvent = await curateEventWithGroq(row, columnMapping, timezone);
      if (aiEvent) {
        return aiEvent;
      }
    } catch (e: any) {
      logger.warn(`Groq curation error: ${e.message}, falling back to standard mapper`);
    }
  }

  return mapRowToEventStandard(row, columnMapping, timezone);
}

/**
 * Check if row data has changed compared to stored snapshot.
 */
function extractRowSignature(row: any): string {
  if (!row || !row.cells) return '';
  const pairs: string[] = [];
  for (const [colId, cell] of Object.entries<any>(row.cells)) {
    const v = cell?.displayValue ?? cell?.value ?? '';
    pairs.push(`${colId}:${v}`);
  }
  return pairs.sort().join('|');
}

function hasRowChanged(newRow: any, storedData: any): boolean {
  if (!storedData) return true;
  return extractRowSignature(newRow) !== extractRowSignature(storedData);
}

function normalizeTitle(title?: string): string {
  if (!title) return '';
  return title
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s]/g, '');
}

function getEventFingerprint(
  summary?: string | null,
  start?: { dateTime?: string | null; date?: string | null } | null
): string {
  const norm = normalizeTitle(summary || '');
  const startStr = (start?.dateTime || start?.date || '').substring(0, 10);
  return `${norm}:::${startStr}`;
}

function getEventTimeFingerprint(
  summary?: string | null,
  start?: { dateTime?: string | null; date?: string | null } | null
): string {
  const norm = normalizeTitle(summary || '');
  const startStr = (start?.dateTime || start?.date || '').substring(0, 16);
  return `${norm}:::${startStr}`;
}

const activeSyncMap = new Map<string, Promise<SyncResult>>();

/**
 * Full sync: compare all Smartsheet rows with stored records and sync differences.
 * Includes intelligent deduplication to prevent duplicate events on existing calendars.
 */
export async function fullSync(configId: string): Promise<SyncResult> {
  if (activeSyncMap.has(configId)) {
    logger.info(`Sync already in progress for config ${configId}, returning active sync run`);
    return activeSyncMap.get(configId)!;
  }

  const syncPromise = executeFullSync(configId);
  activeSyncMap.set(configId, syncPromise);

  try {
    return await syncPromise;
  } finally {
    activeSyncMap.delete(configId);
  }
}

async function executeFullSync(configId: string): Promise<SyncResult> {
  const config = await prisma.syncConfiguration.findUnique({
    where: { id: configId },
    include: { user: true },
  });

  if (!config) throw Object.assign(new Error('Sync configuration not found'), { statusCode: 404 });

  const userId = config.userId;
  const columnMapping = config.columnMapping as ColumnMapping;
  const timezone = env.DEFAULT_TIMEZONE;
  const result: SyncResult = { created: 0, updated: 0, deleted: 0, failed: 0, errors: [] };

  logger.info(`Starting full sync for config ${configId} on calendar ${config.googleCalendarId}`);

  try {
    // Fetch all rows from Smartsheet
    const rows = await smartsheetService.getSheetRows(userId, config.smartsheetSheetId);
    const rowIds = new Set(rows.map((r: any) => r.id.toString()));

    // Get existing sync records from DB
    const existingRecords = await prisma.syncRecord.findMany({
      where: { syncConfigId: configId },
    });
    const recordMap = new Map(existingRecords.map((r) => [r.smartsheetRowId, r]));

    // Pre-fetch existing events from Google Calendar for smart deduplication
    let calendarEvents: any[] = [];
    try {
      calendarEvents = await googleService.listCalendarEvents(userId, config.googleCalendarId);
      logger.info(`Found ${calendarEvents.length} existing events in Google Calendar for deduplication check`);
    } catch (calErr: any) {
      logger.warn(`Could not pre-fetch calendar events for deduplication: ${calErr.message}`);
    }

    // Build deduplication index maps
    const gcalById = new Map<string, any>();
    const gcalByRowId = new Map<string, any>();
    const gcalByTimeFingerprint = new Map<string, any>();
    const gcalByDateFingerprint = new Map<string, any>();

    for (const evt of calendarEvents) {
      if (!evt || !evt.id || evt.status === 'cancelled') continue;
      gcalById.set(evt.id, evt);

      const rowTag = evt.extendedProperties?.private?.smartsheetRowId;
      if (rowTag) {
        gcalByRowId.set(rowTag.toString(), evt);
      }

      if (evt.summary && evt.start) {
        const timeKey = getEventTimeFingerprint(evt.summary, evt.start);
        if (!gcalByTimeFingerprint.has(timeKey)) {
          gcalByTimeFingerprint.set(timeKey, evt);
        }
        const dateKey = getEventFingerprint(evt.summary, evt.start);
        if (!gcalByDateFingerprint.has(dateKey)) {
          gcalByDateFingerprint.set(dateKey, evt);
        }
      }
    }

    // Process each row
    for (const row of rows) {
      const rowId = row.id.toString();
      const existingRecord = recordMap.get(rowId);

      // ⚡ EFFICIENCY OPTIMIZATION:
      // If record is already synced, row has not changed, and event exists on target calendar, skip completely!
      if (
        existingRecord &&
        existingRecord.syncStatus === 'synced' &&
        existingRecord.googleEventId &&
        (!calendarEvents.length || gcalById.has(existingRecord.googleEventId)) &&
        !hasRowChanged(row, existingRecord.rowData)
      ) {
        continue;
      }

      try {
        const eventData = await mapRowToEvent(row, columnMapping, timezone);
        if (!eventData) {
          // If start/end time is blank or missing, and this row was previously on Google Calendar, remove it
          if (existingRecord && existingRecord.googleEventId && existingRecord.syncStatus !== 'deleted') {
            try {
              await googleService.deleteEvent(userId, config.googleCalendarId, existingRecord.googleEventId);
              await prisma.syncRecord.update({
                where: { id: existingRecord.id },
                data: {
                  syncStatus: 'deleted',
                  syncAction: 'delete',
                  lastSyncedAt: new Date(),
                  lastError: null,
                  rowData: row,
                },
              });
              result.deleted++;
              logger.info(`Removed row ${rowId} from Google Calendar (time is blank)`);
            } catch (delErr: any) {
              logger.warn(`Could not remove event for row ${rowId}: ${delErr.message}`);
            }
          }
          continue; // Skip rows without time
        }

        // Add private metadata tags for deterministic identification
        const eventDataWithProps: CalendarEventData = {
          ...eventData,
          extendedProperties: {
            private: {
              smartsheetRowId: rowId,
              smartsheetSheetId: config.smartsheetSheetId,
            },
          },
        };

        // Determine if we already have a valid linked Google event
        let targetEventId = existingRecord?.googleEventId || null;
        let isExistingEventOnCalendar = targetEventId ? (calendarEvents.length === 0 || gcalById.has(targetEventId)) : false;

        // ⚡ DEDUPLICATION CHECK:
        // If we don't have a verified event ID on this calendar, search existing calendar events to prevent duplicates!
        if (!targetEventId || !isExistingEventOnCalendar) {
          const timeKey = getEventTimeFingerprint(eventData.summary, eventData.start);
          const dateKey = getEventFingerprint(eventData.summary, eventData.start);

          const matchedEvent =
            gcalByRowId.get(rowId) ||
            gcalByTimeFingerprint.get(timeKey) ||
            gcalByDateFingerprint.get(dateKey);

          if (matchedEvent && matchedEvent.id) {
            targetEventId = matchedEvent.id;
            isExistingEventOnCalendar = true;
            logger.info(
              `⚡ Deduplication matched existing event "${matchedEvent.summary}" (${matchedEvent.id}) for row ${rowId}. Linking without duplicating.`
            );

            // Consume from maps so another row with same title doesn't attach to same single event
            gcalByRowId.delete(rowId);
            gcalByTimeFingerprint.delete(timeKey);
            gcalByDateFingerprint.delete(dateKey);
          }
        }

        if (targetEventId && isExistingEventOnCalendar) {
          // UPDATE / LINK: Event exists in Google Calendar
          await googleService.updateEvent(
            userId,
            config.googleCalendarId,
            targetEventId,
            eventDataWithProps
          );

          if (existingRecord) {
            await prisma.syncRecord.update({
              where: { id: existingRecord.id },
              data: {
                googleEventId: targetEventId,
                syncStatus: 'synced',
                syncAction: existingRecord.googleEventId === targetEventId ? 'update' : 'linked',
                lastSyncedAt: new Date(),
                lastError: null,
                rowData: row,
              },
            });
          } else {
            await prisma.syncRecord.create({
              data: {
                syncConfigId: configId,
                smartsheetRowId: rowId,
                googleEventId: targetEventId,
                syncStatus: 'synced',
                syncAction: 'linked',
                lastSyncedAt: new Date(),
                rowData: row,
              },
            });
          }
          result.updated++;
        } else {
          // CREATE: No matching event exists on Google Calendar, create new event
          const newEventId = await googleService.createEvent(
            userId,
            config.googleCalendarId,
            eventDataWithProps
          );

          if (existingRecord) {
            await prisma.syncRecord.update({
              where: { id: existingRecord.id },
              data: {
                googleEventId: newEventId,
                syncStatus: 'synced',
                syncAction: 'create',
                lastSyncedAt: new Date(),
                lastError: null,
                rowData: row,
              },
            });
          } else {
            await prisma.syncRecord.create({
              data: {
                syncConfigId: configId,
                smartsheetRowId: rowId,
                googleEventId: newEventId,
                syncStatus: 'synced',
                syncAction: 'create',
                lastSyncedAt: new Date(),
                rowData: row,
              },
            });
          }
          result.created++;
        }
      } catch (error: any) {
        result.failed++;
        result.errors.push({ rowId, error: error.message });
        logger.error(`Failed to sync row ${rowId}: ${error.message}`);

        // Store failure in DB
        if (existingRecord) {
          await prisma.syncRecord.update({
            where: { id: existingRecord.id },
            data: {
              syncStatus: 'failed',
              lastError: error.message,
              retryCount: existingRecord.retryCount + 1,
            },
          });
        } else {
          await prisma.syncRecord.upsert({
            where: { syncConfigId_smartsheetRowId: { syncConfigId: configId, smartsheetRowId: rowId } },
            create: {
              syncConfigId: configId,
              smartsheetRowId: rowId,
              syncStatus: 'failed',
              syncAction: 'create',
              lastError: error.message,
              rowData: row,
            },
            update: {
              syncStatus: 'failed',
              lastError: error.message,
              retryCount: { increment: 1 },
            },
          });
        }
      }
    }

    // DELETE: Records for rows that no longer exist in Smartsheet
    for (const record of existingRecords) {
      if (!rowIds.has(record.smartsheetRowId) && record.syncStatus !== 'deleted') {
        try {
          if (record.googleEventId) {
            await googleService.deleteEvent(userId, config.googleCalendarId, record.googleEventId);
          }
          await prisma.syncRecord.update({
            where: { id: record.id },
            data: {
              syncStatus: 'deleted',
              syncAction: 'delete',
              lastSyncedAt: new Date(),
              lastError: null,
            },
          });
          result.deleted++;
        } catch (error: any) {
          result.failed++;
          result.errors.push({ rowId: record.smartsheetRowId, error: error.message });
          logger.error(`Failed to delete event for row ${record.smartsheetRowId}: ${error.message}`);
        }
      }
    }

    // Update last full sync timestamp
    await prisma.syncConfiguration.update({
      where: { id: configId },
      data: { lastFullSyncAt: new Date() },
    });

    logger.info(`Full sync completed: ${JSON.stringify(result)}`);
    return result;
  } catch (error: any) {
    logger.error(`Full sync failed: ${error.message}`);
    throw error;
  }
}

/**
 * Sync a single row (used by webhooks & direct updates).
 */
export async function syncRow(
  configId: string,
  rowId: string,
  action: 'created' | 'updated' | 'deleted'
): Promise<void> {
  const config = await prisma.syncConfiguration.findUnique({
    where: { id: configId },
  });

  if (!config || !config.isEnabled) {
    logger.debug(`Sync skipped: config ${configId} not found or disabled`);
    return;
  }

  const userId = config.userId;
  const columnMapping = config.columnMapping as ColumnMapping;
  const timezone = env.DEFAULT_TIMEZONE;

  const existingRecord = await prisma.syncRecord.findUnique({
    where: { syncConfigId_smartsheetRowId: { syncConfigId: configId, smartsheetRowId: rowId } },
  });

  try {
    if (action === 'deleted') {
      // DELETE the calendar event
      if (existingRecord?.googleEventId) {
        await googleService.deleteEvent(userId, config.googleCalendarId, existingRecord.googleEventId);
      }
      if (existingRecord) {
        await prisma.syncRecord.update({
          where: { id: existingRecord.id },
          data: {
            syncStatus: 'deleted',
            syncAction: 'delete',
            lastSyncedAt: new Date(),
            lastError: null,
          },
        });
      }
      return;
    }

    // Fetch row data from Smartsheet
    const row = await smartsheetService.getRow(userId, config.smartsheetSheetId, rowId);
    if (!row) {
      logger.warn(`Row ${rowId} not found in Smartsheet, treating as deleted`);
      if (existingRecord?.googleEventId) {
        await googleService.deleteEvent(userId, config.googleCalendarId, existingRecord.googleEventId);
      }
      if (existingRecord) {
        await prisma.syncRecord.update({
          where: { id: existingRecord.id },
          data: { syncStatus: 'deleted', syncAction: 'delete', lastSyncedAt: new Date(), lastError: null },
        });
      }
      return;
    }

    // ⚡ If row hasn't changed from stored snapshot, skip calling LLM/Google Calendar
    if (existingRecord && existingRecord.syncStatus === 'synced' && !hasRowChanged(row, existingRecord.rowData)) {
      logger.debug(`Row ${rowId}: No changes detected in cells, skipping`);
      return;
    }

    const eventData = await mapRowToEvent(row, columnMapping, timezone);
    if (!eventData) {
      logger.debug(`Row ${rowId}: Start/end time is blank or missing required fields, skipping`);
      if (existingRecord?.googleEventId && existingRecord.syncStatus !== 'deleted') {
        try {
          await googleService.deleteEvent(userId, config.googleCalendarId, existingRecord.googleEventId);
          await prisma.syncRecord.update({
            where: { id: existingRecord.id },
            data: { syncStatus: 'deleted', syncAction: 'delete', lastSyncedAt: new Date(), lastError: null, rowData: row },
          });
          logger.info(`Removed row ${rowId} from Google Calendar (time is blank)`);
        } catch (delErr: any) {
          logger.warn(`Could not remove event for row ${rowId}: ${delErr.message}`);
        }
      }
      return;
    }

    const eventDataWithProps: CalendarEventData = {
      ...eventData,
      extendedProperties: {
        private: {
          smartsheetRowId: rowId,
          smartsheetSheetId: config.smartsheetSheetId,
        },
      },
    };

    let targetEventId = existingRecord?.googleEventId || null;

    // If no existing event ID, perform deduplication lookup
    if (!targetEventId) {
      try {
        const candidateEvents = await googleService.findExistingEvent(
          userId,
          config.googleCalendarId,
          eventData.summary
        );
        const targetTimeKey = getEventTimeFingerprint(eventData.summary, eventData.start);
        const targetDateKey = getEventFingerprint(eventData.summary, eventData.start);

        for (const candidate of candidateEvents) {
          if (candidate.status === 'cancelled') continue;
          const rowTag = candidate.extendedProperties?.private?.smartsheetRowId;
          if (rowTag === rowId) {
            targetEventId = candidate.id!;
            break;
          }
          if (candidate.summary && candidate.start) {
            const cTimeKey = getEventTimeFingerprint(candidate.summary, candidate.start);
            const cDateKey = getEventFingerprint(candidate.summary, candidate.start);
            if (cTimeKey === targetTimeKey || cDateKey === targetDateKey) {
              targetEventId = candidate.id!;
              break;
            }
          }
        }
      } catch (searchErr: any) {
        logger.warn(`Could not search existing events for deduplication: ${searchErr.message}`);
      }
    }

    if (targetEventId) {
      // UPDATE / LINK existing event
      await googleService.updateEvent(userId, config.googleCalendarId, targetEventId, eventDataWithProps);
      await prisma.syncRecord.upsert({
        where: { syncConfigId_smartsheetRowId: { syncConfigId: configId, smartsheetRowId: rowId } },
        create: {
          syncConfigId: configId,
          smartsheetRowId: rowId,
          googleEventId: targetEventId,
          syncStatus: 'synced',
          syncAction: 'linked',
          lastSyncedAt: new Date(),
          rowData: row,
        },
        update: {
          googleEventId: targetEventId,
          syncStatus: 'synced',
          syncAction: 'update',
          lastSyncedAt: new Date(),
          lastError: null,
          rowData: row,
        },
      });
    } else {
      // CREATE new event
      const eventId = await googleService.createEvent(userId, config.googleCalendarId, eventDataWithProps);
      await prisma.syncRecord.upsert({
        where: { syncConfigId_smartsheetRowId: { syncConfigId: configId, smartsheetRowId: rowId } },
        create: {
          syncConfigId: configId,
          smartsheetRowId: rowId,
          googleEventId: eventId,
          syncStatus: 'synced',
          syncAction: 'create',
          lastSyncedAt: new Date(),
          rowData: row,
        },
        update: {
          googleEventId: eventId,
          syncStatus: 'synced',
          syncAction: 'create',
          lastSyncedAt: new Date(),
          lastError: null,
          rowData: row,
        },
      });
    }
  } catch (error: any) {
    logger.error(`Failed to sync row ${rowId}: ${error.message}`);

    // Record failure
    await prisma.syncRecord.upsert({
      where: { syncConfigId_smartsheetRowId: { syncConfigId: configId, smartsheetRowId: rowId } },
      create: {
        syncConfigId: configId,
        smartsheetRowId: rowId,
        syncStatus: 'failed',
        syncAction: action === 'created' ? 'create' : action === 'updated' ? 'update' : 'delete',
        lastError: error.message,
      },
      update: {
        syncStatus: 'failed',
        lastError: error.message,
        retryCount: { increment: 1 },
      },
    });

    throw error;
  }
}

/**
 * Retry a failed sync record.
 */
export async function retrySyncRecord(recordId: string): Promise<void> {
  const record = await prisma.syncRecord.findUnique({
    where: { id: recordId },
    include: { syncConfig: true },
  });

  if (!record) throw Object.assign(new Error('Sync record not found'), { statusCode: 404 });
  if (record.syncStatus !== 'failed') {
    throw Object.assign(new Error('Only failed records can be retried'), { statusCode: 400 });
  }

  const actionMap: Record<string, 'created' | 'updated' | 'deleted'> = { create: 'created', update: 'updated', delete: 'deleted' };
  const action = actionMap[record.syncAction || 'update'] || 'updated';
  await syncRow(record.syncConfigId, record.smartsheetRowId, action || 'updated');
}

/**
 * Get sync status / statistics.
 */
export async function getSyncStatus(configId: string) {
  const config = await prisma.syncConfiguration.findUnique({
    where: { id: configId },
  });

  if (!config) throw Object.assign(new Error('Sync configuration not found'), { statusCode: 404 });

  const [total, synced, failed, pending, deleted] = await Promise.all([
    prisma.syncRecord.count({ where: { syncConfigId: configId } }),
    prisma.syncRecord.count({ where: { syncConfigId: configId, syncStatus: 'synced' } }),
    prisma.syncRecord.count({ where: { syncConfigId: configId, syncStatus: 'failed' } }),
    prisma.syncRecord.count({ where: { syncConfigId: configId, syncStatus: 'pending' } }),
    prisma.syncRecord.count({ where: { syncConfigId: configId, syncStatus: 'deleted' } }),
  ]);

  const failedRecords = await prisma.syncRecord.findMany({
    where: { syncConfigId: configId, syncStatus: 'failed' },
    orderBy: { updatedAt: 'desc' },
    take: 50,
  });

  const recentRecords = await prisma.syncRecord.findMany({
    where: { syncConfigId: configId },
    orderBy: { updatedAt: 'desc' },
    take: 20,
  });

  return {
    config: {
      id: config.id,
      sheetName: config.sheetName,
      calendarName: config.calendarName,
      isEnabled: config.isEnabled,
      lastFullSyncAt: config.lastFullSyncAt,
    },
    stats: { total, synced, failed, pending, deleted },
    failedRecords,
    recentRecords,
  };
}

// ── Background Auto-Sync Polling Worker ───────────────────

let autoSyncTimer: NodeJS.Timeout | null = null;
let isSyncRunning = false;

export function startAutoSyncWorker(): void {
  if (autoSyncTimer) return;

  const intervalMs = parseInt(env.AUTO_SYNC_INTERVAL_MS, 10) || 30000;
  logger.info(`🔄 Starting Auto-Sync background worker (polling every ${intervalMs / 1000}s)`);

  // Run a quick tick shortly after start
  setTimeout(async () => {
    await runAutoSyncTick();
  }, 5000);

  autoSyncTimer = setInterval(async () => {
    await runAutoSyncTick();
  }, intervalMs);
}

async function runAutoSyncTick(): Promise<void> {
  if (isSyncRunning) {
    logger.debug('Auto-sync already in progress, skipping tick');
    return;
  }

  try {
    isSyncRunning = true;
    const activeConfigs = await prisma.syncConfiguration.findMany({
      where: { isEnabled: true },
    });

    for (const config of activeConfigs) {
      try {
        const result = await fullSync(config.id);
        if (result.created > 0 || result.updated > 0 || result.deleted > 0) {
          logger.info(`⚡ Auto-sync updated config ${config.id}: +${result.created} ~${result.updated} -${result.deleted}`);
        }
      } catch (err: any) {
        logger.warn(`Auto-sync tick error for config ${config.id}: ${err.message}`);
      }
    }
  } catch (error: any) {
    logger.error(`Auto-sync worker error: ${error.message}`);
  } finally {
    isSyncRunning = false;
  }
}

export function stopAutoSyncWorker(): void {
  if (autoSyncTimer) {
    clearInterval(autoSyncTimer);
    autoSyncTimer = null;
    logger.info('⏹️ Auto-Sync background worker stopped');
  }
}
