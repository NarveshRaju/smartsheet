import { google, calendar_v3 } from 'googleapis';
import { PrismaClient } from '@prisma/client';
import { encrypt, decrypt } from './crypto.service.js';
import { withRetry } from '../utils/apiRetry.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import type { CalendarEventData } from '../types/index.js';

const prisma = new PrismaClient();

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
async function getAuthenticatedClient(userId: string) {
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

export async function listCalendarEvents(
  userId: string,
  calendarId: string,
  timeMin?: string,
  timeMax?: string
): Promise<calendar_v3.Schema$Event[]> {
  const auth = await getAuthenticatedClient(userId);
  const calendar = google.calendar({ version: 'v3', auth });

  return withRetry(async () => {
    const allEvents: calendar_v3.Schema$Event[] = [];
    let pageToken: string | undefined = undefined;

    do {
      const response: calendar_v3.Schema$Events = (
        await calendar.events.list({
          calendarId,
          maxResults: 2500,
          singleEvents: true,
          showDeleted: false,
          timeMin,
          timeMax,
          pageToken,
        })
      ).data;

      if (response.items) {
        allEvents.push(...response.items);
      }
      pageToken = response.nextPageToken || undefined;
    } while (pageToken);

    logger.debug(`Fetched ${allEvents.length} events from calendar ${calendarId} for deduplication check`);
    return allEvents;
  });
}

export async function findExistingEvent(
  userId: string,
  calendarId: string,
  query: string
): Promise<calendar_v3.Schema$Event[]> {
  const auth = await getAuthenticatedClient(userId);
  const calendar = google.calendar({ version: 'v3', auth });

  return withRetry(async () => {
    const response = await calendar.events.list({
      calendarId,
      q: query,
      maxResults: 25,
      singleEvents: true,
      showDeleted: false,
    });
    return response.data.items || [];
  });
}

export async function createEvent(
  userId: string,
  calendarId: string,
  eventData: CalendarEventData
): Promise<string> {
  const auth = await getAuthenticatedClient(userId);
  const calendar = google.calendar({ version: 'v3', auth });

  return withRetry(async () => {
    const response = await calendar.events.insert({
      calendarId,
      requestBody: eventData as calendar_v3.Schema$Event,
    });
    logger.info(`Created Google Calendar event: ${response.data.id}`);
    return response.data.id!;
  });
}

export async function updateEvent(
  userId: string,
  calendarId: string,
  eventId: string,
  eventData: CalendarEventData
): Promise<void> {
  const auth = await getAuthenticatedClient(userId);
  const calendar = google.calendar({ version: 'v3', auth });

  await withRetry(async () => {
    await calendar.events.update({
      calendarId,
      eventId,
      requestBody: eventData as calendar_v3.Schema$Event,
    });
    logger.info(`Updated Google Calendar event: ${eventId}`);
  });
}

export async function deleteEvent(
  userId: string,
  calendarId: string,
  eventId: string
): Promise<void> {
  const auth = await getAuthenticatedClient(userId);
  const calendar = google.calendar({ version: 'v3', auth });

  await withRetry(async () => {
    try {
      await calendar.events.delete({ calendarId, eventId });
      logger.info(`Deleted Google Calendar event: ${eventId}`);
    } catch (error: any) {
      // 404/410 means event already deleted — that's fine
      if (error?.response?.status === 404 || error?.response?.status === 410) {
        logger.info(`Google Calendar event already deleted: ${eventId}`);
        return;
      }
      throw error;
    }
  });
}

export async function getEvent(
  userId: string,
  calendarId: string,
  eventId: string
): Promise<calendar_v3.Schema$Event | null> {
  const auth = await getAuthenticatedClient(userId);
  const calendar = google.calendar({ version: 'v3', auth });

  try {
    const response = await calendar.events.get({ calendarId, eventId });
    return response.data;
  } catch (error: any) {
    if (error?.response?.status === 404 || error?.response?.status === 410) {
      return null;
    }
    throw error;
  }
}
