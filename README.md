# Smartsheet → Google Calendar Sync

A production-ready Node.js + React application for **one-way** synchronization from Smartsheet to Google Calendar.

## Architecture

```
React Dashboard (Vite + TypeScript)
        ↓
Node.js REST API (Express + TypeScript)
        ↓
Smartsheet API → Google Calendar API
        ↓
PostgreSQL (Prisma ORM)
```

## Features

- **OAuth 2.0** for Google Calendar and Smartsheet
- **One-way sync**: Smartsheet → Google Calendar only
- **Smartsheet webhooks** for real-time sync
- **Manual full sync** button
- **Configurable column mapping** (Title, Start/End Date, Description, Location, Attendees, Status)
- **Idempotent sync** — retries never create duplicates
- **AES-256-GCM encrypted** token storage
- **Rate limiting**, **security headers**, and **secret redaction** in logs
- **Retry failed records** individually or in bulk
- **Sync statistics** and error tracking dashboard

## Prerequisites

- Node.js 18+
- PostgreSQL 14+
- Google Cloud OAuth 2.0 credentials (Calendar API enabled)
- Smartsheet Developer App credentials

## Setup

### 1. Clone & Install

```bash
cd smartsheet-gcal-sync

# Backend
cd backend
npm install
cp .env ../.env  # if not already done
# Edit .env with your credentials

# Frontend
cd ../frontend
npm install
```

### 2. Configure Environment Variables

Copy `.env.example` to `backend/.env` and fill in:

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `SESSION_SECRET` | Random string (16+ chars) |
| `ENCRYPTION_KEY` | 64-char hex key for token encryption |
| `GOOGLE_CLIENT_ID` | Google OAuth 2.0 Client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth 2.0 Client Secret |
| `SMARTSHEET_CLIENT_ID` | Smartsheet App Client ID |
| `SMARTSHEET_CLIENT_SECRET` | Smartsheet App Client Secret |
| `WEBHOOK_CALLBACK_URL` | Public URL for Smartsheet webhooks (use ngrok for local dev) |

Generate an encryption key:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. Set Up Database

```bash
cd backend

# Create the database
npx prisma migrate dev --name init

# Generate Prisma client
npx prisma generate
```

### 4. Run

```bash
# Terminal 1: Backend
cd backend
npm run dev

# Terminal 2: Frontend
cd frontend
npm run dev
```

Open http://localhost:5173

### 5. Webhooks (Optional)

For real-time sync, expose your backend via ngrok:

```bash
ngrok http 3001
```

Update `WEBHOOK_CALLBACK_URL` in .env with the ngrok URL.

## API Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/auth/google` | Start Google OAuth |
| GET | `/auth/google/callback` | Google OAuth callback |
| GET | `/auth/smartsheet` | Start Smartsheet OAuth |
| GET | `/auth/smartsheet/callback` | Smartsheet OAuth callback |
| GET | `/auth/status` | Get connection status |
| GET | `/api/google/calendars` | List Google Calendars |
| GET | `/api/smartsheet/sheets` | List Smartsheet sheets |
| GET | `/api/smartsheet/sheets/:id/columns` | Get sheet columns |
| POST | `/api/sync/config` | Create sync config |
| GET | `/api/sync/config` | Get sync config |
| PUT | `/api/sync/config` | Update sync config |
| POST | `/api/sync/full` | Trigger full sync |
| POST | `/api/sync/:rowId/retry` | Retry failed row |
| GET | `/api/sync/status` | Get sync statistics |
| POST | `/webhooks/smartsheet` | Smartsheet webhook handler |

## Timezone

Default timezone is `Asia/Kolkata`. Configure via `DEFAULT_TIMEZONE` in .env.

## Security

- OAuth tokens encrypted with AES-256-GCM at rest
- Session-based auth with httpOnly cookies
- Helmet security headers
- Rate limiting on API and sync endpoints
- Secrets never logged (Winston redaction)
- CORS restricted to frontend origin
