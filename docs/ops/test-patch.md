# Test doc — /github-patch, /github-append
> `yessicavs/github-mcp-server` · stress test doc
> Actualizado: 2026-04-06 · v4.0.1

---

Archivo de test para `/github-patch`, `/github-append`, `/github-read-section`.

## Estado actual

- v4.0.1 activo — tokenizePath bug corregido
- 0 errores — test v4.1.0 verificado

## Sección A

Contenido de prueba para edición quirúrgica.
Este texto aparece exactamente UNA vez — str_replace funcionará sin ambigüedad.

## Sección B

Otro bloque único. Nunca duplicar texto aquí.

## Sección C — nueva (INSERT via /github-append)

Esta sección fue añadida via `/github-append` en la sesión de stress test.
Demostración de append sin tocar el resto del documento.

## Changelog

- 2026-04-05: creado para test básico de patch/append
- 2026-04-06: /github-read-section ✓ — lecturas parciales sin cargar todo el doc
- 2026-04-06: multi-patch 6 ops ✓ — atómico
- 2026-04-06: v4.0.1 stress test — 0 errores
- 2026-04-06: Sección C añadida via /github-append
