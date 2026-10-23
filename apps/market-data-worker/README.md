# @buoh/market-data-worker

Log raw-first de source events, registro operativo, publicación atómica y replay de datasets (F1.3: `F1-STREAM-001`, `F1-DATASET-001`). Decisiones en [ADR-0004](../../docs/arquitectura/adr/0004-pipeline-y-reproduccion-de-datos-fase-1.md) §7–§12 y [ADR-0005](../../docs/arquitectura/adr/0005-persistencia-local-y-formato-fisico-f1-3.md); operación en el [runbook](../../docs/operacion/runbook-ingesta-de-datos.md#entorno-local-y-replay-f13).

Todavía no conecta con Deriv (F1.4).

## Flujo

```text
frame del transporte ─ RawFirstIngestor ─▶ límite de bytes (source_limit_exceeded → pausa)
                                          ▶ SourceEventLog.append: objeto JCS (S3) + índice (PostgreSQL)
                                          ▶ solo si es durable: normalizeRawFrame → sink
                                          ▶ si no: persistence_unavailable → pausa
segmentos (rotación 1.0.0 o cierre explícito) ─▶ objeto NDJSON gzip + fila de cierre
segmentos cerrados ─ publishFromLog ─▶ publishDataset ─▶ objetos sha256/<hash>, documento, commit
dataset_id ─ replayDataset ─▶ verify-only: record, documento, hashes físicos/lógicos, contratos,
                             │              invariantes entre artefactos, versiones de contrato, core
                             ▶ recompute: además regenera con packages/domain y compara core e ID
```

- Puertos: `ObjectStore`, `MetadataStore`, `SourceLogStore` y `OperationalStore`. Adaptadores reales: `S3ObjectStore` y los `Postgres*Store`.
- `migrations/` contiene SQL append-only; `db:migrate` las aplica y rechaza migraciones aplicadas que cambiaron.
- `driveSyntheticStimuli` entrega los estímulos del vector al ingestor real, como un transporte.

## Comandos

Desde la raíz: `pnpm run test` (offline), `pnpm run test:integration` (requiere `infra/compose.yaml`) y `pnpm run data:replay -- --dataset <id> [--verify-only]`.

En el paquete, tras `pnpm run build`: `db:migrate` y `fixture:publish` (pasa los vectores sintéticos por el log y los publica en el stack local).
