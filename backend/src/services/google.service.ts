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

/**
 * Safely resolves a calendar ID for Google Calendar API calls.
 * - Handles primary calendar aliases ('primary')
 * - Resolves email address IDs to 'primary' if they are the primary calendar
 * - If calendar is not found in user's calendar list, falls back gracefully to 'primary'
 */
async function getSafeCalendarId(
  calendar: calendar_v3.Calendar,
  calendarId: string
): Promise<string> {
  if (!calendarId || calendarId === 'primary') {
    return 'primary';
  }

  try {
    const listRes = await calendar.calendarList.list({ minAccessRole: 'writer' });
    const items = listRes.data.items || [];

    // 1. Check for exact match in calendarList
    const exact = items.find((c) => c.id === calendarId);
    if (exact) {
      if (exact.primary) return 'primary';
      return exact.id!;
    }

    // 2. Check if calendarId matches summary (name) of any calendar
    const matchSummary = items.find(
      (c) => c.summary?.toLowerCase() === calendarId.toLowerCase()
    );
    if (matchSummary) {
      if (matchSummary.primary) return 'primary';
      return matchSummary.id!;
    }

    // 3. Fallback: if not found, use user's primary calendar to prevent 404
    const primary = items.find((c) => c.primary) || items[0];
    if (primary) {
      logger.warn(`Calendar "${calendarId}" not found in user calendar list. Falling back to primary calendar.`);
      return 'primary';
    }
  } catch (err: any) {
    logger.warn(`Could not verify calendar list for "${calendarId}": ${err.message}`);
  }

  return calendarId;
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
    let targetCalendarId = await getSafeCalendarId(calendar, calendarId);
    const allEvents: calendar_v3.Schema$Event[] = [];
    let pageToken: string | undefined = undefined;

    try {
      do {
        const response: calendar_v3.Schema$Events = (
          await calendar.events.list({
            calendarId: targetCalendarId,
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
    } catch (err: any) {
      if (err?.response?.status === 404 && targetCalendarId !== 'primary') {
        logger.warn(`Calendar "${targetCalendarId}" returned 404 on list events, retrying with "primary"`);
        targetCalendarId = 'primary';
        const response = await calendar.events.list({
          calendarId: 'primary',
          maxResults: 2500,
          singleEvents: true,
          showDeleted: false,
          timeMin,
          timeMax,
        });
        if (response.data.items) {
          allEvents.push(...response.data.items);
        }
      } else {
        throw err;
      }
    }

    logger.debug(`Fetched ${allEvents.length} events from calendar ${targetCalendarId} for deduplication check`);
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
    let targetCalendarId = await getSafeCalendarId(calendar, calendarId);
    try {
      const response = await calendar.events.list({
        calendarId: targetCalendarId,
        q: query,
        maxResults: 25,
        singleEvents: true,
        showDeleted: false,
      });
      return response.data.items || [];
    } catch (err: any) {
      if (err?.response?.status === 404 && targetCalendarId !== 'primary') {
        logger.warn(`Calendar "${targetCalendarId}" returned 404 on search, retrying with "primary"`);
        const response = await calendar.events.list({
          calendarId: 'primary',
          q: query,
          maxResults: 25,
          singleEvents: true,
          showDeleted: false,
        });
        return response.data.items || [];
      }
      throw err;
    }
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
    let targetCalendarId = await getSafeCalendarId(calendar, calendarId);
    let response: any;
    try {
      response = await calendar.events.insert({
        calendarId: targetCalendarId,
        requestBody: eventData as calendar_v3.Schema$Event,
      });
    } catch (err: any) {
      if (err?.response?.status === 404 && targetCalendarId !== 'primary') {
        logger.warn(`Calendar "${targetCalendarId}" returned 404 on event create, retrying with "primary"`);
        response = await calendar.events.insert({
          calendarId: 'primary',
          requestBody: eventData as calendar_v3.Schema$Event,
        });
      } else {
        throw err;
      }
    }
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
    let targetCalendarId = await getSafeCalendarId(calendar, calendarId);
    try {
      await calendar.events.update({
        calendarId: targetCalendarId,
        eventId,
        requestBody: eventData as calendar_v3.Schema$Event,
      });
    } catch (err: any) {
      if (err?.response?.status === 404 && targetCalendarId !== 'primary') {
        logger.warn(`Calendar "${targetCalendarId}" returned 404 on event update, retrying with "primary"`);
        await calendar.events.update({
          calendarId: 'primary',
          eventId,
          requestBody: eventData as calendar_v3.Schema$Event,
        });
      } else {
        throw err;
      }
    }
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
    let targetCalendarId = await getSafeCalendarId(calendar, calendarId);
    try {
      await calendar.events.delete({ calendarId: targetCalendarId, eventId });
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

  let targetCalendarId = await getSafeCalendarId(calendar, calendarId);
  try {
    const response = await calendar.events.get({ calendarId: targetCalendarId, eventId });
    return response.data;
  } catch (error: any) {
    if (error?.response?.status === 404 || error?.response?.status === 410) {
      return null;
    }
    throw error;
  }
}
