import { PrismaClient } from '@prisma/client';
import * as googleService from './google.service.js';
import * as smartsheetService from './smartsheet.service.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import type { CalendarEventData, ColumnMapping, SyncResult } from '../types/index.js';

const prisma = new PrismaClient();

/**
 * Map a Smartsheet row to Google Calendar event data using the configured column mapping.
 */
function mapRowToEvent(
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
  const endDateStr = getCellValue(columnMapping.endDate);

  if (!startDateStr) {
    logger.debug(`Row ${row.id}: No start date found, skipping`);
    return null;
  }

  // Determine if we have time or just date
  const hasTime = (str: string) => /\d{1,2}:\d{2}/.test(str);

  const startHasTime = hasTime(startDateStr);
  const startDate = new Date(startDateStr);

  let endDate: Date;
  if (endDateStr) {
    endDate = new Date(endDateStr);
  } else {
    // Default: 1 hour for timed events, same day for all-day events
    endDate = new Date(startDate);
    if (startHasTime) {
      endDate.setHours(endDate.getHours() + 1);
    }
  }

  const event: CalendarEventData = {
    summary: title,
    start: startHasTime
      ? { dateTime: startDate.toISOString(), timeZone: timezone }
      : { date: startDate.toISOString().split('T')[0], timeZone: timezone },
    end: startHasTime || (endDateStr && hasTime(endDateStr))
      ? { dateTime: endDate.toISOString(), timeZone: timezone }
      : { date: endDate.toISOString().split('T')[0], timeZone: timezone },
  };

  const description = getCellValue(columnMapping.description);
  if (description) event.description = description;

  const location = getCellValue(columnMapping.location);
  if (location) event.location = location;

  const attendee = getCellValue(columnMapping.attendee);
  if (attendee) {
    // Support comma-separated emails
    event.attendees = attendee
      .split(/[,;\s]+/)
      .filter((e) => e.includes('@'))
      .map((email) => ({ email: email.trim() }));
  }

  const status = getCellValue(columnMapping.status);
  if (status) {
    // Map common status values
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
 * Check if row data has changed compared to stored snapshot.
 */
function hasRowChanged(newRow: any, storedData: any): boolean {
  if (!storedData) return true;
  const newCells = JSON.stringify(newRow.cells);
  const oldCells = JSON.stringify(storedData.cells);
  return newCells !== oldCells;
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

      try {
        const eventData = mapRowToEvent(row, columnMapping, timezone);
        if (!eventData) continue; // Skip rows without required fields

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
        } else if (hasRowChanged(row, existingRecord.rowData)) {
          // UPDATE: Row changed, update calendar event
          if (existingRecord.googleEventId) {
            await googleService.updateEvent(
              userId,
              config.googleCalendarId,
              existingRecord.googleEventId,
              eventData
            );
          } else {
            // Edge case: record exists but no event ID (previous create failed?)
            const eventId = await googleService.createEvent(
              userId,
              config.googleCalendarId,
              eventData
            );
            await prisma.syncRecord.update({
              where: { id: existingRecord.id },
              data: {
                googleEventId: eventId,
                syncStatus: 'synced',
                syncAction: 'create',
                lastSyncedAt: new Date(),
                lastError: null,
                rowData: row,
              },
            });
            result.created++;
            continue;
          }
          await prisma.syncRecord.update({
            where: { id: existingRecord.id },
            data: {
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

    const eventData = mapRowToEvent(row, columnMapping, timezone);
    if (!eventData) {
      logger.debug(`Row ${rowId}: Missing required fields, skipping`);
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
