# GT Agent

Local agentic companion for Galactic Tycoons. GT Agent fetches read-only company and market data, analyzes operations and logistics, and asks a BYO LLM provider key to produce a sitrep and manual action plan.

## Run Locally

```bash
npm install
npm run dev
```

Open http://127.0.0.1:5173.

## Security Model

- Galactic Tycoons and LLM provider API keys are stored only in backend process memory.
- The browser receives an HTTP-only session cookie and does not persist keys in local storage.
- Closing the backend process clears all secrets and cached session data.
- V1 is read-only against Galactic Tycoons and prepares manual commands only.

## Quick Web Deploy

GT Agent is a full-stack app, so deploy it as a Node web service rather than a static site.

### Render

- Connect this GitHub repo as a Web Service, or use the included `render.yaml` blueprint.
- Build command: `npm ci && npm run build`
- Start command: `npm start`
- Environment: `NODE_ENV=production`
- Health check: `/api/health`

### Railway

- Create a new Railway project from this GitHub repo.
- Railway can use the included `railway.json`.
- Build command: `npm ci && npm run build`
- Start command: `npm start`
- Health check: `/api/health`

## Hosted Use Warning

When GT Agent is deployed on a server, user-entered Galactic Tycoons and provider keys are processed by that server in memory. The app does not persist them, but the server operator should still disclose this to users.
