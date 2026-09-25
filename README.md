# cloudflare-mcp

A zero-dependency [Model Context Protocol](https://modelcontextprotocol.io) server for Cloudflare. It exposes typed tools for DNS, zones, and cache, plus a universal passthrough to any Cloudflare API v4 endpoint. Destructive operations are gated behind an explicit confirmation.

Single file, no npm dependencies, Node 18+.

## Design

Most infrastructure MCP servers pull in a framework, a build step, and a tree of transitive dependencies. This one is a single `index.mjs` — small enough to read in full and audit before granting write access to your DNS. Two decisions shape it:

- **Typed convenience tools over a universal escape hatch.** Cloudflare's API v4 has hundreds of endpoints; wrapping all of them is pointless churn. The common paths (DNS and cache) get first-class tools with schemas; `cf_request` covers everything else, so a caller is never blocked by a missing wrapper.
- **Confirmation on destructive actions.** `cf_dns_delete` and `cf_purge_cache { everything: true }` return a refusal unless `confirm: true` is passed. The refusal comes back as structured data rather than an exception, so the caller can see why and retry deliberately.

Zone arguments accept either a domain name (`example.com`) or a 32-character zone id; names are resolved to ids and cached per process.

## Tools

| Tool | Purpose | Confirm |
|------|---------|:-------:|
| `cf_request` | Call any Cloudflare API v4 endpoint (`method`, `path`, `query`, `body`) | — |
| `cf_verify` | Verify the API token and report its status | — |
| `cf_list_zones` | List all zones with ids and status | — |
| `cf_dns_list` | List DNS records for a zone | — |
| `cf_dns_create` | Create a DNS record | — |
| `cf_dns_update` | Update a DNS record by id (PATCH — changed fields only) | — |
| `cf_dns_delete` | Delete a DNS record by id | required |
| `cf_purge_cache` | Purge specific `files`, or everything | required (everything) |

## Configuration

Create an API token at https://dash.cloudflare.com/profile/api-tokens with the scopes you need — typically:

- Zone → DNS → Edit
- Zone → Zone → Read
- Zone → Cache Purge → Purge

Provide it via the environment or a local `.env` (copy `.env.example`):

```bash
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ACCOUNT_ID=      # optional — scopes cf_list_zones to one account
```

Precedence: process environment, then `.env` in the working directory, then `.env` beside `index.mjs`.

## Client setup

Claude Code:

```bash
claude mcp add cloudflare -- npx @habib-alqalam/cloudflare-mcp
```

Any client that reads a JSON config:

```jsonc
{
  "mcpServers": {
    "cloudflare": {
      "command": "npx",
      "args": ["@habib-alqalam/cloudflare-mcp"],
      "env": { "CLOUDFLARE_API_TOKEN": "..." }
    }
  }
}
```

From a local clone, use `"command": "node"` with an absolute path to `index.mjs`.

## Examples

```jsonc
// Point a subdomain at a host, proxied through Cloudflare
cf_dns_create { "zone": "example.com", "type": "A", "name": "app", "content": "203.0.113.10", "proxied": true }

// List MX records
cf_dns_list { "zone": "example.com", "type": "MX" }

// Delete a record — confirmation required
cf_dns_delete { "zone": "example.com", "id": "...", "confirm": true }

// Anything without a dedicated wrapper — e.g. read a zone's SSL setting
cf_request { "method": "GET", "path": "/zones/{zone_id}/settings/ssl" }
```

## Operational notes

Reads and verification never require confirmation. Writes happen on request; the reliable pattern is to write, then re-read with `cf_dns_list` to confirm. Deletes and full-cache purges return `{ "refused": ... }` unless `confirm: true` is passed.

Scope the token to only the zones and permissions required — the server can do exactly what the token allows, and no more.

## Development

```bash
npm run smoke
```

Spawns the server, drives the JSON-RPC handshake, and checks the tool surface. Passes without a token; additionally exercises `cf_verify` when `CLOUDFLARE_API_TOKEN` is set.

## License

[MIT](./LICENSE)
