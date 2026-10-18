# Contratos de dominio y eventos

## Autoridad y alcance

Desde F1.1, [`packages/contracts`](../../packages/contracts/) es canónico para estructura, tipos y validación runtime; este documento conserva semántica y decisiones. Los JSON Schema de `packages/contracts/generated/json-schema` se generan desde Zod y no se editan manualmente.

Las validaciones que JSON Schema no expresa —hashes derivados, orden, cardinalidad entre artifacts y relaciones entre campos— permanecen en los esquemas runtime y sus pruebas. Un consumidor no debe sustituir la validación runtime por validar únicamente el JSON Schema.

Fase 1 implementa `SourceEvent`, `MarketTick`, `DataQualityIncident`, `OperationalConditionEvent`, `IngestionCursor`, `DatasetManifest`, `PublishedManifestRecord` y `HealthReport`. Estrategias, señales y ejecución permanecen conceptuales.

## Evidencia de F1.1

- Zod 4 mantiene contratos estrictos y uniones discriminadas.
- `canonicalize` implementa RFC 8785 para IDs y hashes estructurados.
- `pnpm run schemas:generate` produce ocho JSON Schema; `schemas:check` detecta deriva.
- `pnpm run test:vectors` verifica manifiestos, raw hashes, IDs derivados, publicaciones y escenarios principal/cero-ticks sin red.

## Taxonomías independientes

| Eje | Valores |
|---|---|
| `deployment_environment` | `development`, `test`, `staging`, `production` |
| `execution_mode` | `disabled`, `shadow`, `demo`, `real` |
| `strategy_lifecycle` | `draft`, `reviewed`, `active`, `paused`, `retired` |
| `service_health` | `starting`, `healthy`, `degraded`, `recovering`, `paused`, `failed` |

Fase 1 usa `execution_mode = disabled`. Un servicio pausado no cambia de entorno ni modo.

## Escalares canónicos

| Tipo | Regla |
|---|---|
| `SchemaVersion` | SemVer estable `MAJOR.MINOR.PATCH` |
| `UtcTimestampMs` | RFC 3339 UTC con exactamente tres decimales y `Z`; se valida calendario real |
| `DecimalString` | base 10, sin exponente, separador, `+` ni ceros iniciales no significativos; cotización con exactamente `pip_size` decimales |
| `Sha256Hex` | 64 caracteres hexadecimales minúsculos, sin prefijo |
| `DatasetId` | `sha256:` seguido por `Sha256Hex` |
| `UuidV7` | UUID versión 7 minúsculo y variante RFC 4122 |
| `DerivedEventId` | `sha256:` + SHA-256 de JCS del evento sin su campo ID |
| `EventRef` | `UuidV7 | DerivedEventId` |
| `ConditionKey` | `<condition_type>:sha256:<Sha256Hex>` según tabla de identidad |
| `Symbol` | string no vacío; conserva valor oficial de fuente |
| `NonNegativeInteger` | entero seguro entre 0 y `Number.MAX_SAFE_INTEGER` |

## Canonicalización y orden

- Hash estructurado: JSON Canonicalization Scheme RFC 8785, UTF-8 y SHA-256.
- Hash lógico de secuencia: cada registro en JCS, unido por `\n`, con newline final.
- Conjuntos como `symbols` y `related_refs` son únicos y ordenados.
- Source events conservan orden de observación.
- Ticks de dataset se ordenan por `event_time_utc`, `tick_fingerprint_sha256`, `observation_id`.
- Incidencias se ordenan por `observed_at_utc`, `incident_type`, `incident_id`.
- IDs de source events se obtienen de un generador UUIDv7 inyectable y se reutilizan en replay.
- `incident_id` y `condition_event_id` son `DerivedEventId`: se calculan después de ordenar referencias sobre todos los campos del evento excepto el propio ID; luego se inserta el ID sin recalcularlo.

## `SourceEvent`

Unión estricta y append-only. Todas las ramas rechazan campos desconocidos.

### `RawSourceFrame`

```text
kind: "raw_source_frame"
schema_version: SchemaVersion
observation_id: UuidV7
source: string
connector_version: string
connection_id: UuidV7
received_at_utc: UtcTimestampMs
payload_utf8: string
raw_payload_sha256: Sha256Hex
```

