import { google, calendar_v3 } from 'googleapis';
import { prisma } from './db.js';

google.options({ timeout: 20_000 });
import { encrypt, decrypt } from './crypto.service.js';
import { withRetry } from '../utils/apiRetry.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { stableEventId } from '../utils/eventIdentity.js';
import type { CalendarEventData } from '../types/index.js';



function getOAuth2Client() {
  return new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI
  );
}

/**
 * Build an authenticated OAuth2 client for a user.
 * Automatically refreshes tokens if expired.
 */
async function buildAuthenticatedClient(userId: string) {
  const account = await prisma.oAuthAccount.findUnique({
    where: { userId_provider: { userId, provider: 'google' } },
  });

  if (!account) {
    throw Object.assign(new Error('Google account not connected'), { statusCode: 401 });
  }

  const oauth2 = getOAuth2Client();
  const accessToken = decrypt(account.accessToken);
  const refreshToken = account.refreshToken ? decrypt(account.refreshToken) : undefined;

  oauth2.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken,
    expiry_date: account.tokenExpiresAt?.getTime(),
  });

  // Check if token needs refresh
  if (account.tokenExpiresAt && account.tokenExpiresAt.getTime() < Date.now() + 60_000) {
    logger.debug('Refreshing Google access token');
    const { credentials } = await oauth2.refreshAccessToken();
    oauth2.setCredentials(credentials);

    // Persist new tokens
    await prisma.oAuthAccount.update({
      where: { id: account.id },
      data: {
        accessToken: encrypt(credentials.access_token!),
        refreshToken: credentials.refresh_token
          ? encrypt(credentials.refresh_token)
          : account.refreshToken,
        tokenExpiresAt: credentials.expiry_date
          ? new Date(credentials.expiry_date)
          : account.tokenExpiresAt,
      },
    });
  }

  return oauth2;
}

const authCache = new Map<string, { expires: number; value: ReturnType<typeof buildAuthenticatedClient> }>();
async function getAuthenticatedClient(userId: string) {
  const cached = authCache.get(userId);
  if (cached && cached.expires > Date.now()) return cached.value;
  const value = buildAuthenticatedClient(userId);
  authCache.set(userId, { expires: Date.now() + 30_000, value });
  try { return await value; } catch (error) { authCache.delete(userId); throw error; }
}
export function clearGoogleAuthCache(userId: string): void { authCache.delete(userId); }

export function getGoogleAuthUrl(state: string): string {
  const oauth2 = getOAuth2Client();
  return oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
    state,
  });
}

export async function handleGoogleCallback(code: string) {
  const oauth2 = getOAuth2Client();
  const { tokens } = await oauth2.getToken(code);
  oauth2.setCredentials(tokens);

  // Get user info
  const oauth2Api = google.oauth2({ version: 'v2', auth: oauth2 });
  const { data: userInfo } = await oauth2Api.userinfo.get();

  return {
    tokens,
    userInfo: {
      email: userInfo.email || undefined,
      name: userInfo.name || undefined,
      id: userInfo.id || undefined,
    },
  };
}

export async function listCalendars(userId: string) {
  const auth = await getAuthenticatedClient(userId);
  const calendar = google.calendar({ version: 'v3', auth });

  return withRetry(async () => {
    const response = await calendar.calendarList.list({
      minAccessRole: 'writer',
    });
    return (response.data.items || []).map((cal) => ({
      id: cal.id,
      summary: cal.summary,
      description: cal.description,
      primary: cal.primary,
      backgroundColor: cal.backgroundColor,
      accessRole: cal.accessRole,
      timeZone: cal.timeZone,
    }));
  });
}

