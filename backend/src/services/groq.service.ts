import Groq from 'groq-sdk';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import type { CalendarEventData, ColumnMapping } from '../types/index.js';

let groqClient: Groq | null = null;
let cachedActiveModel: string | null = null;

const PREFERRED_MODELS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-70b-versatile',
  'llama-3.1-8b-instant',
  'llama-3.2-11b-vision-preview',
  'llama-3.2-3b-preview',
  'llama-3.2-1b-preview',
  'mixtral-8x7b-32768',
  'gemma2-9b-it',
  'qwen-2.5-32b',
  'deepseek-r1-distill-llama-70b',
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

/**
 * Dynamically resolves the best active model available on the user's Groq account.
 */
async function resolveGroqModel(client: Groq): Promise<string> {
  if (cachedActiveModel) {
    return cachedActiveModel;
  }

  try {
    const list = await client.models.list();
    const availableModelIds = list.data.map((m) => m.id);
    logger.info(`📋 Groq available models on this key: ${availableModelIds.join(', ')}`);

    for (const candidate of PREFERRED_MODELS) {
      if (availableModelIds.includes(candidate)) {
        cachedActiveModel = candidate;
        logger.info(`🎯 Selected Groq model: ${candidate}`);
        return candidate;
      }
    }

    // Pick first available text/chat model (exclude whisper/guard/audio)
    const fallbackTextModel = availableModelIds.find(
      (id) => !id.includes('whisper') && !id.includes('guard')
    );
    if (fallbackTextModel) {
      cachedActiveModel = fallbackTextModel;
      logger.info(`🎯 Selected Groq fallback model: ${fallbackTextModel}`);
      return fallbackTextModel;
    }
  } catch (err: any) {
    logger.warn(`Could not list Groq models: ${err.message}. Defaulting to llama-3.1-8b-instant`);
  }

  return 'llama-3.1-8b-instant';
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

    // Fast-check: if start date is blank, immediately skip without LLM call
    const startDateVal = columnMapping.startDate && row.cells?.[columnMapping.startDate]
      ? (row.cells[columnMapping.startDate].displayValue || row.cells[columnMapping.startDate].value?.toString() || '').trim()
      : '';

    if (!startDateVal) {
      logger.debug(`Row ${row.id}: Start date is blank, skipping calendar sync`);
      return null;
    }

    const systemPrompt = `You are an expert AI assistant that curates structured Google Calendar events from tabular project data (Smartsheet).
Analyze the provided row data, column mappings, and timezone to output a structured JSON Google Calendar event object.

CRITICAL RULE:
If the row does NOT contain a valid date AND a valid time (i.e. start date is blank/missing, or start time and end time are blank/missing), you MUST output:
{ "skip": true }

Requirements when date and time are both present:
1. "summary": Concise, clear, and professional event title.
2. "start": An object with "dateTime" (ISO 8601 string with time e.g. "2026-08-18T10:00:00") and "timeZone": "${timezone}".
3. "end": An object with "dateTime" (ISO 8601 string with time e.g. "2026-08-18T11:00:00") and "timeZone": "${timezone}". Default duration is 1 hour if start time is provided but no end time is specified.
4. "description": Clean, nicely formatted multi-line summary of key notes, row context, links, and details from the row.
5. "location": Physical location, conference room, or video meeting link (Zoom/Google Meet/Teams) if present in the row.
6. "attendees": Array of valid email objects e.g. [{"email": "user@example.com"}].
7. "status": "confirmed", "tentative", or "cancelled".

Respond strictly with valid JSON conforming to this schema:
{
  "skip"?: boolean,
  "summary"?: string,
  "start"?: { "dateTime": string, "timeZone": string },
  "end"?: { "dateTime": string, "timeZone": string },
  "description"?: string,
  "location"?: string,
  "attendees"?: [{"email": string}],
  "status"?: "confirmed" | "tentative" | "cancelled"
}`;

    const userPrompt = JSON.stringify({
      rowData: rowContent,
      columnMapping,
      targetTimezone: timezone,
      currentDate: new Date().toISOString().split('T')[0],
    });

    const modelToUse = await resolveGroqModel(client);

    const completion = await client.chat.completions.create({
      model: modelToUse,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      logger.warn(`Groq returned empty response for row ${row.id}`);
      return null;
    }

    const parsed = JSON.parse(content);

    if (parsed.skip || !parsed.start?.dateTime || !parsed.end?.dateTime || !parsed.summary) {
      logger.debug(`Row ${row.id}: Groq determined start/end time is blank or row should be skipped`);
      return null;
    }

    logger.info(`✨ Groq (${modelToUse}) successfully curated event: "${parsed.summary}"`);
    return parsed as CalendarEventData;
  } catch (error: any) {
    const errorDetails = error?.response?.data ? JSON.stringify(error.response.data) : error.message;
    logger.warn(`Groq event curation failed for row ${row.id}: ${errorDetails}. Falling back to standard parser.`);
    return null;
  }
}
