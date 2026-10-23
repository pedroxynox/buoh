---
schema_version: "1.0.0"
status_version: 4
updated_at_utc: "2026-10-23T13:30:00.000Z"
current_phase: "Fase 1 — Fundación de datos"
phase_status: "active"
active_work: null
next_delivery: "F1.3b"
next_requirements:
  - "F1-STREAM-001"
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
- F1.3 se entrega en dos partes ([ADR-0005](docs/arquitectura/adr/0005-persistencia-local-y-formato-fisico-f1-3.md)). F1.3a proporciona `infra/compose.yaml` (PostgreSQL 18 y SeaweedFS S3-compatible), `apps/market-data-worker` con publicación atómica y `pnpm run data:replay` en modos recomputación y `--verify-only` (`F1-DATASET-001`).
- No existe todavía log raw-first durable, integración con Deriv ni despliegue.
- No existe estrategia, señal, conexión de cuenta ni ejecución `demo` o `real`.

## Siguiente tarea autorizada

**`F1.3b` — Log raw-first, rotación y registro operativo.**

Implementar el log durable de source events con escritura raw antes de normalizar (`F1-STREAM-001`), la rotación de segmentos por bytes, frames y ventana de `segment_policy_version = 1.0.0` y el registro operativo de `persistence_unavailable`/`source_limit_exceeded`, según las decisiones ya aprobadas en ADR-0005 §4–§6 y en [contratos de dominio](docs/arquitectura/contratos-de-dominio.md#registro-operativo-de-persistencia-y-límites). La publicación pasa a leer segmentos cerrados del log.

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
- 31 pruebas de dominio (10 de vectores y 21 de reglas, continuidad, versiones y límites no cubiertos por el vector) pasan offline.

## Evidencia de F1.3a

- 27 pruebas offline del worker con adaptadores en memoria y sin red; publicación y replay de ambos escenarios corren además con reloj congelado y sin aleatoriedad:
  - ambos escenarios se publican con los `dataset_id` firmados y los source events gzip descomprimen byte a byte a los segmentos del vector;
  - cero ticks guarda objetos de cero bytes;
  - un fallo en escritura, verificación, documento o commit no deja publicación visible, y reanudar la completa;
  - `--verify-only` rechaza datasets íntegros pero inconsistentes (orden, extremos, tick sin raw, procedencia, perfil, versión de contrato) y acepta uno coherente que la recomputación rechaza con `RECOMPUTATION_MISMATCH`;
  - una versión del normalizador no implementada aborta la recomputación con `VERSION_UNSUPPORTED`.
- 11 pruebas de integración (`pnpm run test:integration`) contra PostgreSQL 18.4 y SeaweedFS 4.48 locales: publicación y replay de ambos escenarios, CLI con salidas 0/1/2, rollback completo de un commit fallido, índice de un único record activo, rechazo de `UPDATE`/`DELETE`/`TRUNCATE` y comprobación en base de datos de que `dataset_id` es el hash de `manifest_core`. El job de CI las ejecuta con las imágenes fijadas en `infra/compose.yaml`.

## Pendientes registrados de F1.2

Detectados en la revisión semántica del PR #5; no bloquean F1.3:

1. Con un perfil de varios símbolos, un frame inválido sin símbolo atribuible detiene la derivación, y los mensajes de Deriv que no son ticks (ping, ack, respuestas) se registrarían como `invalid_source_frame`. **Decidir antes de F1.4.**
2. Cuando la salud está en `recovering` por continuidad pendiente, el `HealthReport` no muestra la causa: `open_condition_types` queda vacío.
3. `docs/impact-map.json` no tiene regla para `packages/domain/**`.
4. `qualityProfileSchema` está duplicado entre `packages/domain` y `packages/contracts/src/vector-integrity.ts`.
5. `typecheck` y `lint` resuelven `@buoh/contracts` con `paths` al código fuente; vitest usa `dist`. Ejecutar `pnpm run test`, no vitest directo. `apps/market-data-worker` sigue el mismo patrón.
6. El `HistoryRecoveryResult` debe registrarse después del primer tick posterior al cierre; con otro orden la salud se queda en `recovering`.

## Decisiones vigentes relevantes

- TypeScript estricto es el lenguaje principal; Python queda fuera de la ruta de ingesta inicial.
- Fase 1 usa PostgreSQL estándar y almacenamiento S3-compatible; TimescaleDB y Redis están diferidos hasta demostrar su necesidad. En local, PostgreSQL 18 y SeaweedFS (ADR-0005).
- El adaptador inicial usará únicamente el WebSocket público de Deriv, sin autenticación.
- Datos crudos y normalizados son artefactos distintos; una incidencia nunca reescribe el dato crudo.
- JSON Schema representa estructura interoperable; las invariantes criptográficas y relacionales requieren validación runtime.
- Las pruebas offline sintéticas son bloqueantes. El smoke público de Deriv aparece en F1.4 y nunca constituye el único criterio de merge.
- Hasta incorporar un writer Parquet, ticks e incidencias se publican como NDJSON sin compresión; `dataset_id` no depende del formato físico.

## Bloqueos

Ninguno para iniciar `F1.3b`.

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
