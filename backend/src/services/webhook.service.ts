import axios from 'axios';
import { prisma } from './db.js';
import { decrypt } from './crypto.service.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/apiRetry.js';


const SMARTSHEET_API = 'https://api.smartsheet.com/2.0';

async function getAccessToken(userId: string): Promise<string> {
  const account = await prisma.oAuthAccount.findUnique({
    where: { userId_provider: { userId, provider: 'smartsheet' } },
  });
  if (!account) {
    throw Object.assign(new Error('Smartsheet account not connected'), { statusCode: 401 });
  }
  return decrypt(account.accessToken);
}

export function getWebhookCallbackUrl(): string {
  if (env.WEBHOOK_CALLBACK_URL && env.WEBHOOK_CALLBACK_URL.trim().length > 0) {
    return env.WEBHOOK_CALLBACK_URL.trim();
  }
  if (env.RENDER_EXTERNAL_URL && env.RENDER_EXTERNAL_URL.trim().length > 0) {
    return `${env.RENDER_EXTERNAL_URL.trim()}/webhooks/smartsheet`;
  }
  return 'https://smartsheet-gcal-sync.onrender.com/webhooks/smartsheet';
}

export async function createWebhook(
  userId: string,
  sheetId: string,
  callbackUrl?: string
): Promise<string> {
  const token = await getAccessToken(userId);
  const targetCallbackUrl = callbackUrl || getWebhookCallbackUrl();

  return withRetry(async () => {
    const response = await axios.post(
      `${SMARTSHEET_API}/webhooks`,
      {
        name: `SmartsheetGCalSync-${sheetId}`,
        callbackUrl: targetCallbackUrl,
        scope: 'sheet',
        scopeObjectId: parseInt(sheetId, 10),
        events: ['*.*'],
        version: 1,
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const webhookId = response.data.result?.id?.toString() || response.data.id?.toString();
    logger.info(`Created Smartsheet webhook: ${webhookId}`);

    // Enable the webhook
    try {
      await axios.put(
        `${SMARTSHEET_API}/webhooks/${webhookId}`,
        { enabled: true },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        }
      );
      logger.info(`Enabled Smartsheet webhook: ${webhookId}`);
    } catch (putErr: any) {
      logger.warn(`Could not immediately enable webhook ${webhookId}: ${putErr.message}`);
    }

    return webhookId;
  });
}

export async function deleteWebhook(userId: string, webhookId: string): Promise<void> {
  const token = await getAccessToken(userId);

  try {
    await withRetry(async () => {
      await axios.delete(`${SMARTSHEET_API}/webhooks/${webhookId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    });
    logger.info(`Deleted Smartsheet webhook: ${webhookId}`);
  } catch (error: any) {
    // 404 means webhook already deleted
    if (error?.response?.status === 404) {
      logger.info(`Webhook already deleted: ${webhookId}`);
      return;
    }
    throw error;
  }
}

export async function listWebhooks(userId: string) {
  const token = await getAccessToken(userId);

  const response = await axios.get(`${SMARTSHEET_API}/webhooks`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  return response.data.data || [];
}
