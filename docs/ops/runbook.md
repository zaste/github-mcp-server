# github-mcp-proxy — Runbook de Infraestructura
> `yessicavs/github-mcp-server` · Ops@growthxy.com
> Actualizado: 2026-04-06 · commit `0ea523d9`
> Mantenedor: @zaste · Worker: github-mcp-proxy v4.0.0

---

## 1. Visión general

`github-mcp-proxy` es un Cloudflare Worker que actúa como puente OAuth
entre Claude.ai web y el endpoint oficial de GitHub MCP
(`api.githubcopilot.com/mcp/`). El endpoint oficial requiere autenticación
via GitHub PAT, pero Claude.ai exige OAuth 2.0 con PKCE. Este Worker
implementa el servidor de autorización completo, almacena el PAT del usuario
en KV, y lo inyecta en cada request proxiado hacia el upstream.

El Worker también expone diez endpoints HTTP de edición de documentos que
permiten operar sobre archivos del repositorio sin pasar el contenido completo
por el transporte MCP, resolviendo el límite de contexto para archivos grandes.

### Arquitectura

```
Claude.ai web
    │  OAuth 2.0 + PKCE
    │  (register → authorize → token → refresh)
    ▼
github-mcp-proxy.ops-e1a.workers.dev   ← este Worker (v4.0.0)
    │  KV: github-mcp-proxy-OAUTH
    │  Bearer <github_pat> inyectado por Worker
    ▼
api.githubcopilot.com/mcp/             ← github/github-mcp-server v0.32.0
    │  streamable-HTTP (no SSE)
    ▼
GitHub API (REST + GraphQL)
    │  80+ herramientas: repos, issues, PRs, Actions, Projects,
    │  Discussions, Releases, Security, Gists, Notifications...
    ▼
github.com
```

### Por qué existe este Worker

El Worker anterior (`shared-github-mcp-server-1`, v9) implementaba 50
herramientas propias sobre Durable Objects + PartyKit + SSE. Tenía tres
problemas críticos de producción:

1. **DO storage leak** — >2.000 instancias SQLite acumuladas desde Jun 2025,
   sin cleanup. Crecimiento lineal e ilimitado.
2. **Cancelaciones SSE 25,7%** — 1.971 invocaciones canceladas en 7 días
   (avg 38.804ms) por timeout del layer stateless antes de que el DO
   respondiera.
3. **OAuth 401s semanales** — 35 errores/semana por ausencia de refresh token.

`github-mcp-proxy` resuelve los tres por diseño: sin DOs (sin leak),
streamable-HTTP (sin SSE timeout), refresh token con TTL 30 días.

---

## 2. Recursos de Cloudflare

| Recurso | Nombre | ID / URL |
|---|---|---|
| Cuenta | Ops@growthxy.com | `e1a6f9414e9b47f056d1731ab791f4db` |
| Subdominio | — | `ops-e1a` |
| Worker activo | `github-mcp-proxy` | `github-mcp-proxy.ops-e1a.workers.dev` |
| Worker deprecado | `shared-github-mcp-server-1` | `shared-github-mcp-server-1.ops-e1a.workers.dev` |
| Worker Neo4j | `mcp-neo4j-cypher` | `mcp-neo4j-cypher.ops-e1a.workers.dev` |
| KV (proxy OAuth) | `github-mcp-proxy-OAUTH` | `20cb14eff6cf4a9cbc7d0119018f0876` |
| KV (old GitHub) | `OAUTH_KV` | `56e6c4086dae474aa3e0e9574aa3813c` |

### Versiones desplegadas — historial completo

| Versión | Fecha | etag | Cambios principales |
|---|---|---|---|
| v1.0 | 2026-04-05 | `3a1bc2f0` | OAuth proxy inicial, flujo completo PKCE |
| v1.1 | 2026-04-05 | `7d4ef891` | Fix `/.well-known/oauth-protected-resource` (RFC 9728) |
| v1.2 | 2026-04-05 | `2c8ab345` | Fix PKCE code_challenge verification |
| v1.3 | 2026-04-05 | `9e7dc012` | Test diagnóstico (error — revertido) |
| v1.4 | 2026-04-05 | `12d4b546` | Restore OAuth correcto |
| v2.0 | 2026-04-05 | `4f9bc781` | Add `/github-read`, `/github-patch`, `/github-append` |
| v3.0 | 2026-04-05 | `e0498759` | CRLF normalization, multi-patch, `/github-search` |
| v3.1 | 2026-04-05 | `82f45ec0` | Add `/github-read-section` (líneas N-M + context) |
| **v4.0** | **2026-04-06** | **`0f1b466f`** | `/github-outline`, `/github-replace-section`, `/github-json-patch`, `/github-table-upsert`, `/github-search-dir`, `dry_run`, `_index.json` auto |

