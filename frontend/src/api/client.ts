import type { AuthStatus, Sheet, Column, Calendar, SyncConfig, SyncStatus, SyncResult } from '../types/index.js';

export const API_BASE_URL = import.meta.env.VITE_API_URL ?? (
  typeof window !== 'undefined' && window.location.hostname === 'localhost'
    ? ''
    : 'https://smartsheet-gcal-sync.onrender.com'
);

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const url = path.startsWith('http') ? path : `${API_BASE_URL}${path}`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(90_000),
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  }).catch((error: Error) => {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') throw new Error('Server response timed out. A started sync may still be running; check Sync Status and Render logs.');
    throw new Error('Cannot reach the server. Check your connection and whether the Render service is running.');
  });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || 'Request failed: ' + response.status);
  }
  return response.json();
}

export const api = {
  getAuthStatus: () => request<AuthStatus>('/auth/status'),
  logout: () => request<{ success: boolean }>('/auth/logout', { method: 'POST' }),
  disconnect: (provider: 'google' | 'smartsheet') => request<{ success: boolean }>('/auth/disconnect/' + provider, { method: 'POST' }),
  getCalendars: () => request<{ calendars: Calendar[] }>('/api/google/calendars'),
  createCalendar: (data: { summary: string; description?: string; timeZone?: string }) =>
    request<{ calendar: Calendar }>('/api/google/calendars', { method: 'POST', body: JSON.stringify(data) }),
  getSheets: () => request<{ sheets: Sheet[] }>('/api/smartsheet/sheets'),
  getSheetColumns: (sheetId: string) => request<{ columns: Column[] }>('/api/smartsheet/sheets/' + sheetId + '/columns'),
  getSyncConfig: () => request<{ config: SyncConfig | null }>('/api/sync/config'),
  createSyncConfig: (data: Partial<SyncConfig>) => request<{ config: SyncConfig }>('/api/sync/config', { method: 'POST', body: JSON.stringify(data) }),
  updateSyncConfig: (data: Partial<SyncConfig>) => request<{ config: SyncConfig }>('/api/sync/config', { method: 'PUT', body: JSON.stringify(data) }),
  resetSyncConfig: () => request<{ success: boolean }>('/api/sync/config', { method: 'DELETE' }),
  fullSync: async (onProgress?: (message: string) => void): Promise<{ result: SyncResult }> => {
    onProgress?.('Connecting to server…');
    const { runId } = await request<{ runId: string }>('/api/sync/full', { method: 'POST' });
    const deadline = Date.now() + 15 * 60 * 1000;
    while (Date.now() < deadline) {
      const { run } = await request<{ run: { status: string; stage: string; processed: number; total: number; result?: SyncResult; error?: string } }>('/api/sync/runs/' + runId);
      onProgress?.(run.total ? run.stage + ': ' + run.processed + '/' + run.total + ' rows processed' : run.stage);
      if (run.status === 'completed' && run.result) return { result: run.result };
      if (run.status === 'failed') throw new Error(run.error || 'Sync failed. Check connection settings.');
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    throw new Error('Sync is taking longer than 15 minutes. It may still be running; check Sync Status and Render logs before retrying.');
  },
  retryRow: (rowId: string) => request<{ success: boolean }>('/api/sync/' + rowId + '/retry', { method: 'POST' }),
  getSyncStatus: () => request<SyncStatus>('/api/sync/status'),
};
