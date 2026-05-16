import { TtlCache } from "./cache.js";
import type { AgentSession } from "./sessionStore.js";
import type { GameSnapshot, RateLimitInfo, RefreshOptions } from "../shared/schemas.js";

const GT_BASE_URL = "https://api.g2.galactictycoons.com";
const GAME_DATA_TTL_MS = 24 * 60 * 60 * 1000;
const MARKET_DETAILS_TTL_MS = 5 * 60 * 1000;
const MARKET_PRICES_TTL_MS = 60 * 1000;
const COMPANY_TTL_MS = 30 * 1000;
const DEFAULT_GT_FETCH_TIMEOUT_MS = 20_000;

export class RateLimitError extends Error {
  constructor(
    message: string,
    readonly endpoint: string,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

export class GtApiError extends Error {
  constructor(
    message: string,
    readonly endpoint: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "GtApiError";
  }
}

export type FetchLike = typeof fetch;

export type GtClientOptions = {
  baseUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
};

type SnapshotCacheValue = Omit<GameSnapshot, "fetchedAt">;

export class GalacticTycoonsClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly gameDataCache = new TtlCache<Record<string, unknown>>();
  private readonly marketPricesCache = new TtlCache<Record<string, unknown>[]>();
  private readonly marketDetailsCache = new TtlCache<Record<string, unknown>[]>();
  private readonly companyCache = new TtlCache<SnapshotCacheValue>();

  constructor(options: GtClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? GT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.GT_FETCH_TIMEOUT_MS ?? DEFAULT_GT_FETCH_TIMEOUT_MS);
  }

  async getSnapshot(session: AgentSession, refresh?: RefreshOptions): Promise<GameSnapshot> {
    const companyCacheKey = `company:${session.id}`;
    const cachedCompany = refresh?.forceCompany ? undefined : this.companyCache.get(companyCacheKey);

    const warnings: string[] = [];
    const rateLimits: RateLimitInfo[] = [];

    const [gameData, prices, details, companyParts] = await Promise.all([
      this.getGameData(Boolean(refresh?.forceGameData)).catch((error) => {
        warnings.push(`Could not load game data: ${describeGtError(error)}.`);
        return {};
      }),
      this.getMarketPrices(session.gtApiKey, Boolean(refresh?.forceMarket)).catch((error) => {
        warnings.push(`Could not load exchange prices: ${describeGtError(error)}.`);
        return { value: [], rateLimits: [] };
      }),
      this.getMarketDetails(session.gtApiKey, Boolean(refresh?.forceMarket)).catch((error) => {
        warnings.push(`Could not load exchange details: ${describeGtError(error)}.`);
        return { value: [], rateLimits: [] };
      }),
      cachedCompany ? Promise.resolve(cachedCompany) : this.getCompanyParts(session.gtApiKey)
    ]);

    rateLimits.push(...prices.rateLimits, ...details.rateLimits);
    if ("rateLimits" in companyParts) {
      rateLimits.push(...companyParts.rateLimits);
      warnings.push(...companyParts.warnings);
    }

    const companyValue = "company" in companyParts ? companyParts : cachedCompany;
    if (!companyValue) {
      throw new Error("Unable to load Galactic Tycoons company snapshot.");
    }

    const snapshotCore: SnapshotCacheValue = {
      company: companyValue.company,
      bases: companyValue.bases,
      warehouses: companyValue.warehouses,
      exchangeOrders: companyValue.exchangeOrders,
      cashHistory: companyValue.cashHistory,
      contracts: companyValue.contracts,
      basePlans: companyValue.basePlans,
      wishlists: companyValue.wishlists,
      market: {
        prices: prices.value,
        details: details.value
      },
      gameData,
      rateLimits,
      warnings
    };

    this.companyCache.set(companyCacheKey, snapshotCore, COMPANY_TTL_MS);

    return {
      fetchedAt: new Date().toISOString(),
      ...snapshotCore
    };
  }

  private async getGameData(force: boolean): Promise<Record<string, unknown>> {
    const cached = force ? undefined : this.gameDataCache.get("gamedata");
    if (cached) return cached;
    const { body } = await this.fetchJson<Record<string, unknown>>("/gamedata.json");
    this.gameDataCache.set("gamedata", body, GAME_DATA_TTL_MS);
    return body;
  }

  private async getMarketPrices(apiKey: string, force: boolean) {
    const cached = force ? undefined : this.marketPricesCache.get("prices");
    if (cached) return { value: cached, rateLimits: [] };
    const { body, rateLimit } = await this.fetchJson<{ prices?: Record<string, unknown>[] }>(
      "/public/exchange/mat-prices",
      apiKey
    );
    const prices = Array.isArray(body.prices) ? body.prices : [];
    this.marketPricesCache.set("prices", prices, MARKET_PRICES_TTL_MS);
    return { value: prices, rateLimits: rateLimit ? [rateLimit] : [] };
  }

