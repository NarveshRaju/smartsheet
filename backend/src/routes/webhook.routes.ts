import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import * as syncService from '../services/sync.service.js';
import { webhookLimiter } from '../middleware/rateLimiter.js';
import { logger } from '../utils/logger.js';
import type { SmartsheetWebhookPayload } from '../types/index.js';

const router = Router();
const prisma = new PrismaClient();

/**
 * POST /webhooks/smartsheet
 * Handles Smartsheet webhook callbacks.
 * This route does NOT require user auth — it's called by Smartsheet directly.
 */
router.post('/smartsheet', webhookLimiter, async (req: Request, res: Response) => {
  try {
    // Handle Smartsheet verification challenge (via header, body, or query)
    const challenge =
      (req.headers['smartsheet-hook-challenge'] as string) ||
      (req.body && req.body.challenge) ||
      (req.body && req.body.smartsheetHookChallenge) ||
      (req.query && (req.query.challenge as string));

    if (challenge) {
      logger.info(`Smartsheet webhook verification challenge received: ${challenge}`);
      res.status(200).json({ smartsheetHookResponse: challenge });
      return;
    }

    const payload = req.body as SmartsheetWebhookPayload;
    if (!payload || !payload.webhookId || !payload.events) {
      res.status(400).json({ error: 'Invalid webhook payload' });
      return;
    }

    logger.info(`Webhook received: ${payload.events.length} events for webhook ${payload.webhookId}`);

    // Find the sync config for this webhook
    const config = await prisma.syncConfiguration.findFirst({
      where: { webhookId: payload.webhookId.toString() },
    });

    if (!config || !config.isEnabled) {
      logger.warn(`Webhook ${payload.webhookId}: no active config found, ignoring`);
      res.status(200).json({ success: true });
      return;
    }

    // Respond quickly to Smartsheet (must respond within 30 seconds)
    res.status(200).json({ success: true });

    // Process events asynchronously
    const rowEvents = payload.events.filter((e) => e.objectType === 'row' || e.objectType === 'cell');
    const processedRowIds = new Set<string>();

    for (const event of rowEvents) {
      const rowId = (event.rowId || event.id)?.toString();
      if (!rowId || processedRowIds.has(rowId)) continue;
      processedRowIds.add(rowId);

      let action: 'created' | 'updated' | 'deleted';
      if (event.eventType === 'created') {
        action = 'created';
      } else if (event.eventType === 'deleted') {
        action = 'deleted';
      } else {
        action = 'updated';
      }

      try {
        await syncService.syncRow(config.id, rowId, action);
        logger.info(`Webhook sync: row ${rowId} ${action}`);
      } catch (error: any) {
        logger.error(`Webhook sync failed for row ${rowId}: ${error.message}`);
        // Error already recorded in syncRow, continue with next event
      }
    }
  } catch (error: any) {
    logger.error(`Webhook handler error: ${error.message}`);
    // Still return 200 to avoid Smartsheet retrying
    if (!res.headersSent) {
      res.status(200).json({ success: true });
    }
  }
});

export default router;
