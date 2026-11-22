import { Router, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { prisma } from '../services/db.js';
import { z } from 'zod';
import * as syncService from '../services/sync.service.js';
import * as webhookService from '../services/webhook.service.js';
import { isGroqConfigured } from '../services/groq.service.js';
import { requireAuth } from '../middleware/auth.js';
import { syncLimiter, progressLimiter } from '../middleware/rateLimiter.js';
import { logger } from '../utils/logger.js';

const router = Router();

router.use(requireAuth);

async function lockConfiguration(id: string): Promise<() => Promise<void>> {
  const owner = randomUUID();
  const acquired = await prisma.syncConfiguration.updateMany({
    where: {
      id,
      OR: [
        { syncLeaseUntil: null },
        { syncLeaseUntil: { isSet: false } },
        { syncLeaseUntil: { lt: new Date() } },
      ],
    },
    data: { syncLeaseOwner: owner, syncLeaseUntil: new Date(Date.now() + 600_000) },
  });
  if (!acquired.count) {
    throw Object.assign(new Error('Sync is running. Try again when it finishes.'), { statusCode: 409 });
  }
  return async () => {
    await prisma.syncConfiguration.updateMany({
      where: { id, syncLeaseOwner: owner },
      data: { syncLeaseOwner: null, syncLeaseUntil: null },
    });
  };
}

const syncConfigSchema = z.object({
  name: z.string().optional(),
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

// ── Multi-Project: List All Configurations ────────────────

router.get('/configs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.session.userId!;
    const configs = await syncService.getAllConfigsWithStats(userId);
    res.json({
      configs,
      isAiConfigured: isGroqConfigured(),
    });
  } catch (error) {
    next(error);
  }
});

// ── Multi-Project: Create Configuration ───────────────────

router.post('/configs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.session.userId!;
    const data = syncConfigSchema.parse(req.body);

    const defaultName = data.name?.trim() ||
      `${data.sheetName || 'Sheet'} ➔ ${data.calendarName || 'Calendar'}`;

    const config = await prisma.syncConfiguration.create({
      data: {
        userId,
        name: defaultName,
        smartsheetSheetId: data.smartsheetSheetId,
        sheetName: data.sheetName,
        googleCalendarId: data.googleCalendarId,
        calendarName: data.calendarName,
        columnMapping: data.columnMapping,
        isEnabled: data.isEnabled ?? true,
      },
    });

    // Register webhook if enabled
    if (config.isEnabled) {
      try {
        const webhookId = await webhookService.createWebhook(userId, data.smartsheetSheetId);
        await prisma.syncConfiguration.update({
          where: { id: config.id },
          data: { webhookId },
        });
        config.webhookId = webhookId;
      } catch (error: any) {
        logger.warn(`Failed to create webhook for config ${config.id}: ${error.message}. Auto-sync worker will handle syncing.`);
      }
    }

    if (config.isEnabled) {
      void syncService.fullSync(config.id).catch((error) =>
        logger.warn(`Initial sync deferred for config ${config.id}: ${error.message}`)
      );
    }

    logger.info(`User ${userId} created sync connection: "${config.name}" (${config.id})`);
    res.status(201).json({ config });
  } catch (error) {
    next(error);
  }
});

// ── Multi-Project: Get Single Configuration ───────────────

router.get('/configs/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.session.userId!;
    const config = await prisma.syncConfiguration.findFirst({
      where: { id: req.params.id as string, userId },
    });
    if (!config) {
      res.status(404).json({ error: 'Connection not found.' });
      return;
    }
    res.json({ config, isAiConfigured: isGroqConfigured() });
  } catch (error) {
    next(error);
  }
});

// ── Multi-Project: Update Configuration ───────────────────

router.put('/configs/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.session.userId!;
    const id = req.params.id as string;
    const data = syncConfigSchema.partial().parse(req.body);

    const existing = await prisma.syncConfiguration.findFirst({
      where: { id, userId },
    });

    if (!existing) {
      res.status(404).json({ error: 'Connection not found.' });
      return;
    }

    if (
      (data.smartsheetSheetId && data.smartsheetSheetId !== existing.smartsheetSheetId) ||
      (data.googleCalendarId && data.googleCalendarId !== existing.googleCalendarId)
    ) {
      res.status(409).json({
        error: 'Reset this connection before changing its sheet or calendar. Existing calendar entries are retained.',
      });
      return;
    }

    if (existing.syncLeaseUntil && existing.syncLeaseUntil > new Date()) {
      res.status(409).json({ error: 'A sync is running for this connection. Try changing configuration after it finishes.' });
      return;
    }

    const unlock = await lockConfiguration(existing.id);
    let config;
    try {
      // Handle webhook lifecycle when toggling isEnabled
      if (data.isEnabled !== undefined && data.isEnabled !== existing.isEnabled) {
        if (data.isEnabled) {
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
    } finally {
      await unlock();
    }

    if (config.isEnabled) {
      void syncService.fullSync(config.id).catch((error) =>
        logger.warn(`Configuration sync deferred: ${error.message}`)
      );
    }

    res.json({ config });
  } catch (error) {
    next(error);
  }
});

