import test from 'node:test';
import assert from 'node:assert/strict';
import { logger, getSystemLogs, clearSystemLogs } from '../src/utils/logger.js';
import { getAllConfigsWithStats, retryAllFailedRecords, syncTargetRows, syncDependencies } from '../src/services/sync.service.js';

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
import { mapRowToEvent, resolveRowColorId } from '../src/services/eventParser.js';
import { sameEvent, inputHash } from '../src/utils/eventIdentity.js';
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

  // Smartsheet cell format string (descriptor 9 is bg_color mapped via official palette)
  assert.equal(mapSmartsheetFormatToColor(',,,,,,,,,21,,,,,,'), '5'); // Yellow (Banana)
  assert.equal(mapSmartsheetFormatToColor(',,,,,,,,,15,,,,,,'), '7'); // Light Blue (Peacock)
  assert.equal(mapSmartsheetFormatToColor(',,,,,,,,,11,,,,,,'), '4'); // Pink (Flamingo)
  assert.equal(mapSmartsheetFormatToColor(',,,,,,,,,14,,,,,,'), '2'); // Light Green (Sage)
  assert.equal(mapSmartsheetFormatToColor(',,,,,,,,,27,,,,,,'), '11'); // Red (Tomato)
  assert.equal(mapSmartsheetFormatToColor(',,,,,,,,,28,,,,,,'), '6'); // Orange (Tangerine)
  assert.equal(mapSmartsheetFormatToColor(',,,,,,,,,18,,,,,,'), '8'); // Gray (Graphite)
  assert.equal(mapSmartsheetFormatToColor(',,,,,,,,,9,,,,,,'), '1'); // Lavender
  assert.equal(mapSmartsheetFormatToColor(',,,,,,,,,32,,,,,,'), '3'); // Grape

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
  assert.equal(parsedWithoutColor.colorId, undefined, 'Unmapped color column must be undefined so no color is assigned from our own');
});

test('sameEvent and buildCalendarPatch respect colorId and color clearing', () => {
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

  // Mismatch when color is cleared in sheet (colorId: null) vs existing calendar color ('5')
  assert.equal(sameEvent({ ...baseEvent, colorId: '5' }, { ...baseEvent, colorId: null }, 'UTC'), false);

  // Match when both have no color
  assert.equal(sameEvent({ ...baseEvent, colorId: undefined }, { ...baseEvent, colorId: null }, 'UTC'), true);

  // buildCalendarPatch includes colorId when specified
  const patchWithColor = buildCalendarPatch({ ...baseEvent, colorId: '5' });
  assert.equal(patchWithColor.colorId, '5');

  // buildCalendarPatch passes null when colorId is cleared to reset on Google Calendar
  const patchCleared = buildCalendarPatch({ ...baseEvent, colorId: null });
  assert.equal(patchCleared.colorId, null);
});

test('resolveRowColorId and inputHash accurately track cell, row, and cleared color changes', () => {
  const mapping = { title: 'title', startDate: 'date', color: 'subCategory' };

  // 1. Keyword / Subcategory
  assert.equal(resolveRowColorId({ cells: { subCategory: { value: 'Upcoming Event' } } }, mapping), '5');
  assert.equal(resolveRowColorId({ cells: { subCategory: { value: 'Promo Slide' } } }, mapping), '7');
  assert.equal(resolveRowColorId({ cells: { subCategory: { value: '2x3 Signs' } } }, mapping), '2'); // Sage (Light Green)
  assert.equal(resolveRowColorId({ cells: { subCategory: { value: 'Road Sign' } } }, mapping), '2');
  assert.equal(resolveRowColorId({ cells: { subCategory: { value: 'App Home Feature' } } }, mapping), '7');

  // 1b. Category fallback when subcategory has an unusual name
  assert.equal(resolveRowColorId({
    cells: {
      subCategory: { value: 'Custom Foam Board Special' },
      cat: { columnTitle: 'Category', value: 'Signage' }
    }
  }, mapping), '2');

  // 2. Cell format background color (27 = Red Tomato)
  assert.equal(resolveRowColorId({ cells: { subCategory: { format: ',,,,,,,,,27,,,,,,' } } }, mapping), '11');

  // 2b. Cell format object with conditionalFormat (14 = Soft Green Sage)
  assert.equal(resolveRowColorId({ cells: { subCategory: { format: { conditionalFormat: ',,,,,,,,,14,,,,,,' } } } }, mapping), '2');

  // 3. Row format background color (21 = Yellow Banana)
  assert.equal(resolveRowColorId({ format: ',,,,,,,,,21,,,,,,', cells: { subCategory: {} } }, mapping), '5');

  // 4. Cleared color (mapped column empty and no format) -> returns null to clear calendar color
  assert.equal(resolveRowColorId({ cells: { subCategory: {} } }, mapping), null);

  // 5. Unmapped color column MUST NOT pick colors from row format or cells -> returns undefined
  assert.equal(resolveRowColorId({ format: ',,,,,,,,,15,,,,,,', cells: { a: { format: ',,,,,,,,,15,,,,,,' } } }, { title: 'title', startDate: 'date' }), undefined);

  // 6. Unmapped color column with empty cells -> returns undefined
  assert.equal(resolveRowColorId({ cells: {} }, { title: 'title', startDate: 'date' }), undefined);

  // 7. inputHash changes when row.format changes
  const rowA = { format: ',,,,,,,,,14,,,,,,', cells: { a: { value: 'test' } } };
  const rowB = { format: ',,,,,,,,,10,,,,,,', cells: { a: { value: 'test' } } };
  assert.notEqual(inputHash(rowA, mapping, 'UTC'), inputHash(rowB, mapping, 'UTC'));
});

