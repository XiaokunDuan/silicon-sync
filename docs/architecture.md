# Architecture

## v1 Goals

- Public read-only intelligence desk
- English-first structured summaries
- Manual curation with local JSON sample data
- Cloudflare Workers deployment on the free tier

## Runtime Shape

- `public/` holds static assets for the main feed experience
- `src/index.ts` handles JSON API routes and signal detail pages
- `data/samples/signals.json` is the canonical content store in v1
- `sources/registry.json` documents target sources and planned acquisition methods

## Evolution Path

1. Replace local JSON with generated data artifacts.
2. Add scheduled ingestion for stable feeds.
3. Add search-oriented endpoints.
4. Add MCP-compatible tool and resource layer.
