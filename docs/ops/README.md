# Ops Documentation Index
> `yessicavs/github-mcp-server` · Infraestructura MCP de Ops@growthxy.com
> Actualizado: 2026-04-05 · commit `307ab7cf`

---

## Documentos activos

| Archivo | Descripción | Última actualización |
|---|---|---|
| [github-mcp-audit-comparativo.md](github-mcp-audit-comparativo.md) | Auditoría comparativa: `shared-github-mcp-server-1` vs `github-mcp-proxy` — tools, comportamiento, gaps, tests en vivo | 2026-04-05 |
| [test-patch.md](test-patch.md) | Archivo de test para verificar `/github-patch`, `/github-append`, `/github-read-section` | 2026-04-05 |

---

## Stack actual

```
Claude.ai web
    │  OAuth (registro → autorización → token)
    ▼
github-mcp-proxy.ops-e1a.workers.dev   ← github-mcp-proxy v3.1
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
| Versión Worker | v3.1.0 (2026-04-05) |
| Upstream | `api.githubcopilot.com/mcp/` → `github/github-mcp-server` v0.32.0 |

---

## Endpoints de edición de documentos

Todos requieren `Authorization: Bearer <oauth_access_token | github_pat>`.
Ver referencia completa en [cloudflare-worker/README.md](../../cloudflare-worker/README.md).

| Endpoint | Descripción | Cuándo usar |
|---|---|---|
| `POST /github-read` | Lee archivo completo como texto plano | Archivos ≤70KB |
| `POST /github-read-section` | Lee líneas N-M con expansión de contexto | Archivos grandes — leer solo la sección a editar |
| `POST /github-patch` | str_replace — single o multi-patch, un commit | Cualquier tamaño |
| `POST /github-append` | Añade al final del archivo | Changelogs, listas |
| `POST /github-search` | Busca string en archivo con contexto | Localizar sección antes de parchear |

### Límites del transporte MCP

| Tamaño | Operación recomendada |
|---|---|
| < 30 KB | `get_file_contents` (MCP) + `create_or_update_file` (MCP) |
| 30–70 KB | `/github-patch` |
| > 70 KB | `/github-read-section` para localizar + `/github-patch` |
| > 1 MB | `/github-read` usa `download_url` automáticamente |

---

## Patrón de frontmatter recomendado

Todos los documentos de esta carpeta incluyen un header de metadatos:

```markdown
# Título del documento
> `contexto/repo` · descripción breve
> Actualizado: YYYY-MM-DD · commit `abc1234`
```

En cada sesión de actualización, parchear la línea `Actualizado:` como primer paso.

---

## Workflow incremental recomendado

### Sesión nueva sobre un documento existente

1. **Orientarse** — `get_file_contents` o `/github-read` para SHA + estado actual
2. **Localizar** — `/github-search` para encontrar la sección exacta
3. **Leer sección** — `/github-read-section` si el doc es grande (>70KB)
4. **Parchear** — `/github-patch` con `old_str` suficientemente único
5. **Actualizar metadatos** — `/github-patch` sobre la línea `Actualizado:`
6. **Verificar** — `get_file_contents` o `/github-read` para confirmar

### Crear documento nuevo

1. Crear con `MCP_GITHUB:push_files` (varios archivos en un commit)
2. Incluir el frontmatter con la fecha
3. Añadir entrada a este README con `/github-patch`

### Multi-patch para actualización semanal

Cuando hay varios cambios en un mismo archivo, usar el modo array de `/github-patch`
para que todo quede en un único commit limpio:

```json
{
  "patches": [
    { "old_str": "sección A original", "new_str": "sección A actualizada" },
    { "old_str": "sección B original", "new_str": "sección B actualizada" },
    { "old_str": "Actualizado: 2026-04-04", "new_str": "Actualizado: 2026-04-05" }
  ],
  "message": "docs: actualización semanal"
}
```