---

## 3. Endpoints MCP (upstream)

El Worker no implementa ninguna herramienta — todo se proxia a
`api.githubcopilot.com/mcp/` → `github/github-mcp-server` v0.32.0.

### Herramientas nuevas vs Worker viejo

Las 32 herramientas que **solo tiene el nuevo proxy**:

**GitHub Actions / CI/CD**
- `actions_list`, `actions_get`, `actions_run_trigger`, `get_job_logs`

**GitHub Projects v2**
- `projects_list`, `projects_get`, `projects_write`

**Discussions**
- `list_discussions`, `get_discussion`, `get_discussion_comments`,
  `list_discussion_categories`

**Releases, Tags, Stars**
- `list_releases` ✅, `get_latest_release` ✅, `get_release_by_tag` ✅
- `list_tags`, `get_tag`, `star_repository`, `list_starred_repositories`

**Labels, Gists, Security Advisories**
- `get_label` ✅, `list_label`, `label_write`
- `list_gists`, `get_gist`, `create_gist`, `update_gist`
- `list_global_security_advisories`, `get_global_security_advisory`
- `list_repository_security_advisories`

**Otros exclusivos**
- `delete_file`, `get_repository_tree`, `search_orgs`, `sub_issue_write`
- `search_pull_requests` ✅ (140 PRs open en github/github-mcp-server)
- `get_diff` ✅ (diff línea a línea en PRs), `get_check_runs`
- `get_teams` ✅ (8 orgs detectadas), `get_team_members`
- `assign_copilot_to_issue`, `list_issue_types`

### Gaps (5 herramientas perdidas del Worker viejo)

| Herramienta perdida | Impacto | Workaround |
|---|---|---|
| `list_repositories_by_org` | **Medio** — único gap funcional real | `search_repositories` con `org:nombre` |
| `get_issue_events` | Bajo | Usar `issue_read get` para estado |
| `get_issue_timeline` | Bajo | Combinar `get` + `get_comments` |
| `update_dependabot_alert` | Bajo | Solo lectura de alertas disponible |
| `list_repositories` plano | Mínimo | `search_repositories` cubre 95% |

---

## 4. Endpoints de edición de documentos (v4.0)

Todos requieren `Authorization: Bearer <token>` y aceptan el token
OAuth del flujo Claude.ai o un PAT directo (`ghp_*`, `github_pat_*`).

### Parámetros comunes

```typescript
interface BaseRequest {
  owner: string;        // dueño del repositorio
  repo: string;         // nombre del repositorio
  path: string;         // ruta del archivo (excepto /github-search-dir)
  branch?: string;      // rama opcional (default: rama por defecto)
  dry_run?: boolean;    // preview sin commitear (default: false)
  skip_index?: boolean; // no actualizar _index.json (default: false)
}
```

### Tabla de endpoints

| Endpoint | Versión | Propósito | Cuándo usar |
|---|---|---|---|
| `POST /github-read` | v2.0 | Lee archivo completo como UTF-8 | Archivos ≤70KB |
| `POST /github-read-section` | v3.1 | Lee líneas N-M con context_lines | Docs grandes — leer solo la sección |
| `POST /github-outline` | v4.0 | Estructura sin leer contenido | Orientarse en doc grande, primera llamada |
| `POST /github-patch` | v2.0+ | str_replace — single o multi-patch | Edición quirúrrgica, cualquier tamaño |
| `POST /github-append` | v2.0 | Añade al final del archivo | Changelogs, listas append-only |
| `POST /github-search` | v3.0 | Busca string con contexto | Localizar antes de parchear |
| `POST /github-replace-section` | v4.0 | Reemplaza sección completa | Secciones largas sin old_str único |
| `POST /github-json-patch` | v4.0 | JSONPath ops sobre JSON | Archivos JSON con estructura repetitiva |
| `POST /github-table-upsert` | v4.0 | Upsert fila en tabla markdown | Tablas con datos cambiantes por clave |
| `POST /github-search-dir` | v4.0 | Busca en directorio completo | Referencias cruzadas, renombrar |

### /github-outline — respuesta ejemplo

