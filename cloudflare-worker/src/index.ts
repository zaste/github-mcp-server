/**
 * github-mcp-proxy v2.0
 *
 * OAuth proxy: Claude.ai web <-> api.githubcopilot.com/mcp/ (80+ tools)
 *
 * NEW in v2.0 — Document editing endpoints (bypass MCP transport limits):
 *   POST /github-read    — read file as plain UTF-8 text
 *   POST /github-patch   — str_replace with strict uniqueness validation
 *   POST /github-append  — append content to end of file
 *
 * Auth for /github-* endpoints:
 *   Authorization: Bearer <oauth_access_token>    (from OAuth flow, via KV)
 *   Authorization: Bearer ghp_... | github_pat_... (direct GitHub PAT)
 */

export interface Env {
  OAUTH_KV: KVNamespace;
  WORKER_URL: string;
}

// ─── UTF-8 aware base64 (btoa/atob are Latin-1 only) ────────────────────────

/** Decode base64 -> UTF-8. Strips GitHub's 60-char line wrapping first. */
function b64d(b64: string): string {
  const bin = atob(b64.replace(/\n/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

/** Encode UTF-8 string -> base64. Processes in 8KB chunks (avoids call-stack overflow). */
function b64e(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const K = 8192;
  for (let i = 0; i < bytes.length; i += K)
    bin += String.fromCharCode(...bytes.subarray(i, i + K));
  return btoa(bin);
}

// ─── Auth ────────────────────────────────────────────────────────────────────

interface TokenData { github_pat: string; github_login?: string; client_id?: string; }

/**
 * Resolves Bearer token -> {github_pat}.
 * Accepts OAuth access_token (KV lookup) OR direct GitHub PAT (ghp_* / github_pat_*).
 */
async function resolveAuth(req: Request, env: Env): Promise<TokenData | null> {
  const ah = req.headers.get('Authorization');
  if (!ah || !ah.startsWith('Bearer ')) return null;
  const tok = ah.slice(7).trim();
  if (tok.startsWith('ghp_') || tok.startsWith('github_pat_')) return { github_pat: tok };
  return await env.OAUTH_KV.get(`token:${tok}`, 'json') as TokenData | null;
}

/** Standard GitHub REST API request headers. */
function ghH(pat: string): Record<string, string> {
  return {
    Authorization: `Bearer ${pat}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'github-mcp-proxy/1.0',
    'Content-Type': 'application/json',
  };
}

// ─── Diagnostics helpers ──────────────────────────────────────────────────────

/** Returns 1-based {line, col} of index in string. */
function lineCol(str: string, idx: number): { line: number; col: number } {
  const lines = str.substring(0, idx).split('\n');
  return { line: lines.length, col: lines[lines.length - 1].length + 1 };
}

/** Context window around a match (with ellipsis if truncated). */
function surroundCtx(str: string, idx: number, len: number, n = 80): string {
  const s = Math.max(0, idx - n), e = Math.min(str.length, idx + len + n);
  return (s > 0 ? '\u2026' : '') + str.substring(s, e) + (e < str.length ? '\u2026' : '');
}

// ─── OAuth helpers ────────────────────────────────────────────────────────────

function rnd(n: number): string {
  const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return Array.from(a).map(b => c[b % c.length]).join('');
}

async function h256(p: string): Promise<string> {
  const d = new TextEncoder().encode(p);
  const h = await crypto.subtle.digest('SHA-256', d);
  return btoa(String.fromCharCode(...new Uint8Array(h)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// ─── Response helpers ─────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, mcp-session-id, mcp-protocol-version',
};

const j = (body: unknown, status = 200, extra?: Record<string, string>) =>
  Response.json(body, { status, headers: extra ? { ...CORS, ...extra } : CORS });

// ═════════════════════════════════════════════════════════════════════════════
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    console.log(`${req.method} ${p}`);

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    // ── OAuth: Resource Server Metadata (RFC 9728) ────────────────────────────
    if (p.startsWith('/.well-known/oauth-protected-resource'))
      return j({ resource: `${env.WORKER_URL}/mcp`, authorization_servers: [env.WORKER_URL], bearer_methods_supported: ['header'] });

    // ── OAuth: Authorization Server Metadata ──────────────────────────────────
    if (p === '/.well-known/oauth-authorization-server')
      return j({
        issuer: env.WORKER_URL,
        authorization_endpoint: `${env.WORKER_URL}/oauth/authorize`,
        token_endpoint: `${env.WORKER_URL}/oauth/token`,
        registration_endpoint: `${env.WORKER_URL}/oauth/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
        scopes_supported: ['repo', 'read:org', 'notifications', 'workflow'],
      });

    // ── OAuth: Dynamic Client Registration ────────────────────────────────────
    if (p === '/oauth/register' && req.method === 'POST') {
      const b = await req.json() as Record<string, unknown>;
      const ci = rnd(16), cs = rnd(32), now = Math.floor(Date.now() / 1000);
      const c = {
        client_id: ci, client_secret: cs,
        redirect_uris: (b.redirect_uris as string[]) || [],
        client_name: (b.client_name as string) || 'Claude',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
        client_id_issued_at: now, client_secret_expires_at: 0,
        scope: 'repo read:org notifications workflow',
      };
      await env.OAUTH_KV.put(`client:${ci}`, JSON.stringify(c), { expirationTtl: 31536000 });
      console.log(`registered client=${ci}`);
      return j({ ...c, registration_access_token: rnd(32) }, 201);
    }

    // ── OAuth: Authorization GET — PAT input form ─────────────────────────────
    if (p === '/oauth/authorize' && req.method === 'GET') {
      const ci = url.searchParams.get('client_id') || '';
      const ru = url.searchParams.get('redirect_uri') || '';
      const st = url.searchParams.get('state') || '';
      const cc = url.searchParams.get('code_challenge') || '';
      const cm = url.searchParams.get('code_challenge_method') || 'S256';
      if (!ci || !ru) return new Response('Missing client_id or redirect_uri', { status: 400 });
      const cl = await env.OAUTH_KV.get(`client:${ci}`, 'json');
      if (!cl) return new Response(`Unknown client_id: ${ci}`, { status: 400 });
      const html = [
        '<!DOCTYPE html><html lang=en><head><meta charset=UTF-8>',
        '<meta name=viewport content="width=device-width,initial-scale=1">',
        '<title>Connect GitHub to Claude</title>',
        '<style>*{box-sizing:border-box;margin:0;padding:0}',
        'body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#f6f8fa;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}',
        '.card{background:#fff;border:1px solid #d0d7de;border-radius:12px;padding:2rem;width:100%;max-width:440px}',
        'h1{font-size:1.25rem;color:#24292f;margin:.5rem 0 .5rem}',
        'p{font-size:.875rem;color:#57606a;line-height:1.5;margin-bottom:1rem}',
        'code{background:#f6f8fa;padding:.1em .3em;border-radius:4px;font-size:.85em}',
        'label{display:block;font-size:.875rem;font-weight:600;color:#24292f;margin-bottom:.375rem}',
        'input[type=password]{width:100%;padding:.5rem .75rem;border:1px solid #d0d7de;border-radius:6px;font-size:.875rem;font-family:monospace;outline:none}',
        'input[type=password]:focus{border-color:#0969da;box-shadow:0 0 0 3px rgba(9,105,218,.15)}',
        '.hint{font-size:.75rem;color:#57606a;margin:.375rem 0 1.25rem}',
        '.hint a{color:#0969da;text-decoration:none}',
        'button{width:100%;padding:.625rem;background:#1f883d;color:#fff;border:none;border-radius:6px;font-size:.9375rem;font-weight:600;cursor:pointer}',
        'button:hover{background:#1a7f37}',
        '</style></head><body><div class=card>',
        '<div style="font-size:2.5rem;margin-bottom:.75rem">&#x26A1;</div>',
        '<h1>Connect GitHub to Claude</h1>',
        '<p>Enter your GitHub Personal Access Token.<br>Required: <code>repo</code>, <code>read:org</code>, <code>notifications</code>.</p>',
        '<form method=POST action=/oauth/authorize>',
        `<input type=hidden name=client_id value="${ci}">`,
        `<input type=hidden name=redirect_uri value="${ru}">`,
        `<input type=hidden name=state value="${st}">`,
        `<input type=hidden name=code_challenge value="${cc}">`,
        `<input type=hidden name=code_challenge_method value="${cm}">`,
        '<label for=pat>Personal Access Token</label>',
        '<input type=password id=pat name=pat placeholder="github_pat_... or ghp_..." required autofocus>',
        '<p class=hint><a href=https://github.com/settings/personal-access-tokens/new target=_blank rel=noopener>',
        'Create a new fine-grained token</a> with required scopes.</p>',
        '<button type=submit>Authorize Claude &#x2192;</button></form>',
        '<p style="margin-top:1rem;font-size:.75rem;color:#57606a;text-align:center">',
        'Powered by <a href=https://github.com/github/github-mcp-server style=color:#0969da>',
        'github/github-mcp-server</a> &middot; 80+ tools</p>',
        '</div></body></html>',
      ].join('');
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    }

    // ── OAuth: Authorization POST — verify PAT, issue code ────────────────────
    if (p === '/oauth/authorize' && req.method === 'POST') {
      const form = await req.formData();
      const ci = String(form.get('client_id') || '');
      const ru = String(form.get('redirect_uri') || '');
      const st = String(form.get('state') || '');
      const cc = String(form.get('code_challenge') || '');
      const cm = String(form.get('code_challenge_method') || 'S256');
      const pat = String(form.get('pat') || '').trim();
      if (!pat) return new Response('Missing token', { status: 400 });
      const vr = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${pat}`, 'User-Agent': 'github-mcp-proxy/1.0', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      });
      if (!vr.ok) {
        console.log(`PAT rejected status=${vr.status}`);
        return new Response(`Invalid GitHub token (status ${vr.status}). Check PAT scopes.`, { status: 400, headers: { 'Content-Type': 'text/plain' } });
      }
      const u = await vr.json() as { login: string };
      const code = rnd(40);
      await env.OAUTH_KV.put(`auth_code:${code}`, JSON.stringify({
        client_id: ci, code_challenge: cc, code_challenge_method: cm,
        github_pat: pat, github_login: u.login, created_at: Date.now(),
      }), { expirationTtl: 300 });
      console.log(`code issued for login=${u.login}`);
      const r = new URL(ru);
      r.searchParams.set('code', code);
      if (st) r.searchParams.set('state', st);
      return Response.redirect(r.toString(), 302);
    }

    // ── OAuth: Token endpoint ──────────────────────────────────────────────────
    if (p === '/oauth/token' && req.method === 'POST') {
      const ct = req.headers.get('content-type') || '';
      let b: Record<string, string>;
      if (ct.includes('application/json')) { b = await req.json() as Record<string, string>; }
      else { const fd = await req.formData(); b = Object.fromEntries([...fd.entries()].map(([k, v]) => [k, String(v)])); }
      const { grant_type, code, code_verifier, refresh_token } = b;
      if (grant_type === 'refresh_token' && refresh_token) {
        const et = await env.OAUTH_KV.get(`refresh:${refresh_token}`);
        if (!et) return j({ error: 'invalid_grant' }, 400);
        const td = await env.OAUTH_KV.get(`token:${et}`, 'json') as Record<string, unknown> | null;
        if (!td) return j({ error: 'invalid_grant' }, 400);
        const nt = rnd(48), nr = rnd(48);
        await env.OAUTH_KV.put(`token:${nt}`, JSON.stringify({ ...td, refresh_token: nr, created_at: Date.now() }), { expirationTtl: 2592000 });
        await env.OAUTH_KV.put(`refresh:${nr}`, nt, { expirationTtl: 2592000 });
        await env.OAUTH_KV.delete(`token:${et}`);
        await env.OAUTH_KV.delete(`refresh:${refresh_token}`);
        return j({ access_token: nt, token_type: 'Bearer', expires_in: 28800, refresh_token: nr, scope: 'repo read:org notifications workflow' });
      }
      if (!code) return j({ error: 'invalid_request' }, 400);
      const s = await env.OAUTH_KV.get(`auth_code:${code}`, 'json') as Record<string, string> | null;
      if (!s) return j({ error: 'invalid_grant', error_description: 'Code expired or already used' }, 400);
      if (s.code_challenge && code_verifier) {
        const c = await h256(code_verifier);
        if (c !== s.code_challenge) return j({ error: 'invalid_grant', error_description: 'PKCE failed' }, 400);
      }
      await env.OAUTH_KV.delete(`auth_code:${code}`);
      const at = rnd(48), nrt = rnd(48);
      await env.OAUTH_KV.put(`token:${at}`, JSON.stringify({
        client_id: s.client_id, github_pat: s.github_pat, github_login: s.github_login,
        refresh_token: nrt, created_at: Date.now(),
      }), { expirationTtl: 2592000 });
      await env.OAUTH_KV.put(`refresh:${nrt}`, at, { expirationTtl: 2592000 });
      console.log(`token issued for ${s.github_login}`);
      return j({ access_token: at, token_type: 'Bearer', expires_in: 28800, refresh_token: nrt, scope: 'repo read:org notifications workflow' });
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Document editing endpoints — bypass MCP transport size limits
    // ═════════════════════════════════════════════════════════════════════════

    if ((p === '/github-read' || p === '/github-patch' || p === '/github-append') && req.method === 'POST') {

      // Accepts OAuth access_token OR direct GitHub PAT
      const td = await resolveAuth(req, env);
      if (!td) return j({ error: 'unauthorized', error_description: 'Bearer token required (OAuth access_token or GitHub PAT)' }, 401);

      const body = await req.json() as Record<string, string>;
      const { owner, repo, branch } = body;
      const filePath = body.path;

      if (!owner || !repo || !filePath)
        return j({ error: 'invalid_request', error_description: 'Required: owner, repo, path' }, 400);

      // Fetch current file from GitHub API
      const ref = branch ? `?ref=${encodeURIComponent(branch)}` : '';
      const fileRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${filePath}${ref}`, { headers: ghH(td.github_pat) });

      if (!fileRes.ok) {
        const eb = await fileRes.json().catch(() => ({ message: 'Failed to fetch file' })) as { message: string };
        return j({ error: 'github_error', status: fileRes.status, message: eb.message, owner, repo, path: filePath }, fileRes.status);
      }

      const fd = await fileRes.json() as { content: string; sha: string; size: number; path: string; name: string; html_url: string };
      if (Array.isArray(fd)) return j({ error: 'invalid_request', error_description: `${filePath} is a directory, not a file` }, 422);
      if (!fd.content) return j({ error: 'invalid_request', error_description: 'File appears to be binary or empty' }, 422);

      const current = b64d(fd.content);
      const sha = fd.sha;

      // ── /github-read — return file as plain UTF-8 text ─────────────────────
      if (p === '/github-read') {
        console.log(`github-read ${owner}/${repo}/${filePath} size=${current.length}`);
        return j({ content: current, sha, size: fd.size, path: fd.path, name: fd.name, html_url: fd.html_url, lines: current.split('\n').length, chars: current.length });
      }

      // ── /github-patch — str_replace with strict uniqueness validation ───────
      if (p === '/github-patch') {
        const { old_str, new_str } = body;
        const commitMsg = body.message;
        if (old_str === undefined || old_str === null) return j({ error: 'invalid_request', error_description: 'Required: old_str' }, 400);
        if (new_str === undefined || new_str === null) return j({ error: 'invalid_request', error_description: 'Required: new_str' }, 400);
        if (old_str === '') return j({ error: 'invalid_request', error_description: 'old_str cannot be empty — use /github-append for end-of-file insertions' }, 400);

        // Find ALL occurrences (need count to validate uniqueness)
        const occ: Array<{ idx: number; line: number; col: number; context: string }> = [];
        let si = 0;
        while (true) {
          const fi = current.indexOf(old_str, si);
          if (fi === -1) break;
          const pos = lineCol(current, fi);
          occ.push({ idx: fi, line: pos.line, col: pos.col, context: surroundCtx(current, fi, old_str.length) });
          si = fi + old_str.length;
        }

        if (occ.length === 0)
          return j({
            error: 'not_found',
            error_description: 'old_str not found in file — check whitespace, line endings, and encoding',
            file: { path: filePath, chars: current.length, lines: current.split('\n').length },
            hint: 'Use /github-read to inspect exact current content',
          }, 422);

        if (occ.length > 1)
          return j({
            error: 'ambiguous',
            error_description: `old_str found ${occ.length} times — must match exactly once for a safe replace`,
            count: occ.length,
            occurrences: occ.map(o => ({ line: o.line, col: o.col, context: o.context })),
            hint: 'Add more surrounding context to old_str to make it unique',
          }, 422);

        const m = occ[0];
        const newContent = current.substring(0, m.idx) + new_str + current.substring(m.idx + old_str.length);
        const cm = commitMsg || `docs: patch ${filePath.split('/').pop()}`;
        const putBody = { message: cm, content: b64e(newContent), sha, ...(branch ? { branch } : {}) };

        const pr = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`, {
          method: 'PUT', headers: ghH(td.github_pat), body: JSON.stringify(putBody),
        });
        if (!pr.ok) {
          const eb = await pr.json().catch(() => ({ message: 'Failed to update file' })) as { message: string };
          if (pr.status === 409 || pr.status === 422)
            return j({ error: 'conflict', status: pr.status, message: eb.message, error_description: 'File was modified concurrently — re-read with /github-read and retry' }, pr.status);
          return j({ error: 'github_error', status: pr.status, message: eb.message }, pr.status);
        }
        const pd = await pr.json() as { content: { sha: string }; commit: { sha: string; html_url: string } };
        console.log(`github-patch ${owner}/${repo}/${filePath} at line=${m.line} commit=${pd.commit.sha.slice(0, 8)}`);
        return j({
          success: true, path: filePath,
          sha_before: sha, sha_after: pd.content.sha,
          commit: pd.commit.sha, commit_url: pd.commit.html_url,
          replaced_at: { line: m.line, col: m.col },
          chars_before: current.length, chars_after: newContent.length,
          delta: newContent.length - current.length,
          lines_before: current.split('\n').length, lines_after: newContent.split('\n').length,
        });
      }

      // ── /github-append — append content to end of file ─────────────────────
      if (p === '/github-append') {
        const ac = body.content;
        const commitMsg = body.message;
        const separator = body.separator;
        if (!ac) return j({ error: 'invalid_request', error_description: 'Required: content' }, 400);
        const sep = separator !== undefined ? separator : (current.endsWith('\n') ? '' : '\n');
        const newContent = current + sep + ac;
        const cm = commitMsg || `docs: append to ${filePath.split('/').pop()}`;
        const putBody = { message: cm, content: b64e(newContent), sha, ...(branch ? { branch } : {}) };
        const pr = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`, {
          method: 'PUT', headers: ghH(td.github_pat), body: JSON.stringify(putBody),
        });
        if (!pr.ok) {
          const eb = await pr.json().catch(() => ({ message: 'Failed to update file' })) as { message: string };
          return j({ error: 'github_error', status: pr.status, message: eb.message }, pr.status);
        }
        const pd = await pr.json() as { content: { sha: string }; commit: { sha: string; html_url: string } };
        console.log(`github-append ${owner}/${repo}/${filePath} +${ac.length}chars commit=${pd.commit.sha.slice(0, 8)}`);
        return j({
          success: true, path: filePath,
          sha_before: sha, sha_after: pd.content.sha,
          commit: pd.commit.sha, commit_url: pd.commit.html_url,
          chars_added: ac.length + sep.length,
          chars_before: current.length, chars_after: newContent.length,
        });
      }
    }

    // ── MCP proxy -> api.githubcopilot.com/mcp/ ───────────────────────────────
    if (p === '/mcp' || p.startsWith('/mcp/')) {
      const ah = req.headers.get('Authorization');
      if (!ah || !ah.startsWith('Bearer ')) return j({ error: 'unauthorized' }, 401);
      const tok = ah.slice(7);
      const td = await env.OAUTH_KV.get(`token:${tok}`, 'json') as TokenData | null;
      if (!td) return j({ error: 'unauthorized', error_description: 'Token not found or expired' }, 401);
      const ph = new Headers();
      for (const [k, v] of req.headers.entries())
        if (['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'accept-encoding'].includes(k.toLowerCase()))
          ph.set(k, v);
      ph.set('Authorization', `Bearer ${td.github_pat}`);
      ph.set('User-Agent', 'github-mcp-proxy/1.0');
      const up = await fetch('https://api.githubcopilot.com/mcp/', {
        method: req.method, headers: ph,
        body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
      });
      console.log(`proxy for=${td.github_login || 'unknown'} ${req.method} upstream=${up.status}`);
      const rh = new Headers(up.headers);
      Object.entries(CORS).forEach(([k, v]) => rh.set(k, v));
      return new Response(up.body, { status: up.status, statusText: up.statusText, headers: rh });
    }

    // ── Root ──────────────────────────────────────────────────────────────────
    if (p === '/' || p === '')
      return j({
        name: 'github-mcp-proxy', version: '2.0.0',
        mcp: `${env.WORKER_URL}/mcp`,
        oauth: `${env.WORKER_URL}/.well-known/oauth-authorization-server`,
        resource_metadata: `${env.WORKER_URL}/.well-known/oauth-protected-resource`,
        upstream: 'https://api.githubcopilot.com/mcp/', tools: '80+',
        editing: {
          'POST /github-read': 'Read file as UTF-8 text — no base64 overhead',
          'POST /github-patch': 'str_replace — strict uniqueness, position diagnostics, conflict detection',
          'POST /github-append': 'Append to end of file with smart separator',
          auth: 'Bearer <oauth_access_token | github_pat_* | ghp_*>',
        },
      });

    return new Response('Not found', { status: 404, headers: CORS });
  },
};
