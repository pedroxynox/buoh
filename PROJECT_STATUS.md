---
schema_version: "1.0.0"
status_version: 3
updated_at_utc: "2026-10-18T01:19:59.000Z"
current_phase: "Fase 1 — Fundación de datos"
phase_status: "active"
active_work: null
next_delivery: "F1.3"
next_requirements:
  - "F1-STREAM-001"
  - "F1-DATASET-001"
plan: "docs/plan/fase-1-fundacion-de-datos.md"
---

# Estado actual de buoh

Este archivo describe únicamente el estado vigente. No es un diario: Git y los pull requests conservan el historial. Su contenido entra en vigor al fusionarse el cambio que lo modifica.

## Objetivo actual

Construir una base de datos de mercado reproducible: recibir datos públicos de Deriv, preservar cada frame crudo, normalizar ticks con contratos ejecutables, registrar incidencias de calidad y publicar datasets inmutables que puedan reproducirse de forma idéntica.

## Situación

- La fundación de producto, arquitectura, seguridad y operación está aprobada.
- F1.1 proporciona monorepo reproducible, contratos runtime, JSON Schema generado, vectores verificables y guardia documental.
- F1.2 proporciona `packages/domain`: adaptador sintético, normalización, reglas de calidad 1.0.0, construcción de publicación y salud, todo puro y determinista.
- No existe todavía worker operativo, integración con Deriv, PostgreSQL, almacenamiento de objetos ni despliegue.
- No existe estrategia, señal, conexión de cuenta ni ejecución `demo` o `real`.

## Siguiente tarea autorizada

**`F1.3` — Persistencia, publicación y replay.**

Implementar PostgreSQL estándar, almacenamiento S3-compatible local, log de source events, publicación atómica y `pnpm run data:replay -- --dataset <id>` (`F1-STREAM-001`, `F1-DATASET-001`), reutilizando `packages/domain` para normalizar y recomputar. Incluye la rotación de segmentos por bytes, frames y ventana de `segment_policy_version = 1.0.0` y el registro operativo de `persistence_unavailable`/`source_limit_exceeded`.

No crea todavía conexión Deriv, web, móvil, señales ni ejecución.

## Evidencia de F1.1

- Runtime efectivo: Node.js 24.22.0 y pnpm 12.14.0, verificado por `pnpm run runtime:check`.
- `pnpm run verify` cubre formato, lint, tipos, build, pruebas, esquemas y documentación.
- 7 pruebas del guard documental y 22 pruebas de contratos, JSON Schema, causalidad y seguridad de vectores pasan offline.
- 8 JSON Schema se generan desde Zod y `schemas:check` confirma que están actualizados.
- `test:vectors` valida los datasets firmados:
  - principal: `sha256:611d83367d6b86a210ebdb30a2e73aa30dc35f8efd59f07fb43febf60c98defd`;
  - cero ticks: `sha256:7768d9551e4f5a2a0c16adaf1e93f98461b5cf894dac0c0c8fa7b1c1fe8d431f`.
- El guard relaciona contratos, toolchain, worker, infraestructura y vectores con sus fuentes documentales.

## Evidencia de F1.2

- `pnpm run test:vectors` regenera desde los estímulos ambos escenarios firmados (principal multi-segmento y `zero-valid-ticks`) y compara byte a byte segmentos de source events, ticks, incidencias, condiciones, documento canónico, manifiesto legible, `PublishedManifestRecord`, objetos físicos y salud; recomputar desde los source events persistidos produce los mismos `dataset_id`.
- El escenario de persistencia raw fallida produce exactamente `expected-persistence-failure.json`.
- La suite congela el reloj en otra fecha y prohíbe `Math.random`, `crypto.randomUUID` y `fetch` durante el pipeline.
- 26 pruebas de dominio (10 de vectores y 16 de reglas, continuidad, versiones y límites no cubiertos por el vector) pasan offline.

## Decisiones vigentes relevantes

- TypeScript estricto es el lenguaje principal; Python queda fuera de la ruta de ingesta inicial.
- Fase 1 usa PostgreSQL estándar y almacenamiento S3-compatible; TimescaleDB y Redis están diferidos hasta demostrar su necesidad.
- El adaptador inicial usará únicamente el WebSocket público de Deriv, sin autenticación.
- Datos crudos y normalizados son artefactos distintos; una incidencia nunca reescribe el dato crudo.
- JSON Schema representa estructura interoperable; las invariantes criptográficas y relacionales requieren validación runtime.
- Las pruebas offline sintéticas son bloqueantes. El smoke público de Deriv aparece en F1.4 y nunca constituye el único criterio de merge.

## Bloqueos

Ninguno para iniciar `F1.2`.

## Decisiones pendientes que no bloquean Fase 1

- Jurisdicción inicial del producto comercial.
- Universo definitivo de índices y tipos de contrato.
- Proveedor de almacenamiento de objetos en producción.
- Límites monetarios y política de riesgo para fases `demo` y `real`.
- Proveedor de pagos y modelo de suscripción.

## Evidencia requerida para cambiar de fase

La Fase 1 solo puede marcarse `done` cuando todos sus requisitos tienen pruebas y evidencia, un dataset se reproduce con el mismo identificador y las incidencias de calidad permanecen visibles tras reinicios.

## Mantenimiento obligatorio

Actualizar este archivo en el mismo PR cuando cambie cualquiera de estos elementos:

- fase o estado de fase;
- objetivo o tarea siguiente;
- bloqueo o decisión pendiente;
- componente autorizado para implementarse;
- evidencia de una puerta de salida.

No actualizarlo por cambios internos que no alteren el estado del proyecto. No registrar porcentajes subjetivos de avance ni afirmar verificaciones no ejecutadas.
