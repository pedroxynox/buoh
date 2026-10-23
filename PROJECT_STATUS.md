---
schema_version: "1.0.0"
status_version: 6
updated_at_utc: "2026-10-23T15:27:00.000Z"
current_phase: "Fase 1 — Fundación de datos"
phase_status: "active"
active_work: null
next_delivery: "F1.4b"
next_requirements:
  - "F1-CATALOG-001"
  - "F1-SOURCE-001"
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
- F1.3 se entregó en dos partes ([ADR-0005](docs/arquitectura/adr/0005-persistencia-local-y-formato-fisico-f1-3.md)):
  - F1.3a: `infra/compose.yaml` (PostgreSQL 18 y SeaweedFS S3-compatible), `apps/market-data-worker` con publicación atómica y `pnpm run data:replay` en modos recomputación y `--verify-only` (`F1-DATASET-001`);
  - F1.3b: log raw-first durable con rotación `segment_policy_version = 1.0.0`, registro operativo de `persistence_unavailable`/`source_limit_exceeded` y publicación desde segmentos cerrados del log (`F1-STREAM-001`).
- F1.4 se entrega en dos partes. F1.4a añade las reglas de calidad 2.0.0 para fuentes que mezclan varios tipos de mensaje, como Deriv: mensajes que no son ticks, errores de la fuente, atribución por `echo_req` e incidencia sin símbolo con el esquema de incidencias 2.0.0 ([contratos de dominio](docs/arquitectura/contratos-de-dominio.md#semántica-ejecutable-de-reglas-200)).
- No existe todavía integración con Deriv, persistencia del `IngestionCursor`, cola en memoria del transporte ni despliegue.
- No existe estrategia, señal, conexión de cuenta ni ejecución `demo` o `real`.

## Siguiente tarea autorizada

**`F1.4b` — Catálogo y streaming público de Deriv.**

Implementar el catálogo versionado de `active_symbols` (`F1-CATALOG-001`) y el adaptador público de Deriv con esquemas fijados, límites, keepalive y correlación (`F1-SOURCE-001`), entregando sus frames al `RawFirstIngestor` con un perfil de reglas 2.0.0, más el smoke opt-in `pnpm run data:smoke`.

Decisiones del propietario para F1.4b:

- el primer smoke usa un solo índice sintético de Deriv (por ejemplo Volatility 100), con el nombre exacto tomado del catálogo oficial;
- los umbrales live de retraso y hueco no se inventan: el smoke mide primero los retrasos reales y los umbrales se fijan después con esos números;
- mientras tanto, los datos live no se publican como dataset (ADR-0004 §13).

El perfil 2.0.0 exige umbrales enteros de retraso y hueco. El smoke solo normaliza y mide, sin derivar ni publicar, así que esos umbrales no se aplican; F1.4b debe marcar ese perfil de medición para que nunca sirva para publicar, y declarar en `non_tick_msg_types` las respuestas de Deriv que pide.

No crea todavía web, móvil, señales ni ejecución.

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

## Evidencia de F1.3b

- 8 pruebas de dominio de la política de rotación: umbrales de ADR-0004 §7, medición de bytes, rotación antes del frame 10 001 y a los 300 000 ms, orden de motivos y evento que no cabe en un segmento.
- 15 pruebas offline del log y el ingestor con adaptadores en memoria; las de vectores corren además con reloj congelado y sin aleatoriedad ni red:
  - el escenario principal pasa por el log y sus dos segmentos cerrados son byte a byte `expected-source-events-*.ndjson`; publicar desde el log da el mismo `dataset_id` y el replay lo reproduce;
  - un frame inválido queda durable sin tick y la publicación produce `invalid_source_frame`; cero ticks da su `dataset_id`;
  - el fallo de escritura raw del vector produce exactamente `expected-persistence-failure.json`, sin ticks ni eventos durables;
  - un fallo del índice no emite el tick; sin PostgreSQL solo queda una alerta sanitizada;
  - un frame de más de 1 MiB se rechaza sin persistirlo y registra `source_limit_exceeded`;
  - un `ConnectionOpened` durable resuelve la condición y reabre la entrada;
  - el log rota por frames y por ventana, continúa el segmento no finalizado tras reiniciar y detecta objetos alterados.
- 9 pruebas de integración más (20 en total) contra PostgreSQL 18.4 y SeaweedFS 4.48 locales: vectores a través del log real y publicación con sus `dataset_id`, reinicio desde el estado durable, registro operativo persistido y resuelto, y contigüidad, segmentos cerrados, conteos y append-only impuestos por la base de datos.

## Evidencia de F1.4a

Reglas de calidad versionadas (`F1-QUALITY-001`) y preparación del adaptador de Deriv (`F1-SOURCE-001`). Resuelve el antiguo pendiente 1 de F1.2 con la decisión del propietario: reglas 2.0.0 y esquema de incidencias 2.0.0.

- 20 pruebas de dominio de las reglas 2.0.0:
  - un mensaje declarado en `non_tick_msg_types` no da tick ni incidencia;
  - lo no declarado o roto (`msg_type` desconocido, parecido, vacío, numérico o ausente; JSON inválido) sigue siendo `invalid_source_frame`;
  - un error de la fuente da `source_error_response` y se atribuye por `echo_req`; el orden de atribución solo usa símbolos permitidos;
  - un frame inválido sin atribución queda sin símbolo y la derivación continúa; las reglas 1.0.0 conservan su semántica;
  - el perfil 2.0.0 exige declarar sus respuestas y el 1.0.0 lo prohíbe;
  - la publicación declara normalizador e incidencias 2.0.0, y un dataset sin símbolos atribuibles no se publica;
  - aplicadas al vector v1 dan los mismos registros completos salvo versiones e IDs.
- Contratos: `symbol = null` en `invalid_source_frame` se acepta solo con el esquema de incidencias 2.0.0; 1.0.0 y versiones sin lector (2.1.0, 3.0.0, 99.0.0) se rechazan.
- 5 pruebas del worker:
  - con reglas 2.0.0, un ping queda durable en el log sin tick, alarma ni incidencia, y el dataset se publica y se reproduce en ambos modos;
  - `--verify-only` rechaza una incidencia con otra versión que la del manifiesto, un esquema de incidencias sin lector o incoherente con las reglas;
  - la recomputación aborta ante un conjunto de reglas no implementado.
- Los vectores v1 siguen reproduciéndose byte a byte con reglas 1.0.0.

## Pendientes registrados de F1.3

Detectados en las revisiones semánticas de F1.3a (PR #6) y F1.3b; la lista completa está en cada PR. Los más relevantes para F1.4 y el despliegue:

1. Si la conexión cae durante el `COMMIT` de una publicación, se informa "no se confirmó" aunque pudo confirmarse.
2. Publicar no aplica los límites de lectura del replay. `normalized_ticks` y `quality_incidents` son un único artefacto que crece con el dataset. Resolver antes de publicar datasets live largos.
3. Los nombres de `PublicationStep` no coinciden con `PersistenceStage`; los fallos de publicación todavía no entran en el registro operativo.
4. El worker usa un único rol PostgreSQL dueño de las tablas. Antes de desplegar (ADR-0006) hace falta un rol de ejecución que solo pueda insertar y leer.
5. SeaweedFS `mini` arranca componentes internos que no se usan (Iceberg, Lance, servidor de administración).
6. El log asume un único escritor por fuente y llamadas al ingestor de una en una: los triggers de `0002` no bloquean escritores concurrentes. El transporte de F1.4b debe esperar cada llamada y garantizar una sola instancia por fuente, o añadir un bloqueo por fuente.
7. Tras un fallo de persistencia, el `ConnectionClosed` del cierre no se guarda en el log, así que un dataset que abarque la caída no lleva marca de la interrupción. Un índice que confirma pero informa error se trata como no durable y se adopta al reabrir sin reconciliar el tick.

## Pendientes registrados de F1.2

Detectados en la revisión semántica del PR #5:

El antiguo pendiente 1 (atribución de símbolo y mensajes que no son ticks) quedó resuelto en F1.4a.

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
- Alojamiento productivo en Render para PostgreSQL, API y web; el despliegue sigue diferido ([ADR-0006](docs/arquitectura/adr/0006-alojamiento-en-render.md)).

## Bloqueos

Ninguno para iniciar `F1.4b`.

## Decisiones pendientes que no bloquean Fase 1

- Jurisdicción inicial del producto comercial.
- Universo definitivo de índices y tipos de contrato.
- Proveedor de almacenamiento de objetos en producción; Render no lo ofrece (ADR-0006).
- Alojamiento de `market-data-worker` en producción.
- Compilación y distribución de la app móvil.
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
