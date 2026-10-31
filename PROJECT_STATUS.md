---
schema_version: "1.0.0"
status_version: 35
updated_at_utc: "2026-10-31T02:59:00.000Z"
current_phase: "Fase 2 — Laboratorio y bot shadow para uso propio"
phase_status: "active"
active_work: null
next_delivery: "F2.2"
next_requirements: ["F2-DEPLOY-001", "F2-ROLE-001", "F2-RETENTION-001"]
plan: "docs/plan/fase-2-laboratorio-y-bot-shadow.md"
parallel_plans: []
---

# Estado actual de buoh

Este archivo describe únicamente el estado vigente. No es un diario: Git y los pull requests conservan el historial. Su contenido entra en vigor al fusionarse el cambio que lo modifica.

## Objetivo actual

Transformar una hipótesis en una estrategia viva, explicable y no ejecutora, para uso propio ([roadmap](docs/producto/roadmap.md), Fase 2). La fase termina cuando una estrategia *shadow* puede reproducir cada decisión desde datos y versiones fijados y detenerse sola ante una degradación de los datos. Su alcance, su aceptación y su secuencia, de F2.1 a F2.11, están en el [plan de Fase 2](docs/plan/fase-2-laboratorio-y-bot-shadow.md).

## Situación

- La Fase 1 terminó el 2026-10-29 y cumplió su puerta de salida: la evidencia está en el [documento de la puerta de salida](docs/operacion/evidencia-puerta-fase-1.md) y en «Evidencia de F1.5», más abajo. Ese día el propietario decidió hacer antes la Fase 2 que la Fase 1B («Decisiones vigentes relevantes»).
- El [plan de Fase 2](docs/plan/fase-2-laboratorio-y-bot-shadow.md) fija sus requisitos `F2-*`, el corte de implementación (`apps/api`, `packages/strategy-sdk` y `apps/signal-engine`, cada uno con su incremento), las ADR que van antes del código y su orden, y el presupuesto. Primero lleva el sistema de datos a un servidor (F2.1 y F2.2), para que la captura acumule datos mientras avanza lo demás.
- F2.1 entregó el punto de control de la derivación en vivo ([ADR-0017](docs/arquitectura/adr/0017-punto-de-control-de-la-derivacion-en-vivo.md), PR #48 a #50, #52 y #54 y el de su evidencia): `ingest` lo escribe al cerrar cada segmento, y el arranque, la reparación de cierres, la vigilancia de huecos y `data:health` parten del último válido, sin leer el log entero. Con un log de 7 días, su memoria queda a menos de un 8 % de la de un día y por debajo de los techos de ADR-0017 §9 («Evidencia de F2.1»).
- La fundación de producto, arquitectura, seguridad y operación está aprobada.
- F1.1 proporciona monorepo reproducible, contratos runtime, JSON Schema generado, vectores verificables y guardia documental.
- F1.2 proporciona `packages/domain`: adaptador sintético, normalización, reglas de calidad 1.0.0, construcción de publicación y salud, todo puro y determinista.
- F1.3 se entregó en dos partes ([ADR-0005](docs/arquitectura/adr/0005-persistencia-local-y-formato-fisico-f1-3.md)):
  - F1.3a: `infra/compose.yaml` (PostgreSQL 18 y SeaweedFS S3-compatible), `apps/market-data-worker` con publicación atómica y `pnpm run data:replay` en modos recomputación y `--verify-only` (`F1-DATASET-001`);
  - F1.3b: log raw-first durable con rotación `segment_policy_version = 1.0.0`, registro operativo de `persistence_unavailable`/`source_limit_exceeded` y publicación desde segmentos cerrados del log (`F1-STREAM-001`).
- F1.4 se entrega en dos partes. F1.4a añade las reglas de calidad 2.0.0 para fuentes que mezclan varios tipos de mensaje, como Deriv: mensajes que no son ticks, errores de la fuente, atribución por `echo_req` e incidencia sin símbolo con el esquema de incidencias 2.0.0 ([contratos de dominio](docs/arquitectura/contratos-de-dominio.md#semántica-ejecutable-de-reglas-200)).
- F1.4b entregó el catálogo versionado de Deriv (`F1-CATALOG-001`) y el adaptador público, solo para escuchar (`F1-SOURCE-001`), con el smoke opt-in `pnpm run data:smoke` ([ADR-0012](docs/arquitectura/adr/0012-catalogo-y-adaptador-publico-de-deriv.md)): esquemas fijados, transporte `ws` con sus límites, cola en memoria, correlación, keepalive, versiones del catálogo e incidencias de respuestas pedidas en PostgreSQL, y bloqueo por fuente. La sesión de ingesta reconecta con espera, repara los cierres no registrados y recupera la historia del hueco ([ADR-0015](docs/arquitectura/adr/0015-reconexion-recuperacion-y-salud-f1-5.md)).
- La sesión de ingesta persiste el `IngestionCursor` y el latido en PostgreSQL (migración `0004`), y `pnpm --filter @buoh/market-data-worker run ingest -- --live` la ejecuta de forma continua sobre PostgreSQL y el almacenamiento de objetos, con un esquema y un bucket propios, y para sola a las 23 horas para borrar la captura antes de las 24 ([runbook](docs/operacion/runbook-ingesta-de-datos.md), «Captura viva continua»). `pnpm run data:health -- --json` emite el `HealthReport` de esa captura desde fuera del proceso que ingiere, sin tomar el bloqueo ni escribir nada ([runbook](docs/operacion/runbook-ingesta-de-datos.md), «Salud de datos»). No hay despliegue del sistema de datos.
- MetaTrader 5 (Deriv MT5 y Vantage) queda decidido como segunda integración ([ADR-0007](docs/arquitectura/adr/0007-varias-fuentes-y-metatrader-5.md)): sus datos llegan en la Fase 1B, que no tiene fecha porque la Fase 2 va antes, y operar en MT5 empieza en Fase 4 (demo). No existe código de MT5.
- No existe estrategia, señal, conexión de cuenta ni ejecución `demo` o `real`.
- El sitio oficial está en internet desde el 2026-10-27, como sitio estático gratuito de Render, en `https://buoh-sitio.onrender.com` y sin indexar ni anunciar ([ADR-0013](docs/arquitectura/adr/0013-publicacion-del-sitio-en-render.md)). Es lo único desplegado. El propietario conectó el repositorio, y la comprobación de [despliegue en Render](docs/operacion/despliegue-en-render.md) («Comprobar un despliegue») pasó ese día: cabeceras de seguridad y `noindex` en todas las respuestas, ninguna cookie, `404` propio y las seis páginas abren con el texto de `main` (detalle en P-V1-07 de la [especificación de pendientes](docs/plan/especificacion-de-pendientes.md)).
- La [línea visual V1](docs/plan/linea-visual-v1.md) ([ADR-0008](docs/arquitectura/adr/0008-linea-visual-marca-y-clientes-web.md)) corrió en paralelo a Fase 1 y terminó el 2026-10-25. V1.1 entregó la [guía de marca](docs/diseno/marca-buoh.md), el [catálogo de funciones](docs/producto/funciones-y-disponibilidad.md), el [concepto de interfaz](docs/diseno/concepto-de-interfaz.md) y `packages/design-system`. V1.2 entregó el prototipo navegable en `apps/web`, con datos ficticios (`V1-UI-001`). V1.3 entregó el [sitio oficial](docs/diseno/sitio-oficial.md) en `apps/site`, sin publicar (`V1-SITE-001`). V1.4 entregó el prototipo móvil en `apps/mobile` y compartió los datos ficticios en `packages/prototype-data` (`V1-MOBILE-001`, [ADR-0009](docs/arquitectura/adr/0009-prototipo-movil.md)). V1.5 entregó el prototipo de escritorio en `apps/desktop`, con Tauri 2 y un instalador de Windows compilado en CI (`V1-DESKTOP-001`, [ADR-0010](docs/arquitectura/adr/0010-prototipo-de-escritorio.md)). V1.6 cambió la identidad al logo del propietario, vectorizado, con su paleta, la tipografía Sen y un estilo más técnico (`V1-BRAND-002`, [ADR-0011](docs/arquitectura/adr/0011-identidad-desde-el-logo-del-propietario.md)). No cambió el alcance ni la puerta de salida de Fase 1.

## Trabajo en paralelo autorizado

Ninguno. La línea visual V1 terminó el 2026-10-25 (plan V1, §7): sus requisitos tienen evidencia fusionada, y el propietario decidió que sus aprobaciones ya registradas (ADR-0010 §4 y ADR-0011, «Contexto») cuentan como la revisión de capturas de los prototipos y del sitio. Sus piezas siguen en el repositorio; los directorios y dependencias nuevos necesitan un plan activo (AGENTS.md, «Desarrollo por fases»).

Cerrar V1 no autoriza la app real de Windows: la decisión 6 de ADR-0001 la deja para cuando esté validado el núcleo web y móvil, y el roadmap la sitúa en la Fase 7. El prototipo de escritorio no la adelanta. La prioridad del propietario del 2026-10-26 por una app de escritorio con datos reales («Decisiones vigentes relevantes») tampoco lo autoriza todavía: antes hace falta su plan, y entonces se revisará esa decisión de ADR-0001. El costo del alojamiento ya está decidido ([ADR-0016](docs/arquitectura/adr/0016-alojamiento-del-sistema-de-datos.md)).

## Siguiente tarea autorizada

**`F2.2` — Sistema de datos en producción.**

Primero, la ADR de despliegue (plan de Fase 2, §8, punto 2): las condiciones de [ADR-0016](docs/arquitectura/adr/0016-alojamiento-del-sistema-de-datos.md) §4 que quedan después del punto de control, como los roles, la retención, las reglas de `ingest` en producción, las comprobaciones de R2, dónde y cada cuánto corre `data:health`, las credenciales y la región. Después, su implementación (`F2-DEPLOY-001`, `F2-ROLE-001` y `F2-RETENTION-001`).

Punto de partida: la condición «Memoria» de ADR-0016 §4 se cumple. Con un log de 7 días, `ingest` llegó como mucho a 124 MiB y `data:health` a 118 MiB, con los tamaños de V8 con los que arrancan (`WORKER_NODE_FLAGS`; «Evidencia de F2.1»), así que el worker Standard no hace falta (plan §12). El despliegue tiene que arrancarlos con esos tamaños (ADR-0017 §9). Las decisiones de F2.2 del plan §12 están tomadas: la región, la retención y el acceso del agente a producción («Decisiones vigentes relevantes»).

No se crea ni se paga nada hasta que esté listo el PR de despliegue, que le da al propietario los pasos exactos (ADR-0016 §3).

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
- 7 pruebas de contratos más (29 en total):
  - `symbol = null` en `invalid_source_frame` se acepta solo con el esquema de incidencias 2.0.0; 1.0.0 y versiones sin lector (2.1.0, 3.0.0, 99.0.0) se rechazan;
  - `validateDatasetConsistency` acepta el vector v1 y rechaza con `DATASET_VERSION_MISMATCH` un source event, tick, incidencia o condición con otra versión que la del manifiesto, y una incidencia con otras reglas.
- 5 pruebas del worker:
  - con reglas 2.0.0, un ping queda durable en el log sin tick, alarma ni incidencia, y el dataset se publica y se reproduce en ambos modos;
  - `--verify-only` rechaza una incidencia con otra versión que la del manifiesto, un esquema de incidencias sin lector o incoherente con las reglas;
  - la recomputación aborta ante un conjunto de reglas no implementado.
- Los vectores v1 siguen reproduciéndose byte a byte con reglas 1.0.0.

## Evidencia de F1.4b

Catálogo versionado (`F1-CATALOG-001`) y adaptador público de Deriv (`F1-SOURCE-001`), en la secuencia de siete PR de ADR-0012 §12.

- Pruebas offline, sin red, reloj real ni aleatoriedad:
  - contratos (40 en total): `SourceCatalogSnapshot`, su JSON Schema, su orden y sus dos hashes;
  - dominio (79 en total): validador por dialecto (Ajv 2020 o `ajv-draft-04`), perfil de medición que nunca publica, conversión del catálogo con sus seis motivos e incidencia de respuestas pedidas;
  - worker (122 en total): carga de `schemas.zip` con su SHA-256, sus límites y las huellas de sus 14 entradas (18); adaptador con socket, reloj y temporizador falsos, que cubre catálogo, suscripción, keepalive, tiempos de espera, cola y sus límites, frame cortado, cierres y respuestas pedidas (41); bloqueo por fuente (4); y el smoke con su resultado saneado y sus salidas 0, 1 y 2 (12).
- `pnpm run test:integration` (44 en total, 24 de F1.4b): el corte de `ws` con un servidor local, con un mensaje entero y uno fragmentado, y un cierre previsto sobre `ws` real; versiones del catálogo, incidencias de respuestas pedidas y bloqueo por fuente contra PostgreSQL 18 y almacenamiento S3-compatible.
- Smoke vivo opt-in, `pnpm run data:smoke -- --live`, el 2026-10-26 de 14:34:24 a 14:36:24 UTC, con la release de esquemas `production_v20260901_0` (SHA-256 `adaab0ac…e7c3`). Resultado saneado:
  - `passed`, salida 0, cierre `requested`;
  - `R_100`, «Volatility 100 Index», en un catálogo de 89 entradas (`content_sha256` `cf5b1c49d668b2fe8388029455ba32e58ff26b2c27c443604def0c2a8ce15141`);
  - 66 frames durables en memoria: 61 ticks, 2 `ping` y una respuesta a `active_symbols`, `time` y `forget_all`; ningún frame inválido ni incidencia;
  - retraso de entrega de los 60 ticks posteriores al primero, en ms: mínimo 189, p50 263, p90 356, y p99 y máximo 454. El primero llegó con 917 ms; puede ser un tick que Deriv ya tenía al suscribirse, y por eso va aparte;
  - 2000 ms entre las horas de ticks consecutivos en los 60 intervalos, y 931 ms de desfase medido con la hora del servidor;
  - Deriv da sus horas en segundos enteros, así que el retraso y el desfase medidos pueden superar a los reales hasta en 999 ms;
  - nada se escribió fuera del proceso (ADR-0004 §13).

## Evidencia de F1.5

Reconexión sin ocultar huecos (`F1-RECONNECT-001`) y salud machine-readable (`F1-HEALTH-001`), en la secuencia de siete PR de ADR-0015 §13 (#33, #35 a #39 y #41), más las correcciones que encontraron los ensayos: #40 (el `pip_size` de la historia) y #42 y #43 (la orden del runbook para parar `ingest`).

- Pruebas offline, sin red, reloj real ni aleatoriedad: dominio 137 y worker 574 en total, con la sesión, la espera, la reparación de cierres, la recuperación con `ticks_history`, el cursor, el latido, la retención, `ingest` y las siete reglas de `data:health`, con socket, reloj, temporizador y azar falsos.
- `pnpm run test:integration` (77 en total): la migración `0004`, el cursor y el latido, el bloqueo de PostgreSQL, `ingest` y `data:health` contra PostgreSQL 18 y almacenamiento S3-compatible.
- Los nueve ensayos de ADR-0015 §12, el 2026-10-29, contra el canal público de Deriv y un PostgreSQL y un almacenamiento desechables: todos pasan, y cada punto de la Definition of Done del plan §9 tiene su evidencia ([evidencia de la puerta de salida de Fase 1](docs/operacion/evidencia-puerta-fase-1.md)). La primera pasada encontró que la historia real trae `"pip_size":2.0`, que la recuperación rechazaba; #40 lo corrigió y los ensayos se repitieron.

## Evidencia de F2.1

Punto de control de la derivación en vivo (`F2-CHECKPOINT-001`) y guardia documental de `packages/domain` (`F2-GOV-001`), en la secuencia de seis PR de [ADR-0017](docs/arquitectura/adr/0017-punto-de-control-de-la-derivacion-en-vivo.md) §11 (#48 a #50, #52, #54 y el de la evidencia).

- Equivalencia sin red, reloj real ni azar: en cada límite de segmento cerrado de los vectores v1, de los logs sintéticos escritos a mano, de 300 logs aleatorios y de los logs que no se derivan, el pliegue del dominio da lo mismo que `deriveMarketData`, y en el worker, el arranque, la reparación de cierres, la vigilancia de huecos y `evaluateDataHealth` dan desde el punto de control lo mismo que con el log entero. Los vectores v1 se reproducen byte a byte. Pruebas offline: dominio 157 y worker 807 en total.
- `pnpm run test:integration` (92 en total): la tabla de la migración `0005`, la escritura de `ingest` al cerrar cada segmento, los lectores de la sesión y `data:health`, que no lee los objetos anteriores a su punto de control ni aplica dos veces un segmento recién cerrado, contra PostgreSQL 18 y almacenamiento S3-compatible.
- Memoria, el 2026-10-31, con logs sintéticos de un día (45 122 eventos) y de 7 (315 842) ([evidencia de memoria de F2.1](docs/operacion/evidencia-memoria-f2-1.md)). Máximos con el log de 7 días: `ingest`, 124 MiB al arrancar reconstruyendo los puntos de control, 113 MiB al arrancar con ellos y 118 MiB durante una reconexión con hueco; `data:health`, 118 MiB sin punto de control y 87 MiB con él. Todos a menos de un 8 % de los de un día y por debajo de los techos de 200 MiB y 160 MiB. `ingest` y `data:health` arrancan con los tamaños de V8 que Node elige con 512 MiB (`WORKER_NODE_FLAGS`): en el sandbox, donde Node ve 31 GiB, sin ellos la reconstrucción sin punto de control llegaba a 296 MiB con un día de log.
- La guardia documental tiene una regla para `packages/domain/**` desde el PR #49.

## Pendientes registrados de F1.4a

Detectados en la revisión semántica del PR #8; ninguno bloqueó F1.5:

1. El JSON Schema generado `data-quality-incident.schema.json` todavía acepta `symbol = null` en `invalid_source_frame` con el esquema de incidencias 1.0.0. El runtime sí lo rechaza. Falta la condición `if`/`then` en esa rama, añadida desde `packages/contracts/scripts/generate-json-schemas.ts` o la fuente Zod, nunca a mano en el archivo generado.
2. Las pruebas que ligan versiones al manifiesto no fijan qué campo del manifiesto lee cada comprobación, porque en el vector v1 todas las versiones son 1.0.0. Falta un caso que mueva un campo y sus registros juntos a una versión sin usar.

El antiguo pendiente 3 (el sink `nonTickFrame` no deja ver un `error`) quedó resuelto en F1.4b: el adaptador interpreta cada respuesta sobre el texto que conserva, después de que su frame sea durable (ADR-0012 §5).

## Pendientes registrados de F1.3

Detectados en las revisiones semánticas de F1.3a (PR #6) y F1.3b (PR #7); la lista completa está en cada PR. Los más relevantes para el despliegue:

1. Si la conexión cae durante el `COMMIT` de una publicación, se informa "no se confirmó" aunque pudo confirmarse.
2. Publicar no aplica los límites de lectura del replay. `normalized_ticks` y `quality_incidents` son un único artefacto que crece con el dataset. Resolver antes de publicar datasets live largos.
3. Los nombres de `PublicationStep` no coinciden con `PersistenceStage`; los fallos de publicación todavía no entran en el registro operativo.
4. El worker usa un único rol PostgreSQL dueño de las tablas. Antes de desplegar (ADR-0006) hace falta un rol de ejecución que solo pueda insertar y leer.
5. SeaweedFS `mini` arranca componentes internos que no se usan (Iceberg, Lance, servidor de administración).

El antiguo pendiente 6 (un solo escritor por fuente) quedó resuelto en F1.5 con `ingest` (PR #38), el primer proceso que escribe el log de forma continua: escribe con el log protegido por el bloqueo (`openLockedSourceLog`), vuelve a tomar el bloqueo antes de reconectar si lo perdió y termina con `source_lock_taken` si lo tiene otro proceso ([ADR-0015](docs/arquitectura/adr/0015-reconexion-recuperacion-y-salud-f1-5.md) §3, «Bloqueo»). F1.4b lo había resuelto en parte: el transporte entrega una llamada a la vez, y `fixture:publish` toma antes el bloqueo de su fuente, que nota una sesión perdida en unos 10 s (ADR-0012 §9).

El antiguo pendiente 7 quedó resuelto en F1.5 ([ADR-0015](docs/arquitectura/adr/0015-reconexion-recuperacion-y-salud-f1-5.md) §3). Tras un fallo de persistencia, la sesión repara antes del socket siguiente el `ConnectionClosed` que no quedó durable (`close_not_recorded`), así que la caída queda en el log con `connection_lost` y su recuperación. Un evento que el índice confirmó aunque informó error se adopta al reabrir, sin cerrar dos veces la misma conexión, y la sesión vuelve a leer del log la conexión anterior y el high-watermark; ese evento no se entrega a quien escucha, como acepta §12 (punto 7). Lo demostraron en vivo los puntos 3, 5 y 6 de la puerta de salida.

## Pendientes registrados de F1.2

Detectados en la revisión semántica del PR #5:

El antiguo pendiente 1 (atribución de símbolo y mensajes que no son ticks) quedó resuelto en F1.4a.

2. Cuando la salud está en `recovering` por continuidad pendiente, el `HealthReport` no muestra la causa: `open_condition_types` queda vacío.
4. `qualityProfileSchema` está duplicado entre `packages/domain` y `packages/contracts/src/vector-integrity.ts`.
5. `typecheck` y `lint` resuelven `@buoh/contracts` con `paths` al código fuente; vitest usa `dist`. Ejecutar `pnpm run test`, no vitest directo. `apps/market-data-worker` sigue el mismo patrón.

El antiguo pendiente 3 (el mapa de impacto sin regla para `packages/domain/**`) quedó resuelto en F2.1 (`F2-GOV-001`, PR #49).

El antiguo pendiente 6 quedó resuelto en F1.5 ([ADR-0015](docs/arquitectura/adr/0015-reconexion-recuperacion-y-salud-f1-5.md) §4, «Orden»): el `HistoryRecoveryResult` pasa por la misma cola que los frames, y la sesión lo pide 2000 ms después del primer tick durable posterior al cierre, así que siempre queda después de él. Los puntos 3, 5 y 6 de la puerta de salida volvieron así a `healthy`.

## Decisiones vigentes relevantes

- TypeScript estricto es el lenguaje principal; Python queda fuera de la ruta de ingesta inicial.
- Fase 1 usa PostgreSQL estándar y almacenamiento S3-compatible; TimescaleDB y Redis están diferidos hasta demostrar su necesidad. En local, PostgreSQL 18 y SeaweedFS (ADR-0005).
- El adaptador inicial usará únicamente el WebSocket público de Deriv, sin autenticación.
- Datos crudos y normalizados son artefactos distintos; una incidencia nunca reescribe el dato crudo.
- JSON Schema representa estructura interoperable; las invariantes criptográficas y relacionales requieren validación runtime.
- Las pruebas offline sintéticas son bloqueantes. El smoke público de Deriv (`pnpm run data:smoke`) existe desde F1.4b y nunca constituye el único criterio de merge.
- Los umbrales live de retraso y hueco no se inventan: se fijan con mediciones reales de los retrasos, y mientras tanto los datos live no se publican como dataset (decisión del propietario para F1.4b; ADR-0004 §13 y ADR-0012 §8).
- Sin umbrales live, el estado vivo se derivará con el perfil de medición: tras un cierre no pedido, solo la historia demostrará la continuidad, y el estado vivo no mostrará retrasos ([ADR-0015](docs/arquitectura/adr/0015-reconexion-recuperacion-y-salud-f1-5.md) §2, decisión de la dirección técnica).
- Hasta incorporar un writer Parquet, ticks e incidencias se publican como NDJSON sin compresión; `dataset_id` no depende del formato físico.
- Alojamiento productivo en Render para PostgreSQL, API y web; el despliegue sigue diferido ([ADR-0006](docs/arquitectura/adr/0006-alojamiento-en-render.md)), salvo el sitio oficial, que se publica como sitio estático gratuito ([ADR-0013](docs/arquitectura/adr/0013-publicacion-del-sitio-en-render.md)).
- Alojamiento del sistema de datos (decisión del propietario del 2026-10-29, «Ok me parece perfecto todo»): `market-data-worker` en un background worker Starter de Render, PostgreSQL en Render Postgres Basic-256mb y los objetos en Cloudflare R2, por unos 15 USD al mes, unos 22 cuando exista la API. No se crea ni se paga nada hasta que esté listo el PR de despliegue ([ADR-0016](docs/arquitectura/adr/0016-alojamiento-del-sistema-de-datos.md)).
- Servidor del motor de señales *shadow* (decisión del propietario del 2026-10-29, «1. Si, un servidor pequeño para el bot»): `apps/signal-engine` corre en su propio background worker Starter de Render, unos 7 USD más al mes, para que un fallo o una actualización del bot no corte la captura ni la web. El total de la Fase 2 queda en unos 29 USD al mes, y ese servidor se compra con F2.9 ([plan de Fase 2](docs/plan/fase-2-laboratorio-y-bot-shadow.md) §11).
- Símbolo de la Fase 2 (la misma respuesta del propietario, que el agente toma como un sí a su propuesta de empezar solo con R_100): el bot *shadow* empieza solo con R_100 (Volatility 100 Index), el índice que ya se captura. El universo definitivo sigue pendiente.
- Región del sistema de datos (respuesta del propietario del 2026-10-31, «vivo en brasil no se si te parece que el servidor este en brasil, sera en render»): Render no tiene región en Brasil. Tiene Oregon, Ohio y Virginia, en Estados Unidos, Frankfurt y Singapur, así que el agente propuso Virginia (EE. UU. este), la más cercana a Brasil. `ingest`, PostgreSQL y los demás servicios van en esa región, porque los servicios de Render solo comparten red privada dentro de una misma región. El bucket de R2 se crea con la indicación de ubicación del este de Norteamérica (`enam`). El propietario la aprobó al fusionar el cambio que la registra. La aplica el PR de despliegue, y después no se puede cambiar sin crear de nuevo los servicios y la base de datos.
- Retención de producción (el propietario la delegó el 2026-10-31: «cuanto tiempo guarda los datos lo decides tu»): la fija la dirección técnica en la ADR de despliegue, después de revisar qué permiten guardar los términos de Deriv (`F2-RETENTION-001`), sin subir el presupuesto aprobado. Subirlo, por ejemplo pasando el disco de PostgreSQL de 1 a 5 GB, necesita antes el visto bueno del propietario. Punto de partida: 30 días de log crudo, que con R_100 ocupan unos 1,1 GB de objetos en R2 y unos 0,4 GB de PostgreSQL (estimación con el espacio por evento de [ADR-0016](docs/arquitectura/adr/0016-alojamiento-del-sistema-de-datos.md)), y cada dataset publicado al menos tanto como la evidencia que lo cite.
- Acceso del agente a producción (decisión del propietario del 2026-10-31, «si te dare acceso de produccion tambien acceso total»): el agente tendrá acceso a producción y usará el mínimo que cada tarea necesite. Por defecto, solo lectura: un token de R2 de solo lectura del bucket de producción y el rol de solo lectura de PostgreSQL (`F2-ROLE-001`), con los que puede correr `data:health` contra producción. Un permiso de escritura, solo para una tarea concreta, con el visto bueno del propietario ese día, y se retira al terminarla. La creación de servicios y las compras las hace el propietario con los pasos del PR de despliegue (ADR-0016 §3), y los cambios llegan por PR, que él fusiona. Las credenciales nunca pasan por el chat ni por Git. En el plan Hobby, Render no deja añadir miembros con un rol de solo lectura, y sus claves de API dan acceso a toda la cuenta, salvo las de alcance limitado, que están en acceso anticipado. La ADR de despliegue decide cómo llega lo que haga falta de Render, como la memoria medida.
- MetaTrader 5 entra por un puente MQL5 dentro de la terminal; cada servidor MT5 es una fuente propia; las contraseñas MT5, solo de cuentas propias, las guarda la terminal y los servicios de buoh nunca las reciben ([ADR-0007](docs/arquitectura/adr/0007-varias-fuentes-y-metatrader-5.md)).
- Prioridad del propietario (2026-10-26): el sitio oficial y la app de escritorio, que debe mostrar datos reales de Deriv. Consecuencia técnica: esos datos llegan por la API de buoh ([arquitectura objetivo](docs/arquitectura/arquitectura-objetivo.md), «Windows (futuro)»), y para eso el sistema de datos tiene que funcionar todo el día en un servidor. Por eso fueron antes la reconexión y la salud de F1.5 y la decisión del costo del alojamiento ([ADR-0016](docs/arquitectura/adr/0016-alojamiento-del-sistema-de-datos.md)). El alojamiento, la API y las pantallas con datos reales están en el [plan de Fase 2](docs/plan/fase-2-laboratorio-y-bot-shadow.md) (F2.2 a F2.4); el plan de la app de escritorio con datos reales se escribe cuando existan (plan §6).
- Orden de fases (decisión del propietario del 2026-10-29, «Ok vamos con la fase 2»): la Fase 2 va antes que la Fase 1B (datos MT5), que queda para después, sin fecha.
- Desde el móvil se pueden encender y apagar estrategias del bot, también con dinero real, como con un control remoto. Ningún cliente abre operaciones a mano ni se comunica con el bróker para ejecutar: todo pasa por el servidor, `execution-gateway` y su política de riesgo ([catálogo de funciones](docs/producto/funciones-y-disponibilidad.md) §1; decisión del propietario del 2026-10-25).

## Bloqueos

Ninguno.

## Decisiones pendientes

- Jurisdicción inicial del producto comercial.
- Universo definitivo de índices y tipos de contrato. La Fase 2 empieza solo con R_100 («Decisiones vigentes relevantes»).
- Cómo inicia sesión el propietario en buoh. Se decide en la ADR de la API y las cuentas (F2.3).
- Qué idiomas tiene el producto, para la preferencia de idioma del catálogo de funciones. Se decide en F2.4.
- Qué tipo de operación representan las posiciones hipotéticas del bot *shadow*, dentro de lo que ofrece Deriv para R_100. Se decide antes de abrir la ADR del modelo de estrategia (F2.6).
- Cómo se reanuda una estrategia *shadow* detenida por datos degradados: a mano, como pide hoy el [protocolo de validación](docs/gobierno/protocolo-de-validacion-de-estrategias.md) §5, o sola tras las degradaciones breves que la historia cubre, lo que cambia ese protocolo. Se decide antes de abrir la ADR del motor de señales (plan de Fase 2, `F2-STOP-001`).
- Equipo de la terminal MT5 (PC dedicado del propietario o servidor Windows o Linux con Wine) y su protección. Se decide en el primer incremento de Fase 1B (ADR-0007).
- Revisión de términos de Deriv MT5, Vantage y MetaQuotes, y entidad de Vantage aplicable. Se completa en el primer incremento de Fase 1B.
- Dominio propio del sitio oficial y revisión legal de su texto, antes de comprar el dominio, quitar el `noindex` o anunciarlo (ADR-0013).
- Firmar el instalador de escritorio antes de distribuirlo (ADR-0010). El propietario ya lo instaló y probó en su PC el 2026-10-25.
- Probar la app móvil en un teléfono real (Expo Go para el SDK 58 aún no está en las tiendas, o una compilación nativa), y cómo compilarla y distribuirla (ADR-0009).
- Qué cuenta como reautenticación en un teléfono para pedir el modo `real` o volver a encender una estrategia en `real` desde el móvil. Se define en la revisión de amenazas de la Fase 5 (P-V1-05 de la [especificación de pendientes](docs/plan/especificacion-de-pendientes.md)).
- Límites monetarios y política de riesgo para fases `demo` y `real`.
- Proveedor de pagos y modelo de suscripción.

## Evidencia requerida para cambiar de fase

La Fase 2 solo puede marcarse `done` cuando cumple la Definition of Done de su [plan](docs/plan/fase-2-laboratorio-y-bot-shadow.md) (§13), que concreta el criterio de salida del roadmap («Objetivo actual»). La Fase 1 cumplió el suyo el 2026-10-29 («Evidencia de F1.5»).

## Mantenimiento obligatorio

Actualizar este archivo en el mismo PR cuando cambie cualquiera de estos elementos:

- fase o estado de fase;
- objetivo o tarea siguiente;
- bloqueo o decisión pendiente;
- componente autorizado para implementarse;
- evidencia de una puerta de salida.

No actualizarlo por cambios internos que no alteren el estado del proyecto. No registrar porcentajes subjetivos de avance ni afirmar verificaciones no ejecutadas.
