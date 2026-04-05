# Ops Documentation Index
> `yessicavs/github-mcp-server` · Infraestructura MCP de Ops@growthxy.com
> Actualizado: 2026-04-06 · commit `v4.0.0 deploy`

---

## Documentos activos

| Archivo | Descripción | Última actualización |
|---|---|---|
| [github-mcp-audit-comparativo.md](github-mcp-audit-comparativo.md) | Auditoría comparativa: `shared-github-mcp-server-1` vs `github-mcp-proxy` — tools, comportamiento, gaps, tests en vivo | 2026-04-05 |
| [test-complex.md](test-complex.md) | Documento de test complejo para endpoints v4.0 (secciones, tablas, code blocks, JSON) | 2026-04-06 |
| [test-data.json](test-data.json) | JSON de test para `/github-json-patch` — workers, métricas, config | 2026-04-06 |
| [test-patch.md](test-patch.md) | Archivo de test para `/github-patch`, `/github-append`, `/github-read-section` | 2026-04-05 |
| [_index.json](_index.json) | Índice estructural del directorio — auto-mantenido por el Worker vía `ctx.waitUntil` | 2026-04-06 |

---

## Stack actual

```
Claude.ai web
    │  OAuth (registro → autorización → token)
    ▼
github-mcp-proxy.ops-e1a.workers.dev   ← github-mcp-proxy v4.0
    │  Bearer <PAT>
    ▼
api.githubcopilot.com/mcp/             ← github/github-mcp-server v0.32.0
    │
    ▼
GitHub API  (80+ tools)
```

| Recurso | Valor |
|---|---|
| Worker | `github-mcp-proxy` · cuenta `Ops@growthxy.com` |
| KV | `github-mcp-proxy-OAUTH` (`20cb14eff6cf4a9cbc7d0119018f0876`) |
| URL MCP | `https://github-mcp-proxy.ops-e1a.workers.dev/mcp` |
| Versión Worker | **v4.0.0** (2026-04-06) |
| Upstream | `api.githubcopilot.com/mcp/` → `github/github-mcp-server` v0.32.0 |

---

## Endpoints de edición de documentos

Todos requieren `Authorization: Bearer <oauth_access_token | github_pat>`.
Ver referencia completa en [cloudflare-worker/README.md](../../cloudflare-worker/README.md).

| Endpoint | Versión | Descripción | Cuándo usar |
|---|---|---|---|
| `POST /github-read` | v2.0 | Lee archivo completo como texto plano | Archivos ≤70KB |
| `POST /github-read-section` | v3.1 | Lee líneas N-M con expansión de contexto | Docs grandes — leer solo la sección a editar |
| `POST /github-outline` | **v4.0** | Extrae estructura (headings, tablas, code blocks) sin leer el contenido | Orientarse en doc grande |
| `POST /github-patch` | v2.0+ | str_replace — single o multi-patch, dry_run, un commit | Cualquier tamaño |
| `POST /github-append` | v2.0 | Añade al final del archivo | Changelogs, listas |
| `POST /github-search` | v3.0 | Busca string en archivo con contexto | Localizar sección antes de parchear |
| `POST /github-replace-section` | **v4.0** | Reemplaza sección markdown completa por heading | Secciones largas sin old_str único |
| `POST /github-json-patch` | **v4.0** | Operaciones JSONPath sobre archivos JSON | JSON con estructura repetitiva |
| `POST /github-table-upsert` | **v4.0** | Upsert fila en tabla markdown por clave | Tablas con datos cambiantes |
| `POST /github-search-dir` | **v4.0** | Busca string en todos los archivos de un directorio | Referencias cruzadas, renombrar |

### Features v4.0

- **`dry_run: true`** en todos los endpoints de escritura — preview sin commitear
- **`_index.json`** auto-mantenido en background via `ctx.waitUntil` tras cada escritura
- **`skip_index: true`** para deshabilitar la actualización del índice

### Límites del transporte MCP

| Tamaño | Operación recomendada |
|---|---|
| < 30 KB | `get_file_contents` (MCP) + `create_or_update_file` (MCP) |
| 30–70 KB | `/github-patch` |
| > 70 KB | `/github-outline` para orientarse + `/github-read-section` + `/github-patch` |
| > 1 MB | `/github-read` usa `download_url` automáticamente |

---

## _index.json — índice estructural

El archivo `_index.json` en cada directorio contiene el outline de todos los archivos:
- Para markdown: secciones con `line_start`/`line_end`, tablas, code blocks
- Para JSON: top-level keys, is_array, array_length
- SHA actual + tamaño + líneas + timestamp

Uso en sesión nueva:
1. Leer `_index.json` (~5KB) → orientación completa del directorio en O(1)
2. Ir directo a la sección exacta con `/github-read-section` usando los `line_start`/`line_end` del índice
3. Parchear con el SHA del índice (siempre actualizado)

---

## Patrón de frontmatter recomendado

```markdown
# Título del documento
> `contexto/repo` · descripción breve
> Actualizado: YYYY-MM-DD · commit `abc1234`
```

En cada sesión de actualización, parchear la línea `Actualizado:` como primer paso.

---

## Workflow incremental recomendado (v4.0)

### Sesión nueva sobre directorio existente

1. **Orientarse** — leer `_index.json` (pequeño, siempre actualizado)
2. **Estructura** — `/github-outline` si el doc no está en el índice o ha cambiado
3. **Localizar** — `/github-search` para encontrar sección exacta
4. **Leer sección** — `/github-read-section` con líneas del índice
5. **Parchear** — `/github-patch`, `/github-replace-section`, `/github-table-upsert`, o `/github-json-patch`
6. **Frontmatter** — `/github-patch` sobre la línea `Actualizado:`

### Multi-patch para actualización semanal

```json
{
  "patches": [
    { "old_str": "sección A original", "new_str": "sección A actualizada" },
    { "old_str": "Actualizado: 2026-04-05", "new_str": "Actualizado: 2026-04-06" }
  ],
  "message": "docs: actualización semanal"
}
```

### Preview antes de commitear

Cualquier endpoint de escritura acepta `dry_run: true` — devuelve el diff sin escribir.
