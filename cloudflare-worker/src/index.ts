/**
 * github-mcp-proxy v4.0
 *
 * New endpoints over v3.1:
 *   POST /github-outline          — extract document structure (headings, tables, code blocks, JSON keys)
 *   POST /github-replace-section  — replace markdown section content by heading (semantic, no old_str needed)
 *   POST /github-json-patch       — JSONPath operations on JSON files (set, delete, push, merge)
 *   POST /github-table-upsert     — insert or update a row in a markdown table by key column value
 *   POST /github-search-dir       — search a query across all files in a directory
 *
 * Enhanced existing endpoints:
 *   dry_run: true  — all write endpoints return diff preview without committing
 *   _index.json    — auto-maintained in background after every write (ctx.waitUntil)
 *
 * Auth for /github-* endpoints:
 *   Authorization: Bearer <oauth_access_token | ghp_* | github_pat_*>
 */

export interface Env {
  OAUTH_KV: KVNamespace;
  WORKER_URL: string;
}

function b64d(b64: string): string {
  const bin = atob(b64.replace(/\n/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

function b64e(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const K = 8192;
  for (let i = 0; i < bytes.length; i += K)
    bin += String.fromCharCode(...bytes.subarray(i, i + K));
  return btoa(bin);
}

interface TokenData { github_pat: string; github_login?: string; client_id?: string; }

async function resolveAuth(req: Request, env: Env): Promise<TokenData | null> {
  const ah = req.headers.get('Authorization');
  if (!ah || !ah.startsWith('Bearer ')) return null;
  const tok = ah.slice(7).trim();
  if (tok.startsWith('ghp_') || tok.startsWith('github_pat_')) return { github_pat: tok };
  return await env.OAUTH_KV.get(`token:${tok}`, 'json') as TokenData | null;
}

function ghH(pat: string): Record<string, string> {
  return {
    Authorization: `Bearer ${pat}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'github-mcp-proxy/1.0',
    'Content-Type': 'application/json',
  };
}

interface GitHubFileData {
  content: string; sha: string; size: number;
  path: string; name: string; html_url: string; download_url: string | null;
}

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

function normCRLF(str: string): { content: string; wasCRLF: boolean } {
  const wasCRLF = str.includes('\r\n');
  return { content: wasCRLF ? str.replace(/\r\n/g, '\n') : str, wasCRLF };
}

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
      throw { patchIndex: i, error: 'ambiguous', error_description: `patch[${i}].old_str found ${occ.length} times — must be unique`, count: occ.length, occurrences: occ.map(o => ({ line: o.line, col: o.col, context: o.context })), hint: 'Add more surrounding context' };
    const m = occ[0];
    cur = cur.substring(0, m.idx) + new_str + cur.substring(m.idx + old_str.length);
    results.push({ patch_index: i, replaced_at: { line: m.line, col: m.col }, delta: new_str.length - old_str.length });
  }
  return { newContent: cur, results };
}

// ── v4.0: Format detection ──────────────────────────────────────────────────────

function detectFormat(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return 'markdown';
  if (ext === 'json') return 'json';
  if (ext === 'yaml' || ext === 'yml') return 'yaml';
  if (ext === 'csv') return 'csv';
  if (ext === 'toml') return 'toml';
  if (ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'jsx') return 'code';
  return 'text';
}

// ── v4.0: Markdown outline ──────────────────────────────────────────────────────

interface MdSection { level: number; title: string; line_start: number; line_end: number; anchor: string; char_count?: number; }
interface MdTable { line: number; header: string; col_count: number; }
interface MdCodeBlock { line_start: number; line_end: number; lang: string; }

function anchorize(title: string): string {
  return title.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').trim();
}

function outlineMd(content: string): { sections: MdSection[]; tables: MdTable[]; code_blocks: MdCodeBlock[]; frontmatter: boolean } {
  const { content: norm } = normCRLF(content);
  const lines = norm.split('\n');
  const sections: MdSection[] = [], tables: MdTable[] = [], codeBlocks: MdCodeBlock[] = [];
  let inCode = false, codeStart = 0, codeLang = '', hasFrontmatter = false, inFrontmatter = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0 && line.trim() === '---') { inFrontmatter = true; hasFrontmatter = true; continue; }
    if (inFrontmatter) { if (line.trim() === '---' || line.trim() === '...') inFrontmatter = false; continue; }
    if (line.startsWith('```') || line.startsWith('~~~')) {
      if (!inCode) { inCode = true; codeStart = i + 1; codeLang = line.slice(3).trim(); }
      else { codeBlocks.push({ line_start: codeStart, line_end: i, lang: codeLang }); inCode = false; }
      continue;
    }
    if (inCode) continue;
    const hm = line.match(/^(#{1,6})\s+(.+)$/);
    if (hm) { sections.push({ level: hm[1].length, title: hm[2].trim(), line_start: i + 1, line_end: lines.length, anchor: anchorize(hm[2].trim()) }); continue; }
    if (line.includes('|') && i + 1 < lines.length && /^\|[\s\-:|]+\|/.test(lines[i + 1]))
      tables.push({ line: i + 1, header: line.trim(), col_count: line.split('|').filter(c => c.trim()).length });
  }
  for (let i = 0; i < sections.length; i++) {
    for (let j = i + 1; j < sections.length; j++) {
      if (sections[j].level <= sections[i].level) { sections[i].line_end = sections[j].line_start - 1; break; }
    }
    sections[i].char_count = lines.slice(sections[i].line_start - 1, sections[i].line_end).join('\n').length;
  }
  return { sections, tables, code_blocks: codeBlocks, frontmatter: hasFrontmatter };
}

// ── v4.0: Find section bounds ───────────────────────────────────────────────────

interface SectionBounds { start: number; end: number; level: number; heading_line: string; }

function findSectionBounds(lines: string[], heading: string): SectionBounds | null {
  const norm = heading.trim();
  const lm = norm.match(/^(#{1,6})\s+/);
  if (!lm) return null;
  const level = lm[1].length;
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) { if (lines[i].trim() === norm) { startIdx = i; break; } }
  if (startIdx === -1) return null;
  let endIdx = lines.length, inCode = false;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('```') || l.startsWith('~~~')) { inCode = !inCode; continue; }
    if (inCode) continue;
    const m = l.match(/^(#{1,6})\s/);
    if (m && m[1].length <= level) { endIdx = i; break; }
  }
  return { start: startIdx, end: endIdx, level, heading_line: lines[startIdx] };
}

// ── v4.0: JSON path operations ──────────────────────────────────────────────────

type JsonVal = string | number | boolean | null | JsonVal[] | Record<string, JsonVal>;

function tokenizePath(path: string): Array<{ type: 'key' | 'index' | 'filter'; key: string | number; filter?: { field: string; op: string; val: string } }> {
  const tokens = [];
  const parts = path.replace(/\[/g, '.[').split('.').filter(Boolean);
  for (const part of parts) {
    if (part.startsWith('[?(')) {
      const m = part.match(/\[\?\(@\.(\w+)\s*(==|!=)\s*['"]?(.*?)['"]?\)\]/);
      if (m) tokens.push({ type: 'filter' as const, key: m[1], filter: { field: m[1], op: m[2], val: m[3] } });
    } else if (part.startsWith('[') && part.endsWith(']')) {
      const idx = parseInt(part.slice(1, -1));
      tokens.push({ type: 'index' as const, key: isNaN(idx) ? part.slice(1, -1) : idx });
    } else {
      tokens.push({ type: 'key' as const, key: part });
    }
  }
  return tokens;
}

interface PathRef { parent: Record<string, JsonVal> | JsonVal[]; key: string | number; value: JsonVal; found: boolean; }

function resolvePath(root: JsonVal, pathStr: string): PathRef | null {
  if (!pathStr.startsWith('$.')) return null;
  const path = pathStr.slice(2);
  if (!path) return null;
  const tokens = tokenizePath(path);
  let cur: JsonVal = root, parent: Record<string, JsonVal> | JsonVal[] | null = null, lastKey: string | number = '';
  for (const token of tokens) {
    parent = cur as Record<string, JsonVal> | JsonVal[];
    if (token.type === 'key') {
      if (typeof cur !== 'object' || cur === null || Array.isArray(cur)) return null;
      lastKey = token.key as string;
      cur = (cur as Record<string, JsonVal>)[lastKey];
    } else if (token.type === 'index') {
      if (!Array.isArray(cur)) return null;
      const idx = token.key as number;
      lastKey = idx < 0 ? cur.length + idx : idx;
      cur = (cur as JsonVal[])[lastKey as number];
    } else if (token.type === 'filter' && token.filter) {
      if (!Array.isArray(cur)) return null;
      const { field, op, val } = token.filter;
      const idx = (cur as JsonVal[]).findIndex(item => {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) return false;
        const v = (item as Record<string, JsonVal>)[field];
        return op === '==' ? String(v) === val : String(v) !== val;
      });
      if (idx === -1) return { parent: cur as JsonVal[], key: -1, value: undefined as unknown as JsonVal, found: false };
      lastKey = idx; cur = (cur as JsonVal[])[idx];
    }
    if (cur === undefined) return { parent: parent as Record<string, JsonVal> | JsonVal[], key: lastKey, value: undefined as unknown as JsonVal, found: false };
  }
  return { parent: parent as Record<string, JsonVal> | JsonVal[], key: lastKey, value: cur, found: true };
}

interface JsonOperation { op: 'set' | 'delete' | 'push' | 'merge'; path: string; value?: JsonVal; }

function applyJsonOps(jsonStr: string, operations: JsonOperation[]): { newJson: string; applied: Array<{ path: string; op: string; before: JsonVal; after: JsonVal }> } {
  let obj: JsonVal = JSON.parse(jsonStr);
  const applied = [];
  for (const { op, path, value } of operations) {
    const ref = resolvePath(obj, path);
    if (op === 'set') {
      if (!ref || !ref.parent) throw { error: 'path_not_found', path, error_description: `Cannot resolve path: ${path}` };
      const before = ref.value;
      if (Array.isArray(ref.parent)) (ref.parent as JsonVal[])[ref.key as number] = value as JsonVal;
      else (ref.parent as Record<string, JsonVal>)[ref.key as string] = value as JsonVal;
      applied.push({ path, op, before, after: value as JsonVal });
    } else if (op === 'delete') {
      if (!ref || !ref.found) throw { error: 'not_found', path, error_description: `Path not found: ${path}` };
      const before = ref.value;
      if (Array.isArray(ref.parent)) (ref.parent as JsonVal[]).splice(ref.key as number, 1);
      else delete (ref.parent as Record<string, JsonVal>)[ref.key as string];
      applied.push({ path, op, before, after: null });
    } else if (op === 'push') {
      if (!ref || !ref.found) throw { error: 'not_found', path, error_description: `Path not found: ${path}` };
      if (!Array.isArray(ref.value)) throw { error: 'not_array', path, error_description: `Target is not an array: ${path}` };
      const before = (ref.value as JsonVal[]).length;
      (ref.value as JsonVal[]).push(value as JsonVal);
      applied.push({ path, op, before, after: (ref.value as JsonVal[]).length });
    } else if (op === 'merge') {
      if (!ref || !ref.found) throw { error: 'not_found', path, error_description: `Path not found: ${path}` };
      if (typeof ref.value !== 'object' || ref.value === null || Array.isArray(ref.value))
        throw { error: 'not_object', path, error_description: `Target is not an object: ${path}` };
      const before = { ...ref.value as Record<string, JsonVal> };
      Object.assign(ref.value as Record<string, JsonVal>, value as Record<string, JsonVal>);
      applied.push({ path, op, before, after: { ...ref.value as Record<string, JsonVal> } });
    }
  }
  return { newJson: JSON.stringify(obj, null, 2), applied };
}

// ── v4.0: Markdown table upsert ─────────────────────────────────────────────────

interface TableInfo {
  headerLine: number; sepLine: number; dataLines: number[]; columns: string[];
}

function parseTableAt(lines: string[], anchorStr: string): TableInfo | null {
  let headerLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('|') && lines[i].includes(anchorStr) &&
        i + 1 < lines.length && /^\|[\s\-:|]+\|/.test(lines[i + 1])) {
      headerLine = i; break;
    }
  }
  if (headerLine === -1) return null;
  const sepLine = headerLine + 1;
  const columns = lines[headerLine].split('|').map(c => c.trim()).filter(Boolean);
  const dataLines: number[] = [];
  for (let i = sepLine + 1; i < lines.length; i++) {
    if (!lines[i].includes('|')) break;
    dataLines.push(i);
  }
  return { headerLine, sepLine, dataLines, columns };
}

function parseRowCells(line: string): string[] {
  return line.split('|').map(c => c.trim()).filter((_, i, arr) => i > 0 && i < arr.length - 1);
}

function upsertTableRow(lines: string[], table: TableInfo, keyCol: number, keyVal: string, newRow: string): { newLines: string[]; action: 'updated' | 'inserted'; rowLine: number } {
  const newLines = [...lines];
  for (const dataIdx of table.dataLines) {
    const cells = parseRowCells(lines[dataIdx]);
    if (cells[keyCol]?.trim() === keyVal.trim()) {
      newLines[dataIdx] = newRow;
      return { newLines, action: 'updated', rowLine: dataIdx + 1 };
    }
  }
  const insertAfter = table.dataLines.length > 0 ? table.dataLines[table.dataLines.length - 1] : table.sepLine;
  newLines.splice(insertAfter + 1, 0, newRow);
  return { newLines, action: 'inserted', rowLine: insertAfter + 2 };
}

// ── v4.0: Glob matching ─────────────────────────────────────────────────────────

function matchGlob(pattern: string, filename: string): boolean {
  const re = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*\*/g, '§§').replace(/\*/g, '[^/]*').replace(/§§/g, '.*').replace(/\?/g, '.') + '$');
  return re.test(filename);
}

// ── v4.0: _index.json auto-maintenance ─────────────────────────────────────────

async function updateIndex(
  owner: string, repo: string, branch: string | undefined,
  filePath: string, content: string, newSha: string, pat: string
): Promise<void> {
  if (filePath.endsWith('_index.json')) return;
  const parts = filePath.split('/');
  const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
  const indexPath = dir ? `${dir}/_index.json` : '_index.json';
  const ref = branch ? `?ref=${encodeURIComponent(branch)}` : '';
  const existRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${indexPath}${ref}`, { headers: ghH(pat) });
  let existingIndex: Record<string, unknown> = { version: '1.0', files: {}, last_updated: '' };
  let existingSha: string | undefined;
  if (existRes.ok) {
    const ed = await existRes.json() as GitHubFileData;
    existingSha = ed.sha;
    try { existingIndex = JSON.parse(b64d(ed.content)) as Record<string, unknown>; } catch {}
  }
  const format = detectFormat(filePath);
  const { content: norm } = normCRLF(content);
  const entry: Record<string, unknown> = {
    sha: newSha, size: new TextEncoder().encode(content).length, format,
    lines: norm.split('\n').length, updated_at: new Date().toISOString(),
  };
  if (format === 'markdown') {
    const outline = outlineMd(norm);
    entry.sections = outline.sections.map(s => ({ level: s.level, title: s.title, anchor: s.anchor, line_start: s.line_start, line_end: s.line_end }));
    entry.tables = outline.tables; entry.code_blocks = outline.code_blocks.length; entry.frontmatter = outline.frontmatter;
  } else if (format === 'json') {
    try {
      const parsed = JSON.parse(norm);
      entry.top_level_keys = !Array.isArray(parsed) && typeof parsed === 'object' && parsed !== null ? Object.keys(parsed as Record<string, unknown>) : null;
      entry.is_array = Array.isArray(parsed);
      entry.array_length = Array.isArray(parsed) ? (parsed as unknown[]).length : null;
    } catch {}
  }
  const files = (existingIndex.files as Record<string, unknown>) || {};
  files[filePath] = entry;
  existingIndex.files = files; existingIndex.last_updated = new Date().toISOString(); existingIndex.version = '1.0';
  const body: Record<string, unknown> = {
    message: `chore: _index.json \u2014 ${parts[parts.length - 1]} updated`,
    content: b64e(JSON.stringify(existingIndex, null, 2)),
  };
  if (existingSha) body.sha = existingSha;
  if (branch) body.branch = branch;
  await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${indexPath}`, {
    method: 'PUT', headers: ghH(pat), body: JSON.stringify(body),
  }).catch(() => {});
}

// ── Write to GitHub helper ──────────────────────────────────────────────────────

async function writeFile(
  owner: string, repo: string, filePath: string, branch: string | undefined,
  content: string, sha: string, commitMsg: string, pat: string
): Promise<{ sha_after: string; commit: string; commit_url: string }> {
  const body: Record<string, unknown> = { message: commitMsg, content: b64e(content), sha };
  if (branch) body.branch = branch;
  const pr = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`, {
    method: 'PUT', headers: ghH(pat), body: JSON.stringify(body),
  });
  if (!pr.ok) {
    const eb = await pr.json().catch(() => ({ message: 'Failed to write file' })) as { message: string };
    if (pr.status === 409 || pr.status === 422)
      throw { error: 'conflict', status: pr.status, message: eb.message, error_description: 'File modified concurrently — re-read with /github-read and retry' };
    throw { error: 'github_error', status: pr.status, message: eb.message };
  }
  const pd = await pr.json() as { content: { sha: string }; commit: { sha: string; html_url: string } };
  return { sha_after: pd.content.sha, commit: pd.commit.sha, commit_url: pd.commit.html_url };
}

// ── OAuth helpers ───────────────────────────────────────────────────────────────

function rnd(n: number): string {
  const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const a = new Uint8Array(n); crypto.getRandomValues(a);
  return Array.from(a).map(b => c[b % c.length]).join('');
}

async function h256(p: string): Promise<string> {
  const d = new TextEncoder().encode(p);
  const h = await crypto.subtle.digest('SHA-256', d);
  return btoa(String.fromCharCode(...new Uint8Array(h))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, mcp-session-id, mcp-protocol-version',
};
const j = (body: unknown, status = 200, extra?: Record<string, string>) =>
  Response.json(body, { status, headers: extra ? { ...CORS, ...extra } : CORS });

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url), p = url.pathname;
    console.log(`${req.method} ${p}`);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (p.startsWith('/.well-known/oauth-protected-resource'))
      return j({ resource: `${env.WORKER_URL}/mcp`, authorization_servers: [env.WORKER_URL], bearer_methods_supported: ['header'] });
    if (p === '/.well-known/oauth-authorization-server')
      return j({ issuer: env.WORKER_URL, authorization_endpoint: `${env.WORKER_URL}/oauth/authorize`, token_endpoint: `${env.WORKER_URL}/oauth/token`, registration_endpoint: `${env.WORKER_URL}/oauth/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_post', 'none'], scopes_supported: ['repo', 'read:org', 'notifications', 'workflow'] });
    if (p === '/oauth/register' && req.method === 'POST') {
      const b = await req.json() as Record<string, unknown>;
      const ci = rnd(16), cs = rnd(32), now = Math.floor(Date.now() / 1000);
      const c = { client_id: ci, client_secret: cs, redirect_uris: (b.redirect_uris as string[]) || [], client_name: (b.client_name as string) || 'Claude', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'client_secret_post', client_id_issued_at: now, client_secret_expires_at: 0, scope: 'repo read:org notifications workflow' };
      await env.OAUTH_KV.put(`client:${ci}`, JSON.stringify(c), { expirationTtl: 31536000 });
      return j({ ...c, registration_access_token: rnd(32) }, 201);
    }
    if (p === '/oauth/authorize' && req.method === 'GET') {
      const ci = url.searchParams.get('client_id') || '', ru = url.searchParams.get('redirect_uri') || '', st = url.searchParams.get('state') || '', cc = url.searchParams.get('code_challenge') || '', cm = url.searchParams.get('code_challenge_method') || 'S256';
      if (!ci || !ru) return new Response('Missing client_id or redirect_uri', { status: 400 });
      const cl = await env.OAUTH_KV.get(`client:${ci}`, 'json');
      if (!cl) return new Response(`Unknown client_id: ${ci}`, { status: 400 });
      const html = `<!DOCTYPE html><html lang=en><head><meta charset=UTF-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Connect GitHub</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#f6f8fa;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}.card{background:#fff;border:1px solid #d0d7de;border-radius:12px;padding:2rem;width:100%;max-width:440px}h1{font-size:1.25rem;color:#24292f;margin:.5rem 0 .5rem}p{font-size:.875rem;color:#57606a;line-height:1.5;margin-bottom:1rem}code{background:#f6f8fa;padding:.1em .3em;border-radius:4px;font-size:.85em}label{display:block;font-size:.875rem;font-weight:600;color:#24292f;margin-bottom:.375rem}input[type=password]{width:100%;padding:.5rem .75rem;border:1px solid #d0d7de;border-radius:6px;font-size:.875rem;font-family:monospace;outline:none}input[type=password]:focus{border-color:#0969da;box-shadow:0 0 0 3px rgba(9,105,218,.15)}.hint{font-size:.75rem;color:#57606a;margin:.375rem 0 1.25rem}.hint a{color:#0969da;text-decoration:none}button{width:100%;padding:.625rem;background:#1f883d;color:#fff;border:none;border-radius:6px;font-size:.9375rem;font-weight:600;cursor:pointer}button:hover{background:#1a7f37}</style></head><body><div class=card><div style="font-size:2.5rem;margin-bottom:.75rem">&#x26A1;</div><h1>Connect GitHub to Claude</h1><p>Enter your GitHub PAT.<br>Required: <code>repo</code>, <code>read:org</code>, <code>notifications</code>.</p><form method=POST action=/oauth/authorize><input type=hidden name=client_id value="${ci}"><input type=hidden name=redirect_uri value="${ru}"><input type=hidden name=state value="${st}"><input type=hidden name=code_challenge value="${cc}"><input type=hidden name=code_challenge_method value="${cm}"><label for=pat>Personal Access Token</label><input type=password id=pat name=pat placeholder="github_pat_... or ghp_..." required autofocus><p class=hint><a href=https://github.com/settings/personal-access-tokens/new target=_blank rel=noopener>Create a fine-grained token</a> with required scopes.</p><button type=submit>Authorize Claude &#x2192;</button></form><p style="margin-top:1rem;font-size:.75rem;color:#57606a;text-align:center">Powered by <a href=https://github.com/github/github-mcp-server style=color:#0969da>github/github-mcp-server</a> &middot; 80+ tools</p></div></body></html>`;
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    if (p === '/oauth/authorize' && req.method === 'POST') {
      const form = await req.formData();
      const ci = String(form.get('client_id') || ''), ru = String(form.get('redirect_uri') || ''), st = String(form.get('state') || ''), cc = String(form.get('code_challenge') || ''), cm = String(form.get('code_challenge_method') || 'S256'), pat = String(form.get('pat') || '').trim();
      if (!pat) return new Response('Missing token', { status: 400 });
      const vr = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${pat}`, 'User-Agent': 'github-mcp-proxy/1.0', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
      if (!vr.ok) return new Response(`Invalid GitHub token (${vr.status}).`, { status: 400, headers: { 'Content-Type': 'text/plain' } });
      const u = await vr.json() as { login: string };
      const code = rnd(40);
      await env.OAUTH_KV.put(`auth_code:${code}`, JSON.stringify({ client_id: ci, code_challenge: cc, code_challenge_method: cm, github_pat: pat, github_login: u.login, created_at: Date.now() }), { expirationTtl: 300 });
      const r = new URL(ru); r.searchParams.set('code', code); if (st) r.searchParams.set('state', st);
      return Response.redirect(r.toString(), 302);
    }
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

    const editingPaths = ['/github-read','/github-read-section','/github-patch','/github-append','/github-search','/github-outline','/github-replace-section','/github-json-patch','/github-table-upsert','/github-search-dir'];

    if (editingPaths.includes(p) && req.method === 'POST') {
      const td = await resolveAuth(req, env);
      if (!td) return j({ error: 'unauthorized', error_description: 'Bearer token required (OAuth access_token or GitHub PAT)' }, 401);
      const body = await req.json() as Record<string, unknown>;
      const { owner, repo, branch } = body as { owner: string; repo: string; branch?: string };
      const filePath = body.path as string;
      const dryRun = body.dry_run === true;
      const skipIndex = body.skip_index === true;

      if (p === '/github-search-dir') {
        const dir = (body.dir as string) || '', query = body.query as string;
        if (!owner || !repo || !query) return j({ error: 'invalid_request', error_description: 'Required: owner, repo, query' }, 400);
        const pattern = (body.file_pattern as string) || '*.md';
        const cx = Math.min(Math.max(parseInt(String(body.context_lines ?? 2)), 0), 10);
        const maxPF = Math.min(Math.max(parseInt(String(body.max_per_file ?? 10)), 1), 50);
        const maxF = Math.min(Math.max(parseInt(String(body.max_files ?? 20)), 1), 30);
        const cs = body.case_sensitive === true;
        const ref = branch ? `?ref=${encodeURIComponent(branch)}` : '';
        const dirRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${dir}${ref}`, { headers: ghH(td.github_pat) });
        if (!dirRes.ok) { const eb = await dirRes.json().catch(() => ({ message: 'Failed to list directory' })) as { message: string }; return j({ error: 'github_error', status: dirRes.status, message: eb.message }, dirRes.status); }
        const entries = await dirRes.json() as Array<{ name: string; path: string; type: string; size: number; sha: string }>;
        if (!Array.isArray(entries)) return j({ error: 'invalid_request', error_description: 'Path is not a directory' }, 422);
        const files = entries.filter(e => e.type === 'file' && matchGlob(pattern, e.name)).slice(0, maxF);
        const sq = cs ? query : query.toLowerCase();
        const fileResults = [];
        for (const file of files) {
          const fRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${file.path}${ref}`, { headers: ghH(td.github_pat) });
          if (!fRes.ok) continue;
          const fd = await fRes.json() as GitHubFileData;
          let content: string; try { content = await fetchContent(fd, td.github_pat); } catch { continue; }
          const { content: norm } = normCRLF(content);
          const lines = norm.split('\n'), matches = [];
          for (let i = 0; i < lines.length && matches.length < maxPF; i++) {
            const lt = cs ? lines[i] : lines[i].toLowerCase();
            if (lt.includes(sq)) matches.push({ line: i + 1, col: lt.indexOf(sq) + 1, text: lines[i], context_before: lines.slice(Math.max(0, i - cx), i), context_after: lines.slice(i + 1, Math.min(lines.length, i + 1 + cx)) });
          }
          if (matches.length > 0) fileResults.push({ file: file.path, size: file.size, total_matches: matches.length, matches });
        }
        console.log(`github-search-dir ${owner}/${repo}/${dir} q=${query} files=${files.length} matched=${fileResults.length}`);
        return j({ query, dir: dir || '/', file_pattern: pattern, files_searched: files.length, files_matched: fileResults.length, results: fileResults });
      }

      if (!owner || !repo || !filePath) return j({ error: 'invalid_request', error_description: 'Required: owner, repo, path' }, 400);
      const ref = branch ? `?ref=${encodeURIComponent(branch)}` : '';
      const fileRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${filePath}${ref}`, { headers: ghH(td.github_pat) });
      if (!fileRes.ok) { const eb = await fileRes.json().catch(() => ({ message: 'Failed to fetch file' })) as { message: string }; return j({ error: 'github_error', status: fileRes.status, message: eb.message, owner, repo, path: filePath }, fileRes.status); }
      const fd = await fileRes.json() as GitHubFileData;
      if (Array.isArray(fd)) return j({ error: 'invalid_request', error_description: `${filePath} is a directory` }, 422);
      let rawContent: string;
      try { rawContent = await fetchContent(fd, td.github_pat); }
      catch (e) { return j({ error: 'invalid_request', error_description: (e as Error).message, size_bytes: fd.size }, 422); }
      const sha = fd.sha, isLarge = fd.size > 1048576, format = detectFormat(filePath);

      if (p === '/github-read') {
        console.log(`github-read ${owner}/${repo}/${filePath} size=${rawContent.length}${isLarge ? ' large' : ''}`);
        return j({ content: rawContent, sha, size: fd.size, path: fd.path, name: fd.name, html_url: fd.html_url, lines: rawContent.split('\n').length, chars: rawContent.length, format, is_large_file: isLarge });
      }
      if (p === '/github-read-section') {
        const { content: norm } = normCRLF(rawContent), lines = norm.split('\n'), total = lines.length;
        const sl = Math.max(1, parseInt(String(body.start_line ?? 1)));
        const el = body.end_line != null ? Math.min(total, parseInt(String(body.end_line))) : total;
        const cx = Math.min(Math.max(parseInt(String(body.context_lines ?? 0)), 0), 50);
        if (sl > total) return j({ error: 'invalid_request', error_description: `start_line (${sl}) exceeds file length (${total})`, total_lines: total }, 422);
        if (sl > el) return j({ error: 'invalid_request', error_description: `start_line must be ≤ end_line` }, 422);
        const as = Math.max(1, sl - cx), ae = Math.min(total, el + cx), section = lines.slice(as - 1, ae).join('\n');
        return j({ content: section, sha, path: fd.path, start_line: as, end_line: ae, requested_start: sl, requested_end: el, context_lines: cx, total_lines: total, section_lines: ae - as + 1, section_chars: section.length, is_large_file: isLarge });
      }
      if (p === '/github-outline') {
        const { content: norm } = normCRLF(rawContent);
        console.log(`github-outline ${owner}/${repo}/${filePath} format=${format}`);
        if (format === 'markdown') { const o = outlineMd(norm); return j({ format, path: fd.path, sha, size: fd.size, total_lines: norm.split('\n').length, total_chars: norm.length, is_large_file: isLarge, ...o }); }
        if (format === 'json') { try { const parsed = JSON.parse(norm); const isArr = Array.isArray(parsed); const keys = !isArr && typeof parsed === 'object' && parsed !== null ? Object.keys(parsed as Record<string, unknown>) : null; return j({ format, path: fd.path, sha, size: fd.size, total_chars: norm.length, is_array: isArr, array_length: isArr ? (parsed as unknown[]).length : null, top_level_keys: keys }); } catch { return j({ format, path: fd.path, sha, size: fd.size, error: 'json_parse_error' }); } }
        const lines = norm.split('\n'); return j({ format, path: fd.path, sha, size: fd.size, total_lines: lines.length, total_chars: norm.length });
      }
      if (p === '/github-search') {
        const query = body.query as string;
        if (!query) return j({ error: 'invalid_request', error_description: 'Required: query' }, 400);
        const cx = Math.min(Math.max(parseInt(String(body.context_lines ?? 3)), 0), 20);
        const mx = Math.min(Math.max(parseInt(String(body.max_matches ?? 50)), 1), 200);
        const cs = body.case_sensitive === true;
        const { content: norm } = normCRLF(rawContent), lines = norm.split('\n'), sq = cs ? query : query.toLowerCase();
        const matches: Array<{ line: number; col: number; text: string; context_before: string[]; context_after: string[] }> = [];
        for (let i = 0; i < lines.length && matches.length < mx; i++) {
          const lt = cs ? lines[i] : lines[i].toLowerCase(); let col = lt.indexOf(sq);
          while (col !== -1 && matches.length < mx) { matches.push({ line: i + 1, col: col + 1, text: lines[i], context_before: lines.slice(Math.max(0, i - cx), i), context_after: lines.slice(i + 1, Math.min(lines.length, i + 1 + cx)) }); col = lt.indexOf(sq, col + sq.length); }
        }
        console.log(`github-search ${owner}/${repo}/${filePath} q=${query} matches=${matches.length}`);
        return j({ query, case_sensitive: cs, path: fd.path, sha, file_lines: lines.length, file_chars: norm.length, total_matches: matches.length, truncated: matches.length >= mx, matches });
      }
      if (p === '/github-patch') {
        const { wasCRLF, content: current } = normCRLF(rawContent);
        let patches: Patch[];
        if (Array.isArray((body as Record<string, unknown>).patches)) {
          patches = ((body as Record<string, unknown>).patches as Array<Record<string, string>>).map(pt => ({ old_str: pt.old_str, new_str: pt.new_str }));
          if (patches.length === 0) return j({ error: 'invalid_request', error_description: 'patches array cannot be empty' }, 400);
        } else {
          const { old_str, new_str } = body as { old_str?: string; new_str?: string };
          if (!old_str && old_str !== '') return j({ error: 'invalid_request', error_description: 'Required: old_str' }, 400);
          if (new_str === undefined || new_str === null) return j({ error: 'invalid_request', error_description: 'Required: new_str' }, 400);
          if (old_str === '') return j({ error: 'invalid_request', error_description: 'old_str cannot be empty — use /github-append' }, 400);
          patches = [{ old_str, new_str }];
        }
        patches = patches.map(pt => ({ old_str: pt.old_str.replace(/\r\n/g, '\n'), new_str: pt.new_str }));
        let patchResult: { newContent: string; results: PatchResult[] };
        try { patchResult = applyPatches(current, patches); }
        catch (e) { if ((e as Record<string, unknown>).error) return j(e as Record<string, unknown>, 422); return j({ error: 'patch_failed', error_description: String(e) }, 500); }
        const { newContent, results } = patchResult, totalDelta = results.reduce((s, r) => s + r.delta, 0);
        if (dryRun) return j({ dry_run: true, would_change: newContent !== current, patches_applied: results, chars_before: rawContent.length, chars_after: newContent.length, total_delta: totalDelta, lines_before: rawContent.split('\n').length, lines_after: newContent.split('\n').length, crlf_normalized: wasCRLF });
        const commitMsg = (body.message as string) || (patches.length === 1 ? `docs: patch ${filePath.split('/').pop()}` : `docs: multi-patch ${filePath.split('/').pop()} (${patches.length} changes)`);
        try { const res = await writeFile(owner, repo, filePath, branch, newContent, sha, commitMsg, td.github_pat); if (!skipIndex) ctx.waitUntil(updateIndex(owner, repo, branch, filePath, newContent, res.sha_after, td.github_pat)); console.log(`github-patch ${owner}/${repo}/${filePath} patches=${patches.length}${wasCRLF ? ' crlf' : ''} commit=${res.commit.slice(0, 8)}`); return j({ success: true, path: filePath, sha_before: sha, sha_after: res.sha_after, commit: res.commit, commit_url: res.commit_url, patches_applied: results, chars_before: rawContent.length, chars_after: newContent.length, total_delta: totalDelta, crlf_normalized: wasCRLF }); }
        catch (e) { return j(e as Record<string, unknown>, (e as Record<string, unknown>).status as number || 500); }
      }
      if (p === '/github-append') {
        const ac = body.content as string;
        if (!ac) return j({ error: 'invalid_request', error_description: 'Required: content' }, 400);
        const sep = body.separator !== undefined ? body.separator as string : (rawContent.endsWith('\n') ? '' : '\n');
        const newContent = rawContent + sep + ac;
        if (dryRun) return j({ dry_run: true, chars_added: ac.length + sep.length, chars_before: rawContent.length, chars_after: newContent.length });
        const commitMsg = (body.message as string) || `docs: append to ${filePath.split('/').pop()}`;
        try { const res = await writeFile(owner, repo, filePath, branch, newContent, sha, commitMsg, td.github_pat); if (!skipIndex) ctx.waitUntil(updateIndex(owner, repo, branch, filePath, newContent, res.sha_after, td.github_pat)); console.log(`github-append ${owner}/${repo}/${filePath} +${ac.length}chars commit=${res.commit.slice(0, 8)}`); return j({ success: true, path: filePath, sha_before: sha, sha_after: res.sha_after, commit: res.commit, commit_url: res.commit_url, chars_added: ac.length + sep.length, chars_before: rawContent.length, chars_after: newContent.length }); }
        catch (e) { return j(e as Record<string, unknown>, (e as Record<string, unknown>).status as number || 500); }
      }
      if (p === '/github-replace-section') {
        const sectionHeading = body.section_heading as string, newSectionContent = body.new_content as string;
        if (!sectionHeading) return j({ error: 'invalid_request', error_description: 'Required: section_heading' }, 400);
        if (newSectionContent === undefined || newSectionContent === null) return j({ error: 'invalid_request', error_description: 'Required: new_content' }, 400);
        const { content: norm, wasCRLF } = normCRLF(rawContent), lines = norm.split('\n');
        const bounds = findSectionBounds(lines, sectionHeading);
        if (!bounds) return j({ error: 'not_found', error_description: `Section not found: "${sectionHeading}"`, hint: 'Use /github-outline to list available sections', path: filePath, total_lines: lines.length }, 422);
        const { content: newNorm } = normCRLF(newSectionContent);
        const newLines = [...lines.slice(0, bounds.start), ...newNorm.split('\n'), ...lines.slice(bounds.end)];
        const newContent = newLines.join('\n'), delta = newContent.length - norm.length;
        if (dryRun) return j({ dry_run: true, section: sectionHeading, replaced_lines: { start: bounds.start + 1, end: bounds.end }, chars_before: rawContent.length, chars_after: newContent.length, delta, lines_before: lines.length, lines_after: newLines.length });
        const commitMsg = (body.message as string) || `docs: replace section "${sectionHeading}" in ${filePath.split('/').pop()}`;
        try { const res = await writeFile(owner, repo, filePath, branch, newContent, sha, commitMsg, td.github_pat); if (!skipIndex) ctx.waitUntil(updateIndex(owner, repo, branch, filePath, newContent, res.sha_after, td.github_pat)); console.log(`github-replace-section ${owner}/${repo}/${filePath} section="${sectionHeading}" commit=${res.commit.slice(0, 8)}`); return j({ success: true, path: filePath, sha_before: sha, sha_after: res.sha_after, commit: res.commit, commit_url: res.commit_url, section: sectionHeading, replaced_lines: { start: bounds.start + 1, end: bounds.end }, chars_before: rawContent.length, chars_after: newContent.length, delta, crlf_normalized: wasCRLF }); }
        catch (e) { return j(e as Record<string, unknown>, (e as Record<string, unknown>).status as number || 500); }
      }
      if (p === '/github-json-patch') {
        if (format !== 'json') return j({ error: 'invalid_request', error_description: `File is not JSON (detected: ${format}). Use /github-patch for non-JSON files.` }, 422);
        const ops = body.operations as JsonOperation[];
        if (!Array.isArray(ops) || ops.length === 0) return j({ error: 'invalid_request', error_description: 'Required: operations array [{op, path, value}]' }, 400);
        let patchResult: { newJson: string; applied: Array<{ path: string; op: string; before: JsonVal; after: JsonVal }> };
        try { patchResult = applyJsonOps(rawContent, ops); }
        catch (e) { if ((e as Record<string, unknown>).error) return j(e as Record<string, unknown>, 422); if (e instanceof SyntaxError) return j({ error: 'json_parse_error', error_description: e.message }, 422); return j({ error: 'json_patch_failed', error_description: String(e) }, 500); }
        const { newJson, applied } = patchResult, delta = newJson.length - rawContent.length;
        if (dryRun) return j({ dry_run: true, operations_applied: applied, chars_before: rawContent.length, chars_after: newJson.length, delta });
        const commitMsg = (body.message as string) || `data: json-patch ${filePath.split('/').pop()} (${ops.length} op${ops.length > 1 ? 's' : ''})`;
        try { const res = await writeFile(owner, repo, filePath, branch, newJson, sha, commitMsg, td.github_pat); if (!skipIndex) ctx.waitUntil(updateIndex(owner, repo, branch, filePath, newJson, res.sha_after, td.github_pat)); console.log(`github-json-patch ${owner}/${repo}/${filePath} ops=${ops.length} commit=${res.commit.slice(0, 8)}`); return j({ success: true, path: filePath, sha_before: sha, sha_after: res.sha_after, commit: res.commit, commit_url: res.commit_url, operations_applied: applied, chars_before: rawContent.length, chars_after: newJson.length, delta }); }
        catch (e) { return j(e as Record<string, unknown>, (e as Record<string, unknown>).status as number || 500); }
      }
      if (p === '/github-table-upsert') {
        const tableAnchor = body.table_anchor as string, keyColumn = parseInt(String(body.key_column ?? 0)), keyValue = body.key_value as string, newRow = body.row as string;
        if (!tableAnchor) return j({ error: 'invalid_request', error_description: 'Required: table_anchor' }, 400);
        if (keyValue === undefined || keyValue === null) return j({ error: 'invalid_request', error_description: 'Required: key_value' }, 400);
        if (!newRow) return j({ error: 'invalid_request', error_description: 'Required: row' }, 400);
        const { content: norm, wasCRLF } = normCRLF(rawContent), lines = norm.split('\n');
        const tableInfo = parseTableAt(lines, tableAnchor);
        if (!tableInfo) return j({ error: 'not_found', error_description: `Table with anchor "${tableAnchor}" not found`, hint: 'Use /github-outline to list tables', path: filePath }, 422);
        const { newLines, action, rowLine } = upsertTableRow(lines, tableInfo, keyColumn, keyValue, newRow);
        const newContent = newLines.join('\n'), delta = newContent.length - norm.length;
        if (dryRun) return j({ dry_run: true, action, row_line: rowLine, key_value: keyValue, chars_before: rawContent.length, chars_after: newContent.length, delta });
        const commitMsg = (body.message as string) || `docs: table-upsert ${action} row "${keyValue}" in ${filePath.split('/').pop()}`;
        try { const res = await writeFile(owner, repo, filePath, branch, newContent, sha, commitMsg, td.github_pat); if (!skipIndex) ctx.waitUntil(updateIndex(owner, repo, branch, filePath, newContent, res.sha_after, td.github_pat)); console.log(`github-table-upsert ${owner}/${repo}/${filePath} action=${action} key="${keyValue}" commit=${res.commit.slice(0, 8)}`); return j({ success: true, path: filePath, sha_before: sha, sha_after: res.sha_after, commit: res.commit, commit_url: res.commit_url, action, row_line: rowLine, key_value: keyValue, table_header_line: tableInfo.headerLine + 1, chars_before: rawContent.length, chars_after: newContent.length, delta, crlf_normalized: wasCRLF }); }
        catch (e) { return j(e as Record<string, unknown>, (e as Record<string, unknown>).status as number || 500); }
      }
    }

    if (p === '/mcp' || p.startsWith('/mcp/')) {
      const ah = req.headers.get('Authorization');
      if (!ah || !ah.startsWith('Bearer ')) return j({ error: 'unauthorized' }, 401);
      const tok = ah.slice(7);
      const td = await env.OAUTH_KV.get(`token:${tok}`, 'json') as TokenData | null;
      if (!td) return j({ error: 'unauthorized', error_description: 'Token not found or expired' }, 401);
      const ph = new Headers();
      for (const [k, v] of req.headers.entries())
        if (['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'accept-encoding'].includes(k.toLowerCase())) ph.set(k, v);
      ph.set('Authorization', `Bearer ${td.github_pat}`); ph.set('User-Agent', 'github-mcp-proxy/1.0');
      const up = await fetch('https://api.githubcopilot.com/mcp/', { method: req.method, headers: ph, body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined });
      console.log(`proxy for=${td.github_login || 'unknown'} ${req.method} upstream=${up.status}`);
      const rh = new Headers(up.headers); Object.entries(CORS).forEach(([k, v]) => rh.set(k, v));
      return new Response(up.body, { status: up.status, statusText: up.statusText, headers: rh });
    }

    if (p === '/' || p === '')
      return j({ name: 'github-mcp-proxy', version: '4.0.0', mcp: `${env.WORKER_URL}/mcp`, upstream: 'https://api.githubcopilot.com/mcp/', tools: '80+', editing: { endpoints: ['/github-read', '/github-read-section', '/github-outline', '/github-patch', '/github-append', '/github-search', '/github-replace-section', '/github-json-patch', '/github-table-upsert', '/github-search-dir'], features: ['dry_run:true', '_index.json auto', 'CRLF normalization', '>1MB support', 'multi-patch', 'JSONPath ops'] } });

    return new Response('Not found', { status: 404, headers: CORS });
  },
};
