import { randomUUID } from 'node:crypto';
import { prisma } from './db.js';
import * as googleService from './google.service.js';
import * as smartsheetService from './smartsheet.service.js';
import { mapRowToEvent } from './eventParser.js';
import { eventFingerprint, sameEvent, inputHash, stableEventId } from '../utils/eventIdentity.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import type { CalendarEventData, ColumnMapping, SyncResult } from '../types/index.js';

export const syncDependencies = { db: prisma, google: { ...googleService }, smartsheet: { ...smartsheetService }, parse: mapRowToEvent };
const activeSyncMap = new Map<string, Promise<SyncResult>>();
const emptyResult = (): SyncResult => ({ created: 0, updated: 0, deleted: 0, failed: 0, errors: [] });

export async function fullSync(configId: string): Promise<SyncResult> {
  const active = activeSyncMap.get(configId);
  if (active) return active;
  const promise = executeFullSync(configId);
  activeSyncMap.set(configId, promise);
  try { return await promise; }
  finally { activeSyncMap.delete(configId); }
}

async function executeFullSync(configId: string): Promise<SyncResult> {
  const owner = randomUUID();
  const lease = await syncDependencies.db.syncConfiguration.updateMany({
    where: { id: configId, OR: [
      { syncLeaseUntil: null }, { syncLeaseUntil: { isSet: false } },
      { syncLeaseUntil: { lt: new Date() } },
    ] },
    data: { syncLeaseOwner: owner, syncLeaseUntil: new Date(Date.now() + 600_000) },
  });
  if (!lease.count) throw Object.assign(new Error('Sync is already running; the next scheduled run will catch up.'), { statusCode: 409 });
  const result = emptyResult();
  let renewedAt = Date.now();
  const renew = async () => {
    if (Date.now() - renewedAt < 30_000) return;
    const renewed = await syncDependencies.db.syncConfiguration.updateMany({
      where: { id: configId, syncLeaseOwner: owner, syncLeaseUntil: { gt: new Date() } },
      data: { syncLeaseUntil: new Date(Date.now() + 600_000) },
    });
    if (!renewed.count) throw new Error('Sync lease expired; retry on next run');
    renewedAt = Date.now();
  };
  try {
    const config = await syncDependencies.db.syncConfiguration.findUniqueOrThrow({ where: { id: configId } });
    const { userId, googleCalendarId: calendarId, smartsheetSheetId: sheetId } = config;
    const timezone = await syncDependencies.google.getCalendarTimezone(userId, calendarId);
    // A failed calendar listing aborts the run: never treat a failed lookup as an empty calendar.
    const [rows, records, events] = await Promise.all([
      syncDependencies.smartsheet.getSheetRows(userId, sheetId),
      syncDependencies.db.syncRecord.findMany({ where: { syncConfigId: configId } }),
      syncDependencies.google.listCalendarEvents(userId, calendarId),
    ]);
    const recordMap = new Map(records.map(r => [r.smartsheetRowId, r]));
    const byId = new Map(events.filter(e => e.id && e.status !== 'cancelled').map(e => [e.id!, e]));
    const bySource = new Map<string, (typeof events)[number]>();
    const byContent = new Map<string, (typeof events)>();
    for (const event of byId.values()) {
      const tags = event.extendedProperties?.private;
      if (tags?.smartsheetSheetId === sheetId && tags.smartsheetRowId) bySource.set(tags.smartsheetRowId, event);
      // Only unowned events can be adopted by content. Never steal another row's event.
      if (!tags?.smartsheetRowId && !event.recurringEventId && !event.recurrence) {
        try {
          const key = eventFingerprint(event, timezone);
          byContent.set(key, [...(byContent.get(key) || []), event]);
        } catch { /* Ignore calendar entries with an unsupported boundary. */ }
      }
    }
    const claimed = new Set<string>();
    // Reserve saved links before iterating so an earlier row cannot adopt a later row's event.
    const reserved = new Map(records.filter(r => r.googleEventId && r.syncStatus !== 'deleted').map(r => [r.googleEventId!, r.smartsheetRowId]));
    const rowIds = new Set(rows.map((r: any) => String(r.id)));
    // Quota-deferred rows retain priority over rows that consumed an AI attempt and failed.
    rows.sort((a: any, b: any) => (recordMap.get(String(a.id))?.retryCount || 0) - (recordMap.get(String(b.id))?.retryCount || 0));
    for (const row of rows) {
      await renew();
      const rowId = String(row.id);
      const record = recordMap.get(rowId);
      const hash = inputHash(row, config.columnMapping, timezone);
      if (record?.nextRetryAt && record.nextRetryAt > new Date() && record.failedInputHash === hash) {
        result.failed++;
        result.errors.push({ rowId, error: record.lastError || 'Waiting to retry' });
        continue;
      }
      try {
        const eventData = record?.inputHash === hash && record.parsedEvent
          ? record.parsedEvent as unknown as CalendarEventData
          : await syncDependencies.parse(row, config.columnMapping as ColumnMapping, timezone);
        await renew();
        const linked = record?.googleEventId ? byId.get(record.googleEventId) : undefined;
        const linkedTags = linked?.extendedProperties?.private;
        let target = linked && !claimed.has(linked.id!) &&
          (!linkedTags?.smartsheetRowId || (linkedTags.smartsheetRowId === rowId && linkedTags.smartsheetSheetId === sheetId))
          ? linked : bySource.get(rowId);
        if (!eventData || eventData.status === 'cancelled') {
          // Only explicit missing required fields produce null. Parse/AI failures throw and preserve events.
          if (target?.id && !claimed.has(target.id)) {
            claimed.add(target.id);
            await syncDependencies.google.deleteEvent(userId, calendarId, target.id);
            result.deleted++;
          }
          if (record) await syncDependencies.db.syncRecord.update({ where: { id: record.id }, data: {
            syncStatus: 'deleted', syncAction: 'delete', lastError: null, lastSyncedAt: new Date(),
          } });
          continue;
        }
        if (!target || claimed.has(target.id!)) {
          target = (byContent.get(eventFingerprint(eventData, timezone)) || []).find(e =>
            !claimed.has(e.id!) && (!reserved.has(e.id!) || reserved.get(e.id!) === rowId));
        }
        const desired: CalendarEventData = { ...eventData, extendedProperties: { private: {
          ...(target?.extendedProperties?.private || {}), smartsheetSheetId: sheetId, smartsheetRowId: rowId,
        } } };
        let eventId: string;
        let action = 'linked';
        if (target?.id) {
          eventId = target.id;
          claimed.add(eventId);
          const tags = target.extendedProperties?.private;
          if (!sameEvent(target, desired, timezone) || tags?.smartsheetRowId !== rowId || tags?.smartsheetSheetId !== sheetId) {
            await syncDependencies.google.updateEvent(userId, calendarId, eventId, desired);
            result.updated++;
            action = 'update';
          } else if (record?.syncStatus === 'synced' && record.inputHash === hash && record.googleEventId === eventId) {
            continue; // No Calendar write and no per-row database write for unchanged rows.
          }
        } else {
          eventId = await syncDependencies.google.createEvent(userId, calendarId, desired, stableEventId(sheetId, rowId));
          claimed.add(eventId);
          result.created++;
          action = 'create';
        }
        const data = { googleEventId: eventId, syncStatus: 'synced', syncAction: action,
          lastSyncedAt: new Date(), lastError: null, retryCount: 0, nextRetryAt: null, inputHash: hash, parsedEvent: JSON.parse(JSON.stringify(eventData)) };
        await syncDependencies.db.syncRecord.upsert({
          where: { syncConfigId_smartsheetRowId: { syncConfigId: configId, smartsheetRowId: rowId } },
          create: { syncConfigId: configId, smartsheetRowId: rowId, ...data }, update: data,
        });
      } catch (error: any) {
        result.failed++;
        result.errors.push({ rowId, error: error.message });
        const quotaDeferred = /cooldown|rate limit/i.test(error.message);
        const attempts = /cooldown/i.test(error.message) ? 0 : 1;
        const nextRetryAt = new Date(Date.now() + (quotaDeferred ? 60_000 : 600_000));
        await syncDependencies.db.syncRecord.upsert({
          where: { syncConfigId_smartsheetRowId: { syncConfigId: configId, smartsheetRowId: rowId } },
          create: { syncConfigId: configId, smartsheetRowId: rowId, syncStatus: 'failed', lastError: error.message, nextRetryAt, failedInputHash: hash, retryCount: attempts },
          update: { syncStatus: 'failed', lastError: error.message, retryCount: { increment: attempts }, nextRetryAt, failedInputHash: hash },
        });
      }
    }
    for (const record of records) {
      if (rowIds.has(record.smartsheetRowId) || record.syncStatus === 'deleted') continue;
      await renew();
      try {
        const event = record.googleEventId ? byId.get(record.googleEventId) : undefined;
        const tags = event?.extendedProperties?.private;
        if (event?.id && !claimed.has(event.id) && tags?.smartsheetSheetId === sheetId && tags.smartsheetRowId === record.smartsheetRowId) {
          await syncDependencies.google.deleteEvent(userId, calendarId, event.id);
        }
        await syncDependencies.db.syncRecord.update({ where: { id: record.id }, data: { syncStatus: 'deleted', syncAction: 'delete', lastError: null, lastSyncedAt: new Date() } });
        result.deleted++;
      } catch (error: any) {
        result.failed++;
        result.errors.push({ rowId: record.smartsheetRowId, error: error.message });
        await syncDependencies.db.syncRecord.update({ where: { id: record.id }, data: { syncStatus: 'failed', syncAction: 'delete', lastError: error.message } });
      }
    }
    await syncDependencies.db.syncConfiguration.update({ where: { id: configId }, data: { lastFullSyncAt: new Date() } });
    return result;
  } finally {
    await syncDependencies.db.syncConfiguration.updateMany({ where: { id: configId, syncLeaseOwner: owner }, data: { syncLeaseOwner: null, syncLeaseUntil: null } });
  }
}