El hash se calcula sobre bytes UTF-8 exactos de `payload_utf8`, sin parsear ni reserializar. Se rechazan strings JavaScript con surrogates aislados porque no representan texto Unicode bien formado. Un payload inválido respecto al esquema de fuente sigue siendo raw válido si pudo persistirse.

### `ConnectionOpened`

```text
kind: "connection_opened"
schema_version: SchemaVersion
event_id: UuidV7
source: string
connection_id: UuidV7
occurred_at_utc: UtcTimestampMs
supersedes_connection_id: UuidV7 | null
```

### `ConnectionClosed`

```text
kind: "connection_closed"
schema_version: SchemaVersion
event_id: UuidV7
source: string
connection_id: UuidV7
occurred_at_utc: UtcTimestampMs
closure_type: "requested" | "remote" | "transport_error" | "timeout"
affected_symbols: Symbol[]                  # únicos y ordenados; puede estar vacío si aún no había suscripción
reason: string no vacío
```

### `HistoryRecoveryResult`

Campos comunes:

```text
kind: "history_recovery_result"
schema_version: SchemaVersion
event_id: UuidV7
source: string
connection_id: UuidV7
occurred_at_utc: UtcTimestampMs
from_event_time_utc: UtcTimestampMs
to_event_time_utc: UtcTimestampMs
symbol: Symbol
status: "complete" | "partial" | "unavailable"
```

Restricciones por `status`:

- `complete`: requiere `recovered_event_count: NonNegativeInteger`; prohíbe `reason`.
- `partial`: requiere `recovered_event_count: NonNegativeInteger` y `reason`.
- `unavailable`: requiere `reason`; prohíbe `recovered_event_count`.

`from_event_time_utc <= to_event_time_utc`.

## `IngestionCursor`

Estado operativo PostgreSQL, actualizado transaccionalmente después de confirmar durabilidad; no forma parte de `ConnectionClosed`:

```text
schema_version: SchemaVersion
source: string
symbol: Symbol
connection_id: UuidV7
active_segment_index: NonNegativeInteger
source_event_count: NonNegativeInteger
last_durable_source_event_id: UuidV7
last_durable_observation_id: UuidV7 | null
high_watermark_event_time_utc: UtcTimestampMs | null
updated_at_utc: UtcTimestampMs
```

El procedimiento de desconexión persiste primero `ConnectionClosed` y luego consulta/snapshot el cursor por símbolo. Un cursor nunca avanza por un evento no confirmado como durable.

## `MarketTick`

Proyección regenerable de un raw válido:

```text
schema_version: SchemaVersion
observation_id: UuidV7
source: string
connector_version: string
symbol: Symbol
event_time_utc: UtcTimestampMs
received_at_utc: UtcTimestampMs
quote_decimal: DecimalString
pip_size: entero 0..18
origin: "stream" | "history_recovery"
raw_payload_sha256: Sha256Hex
tick_fingerprint_sha256: Sha256Hex
quality_flags: QualityIncidentType[]
```

`quality_flags` es único y lexicográficamente ordenado. El fingerprint usa exactamente:

```json
{
  "event_time_utc": "...",
  "pip_size": 3,
  "quote_decimal": "...",
  "source": "...",
  "symbol": "..."
}
```

Dos observaciones pueden compartir fingerprint sin compartir `observation_id`. El adaptador conserva el lexema numérico del payload o usa decimal exacto para producir `quote_decimal`; no deriva la cotización mediante aritmética binaria de `JSON.parse`.

## `DataQualityIncident`

```text
schema_version: SchemaVersion
incident_id: DerivedEventId
incident_type: QualityIncidentType
severity: "info" | "warning" | "error" | "critical"
quality_rule_version: SchemaVersion
source: string
symbol: Symbol | null
observed_at_utc: UtcTimestampMs
observed_ref: EventRef
related_refs: EventRef[]
evidence: QualityEvidence
```

`symbol = null` solo se permite para incidencias de conexión o recursos sin símbolo conocido. `related_refs` es único y ordenado. `evidence` rechaza campos desconocidos y se discrimina por `incident_type`:

