# Brownstone Cleaning Tool

Internal web app for the Brownstone Vacations cleaning team. Cleaners use it in the field to submit post-clean photos and inventory requests. Data stores in Google Workspace (Drive + Sheets).

## Local Development

```bash
git clone https://github.com/relaxedstays621/brownstone-cleaning-app.git
cd brownstone-cleaning-app
npm install
cp .env.local.example .env.local  # fill in values (see below)
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Google Workspace Setup

### 1. Create a Service Account

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project (or use an existing one)
3. Enable **Google Drive API** and **Google Sheets API**
4. Go to **IAM & Admin > Service Accounts**
5. Create a service account, download the JSON key
6. Copy the entire JSON contents into the `GOOGLE_SERVICE_ACCOUNT_JSON` env var (as a single line)

### 2. Set Up Google Sheets

1. Create a new Google Sheet named **"Brownstone Cleaning Log"**
2. Create two tabs:
   - **Clean Log** — with headers: `Date | Property | Start Time | Submit Time | # Photos`
   - **Inventory Requests** — with headers: `Date | Property | Item | Quantity | Notes | Status`
3. Share the sheet with the service account email (found in the JSON key, `client_email` field) — give **Editor** access
4. Copy the Sheet ID from the URL: `https://docs.google.com/spreadsheets/d/SHEET_ID_HERE/edit`

### 3. Set Up Google Drive

1. Create a folder named **"Brownstone Cleanings"** in Google Drive
2. Share this folder with the service account email — give **Editor** access
3. Right-click the folder > **Get link** > copy the folder ID from the URL

## Environment Variables

Create `.env.local` (local dev) or `.env` (Docker deployment):

| Variable | Description |
|---|---|
| `CLEANING_APP_PASSWORD` | Shared password for the cleaning team |
| `SESSION_SECRET` | Random secret string for session cookies (e.g. `openssl rand -hex 32`) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Full JSON content of the service account key (single line) |
| `GOOGLE_SHEET_ID` | ID of the Google Sheet |
| `GOOGLE_DRIVE_ROOT_FOLDER_ID` | ID of the "Brownstone Cleanings" Drive folder |
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude (inventory parsing) |

## Deploy with Docker Compose on Hetzner

### 1. Server Setup

```bash
ssh root@your-server-ip
apt update && apt install -y docker.io docker-compose-plugin caddy
```

### 2. Clone and Configure

```bash
git clone https://github.com/relaxedstays621/brownstone-cleaning-app.git
cd brownstone-cleaning-app
nano .env  # add all env vars
```

### 3. Build and Run

```bash
docker compose up -d --build
```

### 4. Caddy Reverse Proxy

Add to `/etc/caddy/Caddyfile`:

```
clean.brownstonevacations.com {
    reverse_proxy localhost:3000
}
```

Then reload Caddy:

```bash
systemctl reload caddy
```

Caddy automatically provisions HTTPS via Let's Encrypt.

### 5. Photo Cleanup Cron

Set up a nightly cron to delete photos older than 45 days:

```bash
crontab -e
```

Add:

```
0 3 * * * curl -s http://localhost:3000/api/cleanup > /dev/null 2>&1
```

## Tech Stack

- Next.js 14 (App Router)
- TypeScript
- Tailwind CSS
- Google Drive API v3 / Sheets API v4
- Anthropic Claude API
- Docker
