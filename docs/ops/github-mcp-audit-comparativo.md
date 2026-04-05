# GitHub MCP — Auditoría Comparativa
> `yessicavs/github-mcp-server` · ops infrastructure
> Auditado: 2026-04-05 · ambos conectores activos simultáneamente
> Cruzado con: observabilidad 7d (28 Mar – 4 Abr), audit v3, recomendaciones técnicas

---

## 1. Arquitectura — diferencias estructurales

| Dimensión | Viejo (`shared-github-mcp-server-1`) | Nuevo (`github-mcp-proxy`) |
|---|---|---|
| **Transporte** | SSE (`/sse` + `/sse/message`) | Streamable-HTTP (`/mcp`) |
| **Runtime** | PartyKit + Durable Objects + KV | Solo KV — sin DOs |
| **Tools** | 50 (custom TypeScript) | 80+ (upstream oficial GitHub) |
| **Mantenimiento** | Manual — código propio | GitHub mantiene el upstream |
| **Tamaño del Worker** | ~150 KB bundled | 13 KB |
| **Cancelaciones 7d** | 1,971 invocaciones canceladas (25.7%) | 0 cancelaciones posibles por diseño |
| **Storage leak** | >2,000 DO instances SQLite acumuladas | No existe — sin DOs |
| **Logging de tools** | Cero — no sabe qué tool ejecutó | Logs básicos (`console.log`) en cada handler |
| **Traces** | Desactivadas | Desactivadas (mismo estado) |
| **Logpush** | false — logs se pierden a 7 días | false — mismo problema |
| **Versión upstream** | No aplica — código propio v9 | `github/github-mcp-server` v0.32.0 (actual) |
| **Deployment** | wrangler (9 versiones, jun 2025) | API directa (abr 2026) |

---

## 2. Inventario de tools — comparación completa

### 2a. Tools que el NUEVO tiene y el VIEJO NO tenía

**GitHub Actions / CI/CD**
- `actions_list`, `actions_get`, `actions_run_trigger`, `get_job_logs`

**GitHub Projects v2**
- `projects_list`, `projects_get`, `projects_write`

**Discussions**
- `list_discussions`, `get_discussion`, `get_discussion_comments`, `list_discussion_categories`

**Releases, Tags, Stars**
- `list_releases` ✅, `get_latest_release` ✅, `get_release_by_tag` ✅
- `list_tags`, `get_tag`, `star_repository`, `unstar_repository`, `list_starred_repositories`

**Labels, Gists, Security Advisories**
- `get_label` ✅, `list_label`, `label_write`
- `list_gists`, `get_gist`, `create_gist`, `update_gist`
- `list_global_security_advisories`, `get_global_security_advisory`
- `list_repository_security_advisories`, `list_org_repository_security_advisories`

**Otros exclusivos del nuevo**
- `delete_file`, `get_repository_tree`, `search_orgs`
- `sub_issue_write`, `assign_copilot_to_issue`, `list_issue_types`
- `search_pull_requests` ✅ (testado — 140 PRs open)
- `add_reply_to_pull_request_comment`
- `get_teams` ✅ (testado — 8 orgs), `get_team_members`

