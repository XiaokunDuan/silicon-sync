# Silicon Sync

Silicon Sync is an agent-native source node for tracking early Silicon Valley signals across product launches, developer communities, and venture capital.

## Positioning

- No human-facing frontend in v2
- Scheduled public-source crawling on Cloudflare Workers
- AI-friendly JSON output for downstream agents and summarizers
- English-first source preservation to reduce lossy re-interpretation
- Official-entry-first ingestion: feeds, sitemaps, and vendor APIs before HTML scraping

## What It Does

- Periodically fetches configured public source pages
- Extracts page title, meta description, text preview, and outbound links
- Builds minimal `article` and `podcast` documents for selected high-signal sources
- Uses source-specific extractors for Product Hunt, a16z, NFX, and sitemap-backed VC sites
- Stores the latest snapshot for each source in Workers KV
- Exposes JSON endpoints for sources, snapshots, documents, links, and latest sync runs

## Current Coverage

- Hacker News
- Product Hunt
- Y Combinator Launches
- TechCrunch
- Crunchbase News
- a16z
- Sequoia
- Lightspeed
- Benchmark
- NFX
- Lenny's Newsletter
- Lenny's Podcast
- Latent Space
- a16z Podcast Network
- First Round Review
- Y Combinator Blog

## API

- `GET /`
- `GET /api/sources`
- `GET /api/sources/:id`
- `GET /api/sources/:id/documents`
- `GET /api/sources/:id/links`
- `GET /api/documents`
- `GET /api/runs/latest`
- `POST /api/sync`

See [docs/api.md](/Users/dxk/code/product/silicon-sync/docs/api.md).

## Runtime

- Worker entry: [src/index.ts](/Users/dxk/code/product/silicon-sync/src/index.ts)
- Source registry: [sources/registry.json](/Users/dxk/code/product/silicon-sync/sources/registry.json)
- Cloudflare config: [wrangler.jsonc](/Users/dxk/code/product/silicon-sync/wrangler.jsonc)

## Local Development

```bash
npm install
npm run dev
```

## Deploy

```bash
npm run deploy
```

The worker uses:

- Workers KV for latest source snapshots
- a cron trigger every 3 hours
- an optional `SYNC_TOKEN` secret for manual sync
- an optional `PRODUCT_HUNT_TOKEN` secret for Product Hunt GraphQL ingestion
- batched sync execution to stay within Worker subrequest limits

## Document Shape

Structured documents are intentionally minimal. Each item keeps only:

- `title`
- `content`
- `url`
- `source_id`
- `source_name`
- `document_type`
- `fetched_at`

## Retention

- Structured documents are filtered to the last 24 hours
- KV entries expire automatically shortly after that window
- Freshly crawled data is kept; older data rolls off on subsequent syncs
