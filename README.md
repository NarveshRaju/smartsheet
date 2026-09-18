# Smartsheet → Google Calendar sync

One-way sync with a React dashboard, Express API, MongoDB Atlas persistence, Smartsheet webhooks, and an independent scheduled worker.

## What syncing does

- Saving a new configuration enables automatic sync and starts the first run. You can pause it with the dashboard toggle.
- Matches by sheet + row metadata first. Existing untagged, non-recurring events are adopted only when title, full start time, and end time match. Same name at different times stays separate. A match is linked to its row, and its mapped fields are updated when necessary.
- Each source row owns its own event; different rows with identical data are treated as separate source records. After each row is reconciled successfully, extra non-recurring entries tagged with that same sheet and row are removed. Once every row succeeds, surplus untagged entries with identical title, start/end, description, location, attendees and status are also removed. Multiple identical source rows retain one entry each. Different-time or otherwise ambiguous untagged entries are retained, as are other sheets and recurring events. Failed rows keep their entries. Cleanup uses Google ETags to avoid deleting entries edited during the sync.
- Unchanged rows skip AI and Calendar writes. Changed mappings and calendar timezones invalidate the parser cache.
- Shared database leases coordinate webhooks, manual sync, and scheduled workers. Deterministic Google event IDs recover inserts after a lost response or a failed database write.
- Missing required date/time fields or cancelled rows remove their linked events. Invalid/ambiguous extraction is recorded for retry and preserves existing events. Deleted rows remove only their owned events.
- Source calendar IDs are used exactly; a missing calendar never silently falls back to your primary calendar.

## Setup with MongoDB Atlas

1. Create an Atlas **Free** cluster and a database user with read/write access to `smartsheet_gcal_sync`.
2. Configure Atlas network access for the machines running the app and scheduled worker. GitHub-hosted runner addresses change; use a runner with fixed egress if you need an IP allowlist. Do not make the database publicly reachable as a shortcut.
3. Copy `.env.example` to `backend/.env`. Put the Atlas driver connection string in `DATABASE_URL`, including the database name. URL-encode special characters in its username/password.
4. Keep existing `ENCRYPTION_KEY`, Google/Smartsheet OAuth credentials, and callback URLs when migrating. The encryption key is required to read existing tokens.
5. Run:

```sh
npm run install:all
npm run db:push
npm run build
npm start
```

Prisma stays on version 6; the MongoDB schema uses UUID strings mapped to `_id` so old record IDs can be retained. Use `db:push`, not relational migrations. Atlas supplies the replica set Prisma needs. A local standalone MongoDB without a replica set is insufficient.

The Render blueprint now creates only the web service. Set `DATABASE_URL` manually to Atlas; it no longer provisions an expiring Render Postgres database. Applying a schema does **not** transfer existing data.

### Preserve the old Postgres data

If Postgres is still readable:

1. Stop all sync workers and pause the old deployment during migration. Keep a backup; do not delete the old database.
2. Set `POSTGRES_SOURCE_URL` to the old Postgres URL and `DATABASE_URL` to a new, empty Atlas database, using environment secrets.
3. Generate clients and preview counts:

```sh
npm run db:legacy-client --prefix backend
npm run db:generate
npm run db:push
npm run db:import-postgres --prefix backend
```

4. Import and verify counts:

```sh
npm run db:import-postgres --prefix backend -- --apply
```

The importer reads Postgres without writing to it, preserves IDs/token ciphertext, refuses a nonempty target, and verifies each collection count. If interrupted, use a fresh empty target and rerun; it does not overwrite a partly imported database. It has not been verified against your live databases.

5. Point Render and the scheduled worker at Atlas with the **same original encryption key**, deploy, then resume syncing.

If Postgres has expired and cannot be recovered, use a fresh Atlas database, reconnect both accounts and recreate the mapping. Existing calendar metadata and exact event matching can recover links; this cannot restore expired database contents.

## Automatic sync without visiting the website

