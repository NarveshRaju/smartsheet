import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';

/**
 * Simple auth guard for single-user mode.
 * Checks that the session has a userId set (established during Google OAuth login).
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session?.userId) {
    logger.debug('Unauthenticated request blocked: ' + req.path);
    res.status(401).json({ error: 'Authentication required. Please connect your Google account.' });
    return;
  }
  (req as any).userId = req.session.userId;
  next();
}
