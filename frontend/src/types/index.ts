export interface AuthStatus {
  authenticated: boolean;
  user?: { email: string; displayName: string };
  google: boolean;
  googleExpiry?: string;
  smartsheet: boolean;
  smartsheetExpiry?: string;
}

export interface Sheet { id: string; name: string; accessLevel: string; modifiedAt: string; }
export interface Column { id: string; title: string; type: string; index: number; primary: boolean; }
export interface Calendar {
  id: string;
  summary: string;
  description?: string;
  primary?: boolean;
  backgroundColor?: string;
  accessRole?: string;
  timeZone?: string;
}

export interface ColumnMapping {
  title?: string;
  startDate?: string;
  startTime?: string;
  endDate?: string;
  endTime?: string;
  description?: string;
  location?: string;
  attendee?: string;
  status?: string;
}

export interface SyncConfig {
  id: string; smartsheetSheetId: string; sheetName?: string;
  googleCalendarId: string; calendarName?: string;
  columnMapping: ColumnMapping; isEnabled: boolean;
  webhookId?: string; lastFullSyncAt?: string;
}

export interface SyncRecord {
  id: string; smartsheetRowId: string; googleEventId?: string;
  syncStatus: string; syncAction?: string; lastSyncedAt?: string;
  lastError?: string; retryCount: number;
}

export interface SyncStats { total: number; synced: number; failed: number; pending: number; deleted: number; }

export interface SyncStatus {
  config: { id: string; sheetName?: string; calendarName?: string; isEnabled: boolean; lastFullSyncAt?: string; } | null;
  stats: SyncStats | null;
  failedRecords: SyncRecord[];
  recentRecords: SyncRecord[];
  isAiConfigured?: boolean;
}

export interface SyncResult {
  created: number; updated: number; deleted: number; failed: number;
  errors: Array<{ rowId: string; error: string }>;
}
