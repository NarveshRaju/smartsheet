import axios from 'axios';
import { PrismaClient } from '@prisma/client';
import { decrypt, encrypt } from './crypto.service.js';
import { withRetry } from '../utils/apiRetry.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const prisma = new PrismaClient();
const SMARTSHEET_API = 'https://api.smartsheet.com/2.0';

async function getAccessToken(userId: string): Promise<string> {
  const account = await prisma.oAuthAccount.findUnique({
    where: { userId_provider: { userId, provider: 'smartsheet' } },
  });

  if (!account) {
    throw Object.assign(new Error('Smartsheet account not connected'), { statusCode: 401 });
  }

  // Check if token needs refresh
  if (account.tokenExpiresAt && account.tokenExpiresAt.getTime() < Date.now() + 60_000) {
    logger.debug('Refreshing Smartsheet access token');
    const refreshToken = account.refreshToken ? decrypt(account.refreshToken) : null;
    if (!refreshToken) {
      throw Object.assign(new Error('No Smartsheet refresh token available'), { statusCode: 401 });
    }

    const response = await axios.post('https://api.smartsheet.com/2.0/token', null, {
      params: {
        grant_type: 'refresh_token',
        client_id: env.SMARTSHEET_CLIENT_ID,
        client_secret: env.SMARTSHEET_CLIENT_SECRET,
        refresh_token: refreshToken,
      },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const { access_token, refresh_token: newRefresh, expires_in } = response.data;

    await prisma.oAuthAccount.update({
      where: { id: account.id },
      data: {
        accessToken: encrypt(access_token),
        refreshToken: newRefresh ? encrypt(newRefresh) : account.refreshToken,
        tokenExpiresAt: new Date(Date.now() + expires_in * 1000),
      },
    });

    return access_token;
  }

  return decrypt(account.accessToken);
}

function apiClient(token: string) {
  return axios.create({
    baseURL: SMARTSHEET_API,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
}

export function getSmartsheetAuthUrl(state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: env.SMARTSHEET_CLIENT_ID,
    redirect_uri: env.SMARTSHEET_REDIRECT_URI,
    scope: 'READ_SHEETS ADMIN_WEBHOOKS',
    state,
  });
  return `https://app.smartsheet.com/b/authorize?${params.toString()}`;
}

export async function handleSmartsheetCallback(code: string) {
  const response = await axios.post('https://api.smartsheet.com/2.0/token', null, {
    params: {
      grant_type: 'authorization_code',
      client_id: env.SMARTSHEET_CLIENT_ID,
      client_secret: env.SMARTSHEET_CLIENT_SECRET,
      code,
      redirect_uri: env.SMARTSHEET_REDIRECT_URI,
    },
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  return response.data; // { access_token, refresh_token, expires_in, token_type }
}

export async function listSheets(userId: string) {
  const token = await getAccessToken(userId);
  return withRetry(async () => {
    const client = apiClient(token);
    const response = await client.get('/sheets', {
      params: { includeAll: true },
    });
    return (response.data.data || []).map((sheet: any) => ({
      id: sheet.id.toString(),
      name: sheet.name,
      accessLevel: sheet.accessLevel,
      modifiedAt: sheet.modifiedAt,
    }));
  });
}

export async function getSheetColumns(userId: string, sheetId: string) {
  const token = await getAccessToken(userId);
  return withRetry(async () => {
    const client = apiClient(token);
    const response = await client.get(`/sheets/${sheetId}/columns`);
    return (response.data.data || []).map((col: any) => ({
      id: col.id.toString(),
      title: col.title,
      type: col.type,
      index: col.index,
      primary: col.primary || false,
    }));
  });
}

export async function getSheetRows(userId: string, sheetId: string) {
  const token = await getAccessToken(userId);
  return withRetry(async () => {
    const client = apiClient(token);
    const response = await client.get(`/sheets/${sheetId}`, {
      params: { level: 2, include: 'objectValue' },
    });
    const columns = response.data.columns || [];
    const rows = response.data.rows || [];

    return rows.map((row: any) => {
      const cells: Record<string, any> = {};
      for (const cell of row.cells || []) {
        const col = columns.find((c: any) => c.id === cell.columnId);
        if (col) {
          cells[col.id.toString()] = {
            value: cell.value,
            displayValue: cell.displayValue,
            columnTitle: col.title,
          };
        }
      }
      return {
        id: row.id.toString(),
        rowNumber: row.rowNumber,
        cells,
        modifiedAt: row.modifiedAt,
      };
    });
  });
}

export async function getRow(userId: string, sheetId: string, rowId: string) {
  const token = await getAccessToken(userId);
  return withRetry(async () => {
    const client = apiClient(token);
    // Get full sheet to have column mapping
    const response = await client.get(`/sheets/${sheetId}`, {
      params: { level: 2, include: 'objectValue', rowIds: rowId },
    });
    const columns = response.data.columns || [];
    const row = response.data.rows?.[0];
    if (!row) return null;

    const cells: Record<string, any> = {};
    for (const cell of row.cells || []) {
      const col = columns.find((c: any) => c.id === cell.columnId);
      if (col) {
        cells[col.id.toString()] = {
          value: cell.value,
          displayValue: cell.displayValue,
          columnTitle: col.title,
        };
      }
    }
    return {
      id: row.id.toString(),
      rowNumber: row.rowNumber,
      cells,
      modifiedAt: row.modifiedAt,
    };
  });
}

export async function getCurrentUser(userId: string) {
  const token = await getAccessToken(userId);
  return withRetry(async () => {
    const client = apiClient(token);
    const response = await client.get('/users/me');
    return response.data;
  });
}