```json
{
  "format": "markdown",
  "total_lines": 82,
  "total_chars": 3561,
  "sections": [
    { "level": 1, "title": "Documento de Test", "line_start": 1, "line_end": 9 },
    { "level": 2, "title": "Estado del sistema", "line_start": 11, "line_end": 20 },
    { "level": 2, "title": "Inventario de Workers", "line_start": 22, "line_end": 28 }
  ],
  "tables": [
    { "line": 23, "header": "| Worker | Versión | Estado |", "col_count": 4 }
  ],
  "code_blocks": [
    { "line_start": 41, "line_end": 46, "lang": "mermaid" },
    { "line_start": 48, "line_end": 54, "lang": "typescript" }
  ],
  "frontmatter": false
}
```

### /github-json-patch — operaciones soportadas

```json
{
  "owner": "yessicavs",
  "repo": "github-mcp-server",
  "path": "docs/ops/test-data.json",
  "operations": [
    { "op": "set",    "path": "$.updated_at",                                    "value": "2026-04-06T00:00:00Z" },
    { "op": "set",    "path": "$.workers[?(@.name=='github-mcp-proxy')].version", "value": "4.0.0" },
    { "op": "push",   "path": "$.workers",                                        "value": { "name": "new-worker" } },
    { "op": "delete", "path": "$.config.deprecated_key",                          "value": null },
    { "op": "merge",  "path": "$.config",                                         "value": { "logpush_enabled": true } }
  ]
}
```

JSONPath soportado: `$.key`, `$.obj.key`, `$.arr[N]`, `$.arr[?(@.field=='val')].subkey`

### Errores comunes y soluciones

| Error | Status | Causa | Solución |
|---|---|---|---|
| `not_found` | 422 | `old_str` no encontrado | `/github-read` para ver contenido actual |
| `ambiguous` | 422 | `old_str` aparece >1 vez | Añadir más contexto alrededor |
| `conflict` | 409 | SHA desactualizado | Re-leer con `/github-read` y reintentar |
| `path_not_found` | 422 | JSONPath no resuelve | Verificar estructura con `/github-outline` |
| `not_array` | 422 | `push` sobre no-array | Verificar tipo del campo target |
| `json_parse_error` | 422 | JSON malformado | Validar JSON antes de parchear |

---

## 5. _index.json — índice estructural automático

Tras cada escritura exitosa via los endpoints del Worker, se actualiza
`_index.json` en el mismo directorio en background via `ctx.waitUntil`.
El índice nunca falla la operación principal — si la actualización falla
silenciosamente, el archivo queda desactualizado pero el commit se realizó.

### Estructura

```json
{
  "version": "1.0",
  "last_updated": "2026-04-06T00:00:00Z",
  "files": {
    "docs/ops/README.md": {
      "sha": "52f9c7f5...",
      "size": 3910,
      "format": "markdown",
      "lines": 96,
      "updated_at": "2026-04-05T21:47:26Z",
      "frontmatter": false,
      "code_blocks": 3,
      "tables": [],
      "sections": [
        { "level": 2, "title": "Stack actual", "anchor": "stack-actual",
          "line_start": 31, "line_end": 40 }
      ]
    },
    "docs/ops/test-data.json": {
      "sha": "203ebe15...",
      "format": "json",
      "top_level_keys": ["version", "updated_at", "workers", "metrics", "config"],
      "is_array": false
    }
  }
}
```

### Flujo de sesión nueva con _index.json

```
1. get_file_contents("docs/ops/_index.json")   ← ~5KB, O(1) en tamaño del directorio
   → sé dónde está cada sección de cada archivo, SHA actuales

2. /github-read-section(start=31, end=40)       ← leo solo las 10 líneas que necesito
   → contenido exacto + SHA del archivo

3. /github-patch(old_str="...", new_str="...")   ← parcho con SHA fresco
   → commit atómico + _index.json actualizado en background
```

---

## 6. OAuth — flujo completo

### Registro dinámico (RFC 7591)

```
POST /oauth/register
{ "redirect_uris": ["https://claude.ai/..."], "client_name": "Claude" }
→ 201 { client_id, client_secret, registration_access_token }
```

Clientes se almacenan en KV con TTL 1 año: `client:{client_id}`.

### Autorización (PKCE S256)

```
GET /oauth/authorize?client_id=...&redirect_uri=...&code_challenge=...&code_challenge_method=S256
→ 200 HTML (formulario para introducir PAT de GitHub)

POST /oauth/authorize
{ client_id, redirect_uri, state, code_challenge, code_challenge_method, pat }
→ 302 redirect a redirect_uri?code=...&state=...
```

El PAT se valida contra `api.github.com/user` antes de emitir el código.
El código tiene TTL 5 minutos.

### Token

```
POST /oauth/token
{ grant_type: "authorization_code", code, code_verifier }
→ { access_token, token_type: "Bearer", expires_in: 28800,
    refresh_token, scope: "repo read:org notifications workflow" }
```