// ── Multi-Project: Delete Configuration ───────────────────

router.delete('/configs/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.session.userId!;
    const id = req.params.id as string;

    const config = await prisma.syncConfiguration.findFirst({
      where: { id, userId },
    });

    if (!config) {
      res.status(404).json({ error: 'Connection not found.' });
      return;
    }

    if (config.syncLeaseUntil && config.syncLeaseUntil > new Date()) {
      res.status(409).json({ error: 'A sync is running for this connection. Delete after it finishes.' });
      return;
    }

    const unlock = await lockConfiguration(config.id);
    try {
      if (config.webhookId) {
        try {
          await webhookService.deleteWebhook(userId, config.webhookId);
        } catch (e: any) {
          logger.warn(`Failed to delete webhook during connection delete: ${e.message}`);
        }
      }

      await prisma.syncRecord.deleteMany({
        where: { syncConfigId: config.id },
      });

      await prisma.syncConfiguration.delete({
        where: { id: config.id },
      });
    } finally {
      await unlock();
    }

    logger.info(`User ${userId} deleted connection ${config.name || config.id}`);
    res.json({ success: true, message: 'Connection removed successfully.' });
  } catch (error) {
    next(error);
  }
});

// ── Multi-Project: Trigger Sync for Specific Config ───────

router.post('/configs/:id/full', syncLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.session.userId!;
    const id = req.params.id as string;

    const config = await prisma.syncConfiguration.findFirst({
      where: { id, userId },
    });

    if (!config) {
      res.status(404).json({ error: 'Connection not found.' });
      return;
    }

    const run = syncService.startFullSync(config.id);
    res.status(202).json({ runId: run.runId, configId: config.id });
  } catch (error) {
    next(error);
  }
});

// ── Multi-Project: Check Run Progress ─────────────────────

router.get('/configs/:id/runs/:runId', progressLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.session.userId!;
    const id = req.params.id as string;
    const runId = req.params.runId as string;

    const config = await prisma.syncConfiguration.findFirst({
      where: { id, userId },
    });

    const run = config && syncService.getRun(config.id, runId);
    if (!run) {
      res.status(404).json({
        error: 'Sync progress is unavailable after a server restart. Check Sync Status before starting another run.',
      });
      return;
    }
    res.json({ run });
  } catch (error) {
    next(error);
  }
});

// ── Multi-Project: Detailed Status for Specific Config ────

router.get('/configs/:id/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.session.userId!;
    const id = req.params.id as string;

    const config = await prisma.syncConfiguration.findFirst({
      where: { id, userId },
    });

    if (!config) {
      res.status(404).json({ error: 'Connection not found.' });
      return;
    }

    const status = await syncService.getSyncStatus(config.id);
    res.json({ ...status, isAiConfigured: isGroqConfigured() });
  } catch (error) {
    next(error);
  }
});

// ── Multi-Project: Retry Single Row in Specific Config ────

router.post('/configs/:id/rows/:rowId/retry', syncLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.session.userId!;
    const id = req.params.id as string;
    const rowId = req.params.rowId as string;

    const config = await prisma.syncConfiguration.findFirst({
      where: { id, userId },
    });

    if (!config) {
      res.status(404).json({ error: 'Connection not found.' });
      return;
    }

    const record = await prisma.syncRecord.findUnique({
      where: {
        syncConfigId_smartsheetRowId: {
          syncConfigId: config.id,
          smartsheetRowId: rowId,
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

// ── Multi-Project: Retry All Failed Rows in Specific Config ──

router.post('/configs/:id/retry-all', syncLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.session.userId!;
    const id = req.params.id as string;

    const config = await prisma.syncConfiguration.findFirst({
      where: { id, userId },
    });

    if (!config) {
      res.status(404).json({ error: 'Connection not found.' });
      return;
    }

    const result = await syncService.retryAllFailedRecords(config.id);
    res.json({ success: true, result });
  } catch (error) {
    next(error);
  }
});

// ── Multi-Project: Sync All Enabled Connections ───────────

router.post('/full-all', syncLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.session.userId!;
    const configs = await prisma.syncConfiguration.findMany({
      where: { userId, isEnabled: true },
    });

    const runs = configs.map((c) => ({
      configId: c.id,
      name: c.name || `${c.sheetName} ➔ ${c.calendarName}`,
      runId: syncService.startFullSync(c.id).runId,
    }));

    res.json({ success: true, runs, count: runs.length });
  } catch (error) {
    next(error);
  }
});

// ── Legacy / Backward-Compatible Endpoints ────────────────

// POST /config: Create or update first config
router.post('/config', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.session.userId!;
    const data = syncConfigSchema.parse(req.body);

    const existing = await prisma.syncConfiguration.findFirst({ where: { userId } });
    if (existing) {
      res.status(409).json({ error: 'Sync configuration already exists. Use PUT to update.' });
      return;
    }

    const config = await prisma.syncConfiguration.create({
      data: {
        userId,
        name: data.name || `${data.sheetName || 'Sheet'} ➔ ${data.calendarName || 'Calendar'}`,
        smartsheetSheetId: data.smartsheetSheetId,
        sheetName: data.sheetName,
        googleCalendarId: data.googleCalendarId,
        calendarName: data.calendarName,
        columnMapping: data.columnMapping,
        isEnabled: data.isEnabled ?? true,
      },
    });

    if (config.isEnabled) {
      try {
        const webhookId = await webhookService.createWebhook(userId, data.smartsheetSheetId);
        await prisma.syncConfiguration.update({
          where: { id: config.id },
          data: { webhookId },
        });
        config.webhookId = webhookId;
      } catch (error: any) {
        logger.warn(`Failed to create webhook: ${error.message}. Auto-sync worker will handle syncing.`);
      }
    }

    if (config.isEnabled) {
      void syncService.fullSync(config.id).catch((error) =>
        logger.warn(`Initial sync deferred: ${error.message}`)
      );
    }
    res.status(201).json({ config });
  } catch (error) {
    next(error);
  }
});

