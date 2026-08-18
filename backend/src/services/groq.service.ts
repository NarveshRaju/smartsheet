import axios from 'axios';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import type { CalendarEventData, ColumnMapping } from '../types/index.js';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

export function isGroqConfigured(): boolean {
  return Boolean(env.GROQ_API_KEY && env.GROQ_API_KEY.trim().length > 0);
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
  if (!isGroqConfigured()) {
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

    const systemPrompt = `You are an expert AI assistant that curates structured Google Calendar events from tabular project data (Smartsheet).
Analyze the provided row data, column mappings, and timezone to output a perfectly structured JSON Google Calendar event object.

Requirements:
1. "summary": Concise, clear, and professional event title.
2. "start": An object with either "dateTime" (ISO 8601 string, e.g. "2026-08-18T10:00:00") or "date" ("YYYY-MM-DD" for all-day events), and "timeZone": "${timezone}".
3. "end": An object with either "dateTime" (ISO 8601 string) or "date" ("YYYY-MM-DD"), and "timeZone": "${timezone}". Default duration is 1 hour if start time is provided but no end time is specified.
4. "description": Clean, nicely formatted multi-line summary of key notes, row context, links, and details from the row.
5. "location": Physical location, conference room, or video meeting link (Zoom/Google Meet/Teams) if present in the row.
6. "attendees": Array of valid email objects e.g. [{"email": "user@example.com"}].
7. "status": "confirmed", "tentative", or "cancelled".

Respond strictly with valid JSON conforming to this schema:
{
  "summary": string,
  "start": { "dateTime": string, "timeZone": string } OR { "date": string, "timeZone": string },
  "end": { "dateTime": string, "timeZone": string } OR { "date": string, "timeZone": string },
  "description": string,
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

    const response = await axios.post(
      GROQ_API_URL,
      {
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1,
      },
      {
        headers: {
          Authorization: `Bearer ${env.GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 8000,
      }
    );

    const content = response.data?.choices?.[0]?.message?.content;
    if (!content) {
      logger.warn(`Groq returned empty response for row ${row.id}`);
      return null;
    }

    const parsed = JSON.parse(content);

    if (!parsed.summary || !parsed.start || !parsed.end) {
      logger.warn(`Groq JSON missing required event fields for row ${row.id}`);
      return null;
    }

    logger.info(`✨ Groq successfully curated event: "${parsed.summary}"`);
    return parsed as CalendarEventData;
  } catch (error: any) {
    logger.warn(`Groq event curation failed for row ${row.id}: ${error.message}. Falling back to standard parser.`);
    return null;
  }
}
