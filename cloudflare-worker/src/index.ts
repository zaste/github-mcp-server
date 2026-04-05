/**
 * github-mcp-proxy v3.1
 *
 * OAuth proxy: Claude.ai web <-> api.githubcopilot.com/mcp/ (80+ tools)
 *
 * Document editing endpoints (bypass MCP transport size limits):
 *   POST /github-read         — read file as plain UTF-8 text (handles >1MB)
 *   POST /github-read-section — read lines N-M with optional context expansion
 *   POST /github-patch        — str_replace: CRLF-safe, multi-patch, conflict detection
 *   POST /github-append       — append content to end of file
 *   POST /github-search       — search within file with context lines
 *
 * v3.1 over v3.0:
 *   + POST /github-read-section: read lines start_line..end_line with context_lines
 *     expansion. Returns sha directly usable in /github-patch. Solves context
 *     window overflow for large documents — read only the section you need.
 *
 * Auth for /github-* endpoints:
 *   Authorization: Bearer <oauth_access_token>     (from OAuth flow, via KV)
 *   Authorization: Bearer ghp_... | github_pat_... (direct GitHub PAT)
 */

export interface Env {
  OAUTH_KV: KVNamespace;
  WORKER_URL: string;
}

// ── UTF-8 safe base64 ────────────────────────────────────────────────────────

