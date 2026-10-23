# @buoh/domain

Normalización y reglas de calidad puras de datos de mercado (F1.2). Semántica canónica en [contratos de dominio](../../docs/arquitectura/contratos-de-dominio.md#semántica-ejecutable-de-reglas-100) y [ADR-0004](../../docs/arquitectura/adr/0004-pipeline-y-reproduccion-de-datos-fase-1.md).

No lee reloj, red, aleatoriedad ni almacenamiento: IDs, tiempos de publicación y ubicaciones se inyectan.

## Flujo

```text
estímulos sintéticos ─ ingestSyntheticStimuli ─▶ segmentos de SourceEvent   (o resultado fail-closed)
segmentos ─ buildDatasetPublication ─▶ ticks, incidencias, condiciones (deriveMarketData),
                                       DatasetManifestCore, dataset_id, objetos, documento JCS,
                                       PublishedManifestRecord
estado durable ─ deriveHealthReport ─▶ HealthReport
```

- `createPipelineProfile`: esquema de fuente (JSON Schema 2020-12 vía Ajv) y perfil de calidad firmados, con sus digests JCS.
- `normalizeRawFrame`: valida el payload exacto y conserva el lexema numérico de la cotización.
- `deriveMarketData`: reglas 1.0.0 en orden de observación; recomputar desde source events persistidos da el mismo resultado.
- `evaluateSourceLimit`: matriz de límites de ADR-0004 §7.
- `buildDatasetPublication` acepta `encodeObject` para la codificación física (por defecto `none`, como los vectores); la usa `apps/market-data-worker` para gzip. Cambiarla no altera `dataset_id`.

## Comandos

Desde la raíz: `pnpm run test`, `pnpm run test:vectors`.
