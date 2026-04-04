/**
 * GitHub MCP OAuth Proxy Worker
 *
 * Bridges the gap between Claude.ai web (which needs OAuth) and
 * api.githubcopilot.com/mcp/ (which uses GitHub PAT).
 *
 * Flow:
 *   1. Claude.ai registers as OAuth client  → POST /oauth/register
 *   2. Claude.ai requests authorization     → GET  /oauth/authorize  (shows PAT form)
 *   3. User enters GitHub PAT               → POST /oauth/authorize  (verifies PAT, issues code)
 *   4. Claude.ai exchanges code for token   → POST /oauth/token
 *   5. Claude.ai calls MCP tools            → POST /mcp  (proxied to official endpoint with PAT)
 *
 * Result: all 80+ tools from github/github-mcp-server, maintained by GitHub,
 * accessible from Claude.ai web via standard OAuth.
 */

export interface Env {
  OAUTH_KV: KVNamespace;
  WORKER_URL: string;
}

function randomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array).map(b => chars[b % chars.length]).join('');
}

async function sha256base64url(plain: string): Promise<string> {
  const data = new TextEncoder().encode(plain);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, mcp-session-id, mcp-protocol-version',
};

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: CORS });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ── OAuth metadata discovery ──────────────────────────────────────────────
    if (path === '/.well-known/oauth-authorization-server') {
      return json({
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
    }

    // ── Dynamic client registration ───────────────────────────────────────────
    if (path === '/oauth/register' && request.method === 'POST') {
      const body = await request.json() as Record<string, unknown>;
      const clientId = randomString(16);
      const clientSecret = randomString(32);
      const client = {
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uris: (body.redirect_uris as string[]) || [],
        client_name: (body.client_name as string) || 'MCP Client',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
      };
      await env.OAUTH_KV.put(`client:${clientId}`, JSON.stringify(client), {
        expirationTtl: 60 * 60 * 24 * 365,
      });
      return json({
        ...client,
        registration_access_token: randomString(32),
        registration_client_uri: `${env.WORKER_URL}/oauth/clients/${clientId}`,
      }, 201);
    }

    // ── Authorization — show PAT input form ───────────────────────────────────
    if (path === '/oauth/authorize' && request.method === 'GET') {
      const clientId = url.searchParams.get('client_id') || '';
      const redirectUri = url.searchParams.get('redirect_uri') || '';
      const state = url.searchParams.get('state') || '';
      const codeChallenge = url.searchParams.get('code_challenge') || '';
      const codeChallengeMethod = url.searchParams.get('code_challenge_method') || 'S256';

      if (!clientId || !redirectUri) {
        return new Response('Missing client_id or redirect_uri', { status: 400 });
      }

      const client = await env.OAUTH_KV.get(`client:${clientId}`, 'json') as Record<string, unknown> | null;
      if (!client) {
        return new Response('Unknown client', { status: 400 });
      }

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Connect GitHub to Claude</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
      background: #f6f8fa; min-height: 100vh;
      display: flex; align-items: center; justify-content: center; padding: 1rem;
    }
    .card {
      background: #fff; border: 1px solid #d0d7de; border-radius: 12px;
      padding: 2rem; width: 100%; max-width: 440px;
    }
    .header { text-align: center; margin-bottom: 1.5rem; }
    .header .icon { font-size: 2.5rem; display: block; margin-bottom: .75rem; }
    h1 { font-size: 1.375rem; font-weight: 600; color: #24292f; margin-bottom: .375rem; }
    .subtitle { font-size: .875rem; color: #57606a; line-height: 1.5; }
    .scopes {
      background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 8px;
      padding: .875rem 1rem; margin-bottom: 1.25rem;
    }
    .scopes h2 { font-size: .8125rem; font-weight: 600; color: #24292f; margin-bottom: .5rem; }
    .scope-list { display: flex; flex-wrap: wrap; gap: .375rem; }
    .badge {
      background: #ddf4ff; color: #0550ae; border: 1px solid #b6e3ff;
      border-radius: 99px; padding: .125rem .625rem; font-size: .75rem; font-weight: 500;
      font-family: monospace;
    }
    .badge.optional { background: #f6f8fa; color: #57606a; border-color: #d0d7de; }
    label { display: block; font-size: .875rem; font-weight: 600; color: #24292f; margin-bottom: .375rem; }
    .input-wrap { position: relative; }
    input[type=text], input[type=password] {
      width: 100%; padding: .5rem .75rem; border: 1px solid #d0d7de; border-radius: 6px;
      font-size: .875rem; outline: none; font-family: monospace; color: #24292f;
      transition: border-color .15s, box-shadow .15s;
    }
    input:focus {
      border-color: #0969da;
      box-shadow: 0 0 0 3px rgba(9, 105, 218, .15);
    }
    .hint { font-size: .75rem; color: #57606a; margin-top: .375rem; margin-bottom: 1.25rem; }
    .hint a { color: #0969da; text-decoration: none; }
    .hint a:hover { text-decoration: underline; }
    .submit {
      width: 100%; padding: .625rem 1rem;
      background: #1f883d; color: #fff;
      border: none; border-radius: 6px;
      font-size: .9375rem; font-weight: 600; cursor: pointer;
      transition: background .15s;
    }
    .submit:hover { background: #1a7f37; }
    .submit:active { background: #166a2e; }
    .footer { margin-top: 1rem; text-align: center; font-size: .75rem; color: #57606a; }
    .footer a { color: #0969da; text-decoration: none; }
  </style>
</head>
<body>
<div class="card">
  <div class="header">
    <span class="icon">&#x26A1;</span>
    <h1>Connect GitHub to Claude</h1>
    <p class="subtitle">
      Enter your GitHub Personal Access Token to give Claude access to
      your repositories, issues, pull requests and more.
    </p>
  </div>

  <div class="scopes">
    <h2>Required permissions</h2>
    <div class="scope-list">
      <span class="badge">repo</span>
      <span class="badge">read:org</span>
      <span class="badge">notifications</span>
      <span class="badge optional">workflow (optional)</span>
    </div>
  </div>

  <form method="POST" action="/oauth/authorize">
    <input type="hidden" name="client_id" value="${clientId}">
    <input type="hidden" name="redirect_uri" value="${redirectUri}">
    <input type="hidden" name="state" value="${state}">
    <input type="hidden" name="code_challenge" value="${codeChallenge}">
    <input type="hidden" name="code_challenge_method" value="${codeChallengeMethod}">

    <label for="pat">Personal Access Token</label>
    <div class="input-wrap">
      <input type="password" id="pat" name="pat"
             placeholder="github_pat_... or ghp_..."
             autocomplete="off" required autofocus>
    </div>
    <p class="hint">
      <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">
        Create a new fine-grained token
      </a> with the permissions above.
      Your token is stored securely and only used to call GitHub APIs.
    </p>

    <button type="submit" class="submit">Authorize Claude &#x2192;</button>
  </form>

  <p class="footer">
    Powered by <a href="https://github.com/github/github-mcp-server" target="_blank" rel="noopener">github/github-mcp-server</a>
    &middot; 80+ tools
  </p>
</div>
</body>
</html>`;

      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // ── Authorization POST — verify PAT and issue code ────────────────────────
    if (path === '/oauth/authorize' && request.method === 'POST') {
      const form = await request.formData();
      const clientId = form.get('client_id') as string;
      const redirectUri = form.get('redirect_uri') as string;
      const state = form.get('state') as string || '';
      const codeChallenge = form.get('code_challenge') as string || '';
      const codeChallengeMethod = form.get('code_challenge_method') as string || 'S256';
      const pat = (form.get('pat') as string || '').trim();

      if (!pat) {
        return new Response('Missing token', { status: 400 });
      }

      // Verify PAT with GitHub API
      const verify = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${pat}`,
          'User-Agent': 'github-mcp-proxy/1.0',
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });

      if (!verify.ok) {
        const errHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>Invalid token</title>
<style>body{font-family:sans-serif;text-align:center;padding:3rem;color:#24292f}
  h2{color:#d1242f;margin-bottom:1rem} a{color:#0969da}</style></head>
<body><h2>&#x274C; Invalid GitHub token</h2>
<p>The token is invalid, expired, or lacks the required permissions.</p>
<p style="margin-top:1.5rem"><a href="javascript:history.back()">&#x2190; Try again</a></p>
</body></html>`;
        return new Response(errHtml, {
          status: 400,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }

      const user = await verify.json() as { login: string };
      const code = randomString(40);

      await env.OAUTH_KV.put(`auth_code:${code}`, JSON.stringify({
        client_id: clientId,
        code_challenge: codeChallenge,
        code_challenge_method: codeChallengeMethod,
        github_pat: pat,
        github_login: user.login,
        created_at: Date.now(),
      }), { expirationTtl: 300 }); // 5 min

      const redirect = new URL(redirectUri);
      redirect.searchParams.set('code', code);
      if (state) redirect.searchParams.set('state', state);

      return Response.redirect(redirect.toString(), 302);
    }

    // ── Token endpoint ────────────────────────────────────────────────────────
    if (path === '/oauth/token' && request.method === 'POST') {
      const ct = request.headers.get('content-type') || '';
      let body: Record<string, string>;
      if (ct.includes('application/json')) {
        body = await request.json() as Record<string, string>;
      } else {
        const fd = await request.formData();
        body = Object.fromEntries(
          [...fd.entries()].map(([k, v]) => [k, String(v)])
        );
      }

      const { grant_type, code, code_verifier, refresh_token } = body;

      // ── Refresh token grant
      if (grant_type === 'refresh_token' && refresh_token) {
        const existingToken = await env.OAUTH_KV.get(`refresh:${refresh_token}`) as string | null;
        if (!existingToken) {
          return json({ error: 'invalid_grant', error_description: 'Refresh token invalid or expired' }, 400);
        }
        const tokenData = await env.OAUTH_KV.get(`token:${existingToken}`, 'json') as Record<string, unknown> | null;
        if (!tokenData) {
          return json({ error: 'invalid_grant', error_description: 'Token not found' }, 400);
        }
        // Issue new access token, keep same PAT
        const newToken = randomString(48);
        const newRefresh = randomString(48);
        await env.OAUTH_KV.put(`token:${newToken}`, JSON.stringify({
          ...tokenData,
          refresh_token: newRefresh,
          created_at: Date.now(),
        }), { expirationTtl: 60 * 60 * 24 * 30 });
        await env.OAUTH_KV.put(`refresh:${newRefresh}`, newToken, { expirationTtl: 60 * 60 * 24 * 30 });
        await env.OAUTH_KV.delete(`token:${existingToken}`);
        await env.OAUTH_KV.delete(`refresh:${refresh_token}`);
        return json({
          access_token: newToken,
          token_type: 'Bearer',
          expires_in: 28800,
          refresh_token: newRefresh,
          scope: 'repo read:org notifications',
        });
      }

      // ── Authorization code grant
      if (!code) {
        return json({ error: 'invalid_request', error_description: 'Missing code' }, 400);
      }

      const stored = await env.OAUTH_KV.get(`auth_code:${code}`, 'json') as Record<string, string> | null;
      if (!stored) {
        return json({ error: 'invalid_grant', error_description: 'Code expired or already used' }, 400);
      }

      // PKCE S256 verification
      if (stored.code_challenge && code_verifier) {
        const computed = await sha256base64url(code_verifier);
        if (computed !== stored.code_challenge) {
          return json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400);
        }
      }

      await env.OAUTH_KV.delete(`auth_code:${code}`);

      const accessToken = randomString(48);
      const refreshToken = randomString(48);

      await env.OAUTH_KV.put(`token:${accessToken}`, JSON.stringify({
        client_id: stored.client_id,
        github_pat: stored.github_pat,
        github_login: stored.github_login,
        refresh_token: refreshToken,
        created_at: Date.now(),
      }), { expirationTtl: 60 * 60 * 24 * 30 });

      await env.OAUTH_KV.put(`refresh:${refreshToken}`, accessToken, {
        expirationTtl: 60 * 60 * 24 * 30,
      });

      return json({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 28800,
        refresh_token: refreshToken,
        scope: 'repo read:org notifications',
      });
    }

    // ── MCP proxy — the main event ────────────────────────────────────────────
    if (path === '/mcp' || path.startsWith('/mcp/')) {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return json({ error: 'unauthorized', error_description: 'Bearer token required' }, 401);
      }

      const token = authHeader.slice(7);
      const tokenData = await env.OAUTH_KV.get(`token:${token}`, 'json') as
        { github_pat: string; github_login: string } | null;

      if (!tokenData) {
        return json({ error: 'unauthorized', error_description: 'Token not found or expired' }, 401);
      }

      // Build proxy request to official GitHub MCP endpoint
      const upstreamUrl = new URL('https://api.githubcopilot.com/mcp/');

      const proxyHeaders = new Headers();
      // Forward safe headers from the original request
      for (const [key, value] of request.headers.entries()) {
        const k = key.toLowerCase();
        if (
          k === 'content-type' ||
          k === 'accept' ||
          k === 'mcp-session-id' ||
          k === 'mcp-protocol-version' ||
          k === 'accept-encoding'
        ) {
          proxyHeaders.set(key, value);
        }
      }
      // Replace auth with the user's GitHub PAT
      proxyHeaders.set('Authorization', `Bearer ${tokenData.github_pat}`);
      proxyHeaders.set('User-Agent', 'github-mcp-proxy/1.0');
      proxyHeaders.set('X-Forwarded-For', request.headers.get('cf-connecting-ip') || '');

      const upstream = await fetch(upstreamUrl.toString(), {
        method: request.method,
        headers: proxyHeaders,
        body: request.method !== 'GET' && request.method !== 'HEAD'
          ? request.body
          : undefined,
      });

      // Stream the response back, injecting CORS headers
      const responseHeaders = new Headers(upstream.headers);
      Object.entries(CORS).forEach(([k, v]) => responseHeaders.set(k, v));

      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      });
    }

    // ── Root — service info ───────────────────────────────────────────────────
    if (path === '/' || path === '') {
      return json({
        name: 'github-mcp-proxy',
        version: '1.0.0',
        description: 'OAuth proxy for api.githubcopilot.com/mcp/ — enables Claude.ai web access to all 80+ GitHub MCP tools',
        endpoints: {
          mcp: `${env.WORKER_URL}/mcp`,
          oauth_metadata: `${env.WORKER_URL}/.well-known/oauth-authorization-server`,
          register: `${env.WORKER_URL}/oauth/register`,
          authorize: `${env.WORKER_URL}/oauth/authorize`,
          token: `${env.WORKER_URL}/oauth/token`,
        },
        upstream: 'https://api.githubcopilot.com/mcp/',
        tools: '80+ (maintained by github/github-mcp-server)',
        transport: 'streamable-http',
        source: 'https://github.com/yessicavs/github-mcp-server/tree/main/cloudflare-worker',
      });
    }

    return new Response('Not found', { status: 404, headers: CORS });
  },
};