/** Decode base64 → UTF-8. Strips GitHub's 60-char line wrapping. */
function b64d(b64: string): string {
  const bin = atob(b64.replace(/\n/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

/** Encode UTF-8 string → base64. 8KB chunks (avoids call-stack overflow). */
function b64e(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const K = 8192;
  for (let i = 0; i < bytes.length; i += K)
    bin += String.fromCharCode(...bytes.subarray(i, i + K));
  return btoa(bin);
}

// ── Auth ─────────────────────────────────────────────────────────────────────

interface TokenData { github_pat: string; github_login?: string; client_id?: string; }

/** Resolves Bearer token → {github_pat}. Accepts OAuth token or direct GitHub PAT. */
async function resolveAuth(req: Request, env: Env): Promise<TokenData | null> {
  const ah = req.headers.get('Authorization');
  if (!ah || !ah.startsWith('Bearer ')) return null;
  const tok = ah.slice(7).trim();
  if (tok.startsWith('ghp_') || tok.startsWith('github_pat_')) return { github_pat: tok };
  return await env.OAUTH_KV.get(`token:${tok}`, 'json') as TokenData | null;
}

/** Standard GitHub REST API headers. */
function ghH(pat: string): Record<string, string> {
  return {
    Authorization: `Bearer ${pat}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'github-mcp-proxy/1.0',
    'Content-Type': 'application/json',
  };
}

// ── Content fetching ─ handles <1MB (inline base64) and >1MB (download_url) ──

interface GitHubFileData {
  content: string; sha: string; size: number;
  path: string; name: string; html_url: string; download_url: string | null;
}

/**
 * Fetch file content as UTF-8 string.
 * GitHub returns base64 inline for files ≤1MB; for >1MB, content="" + download_url.
 */
async function fetchContent(fd: GitHubFileData, pat: string): Promise<string> {
  if (fd.content) return b64d(fd.content);
  if (fd.download_url) {
    const r = await fetch(fd.download_url, {
      headers: { Authorization: `Bearer ${pat}`, 'User-Agent': 'github-mcp-proxy/1.0' },
    });
    if (!r.ok) throw new Error(`Failed to fetch large file (>1MB): HTTP ${r.status}`);
    return await r.text();
  }
  throw new Error('File appears to be binary (no inline content or download_url)');
}

// ── CRLF normalization ───────────────────────────────────────────────────────

/** Normalize \r\n → \n for consistent matching. Markdown files should use LF. */
function normCRLF(str: string): { content: string; wasCRLF: boolean } {
  const wasCRLF = str.includes('\r\n');
  return { content: wasCRLF ? str.replace(/\r\n/g, '\n') : str, wasCRLF };
}

// ── Patch helpers ────────────────────────────────────────────────────────────

function lineCol(str: string, idx: number): { line: number; col: number } {
  const lines = str.substring(0, idx).split('\n');
  return { line: lines.length, col: lines[lines.length - 1].length + 1 };
}

function surCtx(str: string, idx: number, len: number, n = 80): string {
  const s = Math.max(0, idx - n), e = Math.min(str.length, idx + len + n);
  return (s > 0 ? '\u2026' : '') + str.substring(s, e) + (e < str.length ? '\u2026' : '');
}

interface Patch { old_str: string; new_str: string; }
interface PatchResult { patch_index: number; replaced_at: { line: number; col: number }; delta: number; }

/**
 * Validate and apply patches sequentially.
 * Each patch is validated against content AFTER previous patches.
 * Aborts entirely on any failure — no partial writes.
 */
function applyPatches(content: string, patches: Patch[]): { newContent: string; results: PatchResult[] } {
  let cur = content;
  const results: PatchResult[] = [];
  for (let i = 0; i < patches.length; i++) {
    const { old_str, new_str } = patches[i];
    if (!old_str) throw { patchIndex: i, error: 'invalid_request', error_description: `patch[${i}].old_str cannot be empty` };
    if (new_str === undefined || new_str === null) throw { patchIndex: i, error: 'invalid_request', error_description: `patch[${i}].new_str is required` };
    const occ: Array<{ idx: number; line: number; col: number; context: string }> = [];
    let si = 0;
    while (true) {
      const fi = cur.indexOf(old_str, si);
      if (fi === -1) break;
      const pos = lineCol(cur, fi);
      occ.push({ idx: fi, line: pos.line, col: pos.col, context: surCtx(cur, fi, old_str.length) });
      si = fi + old_str.length;
    }
    if (occ.length === 0)
      throw { patchIndex: i, error: 'not_found', error_description: `patch[${i}].old_str not found (after ${i} previous patches)`, hint: 'Use /github-read to inspect current content' };
    if (occ.length > 1)
      throw { patchIndex: i, error: 'ambiguous', error_description: `patch[${i}].old_str found ${occ.length} times — must be unique`, count: occ.length, occurrences: occ.map(o => ({ line: o.line, col: o.col, context: o.context })), hint: 'Add more surrounding context to make it unique' };
    const m = occ[0];
    cur = cur.substring(0, m.idx) + new_str + cur.substring(m.idx + old_str.length);
    results.push({ patch_index: i, replaced_at: { line: m.line, col: m.col }, delta: new_str.length - old_str.length });
  }
  return { newContent: cur, results };
}

// ── Response helpers ─────────────────────────────────────────────────────────

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

    // OAuth metadata
    if (p.startsWith('/.well-known/oauth-protected-resource'))
      return j({ resource: `${env.WORKER_URL}/mcp`, authorization_servers: [env.WORKER_URL], bearer_methods_supported: ['header'] });

    if (p === '/.well-known/oauth-authorization-server')
      return j({ issuer: env.WORKER_URL, authorization_endpoint: `${env.WORKER_URL}/oauth/authorize`, token_endpoint: `${env.WORKER_URL}/oauth/token`, registration_endpoint: `${env.WORKER_URL}/oauth/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_post', 'none'], scopes_supported: ['repo', 'read:org', 'notifications', 'workflow'] });

    // Client registration
    if (p === '/oauth/register' && req.method === 'POST') {
      const b = await req.json() as Record<string, unknown>;
      const ci = rnd(16), cs = rnd(32), now = Math.floor(Date.now() / 1000);
      const c = { client_id: ci, client_secret: cs, redirect_uris: (b.redirect_uris as string[]) || [], client_name: (b.client_name as string) || 'Claude', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'client_secret_post', client_id_issued_at: now, client_secret_expires_at: 0, scope: 'repo read:org notifications workflow' };
      await env.OAUTH_KV.put(`client:${ci}`, JSON.stringify(c), { expirationTtl: 31536000 });
      console.log(`registered client=${ci}`);
      return j({ ...c, registration_access_token: rnd(32) }, 201);
    }

    // Authorization form
    if (p === '/oauth/authorize' && req.method === 'GET') {
      const ci = url.searchParams.get('client_id') || '', ru = url.searchParams.get('redirect_uri') || '', st = url.searchParams.get('state') || '', cc = url.searchParams.get('code_challenge') || '', cm = url.searchParams.get('code_challenge_method') || 'S256';
      if (!ci || !ru) return new Response('Missing client_id or redirect_uri', { status: 400 });
      const cl = await env.OAUTH_KV.get(`client:${ci}`, 'json');
      if (!cl) return new Response(`Unknown client_id: ${ci}`, { status: 400 });
      const html = ['<!DOCTYPE html><html lang=en><head><meta charset=UTF-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Connect GitHub</title>', '<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#f6f8fa;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}.card{background:#fff;border:1px solid #d0d7de;border-radius:12px;padding:2rem;width:100%;max-width:440px}h1{font-size:1.25rem;color:#24292f;margin:.5rem 0 .5rem}p{font-size:.875rem;color:#57606a;line-height:1.5;margin-bottom:1rem}code{background:#f6f8fa;padding:.1em .3em;border-radius:4px;font-size:.85em}label{display:block;font-size:.875rem;font-weight:600;color:#24292f;margin-bottom:.375rem}input[type=password]{width:100%;padding:.5rem .75rem;border:1px solid #d0d7de;border-radius:6px;font-size:.875rem;font-family:monospace;outline:none}input[type=password]:focus{border-color:#0969da;box-shadow:0 0 0 3px rgba(9,105,218,.15)}.hint{font-size:.75rem;color:#57606a;margin:.375rem 0 1.25rem}.hint a{color:#0969da;text-decoration:none}button{width:100%;padding:.625rem;background:#1f883d;color:#fff;border:none;border-radius:6px;font-size:.9375rem;font-weight:600;cursor:pointer}button:hover{background:#1a7f37}</style></head>', `<body><div class=card><div style="font-size:2.5rem;margin-bottom:.75rem">&#x26A1;</div><h1>Connect GitHub to Claude</h1><p>Enter your GitHub PAT.<br>Required: <code>repo</code>, <code>read:org</code>, <code>notifications</code>.</p><form method=POST action=/oauth/authorize><input type=hidden name=client_id value="${ci}"><input type=hidden name=redirect_uri value="${ru}"><input type=hidden name=state value="${st}"><input type=hidden name=code_challenge value="${cc}"><input type=hidden name=code_challenge_method value="${cm}"><label for=pat>Personal Access Token</label><input type=password id=pat name=pat placeholder="github_pat_... or ghp_..." required autofocus><p class=hint><a href=https://github.com/settings/personal-access-tokens/new target=_blank rel=noopener>Create a fine-grained token</a> with required scopes.</p><button type=submit>Authorize Claude &#x2192;</button></form><p style="margin-top:1rem;font-size:.75rem;color:#57606a;text-align:center">Powered by <a href=https://github.com/github/github-mcp-server style=color:#0969da>github/github-mcp-server</a> &middot; 80+ tools</p></div></body></html>`].join('');
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    }

    // Authorization POST
    if (p === '/oauth/authorize' && req.method === 'POST') {
      const form = await req.formData();
      const ci = String(form.get('client_id') || ''), ru = String(form.get('redirect_uri') || ''), st = String(form.get('state') || ''), cc = String(form.get('code_challenge') || ''), cm = String(form.get('code_challenge_method') || 'S256'), pat = String(form.get('pat') || '').trim();
      if (!pat) return new Response('Missing token', { status: 400 });
      const vr = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${pat}`, 'User-Agent': 'github-mcp-proxy/1.0', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
      if (!vr.ok) { console.log(`PAT rejected status=${vr.status}`); return new Response(`Invalid GitHub token (${vr.status}). Check PAT scopes.`, { status: 400, headers: { 'Content-Type': 'text/plain' } }); }
      const u = await vr.json() as { login: string };
      const code = rnd(40);
      await env.OAUTH_KV.put(`auth_code:${code}`, JSON.stringify({ client_id: ci, code_challenge: cc, code_challenge_method: cm, github_pat: pat, github_login: u.login, created_at: Date.now() }), { expirationTtl: 300 });
      console.log(`code issued for login=${u.login}`);
      const r = new URL(ru); r.searchParams.set('code', code); if (st) r.searchParams.set('state', st);
      return Response.redirect(r.toString(), 302);
    }

    // Token endpoint
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
        await env.OAUTH_KV.delete(`token:${et}`); await env.OAUTH_KV.delete(`refresh:${refresh_token}`);
        return j({ access_token: nt, token_type: 'Bearer', expires_in: 28800, refresh_token: nr, scope: 'repo read:org notifications workflow' });
      }
      if (!code) return j({ error: 'invalid_request' }, 400);
      const s = await env.OAUTH_KV.get(`auth_code:${code}`, 'json') as Record<string, string> | null;
      if (!s) return j({ error: 'invalid_grant', error_description: 'Code expired or already used' }, 400);
      if (s.code_challenge && code_verifier) { const c = await h256(code_verifier); if (c !== s.code_challenge) return j({ error: 'invalid_grant', error_description: 'PKCE failed' }, 400); }
      await env.OAUTH_KV.delete(`auth_code:${code}`);
      const at = rnd(48), nrt = rnd(48);
      await env.OAUTH_KV.put(`token:${at}`, JSON.stringify({ client_id: s.client_id, github_pat: s.github_pat, github_login: s.github_login, refresh_token: nrt, created_at: Date.now() }), { expirationTtl: 2592000 });
      await env.OAUTH_KV.put(`refresh:${nrt}`, at, { expirationTtl: 2592000 });
      console.log(`token issued for ${s.github_login}`);
      return j({ access_token: at, token_type: 'Bearer', expires_in: 28800, refresh_token: nrt, scope: 'repo read:org notifications workflow' });
    }

    // ── Document editing endpoints ────────────────────────────────────────────
    if ((p === '/github-read' || p === '/github-read-section' || p === '/github-patch' || p === '/github-append' || p === '/github-search') && req.method === 'POST') {

      const td = await resolveAuth(req, env);
      if (!td) return j({ error: 'unauthorized', error_description: 'Bearer token required (OAuth access_token or GitHub PAT)' }, 401);

      const body = await req.json() as Record<string, unknown>;
      const { owner, repo, branch } = body as { owner: string; repo: string; branch?: string };
      const filePath = body.path as string;
      if (!owner || !repo || !filePath) return j({ error: 'invalid_request', error_description: 'Required: owner, repo, path' }, 400);

      const ref = branch ? `?ref=${encodeURIComponent(branch)}` : '';
      const fileRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${filePath}${ref}`, { headers: ghH(td.github_pat) });
      if (!fileRes.ok) {
        const eb = await fileRes.json().catch(() => ({ message: 'Failed to fetch file' })) as { message: string };
        return j({ error: 'github_error', status: fileRes.status, message: eb.message, owner, repo, path: filePath }, fileRes.status);
      }
      const fd = await fileRes.json() as GitHubFileData;
      if (Array.isArray(fd)) return j({ error: 'invalid_request', error_description: `${filePath} is a directory, not a file` }, 422);

      let rawContent: string;
      try { rawContent = await fetchContent(fd, td.github_pat); }
      catch (e) { return j({ error: 'invalid_request', error_description: (e as Error).message, size_bytes: fd.size, is_large_file: fd.size > 1048576 }, 422); }

      const sha = fd.sha;
      const isLarge = fd.size > 1048576;

      // /github-read — full file as plain text
      if (p === '/github-read') {
        console.log(`github-read ${owner}/${repo}/${filePath} size=${rawContent.length}${isLarge ? ' (large-file)' : ''}`);
        return j({ content: rawContent, sha, size: fd.size, path: fd.path, name: fd.name, html_url: fd.html_url, lines: rawContent.split('\n').length, chars: rawContent.length, is_large_file: isLarge });
      }

      // /github-read-section — read lines start_line..end_line with context expansion
      if (p === '/github-read-section') {
        const { content: norm } = normCRLF(rawContent);
        const lines = norm.split('\n');
        const total = lines.length;
        const sl = Math.max(1, parseInt(String(body.start_line ?? 1)));
        const el = body.end_line != null ? Math.min(total, parseInt(String(body.end_line))) : total;
        const cx = Math.min(Math.max(parseInt(String(body.context_lines ?? 0)), 0), 50);
        if (sl > total) return j({ error: 'invalid_request', error_description: `start_line (${sl}) exceeds file length (${total} lines)`, total_lines: total }, 422);
        if (sl > el) return j({ error: 'invalid_request', error_description: `start_line (${sl}) must be ≤ end_line (${el})` }, 422);
        const as = Math.max(1, sl - cx);
        const ae = Math.min(total, el + cx);
        const section = lines.slice(as - 1, ae).join('\n');
        console.log(`github-read-section ${owner}/${repo}/${filePath} lines=${as}-${ae} of ${total}`);
        return j({ content: section, sha, size: fd.size, path: fd.path, name: fd.name, html_url: fd.html_url, start_line: as, end_line: ae, requested_start: sl, requested_end: el, context_lines: cx, total_lines: total, section_lines: ae - as + 1, section_chars: section.length, is_large_file: isLarge });
      }

      // /github-patch — str_replace, CRLF-safe, single and multi-patch
      if (p === '/github-patch') {
        const { wasCRLF, content: current } = normCRLF(rawContent);
        let patches: Patch[];
        if (Array.isArray((body as Record<string, unknown>).patches)) {
          patches = ((body as Record<string, unknown>).patches as Array<Record<string, string>>).map(pt => ({ old_str: pt.old_str, new_str: pt.new_str }));
          if (patches.length === 0) return j({ error: 'invalid_request', error_description: 'patches array cannot be empty' }, 400);
        } else {
          const { old_str, new_str } = body as { old_str?: string; new_str?: string };
          if (old_str === undefined || old_str === null) return j({ error: 'invalid_request', error_description: 'Required: old_str (or patches array)' }, 400);
          if (new_str === undefined || new_str === null) return j({ error: 'invalid_request', error_description: 'Required: new_str' }, 400);
          if (old_str === '') return j({ error: 'invalid_request', error_description: 'old_str cannot be empty — use /github-append for end-of-file insertions' }, 400);
          patches = [{ old_str, new_str }];
        }
        patches = patches.map(pt => ({ old_str: pt.old_str.replace(/\r\n/g, '\n'), new_str: pt.new_str }));
        let patchResult: { newContent: string; results: PatchResult[] };
        try { patchResult = applyPatches(current, patches); }
        catch (e) {
          if ((e as Record<string, unknown>).error) return j(e as Record<string, unknown>, 422);
          return j({ error: 'patch_failed', error_description: String(e) }, 500);
        }
        const { newContent, results } = patchResult;
        const commitMsg = (body.message as string) || (patches.length === 1 ? `docs: patch ${filePath.split('/').pop()}` : `docs: multi-patch ${filePath.split('/').pop()} (${patches.length} changes)`);
        const putBody = { message: commitMsg, content: b64e(newContent), sha, ...(branch ? { branch } : {}) };
        const pr = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`, { method: 'PUT', headers: ghH(td.github_pat), body: JSON.stringify(putBody) });
        if (!pr.ok) {
          const eb = await pr.json().catch(() => ({ message: 'Failed to update file' })) as { message: string };
          if (pr.status === 409 || pr.status === 422) return j({ error: 'conflict', status: pr.status, message: eb.message, error_description: 'File was modified concurrently — re-read with /github-read and retry' }, pr.status);
          return j({ error: 'github_error', status: pr.status, message: eb.message }, pr.status);
        }
        const pd = await pr.json() as { content: { sha: string }; commit: { sha: string; html_url: string } };
        console.log(`github-patch ${owner}/${repo}/${filePath} patches=${patches.length}${wasCRLF ? ' crlf-normalized' : ''} commit=${pd.commit.sha.slice(0, 8)}`);
        return j({ success: true, path: filePath, sha_before: sha, sha_after: pd.content.sha, commit: pd.commit.sha, commit_url: pd.commit.html_url, patches_applied: results, chars_before: rawContent.length, chars_after: newContent.length, total_delta: results.reduce((s, r) => s + r.delta, 0), crlf_normalized: wasCRLF });
      }

      // /github-append — append to end of file
      if (p === '/github-append') {
        const ac = body.content as string;
        if (!ac) return j({ error: 'invalid_request', error_description: 'Required: content' }, 400);
        const sep = body.separator !== undefined ? body.separator as string : (rawContent.endsWith('\n') ? '' : '\n');
        const newContent = rawContent + sep + ac;
        const commitMsg = (body.message as string) || `docs: append to ${filePath.split('/').pop()}`;
        const putBody = { message: commitMsg, content: b64e(newContent), sha, ...(branch ? { branch } : {}) };
        const pr = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`, { method: 'PUT', headers: ghH(td.github_pat), body: JSON.stringify(putBody) });
        if (!pr.ok) { const eb = await pr.json().catch(() => ({ message: 'Failed to update file' })) as { message: string }; return j({ error: 'github_error', status: pr.status, message: eb.message }, pr.status); }
        const pd = await pr.json() as { content: { sha: string }; commit: { sha: string; html_url: string } };
        console.log(`github-append ${owner}/${repo}/${filePath} +${ac.length}chars commit=${pd.commit.sha.slice(0, 8)}`);
        return j({ success: true, path: filePath, sha_before: sha, sha_after: pd.content.sha, commit: pd.commit.sha, commit_url: pd.commit.html_url, chars_added: ac.length + sep.length, chars_before: rawContent.length, chars_after: newContent.length });
      }

      // /github-search — search within file
      if (p === '/github-search') {
        const query = body.query as string;
        if (!query) return j({ error: 'invalid_request', error_description: 'Required: query' }, 400);
        const cx = Math.min(Math.max(parseInt(String(body.context_lines ?? 3)), 0), 20);
        const mx = Math.min(Math.max(parseInt(String(body.max_matches ?? 50)), 1), 200);
        const cs = body.case_sensitive === true;
        const { content: norm } = normCRLF(rawContent);
        const lines = norm.split('\n');
        const sq = cs ? query : query.toLowerCase();
        const matches: Array<{ line: number; col: number; text: string; context_before: string[]; context_after: string[] }> = [];
        for (let i = 0; i < lines.length && matches.length < mx; i++) {
          const lt = cs ? lines[i] : lines[i].toLowerCase();
          let col = lt.indexOf(sq);
          while (col !== -1 && matches.length < mx) {
            matches.push({ line: i + 1, col: col + 1, text: lines[i], context_before: lines.slice(Math.max(0, i - cx), i), context_after: lines.slice(i + 1, Math.min(lines.length, i + 1 + cx)) });
            col = lt.indexOf(sq, col + sq.length);
          }
        }
        console.log(`github-search ${owner}/${repo}/${filePath} q=${query} matches=${matches.length}`);
        return j({ query, case_sensitive: cs, path: fd.path, sha, size: fd.size, file_lines: lines.length, file_chars: norm.length, total_matches: matches.length, truncated: matches.length >= mx, matches });
      }
    }

    // ── MCP proxy → api.githubcopilot.com/mcp/ ───────────────────────────────
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
      const up = await fetch('https://api.githubcopilot.com/mcp/', { method: req.method, headers: ph, body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined });
      console.log(`proxy for=${td.github_login || 'unknown'} ${req.method} upstream=${up.status}`);
      const rh = new Headers(up.headers);
      Object.entries(CORS).forEach(([k, v]) => rh.set(k, v));
      return new Response(up.body, { status: up.status, statusText: up.statusText, headers: rh });
    }

    // Root
    if (p === '/' || p === '')
      return j({ name: 'github-mcp-proxy', version: '3.1.0', mcp: `${env.WORKER_URL}/mcp`, upstream: 'https://api.githubcopilot.com/mcp/', tools: '80+', editing: { endpoints: ['POST /github-read', 'POST /github-read-section', 'POST /github-patch', 'POST /github-append', 'POST /github-search'], auth: 'Bearer <oauth_token | github_pat_* | ghp_*>' } });

    return new Response('Not found', { status: 404, headers: CORS });
  },
};

// ── OAuth helpers ─────────────────────────────────────────────────────────────

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