**PR ampliado** (`pull_request_read` métodos nuevos):
- `get_diff` ✅ (testado — diff línea a línea PR #2294)
- `get_check_runs`, `get_review_comments` con metadata isResolved/isOutdated

**Issue ampliado** (`issue_read` métodos nuevos):
- `get_sub_issues`, `get_labels`

**Issue escritura consolidada** (`issue_write`):
- Soporta `duplicate_of`, `type`, `state_reason`

### 2b. Tools que el VIEJO tenía y el NUEVO NO tiene

| Tool perdida | Viejo | Nuevo | Impacto real |
|---|---|---|---|
| `list_repositories` | ✅ | ❌ | Workaround: `search_repositories` — cubre 95% |
| `list_repositories_by_org` | ✅ (RunRebel: 7 repos) | ❌ | **Gap real** — sin alternativa directa |
| `get_issue_events` | ✅ (4 eventos issue #1) | ❌ | Pérdida menor |
| `get_issue_timeline` | ✅ | ❌ | Pérdida menor — sin alternativa directa |
| `update_dependabot_alert` | ✅ | ❌ | Pérdida menor — solo lectura en nuevo |

**Veredicto:** `list_repositories_by_org` es el único gap funcional relevante.

### 2c. Tools que existen en ambos pero se comportan diferente

**`list_issues`**
- Viejo: REST, paginación por `page`/`perPage`, devuelve `{issues, count}`
- Nuevo: GraphQL, paginación por cursor (`endCursor`), devuelve `{issues, totalCount, pageInfo}`

**`get_pull_request` → `pull_request_read`**
- Viejo: 70+ campos REST brutos
- Nuevo: 18 campos optimizados para LLM

**`search_code`**
- Nuevo soporta sintaxis extendida: `content:`, `org:`, `NOT`, `OR`

---

## 3. Test de comportamiento — resultados directos

| Operación | Viejo | Nuevo | Notas |
|---|---|---|---|
| `get_me` | ✅ | ✅ | Idéntico |
| `list_issues` (repo vacío) | `{issues:[], count:0}` | `{issues:[], totalCount:0, pageInfo:{...}}` | GraphQL en nuevo |
| `get_pull_request` | ✅ 70+ campos | ✅ 18 campos | Nuevo optimizado para IA |
| `pull_request_read get_diff` | ❌ no existe | ✅ diff línea a línea | Nuevo exclusivo |
| `list_repositories_by_org RunRebel` | ✅ 7 repos | ❌ no existe | Gap confirmado |
| `get_issue_events` | ✅ 4 eventos | ❌ | Gap confirmado |
| `list_releases github/github-mcp-server` | ❌ | ✅ v0.32.0, v0.31.0, v0.30.3 | Nuevo exclusivo |
| `search_pull_requests` | ❌ | ✅ 140 PRs | Nuevo exclusivo |
| `get_teams` | ❌ | ✅ 8 orgs detectadas | Nuevo exclusivo |
| `list_notifications` | ✅ | ✅ | Ambos funcionan |

---

## 4. Infraestructura — estado actual vs problemas documentados

### P0 — DO storage leak → RESUELTO
>2,000 instancias DO SQLite acumuladas en el viejo. El nuevo no tiene DOs.

### P1 — Cancelaciones SSE 25.7% → RESUELTO
1,971 invocaciones canceladas en 7 días (avg 38,804ms) en el viejo.
El nuevo usa streamable-HTTP: una request entra, se procesa, se cierra.

### P2 — Logging de tools → PARCIALMENTE RESUELTO
El nuevo tiene `console.log` por handler pero no ve qué tool específica ejecuta
(ocurre en el upstream). Fix de ~10 líneas pendiente: parsear JSON-RPC en `/mcp`.

### P3 — Acceso repos privados org → DEPENDE DEL PAT
`osiris-intelligence` devuelve 0 repos. El problema es el scope del PAT,
no el Worker. Solución: añadir `read:org` al PAT para esa organización.

### P4 — OAuth 401s → RESUELTO
35 errores 401/semana en el viejo por refresh ausente. El nuevo tiene refresh
token con TTL de 30 días.

### P5 — Logpush desactivado → PENDIENTE
Ambos Workers tienen `logpush: false`. Activarlo en el nuevo es trivial.

---

## 5. Cobertura de las recomendaciones del análisis

| Recomendación | Estado |
|---|---|
| Migrar SSE a streamable-HTTP | ✅ Completado |
| Eliminar Durable Objects | ✅ Completado |
| Ampliar tools (Actions, Projects, Releases...) | ✅ 30+ tools nuevas |
| Fix OAuth 401s / refresh token | ✅ TTL 30d |
| Logpush a R2 | ❌ Pendiente |
| Logging por tool | ⚠️ Parcial |
| Acceso repos privados org con read:org | ⚠️ Depende del PAT |

---

## 6. Gaps pendientes y workarounds

**`list_repositories_by_org`** — usar `search_repositories` con `org:nombre`.
Funciona para repos públicos; privados requieren `read:org` en el PAT.

**`get_issue_events`** — `issue_read get` incluye `state` y `closed_at`.
Para eventos de labeled/assigned no hay alternativa directa.

**`get_issue_timeline`** — sin alternativa directa. Combinar
`issue_read get` + `issue_read get_comments` + búsqueda de commits.

**Logging de tools** — interceptar el body JSON-RPC en `/mcp`
(~10 líneas, pendiente de implementar).

---

## 7. Veredicto

Los 3 problemas de producción críticos del viejo están eliminados por arquitectura:
DO storage leak, cancelaciones SSE 25.7%, OAuth 401s semanales.
Adicionalmente: +30 tools nuevas, acceso a Actions/Projects/Discussions/Releases.

Gaps menores: logpush desactivado, logging de tool específica, `list_repositories_by_org`
(workaround disponible), acceso a `osiris-intelligence` (scope del PAT).

---

## 8. Tabla de referencia rápida (selección)

| Tool | Viejo | Nuevo |
|---|---|---|
| `list_repositories_by_org` | ✅ | ❌ Gap — usar `search_repositories` |
| `get_issue_events` / `get_issue_timeline` | ✅ | ❌ Gap menor |
| `update_dependabot_alert` | ✅ | ❌ Gap menor |
| `list_releases` / `get_latest_release` | ❌ | ✅ Nuevo |
| `search_pull_requests` | ❌ | ✅ Nuevo |
| `pull_request_read get_diff` | ❌ | ✅ Nuevo |
| `pull_request_read get_check_runs` | ❌ | ✅ Nuevo |
| `get_teams` / `get_team_members` | ❌ | ✅ Nuevo |
| `actions_*` / `get_job_logs` | ❌ | ✅ Nuevo |
| `projects_*` | ❌ | ✅ Nuevo |
| `list_discussions` / `get_discussion` | ❌ | ✅ Nuevo |
| `list_gists` / `create_gist` | ❌ | ✅ Nuevo |
| `list_*_security_advisories` | ❌ | ✅ Nuevo |
| `get_label` / `label_write` | ❌ | ✅ Nuevo |
| `list_issues` paginación | REST page/perPage | GraphQL cursor |
| `get_pull_request` campos | 70+ REST | 18 optimizados para IA |

**Resumen:** 45 tools en común · 32 nuevas · 5 perdidas (4 menores + `list_repositories_by_org`)
