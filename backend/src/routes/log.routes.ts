import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getSystemLogs, clearSystemLogs } from '../utils/logger.js';

const router = Router();

router.use(requireAuth);

/**
 * GET /api/logs
 * Retrieve system & sync execution logs
 */
router.get('/', (req: Request, res: Response) => {
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 200;
  const level = (req.query.level as string) || 'all';
  const search = (req.query.search as string) || '';
  const configId = (req.query.configId as string) || '';

  const { logs, total } = getSystemLogs({ limit, level, search, configId });
  res.json({ logs, total });
});

/**
 * DELETE /api/logs
 * Clear in-memory log buffer
 */
router.delete('/', (_req: Request, res: Response) => {
  clearSystemLogs();
  res.json({ success: true, message: 'Logs cleared successfully' });
});

export default router;