export async function createCalendar(
  userId: string,
  summary: string,
  description?: string,
  timeZone?: string
) {
  const auth = await getAuthenticatedClient(userId);
  const calendar = google.calendar({ version: 'v3', auth });

  return withRetry(async () => {
    const response = await calendar.calendars.insert({
      requestBody: {
        summary,
        description,
        timeZone: timeZone || env.DEFAULT_TIMEZONE || 'UTC',
      },
    });
    logger.info(`Created new Google Calendar: ${response.data.id} (${response.data.summary})`);
    return {
      id: response.data.id!,
      summary: response.data.summary!,
      description: response.data.description || undefined,
      primary: false,
      backgroundColor: '#4285f4',
      accessRole: 'owner',
      timeZone: response.data.timeZone || undefined,
    };
  });
}

export async function getCalendarTimezone(userId: string, calendarId: string): Promise<string> {
  const auth = await getAuthenticatedClient(userId);
  const calendar = google.calendar({ version: 'v3', auth });
  const response = await withRetry(() => calendar.calendars.get({ calendarId }));
  return response.data.timeZone || env.DEFAULT_TIMEZONE;
}

export async function listCalendarEvents(userId: string, calendarId: string): Promise<calendar_v3.Schema$Event[]> {
  const auth = await getAuthenticatedClient(userId);
  const calendar = google.calendar({ version: 'v3', auth });
  const all: calendar_v3.Schema$Event[] = [];
  let pageToken: string | undefined;
  do {
    const response = await withRetry(() => calendar.events.list({ calendarId, maxResults: 2500,
      singleEvents: false, showDeleted: false, pageToken }));
    all.push(...(response.data.items || []));
    pageToken = response.data.nextPageToken || undefined;
  } while (pageToken);
  return all;
}

export async function createEvent(userId: string, calendarId: string, eventData: CalendarEventData, requestedId: string): Promise<string> {
  const auth = await getAuthenticatedClient(userId);
  const calendar = google.calendar({ version: 'v3', auth });
  let id = requestedId;
  // A deleted deterministic ID is a tombstone. Its ETag gives a stable next generation,
  // including when an insert succeeded but its response or database write was lost.
  for (let generation = 0; generation < 10; generation++) {
    try {
      const response = await withRetry(() => calendar.events.insert({ calendarId,
        requestBody: { ...eventData, id } as calendar_v3.Schema$Event }));
      return response.data.id!;
    } catch (error: any) {
      if ((error.response?.status || error.code) !== 409) throw error;
      const existing = await withRetry(() => calendar.events.get({ calendarId, eventId: id }));
      if (existing.data.status !== 'cancelled') {
        const tags = existing.data.extendedProperties?.private;
        const wanted = eventData.extendedProperties?.private;
        if (tags?.smartsheetSheetId !== wanted?.smartsheetSheetId || tags?.smartsheetRowId !== wanted?.smartsheetRowId) throw new Error('Calendar event identity conflict');
        await updateEvent(userId, calendarId, id, eventData);
        return id;
      }
      id = stableEventId(requestedId, id, existing.data.etag || 'deleted');
    }
  }
  throw new Error('Too many deleted generations for calendar event; manual review needed');
}

export async function updateEvent(userId: string, calendarId: string, eventId: string, eventData: CalendarEventData): Promise<void> {
  const auth = await getAuthenticatedClient(userId);
  const calendar = google.calendar({ version: 'v3', auth });
  // PATCH preserves unrelated calendar fields and attendee responses.
  await withRetry(() => calendar.events.patch({ calendarId, eventId,
    requestBody: { ...eventData, description: eventData.description || '', location: eventData.location || '',
      attendees: eventData.attendees || [], status: eventData.status || 'confirmed' } as calendar_v3.Schema$Event }));
}

export async function deleteEvent(userId: string, calendarId: string, eventId: string, etag?: string): Promise<void> {
  const auth = await getAuthenticatedClient(userId);
  const calendar = google.calendar({ version: 'v3', auth });
  await withRetry(async () => {
    try { await calendar.events.delete({ calendarId, eventId }, etag ? { headers: { 'If-Match': etag } } : {}); }
    catch (error: any) { if (![404,410].includes(error.response?.status || error.code)) throw error; }
  });
}
