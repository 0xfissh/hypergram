import { DurableObject } from "cloudflare:workers";

type Env = {
  ALERT_ENGINE: DurableObjectNamespace<AlertEngine>;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  ADMIN_SECRET?: string;
  CHECK_INTERVAL_SECONDS?: string;
  HYPERLIQUID_API_URL?: string;
};

type Direction = "above" | "below";

type Alert = {
  id: string;
  chatId: string;
  symbol: string;
  direction: Direction;
  threshold: number;
  createdAt: number;
  active: boolean;
  lastPrice?: number;
  triggeredAt?: number;
};

type Market = {
  symbol: string;
  dex: string;
  coin: string;
  markPx: number;
  oraclePx?: number;
  funding?: string;
  openInterest?: string;
};

type TelegramUpdate = {
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
};

type TelegramMessage = {
  message_id: number;
  chat: {
    id: number | string;
    type: string;
  };
  text?: string;
};

type HyperliquidUniverseAsset = {
  name: string;
  isDelisted?: boolean;
};

type HyperliquidAssetContext = {
  markPx?: string;
  midPx?: string;
  oraclePx?: string;
  funding?: string;
  openInterest?: string;
};

const ALERT_PREFIX = "alert:";
const MARKET_CACHE_KEY = "market-cache";
const MARKET_CACHE_MS = 30_000;
const DEFAULT_INTERVAL_SECONDS = 10;
const MIN_INTERVAL_SECONDS = 5;
const MAX_TELEGRAM_MESSAGE = 3900;
const XYZ_ASSET_ALIASES: Record<string, string> = {
  BRENT: "BRENTOIL",
  CRUDE: "CL",
  CRUDEOIL: "CL",
  USOIL: "CL",
  WTI: "CL",
  WTIOIL: "CL"
};

export { AlertEngine };

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return json({
        ok: true,
        service: "hypergram",
        commands: ["/help", "/price BTC", "/alert BTC > 100000", "/alerts"]
      });
    }

    if (url.pathname === "/webhook" && request.method === "POST") {
      if (!isTelegramWebhookAuthorized(request, env)) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }

      const body = await request.text();
      ctx.waitUntil(engineFetch(env, "/telegram", { method: "POST", body }));
      return json({ ok: true });
    }

    if (url.pathname === "/admin/set-webhook" && request.method === "POST") {
      const auth = requireAdmin(request, env);
      if (auth) return auth;

      try {
        const payload = await readJson<{ url?: string }>(request);
        const webhookUrl = payload.url ?? new URL("/webhook", request.url).href;
        const result = await telegramApi(env, "setWebhook", {
          url: webhookUrl,
          secret_token: env.TELEGRAM_WEBHOOK_SECRET,
          allowed_updates: ["message", "edited_message"]
        });

        return json({ ok: true, webhookUrl, telegram: result });
      } catch (error) {
        return json({ ok: false, error: errorMessage(error) }, 500);
      }
    }

    if (url.pathname === "/admin/start" && request.method === "POST") {
      const auth = requireAdmin(request, env);
      if (auth) return auth;

      try {
        const result = await engineFetch(env, "/start", { method: "POST" });
        return result;
      } catch (error) {
        return json({ ok: false, error: errorMessage(error) }, 500);
      }
    }

    if (url.pathname === "/admin/check" && request.method === "POST") {
      const auth = requireAdmin(request, env);
      if (auth) return auth;

      try {
        return engineFetch(env, "/check", { method: "POST" });
      } catch (error) {
        return json({ ok: false, error: errorMessage(error) }, 500);
      }
    }

    if (url.pathname === "/admin/status" && request.method === "GET") {
      const auth = requireAdmin(request, env);
      if (auth) return auth;

      return engineFetch(env, "/status");
    }

    return json({ ok: false, error: "not_found" }, 404);
  }
} satisfies ExportedHandler<Env>;

