import { Router, Request, Response, NextFunction } from 'express';
import * as smartsheetService from '../services/smartsheet.service.js';
import { requireAuth } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';

const router = Router();
router.use(requireAuth);

router.get('/sheets', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.session.userId!;
    const sheets = await smartsheetService.listSheets(userId);
    res.json({ sheets });
  } catch (error) {
    next(error);
  }
});

router.get('/sheets/:id/columns', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.session.userId!;
    const columns = await smartsheetService.getSheetColumns(userId, req.params.id as string);
    res.json({ columns });
  } catch (error) {
    next(error);
  }
});

export default router;
