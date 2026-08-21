# Hypergram

A Cloudflare Workers Telegram bot for Hyperliquid perp price alerts. It polls the primary Hyperliquid perp dex plus HIP-3 builder-deployed perp dexes through the Hyperliquid info API and sends Telegram alerts when a mark price crosses a threshold.

## Commands

```text
/start
/help
/price BTC
/markets BTC
/alert BTC > 100000
/alert BTC < 90000
/above BTC 100000
/below BTC 90000
/xyz wtioil above 90
/xyz wtioil > 90
/alerts
/delete <alert_id>
/clear
```

HIP-3 perps are addressed as `dex:COIN`, for example:

```text
/price xyz:XYZ100
/alert xyz:XYZ100 > 12.5
```

For XYZ HIP-3 markets, you can use the shorter `/xyz` alert command:

```text
/xyz wtioil above 90
/xyz wtioil > 90
/xyz wtioil below 70
/xyz wtioil < 70
```

## Setup

Follow these steps to run your own Hypergram bot.

### 1. Create a Telegram bot

1. Open Telegram and message `@BotFather`.
2. Send `/newbot`.
3. Pick a bot name and username.
4. Copy the token BotFather gives you. This is your `TELEGRAM_BOT_TOKEN`.

### 2. Install dependencies

Run this inside the project folder:

```sh
npm install
```

### 3. Log in to Cloudflare

```sh
npx wrangler login
```

If this is your first Worker, open Cloudflare Dashboard > Workers & Pages once to create your `workers.dev` subdomain.

### 4. Set Worker secrets

Set the Telegram bot token:

```sh
npx wrangler secret put TELEGRAM_BOT_TOKEN
```

Generate a random webhook secret:

```sh
openssl rand -hex 32
```

Set it:

```sh
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

Generate a random admin secret:

```sh
openssl rand -hex 32
```

Set it and save the value locally:

```sh
npx wrangler secret put ADMIN_SECRET
```

### 5. Deploy the Worker

```sh
npm run deploy
```

Copy the Worker URL from the deploy output. It will look like:

```text
https://hypergram.<your-subdomain>.workers.dev
```

### 6. Register the Telegram webhook

Replace `<worker-url>` with your Worker URL and `<admin-secret>` with your `ADMIN_SECRET`.

```sh
curl -X POST "<worker-url>/admin/set-webhook" \
  -H "Authorization: Bearer <admin-secret>" \
  -H "Content-Type: application/json" \
  -d '{"url":"<worker-url>/webhook"}'
```

You should see `"ok": true`.

### 7. Start the alert engine

```sh
curl -X POST "<worker-url>/admin/start" \
  -H "Authorization: Bearer <admin-secret>"
```

### 8. Test the bot

Open your bot in Telegram and send:

```text
/start
/price BTC
/alert BTC > 100000
/alerts
```

For XYZ HIP-3 assets:

```text
/xyz wtioil > 90
```

## Configuration

Wrangler variables:

- `CHECK_INTERVAL_SECONDS`: Poll interval. Defaults to `10`; values below `5` are clamped to `5`.
- `HYPERLIQUID_API_URL`: Defaults to `https://api.hyperliquid.xyz/info`.

Secrets:

- `TELEGRAM_BOT_TOKEN`: Telegram bot token from BotFather.
- `TELEGRAM_WEBHOOK_SECRET`: Secret token checked against Telegram's `X-Telegram-Bot-Api-Secret-Token` header.
- `ADMIN_SECRET`: Bearer token for `/admin/*` endpoints.

## Notes

Cloudflare Cron Triggers run on minute-level schedules, so this bot uses Durable Object alarms for the 5-10 second polling loop. Alerts are one-shot by default: when a threshold is hit, the bot sends the notification and marks that alert inactive.