class AlertEngine extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/telegram" && request.method === "POST") {
      const update = (await request.json()) as TelegramUpdate;
      await this.handleTelegramUpdate(update);
      return json({ ok: true });
    }

    if (url.pathname === "/start" && request.method === "POST") {
      await this.ensureAlarm();
      return json({ ok: true });
    }

    if (url.pathname === "/check" && request.method === "POST") {
      await this.checkAlerts();
      await this.ensureAlarm();
      return json({ ok: true });
    }

    if (url.pathname === "/status" && request.method === "GET") {
      const alerts = await this.listAlerts();
      const active = alerts.filter((alert) => alert.active).length;
      const alarm = await this.ctx.storage.getAlarm();
      const lastError = await this.ctx.storage.get<string>("last-error");

      return json({
        ok: true,
        alerts: alerts.length,
        activeAlerts: active,
        alarm,
        intervalSeconds: intervalSeconds(this.env),
        lastError
      });
    }

    return json({ ok: false, error: "not_found" }, 404);
  }

  async alarm(): Promise<void> {
    try {
      await this.checkAlerts();
      await this.ctx.storage.delete("last-error");
    } catch (error) {
      console.error("alert check failed", error);
      await this.ctx.storage.put("last-error", errorMessage(error));
    } finally {
      await this.ensureAlarm();
    }
  }

  private async handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message ?? update.edited_message;
    if (!message?.text) return;

    const chatId = String(message.chat.id);
    const text = cleanBotCommand(message.text.trim());
    let reply: string | undefined;

    try {
      reply = await this.handleCommand(chatId, text);
      await this.ctx.storage.delete("last-error");
    } catch (error) {
      console.error("command failed", error);
      await this.ctx.storage.put("last-error", errorMessage(error));
      reply = "I hit a temporary error while handling that command. Try again in a few seconds.";
    }

    if (reply) {
      try {
        await sendTelegramMessage(this.env, chatId, reply);
      } catch (error) {
        console.error("telegram send failed", error);
        await this.ctx.storage.put("last-error", errorMessage(error));
      }
    }
  }

  private async handleCommand(chatId: string, text: string): Promise<string> {
    const [commandRaw = "", ...args] = text.split(/\s+/);
    const command = commandRaw.toLowerCase();

    if (command === "/start" || command === "/help") {
      return helpMessage();
    }

    if (command === "/alerts" || command === "/list") {
      return this.formatAlertList(chatId);
    }

    if (command === "/clear") {
      return this.clearAlerts(chatId);
    }

    if (command === "/delete" || command === "/del" || command === "/remove") {
      return this.deleteAlert(chatId, args[0]);
    }

    if (command === "/markets") {
      return this.searchMarkets(args.join(" "));
    }

    if (command === "/price") {
      return this.price(args[0]);
    }

    if (command === "/above" || command === "/below") {
      return this.createAlertFromParts(chatId, args[0], command === "/above" ? "above" : "below", args[1]);
    }

    if (command === "/xyz") {
      return this.createXyzAlertCommand(chatId, args);
    }

    if (command === "/alert") {
      return this.createAlertFromAlertCommand(chatId, args);
    }

    return "Unknown command. Send /help for examples.";
  }

  private async createAlertFromAlertCommand(chatId: string, args: string[]): Promise<string> {
    if (args.length < 3) {
      return "Use /alert BTC &gt; 100000 or /alert BTC &lt; 90000.";
    }

    const [symbol, operator, value] = args;
    const direction = parseDirection(operator);
    if (!direction) {
      return "Use &gt;, above, &lt;, or below after the symbol.";
    }

    return this.createAlertFromParts(chatId, symbol, direction, value);
  }

  private async createXyzAlertCommand(chatId: string, args: string[]): Promise<string> {
    if (args.length < 3) {
      return "Use /xyz wtioil above 90 or /xyz wtioil &gt; 90.";
    }

    const [assetInput, directionInput, thresholdInput] = args;
    const direction = parseDirection(directionInput);
    if (!direction) {
      return "Use above, below, &gt;, or &lt; after the XYZ asset.";
    }

    const threshold = parsePrice(thresholdInput);
    if (threshold == null) {
      return "That threshold is not a valid positive number.";
    }

    const marketResult = await this.resolveDexMarket("xyz", assetInput, true);
    if (!marketResult.ok) return marketResult.message;

    return this.createAlert(chatId, marketResult.market, direction, threshold);
  }

  private async createAlertFromParts(
    chatId: string,
    symbolInput: string | undefined,
    direction: Direction,
    thresholdInput: string | undefined
  ): Promise<string> {
    if (!symbolInput || !thresholdInput) {
      return "Use /above BTC 100000 or /below BTC 90000.";
    }

    const threshold = parsePrice(thresholdInput);
    if (threshold == null) {
      return "That threshold is not a valid positive number.";
    }

    const marketResult = await this.resolveMarket(symbolInput, true);
    if (!marketResult.ok) return marketResult.message;

    return this.createAlert(chatId, marketResult.market, direction, threshold);
  }

  private async createAlert(
    chatId: string,
    market: Market,
    direction: Direction,
    threshold: number
  ): Promise<string> {
    const alert: Alert = {
      id: crypto.randomUUID().slice(0, 8),
      chatId,
      symbol: market.symbol,
      direction,
      threshold,
      createdAt: Date.now(),
      active: true,
      lastPrice: market.markPx
    };

    await this.ctx.storage.put(alertKey(alert.id), alert);
    await this.ensureAlarm();

    return [
      `Alert ${escapeHtml(alert.id)} created.`,
      `${escapeHtml(alert.symbol)} ${formatDirectionOperator(direction)} ${formatPrice(threshold)}`,
      `Current mark: ${formatPrice(market.markPx)}`
    ].join("\n");
  }

  private async formatAlertList(chatId: string): Promise<string> {
    const alerts = (await this.listAlerts())
      .filter((alert) => alert.chatId === chatId && alert.active)
      .sort((a, b) => a.createdAt - b.createdAt);

    if (alerts.length === 0) {
      return "You have no active alerts.";
    }

    return trimTelegramMessage(
      alerts
        .map((alert) => {
          const op = formatDirectionOperator(alert.direction);
          const last = alert.lastPrice == null ? "" : `, last ${formatPrice(alert.lastPrice)}`;
          return `${escapeHtml(alert.id)}: ${escapeHtml(alert.symbol)} ${op} ${formatPrice(alert.threshold)}${last}`;
        })
        .join("\n")
    );
  }

  private async deleteAlert(chatId: string, id: string | undefined): Promise<string> {
    if (!id) {
      return "Use /delete &lt;alert_id&gt;.";
    }

    const key = alertKey(id);
    const alert = await this.ctx.storage.get<Alert>(key);
    if (!alert || alert.chatId !== chatId || !alert.active) {
      return "I could not find an active alert with that id.";
    }

    alert.active = false;
    await this.ctx.storage.put(key, alert);
    await this.ensureAlarm();

    return `Deleted alert ${escapeHtml(id)}.`;
  }

  private async clearAlerts(chatId: string): Promise<string> {
    const alerts = await this.listAlerts();
    let cleared = 0;

    for (const alert of alerts) {
      if (alert.chatId === chatId && alert.active) {
        alert.active = false;
        await this.ctx.storage.put(alertKey(alert.id), alert);
        cleared += 1;
      }
    }

    await this.ensureAlarm();
    return cleared === 1 ? "Cleared 1 alert." : `Cleared ${cleared} alerts.`;
  }

  private async searchMarkets(query: string): Promise<string> {
    const markets = await this.fetchMarkets(false);
    const normalized = query.trim().toUpperCase();
    const matches = markets
      .filter((market) => {
        if (!normalized) return true;
        return market.symbol.toUpperCase().includes(normalized) || market.coin.toUpperCase().includes(normalized);
      })
      .sort((a, b) => a.symbol.localeCompare(b.symbol))
      .slice(0, 50);

    if (matches.length === 0) {
      return "No markets matched. Try /markets BTC or use the HIP-3 form dex:COIN.";
    }

    const header = normalized ? `Markets matching ${escapeHtml(query)}:` : "First 50 markets:";
    return trimTelegramMessage(`${header}\n${matches.map((market) => escapeHtml(market.symbol)).join("\n")}`);
  }

  private async price(symbol: string | undefined): Promise<string> {
    if (!symbol) {
      return "Use /price BTC or /price dex:COIN.";
    }

    const marketResult = await this.resolveMarket(symbol, true);
    if (!marketResult.ok) return marketResult.message;

    const market = marketResult.market;
    const lines = [
      `${escapeHtml(market.symbol)} mark: ${formatPrice(market.markPx)}`,
      market.oraclePx == null ? undefined : `Oracle: ${formatPrice(market.oraclePx)}`,
      market.funding == null ? undefined : `Funding: ${escapeHtml(market.funding)}`,
      market.openInterest == null ? undefined : `Open interest: ${escapeHtml(market.openInterest)}`
    ].filter(Boolean);

    return lines.join("\n");
  }

  private async checkAlerts(): Promise<void> {
    const alerts = (await this.listAlerts()).filter((alert) => alert.active);
    if (alerts.length === 0) return;

    const markets = await this.fetchMarkets(true);
    const marketsBySymbol = new Map(markets.map((market) => [market.symbol.toUpperCase(), market]));

    for (const alert of alerts) {
      const market = marketsBySymbol.get(alert.symbol.toUpperCase());
      if (!market) continue;

      const crossed =
        alert.direction === "above"
          ? market.markPx >= alert.threshold && (alert.lastPrice == null || alert.lastPrice < alert.threshold)
          : market.markPx <= alert.threshold && (alert.lastPrice == null || alert.lastPrice > alert.threshold);

      alert.lastPrice = market.markPx;

      if (crossed) {
        alert.active = false;
        alert.triggeredAt = Date.now();
        await sendTelegramMessage(
          this.env,
          alert.chatId,
          [
            `Price alert hit: ${escapeHtml(alert.symbol)}`,
            `${formatDirectionOperator(alert.direction)} ${formatPrice(alert.threshold)}`,
            `Current mark: ${formatPrice(market.markPx)}`
          ].join("\n")
        );
      }

      await this.ctx.storage.put(alertKey(alert.id), alert);
    }
  }

  private async resolveMarket(
    input: string,
    forceFresh: boolean
  ): Promise<{ ok: true; market: Market } | { ok: false; message: string }> {
    const markets = await this.fetchMarkets(forceFresh);
    const normalized = input.trim().toUpperCase();
    const exact = markets.find((market) => market.symbol.toUpperCase() === normalized);

    if (exact) {
      return { ok: true, market: exact };
    }

    if (!normalized.includes(":")) {
      const coinMatches = markets.filter((market) => market.coin.toUpperCase() === normalized);
      if (coinMatches.length === 1) {
        return { ok: true, market: coinMatches[0] };
      }

      if (coinMatches.length > 1) {
        return {
          ok: false,
          message: `That coin exists on multiple dexes. Use one of:\n${coinMatches
            .slice(0, 20)
            .map((market) => escapeHtml(market.symbol))
            .join("\n")}`
        };
      }
    }

    return { ok: false, message: `I could not find ${escapeHtml(input)}. Try /markets ${escapeHtml(input)}.` };
  }

  private async resolveDexMarket(
    dex: string,
    input: string,
    forceFresh: boolean
  ): Promise<{ ok: true; market: Market } | { ok: false; message: string }> {
    const markets = await this.fetchDexMarkets(dex, forceFresh);
    const normalizedInput = normalizeDexAssetInput(dex, input);
    const normalizedSymbol = normalizedInput.includes(":") ? normalizedInput : `${dex.toUpperCase()}:${normalizedInput}`;
    const exact = markets.find((market) => market.symbol.toUpperCase() === normalizedSymbol);

    if (exact) {
      return { ok: true, market: exact };
    }

    const coin = normalizedSymbol.split(":").at(-1) ?? normalizedSymbol;
    const coinMatch = markets.find((market) => market.coin.toUpperCase() === coin);
    if (coinMatch) {
      return { ok: true, market: coinMatch };
    }

    const matches = markets
      .filter((market) => market.symbol.toUpperCase().includes(coin) || market.coin.toUpperCase().includes(coin))
      .slice(0, 10);
    const suggestion = matches.length > 0 ? `\nClosest XYZ matches:\n${matches.map((market) => escapeHtml(market.symbol)).join("\n")}` : "";

    return {
      ok: false,
      message: `I could not find xyz:${escapeHtml(coin)}.${suggestion}`
    };
  }

  private async fetchMarkets(forceFresh: boolean): Promise<Market[]> {
    if (!forceFresh) {
      const cached = await this.ctx.storage.get<{ fetchedAt: number; markets: Market[] }>(MARKET_CACHE_KEY);
      if (cached && Date.now() - cached.fetchedAt < MARKET_CACHE_MS) {
        return cached.markets;
      }
    }

    const markets = await fetchHyperliquidMarkets(this.env);
    await this.ctx.storage.put(MARKET_CACHE_KEY, { fetchedAt: Date.now(), markets });
    return markets;
  }

  private async fetchDexMarkets(dex: string, forceFresh: boolean): Promise<Market[]> {
    const cacheKey = `market-cache:${dex}`;

    if (!forceFresh) {
      const cached = await this.ctx.storage.get<{ fetchedAt: number; markets: Market[] }>(cacheKey);
      if (cached && Date.now() - cached.fetchedAt < MARKET_CACHE_MS) {
        return cached.markets;
      }
    }

    const markets = await fetchHyperliquidDexMarkets(this.env, dex);
    await this.ctx.storage.put(cacheKey, { fetchedAt: Date.now(), markets });
    return markets;
  }

  private async listAlerts(): Promise<Alert[]> {
    const entries = await this.ctx.storage.list<Alert>({ prefix: ALERT_PREFIX });
    return [...entries.values()];
  }

  private async ensureAlarm(): Promise<void> {
    const activeAlerts = (await this.listAlerts()).some((alert) => alert.active);
    if (!activeAlerts) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    const nextAlarm = Date.now() + intervalSeconds(this.env) * 1000;
    await this.ctx.storage.setAlarm(nextAlarm);
  }
}

