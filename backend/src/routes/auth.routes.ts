import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import * as googleService from '../services/google.service.js';
import * as smartsheetService from '../services/smartsheet.service.js';
import * as webhookService from '../services/webhook.service.js';
import { encrypt } from '../services/crypto.service.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const router = Router();
const prisma = new PrismaClient();

function getRedirectUrl(req: Request, queryParam: string): string {
  if (env.NODE_ENV === 'production' && !process.env.FRONTEND_URL) {
    return `/?${queryParam}`;
  }
  const base = env.FRONTEND_URL || `${req.protocol}://${req.get('host')}`;
  return `${base}?${queryParam}`;
}

// ── Google OAuth ──────────────────────────────────────────

router.get('/google', (req: Request, res: Response) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.googleState = state;
  const authUrl = googleService.getGoogleAuthUrl(state);
  res.redirect(authUrl);
});

router.get('/google/callback', async (req: Request, res: Response) => {
  try {
    const { code, state } = req.query;

    if (!code || typeof code !== 'string') {
      res.redirect(getRedirectUrl(req, 'error=google_no_code'));
      return;
    }

    if (state !== req.session.googleState) {
      res.redirect(getRedirectUrl(req, 'error=google_state_mismatch'));
      return;
    }

    delete req.session.googleState;

    const { tokens, userInfo } = await googleService.handleGoogleCallback(code);

    let user = await prisma.user.findFirst();
    if (!user) {
      user = await prisma.user.create({
        data: {
          email: userInfo.email,
          displayName: userInfo.name,
          isAdmin: true,
        },
      });
      logger.info(`Created admin user: ${user.id}`);
    }

    await prisma.oAuthAccount.upsert({
      where: { userId_provider: { userId: user.id, provider: 'google' } },
      create: {
        userId: user.id,
        provider: 'google',
        providerAccountId: userInfo.id,
        accessToken: encrypt(tokens.access_token!),
        refreshToken: tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
        tokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        scopes: tokens.scope || null,
      },
      update: {
        providerAccountId: userInfo.id,
        accessToken: encrypt(tokens.access_token!),
        refreshToken: tokens.refresh_token ? encrypt(tokens.refresh_token) : undefined,
        tokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        scopes: tokens.scope || null,
      },
    });

    req.session.userId = user.id;

    logger.info(`Google OAuth completed for user ${user.id}`);
    res.redirect(getRedirectUrl(req, 'auth=google_success'));
  } catch (error: any) {
    logger.error(`Google OAuth callback error: ${error.message}`);
    res.redirect(getRedirectUrl(req, 'error=google_auth_failed'));
  }
});

// ── Smartsheet OAuth ──────────────────────────────────────

router.get('/smartsheet', (req: Request, res: Response) => {
  if (!req.session.userId) {
    res.redirect(getRedirectUrl(req, 'error=login_required'));
    return;
  }
  const state = crypto.randomBytes(16).toString('hex');
  req.session.smartsheetState = state;
  const authUrl = smartsheetService.getSmartsheetAuthUrl(state);
  res.redirect(authUrl);
});

router.get('/smartsheet/callback', async (req: Request, res: Response) => {
  try {
    const { code, state } = req.query;

    if (!code || typeof code !== 'string') {
      res.redirect(getRedirectUrl(req, 'error=smartsheet_no_code'));
      return;
    }

    if (state !== req.session.smartsheetState) {
      res.redirect(getRedirectUrl(req, 'error=smartsheet_state_mismatch'));
      return;
    }

    delete req.session.smartsheetState;

    const userId = req.session.userId;
    if (!userId) {
      res.redirect(getRedirectUrl(req, 'error=login_required'));
      return;
    }

    const tokenData = await smartsheetService.handleSmartsheetCallback(code);

    await prisma.oAuthAccount.upsert({
      where: { userId_provider: { userId, provider: 'smartsheet' } },
      create: {
        userId,
        provider: 'smartsheet',
        accessToken: encrypt(tokenData.access_token),
        refreshToken: tokenData.refresh_token ? encrypt(tokenData.refresh_token) : null,
        tokenExpiresAt: new Date(Date.now() + tokenData.expires_in * 1000),
      },
      update: {
        accessToken: encrypt(tokenData.access_token),
        refreshToken: tokenData.refresh_token ? encrypt(tokenData.refresh_token) : undefined,
        tokenExpiresAt: new Date(Date.now() + tokenData.expires_in * 1000),
      },
    });

    logger.info(`Smartsheet OAuth completed for user ${userId}`);
    res.redirect(getRedirectUrl(req, 'auth=smartsheet_success'));
  } catch (error: any) {
    logger.error(`Smartsheet OAuth callback error: ${error.message}`);
    res.redirect(getRedirectUrl(req, 'error=smartsheet_auth_failed'));
  }
});

// ── Connection Status ─────────────────────────────────────

router.get('/status', async (req: Request, res: Response) => {
  try {
    const userId = req.session?.userId;
    if (!userId) {
      res.json({ authenticated: false, google: false, smartsheet: false });
      return;
    }

    const accounts = await prisma.oAuthAccount.findMany({
      where: { userId },
      select: { provider: true, providerAccountId: true, tokenExpiresAt: true },
    });

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, displayName: true },
    });

    const google = accounts.find((a) => a.provider === 'google');
    const smartsheet = accounts.find((a) => a.provider === 'smartsheet');

    res.json({
      authenticated: true,
      user: { email: user?.email, displayName: user?.displayName },
      google: !!google,
      googleExpiry: google?.tokenExpiresAt,
      smartsheet: !!smartsheet,
      smartsheetExpiry: smartsheet?.tokenExpiresAt,
    });
  } catch (error: any) {
    logger.error(`Auth status error: ${error.message}`);
    res.status(500).json({ error: 'Failed to get auth status' });
  }
});

// ── Disconnect Provider ───────────────────────────────────

router.post('/disconnect/:provider', async (req: Request, res: Response) => {
  try {
    const userId = req.session?.userId;
    const { provider } = req.params;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    if (provider !== 'google' && provider !== 'smartsheet') {
      res.status(400).json({ error: 'Invalid provider' });
      return;
    }

    if (provider === 'smartsheet') {
      const config = await prisma.syncConfiguration.findFirst({ where: { userId } });
      if (config?.webhookId) {
        try {
          await webhookService.deleteWebhook(userId, config.webhookId);
          await prisma.syncConfiguration.update({
            where: { id: config.id },
            data: { webhookId: null, isEnabled: false },
          });
        } catch (e: any) {
          logger.warn(`Failed to clean up webhook on disconnect: ${e.message}`);
        }
      }
    }

    await prisma.oAuthAccount.deleteMany({
      where: { userId, provider },
    });

    logger.info(`User ${userId} disconnected provider ${provider}`);
    res.json({ success: true, provider });
  } catch (error: any) {
    logger.error(`Disconnect error: ${error.message}`);
    res.status(500).json({ error: 'Failed to disconnect account' });
  }
});

// ── Logout ────────────────────────────────────────────────

router.post('/logout', (req: Request, res: Response) => {
  req.session.destroy((err) => {
    if (err) {
      res.status(500).json({ error: 'Failed to logout' });
      return;
    }
    res.json({ success: true });
  });
});

export default router;
