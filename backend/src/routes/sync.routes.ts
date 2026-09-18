import { Router, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { prisma } from '../services/db.js';
import { z } from 'zod';
import * as syncService from '../services/sync.service.js';
import * as webhookService from '../services/webhook.service.js';
import { isGroqConfigured } from '../services/groq.service.js';
import { requireAuth } from '../middleware/auth.js';
import { syncLimiter } from '../middleware/rateLimiter.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const router = Router();

router.use(requireAuth);

async function lockConfiguration(id: string): Promise<() => Promise<void>> {
  const owner = randomUUID();
  const acquired = await prisma.syncConfiguration.updateMany({ where: { id, OR: [
    { syncLeaseUntil: null }, { syncLeaseUntil: { isSet: false } }, { syncLeaseUntil: { lt: new Date() } },
  ] }, data: { syncLeaseOwner: owner, syncLeaseUntil: new Date(Date.now() + 600_000) } });
  if (!acquired.count) throw Object.assign(new Error('Sync is running. Try again when it finishes.'), { statusCode: 409 });
  return async () => { await prisma.syncConfiguration.updateMany({ where: { id, syncLeaseOwner: owner }, data: { syncLeaseOwner: null, syncLeaseUntil: null } }); };
}

const syncConfigSchema = z.object({
  smartsheetSheetId: z.string().min(1),
  sheetName: z.string().optional(),
  googleCalendarId: z.string().min(1),
  calendarName: z.string().optional(),
  columnMapping: z.object({
    title: z.string().optional(),
    startDate: z.string().optional(),
    startTime: z.string().optional(),
    endDate: z.string().optional(),
    endTime: z.string().optional(),
    description: z.string().optional(),
    location: z.string().optional(),
    attendee: z.string().optional(),
    status: z.string().optional(),
  }),
  isEnabled: z.boolean().optional(),
});

// ── Create Sync Config ────────────────────────────────────

router.post('/config', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.session.userId!;
    const data = syncConfigSchema.parse(req.body);

    // Check if config already exists for this user
    const existing = await prisma.syncConfiguration.findFirst({ where: { userId } });
    if (existing) {
      res.status(409).json({ error: 'Sync configuration already exists. Use PUT to update.' });
      return;
    }

    const config = await prisma.syncConfiguration.create({
      data: {
        userId,
        smartsheetSheetId: data.smartsheetSheetId,
        sheetName: data.sheetName,
        googleCalendarId: data.googleCalendarId,
        calendarName: data.calendarName,
        columnMapping: data.columnMapping,
        isEnabled: data.isEnabled ?? true,
      },
    });

    // Try to create webhook if enabled
    if (config.isEnabled) {
      try {
        const webhookId = await webhookService.createWebhook(
          userId,
          data.smartsheetSheetId
        );
        await prisma.syncConfiguration.update({
          where: { id: config.id },
          data: { webhookId },
        });
        config.webhookId = webhookId;
      } catch (error: any) {
        logger.warn(`Failed to create webhook: ${error.message}. Auto-sync worker will handle syncing.`);
      }
    }

    if (config.isEnabled) void syncService.fullSync(config.id).catch(error => logger.warn(`Initial sync deferred: ${error.message}`));
    res.status(201).json({ config });
  } catch (error) {
    next(error);
  }
});

// ── Get Sync Config ───────────────────────────────────────

router.get('/config', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.session.userId!;
    const config = await prisma.syncConfiguration.findFirst({ where: { userId } });
    res.json({ config: config || null, isAiConfigured: isGroqConfigured() });
  } catch (error) {
    next(error);
  }
});

// ── Update Sync Config ────────────────────────────────────