async function fetchHyperliquidMarkets(env: Env): Promise<Market[]> {
  const dexes = await fetchPerpDexes(env);
  const responses = await Promise.allSettled(
    dexes.map(async (dex) => {
      return fetchHyperliquidDexMarkets(env, dex);
    })
  );

  const markets = responses.flatMap((response, index) => {
    if (response.status === "fulfilled") {
      return response.value;
    }

    console.error(`failed to load markets for dex ${dexes[index] || "primary"}`, response.reason);
    return [];
  });

  if (markets.length === 0) {
    throw new Error("No Hyperliquid markets were loaded");
  }

  return markets;
}

async function fetchHyperliquidDexMarkets(env: Env, dex: string): Promise<Market[]> {
  const payload = dex ? { type: "metaAndAssetCtxs", dex } : { type: "metaAndAssetCtxs" };
  const result = await hyperliquidInfo(env, payload);
  return parseMetaAndAssetContexts(dex, result);
}

async function fetchPerpDexes(env: Env): Promise<string[]> {
  try {
    const result = await hyperliquidInfo(env, { type: "perpDexs" });
    if (!Array.isArray(result)) return [""];

    const hip3Dexes = result
      .filter((entry): entry is { name: string } => entry != null && typeof entry.name === "string")
      .map((entry) => entry.name);

    return ["", ...new Set(hip3Dexes)];
  } catch (error) {
    console.error("failed to load perp dexes", error);
    return [""];
  }
}

