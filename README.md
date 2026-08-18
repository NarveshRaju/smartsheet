# Smartsheet → Google Calendar Sync

A production-ready Node.js + React application for **one-way** synchronization from Smartsheet to Google Calendar with real-time webhooks, PostgreSQL persistence, and a dark glassmorphism dashboard.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

---

## 🏗 Architecture

```text
React Dashboard (Vite + TypeScript + SPA)
        ↓ (proxied in dev / static SPA in prod)
Node.js REST API (Express + TypeScript + ESM)
        ↓
Smartsheet API ──→ Google Calendar API
        ↓
PostgreSQL Database (Prisma ORM)
```

---

## ✨ Features

- **OAuth 2.0 Integration**: Seamless connect for Google Calendar and Smartsheet.
- **One-Way Sync**: Smartsheet → Google Calendar only (Google Calendar never modifies Smartsheet).
- **Real-Time Webhooks**: Automatic synchronization when rows are added, modified, or deleted in Smartsheet.
- **Manual Full Sync**: On-demand synchronization button with live progress tracking.
- **Flexible Column Mapping**: Configurable mapping for:
  - Title / Summary
  - Start Date & Time
  - End Date & Time
  - Description
  - Location
  - Attendees
  - Status (Cancelled, Tentative, Confirmed)
- **Idempotency Guarantees**: `@@unique([syncConfigId, smartsheetRowId])` constraint prevents duplicate Google Calendar events even during network retries.
- **Security & Encryption**: OAuth refresh tokens encrypted at rest using **AES-256-GCM**.
- **Rate Limiting & Protection**: Helmet security headers, rate limiting, and Winston logging with automated secret redaction.
- **Retry & Recovery Engine**: View failed records, inspect errors, and retry individual rows or all failed items in batch.
- **Timezone Support**: Defaults to `Asia/Kolkata` (configurable via environment variables).

---

## 🚀 Deploying to Render

This repository is pre-configured with a **Render Blueprint** (`render.yaml`) for automated deployment of both the Fullstack Web Service and PostgreSQL database.

### Method 1: Using the Render Blueprint (Recommended)
1. Push this repository to your GitHub: `https://github.com/NarveshRaju/smartsheet.git`
2. Log in to [Render Dashboard](https://dashboard.render.com/).
3. Click **New +** → **Blueprint**.
4. Connect your `NarveshRaju/smartsheet` GitHub repository.
5. Render will automatically detect `render.yaml` and create:
   - **smartsheet-gcal-db**: Free PostgreSQL Database
   - **smartsheet-gcal-sync**: Node.js Web Service (running both API and frontend SPA)
6. In the Render Environment Variables tab for the web service, supply your OAuth keys:
   - `GOOGLE_CLIENT_ID` & `GOOGLE_CLIENT_SECRET`
   - `GOOGLE_REDIRECT_URI`: `https://<your-render-app>.onrender.com/auth/google/callback`
   - `SMARTSHEET_CLIENT_ID` & `SMARTSHEET_CLIENT_SECRET`
   - `SMARTSHEET_REDIRECT_URI`: `https://<your-render-app>.onrender.com/auth/smartsheet/callback`
   - `WEBHOOK_CALLBACK_URL`: `https://<your-render-app>.onrender.com/webhooks/smartsheet`

---

## 💻 Local Development Setup

### 1. Prerequisites
- Node.js 18+
- PostgreSQL database running locally

### 2. Install Dependencies
```bash
npm run install:all
```

### 3. Configure Environment Variables
Copy `.env.example` to `.env` (or `backend/.env`):
```bash
cp .env.example .env
```

Fill in your database URL and OAuth credentials.

### 4. Initialize Database
```bash
npm run db:push
```

### 5. Run Locally
```bash
# Run backend (port 3001)
npm run dev:backend

# In a separate terminal, run frontend (port 5173)
npm run dev:frontend
```

Open `http://localhost:5173` in your browser.

---

## 📡 API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Health check and uptime status |
| `GET` | `/auth/google` | Initiate Google OAuth 2.0 flow |
| `GET` | `/auth/google/callback` | Handle Google OAuth redirect |
| `GET` | `/auth/smartsheet` | Initiate Smartsheet OAuth 2.0 flow |
| `GET` | `/auth/smartsheet/callback` | Handle Smartsheet OAuth redirect |
| `GET` | `/auth/status` | Check active connection status |
| `GET` | `/api/google/calendars` | Fetch available Google Calendars |
| `GET` | `/api/smartsheet/sheets` | Fetch available Smartsheet sheets |
| `GET` | `/api/smartsheet/sheets/:id/columns` | Fetch sheet column definitions |
| `POST` | `/api/sync/config` | Save synchronization settings & column mapping |
| `GET` | `/api/sync/config` | Retrieve current synchronization configuration |
| `PUT` | `/api/sync/config` | Update synchronization configuration |
| `POST` | `/api/sync/full` | Trigger manual full synchronization |
| `POST` | `/api/sync/:rowId` | Sync a single Smartsheet row |
| `POST` | `/api/sync/:rowId/retry` | Retry failed sync for a specific row |
| `GET` | `/api/sync/status` | Get real-time stats and failure logs |
| `POST` | `/webhooks/smartsheet` | Smartsheet webhook receiver |

---

## 🔐 Security Details

1. **Token Encryption**: Refresh tokens are encrypted with **AES-256-GCM** before database storage.
2. **Credential Isolation**: Client secrets and access tokens stay strictly on the Node.js backend and are never sent to the browser.
3. **Log Sanitization**: Winston logger automatically redacts sensitive keywords (tokens, passwords, authorization headers).
4. **Session Protection**: HTTP-only, secure, same-site session cookies with reverse-proxy trust for Render.
