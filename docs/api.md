# API Design

Silicon Sync exposes an agent-native JSON interface over scheduled public-source snapshots.

## Endpoints

### `GET /`

Returns a service overview with available endpoints and the active cron schedule.

### `GET /api/sources`

Returns the configured source registry plus the latest stored snapshot summary for each source.

Supported query params:

- `category=tech|vc`

### `GET /api/sources/:id`

Returns the full latest snapshot for a single source, including:

- source metadata
- fetch status
- page title
- meta description
- text preview
- extracted links

### `GET /api/sources/:id/links`

Returns only the extracted outbound links for a single source snapshot.

### `GET /api/runs/latest`

Returns the latest sync run summary across all configured sources.

### `POST /api/sync`

Triggers an immediate sync run.

Authentication:

- `Authorization: Bearer <SYNC_TOKEN>`

## Intended Downstream Usage

This API is designed for agents that need to:

- pull the latest source snapshots
- inspect extracted links
- monitor sync success or failure
- use Silicon Sync as a pre-crawled source layer before deeper summarization