async function hyperliquidInfo(env: Env, payload: unknown): Promise<unknown> {
  const response = await fetch(env.HYPERLIQUID_API_URL ?? "https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8_000)
  });

  if (!response.ok) {
    throw new Error(`Hyperliquid API returned ${response.status}`);
  }

  return response.json();
}

function parseMetaAndAssetContexts(dex: string, result: unknown): Market[] {
  if (!Array.isArray(result) || result.length < 2) return [];

  const [meta, contexts] = result as [
    { universe?: HyperliquidUniverseAsset[] },
    HyperliquidAssetContext[]
  ];

  if (!Array.isArray(meta.universe) || !Array.isArray(contexts)) return [];

  return meta.universe.flatMap((asset, index) => {
    if (!asset?.name || asset.isDelisted) return [];

    const context = contexts[index] ?? {};
    const markPx = parseNumber(context.markPx ?? context.midPx ?? context.oraclePx);
    if (markPx == null) return [];

    const symbol = dex && !asset.name.includes(":") ? `${dex}:${asset.name}` : asset.name;
    const coin = symbol.includes(":") ? symbol.split(":").at(-1) ?? symbol : symbol;

    return [
      {
        symbol,
        dex,
        coin,
        markPx,
        oraclePx: parseNumber(context.oraclePx),
        funding: context.funding,
        openInterest: context.openInterest
      }
    ];
  });
}

