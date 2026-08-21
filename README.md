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
/alerts
/delete <alert_id>
/clear
```

HIP-3 perps are addressed as `dex:COIN`, for example:

```text
/price xyz:XYZ100
/alert xyz:XYZ100 > 12.5
```

## Setup

Install dependencies:

```sh
npm install
```

Create Cloudflare secrets:

```sh
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put ADMIN_SECRET
```

Deploy:

```sh
npm run deploy
```

Register the Telegram webhook after deploy. Replace the URL with your Worker URL:

```sh
curl -X POST "https://<worker-host>/admin/set-webhook" \
  -H "Authorization: Bearer <ADMIN_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://<worker-host>/webhook"}'
```

Kick the alert engine if needed:

```sh
curl -X POST "https://<worker-host>/admin/start" \
  -H "Authorization: Bearer <ADMIN_SECRET>"
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
