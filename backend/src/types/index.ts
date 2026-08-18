import type { Request } from 'express';

export interface ColumnMapping {
  title?: string;
  startDate?: string;
  endDate?: string;
  description?: string;
  location?: string;
  attendee?: string;
  status?: string;
}

export interface SyncConfigInput {
  smartsheetSheetId: string;
  sheetName?: string;
  googleCalendarId: string;
  calendarName?: string;
  columnMapping: ColumnMapping;
  isEnabled?: boolean;
}

export interface CalendarEventData {
  summary: string;
  description?: string;
  location?: string;
  start: { dateTime?: string; date?: string; timeZone: string };
  end: { dateTime?: string; date?: string; timeZone: string };
  attendees?: Array<{ email: string }>;
  status?: string;
}

export interface SyncResult {
  created: number;
  updated: number;
  deleted: number;
  failed: number;
  errors: Array<{ rowId: string; error: string }>;
}

export interface SmartsheetWebhookEvent {
  objectType: string;
  eventType: string;
  id: number;
  rowId?: number;
  columnId?: number;
  userId?: number;
  timestamp: string;
}

export interface SmartsheetWebhookPayload {
  nonce: string;
  timestamp: string;
  webhookId: number;
  scope: string;
  scopeObjectId: number;
  events: SmartsheetWebhookEvent[];
  challenge?: string;
}

declare module 'express-session' {
  interface SessionData {
    userId?: string;
    googleState?: string;
    smartsheetState?: string;
  }
}

export interface AuthenticatedRequest extends Request {
  userId?: string;
}