| `incident_type` | `evidence` exacta |
|---|---|
| `invalid_source_frame` | `{ raw_payload_sha256: Sha256Hex, reason: string }` |
| `duplicate_exact` | `{ tick_fingerprint_sha256: Sha256Hex }` |
| `source_time_conflict` | `{ event_time_utc: UtcTimestampMs, tick_fingerprints: [Sha256Hex, Sha256Hex] }`, tuple ordenada y distinta |
| `out_of_order` | `{ event_time_utc: UtcTimestampMs, high_watermark_utc: UtcTimestampMs }` |
| `delivery_delayed` | `{ delay_ms: NonNegativeInteger, maximum_delivery_delay_ms: NonNegativeInteger }` con `delay_ms > maximum` |
| `connection_lost` | `{ affected_symbols: Symbol[], closure_type: "remote" | "transport_error" | "timeout", reason: string }` |
| `event_gap_unresolved` | `{ from_event_time_utc: UtcTimestampMs, to_event_time_utc: UtcTimestampMs, reason: string }` |
| `persistence_unavailable` | `{ stage: PersistenceStage, reason: string }` |
| `source_limit_exceeded` | `{ resource: SourceResource, unit: LimitUnit, observed_value: NonNegativeInteger, maximum_value: NonNegativeInteger }` con `observed_value > maximum_value` |

```text
PersistenceStage =
  raw_object_write | source_event_index | normalized_object_write |
  incident_write | manifest_write | manifest_commit

SourceResource =
  websocket_frame | in_memory_queue_events | in_memory_queue_bytes |
  schema_archive | schema_entry | schema_entries | schema_expanded

LimitUnit = bytes | events | entries
```

La unidad válida está fijada por recurso: `websocket_frame`, `in_memory_queue_bytes`, `schema_archive`, `schema_entry` y `schema_expanded` usan `bytes`; `in_memory_queue_events` usa `events`; `schema_entries` usa `entries`. Los umbrales de rotación de segmento no son incidencias.

## `OperationalConditionEvent`

Registro append-only separado de la observación de calidad. Permite derivar qué condiciones siguen abiertas sin mutar incidencias:

```text
schema_version: SchemaVersion
condition_event_id: DerivedEventId
condition_key: ConditionKey
condition_type: "connection_lost" | "event_gap_unresolved" |
                "persistence_unavailable" | "source_limit_exceeded"
action: "opened" | "resolved"
source: string
symbol: Symbol | null
occurred_at_utc: UtcTimestampMs
cause_refs: EventRef[]                       # no vacío, único y lexicográficamente ordenado
resolution_reason: string                    # requerido solo si action = resolved
```

`resolution_reason` está requerido solo para `resolved` y prohibido para `opened`.

`condition_event_id` autentica el evento, pero `condition_key` depende de su causa. Por ello, todo lote de condiciones debe atravesar `validateConditionCausality({ sourceEvents, incidents, conditions })`; validar eventos aislados no autoriza persistencia ni salud. Los rechazos contextuales usan `ContractContextError` con `code`, `path` y `context` estables.

`condition_key` tiene forma `<condition_type>:sha256:<digest>`, donde digest es SHA-256 de JCS de la identidad:

| Tipo | Identidad para digest |
|---|---|
| `connection_lost` | `{ source, closed_connection_id }` |
| `event_gap_unresolved` | `{ source, symbol, from_event_time_utc, to_event_time_utc }` |
| `persistence_unavailable` | `{ source, stage }` |
| `source_limit_exceeded` | `{ source, resource }` |

Un reducer ordena por `occurred_at_utc`, `condition_event_id`; la última acción de cada clave determina estado. Resolver clave inexistente o abrir dos veces sin resolución es inválido. `open_condition_types` contiene tipos cuya última acción es `opened`.

Transiciones derivables:

- `ConnectionClosed` no solicitado abre `connection_lost`; `ConnectionOpened.supersedes_connection_id` igual al cierre la resuelve.
- `HistoryRecoveryResult.unavailable` abre el gap de su rango; `partial` abre o mantiene el mismo rango y no lo resuelve; `complete` con idénticos fuente, símbolo y rango lo resuelve.
- Incidencias instantáneas (payload inválido, duplicado, conflicto, fuera de orden y retraso) no abren condiciones.
- Persistencia/límites usan eventos causales del registro operativo y no se añaden retroactivamente a datasets.

## `LogicalArtifactRef`

