import type { AuthStatus, Sheet, Column, Calendar, SyncConfig, SyncStatus, SyncResult } from '../types/index.js';

export const API_BASE_URL = import.meta.env.VITE_API_URL ?? (
  typeof window !== 'undefined' && window.location.hostname === 'localhost'
    ? ''
    : 'https://smartsheet-gcal-sync.onrender.com'
);

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const url = path.startsWith('http') ? path : `${API_BASE_URL}${path}`;
  const response = await fetch(url, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
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
  getSheets: () => request<{ sheets: Sheet[] }>('/api/smartsheet/sheets'),
  getSheetColumns: (sheetId: string) => request<{ columns: Column[] }>('/api/smartsheet/sheets/' + sheetId + '/columns'),
  getSyncConfig: () => request<{ config: SyncConfig | null }>('/api/sync/config'),
  createSyncConfig: (data: Partial<SyncConfig>) => request<{ config: SyncConfig }>('/api/sync/config', { method: 'POST', body: JSON.stringify(data) }),
  updateSyncConfig: (data: Partial<SyncConfig>) => request<{ config: SyncConfig }>('/api/sync/config', { method: 'PUT', body: JSON.stringify(data) }),
  resetSyncConfig: () => request<{ success: boolean }>('/api/sync/config', { method: 'DELETE' }),
  fullSync: () => request<{ result: SyncResult }>('/api/sync/full', { method: 'POST' }),
  retryRow: (rowId: string) => request<{ success: boolean }>('/api/sync/' + rowId + '/retry', { method: 'POST' }),
  getSyncStatus: () => request<SyncStatus>('/api/sync/status'),
};
