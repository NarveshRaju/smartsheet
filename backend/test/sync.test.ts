import test from 'node:test';
import assert from 'node:assert/strict';
import { eventFingerprint, sameEvent, stableEventId, inputHash } from '../src/utils/eventIdentity.js';
import { mapRowToEvent } from '../src/services/eventParser.js';
import { validateAiEvent, retryDelay } from '../src/services/groq.service.js';
import { fullSync, syncDependencies } from '../src/services/sync.service.js';

const zone = 'Asia/Kolkata';
const event = (hour = '09') => ({ summary: 'Meeting', start: { dateTime: `2026-09-18T${hour}:00:00`, timeZone: zone }, end: { dateTime: `2026-09-18T${Number(hour)+1}:00:00`, timeZone: zone } });
const mapping = { title: 'title', startDate: 'date', startTime: 'time' };
const row = (id: string, time = '09:00') => ({ id, cells: { title: { value: 'Meeting' }, date: { value: '2026-09-18' }, time: { value: time } } });

test('same name at different times and different durations stay distinct', () => {
  assert.notEqual(eventFingerprint(event(), zone), eventFingerprint(event('10'), zone));
  assert.notEqual(eventFingerprint(event(), zone), eventFingerprint({ ...event(), end: event('10').end }, zone));
  assert.notEqual(eventFingerprint({ ...event(), summary: '日本語' }, zone), eventFingerprint({ ...event(), summary: '中文' }, zone));
});
test('offset and wall-clock times match, all-day does not match timed', () => {
  const offset = { ...event(), start: { dateTime: '2026-09-18T03:30:00Z', timeZone: zone }, end: { dateTime: '2026-09-18T10:00:00+05:30', timeZone: zone } };
  assert.equal(eventFingerprint(offset, zone), eventFingerprint(event(), zone));
  assert.notEqual(eventFingerprint({ summary: 'Meeting', start: { date: '2026-09-18' }, end: { date: '2026-09-19' } }, zone), eventFingerprint(event(), zone));
  assert.equal(sameEvent(event(), { ...offset, status: 'confirmed' }, zone), true);
});
test('stable IDs and input hashes cover mapping and timezone changes', () => {
  assert.match(stableEventId('s','r'), /^[0-9a-f]{64}$/);
  assert.equal(stableEventId('s','r'), stableEventId('s','r'));
  assert.notEqual(stableEventId('s','r'), stableEventId('s2','r'));
  assert.notEqual(inputHash(row('r'),mapping,zone),inputHash(row('r'),mapping,'UTC'));
  assert.notEqual(inputHash(row('r'),mapping,zone),inputHash(row('r'),{...mapping, title:'new'},zone));
});
test('structured date parsing, missing fields, all-day and explicit timezone', async () => {
  assert.equal((await mapRowToEvent(row('1'),mapping,zone))?.start.dateTime,'2026-09-18T09:00:00');
  assert.equal(await mapRowToEvent(row('1',''),mapping,zone),null);
  assert.equal((await mapRowToEvent(row('1','all day'),mapping,zone))?.end.date,'2026-09-19');
  const embedded = row('1',''); embedded.cells.date.value='2026-09-18T09:00:00Z';
  assert.equal((await mapRowToEvent(embedded,mapping,zone))?.start.dateTime,'2026-09-18T09:00:00Z');
});
test('AI validation rejects impossible dates, missing fields, reversed ranges and invalid emails', () => {
  assert.throws(() => validateAiEvent({ ...event(), start: { dateTime: '2026-02-30T09:00:00' } },zone));
  assert.throws(() => validateAiEvent({ skip: true },zone));
  assert.throws(() => validateAiEvent({ ...event(), end: event().start },zone));
  assert.throws(() => validateAiEvent({ ...event(), attendees:[{email:'invented'}] },zone));
  assert.equal(retryDelay('120'),120000);
  assert.equal(retryDelay('junk'),60000);
});