  private async getMarketDetails(apiKey: string, force: boolean) {
    const cached = force ? undefined : this.marketDetailsCache.get("details");
    if (cached) return { value: cached, rateLimits: [] };
    const { body, rateLimit } = await this.fetchJson<{ materials?: Record<string, unknown>[] }>(
      "/public/exchange/mat-details",
      apiKey
    );
    const details = Array.isArray(body.materials) ? body.materials : [];
    this.marketDetailsCache.set("details", details, MARKET_DETAILS_TTL_MS);
    return { value: details, rateLimits: rateLimit ? [rateLimit] : [] };
  }

  private async getCompanyParts(apiKey: string): Promise<SnapshotCacheValue & { rateLimits: RateLimitInfo[] }> {
    const endpoints = [
      ["company", "/public/company"],
      ["bases", "/public/company/bases"],
      ["warehouses", "/public/company/warehouses"],
      ["exchangeOrders", "/public/company/exchangeorders"],
      ["cashHistory", "/public/company/cash-history"],
      ["contracts", "/public/company/contracts"],
      ["basePlans", "/public/company/baseplans"],
      ["wishlists", "/public/wishlists"]
    ] as const;

    const rateLimits: RateLimitInfo[] = [];
    const warnings: string[] = [];
    const result: Record<string, unknown> = {};

    await Promise.all(
      endpoints.map(async ([key, endpoint]) => {
        try {
          const { body, rateLimit } = await this.fetchJson<unknown>(endpoint, apiKey);
          result[key] = body;
          if (rateLimit) rateLimits.push(rateLimit);
        } catch (error) {
          if (key === "company") throw error;
          result[key] = [];
          warnings.push(`Could not load ${key}: ${describeGtError(error)}. Continuing with an empty set.`);
        }
      })
    );

    return {
      company: asRecord(result.company),
      bases: asRecordArray(result.bases),
      warehouses: asRecordArray(result.warehouses),
      exchangeOrders: asRecordArray(result.exchangeOrders),
      cashHistory: asRecordArray(result.cashHistory),
      contracts: asRecordArray(result.contracts),
      basePlans: asRecordArray(result.basePlans),
      wishlists: asRecordArray(result.wishlists),
      market: { prices: [], details: [] },
      gameData: {},
      rateLimits,
      warnings
    };
  }

  private async fetchJson<T>(endpoint: string, apiKey?: string): Promise<{ body: T; rateLimit?: RateLimitInfo }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;

    try {
      response = await this.fetchImpl(`${this.baseUrl}${endpoint}`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
        signal: controller.signal
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new GtApiError(`Galactic Tycoons request timed out after ${Math.round(this.timeoutMs / 1000)}s.`, endpoint, 504);
      }
      throw new GtApiError(error instanceof Error ? error.message : "Galactic Tycoons request failed.", endpoint);
    } finally {
      clearTimeout(timeout);
    }

    const rateLimit = parseRateLimit(endpoint, response.headers);
    if (response.status === 429) {
      throw new RateLimitError("Galactic Tycoons API rate limit exceeded.", endpoint, rateLimit?.retryAfterSeconds);
    }

    if (!response.ok) {
      let message = `Galactic Tycoons API returned ${response.status} for ${endpoint}.`;
      try {
        const body = (await response.json()) as { error?: string };
        if (body.error) message = body.error;
      } catch {
        // Keep the status-based message.
      }
      throw new GtApiError(message, endpoint, response.status);
    }

    return { body: (await response.json()) as T, rateLimit };
  }
}

function describeGtError(error: unknown): string {
  if (error instanceof RateLimitError) {
    return `${error.message}${error.retryAfterSeconds ? ` Retry after ${error.retryAfterSeconds}s` : ""}`;
  }
  if (error instanceof GtApiError) {
    return `${error.message}${error.status ? ` (${error.status})` : ""}`;
  }
  return error instanceof Error ? error.message : "unknown error";
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function parseRateLimit(endpoint: string, headers: Headers): RateLimitInfo | undefined {
  const remaining = numberHeader(headers, "Rate-Remaining");
  const resetSeconds = numberHeader(headers, "Rate-Reset");
  const retryAfterSeconds = numberHeader(headers, "Retry-After");
  if (remaining === undefined && resetSeconds === undefined && retryAfterSeconds === undefined) return undefined;
  return { endpoint, remaining, resetSeconds, retryAfterSeconds };
}

function numberHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}
