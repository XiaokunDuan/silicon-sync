# API Design

Silicon Sync v1 exposes a thin public JSON API behind the human-facing desk.

## Endpoints

### `GET /api/signals`

Returns all signals sorted by `published_at` descending.

Supported query params:

- `category=tech|vc`
- `source=<source name>`
- `tag=<tag slug>`

### `GET /api/signals/:id`

Returns a single signal by stable ID.

## Future Compatibility

The API is intentionally narrow so the same record store can later support:

- `search(query)`
- `fetch(id)`
- `latest`
- `by_source`
- `by_topic`
- MCP resources and tools

The canonical content model should remain shared between the website, API, and future agent-facing access layer.
