# @buoh/domain

Normalización y reglas de calidad puras de datos de mercado (F1.2, reglas 2.0.0 en F1.4a), y la parte pura del catálogo y las respuestas de Deriv (F1.4b, [ADR-0012](../../docs/arquitectura/adr/0012-catalogo-y-adaptador-publico-de-deriv.md)). Semántica canónica en contratos de dominio, [reglas 1.0.0](../../docs/arquitectura/contratos-de-dominio.md#semántica-ejecutable-de-reglas-100) y [reglas 2.0.0](../../docs/arquitectura/contratos-de-dominio.md#semántica-ejecutable-de-reglas-200), y en [ADR-0004](../../docs/arquitectura/adr/0004-pipeline-y-reproduccion-de-datos-fase-1.md).

No lee reloj, red, aleatoriedad ni almacenamiento: IDs, tiempos de publicación y ubicaciones se inyectan.

## Flujo

```text
estímulos sintéticos ─ ingestSyntheticStimuli ─▶ segmentos de SourceEvent   (o resultado fail-closed)
segmentos ─ buildDatasetPublication ─▶ ticks, incidencias, condiciones (deriveMarketData),
                                       DatasetManifestCore, dataset_id, objetos, documento JCS,
                                       PublishedManifestRecord
estado durable ─ deriveHealthReport ─▶ HealthReport
```

- `createPipelineProfile`: esquema de fuente y perfil de calidad firmados, con sus digests JCS. El perfil elige el conjunto de reglas (`RULE_SETS`): 1.0.0 para los vectores v1 y 2.0.0 para fuentes como Deriv, que mezclan varios tipos de mensaje. Un perfil con `purpose: "measurement"` no lleva umbrales y nunca deriva ni publica (`publicationThresholds`; ADR-0012 §8).
- `compileSourceSchema`: elige el validador por el `$schema` del esquema (Ajv 2020 para 2020-12 y `ajv-draft-04` para draft-04, el de Deriv), en modo estricto (ADR-0012 §2).
- `deriveCatalogSnapshot`: convierte la respuesta de `active_symbols` de Deriv en un `SourceCatalogSnapshot`, o da el motivo de la primera comprobación que falla. `createCatalogResponseSchema` prepara su esquema de respuesta.
- `checkRequestedResponse` y `deriveRequestedResponseIncident`: comprobaciones e incidencia de una respuesta pedida inválida (ADR-0012 §6).
- `normalizeRawFrame`: valida el payload exacto y conserva el lexema numérico de la cotización. Con reglas 2.0.0, además separa los mensajes declarados en `non_tick_msg_types`, reconoce errores de la fuente y atribuye el símbolo por `echo_req`.
- `deriveMarketData`: reglas del perfil (1.0.0 o 2.0.0) en orden de observación; recomputar desde source events persistidos da el mismo resultado.
- `evaluateSourceLimit`: matriz de límites de ADR-0004 §7.
- `evaluateSegmentRotation`: política `segment_policy_version = 1.0.0` (bytes, frames y ventana; ADR-0005 §5), evaluada antes de añadir cada source event.
- `buildDatasetPublication` acepta `encodeObject` para la codificación física (por defecto `none`, como los vectores); la usa `apps/market-data-worker` para gzip. Cambiarla no altera `dataset_id`.

## Comandos

Desde la raíz: `pnpm run test`, `pnpm run test:vectors`.