The web server polls enabled configurations every 60 seconds while it is running, and webhooks trigger an earlier reconciliation. Render Free sleeps after 15 minutes without inbound traffic, so its timer alone cannot provide unattended sync.

`.github/workflows/auto-sync.yml` runs the worker directly every 10 minutes, independently of Render. To enable it:

1. Commit/push the workflow to the repository's default branch.
2. Add repository Actions secrets: `DATABASE_URL`, `ENCRYPTION_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SMARTSHEET_CLIENT_ID`, `SMARTSHEET_CLIENT_SECRET`, and optionally `GROQ_API_KEY`. Use the same values as the web service.
3. Ensure the runner can reach Atlas. If using fixed-egress self-hosted runners, change `runs-on` accordingly.
4. Set repository Actions variable `AUTO_SYNC_ENABLED` to `true` after migration. Enable automatic sync in any previously saved configurations; newly created ones default to enabled.
5. Run **Automatic calendar sync → Run workflow** once and check its result and the dashboard's last sync timestamp.

The workflow remains disabled until that variable is set. GitHub schedules can be delayed and public-repository schedules stop after 60 days without repository activity. Public standard hosted runners are generally free; private repositories have included-minute limits. This is best-effort scheduled sync, not a guaranteed realtime service. For consistent low latency, run the server/worker on an always-on machine you already own or an always-on hosting plan. The worker can also be run from a local scheduler with `npm run sync:once --prefix backend` after building.

Google/Smartsheet refresh tokens are read from Atlas, so no browser login session is needed by the worker. Expired/revoked OAuth consent still requires reconnecting the account.

## AI accuracy and free usage

Unambiguous ISO dates and ordinary times are parsed locally. Complex mapped date/time inputs use AI with strict output validation. Successful parsed events are cached by row content, mapping and timezone; unchanged rows do not repeatedly spend tokens.

- Default: `AI_PROVIDER=groq`, `GROQ_MODEL=llama-3.3-70b-versatile`, `GROQ_API_KEY=...`.
- Requests share a database-backed quota gate (`AI_MIN_INTERVAL_MS=10000`). HTTP 429 respects `Retry-After` and defers the row. It does not rotate accounts/models to evade quotas. Other invalid extraction failures back off longer so one bad row does not monopolize requests.
- There is no unlimited free hosted LLM guarantee. The provider's account limits still apply. Ambiguous numeric dates should be corrected to ISO dates; AI is instructed not to guess.
- Optional local inference: install Ollama on an always-on machine, pull a model supported by your hardware (default `qwen3:8b`), set `AI_PROVIDER=ollama`, `OLLAMA_BASE_URL=http://localhost:11434`, and `OLLAMA_MODEL=qwen3:8b`. Run the worker on that machine. No hosted API quota or per-request bill; hardware, electricity, model quality and latency are your constraints. A hosted GitHub runner cannot reach your PC's localhost.
- Set `AI_PROVIDER=none` for structured-only parsing. Complex rows then show actionable errors instead of guessed events.

## Verification

```sh
npm run build
npm test --prefix backend
```

Regression tests cover same-title/different-time rows, exact adoption, source ownership, timezone normalization, repeat-run no-ops, lock contention, incomplete Calendar reads, parser validation and preserving events during AI failure. Database/Calendar integration is mocked; a live end-to-end migration and sync still need deployment credentials.

## References

- [Atlas free cluster limits](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/) — 0.5 GB storage, including indexes; not unlimited.
- [Render free services](https://render.com/docs/free) — web-service sleep and Postgres expiration.
- [Groq rate limits](https://console.groq.com/docs/rate-limits).
- [GitHub scheduled workflow limitations](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

- [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

If Actions fails with empty DATABASE_URL or ENCRYPTION_KEY, add the repository **Secrets**; AUTO_SYNC_ENABLED is a **Variable**, and setting it does not copy credentials from Render. The workflow validates missing settings before installing dependencies, without printing their values.
