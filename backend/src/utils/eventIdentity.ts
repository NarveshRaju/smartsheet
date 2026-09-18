import { createHash } from 'node:crypto';

type Boundary = { date?: string | null; dateTime?: string | null; timeZone?: string | null };
type Event = { summary?: string | null; start?: Boundary | null; end?: Boundary | null; description?: string | null; location?: string | null; status?: string | null; attendees?: Array<{ email?: string | null }> | null };

function wallClock(timestamp: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  const p = (type: string) => parts.find(x => x.type === type)!.value;
  return `${p('year')}-${p('month')}-${p('day')}T${p('hour')}:${p('minute')}:${p('second')}`;
}

function boundaryKey(value: Boundary | null | undefined, timezone: string): string {
  if (value?.date) return `date:${value.date}`;
  const dt = value?.dateTime;
  if (!dt) return '';
  if (/(Z|[+-]\d{2}:\d{2})$/i.test(dt)) return `instant:${Date.parse(dt)}`;
  const local = dt.length === 16 ? dt + ':00' : dt;
  const nominal = Date.parse(local + 'Z');
  const candidates = new Set<number>();
  // Sample offsets on either side of a daylight-saving transition. Never silently
  // equate the two occurrences of a repeated wall-clock time.
  for (const hours of [-36, 0, 36]) {
    const sample = nominal + hours * 3600000;
    const offset = Date.parse(wallClock(sample, timezone) + 'Z') - sample;
    const instant = nominal - offset;
    if (wallClock(instant, timezone) === local) candidates.add(instant);
  }
  if (candidates.size !== 1) throw new Error('Ambiguous or nonexistent local time; supply an explicit UTC offset');
  return `instant:${[...candidates][0]}`;
}

export function eventFingerprint(event: Event, timezone: string): string {
  return JSON.stringify([
    (event.summary || '').trim().replace(/\s+/g, ' '),
    boundaryKey(event.start, timezone), boundaryKey(event.end, timezone),
  ]);
}

export function sameEvent(a: Event, b: Event, timezone: string): boolean {
  const extras = (e: Event) => JSON.stringify([
    e.description || '', e.location || '', e.status || 'confirmed',
    (e.attendees || []).map(x => x.email?.toLowerCase()).sort(),
  ]);
  return eventFingerprint(a, timezone) === eventFingerprint(b, timezone) && extras(a) === extras(b);
}

export function stableEventId(sheetId: string, rowId: string, generation = ''): string {
  // Hex is a valid subset of Google's base32hex alphabet.
  return createHash('sha256').update(JSON.stringify([sheetId, rowId, generation])).digest('hex');
}

export function inputHash(row: any, mapping: unknown, timezone: string): string {
  const cells = Object.entries<any>(row.cells || {}).sort(([a], [b]) => a.localeCompare(b))
    .map(([id, cell]) => [id, cell.value ?? null, cell.displayValue ?? null, cell.columnTitle ?? null]);
  return createHash('sha256').update(JSON.stringify([cells, mapping, timezone, 'parser-v2'])).digest('hex');
}
