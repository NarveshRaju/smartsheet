import { Router, Request, Response, NextFunction } from 'express';
import * as googleService from '../services/google.service.js';
import { requireAuth } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';

const router = Router();
router.use(requireAuth);

router.get('/calendars', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.session.userId!;
    const calendars = await googleService.listCalendars(userId);
    res.json({ calendars });
  } catch (error) {
    next(error);
  }
});

export default router;
