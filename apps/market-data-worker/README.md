# @buoh/market-data-worker

Log raw-first de source events, registro operativo, publicación atómica y replay de datasets (F1.3: `F1-STREAM-001`, `F1-DATASET-001`). Decisiones en [ADR-0004](../../docs/arquitectura/adr/0004-pipeline-y-reproduccion-de-datos-fase-1.md) §7–§12 y [ADR-0005](../../docs/arquitectura/adr/0005-persistencia-local-y-formato-fisico-f1-3.md); operación en el [runbook](../../docs/operacion/runbook-ingesta-de-datos.md#entorno-local-y-replay-f13).

Desde F2.1, `ingest` escribe también, con el log protegido por el bloqueo, el punto de control del estado vivo de cada segmento que cierra (migración `0005`, `src/source-log/live-checkpoint.ts`; [ADR-0017](../../docs/arquitectura/adr/0017-punto-de-control-de-la-derivacion-en-vivo.md)). El arranque, la reparación de cierres y la vigilancia de huecos de la sesión parten del último válido y leen solo los segmentos posteriores, uno a uno (`src/source-log/live-reader.ts`); el arranque busca el evento del cursor en el índice. `data:health` lee igual, sin escribir nada, y sin un punto de control válido reconstruye el estado vivo en memoria (`src/health/observe.ts`). Los dos arrancan con los tamaños de V8 de `src/node-flags.ts`, para que su memoria no dependa de la máquina ([evidencia de memoria de F2.1](../../docs/operacion/evidencia-memoria-f2-1.md)).

Desde F1.4b tiene el adaptador público de Deriv, solo para escuchar, y su catálogo versionado ([ADR-0012](../../docs/arquitectura/adr/0012-catalogo-y-adaptador-publico-de-deriv.md)). `pnpm run data:smoke` corre en memoria la sesión de ingesta, que reconecta tras una pérdida y recupera la historia del hueco ([ADR-0015](../../docs/arquitectura/adr/0015-reconexion-recuperacion-y-salud-f1-5.md)); con `--interrupt-after-seconds`, corta su propio socket una vez para probarlo. `ingest` corre la misma sesión de forma continua sobre PostgreSQL y el almacenamiento de objetos, con un esquema y un bucket propios, el cursor y el latido, y para sola a las 23 horas para que la captura se borre antes de las 24 ([runbook](../../docs/operacion/runbook-ingesta-de-datos.md#captura-viva-continua-ingest)). `pnpm run data:health -- --json` deriva el `HealthReport` de esa captura desde fuera del proceso que ingiere, sin tomar el bloqueo ni escribir nada (`src/health/`; [runbook](../../docs/operacion/runbook-ingesta-de-datos.md#salud-de-datos-datahealth)).

## Flujo

```text
frame del transporte ─ RawFirstIngestor ─▶ límite de bytes (source_limit_exceeded → pausa)
                                          ▶ SourceEventLog.append: objeto JCS (S3) + índice (PostgreSQL)
                                          ▶ solo si es durable: normalizeRawFrame → sink
                                          ▶ si no: persistence_unavailable → pausa
segmentos (rotación 1.0.0 o cierre explícito) ─▶ objeto NDJSON gzip + fila de cierre
segmento cerrado (solo ingest) ─ LiveCheckpointWriter ─▶ foldLiveDerivation ─▶ live_derivation_checkpoints
segmentos cerrados ─ publishFromLog ─▶ publishDataset ─▶ objetos sha256/<hash>, documento, commit
dataset_id ─ replayDataset ─▶ verify-only: record, documento, hashes físicos/lógicos, contratos,
                             │              invariantes entre artefactos, versiones de contrato, core
                             ▶ recompute: además regenera con packages/domain y compara core e ID
```

- Puertos: `ObjectStore`, `MetadataStore`, `SourceLogStore` y `OperationalStore`. Adaptadores reales: `S3ObjectStore` y los `Postgres*Store`.
- `migrations/` contiene SQL append-only; `db:migrate` las aplica y rechaza migraciones aplicadas que cambiaron.
- `driveSyntheticStimuli` entrega los estímulos del vector al ingestor real, como un transporte.

## Comandos

Desde la raíz: `pnpm run test` (offline), `pnpm run test:integration` (requiere `infra/compose.yaml`), `pnpm run data:replay -- --dataset <id> [--verify-only]`, `pnpm run data:smoke -- --live` (prueba viva opt-in contra Deriv; no guarda nada) y `pnpm run data:health -- --json [--symbol R_100]` (salud de datos de una captura, con las variables `BUOH_*` de su `ingest`; no toma el bloqueo ni escribe nada, y sale con 0 si es `healthy`, 1 si es otra y 2 con un error de uso o de configuración).

En el paquete, tras `pnpm run build`: `db:migrate`, `fixture:publish` (pasa los vectores sintéticos por el log y los publica en el stack local) e `ingest -- --live [--symbol R_100]` (captura viva continua opt-in contra Deriv; exige un `BUOH_POSTGRES_SCHEMA` y un `BUOH_S3_BUCKET` propios con las migraciones aplicadas, y sale con una línea JSON saneada al parar con `SIGINT` o `SIGTERM` o a las 23 horas).