test('mapRowToEvent creates all-day events when startTime column is unmapped, supporting 2-digit years and ranges', async () => {
  const rowPromoSingleDay = {
    id: 'row-promo-1',
    cells: {
      title: { value: 'Communion - Newsletter Upcoming Event' },
      promoStart: { value: '01/05/27' },
      promoEnd: { value: '01/05/27' },
      subCategory: { value: 'Upcoming Event' },
    },
  };

  const promoMapping = {
    title: 'title',
    startDate: 'promoStart',
    endDate: 'promoEnd',
    color: 'subCategory',
  };

  const event1 = await mapRowToEvent(rowPromoSingleDay, promoMapping, 'Asia/Kolkata');
  assert.ok(event1, 'Event should be created for date-only row without startTime mapped');
  assert.equal(event1.summary, 'Communion - Newsletter Upcoming Event');
  assert.equal(event1.start.date, '2027-01-05');
  assert.equal(event1.end.date, '2027-01-06'); // 1 day event in Google Calendar API has next-day exclusive end
  assert.equal(event1.colorId, '5'); // Banana / Yellow for Upcoming Event

  // Multi-day range (e.g. 12/27/26 to 01/03/27)
  const rowPromoMultiDay = {
    id: 'row-promo-2',
    cells: {
      title: { value: 'Communion - Promo Slide' },
      promoStart: { value: '12/27/26' },
      promoEnd: { value: '01/03/27' },
      subCategory: { value: 'Promo Slide' },
    },
  };

  const event2 = await mapRowToEvent(rowPromoMultiDay, promoMapping, 'Asia/Kolkata');
  assert.ok(event2);
  assert.equal(event2.summary, 'Communion - Promo Slide');
  assert.equal(event2.start.date, '2026-12-27');
  assert.equal(event2.end.date, '2027-01-04'); // Dec 27 through Jan 3 inclusive -> Jan 4 exclusive
  assert.equal(event2.colorId, '7'); // Peacock

  // Blank start date (e.g. header rows like 'INSTRUCTIONS' or 'JANUARY') is safely skipped
  const headerRow = {
    id: 'header-row',
    cells: {
      title: { value: 'JANUARY' },
      promoStart: { value: '' },
    },
  };
  const headerEvent = await mapRowToEvent(headerRow, promoMapping, 'Asia/Kolkata');
  assert.equal(headerEvent, null, 'Header row without start date must return null');
});

test('syncTargetRows performs fast targeted update on changed row with new color', async () => {
  const originalDb = syncDependencies.db;
  const originalGoogle = syncDependencies.google;
  const originalSmartsheet = syncDependencies.smartsheet;

  let updatedEventPayload: any = null;
  let updatedRecordPayload: any = null;

  (syncDependencies as any).db = {
    syncConfiguration: {
      findUnique: async () => ({
        id: 'cfg-fast',
        isEnabled: true,
        userId: 'u1',
        smartsheetSheetId: 'sheet-1',
        googleCalendarId: 'cal-1',
        columnMapping: { title: 't', startDate: 'd', color: 'c' },
      }),
    },
    syncRecord: {
      findUnique: async () => ({
        id: 'rec-1',
        syncConfigId: 'cfg-fast',
        smartsheetRowId: 'row-100',
        googleEventId: 'gcal-evt-100',
        syncStatus: 'synced',
      }),
      update: async ({ data }: any) => {
        updatedRecordPayload = data;
        return { id: 'rec-1', ...data };
      },
      upsert: async () => ({ id: 'rec-1' }),
    },
  };

  (syncDependencies as any).google = {
    getCalendarTimezone: async () => 'UTC',
    updateEvent: async (_userId: string, _calendarId: string, _eventId: string, desired: any) => {
      updatedEventPayload = desired;
    },
    createEvent: async () => 'new-gcal-id',
    deleteEvent: async () => {},
  };

  // Row has cell with color format 27 (Tomato / Red)
  (syncDependencies as any).smartsheet = {
    getRow: async () => ({
      id: 'row-100',
      cells: {
        t: { value: 'Urgent Strategy Meeting' },
        d: { value: '2026-11-25' },
        c: { format: ',,,,,,,,,27,,,,,,' },
      },
    }),
  };

  try {
    const result = await syncTargetRows('cfg-fast', ['row-100']);
    assert.equal(result.updated, 1, 'Should update 1 row directly');
    assert.ok(updatedEventPayload, 'Google Calendar updateEvent should be called');
    assert.equal(updatedEventPayload.colorId, '11', 'Should update colorId to 11 (Tomato) for format 27');
    assert.ok(updatedRecordPayload, 'Sync record should be updated');
    assert.equal(updatedRecordPayload.parsedEvent.colorId, '11');
  } finally {
    (syncDependencies as any).db = originalDb;
    (syncDependencies as any).google = originalGoogle;
    (syncDependencies as any).smartsheet = originalSmartsheet;
  }
});
