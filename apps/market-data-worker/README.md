# @buoh/market-data-worker

Persistencia, publicación atómica y replay de datasets (F1.3a, `F1-DATASET-001`). Decisiones en [ADR-0004](../../docs/arquitectura/adr/0004-pipeline-y-reproduccion-de-datos-fase-1.md) §8–§9 y [ADR-0005](../../docs/arquitectura/adr/0005-persistencia-local-y-formato-fisico-f1-3.md); operación en el [runbook](../../docs/operacion/runbook-ingesta-de-datos.md#entorno-local-y-replay-f13).

Todavía no conecta con Deriv ni tiene log raw-first durable (F1.3b).

## Flujo

```text
segmentos de source events ─ publishDataset ─▶ objetos sha256/<hash> verificados (S3)
                                              ▶ manifests/<dataset_id>/<publication_id>/<digest>.json
                                              ▶ commit PostgreSQL: dataset, incidencias, record activo
dataset_id ─ replayDataset ─▶ verify-only: record, documento, hashes físicos/lógicos, contratos, core
                             ▶ recompute: además regenera con packages/domain y compara core e ID
```

- `ObjectStore` y `MetadataStore` son los puertos; `S3ObjectStore` y `PostgresMetadataStore` los adaptadores reales.
- `migrations/` contiene SQL append-only; `db:migrate` las aplica y rechaza migraciones aplicadas que cambiaron.

## Comandos

Desde la raíz: `pnpm run test` (offline), `pnpm run test:integration` (requiere `infra/compose.yaml`) y `pnpm run data:replay -- --dataset <id> [--verify-only]`.

En el paquete, tras `pnpm run build`: `db:migrate` y `fixture:publish` (publica los vectores sintéticos en el stack local).
