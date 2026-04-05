# GitHub MCP Proxy — Cloudflare Worker v3.1

OAuth proxy that bridges **Claude.ai web** with the official
[`github/github-mcp-server`](https://github.com/github/github-mcp-server) remote endpoint
(`api.githubcopilot.com/mcp/`), plus a set of document editing endpoints that bypass
the MCP transport size limit.

```
Claude.ai web
    │  OAuth (register → authorize → token)
    ▼
github-mcp-proxy.ops-e1a.workers.dev   ← this Worker (v3.1)
    │  Bearer <github_pat>
    ▼
api.githubcopilot.com/mcp/             ← github/github-mcp-server v0.32.0
    │
    ▼
GitHub API  (80+ tools)
```

## MCP tools available

All 80+ tools from `github/github-mcp-server` v0.32.0, maintained by GitHub:
Actions, Projects v2, Discussions, Releases, Tags, Stars, Labels, Gists,
Security Advisories, full repos/issues/PRs/notifications, and more.
See the [comparative audit](../docs/ops/github-mcp-audit-comparativo.md) for the full list.

---

## Document Editing API

Five HTTP endpoints that operate directly on GitHub files, bypassing the MCP
transport size limit. Use these for files too large to pass through MCP calls,
or when you want surgical edits without reading the full file.

### Authentication

All `/github-*` endpoints accept either:

```
Authorization: Bearer <oauth_access_token>   # from the OAuth flow (stored in KV)
Authorization: Bearer ghp_...               # direct classic GitHub PAT
Authorization: Bearer github_pat_...        # direct fine-grained GitHub PAT
```

---

### `POST /github-read`

Read a file as plain UTF-8 text. Handles files >1MB via `download_url`.

**Request**
```json
{
  "owner": "yessicavs",
  "repo": "github-mcp-server",
  "path": "docs/ops/README.md",
  "branch": "main"              // optional, defaults to default branch
}
```

**Response**
```json
{
  "content": "# Ops Documentation...\n",
  "sha": "f76886e2f9d8...",     // use in /github-patch to avoid conflicts
  "size": 5230,
  "path": "docs/ops/README.md",
  "name": "README.md",
  "html_url": "https://github.com/.../README.md",
  "lines": 142,
  "chars": 5230,
  "is_large_file": false       // true when size > 1MB
}
```

---

### `POST /github-read-section`

Read lines `start_line` to `end_line` (1-based, inclusive) with optional context
expansion. Solves context window overflow for large documents — read only the
section you need to update.

**Request**
```json
{
  "owner": "yessicavs",
  "repo": "github-mcp-server",
  "path": "docs/ops/large-audit.md",
  "start_line": 200,     // 1-based, inclusive (default: 1)
  "end_line": 260,       // 1-based, inclusive (default: last line)
  "context_lines": 5     // expand selection by N lines on each side (max 50, default 0)
}
```

**Response**
```json
{
  "content": "## Sección relevante...\n...",
  "sha": "f76886e2...",    // file SHA — use directly in /github-patch
  "start_line": 195,      // actual start after context expansion
  "end_line": 265,        // actual end after context expansion
  "requested_start": 200,
  "requested_end": 260,
  "context_lines": 5,
  "total_lines": 357,     // total lines in full file
  "section_lines": 71,
  "section_chars": 3420,
  "is_large_file": false
}
```

Line arithmetic is CRLF-normalized (\r\n → \n) before slicing.

---

### `POST /github-patch`

Replace text with strict uniqueness validation. Supports single-patch and
multi-patch (array) mode. CRLF-safe. One commit per call.

**Request — single patch**
```json
{
  "owner": "yessicavs",
  "repo": "github-mcp-server",
  "path": "docs/ops/README.md",
  "old_str": "Actualizado: 2026-04-04",
  "new_str": "Actualizado: 2026-04-05",
  "message": "docs: update last-modified date",  // optional
  "branch": "main"                               // optional
}
```

**Request — multi-patch (array mode, atomic — one commit)**
```json
{
  "owner": "yessicavs",
  "repo": "github-mcp-server",
  "path": "docs/ops/audit.md",
  "patches": [
    { "old_str": "## Estado actual\n> v1", "new_str": "## Estado actual\n> v2" },
    { "old_str": "Actualizado: 2026-04-04", "new_str": "Actualizado: 2026-04-05" }
  ],
  "message": "docs: weekly update"
}
```

**Response**
```json
{
  "success": true,
  "path": "docs/ops/README.md",
  "sha_before": "f76886e2...",
  "sha_after": "3a0bc5b2...",
  "commit": "307ab7cf...",
  "commit_url": "https://github.com/.../commit/307ab7cf",
  "patches_applied": [
    { "patch_index": 0, "replaced_at": { "line": 4, "col": 1 }, "delta": 0 }
  ],
  "chars_before": 5230,
  "chars_after": 5230,
  "total_delta": 0,
  "crlf_normalized": false    // true if file had \r\n line endings
}
```

**Error responses**

| Error | Status | Meaning |
|---|---|---|
| `not_found` | 422 | `old_str` not found — includes file stats and hint |
| `ambiguous` | 422 | `old_str` found >1 times — includes all positions and context |
| `conflict` | 409 | SHA mismatch (concurrent edit) — re-read with `/github-read` and retry |
| `invalid_request` | 400 | Missing required field, or `old_str` is empty |
| `github_error` | varies | GitHub API returned an error |

**CRLF:** `\r\n` is normalized to `\n` in both the file content and in `old_str`
before matching. The normalized (LF) content is written back — correct for Markdown.

---

### `POST /github-append`

Append content to the end of a file. Smart separator: adds `\n` automatically
if the file doesn't end with a newline.

**Request**
```json
{
  "owner": "yessicavs",
  "repo": "github-mcp-server",
  "path": "docs/ops/changelog.md",
  "content": "\n## 2026-04-05\n- Deployed Worker v3.1",
  "message": "docs: changelog entry 2026-04-05",  // optional
  "separator": "\n"                               // optional, overrides auto-newline
}
```

**Response**
```json
{
  "success": true,
  "sha_before": "...",
  "sha_after": "...",
  "commit": "...",
  "commit_url": "...",
  "chars_added": 48,
  "chars_before": 1200,
  "chars_after": 1248
}
```

---

### `POST /github-search`

Search for a string within a file. Returns matches with surrounding context lines.
Useful for locating a section before patching, without reading the full file.

**Request**
```json
{
  "owner": "yessicavs",
  "repo": "github-mcp-server",
  "path": "docs/ops/github-mcp-audit-comparativo.md",
  "query": "storage leak",
  "context_lines": 3,       // lines before/after each match (0-20, default 3)
  "max_matches": 20,        // cap results (1-200, default 50)
  "case_sensitive": false   // default false
}
```

**Response**
```json
{
  "query": "storage leak",
  "case_sensitive": false,
  "file_lines": 357,
  "file_chars": 18697,
  "total_matches": 3,
  "truncated": false,
  "matches": [
    {
      "line": 18,
      "col": 14,
      "text": "| **Storage leak** | >2,000 DO instances SQLite acumuladas | No existe — sin DOs |",
      "context_before": ["| **Runtime** | ...", "| **Tools** | ..."],
      "context_after": ["| **Logging de tools** | ...", "| **Traces** | ..."]
    }
  ]
}
```

---

## Size-based operation guide

| File size | Recommended approach |
|---|---|
| < 30 KB | `get_file_contents` (MCP) + `create_or_update_file` (MCP) |
| 30–70 KB | `/github-patch` — avoids transporting the full file via MCP |
| > 70 KB | `/github-read` or `/github-read-section` + `/github-patch` |
| > 1 MB | `/github-read` automatically uses `download_url` |

**Typical session workflow for large documents:**
1. `/github-search` — locate the section without reading the full file
2. `/github-read-section` — read lines around the section for exact context
3. `/github-patch` — replace the section (use SHA from step 2)
4. `/github-patch` — update the `Actualizado:` frontmatter line

---

## Setup

### Prerequisites

```bash
npm install -g wrangler
wrangler login
```

### Install and deploy

```bash
cd cloudflare-worker
npm install
wrangler deploy
```

Deployed to: `https://github-mcp-proxy.ops-e1a.workers.dev`

### Connect Claude.ai

Settings → Connectors → Add custom connector:
```
https://github-mcp-proxy.ops-e1a.workers.dev/mcp
```

Claude will redirect to the authorization page. Enter your GitHub PAT.

### Required GitHub PAT scopes

| Scope | Purpose |
|---|---|
| `repo` | Read/write repos, issues, PRs, files |
| `read:org` | Access organization repos |
| `notifications` | Notification tools |
| `workflow` | GitHub Actions (optional) |

---

## Cloudflare resources

| Resource | Name | ID |
|---|---|---|
| Account | Ops@growthxy.com | `e1a6f9414e9b47f056d1731ab791f4db` |
| Worker | `github-mcp-proxy` | `ops-e1a.workers.dev` |
| KV Namespace | `github-mcp-proxy-OAUTH` | `20cb14eff6cf4a9cbc7d0119018f0876` |

---

## Version history

| Version | Date | Changes |
|---|---|---|
| **v3.1** | 2026-04-05 | Add `POST /github-read-section` (lines N-M with context expansion) |
| **v3.0** | 2026-04-05 | CRLF normalization, >1MB file support, multi-patch array mode, `POST /github-search` |
| **v2.0** | 2026-04-05 | Add `POST /github-read`, `POST /github-patch`, `POST /github-append` |
| **v1.4** | 2026-04-05 | Restore correct OAuth flow after diagnostic test Worker mistake |
| **v1.3** | 2026-04-05 | Diagnostic test (mistake — reverted) |
| **v1.2** | 2026-04-05 | Fix PKCE code_challenge handling |
| **v1.1** | 2026-04-05 | Add `/.well-known/oauth-protected-resource` (RFC 9728) |
| **v1.0** | 2026-04-05 | Initial deployment — OAuth proxy for Claude.ai → githubcopilot.com/mcp/ |

---

## Architecture notes

- **Transport**: streamable-HTTP — no SSE, no `waitUntil` timeouts, no DO storage leak
- **No tool implementation**: all 80+ MCP tools proxied from official upstream, maintained by GitHub
- **Token storage**: `token:{accessToken}` → `{ github_pat, github_login }` in KV, 30-day TTL
- **Refresh tokens**: supported, rotate on use
- **PKCE**: S256 code challenge verification
- **Auth flexibility**: OAuth access tokens (Claude.ai flow) OR direct GitHub PAT (programmatic use)
- **Upstream**: `https://api.githubcopilot.com/mcp/` → `github/github-mcp-server` v0.32.0
