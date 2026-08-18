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

  if (!startDateStr || !startDateStr.trim()) {
    logger.debug(`Row ${row.id}: No start date mentioned or date is blank, skipping calendar sync`);
    return null;
  }

  const startParsed = parseSmartsheetDateTime(startDateStr, startTimeStr, 9, 0);
  if (!startParsed) {
    logger.debug(`Row ${row.id}: Invalid start date "${startDateStr}", skipping`);
    return null;
  }

  // If start time is neither a specific time nor an all-day event, skip calendar sync
  if (!startParsed.hasTime && !startParsed.isAllDay) {
    logger.debug(`Row ${row.id}: Start time and end time are blank, skipping calendar sync`);
    return null;
  }

  let endParsed = parseSmartsheetDateTime(endDateStr || startDateStr, endTimeStr, 10, 0);
  if (!endParsed || (!endDateStr && !endTimeStr && startParsed.hasTime)) {
    if (startParsed.hasTime && startParsed.dateTime) {
      const sDate = new Date(startParsed.dateTime);
      sDate.setHours(sDate.getHours() + 1);
      endParsed = {
        dateTime: sDate.toISOString(),
        dateOnly: startParsed.dateOnly,
        hasTime: true,
        isAllDay: false,
      };
    } else {
      endParsed = {
        dateOnly: startParsed.dateOnly,
        hasTime: false,
        isAllDay: startParsed.isAllDay,
      };
    }
  }

  const event: CalendarEventData = {
    summary: title,
    start: startParsed.isAllDay || !startParsed.hasTime
      ? { date: startParsed.dateOnly, timeZone: timezone }
      : { dateTime: startParsed.dateTime!, timeZone: timezone },
    end: startParsed.isAllDay || !endParsed.hasTime
      ? { date: endParsed.dateOnly || startParsed.dateOnly, timeZone: timezone }
      : { dateTime: endParsed.dateTime || startParsed.dateTime!, timeZone: timezone },
  };

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

/**
 * Full sync: compare all Smartsheet rows with stored records and sync differences.
 */
export async function fullSync(configId: string): Promise<SyncResult> {
  const config = await prisma.syncConfiguration.findUnique({
    where: { id: configId },
    include: { user: true },
  });

  if (!config) throw Object.assign(new Error('Sync configuration not found'), { statusCode: 404 });

  const userId = config.userId;
  const columnMapping = config.columnMapping as ColumnMapping;
  const timezone = env.DEFAULT_TIMEZONE;
  const result: SyncResult = { created: 0, updated: 0, deleted: 0, failed: 0, errors: [] };

  logger.info(`Starting full sync for config ${configId}`);

  try {
    // Fetch all rows from Smartsheet
    const rows = await smartsheetService.getSheetRows(userId, config.smartsheetSheetId);
    const rowIds = new Set(rows.map((r: any) => r.id.toString()));

    // Get existing sync records
    const existingRecords = await prisma.syncRecord.findMany({
      where: { syncConfigId: configId },
    });
    const recordMap = new Map(existingRecords.map((r) => [r.smartsheetRowId, r]));

    // Process each row
    for (const row of rows) {
      const rowId = row.id.toString();
      const existingRecord = recordMap.get(rowId);

      // ⚡ EFFICIENCY OPTIMIZATION:
      // If record is already synced and row has not changed at all, SKIP COMPLETELY!
      // Do NOT call Groq LLM or Google Calendar API for untouched rows!
      if (existingRecord && existingRecord.syncStatus === 'synced' && !hasRowChanged(row, existingRecord.rowData)) {
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

        if (!existingRecord) {
          // CREATE: New row, create calendar event
          const eventId = await googleService.createEvent(
            userId,
            config.googleCalendarId,
            eventData
          );
          await prisma.syncRecord.create({
            data: {
              syncConfigId: configId,
              smartsheetRowId: rowId,
              googleEventId: eventId,
              syncStatus: 'synced',
              syncAction: 'create',
              lastSyncedAt: new Date(),
              rowData: row,
            },
          });
          result.created++;
        } else if (hasRowChanged(row, existingRecord.rowData) || existingRecord.syncStatus !== 'synced') {
          // UPDATE: Row changed, update calendar event
          if (existingRecord.googleEventId) {
            await googleService.updateEvent(
              userId,
              config.googleCalendarId,
              existingRecord.googleEventId,
              eventData
            );
          } else {
            const eventId = await googleService.createEvent(
              userId,
              config.googleCalendarId,
              eventData
            );
            existingRecord.googleEventId = eventId;
          }
          await prisma.syncRecord.update({
            where: { id: existingRecord.id },
            data: {
              googleEventId: existingRecord.googleEventId,
              syncStatus: 'synced',
              syncAction: 'update',
              lastSyncedAt: new Date(),
              lastError: null,
              rowData: row,
            },
          });
          result.updated++;
        }
        // else: no changes, skip
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
 * Sync a single row (used by webhooks).
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

    if (action === 'created' || !existingRecord?.googleEventId) {
      // CREATE — Idempotency: if record exists with event ID, update instead
      if (existingRecord?.googleEventId) {
        await googleService.updateEvent(userId, config.googleCalendarId, existingRecord.googleEventId, eventData);
        await prisma.syncRecord.update({
          where: { id: existingRecord.id },
          data: { syncStatus: 'synced', syncAction: 'update', lastSyncedAt: new Date(), lastError: null, rowData: row },
        });
      } else {
        const eventId = await googleService.createEvent(userId, config.googleCalendarId, eventData);
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
    } else {
      // UPDATE
      await googleService.updateEvent(userId, config.googleCalendarId, existingRecord.googleEventId, eventData);
      await prisma.syncRecord.update({
        where: { id: existingRecord.id },
        data: { syncStatus: 'synced', syncAction: 'update', lastSyncedAt: new Date(), lastError: null, rowData: row },
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