Tokens almacenados en KV: `token:{at}` → `{ github_pat, github_login, ... }`.
Refresh tokens: `refresh:{rt}` → `{access_token}`. TTL 30 días, rotación en uso.

### Refresh

```
POST /oauth/token
{ grant_type: "refresh_token", refresh_token }
→ { access_token (nuevo), refresh_token (nuevo) }
```

El par anterior se elimina atómicamente. El refresh token se rota en cada uso.

---

## 7. Observabilidad

### Estado actual

| Métrica | Valor | Período |
|---|---|---|
| Total invocaciones | ~45 | 2026-04-05 (día de deploy) |
| Errores | 0 | mismo período |
| POST `/mcp` | 14 | mismo período |
| GET `/mcp` | 5 | mismo período |
| Token refreshes | 2 | mismo período |
| `upstream=200` | 12 | mismo período |
| `upstream=202` | 2 | mismo período |
| `upstream=405` | 5 | GET /mcp → 405 por diseño |

### Logs disponibles (7 días, sin Logpush)

Cada invocación loguea:
- `{METHOD} {pathname}` en todas las requests
- `proxy for={login} {METHOD} upstream={status}` en requests MCP
- `github-{endpoint} {owner}/{repo}/{path} ...` en endpoints de edición
- `token issued for {login}` en emisión de tokens

### Logpush — PENDIENTE

Los logs actuales se pierden a los 7 días. Para retención histórica:

```bash
# Activar Logpush — estimado 30 minutos
wrangler tail github-mcp-proxy | tee -a /var/log/mcp-proxy.jsonl
# O configurar Logpush a R2 via Dashboard
```

Configuración sugerida: R2 bucket `ops-logs`, prefijo `github-mcp-proxy/`,
retención 90 días.

---

## 8. Gaps pendientes y plan de acción

### P1 — Logging de tool name (alta visibilidad, ~10 líneas)

El Worker no sabe qué herramienta específica ejecutó el upstream. Los logs
solo muestran `proxy for=zaste POST upstream=200` pero no
`tool=list_releases repo=github/github-mcp-server`.

Fix en el handler `/mcp`:

```typescript
// Antes del fetch al upstream, interceptar el body JSON-RPC
const bodyClone = await req.clone().json().catch(() => null);
const toolName = bodyClone?.params?.name || bodyClone?.method || 'unknown';
console.log(`tool=${toolName} user=${td.github_login}`);
```

Impacto: visibilidad completa de qué herramientas se usan y con qué frecuencia.
Esfuerzo: ~15 minutos. Sin riesgo.

### P2 — PAT scope read:org para osiris-intelligence (5 minutos)

`list_repositories_by_org("osiris-intelligence")` devuelve 0 repos. El
problema no es el Worker sino el scope del PAT. El PAT activo de `zaste`
no tiene `read:org` para esa organización específica.

Fix: regenerar el PAT con el scope `read:org` añadido, reconectar el
conector en Claude.ai.

### P3 — Activar Logpush (30 minutos)

Ver sección 7. Sin esto los logs se pierden a los 7 días y no hay forma
de auditar retroactivamente.

### P4 — Deprecar shared-github-mcp-server-1 (coordinado)

El Worker viejo sigue activo en `ops-e1a`. No tiene usuarios activos
conocidos después de la migración a `github-mcp-proxy`. Borrar los DO
orphaned y el Worker en la próxima ventana de mantenimiento.

```bash
# Verificar que no tiene tráfico antes de borrar
# Si 0 invocaciones en 7 días → seguro eliminar
wrangler delete shared-github-mcp-server-1
```

---

## 9. Workflow operacional recomendado

### Editar un documento pequeño (<30KB)

```
1. get_file_contents → obtener contenido y SHA
2. create_or_update_file → escribir con SHA
```

### Editar un documento mediano (30-70KB)

```
1. /github-search → localizar la sección
2. /github-patch → reemplazar con old_str + new_str
```

### Editar un documento grande (>70KB)

```
1. get_file_contents("_index.json") → orientarse sin tocar el documento
2. /github-read-section(start=N, end=M) → leer solo la sección
3. /github-patch o /github-replace-section → editar
4. /github-patch sobre línea "Actualizado:" → actualizar frontmatter
```

### Actualizar datos estructurados (JSON)

```
1. /github-outline → verificar top_level_keys y estructura
2. /github-json-patch(operations=[...]) → operaciones atómicas JSONPath
```

### Actualizar tabla de inventario

```
1. /github-table-upsert(table_anchor="| Worker |", key_value="worker-name", row="...")
   → update si existe, insert si no existe
```

### Encontrar referencias cruzadas antes de renombrar

