# API Design

Silicon Sync exposes an agent-native JSON interface over scheduled public-source snapshots.

## Endpoints

### `GET /`

Returns a service overview with available endpoints and the active cron schedule.

### `GET /api/sources`

Returns the configured source registry plus the latest stored snapshot summary for each source.

Supported query params:

- `category=tech|vc`

Each source now also includes:

- `ingest_mode`
- `enabled`
- `stability`

### `GET /api/sources/:id`

Returns the full latest snapshot for a single source, including:

- source metadata
- fetch status
- page title
- meta description
- text preview
- extracted links
- structured documents when available

### `GET /api/sources/:id/documents`

Returns structured documents for a single source.

Current document shapes:

- `article`
- `podcast`

Each item now keeps only:

- `title`
- `content`
- `url`
- `source_id`
- `source_name`
- `document_type`
- `fetched_at`

Retention behavior:

- only the most recent 24 hours of documents are kept in output
- older data is filtered out on sync and KV entries also expire automatically

### `GET /api/sources/:id/links`

Returns only the extracted outbound links for a single source snapshot.

### `GET /api/documents`

Returns structured documents across all sources.

Supported query params:

- `type=article|podcast`
- `category=tech|vc`
- `source=<source id>`
- `limit=<n>`

### `GET /api/runs/latest`

Returns the latest sync run summary across all configured sources.

### `POST /api/sync`

Triggers an immediate sync run.

Note:

- each sync runs a batch of sources, not the entire registry at once
- this keeps the Worker under Cloudflare subrequest limits
- Product Hunt requires the `PRODUCT_HUNT_TOKEN` Worker secret when enabled

Authentication:

- `Authorization: Bearer <SYNC_TOKEN>`

## Intended Downstream Usage

This API is designed for agents that need to:

- pull the latest source snapshots
- pull normalized article and podcast documents
- inspect extracted links
- monitor sync success or failure
- use Silicon Sync as a pre-crawled source layer before deeper summarization
