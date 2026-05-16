import type { FastifyReply, FastifyRequest } from "fastify";
import type { Provider, ProviderKeys } from "../shared/schemas.js";

const COOKIE_NAME = "gt_agent_sid";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export type AgentSession = {
  id: string;
  gtApiKey: string;
  providerKeys: ProviderKeys;
  createdAt: number;
  updatedAt: number;
};

export class MissingProviderKeyError extends Error {
  constructor(readonly provider: Provider) {
    super(`No ${provider} API key is available in this session.`);
    this.name = "MissingProviderKeyError";
  }
}

export class SessionStore {
  private readonly sessions = new Map<string, AgentSession>();

  save(reply: FastifyReply, gtApiKey: string, providerKeys: ProviderKeys): AgentSession {
    this.pruneExpired();
    const id = crypto.randomUUID();
    const now = Date.now();
    const session: AgentSession = { id, gtApiKey, providerKeys, createdAt: now, updatedAt: now };
    this.sessions.set(id, session);
    reply.setCookie(COOKIE_NAME, id, {
      httpOnly: true,
      sameSite: "strict",
      secure: false,
      path: "/",
      maxAge: SESSION_TTL_MS / 1000
    });
    return session;
  }

  get(request: FastifyRequest): AgentSession | undefined {
    const id = request.cookies[COOKIE_NAME];
    if (!id) return undefined;
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (Date.now() - session.updatedAt > SESSION_TTL_MS) {
      this.sessions.delete(id);
      return undefined;
    }
    session.updatedAt = Date.now();
    return session;
  }

  requireProviderKey(session: AgentSession, provider: Provider): string {
    const key = session.providerKeys[provider];
    if (!key) {
      throw new MissingProviderKeyError(provider);
    }
    return key;
  }

  destroy(request: FastifyRequest, reply: FastifyReply): void {
    const id = request.cookies[COOKIE_NAME];
    if (id) this.sessions.delete(id);
    reply.clearCookie(COOKIE_NAME, { path: "/" });
  }

  size(): number {
    this.pruneExpired();
    return this.sessions.size;
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions.entries()) {
      if (now - session.updatedAt > SESSION_TTL_MS) this.sessions.delete(id);
    }
  }
}