async function engineFetch(env: Env, path: string, init?: RequestInit): Promise<Response> {
  const id = env.ALERT_ENGINE.idFromName("global");
  const stub = env.ALERT_ENGINE.get(id);
  return stub.fetch(`https://alert-engine.local${path}`, init);
}

function isTelegramWebhookAuthorized(request: Request, env: Env): boolean {
  if (!env.TELEGRAM_WEBHOOK_SECRET) return true;
  return request.headers.get("X-Telegram-Bot-Api-Secret-Token") === env.TELEGRAM_WEBHOOK_SECRET;
}

function requireAdmin(request: Request, env: Env): Response | undefined {
  if (!env.ADMIN_SECRET) {
    return json({ ok: false, error: "ADMIN_SECRET is not configured" }, 500);
  }

  if (request.headers.get("authorization") !== `Bearer ${env.ADMIN_SECRET}`) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  return undefined;
}

async function readJson<T>(request: Request): Promise<T> {
  if (!request.body) return {} as T;
  return request.json<T>().catch(() => ({} as T));
}

async function telegramApi(env: Env, method: string, payload: unknown): Promise<unknown> {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  }

  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

  const result = await response.json();
  if (!response.ok) {
    throw new Error(`Telegram API returned ${response.status}: ${JSON.stringify(result)}`);
  }

  return result;
}

