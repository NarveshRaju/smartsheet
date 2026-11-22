import test from 'node:test';
import assert from 'node:assert/strict';
import { logger, getSystemLogs, clearSystemLogs } from '../src/utils/logger.js';
import { getAllConfigsWithStats, retryAllFailedRecords, syncDependencies } from '../src/services/sync.service.js';

test('system logger captures logs in memory buffer with level and search filtering', () => {
  clearSystemLogs();
  logger.info('Project Alpha: initial sync complete');
  logger.warn('Project Beta: rate limit reached');
  logger.error('Project Alpha: connection failed to calendar');

  const allLogs = getSystemLogs({ limit: 10 });
  assert.equal(allLogs.logs.length, 3);
  assert.equal(allLogs.total, 3);

  // Filter by level
  const errorLogs = getSystemLogs({ level: 'error' });
  assert.equal(errorLogs.logs.length, 1);
  assert.match(errorLogs.logs[0].message, /connection failed/);

  const warnLogs = getSystemLogs({ level: 'warn' });
  assert.equal(warnLogs.logs.length, 1);
  assert.match(warnLogs.logs[0].message, /rate limit/);

  // Filter by search query
  const alphaLogs = getSystemLogs({ search: 'Alpha' });
  assert.equal(alphaLogs.logs.length, 2);

  const betaLogs = getSystemLogs({ search: 'Beta' });
  assert.equal(betaLogs.logs.length, 1);

  clearSystemLogs();
  const cleared = getSystemLogs();
  assert.equal(cleared.logs.length, 0);
});

test('getAllConfigsWithStats aggregates stats across multiple configurations', async () => {
  const mockConfigs = [
    {
      id: 'cfg-1',
      userId: 'user-1',
      name: 'Marketing Roadmap',
      smartsheetSheetId: 'sheet-1',
      sheetName: 'Marketing',
      googleCalendarId: 'cal-1',
      calendarName: 'Marketing Cal',
      columnMapping: {},
      isEnabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: 'cfg-2',
      userId: 'user-1',
      name: 'Engineering Sprints',
      smartsheetSheetId: 'sheet-2',
      sheetName: 'Engineering',
      googleCalendarId: 'cal-2',
      calendarName: 'Dev Cal',
      columnMapping: {},
      isEnabled: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];

  syncDependencies.db = {
    syncConfiguration: {
      findMany: async () => mockConfigs,
    },
    syncRecord: {
      count: async ({ where }: any) => {
        if (where.syncConfigId === 'cfg-1') {
          if (where.syncStatus === 'synced') return 15;
          if (where.syncStatus === 'failed') return 2;
          return 17;
        }
        if (where.syncConfigId === 'cfg-2') {
          if (where.syncStatus === 'synced') return 30;
          return 30;
        }
        return 0;
      },
      updateMany: async () => ({ count: 2 }),
    },
  } as any;

  const result = await getAllConfigsWithStats('user-1');
  assert.equal(result.length, 2);
  assert.equal(result[0].name, 'Marketing Roadmap');
  assert.equal(result[0].stats?.total, 17);
  assert.equal(result[0].stats?.synced, 15);
  assert.equal(result[0].stats?.failed, 2);
  assert.equal(result[1].name, 'Engineering Sprints');
  assert.equal(result[1].stats?.synced, 30);
});