```
1. /github-search-dir(dir="docs", query="nombre-actual", file_pattern="*.md")
   → lista todos los archivos que lo referencian
2. Para cada archivo: /github-patch con old_str=nombre-actual, new_str=nombre-nuevo
```

---

## 10. Seguridad

### Tokens y secretos

- Los PAT de GitHub **nunca** aparecen en logs (solo `github_login`)
- Los tokens OAuth son strings aleatorios de 48 caracteres (`crypto.getRandomValues`)
- Los códigos de autorización expiran en 5 minutos y se eliminan al usar
- El PKCE S256 verifica que quien intercambia el código es quien generó el challenge
- Los refresh tokens rotan en cada uso — un refresh token usado dos veces
  indica compromiso

### Superficie de ataque

El Worker no expone ningún dato de GitHub directamente — solo proxia.
Un atacante con acceso al KV podría obtener PATs de GitHub de los usuarios.
El KV `github-mcp-proxy-OAUTH` solo tiene acceso via este Worker.

### Rotación de PAT

Si un PAT se compromete:
1. Revocar el PAT en GitHub → `github.com/settings/tokens`
2. Las sesiones activas fallarán en el siguiente request MCP
3. El usuario debe reconectar el conector en Claude.ai con un nuevo PAT

No hay mecanismo de revocación activa de tokens OAuth desde el Worker.

---

## 11. Decisiones de diseño

### ¿Por qué no implementar las herramientas nosotros mismos?

El Worker viejo implementaba 50 herramientas propias. GitHub actualiza
`github-mcp-server` frecuentemente (v0.32.0 al momento de escribir esto,
con 28K stars). Mantener herramientas propias significaría seguir los
cambios de la GitHub API manualmente, perder herramientas nuevas que GitHub
añade, y debuggear comportamientos que GitHub ya corrigió. El proxy puro
recibe automáticamente cada versión nueva del upstream.

### ¿Por qué Cloudflare Workers y no un servidor propio?

- Sin infraestructura propia que mantener
- Cold start <10ms (Workers es V8 Isolates, no containers)
- KV global para tokens (latencia baja desde cualquier región)
- 100K requests/día en el free tier — más que suficiente para uso interno

### ¿Por qué los endpoints de edición HTTP en lugar de herramientas MCP?

Las herramientas MCP tienen un límite práctico de contexto. Un archivo de
70KB serializado como base64 ocupa ~95KB de JSON, consumiendo una fracción
significativa del contexto de conversación. Los endpoints HTTP devuelven
solo la sección relevante (<5KB típicamente) y escriben sin que el
contenido completo pase por el transporte.

Los 5 endpoints v4.0 (`outline`, `replace-section`, `json-patch`,
`table-upsert`, `search-dir`) añaden semántica por formato: operan sobre
la estructura del documento en lugar de strings arbitrarios.

### ¿Por qué _index.json en lugar de leer el árbol en cada sesión?

`get_repository_tree` devuelve el árbol de archivos pero no el outline
de cada documento. Para saber que la sección "Arquitectura" está en las
líneas 47-201 del archivo `audit.md`, habría que leer ese archivo.
Con `_index.json` esa información está disponible en una sola lectura de
~5KB, independiente del tamaño total del directorio.

---

## 12. Changelog

- **2026-04-06** — v4.0.0: `/github-outline`, `/github-replace-section`,
  `/github-json-patch`, `/github-table-upsert`, `/github-search-dir`,
  `dry_run:true`, `_index.json` auto. Fuente TypeScript y seed de `_index.json`
  commiteados al repo.
- **2026-04-05** — v3.1.0: `/github-read-section` (líneas N-M con context_lines).
  `cloudflare-worker/README.md` con referencia completa de endpoints.
  `docs/ops/` creado: índice, audit comparativo, tests.
- **2026-04-05** — v3.0.0: CRLF normalization en `/github-patch`.
  Soporte archivos >1MB via `download_url`. Multi-patch array mode.
  `/github-search` con context_lines y max_matches.
- **2026-04-05** — v2.0.0: `/github-read`, `/github-patch`, `/github-append`.
  Bypass del transporte MCP para archivos medianos.
- **2026-04-05** — v1.4.0: Restore OAuth correcto tras test diagnóstico.
- **2026-04-05** — v1.2.0: Fix PKCE S256 verification.
- **2026-04-05** — v1.1.0: `/.well-known/oauth-protected-resource` (RFC 9728).
- **2026-04-05** — v1.0.0: Deploy inicial. OAuth completo, proxy MCP funcional.
  Usuario `zaste` conectado. 80+ herramientas activas.
