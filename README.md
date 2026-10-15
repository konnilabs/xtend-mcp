# XTend hosted MCP — development MVP

Standalone, Apache-2.0 licensed, read-only knowledge service for XTend agents.
Implementation tracks [XTend #113](https://github.com/konnilabs/xtend/issues/113).
This first development slice is **not production-ready** and has no deployed public endpoint.

## Responsibilities

This repository owns HTTP hosting, synchronization, snapshots, limits and container operation.
Canonical documentation and recipes remain in `konnilabs/xtend`. Requests use a local snapshot;
only the background synchronizer contacts GitHub. Downloaded JavaScript and recipes are never executed.
The upstream retrieval module is vendored unchanged with commit, hash and license in `vendor/`;
upgrades are reviewed software changes, pending an upstream public library package boundary.

## Run

Node.js 24.19.0; install with `npm ci --ignore-scripts`, then `npm test` and `npm run check`.
Set `XTEND_MCP_TOKENS` to one or more comma-separated secrets (32–256 characters each), then
run `npm start`. Supply secrets through the deployment environment; do not commit them.

For Docker: set the same variable, then `docker compose up --build -d`.
The image binds internally to `0.0.0.0`; Compose exposes only `127.0.0.1:31415` on the host.
Put an HTTPS reverse proxy in front of it. Set `XTEND_ALLOWED_HOSTS` to the exact external
hostname and internal health-check hostname; configure `XTEND_ALLOWED_ORIGINS` with exact
scheme/host/port origins when browser access is needed. Missing Origin is allowed for machine clients.
This slice ignores forwarded headers: clients behind a proxy share its IP budget. Dedicated per-client
IP attribution through explicitly trusted proxies remains open. Bearer-header clients are supported;
OAuth discovery is not implemented.

`POST /mcp` uses the official SDK's stateless Streamable HTTP transport and JSON responses.
Use `Authorization: Bearer <secret>` and `Accept: application/json, text/event-stream`.
`GET /health` is an unauthenticated process check; authenticated `GET /ready` reports readiness,
commit, ref, snapshot inventory and synchronization status. Without a valid snapshot MCP returns 503.
`X-XTend-Snapshot` selects a retained commit for a request; the response header reports the chosen commit.
A retained snapshot can eventually be evicted; unavailable selections fail rather than silently switching.

Tools: `xtend_knowledge_search`, `xtend_knowledge_context`.
Resources: paginated documentation listing and direct canonical documentation/kit URIs.
Prompt: `xtend_recipe`, with stable recipe `id`; discover recipes with knowledge search.
Compiler, repair and workspace mutation tools are deliberately absent from this hosted profile.

## Knowledge updates

`XTEND_SOURCE_REPOSITORY` defaults to `konnilabs/xtend`; `XTEND_SOURCE_REF` defaults to `main`
(the development channel). Select a release tag for a release channel. `GITHUB_TOKEN` optionally
provides read access and a larger API budget; never expose it to MCP clients.

Every sync resolves one commit, reads its Git tree, downloads the fixed artifact allowlist,
checks schemas, counts, hashes, documentation coverage, canonical menu, kit files and declared kit
source hashes, and prepares the upstream search index before atomic activation. Existing requests
hold a snapshot lease. Failure leaves the last valid snapshot available. Startup revalidates cached
artifacts. No independent productive recipe collection lives here.

Polling defaults to five minutes with jitter, ETag revalidation and bounded retries. Persist `/data`;
`XTEND_DATA_DIR` overrides the local directory. `XTEND_RETAIN_SNAPSHOTS` defaults to three.
`XTEND_MAX_SNAPSHOT_BYTES` defaults to 64 MiB (including source verification downloads); budget
failure rejects the whole update, never truncates recipes. The filesystem/volume itself still needs
an operator-enforced disk quota. Recipe counts and topic names have no fixed product maximum.

## Request budgets

Defaults: 60 requests/minute/key, 120/minute/socket IP, 10 requests/second globally,
eight concurrent MCP requests, 128 connections, 64 KiB body, 1 MiB response and ten-second timeout.
All are configurable using the named `XTEND_*` variables in `src/config.mjs`. Limits protect
application work; provider/proxy protection is needed for connection floods and network saturation.
Never log access tokens. Shutdown aborts synchronization and closes HTTP connections.

## Remaining acceptance work

- Run container build and SDK-client integration through a real TLS reverse proxy; benchmark target hardware.
- Add recipe catalogue filtering/pagination, existing per-recipe prompt aliases, compatibility metadata and explicit incompatibility behavior.
- Prove generated kit freshness using a successful upstream release/drift gate (source hashes alone do not prove generator freshness).
- Add signed webhook triggering, stronger exponential backoff, rollback operations and exhaustive retention/crash tests.
- Expand timeout, response budget, rate, forged-header, secret-redaction and resource-exhaustion tests.
- Finish DE/EN operator documentation and review the shared retrieval package boundary.
- Pin CI action/image digests and establish dependency/security update policy before deployment.

The first tests cover real SDK server transport requests, knowledge retrieval and recipe ID 999,
invalid access/origin/host/body, corrupt artifacts, 1,000-record growth, atomic update and pinning,
restart recovery, and failed/single-flight synchronization. They use synthetic data, not a copied
productive knowledge base. Docker verification belongs to CI and is not claimed as locally completed.

## Deutsch

Dies ist der erste Entwicklungsstand, noch kein freigegebener Serverbetrieb. Die Wissensbasis bleibt
im XTend-Hauptrepository; der Container übernimmt geprüfte Snapshots unabhängig vom Image.
Zugangsschlüssel, HTTPS-Proxy und passende Host-/Origin-Freigaben sind für den Betrieb erforderlich.
Die oben genannten offenen Abnahmen müssen vor einer öffentlichen Bereitstellung abgeschlossen sein.
