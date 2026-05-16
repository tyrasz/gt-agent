import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import fastify, { type FastifyInstance } from "fastify";
import staticPlugin from "@fastify/static";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GalacticTycoonsClient, GtApiError, RateLimitError } from "./gtClient.js";
import { RestLlmPlanner } from "./llm/providers.js";
import { ModelCatalogService } from "./modelCatalog.js";
import { redactError, redactSecrets } from "./redact.js";
import { MissingProviderKeyError, SessionStore } from "./sessionStore.js";
import { SitrepService } from "./sitrepService.js";
import { modelCatalogQuerySchema, sessionKeysRequestSchema, sitrepRequestSchema } from "../shared/schemas.js";

export type CreateAppOptions = {
  gtClient?: GalacticTycoonsClient;
  llmPlanner?: RestLlmPlanner;
  modelCatalog?: ModelCatalogService;
  sessionStore?: SessionStore;
};

export async function createApp(options: CreateAppOptions = {}): Promise<FastifyInstance> {
  const sessions = options.sessionStore ?? new SessionStore();
  const gtClient = options.gtClient ?? new GalacticTycoonsClient();
  const llmPlanner = options.llmPlanner ?? new RestLlmPlanner();
  const modelCatalog = options.modelCatalog ?? new ModelCatalogService();
  const sitrepService = new SitrepService(gtClient, llmPlanner, sessions);

  const app = fastify({
    logger: {
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "res.headers.set-cookie",
        "*.gtApiKey",
        "*.providerKeys",
        "*.providerApiKey",
        "*.apiKey",
        "*.token",
        "*.secret"
      ]
    }
  });

  await app.register(cookie);
  await app.register(cors, {
    origin: ["http://127.0.0.1:5173", "http://localhost:5173"],
    credentials: true
  });

  app.get("/api/health", async () => ({ ok: true, sessions: sessions.size() }));

  app.post("/api/session/keys", async (request, reply) => {
    const parsed = sessionKeysRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid key payload.", details: redactSecrets(parsed.error.format()) });
    }

    sessions.save(reply, parsed.data.gtApiKey, parsed.data.providerKeys);
    return { ok: true };
  });

  app.delete("/api/session", async (request, reply) => {
    sessions.destroy(request, reply);
    return { ok: true };
  });

  app.get("/api/session/models", async (request, reply) => {
    const session = sessions.get(request);
    if (!session) return reply.code(401).send({ error: "No active GT Agent session." });

    const parsed = modelCatalogQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid model catalog request.", details: parsed.error.format() });
    }

    try {
      return await modelCatalog.listModels(session, parsed.data.provider, Boolean(parsed.data.refresh));
    } catch (error) {
      if (error instanceof MissingProviderKeyError) {
        return reply.code(400).send({
          error: `No ${parsed.data.provider} API key is stored in this session.`
        });
      }
      request.log.error({ error: redactError(error) }, "model catalog failed");
      return reply.code(500).send({ error: "Could not load provider models." });
    }
  });

  app.post("/api/agent/sitrep", async (request, reply) => {
    const session = sessions.get(request);
    if (!session) return reply.code(401).send({ error: "No active GT Agent session." });

    const parsed = sitrepRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid sitrep request.", details: parsed.error.format() });
    }

    try {
      return await sitrepService.generate(session, parsed.data);
    } catch (error) {
      if (error instanceof RateLimitError) {
        return reply.code(429).send({
          error: error.message,
          details: { endpoint: error.endpoint, retryAfterSeconds: error.retryAfterSeconds }
        });
      }
      if (error instanceof GtApiError) {
        const statusCode = error.status === 401 || error.status === 403 ? 401 : 502;
        return reply.code(statusCode).send({
          error: error.message,
          details: { endpoint: error.endpoint, status: error.status }
        });
      }
      request.log.error({ error: redactError(error) }, "sitrep generation failed");
      return reply.code(500).send({ error: "Could not generate sitrep." });
    }
  });

  const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../client");
  if (process.env.NODE_ENV === "production") {
    await app.register(staticPlugin, { root: clientDir, prefix: "/" });
    app.setNotFoundHandler(async (_request, reply) => reply.sendFile("index.html"));
  }

  return app;
}

async function main(): Promise<void> {
  const app = await createApp();
  const port = Number(process.env.PORT ?? process.env.GT_AGENT_PORT ?? 8787);
  const host = process.env.HOST ?? (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
  await app.listen({ host, port });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(redactError(error));
    process.exit(1);
  });
}
