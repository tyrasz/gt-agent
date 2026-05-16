import { describe, expect, it } from "vitest";
import { GalacticTycoonsClient, RateLimitError } from "../gtClient.js";
import type { AgentSession } from "../sessionStore.js";

const session: AgentSession = {
  id: "session-1",
  gtApiKey: "gt-test-key",
  providerKeys: { openai: "sk-test" },
  createdAt: Date.now(),
  updatedAt: Date.now()
};

describe("GalacticTycoonsClient", () => {
  it("sends bearer auth and captures rate limit headers", async () => {
    const authHeaders: string[] = [];
    const client = new GalacticTycoonsClient({
      baseUrl: "https://gt.test",
      fetchImpl: async (input, init) => {
        const url = String(input);
        const auth = new Headers(init?.headers).get("authorization");
        if (auth) authHeaders.push(auth);
        return Response.json(bodyFor(url), {
          headers: {
            "Rate-Remaining": "123",
            "Rate-Reset": "44"
          }
        });
      }
    });

    const snapshot = await client.getSnapshot(session, { forceCompany: true, forceMarket: true, forceGameData: true });

    expect(authHeaders.every((value) => value === "Bearer gt-test-key")).toBe(true);
    expect(snapshot.rateLimits.some((info) => info.remaining === 123 && info.resetSeconds === 44)).toBe(true);
  });

  it("throws a typed error on GT rate limits", async () => {
    const client = new GalacticTycoonsClient({
      baseUrl: "https://gt.test",
      fetchImpl: async (input) => {
        if (String(input).includes("mat-prices")) {
          return Response.json({}, { status: 429, headers: { "Retry-After": "30" } });
        }
        return Response.json(bodyFor(String(input)));
      }
    });

    await expect(client.getSnapshot(session, { forceMarket: true })).rejects.toBeInstanceOf(RateLimitError);
  });
});

function bodyFor(url: string) {
  if (url.endsWith("/gamedata.json")) return { materials: [], recipes: [] };
  if (url.endsWith("/public/exchange/mat-prices")) return { prices: [] };
  if (url.endsWith("/public/exchange/mat-details")) return { materials: [] };
  if (url.endsWith("/public/company")) return { id: 42, name: "Test Co" };
  return [];
}
