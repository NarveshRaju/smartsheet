import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as googleService from '../services/google.service.js';
import { requireAuth } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';

const router = Router();
router.use(requireAuth);

const createCalendarSchema = z.object({
  summary: z.string().trim().min(1, 'Calendar name is required').max(200),
  description: z.string().trim().max(1000).optional(),
  timeZone: z.string().optional(),
});

router.get('/calendars', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.session.userId!;
    const calendars = await googleService.listCalendars(userId);
    res.json({ calendars });
  } catch (error) {
    next(error);
  }
});

router.post('/calendars', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.session.userId!;
    const { summary, description, timeZone } = createCalendarSchema.parse(req.body);
    const calendar = await googleService.createCalendar(userId, summary, description, timeZone);
    res.status(201).json({ calendar });
  } catch (error) {
    next(error);
  }
});

export default router;