function setup(rows: any[], events: any[] = [], records: any[] = []) {
  const writes: any[] = []; const creates: any[] = []; const deletes: string[] = [];
  let parses = 0;
  const config = { id: 'config', userId: 'user', googleCalendarId: 'calendar', smartsheetSheetId: 'sheet', columnMapping: mapping, isEnabled:true };
  syncDependencies.db = {
    syncConfiguration: { updateMany: async () => ({count:1}), findUniqueOrThrow: async () => config, update: async () => config },
    syncRecord: {
      findMany: async () => records,
      upsert: async ({where,create,update}:any) => {
        const existing=records.find(r => r.smartsheetRowId===where.syncConfigId_smartsheetRowId.smartsheetRowId);
        if(existing) Object.assign(existing,update); else records.push({id:String(records.length),...create});
      },
      update: async ({where,data}:any) => Object.assign(records.find(r=>r.id===where.id),data),
    },
  } as any;
  syncDependencies.smartsheet.getSheetRows = async () => rows;
  syncDependencies.google.getCalendarTimezone = async () => zone;
  syncDependencies.google.listCalendarEvents = async () => events;
  syncDependencies.google.createEvent = async (_u,_c,data,id) => { creates.push(data);events.push({id,...data});return id; };
  syncDependencies.google.updateEvent = async (_u,_c,id,data) => { writes.push(data);Object.assign(events.find(e=>e.id===id),data); };
  syncDependencies.google.deleteEvent = async (_u,_c,id) => {deletes.push(id);};
  syncDependencies.parse = async (r,m,t) => {parses++;return mapRowToEvent(r,m,t);};
  return {writes,creates,deletes,records,get parses(){return parses;}};
}
test('integration: two same-name times create two events; second sync has zero writes or parses', async () => {
  const state=setup([row('1'),row('2','10:00')]);
  assert.equal((await fullSync('config')).created,2);
  assert.equal(state.creates.length,2);
  assert.equal((await fullSync('config')).updated,0);
  assert.equal(state.creates.length,2);assert.equal(state.writes.length,0);assert.equal(state.parses,2);
});
test('integration: exact existing event is adopted; different time is created', async () => {
  const state=setup([row('1'),row('2','10:00')],[{id:'old',...event()}]);
  const result=await fullSync('config');
  assert.equal(result.created,1);assert.equal(result.updated,1);
  assert.equal(state.records.find(r=>r.smartsheetRowId==='1').googleEventId,'old');
});
test('integration: tagged event from another sheet is never adopted', async () => {
  const state=setup([row('1')],[{id:'foreign',...event(),extendedProperties:{private:{smartsheetSheetId:'other',smartsheetRowId:'1'}}}]);
  assert.equal((await fullSync('config')).created,1);assert.equal(state.writes.length,0);
});
test('integration: failed calendar read aborts without writes', async () => {
  const state=setup([row('1')]);syncDependencies.google.listCalendarEvents=async()=>{throw new Error('offline');};
  await assert.rejects(fullSync('config'),/offline/);assert.equal(state.creates.length,0);
});
test('integration: AI failure preserves existing event and is retryable', async () => {
  const state=setup([row('1')],[{id:'old',...event()}],[{id:'r',smartsheetRowId:'1',googleEventId:'old',syncStatus:'synced'}]);
  syncDependencies.parse=async()=>{throw new Error('AI rate limit');};
  assert.equal((await fullSync('config')).failed,1);
  assert.equal(state.deletes.length,0);assert.equal(state.writes.length,0);assert.equal(state.records[0].syncStatus,'failed');
});
test('integration: overlapping sync calls share one run and DB lease prevents cross-process work', async () => {
  const state=setup([row('1')]);await Promise.all([fullSync('config'),fullSync('config')]);assert.equal(state.creates.length,1);
  (syncDependencies.db.syncConfiguration as any).updateMany=async()=>({count:0});
  await assert.rejects(fullSync('config'),/already running/);
});
test('integration: deleted source row removes only its own tagged event', async () => {
  const state=setup([],[{id:'old',...event(),extendedProperties:{private:{smartsheetSheetId:'sheet',smartsheetRowId:'1'}}}],
    [{id:'r',smartsheetRowId:'1',googleEventId:'old',syncStatus:'synced'}]);
  assert.equal((await fullSync('config')).deleted,1);assert.deepEqual(state.deletes,['old']);
});

test('DST repeated instants stay separate; ambiguous wall clocks require offsets', () => {
  const e = (offset:string) => ({ summary:'Meeting',start:{dateTime:`2026-11-01T01:15:00${offset}`},end:{dateTime:`2026-11-01T01:30:00${offset}`} });
  assert.notEqual(eventFingerprint(e('-04:00'),'America/New_York'),eventFingerprint(e('-05:00'),'America/New_York'));
  assert.throws(()=>eventFingerprint(e(''),'America/New_York'),/Ambiguous/);
});
test('integration: insert succeeded but database save failed; next run adopts tagged event', async () => {
  const state=setup([row('1')]);
  const upsert=syncDependencies.db.syncRecord.upsert;
  let fail=true;
  (syncDependencies.db.syncRecord as any).upsert=async(args:any)=>{
    if(fail){fail=false;throw new Error('DB temporarily unavailable');}
    return upsert(args);
  };
  assert.equal((await fullSync('config')).failed,1);
  state.records[0].nextRetryAt=null;
  assert.equal((await fullSync('config')).created,0);
  assert.equal(state.creates.length,1);
  assert.equal(state.records[0].syncStatus,'synced');
});
test('integration: cancelled source never creates a new calendar entry', async () => {
  const state=setup([row('1')]);
  syncDependencies.parse=async()=>({...event(),status:'cancelled'});
  await fullSync('config');await fullSync('config');
  assert.equal(state.creates.length,0);
});
test('integration: mapping changes invalidate cache and update linked event', async () => {
  const source=row('1');const state=setup([source]);await fullSync('config');
  source.cells.time.value='10:00';
  assert.equal((await fullSync('config')).updated,1);
  assert.equal(state.creates.length,1);assert.equal(state.parses,2);
});

test('integration: malformed AI row cannot starve other rows on scheduled runs', async () => {
  const state=setup([row('bad'),row('good')]);
  let slot=false;
  syncDependencies.parse=async(r)=>{
    if(slot) throw new Error('AI quota cooldown');
    slot=true;
    if(r.id==='bad') throw new Error('AI extraction failed');
    return event();
  };
  assert.equal((await fullSync('config')).failed,2);
  for(const r of state.records) r.nextRetryAt=null;
  slot=false;
  await fullSync('config');
  assert.equal(state.creates.length,1);
  assert.equal(state.records.find(r=>r.smartsheetRowId==='good').syncStatus,'synced');
});
test('integration: correcting a failed row bypasses its old backoff immediately', async () => {
  const source=row('1');const state=setup([source]);
  syncDependencies.parse=async()=>{throw new Error('invalid time');};await fullSync('config');
  source.cells.time.value='10:00';syncDependencies.parse=mapRowToEvent;
  assert.equal((await fullSync('config')).created,1);assert.equal(state.records[0].syncStatus,'synced');
});
