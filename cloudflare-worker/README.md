# GitHub MCP Proxy — Cloudflare Worker

OAuth proxy that bridges **Claude.ai web** with the official
[`github/github-mcp-server`](https://github.com/github/github-mcp-server) remote endpoint.

## Why this exists

The official GitHub MCP remote endpoint (`api.githubcopilot.com/mcp/`) uses
GitHub PAT authentication — it does not support the OAuth flow that Claude.ai
web requires. This Worker fills that gap:

```
Claude.ai web
    │  OAuth flow (register → authorize → token)
    ▼
github-mcp-proxy (this Worker)
    │  GitHub PAT (stored in KV)
    ▼
api.githubcopilot.com/mcp/
    │  GitHub API (80+ tools)
    ▼
github.com
```

## Tools available

All 80+ tools from `github/github-mcp-server`, including:

- **Actions** — list, trigger, get job logs
- **Projects** — full GitHub Projects v2 support  
- **Discussions** — list, read, comments
- **Releases** — list, latest, by tag
- **Security Advisories** — global and per-repo
- **Labels, Gists, Tags, Stars** and much more
- **Full repos, issues, PRs, notifications** coverage

## Setup

### 1. Prerequisites

```bash
npm install -g wrangler
wrangler login
```

### 2. Install dependencies

```bash
cd cloudflare-worker
npm install
```

### 3. Deploy

```bash
wrangler deploy
```

The Worker deploys to:
`https://github-mcp-proxy.ops-e1a.workers.dev`

### 4. Connect Claude.ai

In Claude.ai → Settings → Connectors → Add custom connector:

```
https://github-mcp-proxy.ops-e1a.workers.dev/mcp
```

Claude will redirect you to the authorization page where you enter
your GitHub Personal Access Token.

### 5. Create a GitHub PAT

Go to [GitHub → Settings → Personal Access Tokens](https://github.com/settings/personal-access-tokens/new)
and create a token with these permissions:

| Scope | Purpose |
|---|---|
| `repo` | Read/write repositories, issues, PRs |
| `read:org` | Access organization repos |
| `notifications` | Notification tools |
| `workflow` | GitHub Actions (optional) |

## Cloudflare resources

| Resource | Name | ID |
|---|---|---|
| KV Namespace | `github-mcp-proxy-OAUTH` | `20cb14eff6cf4a9cbc7d0119018f0876` |
| Worker | `github-mcp-proxy` | `ops-e1a.workers.dev` |

## Architecture notes

- **Transport**: streamable-http — no SSE, no waitUntil timeouts
- **No tool implementation**: all tools proxied from official endpoint
- **Token storage**: `token:{accessToken}` → `{ github_pat, github_login }` in KV
- **PKCE**: S256 code challenge verification
- **Refresh tokens**: supported, 30-day TTL
- **Upstream**: `https://api.githubcopilot.com/mcp/`

## Comparison with previous Worker

| | `shared-github-mcp-server-1` (old) | `github-mcp-proxy` (this) |
|---|---|---|
| Tools | 50 | 80+ |
| Transport | SSE (25.7% timeout rate) | streamable-http |
| DO storage leak | ✓ (2,000+ instances) | ✗ (no DOs) |
| Tool maintenance | Custom (manual) | GitHub (automatic) |
| Actions/Projects/Discussions | ✗ | ✓ |
| Architecture | PartyKit + DO | Simple proxy |
| Lines of code | ~1,200 (bundled) | ~350 (source) |
