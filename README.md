# Zebrafish Stock Tracker

A web app for the Mongera Lab fish room: stock register, breeding log, planned crosses, regeneration and breeding alerts, QR tank labels, fish-number records and per-person views.

- **App:** https://mongeralab-fish.github.io/fish-tracker/
- **Data:** Supabase project `fish-tracker` (London region). Only invited lab members can sign in and see records. This repository holds the app's code only, never fish data.

## How it's built
| File | What it does |
|---|---|
| `index.html` | The whole app (screens, alerts, planner, labels, scanner) |
| `adapter.js` | Connects the app to Supabase: sign-in, membership, live updates, offline queue |
| `sw.js`, `manifest.json`, `icons/` | Make it installable on phones ("Add to Home Screen") and open without a connection |
| `supabase/01_setup.sql` … `06_…sql` | Database tables, access rules and later updates. New install: run 01, then 02–06 in order (each is safe to re-run) |
| `.github/workflows/backup.yml` | Encrypted database backup twice a week; also keeps the free database awake |
| `.github/workflows/weekly-summary.yml`, `scripts/weekly_summary.py` | Monday summary per person by email and phone notification |

## Roles
- **Owner**: everything, including deleting records for good.
- **Admin**: manage members and alert thresholds.
- **Member**: add and edit stocks, crosses, plans and fish numbers.
- **Viewer**: read only.

Invite people in the app: **Settings › Lab members**. They sign in with that exact email.

## Backups
The workflow needs two repository secrets (**Settings › Secrets and variables › Actions › New repository secret**):
- `SUPABASE_DB_URL`: Supabase › Connect › *Session pooler* connection string, with the database password filled in.
- `BACKUP_PASSPHRASE`: a long passphrase. Keep it somewhere safe; it is needed to open a backup.

Backups appear under **Actions › Database backup › (a run) › Artifacts** and are kept 90 days. To open one:
```
gpg --decrypt fish-tracker-YYYY-MM-DD.sql.gz.gpg | gunzip > backup.sql
```
In-app, **Settings › Download full backup** also saves a readable JSON copy at any time.

## Weekly summary
Each member chooses in **Settings › Your account**: email and/or phone notification, own lines or the whole lab. Admins can switch "Summary: everything" on for anyone in **Lab members**.
Secrets needed (besides `SUPABASE_DB_URL`): `GMAIL_USER` (lab Gmail address), `GMAIL_APP_PASSWORD` (its app password), `VAPID_PRIVATE_KEY` (phone notifications; the matching public key is in `adapter.js`).
Test: **Actions › Weekly summary › Run workflow**, tick *Preview only* or put one email in *Send only to*.
