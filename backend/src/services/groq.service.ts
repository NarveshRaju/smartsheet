import Groq from 'groq-sdk';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import type { CalendarEventData, ColumnMapping } from '../types/index.js';

let groqClient: Groq | null = null;
let cachedActiveModel: string | null = null;
const modelCooldowns = new Map<string, number>();

const PREFERRED_MODELS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'qwen/qwen3.8-27b',
  'qwen/qwen3.6-27b',
  'allam-2-7b',
  'groq/compound',
  'groq/compound-mini',
];

function getGroqClient(): Groq | null {
  const rawKey = env.GROQ_API_KEY ? env.GROQ_API_KEY.trim().replace(/^['"]|['"]$/g, '') : '';
  if (!rawKey) return null;
  if (!groqClient) {
    groqClient = new Groq({ apiKey: rawKey });
  }
  return groqClient;
}

export function isGroqConfigured(): boolean {
  return Boolean(env.GROQ_API_KEY && env.GROQ_API_KEY.trim().length > 0);
}

function extractJsonFromText(rawText: string): any {
  if (!rawText || !rawText.trim()) {
    throw new Error('Empty response from AI');
  }

  // 1. Remove thinking / reasoning tags (e.g. <think>...</think>)
  let cleaned = rawText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  // 2. Try direct JSON parse
  try {
    return JSON.parse(cleaned);
  } catch {}

  // 3. Try stripping markdown code fences ```json ... ```
  const codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch {}
  }

  // 4. Find the first balanced JSON object { ... }
  const firstBrace = cleaned.indexOf('{');
  if (firstBrace !== -1) {
    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = firstBrace; i < cleaned.length; i++) {
      const char = cleaned[i];

      if (escape) {
        escape = false;
        continue;
      }

      if (char === '\\') {
        escape = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (!inString) {
        if (char === '{') {
          depth++;
        } else if (char === '}') {
          depth--;
          if (depth === 0) {
            const jsonSubstring = cleaned.substring(firstBrace, i + 1);
            try {
              return JSON.parse(jsonSubstring);
            } catch {}
          }
        }
      }
    }
  }

  throw new Error('No valid JSON structure found in response');
}

/**
 * Dynamically resolves the best active model available on the user's Groq account,
 * skipping any models currently on 429 rate limit cooldown.
 */
async function resolveGroqModel(client: Groq, excludedModels: Set<string> = new Set()): Promise<string> {
  const now = Date.now();

  if (cachedActiveModel && !excludedModels.has(cachedActiveModel)) {
    const cooldownUntil = modelCooldowns.get(cachedActiveModel) || 0;
    if (cooldownUntil < now) {
      return cachedActiveModel;
    }
  }

  try {
    const list = await client.models.list();
    const availableModelIds = list.data.map((m) => m.id);

    // Find first preferred model not excluded or cooling down
    for (const candidate of PREFERRED_MODELS) {
      const found = availableModelIds.find(
        (id) => (id === candidate || id.endsWith(`/${candidate}`) || id.includes(candidate)) &&
          !excludedModels.has(id) &&
          ((modelCooldowns.get(id) || 0) < now)
      );
      if (found) {
        cachedActiveModel = found;
        return found;
      }
    }

    // Pick first available text/chat model (exclude whisper, guard, safeguard, canopylabs/orpheus)
    const fallbackTextModel = availableModelIds.find(
      (id) =>
        !excludedModels.has(id) &&
        ((modelCooldowns.get(id) || 0) < now) &&
        !id.includes('whisper') &&
        !id.includes('guard') &&
        !id.includes('safeguard') &&
        !id.includes('canopylabs') &&
        !id.includes('orpheus')
    );
    if (fallbackTextModel) {
      cachedActiveModel = fallbackTextModel;
      return fallbackTextModel;
    }
  } catch (err: any) {
    logger.warn(`Could not list Groq models: ${err.message}.`);
  }

  return 'openai/gpt-oss-120b';
}

/**
 * Use Groq LLM to intelligently extract, parse, and curate Google Calendar event details
 * from a Smartsheet row.
 */
export async function curateEventWithGroq(
  row: any,
  columnMapping: ColumnMapping,
  timezone: string
): Promise<CalendarEventData | null> {
  const client = getGroqClient();
  if (!client) {
    return null;
  }

  try {
    // Extract row cell values into readable key-value dictionary
    const rowContent: Record<string, string> = {};
    if (row.cells) {
      for (const [colId, cellData] of Object.entries<any>(row.cells)) {
        const title = cellData.columnTitle || `Col_${colId}`;
        const val = cellData.displayValue || cellData.value?.toString() || '';
        if (val.trim()) {
          rowContent[title] = val.trim();
        }
      }
    }

    if (Object.keys(rowContent).length === 0) {
      return null;
    }

    // Fast-check: both start date AND start time are strictly mandatory
    const startDateVal = columnMapping.startDate && row.cells?.[columnMapping.startDate]
      ? (row.cells[columnMapping.startDate].displayValue || row.cells[columnMapping.startDate].value?.toString() || '').trim()
      : '';

    const startTimeVal = columnMapping.startTime && row.cells?.[columnMapping.startTime]
      ? (row.cells[columnMapping.startTime].displayValue || row.cells[columnMapping.startTime].value?.toString() || '').trim()
      : '';

    const isAllDay = (val: string) => /^(all\s*day|full\s*day|yes|true)/i.test(val.trim());
    const dateHasEmbeddedTime = /\d{1,2}:\d{2}/.test(startDateVal) || isAllDay(startDateVal);

    if (!startDateVal || (!startTimeVal && !dateHasEmbeddedTime)) {
      logger.debug(`Row ${row.id}: Start date or start time is blank (both are mandatory), skipping calendar sync`);
      return null;
    }

    const systemPrompt = `You are an expert AI assistant that curates structured Google Calendar events from tabular project data (Smartsheet).
Analyze the provided row data, column mappings, and timezone to output a structured JSON Google Calendar event object.

RULES:
1. ALL-DAY EVENTS: If start time is "all day", "all-day", "full day", "yes", or explicitly marked all day, format "start" and "end" using "date" ONLY:
   - "start": { "date": "YYYY-MM-DD", "timeZone": "${timezone}" }
   - "end": { "date": "YYYY-MM-DD", "timeZone": "${timezone}" }
2. TIMED EVENTS: If a specific time is provided (e.g. 10:00 AM, 14:30), format "start" and "end" using "dateTime" ISO 8601:
   - "start": { "dateTime": "YYYY-MM-DDTHH:mm:ss", "timeZone": "${timezone}" }
   - "end": { "dateTime": "YYYY-MM-DDTHH:mm:ss", "timeZone": "${timezone}" }
3. SKIPPING: If start time is blank/empty AND is NOT an all-day event, you MUST output:
   { "skip": true }

Requirements when event is created:
1. "summary": Concise, clear, and professional event title.
2. "description": Clean, nicely formatted multi-line summary of key notes, row context, links, and details from the row.
3. "location": Physical location, conference room, or video meeting link (Zoom/Google Meet/Teams) if present in the row.
4. "attendees": Array of valid email objects e.g. [{"email": "user@example.com"}].
5. "status": "confirmed", "tentative", or "cancelled".

Respond strictly with valid JSON conforming to this schema:
{
  "skip"?: boolean,
  "summary"?: string,
  "start"?: { "dateTime"?: string, "date"?: string, "timeZone": string },
  "end"?: { "dateTime"?: string, "date"?: string, "timeZone": string },
  "description"?: string,
  "location"?: string,
  "attendees"?: [{"email": string}],
  "status"?: "confirmed" | "tentative" | "cancelled"
}`;

    const userPrompt = `Please analyze the following row and return ONLY a valid JSON object matching the schema:\n${JSON.stringify({
      rowData: rowContent,
      columnMapping,
      targetTimezone: timezone,
      currentDate: new Date().toISOString().split('T')[0],
    })}`;

    const excludedModels = new Set<string>();
    let completion: any;
    let modelToUse = '';

    for (let attempt = 0; attempt < 2; attempt++) {
      modelToUse = await resolveGroqModel(client, excludedModels);
      try {
        try {
          completion = await client.chat.completions.create({
            model: modelToUse,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            response_format: { type: 'json_object' },
            temperature: 0.1,
          });
        } catch (apiErr: any) {
          if (apiErr?.message?.includes('json_validate_failed') || apiErr?.status === 400) {
            completion = await client.chat.completions.create({
              model: modelToUse,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `${userPrompt}\n\nIMPORTANT: Output ONLY the raw JSON object with no markdown wrappers.` },
              ],
              temperature: 0.1,
            });
          } else {
            throw apiErr;
          }
        }
        break;
      } catch (err: any) {
        if (err?.status === 429 || err?.message?.includes('429')) {
          modelCooldowns.set(modelToUse, Date.now() + 60_000);
          excludedModels.add(modelToUse);
          cachedActiveModel = null;
          logger.warn(`Groq rate limit (429) on ${modelToUse} for row ${row.id}. Rotating to next model...`);
          if (attempt === 1) {
            return null;
          }
        } else {
          throw err;
        }
      }
    }

    const content = completion?.choices?.[0]?.message?.content;
    if (!content) {
      logger.warn(`Groq returned empty response for row ${row.id}`);
      return null;
    }

    const parsed = extractJsonFromText(content);

    const hasStart = Boolean(parsed.start?.dateTime || parsed.start?.date);
    const hasEnd = Boolean(parsed.end?.dateTime || parsed.end?.date);

    if (parsed.skip || !hasStart || !hasEnd || !parsed.summary) {
      logger.debug(`Row ${row.id}: Groq determined row is blank or should be skipped`);
      return null;
    }

    // Ensure format consistency: start and end MUST both be date OR both be dateTime
    if (parsed.start?.dateTime && !parsed.end?.dateTime) {
      if (parsed.end?.date) {
        parsed.end = { dateTime: `${parsed.end.date}T10:00:00`, timeZone: timezone };
      } else {
        const sDate = new Date(parsed.start.dateTime);
        sDate.setHours(sDate.getHours() + 1);
        parsed.end = { dateTime: sDate.toISOString(), timeZone: timezone };
      }
    } else if (parsed.start?.date && !parsed.end?.date) {
      parsed.end = { date: parsed.start.date, timeZone: timezone };
    }

    logger.info(`✨ Groq (${modelToUse}) successfully curated event: "${parsed.summary}"`);
    return parsed as CalendarEventData;
  } catch (error: any) {
    if (error?.status === 429 || error?.message?.includes('429')) {
      cachedActiveModel = null;
      logger.warn(`Groq rate limit (429) reached for row ${row.id}. Gracefully falling back to standard parser.`);
    } else {
      const errorDetails = error?.response?.data ? JSON.stringify(error.response.data) : error.message;
      logger.warn(`Groq event curation failed for row ${row.id}: ${errorDetails}. Falling back to standard parser.`);
    }
    return null;
  }
}
