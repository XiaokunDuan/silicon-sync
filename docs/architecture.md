# Architecture

## v2 Goals

- Agent-native source ingestion node
- No frontend rendering layer
- Scheduled crawling of public source pages
- Persist latest snapshots in Cloudflare KV
- Expose lightweight JSON interfaces for downstream AI consumers

## Runtime Shape

- `src/index.ts` handles the public JSON API and scheduled sync logic
- `sources/registry.json` defines the public sources to crawl
- `wrangler.jsonc` configures the Worker, KV binding, and cron trigger
- Workers KV stores:
  - latest snapshot per source
  - latest sync run summary

## Current Snapshot Model

Each source snapshot stores:

- source id and name
- category and content channel
- requested URL and final URL
- fetch timestamp and HTTP status
- page title and meta description
- text preview
- extracted outbound links
- basic cache headers such as `etag` and `last-modified`

## Evolution Path

1. Add per-source specialized crawlers where generic page snapshots are insufficient.
2. Persist historical runs instead of only latest state.
3. Add normalized signal extraction on top of raw snapshots.
4. Expose MCP resources and tools for trend summaries and topic retrieval.