// GET /config: Get first config
router.get('/config', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.session.userId!;
    const config = await prisma.syncConfiguration.findFirst({ where: { userId } });
    res.json({ config: config || null, isAiConfigured: isGroqConfigured() });
  } catch (error) {
    next(error);
  }
});

// PUT /config: Update first config
router.put('/config', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.session.userId!;
    const data = syncConfigSchema.partial().parse(req.body);

    const existing = await prisma.syncConfiguration.findFirst({ where: { userId } });
    if (!existing) {
      res.status(404).json({ error: 'Sync configuration not found. Use POST to create.' });
      return;
    }

    if (
      (data.smartsheetSheetId && data.smartsheetSheetId !== existing.smartsheetSheetId) ||
      (data.googleCalendarId && data.googleCalendarId !== existing.googleCalendarId)
    ) {
      res.status(409).json({
        error: 'Reset the current configuration before changing its sheet or calendar. Existing calendar entries are retained.',
      });
      return;
    }
    if (existing.syncLeaseUntil && existing.syncLeaseUntil > new Date()) {
      res.status(409).json({ error: 'A sync is running. Try changing the configuration after it finishes.' });
      return;
    }
    const unlock = await lockConfiguration(existing.id);
    let config;
    try {
      if (data.isEnabled !== undefined && data.isEnabled !== existing.isEnabled) {
        if (data.isEnabled) {
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
    } finally {
      await unlock();
    }
    if (config.isEnabled) {
      void syncService.fullSync(config.id).catch((error) =>
        logger.warn(`Configuration sync deferred: ${error.message}`)
      );
    }
    res.json({ config });
  } catch (error) {
    next(error);
  }
});

// DELETE /config: Delete first config
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
      if (config.webhookId) {
        try {
          await webhookService.deleteWebhook(userId, config.webhookId);
        } catch (e: any) {
          logger.warn(`Failed to delete webhook during sync reset: ${e.message}`);
        }
      }

      await prisma.syncRecord.deleteMany({
        where: { syncConfigId: config.id },
      });

      await prisma.syncConfiguration.delete({
        where: { id: config.id },
      });
    } finally {
      await unlock();
    }
    logger.info(`User ${userId} reset sync configuration`);
    res.json({ success: true, message: 'Sync configuration reset successfully' });
  } catch (error) {
    next(error);
  }
});

// POST /full: Full sync for first config
router.post('/full', syncLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.session.userId!;
    const config = await prisma.syncConfiguration.findFirst({ where: { userId } });
    if (!config) {
      res.status(404).json({ error: 'No sync configuration found.' });
      return;
    }

    const run = syncService.startFullSync(config.id);
    res.status(202).json({ runId: run.runId });
  } catch (error) {
    next(error);
  }
});

// GET /runs/:runId
router.get('/runs/:runId', progressLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await prisma.syncConfiguration.findFirst({ where: { userId: req.session.userId! } });
    const run = config && syncService.getRun(config.id, req.params.runId as string);
    if (!run) {
      res.status(404).json({
        error: 'Sync progress is unavailable after a server restart. Check Sync Status before starting another run.',
      });
      return;
    }
    res.json({ run });
  } catch (error) {
    next(error);
  }
});

// POST /:rowId
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

// POST /:rowId/retry
router.post('/:rowId/retry', syncLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.session.userId!;
    const config = await prisma.syncConfiguration.findFirst({ where: { userId } });
    if (!config) {
      res.status(404).json({ error: 'No sync configuration found.' });
      return;
    }

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

// GET /status: Sync status for first config
router.get('/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.session.userId!;
    const config = await prisma.syncConfiguration.findFirst({ where: { userId } });
    if (!config) {
      res.json({
        config: null,
        stats: null,
        failedRecords: [],
        recentRecords: [],
        isAiConfigured: isGroqConfigured(),
      });
      return;
    }

    const status = await syncService.getSyncStatus(config.id);
    res.json({ ...status, isAiConfigured: isGroqConfigured() });
  } catch (error) {
    next(error);
  }
});

export default router;
