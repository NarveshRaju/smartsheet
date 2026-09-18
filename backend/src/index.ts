import express from 'express';
import session from 'express-session';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { env } from './config/env.js';
import { securityHeaders } from './middleware/securityHeaders.js';
import { apiLimiter } from './middleware/rateLimiter.js';
import { errorHandler } from './middleware/errorHandler.js';
import { logger } from './utils/logger.js';

import authRoutes from './routes/auth.routes.js';
import googleRoutes from './routes/google.routes.js';
import smartsheetRoutes from './routes/smartsheet.routes.js';
import syncRoutes from './routes/sync.routes.js';
import webhookRoutes from './routes/webhook.routes.js';
import { startAutoSyncWorker } from './services/sync.service.js';
import { isGroqConfigured } from './services/groq.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Trust proxy for Render / Cloudflare / Heroku (enables secure cookies over HTTPS)
app.set('trust proxy', 1);

// ── Global Middleware ─────────────────────────────────────

app.use(securityHeaders);

const allowedOrigins = [
  env.FRONTEND_URL,
  'http://localhost:5173',
  'http://localhost:3001',
  env.RENDER_EXTERNAL_URL,
].filter(Boolean) as string[];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps, curl, server-to-server, or same-origin)
    if (!origin || allowedOrigins.includes(origin) || env.NODE_ENV === 'production') {
      callback(null, true);
    } else {
      callback(null, true);
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    sameSite: env.NODE_ENV === 'production' ? 'none' : 'lax',
  },
}));

// ── Routes ────────────────────────────────────────────────

// Health check endpoint for Render / monitoring
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    environment: env.NODE_ENV,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Auth routes (OAuth callbacks)
app.use('/auth', authRoutes);

// Webhook routes (called directly by Smartsheet)
app.use('/webhooks', webhookRoutes);

// API routes (rate limited + auth required)
app.use('/api/google', apiLimiter, googleRoutes);
app.use('/api/smartsheet', apiLimiter, smartsheetRoutes);
app.use('/api/sync', apiLimiter, syncRoutes);

// ── Serve React Frontend in Production ─────────────────────

const possibleFrontendDistPaths = [
  path.resolve(__dirname, '../../frontend/dist'),
  path.resolve(__dirname, '../../../frontend/dist'),
  path.resolve(process.cwd(), 'frontend/dist'),
  path.resolve(process.cwd(), '../frontend/dist'),
];

const frontendDist = possibleFrontendDistPaths.find((p) => fs.existsSync(p));

if (frontendDist) {
  logger.info(`📦 Serving static frontend from: ${frontendDist}`);
  app.use(express.static(frontendDist));

  // SPA fallback for client-side routing
  app.get('*', (req, res, next) => {
    if (
      req.path.startsWith('/api') ||
      req.path.startsWith('/auth') ||
      req.path.startsWith('/webhooks') ||
      req.path.startsWith('/health')
    ) {
      return next();
    }
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

// ── Error Handler ─────────────────────────────────────────

app.use(errorHandler);

// ── Start Server ──────────────────────────────────────────

const PORT = parseInt(env.PORT, 10);
app.listen(PORT, '0.0.0.0', () => {
  logger.info(`🚀 Server running on http://0.0.0.0:${PORT}`);
  logger.info(`📋 Environment: ${env.NODE_ENV}`);
  logger.info(`🌐 Frontend URL: ${env.FRONTEND_URL || 'Self-hosted'}`);
  logger.info(`🕐 Default timezone: ${env.DEFAULT_TIMEZONE}`);
  logger.info(`🤖 Groq AI Curation: ${isGroqConfigured() ? 'Active for complex rows' : 'Disabled (Add GROQ_API_KEY to activate)'}`);

  // Start periodic background auto-sync worker (guaranteed fallback for sheet updates)
  startAutoSyncWorker();
});

export default app;