// All entry points share the same reconciliation and lock, including webhook bursts.
export async function syncRow(configId: string, _rowId: string, _action: 'created' | 'updated' | 'deleted'): Promise<void> {
  const config = await syncDependencies.db.syncConfiguration.findUnique({ where: { id: configId } });
  if (config?.isEnabled) {
    const result = await fullSync(configId);
    if (result.failed) throw new Error(result.errors.map(e => e.error).join('; '));
  }
}

export async function retrySyncRecord(recordId: string): Promise<void> {
  const record = await syncDependencies.db.syncRecord.findUniqueOrThrow({ where: { id: recordId } });
  await syncDependencies.db.syncRecord.update({ where: { id: record.id }, data: { nextRetryAt: null } });
  const result = await fullSync(record.syncConfigId);
  const failed = result.errors.find(e => e.rowId === record.smartsheetRowId);
  if (failed) throw new Error(failed.error);
}

export async function getSyncStatus(configId: string) {
  const config = await syncDependencies.db.syncConfiguration.findUnique({
    where: { id: configId },
  });

  if (!config) throw Object.assign(new Error('Sync configuration not found'), { statusCode: 404 });

  const [total, synced, failed, pending, deleted] = await Promise.all([
    syncDependencies.db.syncRecord.count({ where: { syncConfigId: configId } }),
    syncDependencies.db.syncRecord.count({ where: { syncConfigId: configId, syncStatus: 'synced' } }),
    syncDependencies.db.syncRecord.count({ where: { syncConfigId: configId, syncStatus: 'failed' } }),
    syncDependencies.db.syncRecord.count({ where: { syncConfigId: configId, syncStatus: 'pending' } }),
    syncDependencies.db.syncRecord.count({ where: { syncConfigId: configId, syncStatus: 'deleted' } }),
  ]);

  const failedRecords = await syncDependencies.db.syncRecord.findMany({
    where: { syncConfigId: configId, syncStatus: 'failed' },
    orderBy: { updatedAt: 'desc' },
    take: 50,
  });

  const recentRecords = await syncDependencies.db.syncRecord.findMany({
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

  const intervalMs = Math.max(10000, parseInt(env.AUTO_SYNC_INTERVAL_MS, 10) || 60000);
  logger.info(`🔄 Starting Auto-Sync background worker (polling every ${intervalMs / 1000}s)`);

  // Run a quick tick shortly after start
  setTimeout(async () => {
    await runAutoSyncTick();
  }, 5000);

  autoSyncTimer = setInterval(async () => {
    await runAutoSyncTick();
  }, intervalMs);
}

export async function runAutoSyncTick(): Promise<void> {
  if (isSyncRunning) {
    logger.debug('Auto-sync already in progress, skipping tick');
    return;
  }

  try {
    isSyncRunning = true;
    const activeConfigs = await syncDependencies.db.syncConfiguration.findMany({
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