async function sendTelegramMessage(env: Env, chatId: string, text: string): Promise<void> {
  await telegramApi(env, "sendMessage", {
    chat_id: chatId,
    text: trimTelegramMessage(text),
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
}

function cleanBotCommand(text: string): string {
  return text.replace(/^\/([a-z]+)@[A-Za-z0-9_]+/i, "/$1");
}

function normalizeDexAssetInput(dex: string, input: string): string {
  const normalized = input.trim().toUpperCase();

  if (dex.toLowerCase() !== "xyz") {
    return normalized;
  }

  const asset = normalized.includes(":") ? normalized.split(":").at(-1) ?? normalized : normalized;
  return XYZ_ASSET_ALIASES[asset] ?? normalized;
}

function parseDirection(operator: string): Direction | undefined {
  const normalized = operator.toLowerCase();
  if (normalized === ">" || normalized === ">=" || normalized === "above") return "above";
  if (normalized === "<" || normalized === "<=" || normalized === "below") return "below";
  return undefined;
}

function parsePrice(input: string): number | undefined {
  const value = parseNumber(input.replace(/[$,]/g, ""));
  return value != null && value > 0 ? value : undefined;
}

function parseNumber(input: string | number | undefined): number | undefined {
  if (input == null) return undefined;
  const value = typeof input === "number" ? input : Number(input);
  return Number.isFinite(value) ? value : undefined;
}

function formatPrice(value: number): string {
  if (value >= 1000) return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (value >= 1) return value.toLocaleString("en-US", { maximumFractionDigits: 6 });
  return value.toLocaleString("en-US", { maximumSignificantDigits: 6 });
}

function formatDirectionOperator(direction: Direction): string {
  return direction === "above" ? "&gt;=" : "&lt;=";
}

function intervalSeconds(env: Env): number {
  const parsed = Number(env.CHECK_INTERVAL_SECONDS ?? DEFAULT_INTERVAL_SECONDS);
  if (!Number.isFinite(parsed)) return DEFAULT_INTERVAL_SECONDS;
  return Math.max(MIN_INTERVAL_SECONDS, Math.floor(parsed));
}

function alertKey(id: string): string {
  return `${ALERT_PREFIX}${id}`;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function trimTelegramMessage(text: string): string {
  if (text.length <= MAX_TELEGRAM_MESSAGE) return text;
  return `${text.slice(0, MAX_TELEGRAM_MESSAGE - 20)}\n...truncated`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function helpMessage(): string {
  return [
    "Hyperliquid price alerts",
    "",
    "Create alerts:",
    "/alert BTC &gt; 100000",
    "/alert BTC &lt; 90000",
    "/above BTC 100000",
    "/below BTC 90000",
    "/xyz wtioil above 90",
    "/xyz wtioil &gt; 90",
    "",
    "XYZ aliases: wtioil, wti, and usoil resolve to xyz:CL.",
    "",
    "HIP-3 symbols use dex:COIN, for example /price xyz:XYZ100.",
    "",
    "Other commands:",
    "/price BTC",
    "/markets BTC",
    "/alerts",
    "/delete &lt;alert_id&gt;",
    "/clear"
  ].join("\n");
}