```text
artifact_id: string                         # `<role>:<segment_index de 6 dígitos>`
role: "source_events" | "normalized_ticks" | "quality_incidents" |
      "operational_conditions"
segment_index: NonNegativeInteger
record_count: NonNegativeInteger
logical_content_sha256: Sha256Hex
```

Orden obligatorio de roles: `source_events`, `normalized_ticks`, `quality_incidents`, `operational_conditions`; dentro del rol, `segment_index` asciende de cero sin huecos. Cada rol aparece al menos una vez. Una secuencia vacía usa un artefacto índice cero, conteo cero, cero bytes y hash `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

## `StorageObjectRef`

Campos comunes:

```text
artifact_id: string                         # clave de unión, única en el manifiesto
role: "source_events" | "normalized_ticks" | "quality_incidents" |
      "operational_conditions" | "source_schema" | "quality_profile"
uri: URI absoluta
media_type: string no vacío
compression: "none" | "gzip"
size_bytes: NonNegativeInteger
object_bytes_sha256: Sha256Hex
logical_content_sha256: Sha256Hex
```

Si `compression = gzip` o `media_type = application/vnd.apache.parquet`, requiere `writer_name` y `writer_version`; con `compression = none` y JSON/NDJSON esos campos están prohibidos. Orden: `artifact_id` lexicográfico.

Cada `LogicalArtifactRef.artifact_id` se une con exactamente un `StorageObjectRef` del mismo ID, rol y hash lógico. `source_schema:000000` y `quality_profile:000000` aparecen exactamente una vez. Dos artefactos pueden compartir bytes/URI por deduplicación, pero nunca comparten `artifact_id`.

## `DatasetManifestCore`

Contenido completo de identidad:

```text
schema_version: SchemaVersion
canonicalization_version: "RFC8785"
source: string
source_schema_release: string
source_schema_sha256: Sha256Hex
connector_version: string
normalizer_version: SchemaVersion
quality_rule_version: SchemaVersion
quality_profile_id: string
quality_profile_sha256: Sha256Hex
segment_policy_version: SchemaVersion
source_event_schema_version: SchemaVersion
market_tick_schema_version: SchemaVersion
incident_schema_version: SchemaVersion
condition_event_schema_version: SchemaVersion
symbols: Symbol[]                            # no vacío, único y ordenado
event_time_from_utc: UtcTimestampMs | null
event_time_to_utc: UtcTimestampMs | null
source_event_count: NonNegativeInteger
raw_frame_count: NonNegativeInteger
normalized_tick_count: NonNegativeInteger
incident_count: NonNegativeInteger
condition_event_count: NonNegativeInteger
logical_artifacts: LogicalArtifactRef[]
```

Los conteos coinciden con la suma de artefactos de su rol y `raw_frame_count <= source_event_count`. Si `normalized_tick_count = 0`, ambos tiempos son `null`; de otro modo ambos son no nulos, `from <= to` y representan extremos de ticks normalizados.

`dataset_id = "sha256:" + SHA256(JCS(manifest_core))`.

## `DatasetManifest`

```text
schema_version: SchemaVersion
dataset_id: DatasetId
publication_id: UuidV7
state: "published"
published_at_utc: UtcTimestampMs
manifest_core: DatasetManifestCore
storage_objects: StorageObjectRef[]
```

Cada artifact lógico y cada digest de esquema/perfil tiene exactamente un objeto físico correspondiente. Solo existe estado público `published`; el proceso incompleto permanece invisible. La representación almacenada es JCS sin newline.

## `PublishedManifestRecord`

Fila append-only que autentica una instancia física:

```text
schema_version: SchemaVersion
publication_id: UuidV7
dataset_id: DatasetId
manifest_document_sha256: Sha256Hex          # SHA-256 de JCS(DatasetManifest)
manifest_object_uri: URI absoluta
manifest_object_bytes_sha256: Sha256Hex
published_at_utc: UtcTimestampMs
state: "active" | "superseded"
```

En una publicación canónica, hash de documento y bytes coinciden. Relocar o cambiar writer crea otro `publication_id` y record; nunca sobrescribe la instancia anterior bajo el mismo `dataset_id`. Solo un record puede estar `active` por dataset en cada `deployment_environment`.

## `HealthReport`

```text
schema_version: SchemaVersion
source: string
execution_mode: "disabled"
service_health: "starting" | "healthy" | "degraded" | "recovering" | "paused" | "failed"
connection_state: "disconnected" | "connecting" | "connected"
backlog_count: NonNegativeInteger
backlog_bytes: NonNegativeInteger
last_observation_id: UuidV7 | null
last_received_at_utc: UtcTimestampMs | null
last_event_time_utc: UtcTimestampMs | null
last_published_dataset_id: DatasetId | null
open_condition_types: ("connection_lost" | "event_gap_unresolved" |
                       "persistence_unavailable" | "source_limit_exceeded")[]
