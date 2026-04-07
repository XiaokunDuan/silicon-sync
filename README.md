# Palo Wire

Palo Wire is an agent-native source layer for tracking early Silicon Valley signals across product launches, developer communities, startup media, newsletters, podcasts, and venture capital writing.

Instead of building a traditional media site, Palo Wire treats public web sources as inputs to a lightweight intelligence node:

- crawl a curated set of high-signal sources
- prefer official entry points over brittle scraping
- keep a rolling 24-hour window of output
- expose minimal JSON documents that downstream agents can crawl, rank, summarize, and synthesize

The root page is a landing page for humans. The core product is the source node behind it.

## Live Access

- Landing page: [https://silicon.yulu34.top](https://silicon.yulu34.top)
- Global documents feed: [https://silicon.yulu34.top/api/documents](https://silicon.yulu34.top/api/documents)
- Source registry: [https://silicon.yulu34.top/api/sources](https://silicon.yulu34.top/api/sources)
- Worker preview: [https://palo-wire.ylu665485.workers.dev](https://palo-wire.ylu665485.workers.dev)

If you are a human, start with the landing page.

If you are an agent, start with:

- `/api/sources` to discover available sources
- `/api/documents` to read the latest cross-source documents
- `/api/sources/:id/documents` to pull one source at a time
- `/api/runs/latest` to inspect sync status

## Why This Exists

Most “trend tracking” products are designed for people to browse manually. That breaks down quickly for agentic workflows:

- the web is noisy
- source formats are inconsistent
- high-signal content is scattered across feeds, sitemaps, APIs, and modern app shells
- agents should not have to rediscover the same public information on every run

Palo Wire solves this by maintaining a small, opinionated, continuously refreshed layer of crawlable documents for Silicon Valley tech and VC intelligence.

In short:

`Palo Wire = a 24-hour rolling source node for AI systems watching Silicon Valley.`

## Design Principles

- `Agent-first`: optimize for downstream model consumption, not dashboard depth.
- `Official-entry-first`: prefer RSS, XML sitemaps, page-data endpoints, and vendor APIs before HTML scraping.
- `High-signal only`: track a small number of good sources instead of mirroring the entire web.
- `Minimal schema`: keep documents lightweight enough for cheap downstream crawling.
- `Rolling freshness`: prefer recent material while preserving the last successful snapshot for low-frequency sources.
- `Cheap to run`: stay within the operational envelope of Cloudflare Workers + KV.

## What The System Does

At a high level, Palo Wire:

1. reads a source registry
2. schedules crawl batches on Cloudflare Workers
3. uses source-specific ingestion paths per publisher or platform
4. builds normalized `article` and `podcast` documents
5. stores only the latest snapshot per source in Workers KV
6. exposes a simple JSON interface for downstream agents

Current output is intentionally small. Each document keeps only:

- `title`
- `content`
- `url`
- `source_id`
- `source_name`
- `document_type`
- `fetched_at`

## System Shape

### Runtime

- Entry point: [src/index.ts](/Users/dxk/code/product/silicon-sync/src/index.ts)
- Source registry: [sources/registry.json](/Users/dxk/code/product/silicon-sync/sources/registry.json)
- Worker config: [wrangler.jsonc](/Users/dxk/code/product/silicon-sync/wrangler.jsonc)
- API reference: [docs/api.md](/Users/dxk/code/product/silicon-sync/docs/api.md)
- Architecture notes: [docs/architecture.md](/Users/dxk/code/product/silicon-sync/docs/architecture.md)

### Storage

Workers KV stores:

- the latest snapshot for each source
- the latest sync run summary
- the sync cursor for batched scheduled execution

### Scheduling

- cron trigger every 3 hours
- batched sync to stay under Worker subrequest limits
- manual sync supported via authenticated `POST /api/sync`

## Source Ingestion Strategy

Palo Wire does not use one generic crawler for everything. Each source is assigned an explicit ingestion mode.

### `rss_feed`

Used for sources with stable public feeds.

Examples:

- Lenny's Newsletter
- Lenny's Podcast
- Latent Space
- Y Combinator Blog

### `xml_sitemap`

Used for sites with stable publisher-managed sitemap indexes.

Examples:

- a16z
- Sequoia
- Lightspeed
- a16z Podcast Network

### `official_api`

Used when public HTML is protected or unstable but a vendor API is available.

Examples:

- Product Hunt

### `page_data`

Used for modern application shells that expose structured data separately from rendered pages.

Examples:

- NFX

### `manual_curated`

Used when no stable automated public entry point exists.

Examples:

- Benchmark

## Current Coverage

### Tech

- Hacker News
- Product Hunt
- Y Combinator Launches
- TechCrunch
- Lenny's Newsletter
- Lenny's Podcast
- Latent Space
- First Round Review
- Y Combinator Blog

### VC

- Crunchbase News
- a16z
- a16z Podcast Network
- Sequoia
- Lightspeed
- NFX
- Benchmark (manual curated)

## Freshness Model

Palo Wire prefers recent material, but low-frequency sources are not cleared just because they did not publish again inside the last 24 hours.

Current behavior:

- if a source has fresh matching content from the last 24 hours, that snapshot is replaced with the new result
- if a source has no fresh matching content, the last successful snapshot is preserved
- KV keys still expire on a short TTL, but active sources keep getting refreshed as the scheduler runs

This gives downstream agents two useful properties:

- fresh sources update quickly
- low-frequency sources do not collapse into empty feeds between publishing cycles

## Public Interface

### Root

- `GET /`

Returns a human-facing landing page describing the project and linking into the APIs.

### Source Registry

- `GET /api/sources`
- `GET /api/sources/:id`

Returns source metadata plus the latest snapshot summary.

### Documents

- `GET /api/documents`
- `GET /api/sources/:id/documents`

Returns normalized `article` and `podcast` documents.

### Links

- `GET /api/sources/:id/links`

Returns outbound links extracted from the latest source snapshot.

### Operations

- `GET /api/runs/latest`
- `POST /api/sync`

Returns or triggers sync operations.

For the precise wire shape, see [docs/api.md](/Users/dxk/code/product/silicon-sync/docs/api.md).

## Local Development

Install dependencies:

```bash
npm install
```

Run locally:

```bash
npm run dev
```

Type-check by using Wrangler’s generated types:

```bash
npx tsc --noEmit
```

## Deployment

Deploy the Worker:

```bash
npm run deploy
```

Required runtime pieces:

- Cloudflare Workers
- Workers KV
- a cron trigger

Optional secrets:

- `SYNC_TOKEN`
  Used for authenticated manual syncs.
- `PRODUCT_HUNT_TOKEN`
  Used for Product Hunt GraphQL ingestion.

These secrets must stay out of git. They belong in Worker secrets and/or a local secret store.

## Repository Status

This repo is intentionally narrow.

What is already in place:

- scheduled source crawling
- source-specific ingestion paths
- rolling source snapshots
- minimal document output
- NYT-style landing page
- public JSON endpoints

What is intentionally not in place yet:

- embeddings
- semantic search
- entity extraction
- topic clustering
- long-term historical archives
- user accounts
- billing

## Roadmap

Likely next steps:

1. distinguish `recent` vs `backfill` documents explicitly in output
2. tighten source-specific parsers further for YC Launches, TechCrunch, and podcast networks
3. add lightweight history without losing the low-cost runtime model
4. expose MCP-style resources or agent-oriented retrieval helpers

## Philosophy

Palo Wire is not trying to be another news reader.

It is trying to be a durable intermediate layer between the open web and agentic reasoning:

- closer to the sources than a summary product
- more structured than raw web pages
- cheaper and simpler than a full data platform

That constraint is deliberate.
