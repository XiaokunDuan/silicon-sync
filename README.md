# Silicon Sync

Silicon Sync is a public intelligence desk for tracking early Silicon Valley signals across product launches, developer communities, and venture capital.

## Positioning

- Human-first in v1: readable as a public signal desk
- Agent-ready by design: structured records and stable IDs
- English-first content to preserve source fidelity and make later API or MCP usage simpler

## What v1 includes

- A public feed of manually curated signals
- Filters for category, source, and topic
- Detail pages for each signal
- A thin JSON API behind the UI
- A source registry documenting target information sources

## Initial coverage

### Tech

- Hacker News
- Product Hunt
- Y Combinator
- TechCrunch

### VC

- Crunchbase
- a16z
- Sequoia
- Lightspeed
- Benchmark

## Data model

Each signal is stored as a structured record with:

- `id`
- `title`
- `source`
- `url`
- `published_at`
- `category`
- `signal_type`
- `summary`
- `why_it_matters`
- `tags`

The canonical sample data lives in [data/samples/signals.json](/Users/bytedance/silicon-sync/data/samples/signals.json).

## API

- `GET /api/signals`
- `GET /api/signals/:id`

Supported list filters:

- `category`
- `source`
- `tag`

See [docs/api.md](/Users/bytedance/silicon-sync/docs/api.md).

## Local development

```bash
npm install
npm run dev
```

## Deploy to Cloudflare Workers

```bash
npm run deploy
```

You will need to authenticate `wrangler` with your Cloudflare account before the first deployment.

## Repo layout

- [src/index.ts](/Users/bytedance/silicon-sync/src/index.ts): Worker routes and signal detail rendering
- [public/index.html](/Users/bytedance/silicon-sync/public/index.html): main feed shell
- [sources/registry.json](/Users/bytedance/silicon-sync/sources/registry.json): target source registry
- [docs/architecture.md](/Users/bytedance/silicon-sync/docs/architecture.md): runtime and evolution path

## Next steps

1. Replace hand-curated JSON with generated data artifacts.
2. Add scheduled ingestion for stable feeds.
3. Add search endpoints and richer topic pages.
4. Add an MCP layer for agent-native access.