```

`open_condition_types` se deriva del validador/reducer contextual, es único y ordenado. `healthy` exige conexión `connected`, ninguna condición abierta, último raw durable y backlog bajo límites; un reporte visiblemente contradictorio falla en runtime.

`persistence_unavailable` y `source_limit_exceeded` son incidencias operativas cuando impiden crear un source event durable; permanecen en el registro operativo PostgreSQL y no se insertan retroactivamente en un dataset publicado. Los artifacts `quality_incidents` y `operational_conditions` del dataset contienen únicamente eventos derivables de sus source events.

## Replay de dataset

`pnpm run data:replay -- --dataset <id>` ejecuta por defecto **recomputación**, sin red:

1. resolver el `PublishedManifestRecord` activo y verificar el documento canónico;
2. validar hashes físicos y decodificar objetos;
3. reconstruir hashes lógicos y validar `DatasetManifestCore`;
4. tomar únicamente source events, esquema de fuente, perfil y versiones como inputs;
5. regenerar ticks, incidencias derivables y `OperationalConditionEvent` derivables;
6. ordenar/canonicalizar resultados y comparar hashes, conteos, core y `dataset_id`.

`--verify-only` termina después del paso 3 y demuestra integridad, no corrección del normalizador. Incidencias operativas `persistence_unavailable` y `source_limit_exceeded` fuera de un dataset no se recomputan; se validan en pruebas fail-closed mediante sus causas inyectadas. Un replay nunca contacta a Deriv ni usa reloj/IDs nuevos.

## Reglas de calidad v1

- `duplicate_exact`: fingerprint igual a observación previa del dataset.
- `source_time_conflict`: igual `source + symbol + event_time_utc` y fingerprint distinto.
- `out_of_order`: evento anterior al high-watermark persistido del símbolo.
- `delivery_delayed`: recepción menos evento supera el perfil.
- `invalid_source_frame`: payload no satisface esquema/adaptador fijado.
- `connection_lost`: `ConnectionClosed.closure_type` es `remote`, `transport_error` o `timeout`; `requested` no crea incidencia.
- `event_gap_unresolved`: el perfil exige revisar continuidad y la recuperación no la demuestra.
- `persistence_unavailable`: durabilidad requerida no puede confirmarse.
- `source_limit_exceeded`: entrada excede el valor y unidad fijados para su recurso.

El perfil sintético v1 usa 2000 ms para retraso y separación tras reconexión. Ningún símbolo real hereda estos valores.

## Contratos futuros

`StrategyDefinition`, `SignalEvent`, `RiskPolicy`, `ExecutionIntent` y `ExecutionEvent` se definirán en sus fases. Sus conceptos no autorizan crear tablas, APIs o servicios en Fase 1.

## Versionado y compatibilidad

- Cambio aditivo compatible incrementa minor; cambio de semántica, tipo, requiredness, orden o canonicalización incrementa major.
- Contratos internos son estrictos y productores/consumidores se actualizan coordinadamente.
- Payload externo se preserva completo como raw; el adaptador extrae campos validados y tolera extras solo si el esquema fijado lo permite.
- Toda versión mayor conserva lector/replay mientras exista un dataset que la referencie, o documenta migración explícita sin sobrescribir originales.
- TypeScript y futuro Python comparten JSON Schema generado y vectores.

## Oráculo inicial

[`test-vectors/market-data/v1`](../../test-vectors/market-data/v1/) es normativo para serialización lógica, hashes, calidad, salud y fallo de persistencia. Sus datos son sintéticos. El verificador limita cada archivo a 8 MiB y cada manifiesto a 64 MiB declarados, rechaza paths absolutos, traversal y symlinks, y valida expectativas/perfiles además de checksums.
