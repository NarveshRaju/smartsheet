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


import { parseColorToGoogleColorId, matchHexToGoogleColor, mapSmartsheetFormatToColor } from '../src/utils/colorMapper.js';
import { mapRowToEvent } from '../src/services/eventParser.js';
import { sameEvent } from '../src/utils/eventIdentity.js';
import { buildCalendarPatch } from '../src/utils/calendarPatch.js';

test('colorMapper resolves color codes, names, subcategory text, and Smartsheet cell formats', () => {
  // Direct Google Calendar colorId
  assert.equal(parseColorToGoogleColorId('5'), '5');
  assert.equal(parseColorToGoogleColorId('11'), '11');

  // Hex codes
  assert.equal(matchHexToGoogleColor('#FFFF00'), '5'); // Yellow -> Banana (5)
  assert.equal(matchHexToGoogleColor('#FF0000'), '11'); // Red -> Tomato (11)
  assert.equal(matchHexToGoogleColor('#039BE5'), '7'); // Light Blue -> Peacock (7)
  assert.equal(matchHexToGoogleColor('#33B679'), '2'); // Light Green -> Sage (2)

  // Color names
  assert.equal(parseColorToGoogleColorId('yellow'), '5');
  assert.equal(parseColorToGoogleColorId('blue'), '9');
  assert.equal(parseColorToGoogleColorId('pink'), '4');
  assert.equal(parseColorToGoogleColorId('green'), '10');
  assert.equal(parseColorToGoogleColorId('orange'), '6');

  // Sub-Category values from user's Smartsheet
  assert.equal(parseColorToGoogleColorId('Upcoming Event'), '5');
  assert.equal(parseColorToGoogleColorId('Promo Slide'), '7');
  assert.equal(parseColorToGoogleColorId('Events Page'), '4');
  assert.equal(parseColorToGoogleColorId('Announcements'), '6');
  assert.equal(parseColorToGoogleColorId('Restroom Posters'), '2');
  assert.equal(parseColorToGoogleColorId('Social Media'), '8');
  assert.equal(parseColorToGoogleColorId('Newsletter Feature Mention'), '5');

  // Smartsheet cell format string (descriptor 9 is bg_color)
  assert.equal(mapSmartsheetFormatToColor(',,,,,,,,,14,,,,,,'), '5'); // Yellow
  assert.equal(mapSmartsheetFormatToColor(',,,,,,,,,18,,,,,,'), '7'); // Cyan/Light Blue
  assert.equal(mapSmartsheetFormatToColor(',,,,,,,,,11,,,,,,'), '4'); // Pink
  assert.equal(mapSmartsheetFormatToColor(',,,,,,,,,17,,,,,,'), '2'); // Light Green

  // Optionality / blank handling
  assert.equal(parseColorToGoogleColorId(undefined, undefined), undefined);
  assert.equal(parseColorToGoogleColorId('', ''), undefined);
  assert.equal(parseColorToGoogleColorId('   '), undefined);
});

test('mapRowToEvent assigns colorId when color column is mapped, and ignores when unmapped', async () => {
  const rowWithColor = {
    id: 'row-1',
    cells: {
      title: { value: 'Annual Gala' },
      date: { value: '2026-10-15' },
      time: { value: '18:00' },
      subCategory: { value: 'Promo Slide' },
    },
  };

  const mappingWithColor = {
    title: 'title',
    startDate: 'date',
    startTime: 'time',
    color: 'subCategory',
  };

  const parsedWithColor = await mapRowToEvent(rowWithColor, mappingWithColor, 'Asia/Kolkata');
  assert.ok(parsedWithColor);
  assert.equal(parsedWithColor.colorId, '7'); // Peacock

  // Without color column mapped
  const mappingWithoutColor = {
    title: 'title',
    startDate: 'date',
    startTime: 'time',
  };

  const parsedWithoutColor = await mapRowToEvent(rowWithColor, mappingWithoutColor, 'Asia/Kolkata');
  assert.ok(parsedWithoutColor);
  assert.equal(parsedWithoutColor.colorId, undefined);
});

test('sameEvent and buildCalendarPatch respect colorId', () => {
  const baseEvent: any = {
    summary: 'Meeting',
    start: { dateTime: '2026-10-15T09:00:00' },
    end: { dateTime: '2026-10-15T10:00:00' },
  };

  // Same event when desired does not specify colorId (preserves calendar's color)
  assert.equal(sameEvent({ ...baseEvent, colorId: '7' }, baseEvent, 'UTC'), true);

  // Mismatch when desired specifies different colorId
  assert.equal(sameEvent({ ...baseEvent, colorId: '7' }, { ...baseEvent, colorId: '5' }, 'UTC'), false);

  // Match when desired specifies identical colorId
  assert.equal(sameEvent({ ...baseEvent, colorId: '5' }, { ...baseEvent, colorId: '5' }, 'UTC'), true);

  // buildCalendarPatch includes colorId when specified
  const patch = buildCalendarPatch({ ...baseEvent, colorId: '5' });
  assert.equal(patch.colorId, '5');
});