router.put('/config', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.session.userId!;
    const data = syncConfigSchema.partial().parse(req.body);

    const existing = await prisma.syncConfiguration.findFirst({ where: { userId } });
    if (!existing) {
      res.status(404).json({ error: 'Sync configuration not found. Use POST to create.' });
      return;
    }

    if ((data.smartsheetSheetId && data.smartsheetSheetId !== existing.smartsheetSheetId) ||
        (data.googleCalendarId && data.googleCalendarId !== existing.googleCalendarId)) {
      res.status(409).json({ error: 'Reset the current configuration before changing its sheet or calendar. Existing calendar entries are retained.' });
      return;
    }
    if (existing.syncLeaseUntil && existing.syncLeaseUntil > new Date()) {
      res.status(409).json({ error: 'A sync is running. Try changing the configuration after it finishes.' });
      return;
    }
    const unlock = await lockConfiguration(existing.id);
    let config;
    try {
      // Handle webhook lifecycle when toggling isEnabled
      if (data.isEnabled !== undefined && data.isEnabled !== existing.isEnabled) {
        if (data.isEnabled) {
          // Enable: create webhook
          try {
            const webhookId = await webhookService.createWebhook(
              userId,
              data.smartsheetSheetId || existing.smartsheetSheetId
            );
            data.isEnabled = true;
            (data as any).webhookId = webhookId;
          } catch (error: any) {
            logger.warn(`Failed to create webhook: ${error.message}. Auto-sync worker will handle syncing.`);
          }
        } else if (!data.isEnabled && existing.webhookId) {
          // Disable: delete webhook
          try {
            await webhookService.deleteWebhook(userId, existing.webhookId);
            (data as any).webhookId = null;
          } catch (error: any) {
            logger.warn(`Failed to delete webhook: ${error.message}`);
          }
        }
      }

      config = await prisma.syncConfiguration.update({
        where: { id: existing.id },
        data: data as any,
      });

    } finally { await unlock(); }
    if (config.isEnabled) void syncService.fullSync(config.id).catch(error => logger.warn(`Configuration sync deferred: ${error.message}`));
    res.json({ config });
  } catch (error) {
    next(error);
  }
});

// ── Reset / Delete Sync Config ────────────────────────────

router.delete('/config', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.session.userId!;
    const config = await prisma.syncConfiguration.findFirst({ where: { userId } });
    if (!config) {
      res.status(404).json({ error: 'No sync configuration found to reset.' });
      return;
    }

    if (config.syncLeaseUntil && config.syncLeaseUntil > new Date()) {
      res.status(409).json({ error: 'A sync is running. Reset after it finishes.' });
      return;
    }
    const unlock = await lockConfiguration(config.id);
    try {
      // Clean up webhook if registered
      if (config.webhookId) {
        try {
          await webhookService.deleteWebhook(userId, config.webhookId);
        } catch (e: any) {
          logger.warn(`Failed to delete webhook during sync reset: ${e.message}`);
        }
      }

      // Delete sync records first
      await prisma.syncRecord.deleteMany({
        where: { syncConfigId: config.id },
      });

      // Delete sync configuration
      await prisma.syncConfiguration.delete({
        where: { id: config.id },
      });

    } finally { await unlock(); }
    logger.info(`User ${userId} reset sync configuration`);
    res.json({ success: true, message: 'Sync configuration reset successfully' });
  } catch (error) {
    next(error);
  }
});

// ── Full Sync ─────────────────────────────────────────────

router.post('/full', syncLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.session.userId!;
    const config = await prisma.syncConfiguration.findFirst({ where: { userId } });
    if (!config) {
      res.status(404).json({ error: 'No sync configuration found.' });
      return;
    }

    const result = await syncService.fullSync(config.id);
    res.json({ result });
  } catch (error) {
    next(error);
  }
});

// ── Sync Single Row ───────────────────────────────────────

router.post('/:rowId', syncLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.session.userId!;
    const config = await prisma.syncConfiguration.findFirst({ where: { userId } });
    if (!config) {
      res.status(404).json({ error: 'No sync configuration found.' });
      return;
    }

    await syncService.syncRow(config.id, req.params.rowId as string, 'updated');
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// ── Retry Failed Sync ─────────────────────────────────────

router.post('/:rowId/retry', syncLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.session.userId!;
    const config = await prisma.syncConfiguration.findFirst({ where: { userId } });
    if (!config) {
      res.status(404).json({ error: 'No sync configuration found.' });
      return;
    }

    // Find the sync record by row ID
    const record = await prisma.syncRecord.findUnique({
      where: {
        syncConfigId_smartsheetRowId: {
          syncConfigId: config.id,
          smartsheetRowId: req.params.rowId as string,
        },
      },
    });

    if (!record) {
      res.status(404).json({ error: 'Sync record not found.' });
      return;
    }

    await syncService.retrySyncRecord(record.id);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// ── Sync Status ───────────────────────────────────────────

router.get('/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.session.userId!;
    const config = await prisma.syncConfiguration.findFirst({ where: { userId } });
    if (!config) {
      res.json({ config: null, stats: null, failedRecords: [], recentRecords: [], isAiConfigured: isGroqConfigured() });
      return;
    }

    const status = await syncService.getSyncStatus(config.id);
    res.json({ ...status, isAiConfigured: isGroqConfigured() });
  } catch (error) {
    next(error);
  }
});

export default router;
