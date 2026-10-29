# Evidencia de la puerta de salida de Fase 1

Evidencia de los nueve ensayos de [ADR-0015](../arquitectura/adr/0015-reconexion-recuperacion-y-salud-f1-5.md) §12 y de cada punto de la Definition of Done del [plan de Fase 1](../plan/fase-1-fundacion-de-datos.md) §9, reunida el 2026-10-29. Con ella, para marcar la Fase 1 como `done` solo falta la decisión del propietario sobre el orden entre la Fase 1B (datos MT5) y la Fase 2 (bot shadow) (ADR-0015 §12; `PROJECT_STATUS.md`, «Bloqueos»).

Los ensayos capturaron datos reales de Deriv en un PostgreSQL y un almacenamiento de objetos desechables, que se borraron al terminar cada secuencia (ADR-0015 §7, ADR-0004 §13). Este documento solo trae lo que no es dato de mercado: horas UTC, estados, motivos, conteos, esperas e identificadores. Ningún precio, payload, credencial, host ni puerto. Las salidas crudas de cada orden quedaron fuera de Git.

## Entorno

- Sandbox de Kiro, sin Docker. PostgreSQL 18.4 y SeaweedFS 4.48 portátiles, como dice `.kiro/steering/entorno-sandbox-kiro.md` («PostgreSQL y SeaweedFS sin Docker»), solo en `127.0.0.1` y con credenciales generadas para la sesión, fuera del repositorio. CI usa PostgreSQL 18.6 (`infra/compose.yaml`).
- Node.js 24.22.0 y pnpm 12.14.0 (`devEngines`). `BUOH_DEPLOYMENT_ENVIRONMENT=test`. Cada secuencia, con un esquema y un bucket propios, creados y borrados con los pasos de «Captura viva continua (`ingest`)» del [runbook](runbook-ingesta-de-datos.md).
- Deriv: el canal público fijado (`DERIV_PUBLIC_ENDPOINT`), la release de esquemas `production_v20260901_0` (SHA-256 `adaab0acaf33bd159e45912995af2b78101049f43683d223f0ac11be0a39e7c3`), el conector `deriv-options-ws-1.1.0` y el símbolo `R_100`, sin credenciales.
- Código: `main` en `2dffd23` (PR #35 a #40) más las herramientas de `scripts/evidencia-f1-5/`, que no son comandos del producto («Puerta de salida de Fase 1» en el runbook dice cómo repetir cada secuencia). `psql` no estaba instalado, así que los bloques SQL del runbook corrieron tal cual con un sustituto mínimo sobre `pg` de Node.

## Un fallo que encontraron los ensayos

La primera pasada (08:49–09:11 UTC) falló en los puntos 2 y 3. La respuesta real de `ticks_history` trae `"pip_size":2.0`, y la recuperación de historia solo admitía un lexema entero, así que toda recuperación viva terminaba `unavailable` con `history_invalid` y la captura quedaba en `degraded` con `event_gap_unresolved`. Las pruebas no lo vieron porque sus fixtures mandaban `"pip_size":2`. El PR #40 lo corrigió (`pipSizeFromNumberLexeme`, solo para la historia) y los puntos 1 a 8 se repitieron después con el arreglo. Los resultados de abajo son los de esa segunda pasada; el punto 9 no depende del arreglo y viene de la primera.

## Los nueve ensayos (ADR-0015 §12)

| Punto | Resultado | Clave |
|---|---|---|
| 1. Captura viva continua con `ingest` | pasa | 181,4 s de captura; `healthy` a los 10,9 s y en las tres instantáneas siguientes |
| 2. Desconexión: smoke con corte | pasa | `passed`; 1 reconexión; recuperación `complete`; cierre previsto durable |
| 3. Reinicio sin aviso (`SIGKILL`) | pasa | `close_not_recorded`, apertura que lo supera, recuperación `complete`; `healthy` 8,0 s después de matar el proceso |
| 4. Reinicio programado (`SIGTERM`) | pasa | cierre `requested` durable, apertura que lo supera, ningún hueco; `healthy` 6,0 s tras arrancar |
| 5. Almacenamiento de objetos parado | pasa | `persistence_unavailable` abierta y resuelta; `paused` mientras duró; reparación, recuperación `complete` y `healthy` |
| 6. PostgreSQL parado | pasa | `paused` por la regla 3; bloqueo nuevo con otro PID; reparación, recuperación `complete` y `healthy` |
| 7. Ningún dato no durable emitido | pasa | 129, 23 y 24 ticks entregados en las tres capturas, todos frames durables del log |
| 8. Incidencias visibles tras reiniciar | pasa | conteos por tipo antes y después de cada reinicio, y `data:health` en cada paso |
| 9. Replay | pasa | los dos datasets sintéticos se reproducen y verifican con su `dataset_id` |

### 1. Captura viva continua

`capture.mjs` corrió la sesión de ingesta con el cableado de `ingest` (almacenes de PostgreSQL y S3, bloqueo de PostgreSQL, log protegido, cursor, latido y retención de 23 horas), y su sink anotó cada tick entregado. Arrancó a las 09:35:06.402Z y llegó a `healthy` a las 09:35:17.332Z. Siguió `healthy` en `data:health` a +1, +2 y +3 minutos y se mató a las 09:38:07.801Z, tras 181,4 s y 91 ticks. Antes de matarla, el log tenía 1 segmento, 1 `connection_opened` sin cierre, 96 frames raw, 91 ticks derivados, ninguna incidencia, ninguna condición y ningún hueco pendiente; el latido decía `connected` y había escritor vivo.

### 2. Desconexión

`pnpm run data:smoke -- --live --duration-seconds 120 --interrupt-after-seconds 30`, en memoria, de 09:40:25Z a 09:42:25Z: salida 0 y `passed`. Hubo 2 conexiones y 1 reconexión tras el corte `smoke_interrupt`, con una espera de 776 ms. La recuperación fue `complete` en 1 intento y 1 página, con `recovered_event_count` 0, porque en el corte no se perdió ningún tick. El cierre final fue el previsto (`requested`, durable). Llegaron 68 frames y 61 ticks, sin frames inválidos ni incidencias. La primera pasada ya había dado los mismos frames, pero con la recuperación `unavailable`; la segunda solo cambia por el arreglo.

### 3. Reinicio sin aviso

La captura del punto 1 terminó por `SIGKILL` a las 09:38:07.805Z, sin línea JSON. Justo después, `data:health` dio `paused`, `disconnected` y `connection_lost`: sin escritor vivo, la regla 4 deriva el cierre que registrará el próximo arranque. La segunda captura arrancó a las 09:38:09.194Z. Primero cerró la conexión anterior con `transport_error` / `close_not_recorded` (09:38:10.099Z); después abrió una nueva que la supera (`supersedes_connection_id`, 09:38:10.300Z); al primer tick posterior al cierre pidió la historia y obtuvo `complete`, con 1 tick recuperado. `data:health` dio `healthy`, con salida 0, a las 09:38:15.819Z (6,6 s tras arrancar y 8,0 s tras el `SIGKILL`) y otra vez 31 s después. Solo quedó `connection_lost`, abierta y resuelta.

### 4. Reinicio programado

`SIGTERM` a la segunda captura a las 09:38:47.330Z: salida 0, fin `completed` y cierre `requested` durable (09:38:47.355Z). Con el log en ese estado no había ningún hueco pendiente. La tercera captura arrancó a las 09:38:48.209Z, abrió una conexión que supera a la anterior, no pidió ninguna recuperación y dio `healthy` a las 09:38:54.214Z (6,0 s tras arrancar) y otra vez 31 s después. El intervalo parado queda visible en el log como un cierre pedido seguido de una apertura, sin hueco que recuperar (ADR-0015 §10).

### 5. Almacenamiento de objetos parado

En una captura `healthy`, SeaweedFS se paró a las 09:55:51.002Z y volvió a las 09:56:13.280Z (22,3 s). Mientras estuvo parado, la captura siguió viva y `data:health` dio `paused` con `data_health_storage_unavailable` / `ECONNREFUSED` en cada sondeo. El registro operativo, en PostgreSQL, abrió `persistence_unavailable` 2 veces, con 5 incidencias: 1 en `raw_object_write` y 4 en `source_event_index`. La sesión esperó 678, 1227, 2498, 5423 y 13 119 ms entre intentos. Al volver, cerró la conexión perdida con `close_not_recorded`, abrió una nueva que la supera y recuperó el hueco con `complete` y 11 ticks. Las dos condiciones se resolvieron con `persistence_restored`, y `data:health` dio `healthy` 29,2 s después de volver el almacenamiento.

### 6. PostgreSQL parado

En una captura `healthy`, PostgreSQL se paró a las 09:57:59.050Z y volvió a las 09:58:15.219Z (16,2 s). Mientras estuvo parado, `data:health` dio `paused` por la regla 3 (`data_health_storage_unavailable` / `ECONNREFUSED`) en los cuatro sondeos. En el stderr de la captura quedaron solo avisos saneados: `source_lock_unavailable` / `ECONNREFUSED` ×4, `operational_registry_unavailable` / `ECONNREFUSED` ×1 y `postgres_connection_lost` / `57P01` ×2. La conexión terminó `paused` con `persistence_unavailable`, sin cierre durable, y la sesión esperó 842, 1268, 2452, 4262 y 12 092 ms.

Al volver, la sesión tomó un bloqueo nuevo: los latidos pasan del PID 1794 al 2542, con el mismo `run_id`. Cerró la conexión anterior con `close_not_recorded` (09:58:21.297Z), abrió una que la supera (09:58:21.364Z) y recuperó el hueco con `complete` y 10 ticks. `data:health` dio `paused` sin escritor vivo, después `recovering` (09:58:22.017Z) y `healthy` a las 09:58:27.552Z, 12,3 s después de volver PostgreSQL. El registro operativo terminó sin condiciones abiertas.

### 7. Ningún dato no durable emitido

Cada `observation_id` que el sink recibió se buscó en el log al final, entre los frames raw durables. En los reinicios, 129 de 129 (91, 19 y 19 por captura), incluidos los entregados justo antes del `SIGKILL`; con el almacenamiento parado, 23 de 23; con PostgreSQL parado, 24 de 24. No faltó ninguno. Al revés no hace falta (ADR-0015 §12): un evento que el índice confirmó aunque informó error se adopta al reabrir sin haberse entregado.

### 8. Incidencias visibles tras reiniciar

`count-incidents.mjs` deriva del log, solo leyendo y con el código del worker, las incidencias y condiciones por tipo, los huecos pendientes y las recuperaciones. Se ejecutó antes y después de cada reinicio y de cada fallo, y `data:health` en cada paso.

| Paso de los reinicios (UTC) | Conexiones | Recuperaciones | Incidencias | Condiciones abiertas | Huecos | Ticks |
|---|---|---|---|---|---|---|
| antes del `SIGKILL`, 09:38:07 | 1, abierta | — | — | — | 0 | 91 |
| tras el `SIGKILL`, 09:38:09 | 1, sin cierre | — | — | — | 0 | 91 |
| tras el reinicio, 09:38:16 | 2: `close_not_recorded`, abierta | `complete` 1 | `connection_lost` 1 | — | 0 | 94 |
| tras el `SIGTERM`, 09:38:48 | 2: `close_not_recorded`, `requested` | `complete` 1 | `connection_lost` 1 | — | 0 | 110 |
| tras el reinicio, 09:38:54 | 3: …, abierta | `complete` 1 | `connection_lost` 1 | — | 0 | 114 |
| final, 09:39:26 | 3: …, `requested` | `complete` 1 | `connection_lost` 1 | — | 0 | 129 |

`data:health -- --json` en los 15 pasos de los reinicios: `paused` y `disconnected` con el esquema vacío, al arrancar y con la captura parada (salida 1); `healthy` y `connected` en cada captura en marcha (salida 0); `paused` con `connection_lost` justo después del `SIGKILL`. En los puntos 5 y 6, `paused` mientras duró el fallo, `recovering` al reconectar y `healthy` después. Nunca hubo backlog, y `execution_mode` siempre fue `disabled`.

### 9. Replay

En un esquema y un bucket desechables (08:48:26–08:48:30 UTC): `db:migrate`, `fixture:publish` de los dos datasets sintéticos y `pnpm run data:replay -- --dataset <id>`, con y sin `--verify-only`. Se publicaron con los identificadores de `test-vectors/market-data/v1`: el principal, `sha256:611d83367d6b86a210ebdb30a2e73aa30dc35f8efd59f07fb43febf60c98defd`, y `zero-valid-ticks`, `sha256:7768d9551e4f5a2a0c16adaf1e93f98461b5cf894dac0c0c8fa7b1c1fe8d431f`. Los dos dieron `reproduced` (recomputación) y `verified` (`--verify-only`), con salida 0 y el mismo `dataset_id`.

## Definition of Done (plan de Fase 1, §9)

| Punto | Evidencia |
|---|---|
| Todos los requisitos `F1-*` tienen evidencia fusionada | `F1-FOUND-001`, `F1-CONTRACT-001` y `F1-GOV-001`: «Evidencia de F1.1» de `PROJECT_STATUS.md`. `F1-VECTOR-001` y `F1-QUALITY-001`: «Evidencia de F1.2» y «de F1.4a». `F1-DATASET-001`: «de F1.3a». `F1-STREAM-001`: «de F1.3b». `F1-CATALOG-001` y `F1-SOURCE-001`: «de F1.4b». `F1-RECONNECT-001`: PR #35 a #38 y #40, con las pruebas de reloj y transporte falsos y los puntos 2, 3, 5 y 6. `F1-HEALTH-001`: PR #35 y #39, con `data:health` en cada paso de estos ensayos |
| Un clon limpio ejecuta las verificaciones offline con el toolchain fijado | CI ejecuta `DOCS_BASE_REF=origin/main pnpm run verify:pr` y `pnpm run test:integration` sobre un clon limpio, con el Node y el pnpm fijados, en cada PR y en cada push a `main` (`CONTRIBUTING.md`); los dos pasaron sobre `main` en `2dffd23` |
| Los vectores se reproducen exactamente | `pnpm run test:vectors`, dentro de `verify:pr`, y el punto 9 |
| Un flujo público de Deriv se captura sin credenciales | Punto 1 (persistido) y punto 2 (en memoria) |
| Raw, normalizados e incidencias tienen procedencia y versiones | Contratos y log raw-first (F1.1 a F1.3b). Cada frame vivo del log lleva su `connector_version`, su conexión, la hora de recepción y el SHA-256 de su payload; la captura guarda el esquema de fuente de la release con su SHA-256 fijado, y `data:health` comprobó en cada paso el conector del log y ese esquema (regla 2, sin fallos) |
| Un dataset publicado conserva el mismo ID en replay | Punto 9 |
| Reinicio, desconexión y fallo de persistencia no ocultan pérdida ni emiten datos no durables | Puntos 2 a 8. Cada pérdida dejó un cierre no pedido (`close_not_recorded` o el del corte), con `connection_lost` y su recuperación en el log, y ningún tick entregado faltó entre los frames durables |
| `PROJECT_STATUS.md`, contratos, ADR y runbook reflejan el sistema real | Cada PR de ADR-0015 §13 actualizó el runbook y los contratos en el mismo commit que el código (la guardia documental lo exige). Este PR actualiza `PROJECT_STATUS.md`, la especificación de pendientes y el runbook |

## Límites y lo que no se demostró

- Los servicios fueron portátiles en el sandbox, no las imágenes de `infra/compose.yaml`, y PostgreSQL fue 18.4, no la 18.6 de CI. Las pruebas de integración de CI corren con las imágenes fijadas.
- Las capturas duraron minutos, no las 23 horas de la retención. La parada a las 23 horas y `retention_expired` solo están probadas con reloj falso.
- En el punto 2 la historia no trajo ningún tick que faltara (`recovered_event_count` 0). Los puntos 3, 5 y 6 sí recuperaron ticks (1, 11 y 10), así que el recuento intermedio está probado en vivo.
- Las incidencias derivadas solo incluyen las que este tráfico produjo. Los demás tipos están cubiertos por los vectores y las pruebas offline.
- Nada se publicó desde una captura viva: los datos live siguen sin publicarse hasta fijar sus umbrales (`PROJECT_STATUS.md`, «Decisiones vigentes relevantes»).
