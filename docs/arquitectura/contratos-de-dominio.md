# Contratos de dominio y eventos

## Autoridad y alcance

Desde F1.1, [`packages/contracts`](../../packages/contracts/) es canónico para estructura, tipos y validación runtime; este documento conserva semántica y decisiones. Los JSON Schema de `packages/contracts/generated/json-schema` se generan desde Zod y no se editan manualmente.

Las validaciones que JSON Schema no expresa —hashes derivados, orden, cardinalidad entre artifacts y relaciones entre campos— permanecen en los esquemas runtime y sus pruebas. Un consumidor no debe sustituir la validación runtime por validar únicamente el JSON Schema. Las invariantes entre artefactos de un dataset (conteos, orden canónico, unión tick→raw, referencias de incidencias, procedencia y extremos temporales) están en `validateDatasetConsistency`, que usan el verificador de vectores y `data:replay` en ambos modos.

Fase 1 implementa `SourceEvent`, `MarketTick`, `DataQualityIncident`, `OperationalConditionEvent`, `IngestionCursor`, `DatasetManifest`, `PublishedManifestRecord` y `HealthReport`. F1.4b añade `SourceCatalogSnapshot` ([ADR-0012](adr/0012-catalogo-y-adaptador-publico-de-deriv.md)); F2.1, `LiveDerivationCheckpoint` ([ADR-0017](adr/0017-punto-de-control-de-la-derivacion-en-vivo.md)); F2.3, los mensajes de la API y `AuditEvent` ([ADR-0019](adr/0019-api-cuentas-y-auditoria.md)); y F2.5b, los [registros de los lotes](#registros-de-los-lotes) y `MarketTick` 1.1.0 ([ADR-0021](adr/0021-mercados-reales-y-fuentes-de-investigacion.md) §4); F2.6, [`StrategyDefinition`](#strategydefinition) ([ADR-0022](adr/0022-modelo-de-estrategia.md)). Señales y ejecución permanecen conceptuales.

## Evidencia de F1.1

- Zod 4 mantiene contratos estrictos y uniones discriminadas.
- `canonicalize` implementa RFC 8785 para IDs y hashes estructurados.
- `pnpm run schemas:generate` produjo ocho JSON Schema en F1.1, nueve desde F1.4b con `SourceCatalogSnapshot`, diez desde F2.1 con `LiveDerivationCheckpoint`, once desde F2.3 con `AuditEvent`, quince desde el PR 4b de ADR-0021 con los registros de los lotes y dieciséis desde el PR 2 de ADR-0022 con `StrategyDefinition`; `schemas:check` detecta deriva.
- `pnpm run test:vectors` verifica manifiestos, raw hashes, IDs derivados, publicaciones y escenarios principal/cero-ticks sin red.
- Desde F1.2, `test:vectors` además regenera con `packages/domain` todos los artefactos de ambos escenarios y los compara byte a byte.

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
- Implementación: `packages/domain/src/quality.ts` produce este orden y `packages/contracts/src/dataset-consistency.ts` lo valida, cada uno con sus propios comparadores por unidades UTF-16. Deben cambiar a la vez ([estado del código](estado-del-codigo.md) D-06).
- Las entradas de `SourceCatalogSnapshot` se ordenan por `underlying_symbol` en unidades UTF-16: `deriveCatalogSnapshot` (`packages/domain/src/catalog.ts`) las ordena y `isSortedUnique` (`packages/contracts`) lo valida, los dos con el operador `<` de JavaScript.
- Las `offers` de `ContractOffer` se ordenan por `contract_type` y `expiry_type` en unidades UTF-16, con el operador `<`, y los `intervals` de `TradingSession`, por su hora, sin solaparse ni tocarse. Los valida `packages/contracts`, y los ordenan las reglas de los lotes (`deriveContractOffer` y `deriveTradingSessions`, en `packages/domain/src/batch-rules.ts`). Los horarios, los contratos y las cotizaciones de un dataset se ordenan por `received_at_utc`, `observation_id` y `symbol`, con el mismo operador (`compareBatchRecords`). Las velas se ordenan por `open_time_utc` y `symbol`, y los ticks de la historia, como los de los datasets en vivo, por `event_time_utc`, huella y observación. Desde el PR 5d1 de [ADR-0021](adr/0021-mercados-reales-y-fuentes-de-investigacion.md) §9, `validateDatasetConsistency` valida también el orden de las velas, los horarios, los contratos y las cotizaciones de un dataset de los lotes, con sus propios comparadores, que deben coincidir con los de las reglas.
- El orden de las condiciones operativas (`occurred_at_utc`, `condition_event_id`; ver `OperationalConditionEvent`) está implementado tres veces: `compareConditions` en `packages/domain/src/quality.ts`, por unidades UTF-16, y `validateConditionCausality` y `reduceOpenConditions` en `packages/contracts/src/conditions.ts`, con `localeCompare`. Coinciden porque los dos campos tienen formato fijo ([estado del código](estado-del-codigo.md) D-13).
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

Desde el PR 3 de [ADR-0015](adr/0015-reconexion-recuperacion-y-salud-f1-5.md) §13 (§4), una conexión del worker de Deriv sabe construirlo con `ticks_history` y persistirlo por la misma cola que los frames, así que queda después del primer tick posterior al cierre:

- `connection_id` es la conexión que recuperó; `from_event_time_utc`, el high-watermark del inicio del hueco + 1 ms, y `to_event_time_utc`, el primer tick posterior al último cierre − 1 ms. Es el rango que las reglas aceptan para decidir el hueco;
- `complete`: las páginas son válidas, cubren el rango pedido y traen el tick del high-watermark y el primer tick posterior, con la misma cotización que se recibió, en decimal canónico con el `pip_size` de la respuesta. `recovered_event_count` cuenta los ticks entre los dos, sin incluirlos; en `partial`, los de las páginas válidas;
- `partial` y `unavailable` llevan uno de estos motivos: `history_page_limit`, `history_error_response`, `history_invalid`, `history_timeout`, `history_boundary_missing` o `history_boundary_mismatch`. `unavailable` significa que falló la primera página. Si se cumple más de uno, va el primero en este orden: una página que falla (`history_error_response`, `history_invalid` o `history_timeout`), un extremo con otra cotización (`history_boundary_mismatch`), el tope de páginas sin llegar al inicio del rango (`history_page_limit`) y un extremo que falta (`history_boundary_missing`);
- un intento que termina con `history_error_response`, `history_timeout` o `history_boundary_missing` se repite, con 30 000 ms entre intentos y hasta tres en total. Solo se persiste el resultado del último intento.

Desde el PR 4, lo pide la sesión de ingesta (`startDerivSession`) por la conexión nueva, 2000 ms después del primer tick durable posterior al cierre (ADR-0015 §4, «Cuándo»).

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

Decidido en [ADR-0015](adr/0015-reconexion-recuperacion-y-salud-f1-5.md) §6 y persistido desde el PR 5 de su secuencia: la sesión de ingesta lo guarda en la tabla append-only `ingestion_cursors`, en versiones contiguas por fuente y símbolo, después de cada `ConnectionClosed` durable, también uno reparado, y al parar. `connection_id` es la conexión del último evento durable. `active_segment_index`, `source_event_count`, `last_durable_source_event_id` y `last_durable_observation_id` son los del log de la fuente en ese momento: segmento abierto, eventos durables, último evento y último raw. `high_watermark_event_time_utc` es el del símbolo: la hora de su tick durable más tardío. Al arrancar, el último evento del cursor del símbolo tiene que estar en el índice del log, y ningún cursor de la fuente puede ser de otro símbolo: un log lo escribe una sesión de un solo símbolo.

## `LiveDerivationCheckpoint`

Decidido en [ADR-0017](adr/0017-punto-de-control-de-la-derivacion-en-vivo.md) (F2.1). Desde el PR 2 de su secuencia, `LiveDerivationCheckpoint` 1.0.0 está en `packages/contracts`, con su esquema Zod y su JSON Schema, y el pliegue que lo produce está en `packages/domain`. Desde el PR 3, `ingest` lo escribe en su tabla. Desde el PR 4, el arranque, la reparación de cierres y la vigilancia de huecos de la sesión parten de él, y desde el PR 5, `data:health`.

Es el estado vivo de un log al final de un segmento cerrado: lo que la derivación del log hasta ese segmento deja para los lectores en vivo (arranque, reparación de cierres, vigilancia de huecos y `data:health`). No es un artefacto de dataset ni participa en ningún `dataset_id`.

```text
schema_version: SchemaVersion
source: string
symbol: Symbol
segment_index: NonNegativeInteger
segment_logical_content_sha256: Sha256Hex
event_count: NonNegativeInteger
raw_frame_count: NonNegativeInteger
versions: LiveCheckpointVersions
state: LiveDerivationState
```

- **Identidad del log:** `source`, `symbol` y el segmento cerrado *k* que cubre (`segment_index`), con su `logical_content_sha256` y los conteos acumulados de eventos y de raw frames de los segmentos 0 a *k*, que se comprueban contra `closed_source_segments`.
- **Versiones** (`versions`): `connector_version`, `quality_rule_version`, `quality_profile_sha256`, `source_schema_sha256` del esquema de fuente guardado, `segment_policy_version`, `source_event_schema_version` y `live_state_version`, la versión del formato del estado vivo (`LIVE_STATE_VERSION`, hoy 1.0.0). Esta última es un campo propio, distinto de `schema_version`, que sube con cualquier cambio de lo que el pliegue produce para un mismo log. Si alguna versión no coincide con la del lector, el punto de control no se usa ni se migra: el estado se reconstruye por partes. Uno con otro enlace o con otro SHA-256 tampoco se usa, y deja una alerta.
- **Estado vivo** (`state`):
  - `watermarks`: el high-watermark de cada símbolo, con la `observation_id` del tick que lo fijó y el tick canónico de ese instante (`observation_id`, `quote_decimal` y `tick_fingerprint_sha256`);
  - `pending_continuity`: la continuidad pendiente de cada símbolo, como en `deriveMarketData` (inicio, último cierre, `exceeded` y fin), con los ticks de los extremos del hueco. Del inicio guarda el primer tick observado y el canónico. Del fin, cuando se conoce, guarda el canónico del instante siguiente al rango pendiente y el primero observado con el menor tiempo posterior;
  - `open_conditions`: cada apertura sin resolver, completa, con su incidencia causal y, para `connection_lost`, la `connection_id` cerrada;
  - `previous_connection`: la última conexión abierta y la hora de su cierre, si lo tiene;
  - `last_connection_event_time_utc`, `last_raw` (su `observation_id` y su hora de recepción) y `connected_in_log`, para la salud;
  - `last_event_connection_id` y `symbol_not_allowed_seen`, para el arranque.

  Las incidencias y condiciones que abren o resuelven algo tienen los mismos cuerpos e IDs derivados que en `deriveMarketData`.
- **Validación runtime:** además de la forma, que describe el JSON Schema, el esquema runtime exige `watermarks` y `pending_continuity` en orden de símbolo, y `open_conditions` en orden de `condition_key`, sin repetir. Cada condición abierta tiene que ser una apertura que cita a su incidencia, del mismo tipo y el mismo símbolo, con la fuente del punto de control en las dos. Lleva `closed_connection_id` solo si es `connection_lost`. Su `condition_key` tiene que ser la que el pliegue usa para resolverla, como en `validateConditionCausality`: la de esa conexión en un `connection_lost` (`deriveConnectionConditionKey`) y la del rango, la fuente y el símbolo de su incidencia en un `event_gap_unresolved` (`deriveGapConditionKey`). `raw_frame_count` no puede superar `event_count`.
- **Derivación** (`packages/domain`): `foldLiveDerivation` aplica eventos sobre un estado vivo con las mismas reglas que `deriveMarketData` (`derivation-rules.ts`), y falla donde ella falla. También falla con un resultado `partial` o `unavailable` que no cubre exactamente el hueco pendiente (ADR-0017 §3). `liveDerivationView` da lo que usan los lectores. `buildLiveDerivationCheckpoint` arma y valida el punto de control, y `liveCheckpointDigests` da el SHA-256 de su JCS completo, que comprueba la integridad, y el de sus versiones, que entra en la clave.
- **Equivalencia:** la prueba del dominio compara el pliegue con `deriveMarketData` en cada límite entre eventos del vector v1, de los logs sintéticos escritos a mano y de 450 logs aleatorios del dominio de ADR-0017 §3, con semilla fija y tres perfiles: el de medición, uno con umbrales y, desde el PR 5 de [ADR-0020](adr/0020-datasets-vivos.md) §13, uno con umbrales y las reglas 3.0.0. Los logs escritos a mano para un perfil con umbrales también se comparan con este último.
- **Vector:** `packages/domain/test/fixtures/live-checkpoints.ndjson` fija en JCS, con sus SHA-256, el punto de control de cada límite de segmento del vector v1 y de los logs sintéticos escritos a mano. La prueba fija además el SHA-256 de cada log del vector para cada `live_state_version`, así que un cambio que altere uno de esos estados sin subir la versión falla en CI. Un log nuevo solo añade su digest.
- **Persistencia** (desde el PR 3): la tabla append-only `live_derivation_checkpoints` (migración `0005`), con el punto de control entero en JCS y su SHA-256, el mismo de `liveCheckpointDigests`. Su clave es única por fuente, segmento y SHA-256 de las versiones, y la hora de escritura no entra en el hash. Solo la escribe `ingest`, con el bloqueo de la fuente, después de cada cierre de segmento durable (`LiveCheckpointWriter`, en `apps/market-data-worker`). Quien lo lee lo usa solo si pasa las comprobaciones de ADR-0017 §6 (`checkStoredCheckpoint`): integridad, identidad y enlace con `closed_source_segments`, en ese orden.
- **Lectura** (desde el PR 4, `apps/market-data-worker/src/source-log/live-reader.ts`): un lector toma la foto del segmento abierto, busca el último punto de control válido por debajo de él (`LiveCheckpointLookup`, que en una sesión comparten los lectores y quien escribe, y avisa una sola vez de cada fila rechazada) y aplica después los segmentos cerrados posteriores, de uno en uno, y los eventos del abierto. Así el estado vivo es el del log durable entero sin leer los segmentos anteriores al punto de control. Desde el PR 5, `data:health` lee así el log desde fuera del proceso que ingiere, sin escribir nada: busca el punto de control por debajo del segmento abierto del estado del log que leyó (`readLogState`), en otra consulta, y como las filas de los segmentos cerrados y de los puntos de control nunca cambian, uno que se cierra mientras tanto no se aplica dos veces. Sin uno válido reconstruye el estado vivo en memoria, y si su plazo se cumple mientras lo hace, da `paused` con la alerta `data_health_checkpoint_rebuild_incomplete` (ADR-0017 §6).

## `MarketTick`

Proyección regenerable de un raw válido:

```text
schema_version: SchemaVersion              # "1.0.0" o "1.1.0"; history_download, solo en la 1.1.0
observation_id: UuidV7
source: string
connector_version: string
symbol: Symbol
event_time_utc: UtcTimestampMs
received_at_utc: UtcTimestampMs
quote_decimal: DecimalString
pip_size: entero 0..18
origin: "stream" | "history_recovery" | "history_download"   # el último, solo en la 1.1.0
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

Un tick del flujo (`origin: "stream"`) es el único de su observación. Desde las reglas 3.0.0, un tick que trae la historia (`origin: "history_recovery"`) lleva el `observation_id`, el `raw_payload_sha256`, el `received_at_utc`, la fuente y el conector del frame `history` que lo trajo, así que varios ticks comparten el `observation_id` de su frame y se distinguen por `event_time_utc` (ver «Semántica ejecutable de reglas 3.0.0»).

Desde el PR 4b de [ADR-0021](adr/0021-mercados-reales-y-fuentes-de-investigacion.md) §9 hay dos versiones. La 1.1.0 suma el origen `history_download`, el de los ticks de la descarga de la historia de un año (ADR-0021 §4); el esquema runtime solo lo admite con `schema_version` 1.1.0, y la 1.0.0 es la que siguen produciendo la captura y los datasets vivos. Qué versión admite cada dataset lo siguen comprobando `validateDatasetConsistency` y el replay, con la del manifiesto. Un tick `history_download` lleva la procedencia del frame `history` que lo trajo, como uno de `history_recovery`, y nunca la marca `delivery_delayed`: se recibe mucho después de su hora, así que no tiene retraso de entrega, y en el backtest su instante es su hora de la fuente ([ADR-0024](adr/0024-semantica-del-backtest.md) §4). Como la historia y la captura son de la misma fuente, un mismo tick tiene la misma huella en las dos.

## `DataQualityIncident`

```text
schema_version: SchemaVersion
incident_id: DerivedEventId
incident_type: QualityIncidentType | "contract_rejected" | "candle_repeated" | "candle_missing" | "tick_gap"   # DataQualityIncidentType; los tres primeros de estos cuatro, solo con los esquemas 3.0.0 y 3.1.0, y tick_gap, solo con el 3.1.0; no son marcas de tick ni de vela
severity: "info" | "warning" | "error" | "critical"
quality_rule_version: SchemaVersion
source: string
symbol: Symbol | null
observed_at_utc: UtcTimestampMs
observed_ref: EventRef
related_refs: EventRef[]
evidence: QualityEvidence
```

`symbol = null` solo se permite para incidencias de conexión o recursos sin símbolo conocido y, desde el esquema de incidencias 2.0.0, para `invalid_source_frame` sin símbolo atribuible (reglas de calidad 2.0.0). El esquema 3.0.0, el de las [reglas de los lotes 4.0.0](#semántica-ejecutable-de-las-reglas-de-los-lotes-400), lo admite igual y suma `contract_rejected`, `candle_repeated` y `candle_missing`, que solo existen con él y con el 3.1.0. El 3.1.0, el de las reglas de los lotes 4.1.0 (desde el PR 6b de ADR-0021 §9), es el 3.0.0 más `tick_gap`, que solo existe con él. `related_refs` es único y ordenado. `evidence` rechaza campos desconocidos y se discrimina por `incident_type`:

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
| `candle_repeated` | `{ open_time_utc: UtcTimestampMs, first_candle_fingerprint_sha256: Sha256Hex, candle_fingerprint_sha256: Sha256Hex }`; `warning` si las dos huellas son iguales y `error` si no; solo con los esquemas 3.0.0 y 3.1.0 |
| `contract_rejected` | `{ raw_payload_sha256: Sha256Hex, error_code: string, contract_type: "MULTUP" \| "MULTDOWN", multiplier_decimal: DecimalString }`, con el multiplicador mayor que cero; solo con los esquemas 3.0.0 y 3.1.0 |
| `candle_missing` | `{ from_open_time_utc: UtcTimestampMs, to_open_time_utc: UtcTimestampMs }`: la apertura de la primera y de la última vela que faltan de un tramo seguido, las dos incluidas, en minutos enteros y sin invertirse; siempre `error`; solo con los esquemas 3.0.0 y 3.1.0 (desde el PR 5d1 de ADR-0021 §9) |
| `tick_gap` | `{ from_event_time_utc: UtcTimestampMs, to_event_time_utc: UtcTimestampMs, maximum_tick_gap_ms: NonNegativeInteger }`: el primer y el último segundo de un tramo seguido sin ticks de la historia, los dos incluidos, en segundos enteros y sin invertirse, y el umbral de su símbolo, en segundos enteros y mayor que cero; el tramo dura al menos el umbral; siempre `error`; solo con el esquema 3.1.0 (desde el PR 6b de ADR-0021 §9) |

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
role: "source_events" | "normalized_ticks" | "market_candles" | "trading_sessions" |
      "contract_offers" | "contract_quotes" | "quality_incidents" | "operational_conditions"
segment_index: NonNegativeInteger
record_count: NonNegativeInteger
logical_content_sha256: Sha256Hex
```

Orden obligatorio de roles: `source_events`, `normalized_ticks`, `market_candles`, `trading_sessions`, `contract_offers`, `contract_quotes`, `quality_incidents`, `operational_conditions`; dentro del rol, `segment_index` asciende de cero sin huecos. Cada rol aparece al menos una vez, salvo los cuatro de los registros de los lotes (`market_candles` a `contract_quotes`), que solo existen, y entonces todos, en un `DatasetManifestCore` 1.1.0. Una secuencia vacía usa un artefacto índice cero, conteo cero, cero bytes y hash `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

`source_events` lleva un artefacto por segmento del log. Los roles derivados (`normalized_ticks`, `quality_incidents` y `operational_conditions`) llevan uno con las reglas 1.0.0 y 2.0.0. Con las 3.0.0 y las de los lotes 4.0.0, también los roles de sus registros, se dividen en partes de como mucho 5000 registros, en su orden canónico: un rol con *n* registros tiene ⌈*n* / 5000⌉ partes, y al menos una, la vacía si no tiene ninguno ([ADR-0020](adr/0020-datasets-vivos.md) §7). El tamaño lo fija el conjunto de reglas (`derived_part_records`), así que no cambia sin otra versión, y el replay une las partes de cada rol en su orden.

## `StorageObjectRef`

Campos comunes:

```text
artifact_id: string                         # clave de unión, única en el manifiesto
role: LogicalArtifactRef.role | "source_schema" | "quality_profile"
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
# solo en la versión 1.1.0, la de un dataset de los lotes, y entonces todos:
market_candle_schema_version: SchemaVersion
trading_session_schema_version: SchemaVersion
contract_offer_schema_version: SchemaVersion
contract_quote_schema_version: SchemaVersion
candle_time_from_utc: UtcTimestampMs | null
candle_time_to_utc: UtcTimestampMs | null
market_candle_count: NonNegativeInteger
trading_session_count: NonNegativeInteger
contract_offer_count: NonNegativeInteger
contract_quote_count: NonNegativeInteger
logical_artifacts: LogicalArtifactRef[]
```

Los conteos coinciden con la suma de artefactos de su rol y `raw_frame_count <= source_event_count`. Si `normalized_tick_count = 0`, ambos tiempos son `null`; de otro modo ambos son no nulos, `from <= to` y representan extremos de ticks normalizados. Lo mismo valen `candle_time_from_utc` y `candle_time_to_utc` con las velas: la apertura de la primera y de la última en su orden canónico.

- **La versión 1.1.0** (desde el PR 5d1 de [ADR-0021](adr/0021-mercados-reales-y-fuentes-de-investigacion.md) §9) es la de un dataset de una secuencia por lotes (ADR-0021 §3), y la 1.0.0 sigue siendo la de la captura en vivo, así que sus `dataset_id` no cambian. Es un cambio aditivo: suma los campos y los roles de los registros de los lotes. Un core 1.1.0 lleva las reglas de los lotes 4.0.0, con su normalizador (`normalizer_version` 4.0.0) y su esquema de incidencias (3.0.0), o, en una historia de ticks, las 4.1.0, con el normalizador 4.1.0 y el esquema 3.1.0 (desde el PR 6b de ADR-0021 §9; la historia de las velas del 6d sigue con las 4.0.0), y la política de segmentos de los lotes (2.0.0); sus registros, en la versión 1.0.0, y los ticks de la historia, `MarketTick` 1.1.0; `operational_conditions` vacío, porque las reglas de los lotes no derivan condiciones; y, como `symbols`, los de sus registros y sus incidencias.
- **Su esquema de fuente** (`source_schema:000000`) es un objeto con el esquema de respuesta de la release fijada de cada operación que usan las reglas de los lotes (`active_symbols`, `contracts_for`, `proposal`, `ticks_history` y `trading_times`), tal como lo trae la release (`batchSourceSchemaBytes`). Las reglas aplican a `active_symbols` y a `contracts_for` sus relajaciones (`createBatchLogConfig`). Su perfil (`quality_profile:000000`) es el de su secuencia, el de la fila `log_quality_profile` de su log, y las reglas buscan en `trading_times` los símbolos de su `symbols`; el de las cotizaciones no lo tiene.

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

Desde el PR 2 de [ADR-0015](adr/0015-reconexion-recuperacion-y-salud-f1-5.md) §13, `deriveHealthReport` (`packages/domain`) admite tres entradas opcionales: los tipos abiertos del registro operativo, que suma a los derivables, únicos y ordenados; el estado de la conexión observado, que sustituye al del log y, si no es `connected`, nunca deja la salud en `healthy` (con raw durable y el log conectado es una causa más, de mínimo `recovering`; sin raw durable sigue `starting`, y tras un cierre pedido, `paused`); y una salud mínima, que solo cuenta si es más severa que `healthy`. Sin ellas da lo mismo que antes. `unobservedHealthReport` arma el informe `failed` o `paused` cuando nada de lo observado es fiable: sin conexión, backlog 0 y campos `null`. Desde el PR 5 de [ADR-0017](adr/0017-punto-de-control-de-la-derivacion-en-vivo.md) §11, `deriveLiveHealthReport` da el mismo informe que `deriveHealthReport` desde la vista del estado vivo del log (`liveDerivationView`), con las mismas entradas opcionales y sin derivar el log entero: lo que el informe toma del log (`HealthLogFacts`) es si sigue conectado, el último raw, el último tiempo de evento y lo derivable que sigue abierto. La prueba de equivalencia del dominio compara los dos en cada límite del corpus de ADR-0017 §9.

Desde el PR 6 de ADR-0015 §13, como decide su §8, `pnpm run data:health -- --json` lo emite desde fuera del proceso que ingiere, sin tomar el bloqueo ni escribir nada, y suma a las condiciones derivables del log las del registro operativo ([runbook](../operacion/runbook-ingesta-de-datos.md#salud-de-datos-datahealth), «Salud de datos (`data:health`)»). Con escritor vivo (el que tiene el bloqueo, con el mismo PID que su latido) y un latido reciente, el backlog sale del latido, y la conexión también si el latido es posterior al último evento de conexión del log; con una conexión que no es `connected`, la salud nunca es `healthy`. Sin escritor, la conexión es `disconnected`, el backlog es 0, la salud es como mínimo `paused` y una conexión sin cierre durable se deriva como cerrada con `close_not_recorded`. Un latido de más de 45 000 ms, o un escritor vivo con otro PID, impone como mínimo `paused`. Lo incompatible que se observa (conector, esquema guardado, símbolo o log no derivable) da `failed`, y el almacenamiento no disponible, `paused`.

**Cómo se lee la causa** (precisión de F2.4). El informe no nombra la causa de su salud: la dan los campos que la imponen. Cada condición abierta impone su mínimo (`CONDITION_HEALTH`), la cola sobre su límite impone `paused` y la salud mínima de quien observa la ingesta, como mucho `paused`; lo que no se pudo observar va en las alertas de `data:health`, aparte del informe (`DataHealth`). En `recovering` sin `connection_lost`, la causa sale de la conexión. Si es `connected`, solo queda la continuidad pendiente, que no abre ninguna condición y deja `open_condition_types` vacío, o con un hueco anterior sin resolver: el pendiente 2 de F1.2, que la web resuelve leyendo así la causa ([concepto de interfaz](../diseno/concepto-de-interfaz.md) §10). Si no es `connected`, la ingesta está reconectando, o cerró la conexión a pedido con la continuidad de una reconexión anterior todavía pendiente: el informe no distingue las dos. Un `paused` cuyas condiciones, cola y alertas no llegan a esa gravedad solo lo da la salud mínima de quien observa la ingesta: no hay un escritor vivo, o su latido no es reciente (ADR-0015 §8, reglas 4 y 6). Uno sin ninguna causa también puede venir de un cierre pedido. La prueba de la web (`apps/web/test/salud.test.ts`) compara esa lectura, con la gravedad de cada causa, con `deriveLiveHealthReport` en todas las combinaciones de sus entradas, así que cambiar las causas de la salud en el dominio, o su gravedad, obliga a cambiar también esta lectura.

`persistence_unavailable` y `source_limit_exceeded` son incidencias operativas cuando impiden crear un source event durable; permanecen en el registro operativo PostgreSQL y no se insertan retroactivamente en un dataset publicado. Los artifacts `quality_incidents` y `operational_conditions` del dataset contienen únicamente eventos derivables de sus source events.

## `SourceCatalogSnapshot`

Definido para F1.4b ([ADR-0012](adr/0012-catalogo-y-adaptador-publico-de-deriv.md) §7, `F1-CATALOG-001`) e implementado en `packages/contracts` (`sourceCatalogSnapshotSchema`, con `deriveCatalogContentSha256` y `deriveCatalogSnapshotId`). Es una versión del catálogo oficial de una fuente, derivada de un `RawSourceFrame` durable que trae la respuesta completa. Es inmutable: un catálogo distinto crea otro snapshot.

Hay dos versiones. Desde la precisión del 2026-11-25 de ADR-0012 §7, buoh deriva la 2.0.0, sin `underlying_symbol_type`, que Deriv dejó de mandar el 2026-11-24 (ADR-0012, «Hechos verificados el 2026-11-25»). La 1.0.0, la de antes, lleva ese campo en cada entrada y su normalizador es el 1.0.0; sigue teniendo lector, porque los logs guardan sus documentos hasta que vencen (ADR-0018 §7). El esquema runtime acepta las dos, cada una con sus entradas, y nada vuelve a escribir una 1.0.0.

El JSON Schema generado (`source-catalog-snapshot`) describe la forma. Solo el esquema runtime comprueba el orden y la unicidad de `entries`, que `entry_count` sea su longitud y los dos hashes.

```text
schema_version: "2.0.0"                     # "1.0.0" en los guardados hasta el 2026-11-24
snapshot_id: DerivedEventId
source: string
catalog_format: "deriv_active_symbols"
catalog_normalizer_version: "2.0.0"         # "1.0.0" con schema_version "1.0.0"
connector_version: string
source_schema_release: string
source_schema_sha256: Sha256Hex
observation_id: UuidV7
raw_payload_sha256: Sha256Hex
received_at_utc: UtcTimestampMs
entry_count: integer >= 1
content_sha256: Sha256Hex
entries: DerivActiveSymbolEntry[]   # no vacía
```

`DerivActiveSymbolEntry`, con los nombres y valores oficiales sin traducir ni reinterpretar:

```text
underlying_symbol: Symbol
underlying_symbol_name: string
underlying_symbol_type: string     # solo en la 1.0.0, y ahí obligatorio
market: string
submarket: string
subgroup: string
pip_size: DecimalString            # lexema recibido, sin exponente
exchange_is_open: 0 | 1
is_trading_suspended: 0 | 1
```

- **Procedencia.** `source`, `connector_version`, `observation_id`, `raw_payload_sha256` y `received_at_utc` son los del frame. `source_schema_release` es la release fijada, y `source_schema_sha256`, el SHA-256 del JCS del esquema de respuesta con que se validó: en la 2.0.0, `active_symbols_response.schema.json` sin `underlying_symbol_type` en la lista `required` de las entradas (`relaxCatalogResponseSchema`, ADR-0012 §2), y en la 1.0.0, ese archivo tal cual.
- **Identidad.** `snapshot_id` es `sha256:` + SHA-256 del JCS del snapshot sin `snapshot_id`. `content_sha256` es el hash de secuencia de `entries` (JCS por línea, unidas por `\n`, con newline final), y `entry_count`, su longitud.
- **Orden.** `entries` va ordenada por `underlying_symbol` en unidades UTF-16 y no repite códigos.
- **Campos fuera.** `trade_count` no entra: es un contador que cambió en todas las entradas entre dos consultas separadas por 8 s (ADR-0012), y con él cada consulta sería una versión. En la 2.0.0, `underlying_symbol_type` tampoco, aunque llegue: así, que Deriv lo mande o no, no crea versiones. El raw lo conserva.
- **Dos `pip_size`.** El `pip_size` del catálogo es la variación mínima que publica Deriv (por ejemplo `0.01`). No es el de `MarketTick`, que cuenta decimales.
- **Versiones.**
  - Un índice PostgreSQL append-only asigna versiones contiguas desde 1 por `source + catalog_format`.
  - Un snapshot se guarda solo si su `content_sha256` difiere del de la última versión; volver a un contenido anterior también crea versión. En un log cuya última versión es una 1.0.0, el primer snapshot 2.0.0 crea versión aunque Deriv mande el mismo catálogo, porque sus entradas ya no llevan `underlying_symbol_type`.
  - La versión la pone el índice y no forma parte del snapshot.
  - El documento es el JCS del snapshot, sin newline, en el almacenamiento de objetos con clave por contenido.
  - Implementado desde el PR 6 de F1.4b en la tabla `source_catalog_versions` (migración `0003`, `PostgresCatalogStore` en el worker).
- **Respuesta inválida.** Una respuesta que falla una de estas comprobaciones no crea versión, y el último snapshot válido sigue vigente. Se comprueban en este orden, y la primera que falla da el motivo:
  1. trae un objeto `error`, como en las reglas 2.0.0: `source_error_response`;
  2. no cumple el esquema fijado, en la 2.0.0 sin exigir `underlying_symbol_type`: `schema_validation_failed`;
  3. la lista falta, no es una lista o está vacía: `catalog_empty`;
  4. un `pip_size` trae exponente: `catalog_exponent_not_supported`;
  5. una entrada no cumple este contrato, por ejemplo un código vacío: `catalog_entry_invalid`;
  6. un código se repite: `catalog_duplicate_symbol`.

  Quien pidió el catálogo registra la incidencia de [respuestas pedidas](#incidencias-de-respuestas-pedidas) con ese motivo.
- **Conversión.** `deriveCatalogSnapshot` (`packages/domain`) aplica las seis comprobaciones a un frame durable y, si pasan, arma el snapshot 2.0.0: proyecta los ocho campos de la 2.0.0, ordena las entradas y calcula los hashes con las funciones del contrato. Es pura, así que el snapshot o la incidencia se pueden volver a derivar del frame. El frame tiene que ser JSON: quien lo correlaciona tiene que leerlo con el mismo lector estricto (`parseJsonPreservingNumbers`), así que un frame que no lo es, o que repite una clave, nunca llega a la conversión, y ya deja la incidencia `payload_not_json` de las reglas 2.0.0. Si llegara, la conversión lanza un error.
- **Estado de mercado.** `exchange_is_open` e `is_trading_suspended` siguen el horario de cada mercado, así que habrá una versión nueva cuando un mercado abra, cierre o se suspenda.

## Registros de los lotes

Los fija [ADR-0021](adr/0021-mercados-reales-y-fuentes-de-investigacion.md) §4, con la precisión de [ADR-0024](adr/0024-semantica-del-backtest.md) §4, y están en `packages/contracts` desde el PR 4b de ADR-0021 §9: `MarketCandle`, `TradingSession`, `ContractOffer` y `ContractQuote`, todos 1.0.0. Salen de las respuestas que piden los lotes con el conector `deriv-options-lotes-1.0.0` (ADR-0021 §3). Las reglas que derivan los horarios, los contratos y las cotizaciones llegaron con el PR 4c ([reglas de los lotes 4.0.0](#semántica-ejecutable-de-las-reglas-de-los-lotes-400)); las de las velas, los ticks de la historia y la clasificación de un log, con el PR 4d, y el paso que pide las respuestas, con el PR 5. Hasta entonces, nadie los produce.

- **Procedencia.** Los cuatro llevan la de `MarketTick`: `observation_id`, `source`, `connector_version`, `received_at_utc` y `raw_payload_sha256` son los del `RawSourceFrame` de la respuesta, así que los registros de un mismo frame comparten su `observation_id`. Desde cuándo vale cada uno lo fijan ADR-0024 §4, en un backtest, también antes del paso de los lotes, y ADR-0026 §3, en `shadow`.
- **Importes y precios.** Son `DecimalString`, del lexema recibido o en decimal exacto, nunca con la aritmética binaria de `JSON.parse`, como `quote_decimal`. Ninguno entra en Git (ADR-0021 §7).
- **Lo medido.** La forma de las respuestas se midió el 2026-11-25 en el canal público de Deriv, sin cuenta y sin guardar precios, con los esquemas de la release fijada (`DERIV_BATCH_OPERATIONS`). Las horas y los tipos de contrato de abajo salen de esa medición.
- **JSON Schema y runtime.** El JSON Schema generado de cada uno describe su forma. Solo el esquema runtime comprueba los decimales, el orden, las huellas y las relaciones entre campos.

### `MarketCandle`

```text
schema_version: "1.0.0"
observation_id: UuidV7
source: string
connector_version: string
symbol: Symbol
open_time_utc: UtcTimestampMs              # `epoch` de Deriv: el principio del minuto
granularity_seconds: 60
open_decimal: DecimalString
high_decimal: DecimalString
low_decimal: DecimalString
close_decimal: DecimalString
pip_size: entero 0..18
received_at_utc: UtcTimestampMs
raw_payload_sha256: Sha256Hex
candle_fingerprint_sha256: Sha256Hex
quality_flags: QualityIncidentType[]
```

- **Qué es.** Una vela de 1 minuto que calcula Deriv, de `ticks_history` con `style: "candles"` y `granularity: 60`. Nunca se mezcla con las que buoh arma con sus ticks, y una estrategia declara cuáles usa (ADR-0021 §4; ADR-0022 §2).
- **Su intervalo** va de `open_time_utc`, incluido, a `open_time_utc` más `granularity_seconds`, sin incluir. Ese fin es su instante en el backtest (ADR-0024 §4). El 2026-11-25, el `epoch` de cada vela fue un múltiplo de 60 s y el principio de su minuto. Deriv no da velas sin ticks: el oro no tuvo ninguna de 22:00 a 23:00 UTC del 2026-11-24, su cierre diario, ni el sábado 2026-11-21.
- **Solo velas terminadas al recibirse.** Con `end: "latest"`, Deriv da también la vela del minuto en curso. El contrato rechaza una vela cuyo fin es posterior a su `received_at_utc`, que según el reloj de buoh todavía no había terminado. No garantiza que Deriv la hubiera cerrado: una vela calculada justo antes del fin de su minuto y recibida justo después, o con los relojes de Deriv y de buoh desfasados, pasa. Las reglas de los lotes dejan fuera la última vela de una página si su minuto no había terminado al recibirse, sin incidencia.
- **Granularidad.** Solo 60 s, la que piden los lotes (ADR-0021 §3). Otra es otra versión.
- **Decimales.** Cada precio lleva exactamente `pip_size` decimales, el `pip_size` de la respuesta, como `quote_decimal`. El máximo no es menor que la apertura ni que el cierre, y el mínimo no es mayor que ninguno de los dos.
- **Huella.** `candle_fingerprint_sha256` es el SHA-256 del JCS de `close_decimal`, `granularity_seconds`, `high_decimal`, `low_decimal`, `open_decimal`, `open_time_utc`, `pip_size`, `source` y `symbol`. No incluye la observación ni la recepción, así que la misma vela en dos páginas tiene la misma huella, como un tick repetido.
- `quality_flags` es único y ordenado, como en `MarketTick`.

### `TradingSession`

```text
schema_version: "1.0.0"
observation_id: UuidV7
source: string
connector_version: string
symbol: Symbol
trading_date: "AAAA-MM-DD"                  # el día UTC pedido
intervals: TradingInterval[]                # vacía: ese día no cotiza
received_at_utc: UtcTimestampMs
raw_payload_sha256: Sha256Hex
```

`TradingInterval`:

```text
opens_at_utc: UtcTimestampMs
closes_at_utc: UtcTimestampMs
```

- **Qué es.** El horario de un símbolo en un día UTC, de una respuesta de `trading_times` para ese día. Un frame da como mucho un `TradingSession` por cada símbolo que pide el perfil (ver «Semántica ejecutable de las reglas de los lotes 4.0.0»). Un horario es de un día: vale el último recibido para ese día (ADR-0024 §4).
- **Los intervalos.** Cada uno cotiza desde `opens_at_utc`, incluido, hasta `closes_at_utc`, sin incluir. Van en orden, sin solaparse ni tocarse, entre las 00:00 de `trading_date` y las 00:00 del día siguiente.
- **Desde Deriv.** `times.open` y `times.close` son listas paralelas de horas `HH:MM:SS` en UTC, y un día sin cotización trae `--` en las dos. Un cierre `23:59:59` es el fin del día, y el contrato lo guarda como las 00:00:00.000 del día siguiente. El 2026-11-24, el oro dio ticks a las 23:59:59 y a las 00:00:00, y R_100 a las 23:59:58 y a las 00:00:00: la sesión sigue al día siguiente, y con un fin a las 23:59:59 el último segundo de cada día parecería cerrado. Los demás cierres son la hora misma: ese día, el último tick del oro antes de su cierre de las 22:00:00 fue de las 21:59:59, y el primero después de su apertura de las 23:00:00, de las 23:00:01. `settlement`, `trading_days` y los avisos de `events` no entran; los conserva el raw.
- **Ejemplos del 2026-11-25.** El oro cotiza ese día de 00:00 a 22:00 y de 23:00 a 00:00; el 2026-11-26, de 00:00 a 16:30, por un cierre anticipado; y el sábado 2026-11-28, nada. R_100, Bitcoin y Ethereum, el día entero los siete días. El `trading_times` de un día de hace un año respondió con la misma forma.

### `ContractOffer`

```text
schema_version: "1.0.0"
observation_id: UuidV7
source: string
connector_version: string
symbol: Symbol
offers: ContractTypeOffer[]                 # vacía si no ofrece ninguno de los cuatro
received_at_utc: UtcTimestampMs
raw_payload_sha256: Sha256Hex
```

`ContractTypeOffer`, de una de dos formas, con los nombres de Deriv:

```text
contract_category: "callput"
contract_type: "CALL" | "PUT"
expiry_type: "tick" | "intraday" | "daily"
min_contract_duration: ContractDuration
max_contract_duration: ContractDuration

contract_category: "multiplier"
contract_type: "MULTUP" | "MULTDOWN"
expiry_type: "no_expiry"
```

`ContractDuration`, con los nombres de `proposal`:

```text
duration: entero 1..99999999
duration_unit: "t" | "s" | "m" | "h" | "d"
```

- **Qué es.** De una respuesta de `contracts_for` de un símbolo, cuáles de los cuatro tipos que usa buoh ofrece ese mercado (ADR-0022 §5) y, en sube/baja, la duración mínima y la máxima de cada vencimiento. Los demás tipos y las barreras no entran; los conserva el raw.
- **Duraciones.** Deriv las da como texto, como `5m`, `1d` o `10t`, y el contrato las guarda con su número y su unidad. El vencimiento `tick` va en ticks (`t`), y `intraday` y `daily`, en tiempo. La mínima no pasa de la máxima.
- **Sin multiplicadores.** `contracts_for` publica `multiplier_range`, pero el 2026-11-25, sin cuenta, `proposal` aceptó otros en los siete mercados reales, y solo en R_100 coincidieron (ADR-0021 §3). El contrato no los guarda, para que nadie los tome por los que se aceptan. Qué multiplicadores se ofrecen lo dicen las cotizaciones (ADR-0024 §4). Las duraciones de sube/baja sí coincidieron con las que aceptó `proposal`.
- **Orden.** `offers` va ordenada por `contract_type` y `expiry_type`, en unidades UTF-16, sin repetir la pareja. El 2026-11-25, `contracts_for` trajo como mucho una entrada de `CALL` y una de `PUT` por vencimiento en los ocho mercados: la de `tick` y la de `intraday`, con la barrera relativa del sube/baja, y la de `daily`, con una absoluta (la clase de la barrera se miró en R_100 y en el oro). Con dos del mismo tipo y vencimiento, las reglas no dan registro (`contracts_for_duplicate_entry`).

### `ContractQuote`

```text
schema_version: "1.0.0"
observation_id: UuidV7
source: string
connector_version: string
symbol: Symbol
currency: "USD"
stake_decimal: DecimalString                # `amount`, con `basis: "stake"`
quoted_at_utc: UtcTimestampMs               # `spot_time`
ask_price_decimal: DecimalString
received_at_utc: UtcTimestampMs
raw_payload_sha256: Sha256Hex
# y, según contract_category:
contract_category: "callput"
contract_type: "CALL" | "PUT"
duration: ContractDuration
payout_decimal: DecimalString

contract_category: "multiplier"
contract_type: "MULTUP" | "MULTDOWN"
multiplier_decimal: DecimalString
commission_decimal: DecimalString
```

- **Qué es.** Lo que Deriv ofrecía por un contrato en un instante, de una respuesta de `proposal` sin cuenta y sin suscripción: un registro por respuesta. El contrato pedido (el símbolo, el tipo, la apuesta, la moneda y la duración o el multiplicador) sale de `echo_req`, que Deriv devuelve en la misma respuesta, y lo cotizado, de `proposal`.
- **Sin cotización.** Una respuesta con `error`, como un multiplicador que no acepta (`ContractBuyValidationError`) o una duración que no ofrece (`TradingDurationNotAllowed`), no da registro. Las reglas de los lotes la registran como incidencia: el rechazo de un multiplicador, como `contract_rejected`, con el contrato pedido, y los demás errores, como `invalid_source_frame`.
- **La hora.** `quoted_at_utc` es `spot_time`, la del tick con que Deriv cotizó. `date_start` no entra: el 2026-11-25 coincidió con `spot_time` en ocho de las nueve respuestas medidas, y la otra fue un sube/baja de 5 ticks de R_100.
- **Lo que usa el backtest** (ADR-0022 §5 y ADR-0024 §6). En un sube/baja, `payout_decimal`. En un multiplicador, `commission_decimal`, que dividida por la apuesta por el multiplicador da la comisión como fracción de la exposición. Es un importe en la moneda, aunque el esquema de la release describa `commission` como un porcentaje: el 2026-11-25, en R_100 y en el oro, salió de 2 a 2,03 veces mayor al doblar la apuesta, y en la proporción del multiplicador al pasarlo de 100 a 200 en R_100 (2,03 veces) y de 100 a 500 en el oro (5 veces). `ask_price_decimal` es el precio del contrato, y con `basis: "stake"` fue la apuesta en las cuatro respuestas medidas. Deriv manda también `payout` en un multiplicador, sin sentido sin vencimiento, y no entra; tampoco `spot`, `longcode`, `id`, los límites ni las barreras, que conserva el raw.
- **Importes.** Sin signo; la apuesta y el multiplicador, mayores que cero. El esquema de Deriv admite `commission: null`, y el contrato no: una respuesta así da `proposal_inconsistent`.

## Replay de dataset

`pnpm run data:replay -- --dataset <id>` ejecuta por defecto **recomputación**, sin red:

1. resolver el `PublishedManifestRecord` activo y verificar el documento canónico;
2. validar hashes físicos y decodificar objetos;
3. reconstruir hashes lógicos y validar `DatasetManifestCore`;
4. tomar únicamente source events, esquema de fuente, perfil y versiones como inputs;
5. regenerar ticks, incidencias derivables y `OperationalConditionEvent` derivables;
6. ordenar/canonicalizar resultados y comparar hashes, conteos, core y `dataset_id`.

`--verify-only` termina después del paso 3 y demuestra integridad, no corrección del normalizador. Desde el PR 5d1 de [ADR-0021](adr/0021-mercados-reales-y-fuentes-de-investigacion.md) §9, un dataset de los lotes (`DatasetManifestCore` 1.1.0) se valida igual, con sus registros y su coherencia, y se recomputa con las reglas de los lotes que declara (`buildBatchDatasetPublication`), desde sus source events, su esquema de fuente y su perfil. En los dos modos, un core 1.1.0 tiene que declarar las reglas 4.0.0 o, desde el PR 6b, las 4.1.0, y un core 1.0.0 no puede declararlas; las 4.0.0 atan su esquema de incidencias al 3.0.0, y las 4.1.0, al 3.1.0. La recomputación pide además el normalizador de esas reglas y la política de segmentos 2.0.0. Desde F1.3a lo implementa [`apps/market-data-worker`](../../apps/market-data-worker/); informe JSON y códigos de salida en el [runbook](../operacion/runbook-ingesta-de-datos.md#entorno-local-y-replay-f13). Incidencias operativas `persistence_unavailable` y `source_limit_exceeded` fuera de un dataset no se recomputan; se validan en pruebas fail-closed mediante sus causas inyectadas. Un replay nunca contacta a Deriv ni usa reloj/IDs nuevos.

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

### Semántica ejecutable de reglas 1.0.0

Desde F1.2, [`packages/domain`](../../packages/domain/) implementa estas reglas como funciones puras sobre source events en orden de observación; el vector v1 fija su resultado. Precisiones que el vector determina o que el código necesita para no elegir silenciosamente:

| `incident_type` | `severity` | `observed_ref` / `observed_at_utc` | `related_refs` | Flag en tick |
|---|---|---|---|---|
| `invalid_source_frame` | `error` | raw / recepción | `[]` | no hay tick |
| `duplicate_exact` | `warning` | raw / recepción | primera observación con el mismo fingerprint | el duplicado |
| `source_time_conflict` | `error` | raw / recepción | primera observación de ese `source + symbol + event_time_utc` | el conflictivo |
| `out_of_order` | `warning` | raw / recepción | observación que fijó el high-watermark | el atrasado |
| `delivery_delayed` | `warning` | raw / recepción | `[]` | el retrasado |
| `connection_lost` | `warning` | `ConnectionClosed` / cierre | `[]` | — |
| `event_gap_unresolved` | `error` | `HistoryRecoveryResult` / resultado | tick previo y tick posterior que delimitan el rango, entre los ya observados | el tick posterior |

- Conflicto se evalúa contra la primera observación del instante; una observación idéntica a esa es solo duplicado.
- El high-watermark avanza solo con un tiempo estrictamente mayor; igual tiempo no es fuera de orden.
- Límites del hueco: el tick de mayor tiempo anterior a `from_event_time_utc` y el de menor tiempo posterior a `to_event_time_utc`; empates, la primera observación.
- `partial` y `unavailable` crean incidencia; abren condición solo si la clave no está abierta. `complete` resuelve una clave abierta con `resolution_reason = history_recovered`; la reconexión usa `connection_reestablished`. Ambas resoluciones citan el evento fuente y la apertura.
- Un frame inválido se atribuye al `tick.symbol` del payload si es un símbolo permitido; si no, al único símbolo del perfil. Con varios símbolos permitidos y sin atribución posible, la derivación aborta.
- `evidence.reason` de `invalid_source_frame` en normalizador 1.0.0: `payload_not_json` (incluye claves duplicadas y JSON no estricto), `schema_validation_failed`, `symbol_not_allowed`, `event_time_out_of_range`, `quote_exponent_not_supported` y `quote_precision_exceeds_pip_size`.
- `quote_decimal` sale del lexema numérico del payload: completar con ceros hasta `pip_size` es exacto; más decimales o exponente invalidan el frame en lugar de redondear.
- `symbols` del manifiesto es la unión ordenada de símbolos de ticks, incidencias, recuperaciones y `affected_symbols`.
- Continuidad tras `ConnectionClosed` no solicitado (`gap_detection = after_reconnection`): cada símbolo afectado con high-watermark queda pendiente desde ese high-watermark (inicio del hueco). Decide solo el primer tick estrictamente posterior al high-watermark vigente en el último cierre; uno igual o anterior no informa sobre el intervalo. Si su separación respecto del inicio no supera `maximum_event_gap_ms` y el hueco no se había declarado excedido, demuestra continuidad; si no, el hueco queda excedido y ese tick fija su fin. Un nuevo cierre de un símbolo pendiente conserva inicio y estado excedido y espera un nuevo fin, de modo que una sola recuperación debe cubrirlos todos. Solo decide un `HistoryRecoveryResult` del símbolo registrado después de fijado el fin y cuyo rango cubra desde el inicio + 1 ms hasta el fin − 1 ms (`complete` la demuestra; `partial`/`unavailable` crean `event_gap_unresolved`); uno anterior o que no cubre no decide y la salud permanece `recovering`. Pendiente no crea incidencia: la recuperación la solicita el worker (F1.5).
- Salud derivada: cada causa impone un mínimo y gana el más severo: `connection_lost` → `recovering`, continuidad pendiente → `recovering`, `event_gap_unresolved` → `degraded`, `persistence_unavailable`, `source_limit_exceeded` o cola sobre su límite → `paused`. Sin causas: `starting` sin raw durable, `paused` si la última conexión se cerró a petición, `healthy` en otro caso. `last_event_time_utc` es el extremo final de los ticks canónicos. F1.2 solo recibe condiciones derivables del dataset; desde F1.5, `deriveHealthReport` suma las del registro operativo y la salud mínima cuando se le pasan, y una conexión observada que no es `connected`, con raw durable y el log conectado, es otra causa → `recovering` ([ADR-0015](adr/0015-reconexion-recuperacion-y-salud-f1-5.md) §8).
- Source events con `schema_version` distinta de la implementada abortan la derivación; no se migran.
- `persistence_unavailable` y `source_limit_exceeded` no se derivan de un dataset: F1.2 fija su resultado fail-closed y su evidencia; su registro operativo se define en la sección siguiente.

### Semántica ejecutable de reglas 2.0.0

Decididas por el propietario antes de F1.4 para fuentes que mezclan varios tipos de mensaje en la misma conexión, como Deriv. El perfil de calidad elige el conjunto de reglas con `quality_rule_version`. Cada conjunto fija su normalizador y el esquema de incidencias que emite. Son versiones mayores porque cambian el resultado de entradas que 1.0.0 ya define:

| `quality_rule_version` | `normalizer_version` | `incident_schema_version` | Uso |
|---|---|---|---|
| `1.0.0` | `1.0.0` | `1.0.0` | vectores sintéticos v1 |
| `2.0.0` | `2.0.0` | `2.0.0` | Deriv y fuentes con varios tipos de mensaje |
| `3.0.0` | `3.0.0` | `2.0.0` | los datasets vivos de Deriv: las 2.0.0 más los ticks de la historia y los artefactos por partes (ver «Semántica ejecutable de reglas 3.0.0») |

Las reglas 2.0.0 son las 1.0.0 con estas diferencias:

- **Perfil.** El perfil 2.0.0 declara en `non_tick_msg_types` (no vacío, único, ordenado, sin textos vacíos ni `tick`) los tipos de respuesta de la fuente que no son ticks, por ejemplo `ping` o `active_symbols`. El perfil 1.0.0 no puede declararlo.
- **Mensajes que no son ticks.** Un frame JSON cuyo `msg_type` está en `non_tick_msg_types` se conserva raw en el log como cualquier frame, pero no produce tick ni incidencia; su significado lo procesa quien lo pidió. Eso incluye un objeto `error` en esa respuesta: quien la pidió debe comprobarlo y registrarlo, porque las reglas de calidad no lo hacen. Cualquier otro mensaje, con un `msg_type` no declarado, vacío, de otro tipo o ausente, sigue siendo candidato a tick: si no cumple el esquema de fuente, es `invalid_source_frame`.
- **Errores de la fuente.** Un frame no declarado como respuesta que contiene un objeto `error` es `invalid_source_frame` con motivo `source_error_response`.
- **Atribución.** El símbolo de un frame inválido se toma, en este orden, de `tick.symbol` si está permitido, de `echo_req.ticks` (la copia de la petición que devuelve la fuente) si está permitido, o del único símbolo del perfil. Sin atribución posible, la incidencia lleva `symbol = null` y la derivación continúa, en lugar de abortar como en 1.0.0.
- **Esquema de incidencias 2.0.0.** La única diferencia con 1.0.0 es que admite `symbol = null` en `invalid_source_frame`. Las incidencias 1.0.0 siguen exigiendo símbolo, y una versión distinta de 1.0.0 y 2.0.0 se rechaza.
- **Publicación.** Un dataset cuyos frames no permiten atribuir ningún símbolo no es publicable, porque `symbols` del manifiesto no puede quedar vacío.

Cada registro de un dataset declara la misma versión de contrato que su manifiesto, y cada incidencia sus mismas reglas; `validateDatasetConsistency` lo exige (`DATASET_VERSION_MISMATCH`). El replay en `--verify-only` acepta solo esquemas de incidencias con lector y coherentes con las reglas declaradas cuando esas reglas están implementadas; la recomputación exige además un conjunto de reglas implementado.

Aplicadas a los source events del vector v1, las reglas 2.0.0 dan los mismos ticks y las mismas incidencias y condiciones, salvo sus campos de versión e IDs derivados. El vector v1 sigue fijado a 1.0.0, y el replay conserva lector y recomputación para ambos conjuntos.

### Semántica ejecutable de reglas 3.0.0

Desde F2.5 ([ADR-0020](adr/0020-datasets-vivos.md) §2, §3 y §7), para publicar los datasets vivos de Deriv. Son las reglas 2.0.0 con dos diferencias, y con las demás entradas dan lo mismo que ellas. Son mayores porque cambian el resultado de entradas que 2.0.0 ya define: una respuesta `history` deja de producir solo raw, y un rol derivado con más de 5000 registros deja de ser un solo artefacto.

- **Perfil.** Como el 2.0.0, declara `non_tick_msg_types`, y tiene que incluir `history`: los ticks de la historia salen de esas respuestas, que así no son candidatas a tick. Crear un perfil 3.0.0 sin `history` falla. Un perfil de medición sigue usando las reglas 2.0.0 (ver «Perfil de medición»).
- **Ticks de la historia.** Un `HistoryRecoveryResult` `complete` que resuelve la continuidad pendiente de su símbolo en la misma derivación, con el rango exacto de ese hueco (`from_event_time_utc` = inicio + 1 ms y `to_event_time_utc` = fin − 1 ms, el de `pendingGaps`), convierte en `MarketTick` los ticks de su historia. Un resultado `partial` o `unavailable`, uno `complete` sin continuidad pendiente, como el de un hueco que empezó antes del primer segmento del dataset, y uno con un rango mayor que el del hueco no dan ticks: sus páginas siguen solo en el raw.
- **Qué páginas.** Las del último intento de la sesión, que correlaciona cada respuesta por su `req_id`, un número entero positivo que asigna creciente en cada conexión: los frames `history` de la misma conexión, posteriores al resultado anterior de esa conexión, cuya petición (`echo_req.ticks_history`) es el símbolo del resultado y cuyo `req_id` es igual o mayor que el de la página de mayor `req_id` cuya petición termina en E (`echo_req.end`, como entero, número o texto). Una respuesta con el `req_id` en texto, 0 o sin él no es una página. Las páginas de otra conexión, como las de una recuperación que se abandonó al perderse la conexión, no cuentan, aunque repitan los `req_id`, que vuelven a empezar en cada conexión. S y E son los segundos de los extremos: S = `from_event_time_utc` − 1 ms y E = `to_event_time_utc` + 1 ms. Así no cuenta la respuesta tardía de un intento anterior.
- **Qué ticks.** Los de esas páginas con un tiempo estrictamente entre S y E. Cada página pasa las comprobaciones de ADR-0015 §4 que no necesitan el esquema de respuesta (`readHistoryTicks`, en `packages/domain`): `history.times`, `history.prices` y `pip_size`; `pip_size` de valor entero de 0 a 18, también con una fracción de ceros (`2.0`); las dos listas de la misma longitud; tiempos enteros estrictamente crecientes dentro de lo que pidió la página; y precios que acepta la regla de `quote_decimal` con ese `pip_size`. Si una página no las pasa, o los tiempos distintos no suman `recovered_event_count`, la derivación aborta: la sesión ya comprobó esas mismas páginas.
- **Sus campos.** `origin: "history_recovery"`; `observation_id`, `raw_payload_sha256`, `received_at_utc`, `source` y `connector_version` del frame; `event_time_utc`, su segundo en UTC con milisegundos; `pip_size`, el de la página; y `quote_decimal`, el lexema de su precio con ese `pip_size`.
- **Sus reglas.** Entran en la derivación en la posición de su resultado, en orden de tiempo, con `duplicate_exact` y `source_time_conflict` contra todos los ticks anteriores, del flujo y de la historia; y un tick posterior, de cualquiera de los dos, se compara también con ellos. No mueven el high-watermark, no deciden la continuidad, no se evalúan con `out_of_order` ni con `delivery_delayed`, y no son extremos de un hueco. Las marcas van con cada tick, por su `observation_id` y su `event_time_utc`; en sus incidencias, `observed_ref` y `related_refs` citan el frame, y la evidencia dice qué tick.
- **Partes.** Los roles derivados se dividen en partes de 5000 registros (ver `LogicalArtifactRef`).
- **El estado vivo.** El pliegue de [ADR-0017](adr/0017-punto-de-control-de-la-derivacion-en-vivo.md) §3 no produce ticks ni artefactos, así que da lo mismo con las reglas 2.0.0 y 3.0.0 para un mismo perfil de umbrales. Desde el PR 5 de ADR-0020 §13, el estado vivo de un log con `log_quality_profile` se deriva con el perfil de publicación, de reglas 3.0.0 (§4). La prueba del vector, que trae ticks de la historia, compara el pliegue con `deriveMarketData` en cada límite de segmento (huecos pendientes, tipos abiertos y continuidad pendiente) y, en cada evento, retoma el pliegue desde su punto de control pasado por el contrato y por JSON y lo compara con el del log entero.

Implementado en `packages/domain` (`RULE_SETS['3.0.0']`, `deriveMarketData`, `historyTicksOf`, `readHistoryTicks` y `buildDatasetPublication`). Su vector está en `packages/domain/test/rules-3-0-0.test.ts` (ver «Oráculo inicial»).

### Semántica ejecutable de las reglas de los lotes 4.0.0

Desde el PR 4c de [ADR-0021](adr/0021-mercados-reales-y-fuentes-de-investigacion.md) §9, para las secuencias por lotes de ADR-0021 §3. Son un conjunto propio, no la versión siguiente de las reglas en vivo: el número sigue la serie para que una `quality_rule_version` nombre un solo conjunto, y `RULE_SETS` no lo tiene, así que un perfil en vivo no lo puede pedir. Sus incidencias usan el esquema 3.0.0. El PR 4c trajo las de `trading_times`, `contracts_for` y `proposal`, y el 4d, las de las velas y los ticks de la historia, con sus repetidos entre páginas, y la clasificación de los frames de un log. El 5d1 trae las velas que faltan dentro del horario de su mercado (ADR-0021 §4; ADR-0024 §5), sin umbral: cada minuto que falta cuenta. Un tramo sin ticks de la historia llega con las [reglas 4.1.0](#semántica-ejecutable-de-las-reglas-de-los-lotes-410) del PR 6b, con el umbral por mercado de su perfil.

- **Entrada.** Un `RawSourceFrame` durable que responde a la operación, con el esquema de respuesta de la release fijada que compila quien llama. Las funciones son puras. Un frame que no es JSON o que responde a otra operación (`msg_type`) es un error del llamador, y lanza: los frames de un log pasan antes por su clasificación (`deriveBatchLog`).
- **Comprobaciones comunes**, en este orden, como en las [respuestas pedidas](#incidencias-de-respuestas-pedidas): un objeto `error` da `source_error_response`, salvo el rechazo de un multiplicador, y una respuesta que no cumple su esquema, `schema_validation_failed`. Las dos son `invalid_source_frame` de gravedad `error`, con la observación, la recepción y el hash del frame y el símbolo pedido de `echo_req` si lo trae.
- **`trading_times`** (`deriveTradingSessions`). El día sale de `echo_req.trading_times`, que tiene que ser una fecha `AAAA-MM-DD` real; si no, por ejemplo con `today`, `trading_date_unknown`, sin símbolo. Da un `TradingSession` por cada símbolo del perfil que trae la respuesta, en el orden de los símbolos. Un símbolo que no trae no da registro ni incidencia: su día queda sin horario (ADR-0024 §4). Uno que aparece dos veces, o cuyas horas no son coherentes, da `trading_times_inconsistent` con su símbolo, y los demás siguen. Las horas son coherentes si `times.open` y `times.close` tienen la misma longitud, con al menos un elemento, y o bien las dos son la lista `["--"]`, un día sin cotización, o cada pareja es de horas `HH:MM:SS` con la apertura antes del cierre y el contrato acepta los intervalos que salen. Un cierre `23:59:59` es el fin del día, y dos intervalos seguidos que se tocan se unen en uno.
- **`contracts_for`** (`deriveContractOffer`). El símbolo sale de `echo_req.contracts_for`. Entran las entradas de `CALL`, `PUT`, `MULTUP` y `MULTDOWN`; las demás no. Una de esas cuatro es coherente si es del mismo símbolo, `CALL` y `PUT` son de `contract_category` `callput` con un vencimiento `tick`, `intraday` o `daily` y duraciones de la forma `5m`, `1d` o `10t`, y `MULTUP` y `MULTDOWN` son de `multiplier` con `no_expiry`. Una incoherente, la falta de `available` o un conjunto que el contrato rechaza, como una duración mínima mayor que la máxima, da `contracts_for_inconsistent`, y dos del mismo tipo y vencimiento, `contracts_for_duplicate_entry`; en los dos casos no hay registro, así que sigue valiendo el anterior. Desde el PR 5a de ADR-0021 §9, el esquema de la respuesta es el de la release con `growth_rate_barrier_offsets` descrito en cada entrada, que Deriv manda en el `ACCU` de R_100 (`relaxContractsForResponseSchema`; ADR-0012 §2).
- **`proposal`** (`deriveContractQuote`). El contrato pedido sale de `echo_req`, y solo es suyo si es de los que pide el paso de los lotes: `basis` `stake`, `currency` `USD`, una apuesta mayor que cero, un sube/baja con una duración entera de 1 a 99 999 999 y su unidad, o un multiplicador mayor que cero, sin otros campos que los de la petición (`proposal`, `req_id`, `underlying_symbol`, `contract_type`, `amount`, `basis`, `currency`, `duration`, `duration_unit` y `multiplier`). Los importes y el multiplicador son el lexema del número, que no puede llevar exponente.
  - **El rechazo de un multiplicador.** Un error `ContractBuyValidationError` con `details.field` `multiplier`, a un multiplicador que es suyo, da `contract_rejected`, de gravedad `info`, con el símbolo, el tipo y el multiplicador pedidos y el código del error. Es la lista cerrada de ADR-0024 §4: cualquier otro error, como `RateLimit`, un mercado cerrado, `TradingDurationNotAllowed` u otro campo de `ContractBuyValidationError`, da `source_error_response` y no cambia qué se ofrece.
  - **Sin cotización.** Un contrato que no es suyo da `proposal_request_unsupported`. Si lo es, la respuesta da su `ContractQuote`, o `proposal_inconsistent` si al contrato le falta algo: `ask_price`, `payout` en un sube/baja o `commission` en un multiplicador, también si es `null`, que no son decimales sin exponente, un importe negativo o un `spot_time` que no es un entero de segundos.
- **Velas** (`deriveMarketCandles`). Una página de `ticks_history` con `msg_type` `candles`. La petición, de `echo_req`, tiene que ser de las del paso de los lotes: un símbolo, `style` `candles`, `granularity` 60, `start` y `end` enteros, con `end` no anterior a `start` y no `latest`, y solo los campos `ticks_history`, `style`, `granularity`, `start`, `end`, `count` y `req_id`; si no, `history_request_unsupported`. Cada vela tiene un `epoch` entero, desde el principio del minuto de `start` hasta `end`, estrictamente creciente, y sus cuatro precios con el `pip_size` de la respuesta, por la regla de `quote_decimal`, y el contrato la acepta. Si no, la página entera da `candles_inconsistent`, sin velas. La última vela, si su minuto no había terminado en `received_at_utc`, queda fuera sin incidencia, y una vela así que no es la última hace la página incoherente. Una página sin velas, como con el mercado cerrado, no da nada.
- **Ticks de la historia** (`deriveHistoryDownloadTicks`). Una página de `ticks_history` con `msg_type` `history`, con una petición como la de las velas pero con `style` `ticks` o sin `style`, y sin `granularity`; si no, `history_request_unsupported`. La página pasa las comprobaciones de `readHistoryTicks` (ADR-0015 §4) con su `start` y su `end`; si no, `history_inconsistent`, sin ticks. Cada tick es un `MarketTick` 1.1.0 con el origen `history_download`, la procedencia del frame y `quality_flags` vacío.
- **Un log** (`deriveBatchLog`). Recorre los source events de un log de los lotes en su orden y convierte cada frame según su `msg_type`: `trading_times`, `contracts_for`, `proposal`, `candles`, `history` o `active_symbols`. Los eventos de conexión no dan nada. Un frame que no es JSON da `payload_not_json`, y uno con otro `msg_type`, `unexpected_msg_type`, los dos sin símbolo. Un error a `ticks_history`, que Deriv manda con `msg_type` `ticks_history`, da `source_error_response` con el símbolo pedido. La respuesta `active_symbols`, el catálogo de los lotes (ADR-0021 §3), no da registro: el raw la conserva, y una inválida da su incidencia con el motivo del catálogo (ver `SourceCatalogSnapshot`).
- **Velas que faltan** (desde el PR 5d1 de ADR-0021 §9). Un minuto está pedido si una página de velas respondida, válida o no (también con un error, como `RateLimit`), cuya petición es de las del paso de los lotes, pide su vela, como las acepta la regla de las velas: desde el minuto de su `start` hasta el de su `end`. Cuenta si ya había terminado al recibirse la página y si cae entero dentro de un intervalo del horario de su símbolo y su día: el último `TradingSession` recibido para ese día entre los mismos eventos, los del dataset. Un minuto pedido sin vela de ninguna página falta. Cada tramo de minutos seguidos que faltan, por símbolo, da un `candle_missing`, con el tramo, la observación de la última página que pidió su primer minuto en `observed_ref` y la de los horarios que usó en `related_refs`. Sin horario de su día en el dataset, un minuto no se comprueba, y uno que ninguna página pidió, como los de una vuelta abandonada, tampoco: su día queda corto sin incidencia. Por eso el paso de los lotes pide, antes de las páginas de cada día, el `trading_times` de ese día, y el 5d2 publica cada día de velas con su horario en un solo dataset.
- **Repetidos entre páginas.** Cuenta el primero, en el orden del log, y el repetido no es un registro. Una vela con el mismo símbolo y minuto que la primera, la que cuenta, da `candle_repeated`, `warning` si es igual a ella y `error` si trae otros precios. Un tick con la misma huella que otro que cuenta da `duplicate_exact`, y uno con el mismo símbolo e instante y otra huella, `source_time_conflict`, como en las reglas en vivo, pero sin quedar en la lista con su marca. Solo se compara con el tick que cuenta: una tercera copia igual a la segunda, que no contó, da otro `source_time_conflict` contra el primero, y no `duplicate_exact`. Las tres llevan la observación del primero en `related_refs`, y la del repetido en `observed_ref`.
- **Orden.** Cada clase sale en su orden canónico (ver «Canonicalización y orden»), y las incidencias, por `observed_at_utc`, tipo e `incident_id`, como en los datasets en vivo.
- **Política de segmentos 2.0.0** (`BATCH_SEGMENT_POLICY`). La de las secuencias en vivo, con el segmento cerrado además a las 15 respuestas: el motivo es `raw_frames`, porque cada respuesta es un frame raw, y los demás eventos no cuentan. Mantiene los 64 MiB y la ventana de 5 minutos: un segmento que no llega a 15 respuestas se cierra con el primer evento que llega 5 minutos o más después del suyo primero, que puede ser de la misma ejecución o de otra, si antes no se cierra de forma explícita (ADR-0005 §5), lo que fija el PR 5. `evaluateSegmentRotation` recibe la política; sin ella, sigue la 1.0.0 de las secuencias en vivo. La usará el paso de los lotes desde el PR 5. (Precisión del PR 5c1 de ADR-0021 §9: el comando de los lotes abre el log con esta política, que el segmento cerrado lleva en `segment_policy_version`, y al terminar cada secuencia de una ejecución cierra el segmento abierto de forma explícita, con el motivo `requested`. Si una escritura falla o el proceso se corta, el segmento queda abierto hasta la siguiente ejecución que escribe en esa secuencia, que lo cierra igual, con `requested`, antes de escribir nada, también si con un corte escribe en el log siguiente. En los horarios y las velas, si la vuelta del día ya estaba entera, esa ejecución es la del día siguiente. Así ningún segmento de los lotes mezcla dos ejecuciones, aunque la conexión de la que falló quede sin su `ConnectionClosed`.)

Implementado en `packages/domain/src/batch-rules.ts` (`BATCH_RULE_SET`, `deriveTradingSessions`, `deriveContractOffer`, `relaxContractsForResponseSchema`, `deriveContractQuote` y `compareBatchRecords`), en `batch-series.ts` (`deriveMarketCandles`, `deriveHistoryDownloadTicks` y `deriveBatchLog`), en `segment-policy.ts` y, la publicación de sus datasets, en `batch-publication.ts` (`batchSourceSchemaBytes`, `createBatchLogConfig` y `buildBatchDatasetPublication`). Sus vectores sintéticos están en `packages/domain/test/batch-rules.test.ts`, `batch-series.test.ts` y `batch-publication.test.ts`, que corren con `pnpm run test:vectors` bajo las mismas guardas de reloj, azar y red.

### Semántica ejecutable de las reglas de los lotes 4.1.0

Desde el PR 6b de [ADR-0021](adr/0021-mercados-reales-y-fuentes-de-investigacion.md) §9, para las dos historias de ticks de ADR-0021 §4. Son las [4.0.0](#semántica-ejecutable-de-las-reglas-de-los-lotes-400) con una regla más, y todas sus incidencias llevan el esquema 3.1.0. Solo las usan los perfiles de la historia de ticks: los de los horarios, las cotizaciones y las velas siguen con las 4.0.0, que no cambian, y también el de la historia de las velas del PR 6d, que pide lo mismo que las velas de cada día. Su normalizador es el mismo conjunto, el 4.1.0.

- **El perfil.** El de una historia lleva su símbolo (`symbol`), que es el que se busca en `trading_times`, y su umbral, `maximum_tick_gap_ms`, en segundos enteros y mayor que cero. Solo un perfil con las reglas 4.1.0 los lleva, y los lleva los dos.
- **Ticks que faltan.** Un segundo está pedido si una página de ticks de la historia respondida, válida o no (también con un error, como `RateLimit`), cuya petición es de las del paso de los lotes, lo pide, de su `start` a su `end`. Cuenta si ya había terminado al recibirse la página y si cae entero dentro de un intervalo del horario de su símbolo y su día, como en las velas que faltan. Los segundos pedidos seguidos, también de páginas distintas, forman un tramo comprobado. Dentro de él, cada tramo de segundos seguidos sin ningún tick que cuenta y que dura al menos el umbral da un `tick_gap`, con su primer y su último segundo, la observación de la última página que pidió su primer segundo en `observed_ref` y la de los horarios de sus segundos en `related_refs`. Así, entre dos ticks, la separación pasa del umbral, como `maximum_event_gap_ms` en la captura, y en cada borde de lo comprobado cuenta como si hubiera un tick en el segundo de fuera. Sin umbral para su símbolo, o sin horario de su día, un segundo no se comprueba. Un tramo así nunca se rellena. Como cada dataset se reproduce solo, un tramo que cruza el borde entre dos datasets se mide en cada uno hasta su borde: si los dos trozos quedan por debajo del umbral, ninguno lo registra, aunque juntos lo pasen. En R_100, un tick que falta siempre se registra, porque con un umbral de 2 s y un tick cada 2 s uno de los dos trozos llega al umbral.

### Validador del esquema de fuente

Desde F1.4b ([ADR-0012](adr/0012-catalogo-y-adaptador-publico-de-deriv.md) §2), el validador se elige por el `$schema` del documento de esquema de fuente:

- draft 2020-12: `Ajv2020`, como en los vectores;
- draft-04: `ajv` con `ajv-draft-04`, como en Deriv;
- cualquier otro: crear el perfil falla.

Los dos validan en modo estricto. En draft-04 solo se admiten como anotación, sin validar, las palabras clave `auth_required` y `examples` de la release fijada de Deriv. El `$schema` tiene que coincidir exactamente con `https://json-schema.org/draft/2020-12/schema` o con `http://json-schema.org/draft-04/schema#`, y un documento sin `$schema` también se rechaza. El replay obtiene el mismo validador del esquema que el dataset publica. Implementado en `packages/domain` (`compileSourceSchema`), que usan el perfil del pipeline y el esquema del catálogo.

### Perfil de medición

Desde F1.4b ([ADR-0012](adr/0012-catalogo-y-adaptador-publico-de-deriv.md) §8), el perfil de calidad admite `purpose: "measurement"`, opcional.

- Sin ese campo, el perfil es de publicación, como hasta ahora; los perfiles existentes conservan sus bytes y sus hashes.
- Un perfil de medición usa las reglas 2.0.0, declara `non_tick_msg_types` y no lleva `maximum_delivery_delay_ms` ni `maximum_event_gap_ms`. Los umbrales live se fijan después con lo que mida el smoke.
- La publicación lo rechaza, así que nunca publica. El ingestor, el normalizador y, desde F1.5, la derivación del estado vivo lo aceptan.
- Un perfil con `purpose: "measurement"` y algún umbral, o con `purpose` de otro valor, se rechaza.
- Implementado en `packages/domain`: `createPipelineProfile` expone `purpose`; `publicationThresholds` falla con un perfil de medición, y `buildDatasetPublication` la llama antes de leer nada.
- Desde F1.5 ([ADR-0015](adr/0015-reconexion-recuperacion-y-salud-f1-5.md) §2), `deriveMarketData` acepta un perfil de medición para derivar el estado vivo (salud, condiciones y continuidad). `derivationThresholds` da `null` como umbrales de un perfil de medición. Sin umbral de retraso no se evalúa `delivery_delayed`. Sin umbral de hueco, la separación tras una reconexión nunca demuestra continuidad (lo que en las reglas 1.0.0 decide `maximum_event_gap_ms`): el símbolo sigue pendiente hasta que lo decide un `HistoryRecoveryResult` que cubre su hueco. `pendingGaps` da cada hueco pendiente: `from_event_time_utc`, el high-watermark del inicio + 1 ms, y `to_event_time_utc`, el primer tick posterior al último cierre − 1 ms (nunca antes de `from_event_time_utc`), o `null` mientras ese tick no llegue. No hace falta otra `quality_rule_version` (ADR-0015 §2, «Versionado»).
- Desde el PR 3 de [ADR-0015](adr/0015-reconexion-recuperacion-y-salud-f1-5.md) §13, el perfil de Deriv es el v2 (`deriv_options-measurement-v2-<símbolo>`, conector `deriv-options-ws-1.1.0`): declara además `history`, la respuesta a `ticks_history`.

### Registro operativo de persistencia y límites

Implementado en F1.3b ([ADR-0005](adr/0005-persistencia-local-y-formato-fisico-f1-3.md), `apps/market-data-worker/src/operational`). Vive en tablas PostgreSQL append-only (`operational_incidents`, `operational_conditions`) separadas de los datasets y nunca entra en sus artifacts. Cada escritura se valida con `validateConditionCausality` antes de persistirse. Sus incidencias declaran reglas 1.0.0 y esquema de incidencias 1.0.0 sea cual sea el perfil de la fuente: las reglas de persistencia y límites son las mismas en ambos conjuntos y nunca llevan `invalid_source_frame`.

| Campo | `persistence_unavailable` | `source_limit_exceeded` |
|---|---|---|
| `severity` | `critical` | `error` si impone `paused` (`websocket_frame`, `in_memory_queue_*`); `critical` si impone `failed` (`schema_*`) |
| `observed_ref` | `observation_id` del frame afectado si ya se asignó; si no, un UUIDv7 nuevo del generador inyectado que identifica el intento | igual |
| `related_refs` | último source event durable, o `[]` si no existe | igual, salvo un límite de esquema (`schema_*`) de la sesión de ingesta del worker, que prepara los esquemas antes de tomar el bloqueo y abrir el log: esa incidencia lleva `[]` |
| `symbol` | `null` salvo atribución cierta | `null` salvo atribución cierta sin parsear contenido fuera del límite |
| `observed_at_utc` | reloj UTC inyectado al detectar | igual |

- La condición se abre en el mismo instante con `cause_refs = [incident_id]` y solo si su clave (`source + stage` o `source + resource`) no está abierta; una repetición registra incidencia sin reabrir.
- Se resuelve con el primer source event durable que demuestra la capacidad restaurada: para persistencia, el primer evento confirmado tras recuperar; para límites, el `ConnectionOpened` que reabre la entrada. `cause_refs = [apertura, ese evento]` y `resolution_reason` es `persistence_restored` o `input_reopened`.
- Si PostgreSQL no está disponible no se puede registrar: se emite una alerta estructurada y sanitizada en stderr, sin afirmar persistencia y sin inserción retroactiva posterior.
- El motivo (`evidence.reason`) es el código o nombre del error de almacenamiento, nunca su mensaje.
- Mientras quede una condición abierta, incluida una de una ejecución anterior, la entrada sigue cerrada hasta el `ConnectionOpened` que la resuelve.

Desde F1.4b ([ADR-0012](adr/0012-catalogo-y-adaptador-publico-de-deriv.md) §3 y §4), el transporte también registra aquí dos límites que actúan antes del `RawFirstIngestor`:

- el frame que el cliente WebSocket corta por superar 1 048 576 bytes. Su `observed_value` es la suma de las longitudes declaradas hasta el fragmento que supera el límite (en un mensaje sin fragmentar, su tamaño), y su `observed_ref`, un UUIDv7 nuevo, porque el frame nunca llega;
- la cola en memoria llena (`in_memory_queue_events` o `in_memory_queue_bytes`), con el `observation_id` del frame que no cupo.

En los dos casos el transporte pausa el ingestor y cierra la entrada con `ConnectionClosed` (`closure_type: transport_error`, con el recurso como motivo). No es un cierre pedido: se pierden datos, así que las reglas abren `connection_lost` y dejan pendiente la continuidad de los símbolos afectados.

#### Registro de la publicación en `buoh_datasets`

Desde el PR 3b de [ADR-0020](adr/0020-datasets-vivos.md) §13, la publicación de los datasets vivos tiene su propio registro, en las tablas `operational_incidents` y `operational_conditions` de `buoh_datasets` (ADR-0020 §9). Solo registra `persistence_unavailable`, con la etapa de la escritura que falló: `normalized_object_write`, `manifest_write` o `manifest_commit`, también cuando el `COMMIT` es ambiguo, con el motivo `commit_outcome_unknown`. La consulta previa es una lectura, y un conflicto (`publication_conflict`) no cambia al repetirlo: ninguno de los dos entra. Una publicación no produce source events, así que sus referencias son las de la publicación:

| Campo | `persistence_unavailable` de la publicación |
|---|---|
| `observed_ref` | el `publication_id` del intento que falló, el UUIDv7 que ya lo identifica |
| `related_refs` | el `publication_id` de la última publicación confirmada en el entorno, o `[]` si no hay ninguna |
| `symbol` | `null` |
| `observed_at_utc` | reloj UTC inyectado al detectar |

- La resuelve la primera publicación confirmada después de la apertura: `cause_refs = [apertura, su publication_id]`, a la hora de su `published_at_utc`, con `resolution_reason` `persistence_restored`. Una publicación confirmada resuelve solo las condiciones abiertas antes de su hora. Por eso un `commit_outcome_unknown` que la ejecución siguiente encuentra confirmado no resuelve nada: su hora es anterior a la apertura, y lo resuelve la publicación nueva siguiente.
- `validateConditionCausality` recibe, solo en este registro, las publicaciones confirmadas que citan sus condiciones (`confirmedPublications`, cada una con su `publication_id` y su `published_at_utc`). Con ellas, un `publication_id` es una referencia conocida, y cada resolución de `persistence_unavailable` tiene que citar una de ellas, a su misma hora y posterior a la apertura; si no, falla con `CONDITION_PUBLICATION_MISMATCH`. Los demás registros y la validación de los datasets no las pasan, así que en ellos un `publication_id` sigue siendo una referencia desconocida (`CONDITION_REFERENCE_UNKNOWN`).
- Si PostgreSQL no responde, solo quedan la alerta saneada y el informe del paso, como en el log.

### Incidencias de respuestas pedidas

Desde F1.4b ([ADR-0012](adr/0012-catalogo-y-adaptador-publico-de-deriv.md) §6). Las reglas 2.0.0 no comprueban las respuestas declaradas en `non_tick_msg_types`. Quien pidió una respuesta declarada la compara con el esquema de respuesta de su operación en la release fijada; la del catálogo, desde la precisión del 2026-11-25 de ADR-0012 §2, sin exigir `underlying_symbol_type` ([«SourceCatalogSnapshot»](#sourcecatalogsnapshot)). Si la respuesta trae `error`, no cumple ese esquema o, en el catálogo, no puede convertirse en snapshot, quien la pidió registra un `DataQualityIncident`:

| Campo | Valor |
|---|---|
| `incident_type` | `invalid_source_frame` |
| `schema_version` y `quality_rule_version` | `2.0.0` |
| `severity` | `error` |
| `observed_ref` y `observed_at_utc` | `observation_id` y `received_at_utc` del frame |
| `related_refs` | `[]` |
| `symbol` | `null`: ninguna respuesta declarada es de un símbolo. Es una diferencia deliberada con la atribución de las reglas 2.0.0, que acabaría en el único símbolo del perfil |
| `evidence` | `raw_payload_sha256` y el motivo: `source_error_response`, `schema_validation_failed`, uno de los del catálogo o, solo en las respuestas de historia, `history_inconsistent` |

Así, la incidencia se puede volver a derivar del frame durable. Vive en la tabla PostgreSQL append-only `requested_response_incidents`, fuera de los datasets y del registro operativo: no abre condiciones ni cambia la salud.

En `packages/domain`, `checkRequestedResponse` hace las dos comprobaciones comunes en orden (un objeto `error` y después el esquema de la operación), y `deriveRequestedResponseIncident` arma la incidencia de esta tabla. Desde el PR 6 de F1.4b, el worker la guarda con `PostgresRequestedResponseIncidentStore` (migración `0003`); la misma incidencia, con el mismo `incident_id`, no añade fila.

El perfil de Deriv no declara `ticks` ni `error`. Una suscripción fallida (`msg_type` `ticks`) y la respuesta a un método desconocido (`msg_type` `error`) llegan con un objeto `error`, y las reglas 2.0.0 ya las registran como `source_error_response`.

Desde el PR 3 de [ADR-0015](adr/0015-reconexion-recuperacion-y-salud-f1-5.md) §13 (§4), quien pide `ticks_history` comprueba igual su respuesta `history`, con `checkRequestedResponse`; `schema_validation_failed` es solo para la que no cumple el esquema de respuesta. Además, la página tiene que ser coherente: traer el objeto `history`, sus arrays `times` y `prices`, y `pip_size`, con `pip_size` de valor entero de 0 a 18, también escrito con una fracción de ceros (`2.0`, como lo manda el canal real en la historia; `pipSizeFromNumberLexeme`, en `packages/domain`), `times` y `prices` de la misma longitud, tiempos enteros estrictamente crecientes dentro del rango pedido y precios que acepta con ese `pip_size` la regla de `quote_decimal` (`canonicalQuoteDecimal`, en `packages/domain`); si no, el motivo es `history_inconsistent`, también cuando cumple el esquema pero le falta uno de esos miembros. Una petición de historia rechazada llega con `msg_type` `ticks_history` y un objeto `error`; el perfil v2 no lo declara, así que la registran las reglas 2.0.0 y no deja incidencia de respuesta pedida.

`history_inconsistent` (una página de historia incoherente) existe en `packages/domain` desde el PR 3 y es solo para las respuestas de historia. En PostgreSQL, `requested_response_incidents` lo admite desde la migración `0004`, del PR 5 de ADR-0015 §13; la `0003` no lo admitía.

## Mensajes de la API

Los mensajes de la API de buoh (`apps/api`, [ADR-0019](adr/0019-api-cuentas-y-auditoria.md) §6) están en `packages/contracts/src/api.ts`. Las rutas van bajo `/api/v1/`, y la versión de un mensaje es la de su ruta: estos mensajes no llevan `schema_version`, y un cambio incompatible crea `/api/v2/`. El primero fue el del catálogo, `GET /api/v2/datos/catalogo` (`DataCatalog`, más abajo; ADR-0019 §6, precisión del 2026-11-25). La API valida con ellos cada entrada y cada salida. Su descripción OpenAPI 3.1 sale de ellos y de la tabla de rutas de la API, en `apps/api/generated/openapi.json`, y no se edita a mano (`pnpm run openapi:generate`; `pnpm run openapi:check` lo comprueba). No tienen JSON Schema propio en `generated/`: lo lleva ese OpenAPI.

```text
ApiError {
  error:
    | { code: "invalid_request" | "not_found" | "internal" | "csrf_rejected"
              | "invalid_link" | "invalid_code" | "not_ready" | "postgres_unavailable"
              | "unauthenticated" | "invalid_credentials" | "credential_disabled"
              | "storage_unavailable",
        request_id: UUID }
    | { code: "rate_limited", request_id: UUID, retry_after_seconds: 1..3600 }
    | { code: "password_rejected", request_id: UUID,
        reason: "too_short" | "too_long" | "common_password" | "context_words" }
}

ApiHealth {
  status: "ok"
}

LinkSecretRequest { token: LinkToken }           # POST /api/v1/enlace/secreto
LinkSecret {
  purpose: "enrollment" | "reset",
  username: Username,
  expires_at_utc: UtcTimestampMs,                # el vencimiento del enlace
  totp: { secret: Base32 (32 caracteres), uri: "otpauth://totp/buoh:<username>?secret=<secret>&issuer=buoh&algorithm=SHA1&digits=6&period=30" }
}
LinkUseRequest { token: LinkToken, password: texto de 1 a 1024 caracteres (puntos de código), bien formado, code: 6 cifras }   # POST /api/v1/enlace
LinkUse { result: "account_enrolled" | "credential_reset" }

SessionLoginRequest { username: Username, password: igual que la del enlace, code: 6 cifras }   # POST /api/v1/sesion
SessionInfo { csrf_token: 64 hexadecimales }     # inicio de sesión (201) y GET /api/v1/sesion (200)
EmptyRequest { }                                 # cuerpo de DELETE /api/v1/sesion y DELETE /api/v1/sesiones
SessionsClosedResult { closed: 0..1000 }         # cuántas sesiones se cerraron
AuditEvents { events: AuditEvent[] }             # GET /api/v1/auditoria
AccountPreferences { theme: "night" | "day" }    # GET y POST /api/v1/preferencias (F2.4)
PreferencesRequest { theme: "night" | "day" }    # cuerpo de POST /api/v1/preferencias

DataHealth {                                     # GET /api/v1/datos/salud (F2.4)
  log: 1..999999 | null,                         # el log activo
  observation:
    | { status: "completed", observed_at_utc: UtcTimestampMs, report: HealthReport,
        alerts: { event: Código, reason: Código | null }[] }
    | { status: "failed", observed_at_utc: UtcTimestampMs, reason: Código, code: Código | null }
    | null                                       # sin observación; siempre null si log es null
}

DataChartQuery { hours: "1" .. "24" }            # GET /api/v1/datos/grafico?hours=<n> (F2.4)
DataChart {
  log: 1..999999 | null,                         # el log activo; sin él, sin ticks, huecos ni inicio
  source: texto, symbol: texto,                  # deriv_options y R_100
  from_utc: UtcTimestampMs, to_utc: UtcTimestampMs,   # horas enteras, de 1 a 24
  log_started_at_utc: UtcTimestampMs | null,     # el primer evento del log, o null si está vacío
  ticks: { offsets_ms: entero ≥ 0 [], quotes: DecimalString [] },   # un tick por instante, en orden
  gaps: {
    from_utc: UtcTimestampMs, to_utc: UtcTimestampMs | null,
    cause: "connection_lost" | "capture_stopped",
    history: "recovered" | "partial" | "unavailable" | "pending" | "not_requested",
    reason: Código | null, recovered_ticks: entero ≥ 0 | null
  }[]                                            # los que tocan la ventana, en orden de inicio
}
DataCatalog {                                    # GET /api/v2/datos/catalogo (F2.4)
  log: 1..999999 | null,
  catalog: { source: texto, version: entero ≥ 1, received_at_utc: UtcTimestampMs,
             source_schema_release: texto, content_sha256: Sha256Hex,
             entries: DerivActiveSymbolEntry [] } | null   # las de la 2.0.0; null si log es null
}
DataEvents {                                     # GET /api/v2/datos/eventos (F2.4; PR 5e de ADR-0021)
  sequences: {                                   # por su nombre, sin repetir
  sequence: SequenceName,
  logs: 1..999999 [],                            # los leídos, de mayor a menor, sin repetir
  events: (                                      # 200 como mucho, del más nuevo al más viejo
    | { kind: "catalog_version", log, at_utc, source, version: entero ≥ 1,
        snapshot_id: "sha256:" + Sha256Hex, content_sha256: Sha256Hex, entry_count: entero ≥ 1 }
    | { kind: "publication", log, at_utc, source, dataset_id: DatasetId,
        publication_id: UUIDv7, state: "active" | "superseded" }
    | { kind: "incident", log, at_utc, source, incident_id: "sha256:" + Sha256Hex,
        severity: Severity, symbol: texto | null,
        incident_type: "persistence_unavailable", evidence: { stage: PersistenceStage, reason: Código } }
    | { …, incident_type: "source_limit_exceeded",
        evidence: { resource, unit, observed_value: entero ≥ 0, maximum_value: entero ≥ 0 } }
    | { …, incident_type: "invalid_source_frame",
        evidence: { reason: Código, raw_payload_sha256: Sha256Hex } }
    | { kind: "condition", log, at_utc, source, condition_event_id: "sha256:" + Sha256Hex,
        condition_key: ConditionKey, condition_type: ConditionType, symbol: texto | null,
        action: "opened" | "resolved", resolution_reason: Código | null }
  )[],
  truncated: booleano                            # si quedaron fuera otros más viejos
  } []                                           # cada una con algún log o algún evento
}
DataDatasets {                                   # GET /api/v2/datos/datasets (F2.4, 6b; PR 5e de ADR-0021)
  sequences: {                                   # por su nombre, sin repetir
  sequence: SequenceName,
  datasets: {                                    # de 1 a 200, del más nuevo al más viejo
    dataset_id: DatasetId, publication_id: UUIDv7, published_at_utc: UtcTimestampMs,
    source: texto, symbols: texto [],            # al menos uno, en orden y sin repetir
    log: 1..999999, first_segment: entero ≥ 0, last_segment: entero ≥ first_segment,
    event_time_from_utc: UtcTimestampMs | null, event_time_to_utc: UtcTimestampMs | null,
    source_event_count, raw_frame_count, normalized_tick_count, incident_count,
    condition_event_count: entero ≥ 0,
    quality_rule_version: "x.y.z", quality_profile_id: texto,
    clean: booleano, pending_continuity_symbols: texto [], open_condition_types: ConditionType [],
    incidents: { incident_type: DataQualityIncidentType, severity: Severity, count: entero ≥ 1 } [],
    verifications: {
      verify_only: { status: "passed" | "failed" | "incomplete", verified_at_utc: UtcTimestampMs,
                     error_code: ReplayErrorCode | null } | null,
      recompute: … | null
    },
    batch: {                                     # null con un core 1.0.0, el de la captura en vivo
      candle_time_from_utc: UtcTimestampMs | null, candle_time_to_utc: UtcTimestampMs | null,
      market_candle_count, trading_session_count, contract_offer_count,
      contract_quote_count: entero ≥ 0
    } | null
  } [],
  truncated: booleano                            # si quedaron fuera otros más viejos
  } []                                           # cada dataset sale una vez
}
SequenceName = 1 a 64 caracteres de A-Z, a-z, 0-9 y "_"   # como dataset_log_ranges.sequence
Código = 1 a 64 caracteres de A-Z, a-z, 0-9, "_", "." y "-"

Username = 3 a 32 caracteres de a-z, 0-9, "-" y "_"
LinkToken = 32 bytes en base64url sin relleno: 43 caracteres, con una sola escritura
```

- `ApiError` es el cuerpo de toda respuesta de error. No admite un mensaje, una traza ni otros campos: un error interno nunca sale con su mensaje. `request_id` es el UUID que la API genera para cada petición; nunca el que envía el cliente.
- La lista de códigos es cerrada (`API_ERROR_CODES`), y cada PR de ADR-0019 §14 suma los que produce. Es una unión por el código: solo `rate_limited` lleva los segundos que faltan, y solo `password_rejected`, su motivo.
  - Del esqueleto (PR 2). `invalid_request`: la petición no cumple su contrato, por ejemplo con un parámetro de consulta que la ruta no admite, o el servidor HTTP la rechazó antes de llegar a una ruta. `not_found`: ninguna ruta atiende ese método y esa dirección. `internal`: un fallo del servidor, también una respuesta que no cumple su contrato.
  - De los enlaces (PR 4a). `csrf_rejected` (403): una petición que cambia algo sin el `Origin`, el `Sec-Fetch-Site` o el `Content-Type` de la propia web. `invalid_link` (400): el enlace no existe, venció, ya se usó o lo anuló otro. `invalid_code` (400): el código no corresponde al último secreto TOTP del enlace. `password_rejected` (422): la contraseña nueva no cumple la política de ADR-0019 §1. `rate_limited` (429): hay que esperar. `not_ready` (503): faltan las migraciones de la API y, en las rutas de datos (F2.4), también la credencial de lectura. `postgres_unavailable` (503): PostgreSQL no responde.
  - De las sesiones (PR 4b). `unauthenticated` (401): la petición necesita una sesión y no la trae o no vale. `invalid_credentials` (401): el nombre, la contraseña o el código no valen, sin decir cuál. `credential_disabled` (403): la credencial está deshabilitada por sus 100 fallos, y solo lo recibe quien acierta la contraseña y el código.
  - De las lecturas de R2 (F2.4). `storage_unavailable` (503): el almacenamiento de objetos de la captura no responde o rechaza la lectura. En las rutas que leen R2, `not_ready` también dice que falta el token `api`.
- `ApiHealth` es la respuesta de `GET /api/salud`, la ruta de salud de Render, cuando el proceso responde y tiene sus migraciones.
- `LinkSecret` es la respuesta de `POST /api/v1/enlace/secreto`: un secreto TOTP nuevo para el enlace, una sola vez, que anula el anterior del mismo enlace (ADR-0019 §3). Su URI repite exactamente el usuario y el secreto: el esquema runtime lo comprueba, el JSON Schema del OpenAPI no.
- `LinkUseRequest` es el cuerpo de `POST /api/v1/enlace`. La contraseña se rechaza en el contrato si no es texto Unicode bien formado, porque un sustituto suelto se convertiría en otro carácter al pasar a UTF-8; su política la decide después la API, con su motivo.
- `SessionLoginRequest` es el cuerpo de `POST /api/v1/sesion` (PR 4b). Si el nombre, la contraseña y el código valen, la respuesta es 201 con `SessionInfo` y la cookie `__Host-Http-buoh_sesion` (ADR-0019 §2). `SessionInfo`, el cuerpo del inicio de sesión y de `GET /api/v1/sesion`, lleva solo el token CSRF, que la web manda en `X-CSRF-Token` en cada petición que cambia algo; el identificador de la sesión no sale del `Set-Cookie`. Los cierres, `DELETE /api/v1/sesion` (la actual) y `DELETE /api/v1/sesiones` (las demás), llevan el cuerpo vacío `EmptyRequest` y responden `SessionsClosedResult`. `GET /api/v1/auditoria` responde `AuditEvents`, solo con las entradas de la cuenta de la sesión, de la más nueva a la más vieja.
- `AccountPreferences` es la respuesta de `GET /api/v1/preferencias` y de `POST /api/v1/preferencias` (F2.4, [ADR-0019](adr/0019-api-cuentas-y-auditoria.md) §7), con sesión: las preferencias de la cuenta de la sesión. En la Fase 2 solo el tema de la web, `night` o `day`, que la web pone como `data-theme="noche"` o `"dia"`; sin ninguno guardado, `night`. `PreferencesRequest`, el cuerpo de `POST`, lleva el tema que se guarda (`THEMES`).
- `DataHealth` es la respuesta de `GET /api/v1/datos/salud` (F2.4, [ADR-0019](adr/0019-api-cuentas-y-auditoria.md) §8), con sesión: la salud de los datos, la última observación que guardó `buoh-operaciones` en el log activo, con la hora en que la guardó (`observed_at_utc`), para que se vea su frescura. La API no ejecuta `data:health`. `log` es el número del log activo, o `null` si no hay ninguno, y entonces tampoco hay observación: el esquema runtime lo comprueba, el JSON Schema del OpenAPI no. `observation` es `null` si el log activo todavía no tiene ninguna, como justo después del corte semanal, y si la última falló, una anterior que terminó no la sustituye. `completed` lleva el `HealthReport`, con sus reglas, que puede no ser `healthy`, y las alertas que dejó `data:health` en stderr, con su evento y su motivo saneados, como las guarda `buoh-operaciones`: son la causa de un `paused` o un `failed` cuando no pudo observar el log, como `data_health_storage_unavailable`. `failed` lleva el motivo saneado por el que no se pudo observar, como `child_timeout`, `health_command_failed` o un SQLSTATE, y `code`, con `health_command_failed`, el código de la línea de error de `data:health`, como `ConfigError`, o `null`. Nunca un mensaje.
- `DataChart` es la respuesta de `GET /api/v1/datos/grafico` (F2.4, [ADR-0019](adr/0019-api-cuentas-y-auditoria.md) §8), con sesión: el gráfico de R_100 en las últimas `hours` horas del log activo, de `from_utc` a `to_utc`, la hora de la lectura. `DataChartQuery` admite solo `hours`, de 1 a 24 escrito sin ceros delante, la ventana máxima (`DATA_CHART_MAX_HOURS`). Cada tick es su distancia en milisegundos a `from_utc` (`offsets_ms`) y su cotización en decimal canónico (`quotes`), en la misma posición: uno por instante, en orden, dentro de la ventana. Si llegó más de uno en el mismo instante, cuenta el de menor `tick_fingerprint_sha256`. `log_started_at_utc` es la hora del primer evento del log: antes, la ventana no tiene datos de ese log, como justo después del corte semanal. Un hueco es un período sin ticks que el log registra, nunca la distancia entre dos ticks, del high-watermark + 1 ms al primer tick posterior − 1 ms, o sin fin (`to_utc` `null`) mientras no llega ninguno. `connection_lost` sigue a un cierre no pedido, y `history` dice qué trajo la historia: `recovered`, con los ticks que faltaban en `recovered_ticks`, que el gráfico no dibuja; `partial` o `unavailable`, sin resolver, con el motivo de su `event_gap_unresolved` en `reason`, y `partial` con los ticks que trajo; o `pending`, sin resultado todavía. `capture_stopped` sigue a un cierre pedido, como el de un despliegue, y su `history` es `not_requested`, porque no se recupera. Van los que tocan la ventana, aunque empiecen antes, en orden de inicio. Las reglas entre campos (las horas enteras de la ventana, los ticks en orden y dentro de ella, lo que lleva cada clase de hueco y que sin log no hay datos) las comprueba el esquema runtime; el JSON Schema del OpenAPI, no.
- `DataCatalog` es la respuesta de `GET /api/v2/datos/catalogo` (F2.4, ADR-0019 §8), con sesión: la última versión del catálogo de Deriv en el log activo (ADR-0012 §7), con su número, la hora en que llegó, la release de esquemas con que se derivó, su `content_sha256` y sus entradas, las `DerivActiveSymbolEntry` de `SourceCatalogSnapshot` 2.0.0, en orden de símbolo y con los nombres y valores oficiales. De una versión 1.0.0 guardada, la API da sus entradas sin `underlying_symbol_type`, y su `content_sha256`, el de la versión guardada. Antes de esa precisión era `GET /api/v1/datos/catalogo`, con el campo: quitarlo es un cambio incompatible, que lleva el mensaje a `/api/v2/`, y la ruta de `/api/v1/` ya no existe. El número cuenta desde 1 en cada log. `catalog` es `null` si el log activo todavía no tiene ninguna versión, sin mirar la del log anterior, y siempre que `log` es `null`.
- `DataDatasets` es la respuesta de `GET /api/v2/datos/datasets` (F2.4, segunda parte del 6b; [ADR-0020](adr/0020-datasets-vivos.md) §10), con sesión: los datasets publicados del entorno de la API en `buoh_datasets`, para la sección Datos, cada uno por su publicación activa, agrupados por la secuencia de su log (`dataset_log_ranges.sequence`; [ADR-0021](adr/0021-mercados-reales-y-fuentes-de-investigacion.md) §5), para que los de los lotes no tapen los de la captura en vivo. Las secuencias van por su nombre, en el orden de las unidades UTF-16, solo las que tienen algún dataset, y cada dataset sale una vez. De cada secuencia, los `DATA_DATASETS_LIMIT` (200) más recientes, del más nuevo al más viejo, y `truncated` dice si quedaron fuera otros más viejos. Desde el PR 5e de ADR-0021 sustituye a `GET /api/v1/datos/datasets`, que no nombraba la secuencia: es un cambio incompatible, y la ruta de `/api/v1/` ya no existe (ADR-0019 §6). De cada uno, su identificador y su publicación; su fuente, sus símbolos, su período y sus conteos, los de su `DatasetManifestCore`, con sus reglas y su perfil; su log y sus segmentos, y cómo terminó, de `dataset_log_ranges` (`clean`: sin continuidad pendiente ni `connection_lost` abierta); sus incidencias por tipo y gravedad, que suman `incident_count`; y la última verificación de cada modo de esa publicación (`verify_only` y `recompute`, ADR-0020 §8), o `null`. Una verificación `passed` no lleva código, una `failed` lo lleva, y una `incomplete` lleva el de su última ejecución, si lo tiene. El período es `null` exactamente cuando no hay ticks. Las incidencias admiten todos los tipos de `DataQualityIncident` (`DataQualityIncidentType`), también `contract_rejected`, `candle_repeated` y `candle_missing`, que solo dan los esquemas 3.0.0 y 3.1.0 de los lotes, y `tick_gap`, que solo da el 3.1.0; `QualityIncidentType` no cambia, porque es también el de las `quality_flags` de `MarketTick` y `MarketCandle`. `batch` lleva lo que solo tiene un `DatasetManifestCore` 1.1.0, el de un dataset de los lotes: el período de sus velas, `null` exactamente cuando no hay velas, y cuántas velas, horarios, ofertas de contratos y cotizaciones tiene; con un core 1.0.0 es `null`. Las reglas entre campos las comprueba el esquema runtime; el JSON Schema del OpenAPI, no. Los datasets no vencen (ADR-0020 §6).
- `DataEvents` es la respuesta de `GET /api/v2/datos/eventos` (F2.4, ADR-0019 §5 y §8), con sesión: los eventos de datos que guardan los logs que no han vencido y, desde el 6b de F2.4, las publicaciones de `buoh_datasets`, para la sección Auditoría, agrupados por la secuencia de su log (ADR-0021 §5). Las secuencias van por su nombre, en el orden de las unidades UTF-16, y solo está la que tiene algún log leído o algún evento. Los logs que se leen son los de R_100 (ADR-0019 §8), así que en las demás `logs` está vacía y sus eventos son las publicaciones de sus datasets. Desde el PR 5e de ADR-0021 sustituye a `GET /api/v1/datos/eventos`, que no nombraba la secuencia: es un cambio incompatible, y la ruta de `/api/v1/` ya no existe (ADR-0019 §6). Lo que sigue vale para cada secuencia. Son las versiones del catálogo, las publicaciones del entorno de la API, las incidencias del registro operativo (`persistence_unavailable` y `source_limit_exceeded`) y de las respuestas pedidas (`invalid_source_frame`), y las aperturas y resoluciones de las condiciones del registro operativo. Cada uno lleva el log donde está (una publicación, el de su dataset), su hora (`at_utc`: la de llegada del catálogo, la de la publicación, la de observación de la incidencia o la de la condición) y su fuente; cada incidencia, la evidencia de su `DataQualityIncident`, y cada condición, los campos de su `OperationalConditionEvent` salvo `cause_refs`. Son los `DATA_EVENTS_LIMIT` (200) más recientes como mucho, del más nuevo al más viejo, y `truncated` dice si quedaron fuera otros más viejos, así que solo puede ser `true` con la lista llena. `logs` son los logs leídos, de mayor a menor: cada evento que no es una publicación es de uno de ellos. Desde el 6b de F2.4, las publicaciones salen de `buoh_datasets` ([ADR-0020](adr/0020-datasets-vivos.md) §10), con el log de su dataset (`dataset_log_ranges`), que puede ser uno que ya no se lee. Una resolución lleva su motivo, una apertura no, y la clave de una condición empieza por su tipo. Los motivos son códigos saneados, nunca un mensaje. Las reglas entre campos las comprueba el esquema runtime; el JSON Schema del OpenAPI, no. Los eventos siguen en su log y se borran con él a los 30 días de su última escritura (ADR-0018 §7), salvo las publicaciones, que no vencen (ADR-0020 §6).

## `AuditEvent`

Decidido en [ADR-0019](adr/0019-api-cuentas-y-auditoria.md) §5 (F2.3). Desde el PR 3 de su §14 está en `packages/contracts/src/audit.ts`, con su JSON Schema generado (`audit-event`), y cada entrada se guarda en JCS en `buoh_api.audit_events`, que nadie modifica ni borra. Es una entrada de la auditoría: quién hizo qué, cuándo, por qué y sobre qué objetos. A diferencia de los mensajes de la API, es un documento guardado y lleva `schema_version`: cada incremento que suma acciones sube el minor (plan de Fase 2, §9), y una versión sin lector se rechaza.

```text
AuditEvent =
  schema_version: "1.0.0"
  audit_event_id: UuidV7
  occurred_at_utc: UtcTimestampMs
  account_id: UuidV7 | null              # la cuenta de la entrada; null solo en login_failures
  actor: "account" | "operator" | "system" | "anonymous"
  action: AuditAction                    # el discriminante: cada acción fija sus autores y motivos
  reason: …                              # un código, de la lista de su acción
  objects: AuditObject[]                 # en orden por kind y después por id, sin repetir
  request_id: UUID | null                # el de ApiError; null con la orden cuenta y en los agrupados
  failure_count: integer >= 1            # solo en login_failures
  window_started_at_utc: UtcTimestampMs  # solo en login_failures

AuditObject = { kind: "account" | "credential" | "link" | "session", id: UuidV7 }
```

| Acción | Autor | Motivos |
|---|---|---|
| `link_created` | `operator` | `enrollment`, `reset` |
| `link_used` | `anonymous` | `enrollment`, `reset` |
| `account_enrolled` | `anonymous` | `enrollment_link` |
| `credential_reset` | `anonymous` | `reset_link` |
| `credential_disabled` | `system` | `failure_limit` |
| `session_started` | `account` | `password_and_totp` |
| `login_failed` | `anonymous` | `invalid_credentials` |
| `login_failures` | `anonymous` | `unknown_username`, `disabled_credential`, `rate_limited` |
| `session_closed` | `account` con `logout`; `system` con `session_limit` | `logout`, `session_limit` |
| `sessions_closed` | `account` con `other_sessions`; `operator` con `operator_command`; `system` con `credential_reset` | `other_sessions`, `operator_command`, `credential_reset` |

- **Autor:** la cuenta de la sesión (`account`), la orden `cuenta` desde la consola de Render (`operator`), la propia API (`system`) o quien todavía no tiene sesión (`anonymous`). Con `account`, `account_id` es esa cuenta.
- **Cuenta:** `account_id` es la cuenta de la entrada, la que la ve por la API (ADR-0019 §4). Solo `login_failures` puede ir sin cuenta: los intentos con un nombre que no existe (`unknown_username`) nunca tienen cuenta, y los que llegan a una credencial deshabilitada siempre la tienen.
- **Objetos:** al menos uno, salvo en `login_failures`, cada uno con su identificador UUIDv7: un token, un hash con clave o un nombre nunca son un objeto. Una entrada sin cuenta, que ninguna cuenta ve, no nombra ninguno, y una cuenta entre los objetos es siempre la de `account_id`, así que ninguna entrada de una cuenta nombra otra.
- **Agrupados:** `login_failures` cuenta los intentos fallidos de una ventana de 5 minutos, por clase y por cuenta (ADR-0019 §5): `failure_count` es su número y `window_started_at_utc` el principio de la ventana, que no es posterior a la entrada. `login_failed`, en cambio, es un solo intento fallido con una cuenta que existe.
- **Sin datos de la petición:** el contrato no tiene ningún campo para un secreto, una dirección IP, el navegador ni el nombre escrito en un intento fallido, y como objeto estricto rechaza cualquier campo de más.
- **Validación runtime:** el JSON Schema describe la forma de cada acción. Solo `auditEventSchema` comprueba el orden de los objetos, que haya al menos uno salvo en `login_failures` y ninguno en una entrada sin cuenta, la cuenta de los objetos, la pareja de autor y motivo de los cierres, la petición de `sessions_closed` y las reglas de `login_failures`.
- **Persistencia:** la fila guarda el documento en JCS (`event_jcs`) con su identificador, su cuenta, su hora y su acción en columnas, y la base comprueba que esas columnas son iguales a los campos del documento (migración `0001_auditoria.sql` de `apps/api`).

## StrategyDefinition

Una estrategia como documento declarativo, sin código ([ADR-0022](adr/0022-modelo-de-estrategia.md) §1 a §7 y §9), en `packages/contracts/src/strategy-definition.ts` desde el PR 2 de su §13.

```text
strategy_schema_version: "1.0.0"            # la gramática
indicator_library_version: "1.0.0"          # la biblioteca de §3
strategy_id: string                         # la familia: [a-z0-9][a-z0-9_-]{2,63}, 3 a 64 caracteres
semantic_version: SchemaVersion           # cada número, de como mucho 9 cifras
responsible: UuidV7                         # el account_id de la cuenta responsable (ADR-0019 §4)
origin: { kind: "research_engine", search_id: "sha256:<Sha256Hex>", candidate_number: NonNegativeInteger }
description: string                         # 1..1000; ver «Texto libre»
market: { source: "deriv_options", symbol, data: "ticks" | "deriv_candles",
          quality_profile_id: string, quality_profile_sha256: Sha256Hex,
          timeframe: "tick" | "5s" | "15s" | "1m" | "5m" | "15m" | "60m" }
indicators: Indicator[]                     # 1..6
side: "up" | "down"
entry: { groups: Condition[][],             # 1..2 grupos de 1..3 condiciones
         hours_utc: entero[] | null,        # 0..23, en orden, de 1 a 23 horas
         weekdays_utc: entero[] | null }    # 0 (lunes)..6, en orden, de 1 a 6 días
exit: { conditions: Condition[] } | null    # 1..3; solo multiplicadores
contract: MultiplierContract | CallPutContract
position: { currency: "USD", initial_capital: "1000", stake: "10", max_drawdown_percent: Amount }   # un porcentaje
signals: { signal_expiry_ms: 1000..60000, min_seconds_between_entries: 0..86400,
           max_entries_per_day: 1..500 }    # el día es el UTC
data_policy: { max_data_age_ms: 1000..60000 }
execution_mode: "disabled" | "shadow"
promoted_from: { version_id: "sha256:<Sha256Hex>", evaluation_id: UuidV7 } | null
```

```text
Indicator: { indicator: "price" | "hour_utc" | "weekday_utc" }
         | { indicator: "return", n: 1..500 }
         | { indicator: "sma" | "ema" | "volatility" | "highest" | "lowest" | "zscore", n: 2..500 }
         | { indicator: "rsi" | "atr", n: 2..100 }
         | { indicator: "bollinger_pct", n: 2..500, k: "1" | "1.5" | "2" | "2.5" | "3" }
Condition: { left: índice de indicators,
             operator: "gt" | "gte" | "lt" | "lte" | "crosses_above" | "crosses_below",
             right: { kind: "indicator", index } | { kind: "constant", value: decimal } }
MultiplierContract: { contract_type: "MULTUP" | "MULTDOWN", multiplier: entero,
                      stop_loss: Amount | null, take_profit: Amount | null,
                      max_duration_ms: 1000..86400000 }
CallPutContract: { contract_type: "CALL" | "PUT", duration: { duration, duration_unit: "t" | "s" | "m" } }
```

- **Mercados.** Con `ticks`, R_100 y el oro (`frxXAUUSD`), los que se capturan en vivo; con `deriv_candles`, los siete de las velas de los lotes, desde 1 minuto. Solo una estrategia de `ticks` puede estar en `shadow` (ADR-0022 §2). Los multiplicadores y las duraciones de sube/baja son los de las cotizaciones de los lotes en cada mercado (ADR-0021 §3; `STRATEGY_MARKETS`, la misma lista que `quoteMarkets` en el worker), así que una duración se escribe como en ellas: 60 minutos es `{60, "m"}`, no `{1, "h"}`. Bitcoin y Ethereum no tienen sube/baja.
- **Indicadores y reglas.** Una condición nombra sus indicadores por su índice en `indicators`. Cada instancia se usa en alguna condición. Los dos lados de una condición tienen la misma unidad (§3); un nivel de precio (`price`, `sma`, `ema`, `highest` y `lowest`) no se compara con una constante, y las constantes de `rsi`, `hour_utc` y `weekday_utc` caben en su rango.
- **Una sola escritura.** Para que una misma regla no dé varias versiones por cómo se escribe, los indicadores, las condiciones de cada grupo y de `exit`, y los grupos van en orden ascendente de su JCS, en unidades UTF-16, sin repetirse (`duplicate_indicator` y `not_canonical`); una condición entre dos indicadores pone a la izquierda el que va antes en la lista, con el operador contrario si hace falta (`a gt b` se escribe así y no `b lt a`; `crosses_above` y `crosses_below` también se invierten, porque `crosses_below` es el espejo de `crosses_above`: antes `izquierda ≥ derecha` y ahora `izquierda < derecha`), y nunca compara uno consigo mismo. Un indicador igual al anterior da `duplicate_indicator`, y una repetición más lejos, que ya rompe el orden, `not_canonical`; y las constantes y los importes son `DecimalString` sin ceros finales en los decimales ni `-0`, las constantes de como mucho 40 caracteres. `Amount` es un decimal de 0,01 a 999 999,99, con como mucho dos decimales: un importe en USD, o un porcentaje en `max_drawdown_percent`. Las demás equivalencias, como dos constantes que dan el mismo binario64, no se detectan. Las comparaciones de los rangos son exactas, en decimal.
- **Texto libre.** `description` no admite caracteres de control, salvo el salto de línea. Tampoco admite los de dirección del texto (`Bidi_Control` de Unicode: U+061C, U+200E, U+200F, U+202A a U+202E y U+2066 a U+2069), que cambian cómo se ve en la web, ni sustitutos UTF-16 sueltos, que el JCS no admite (RFC 8785).
- **Contrato y posición.** `side` y el tipo de contrato van en la misma dirección (`MULTUP` y `CALL` suben). La apuesta es fija, 10 USD de un capital de 1000 USD (§5). El stop loss es menor que la apuesta, que se pierde entera antes; la caída máxima es como mucho el 50 %. En sube/baja, `exit` es `null`, y la señal vence antes que el contrato: con 5 ticks, como mucho 5000 ms, y con una duración de tiempo, antes de que se cumpla (§6).
- **Modo y promoción.** `execution_mode` es `disabled` o `shadow`: el modo más alto de la Fase 2. Solo una versión en `shadow` lleva `promoted_from`, con la versión congelada y su evaluación (§10), y siempre lo lleva. La forma de `origin`, el hash JCS de la `ResearchSearchSpec` y el número de la candidata (ADR-0023 §6), la de `evaluation_id` y el tope de 64 caracteres de `strategy_id`, que la congelación deriva de la búsqueda y del número (ADR-0023 §6) y tiene que caber, son supuestos del PR 2 de ADR-0022 que los contratos de la investigación y de la evaluación confirman o cambian con otra versión.
- **Identidad.** El identificador de una versión es `sha256:` más el SHA-256 del JCS de la definición entera (`deriveStrategyVersionId`): cambiar cualquier campo, también la descripción, da otra versión (§9).
- **Errores.** `validateStrategyDefinition` devuelve la definición y su identificador, o la lista de sus errores, cada uno con un código de `STRATEGY_DEFINITION_ERROR_CODES`, la ruta del campo y un mensaje, en orden por su ruta, componente a componente (los índices por su número y antes que los nombres, los nombres en unidades UTF-16, y una ruta antes que las que la continúan), y después por el código. Una versión de la gramática o de la biblioteca que no conoce da solo `version_unsupported`. Una regla rota dos veces en el mismo sitio da un solo error, y una referencia fuera de la lista no da además el de los lados de la condición. Las reglas entre campos solo se comprueban con la forma correcta. Los mensajes no son contrato: los vectores fijan el código y la ruta.
- **Validación runtime:** el JSON Schema, que usa el motor de investigación (ADR-0023 §13), describe la forma. Solo el runtime comprueba lo que relaciona campos: el mercado y sus datos, la temporalidad, los multiplicadores y las duraciones, la dirección, que el sube/baja exista en el mercado y no tenga salida, las referencias, el orden y las unidades de las condiciones, los indicadores en orden y usados, el rango de las constantes, las ventanas en orden, el stop loss y la caída máxima, el vencimiento de la señal y la promoción. Los patrones usan `[0-9]` y no `\d`. Un validador de JSON Schema en Python, como `jsonschema`, los aplica con `re.search`, en el que `$` admite un salto de línea final: el runtime, que la API vuelve a aplicar, rechaza ese texto.
- **Vectores.** [`test-vectors/strategy-definition/v1`](../../test-vectors/strategy-definition/v1/) tiene definiciones válidas con su identificador, calculado fuera de `packages/contracts`, e inválidas con sus errores, escritos desde ADR-0022, y cubre cada código.

## Contratos futuros

`SignalEvent`, `RiskPolicy`, `ExecutionIntent` y `ExecutionEvent` se definirán en sus fases. [ADR-0023](adr/0023-motor-de-investigacion.md) fija los de la investigación (`ResearchSearchSpec`, `ResearchSearchSummary`, `ResearchCandidateList`, `ResearchCandidateFreeze`, `ResearchEngineStatus` y `ResearchWeeklyReport`), que llegan con el PR 3 de su §14, salvo `ResearchCandidateFreeze`, que llega con F2.8. [ADR-0024](adr/0024-semantica-del-backtest.md) fija los del backtest (`DataViewEvent`, el evento de la vista de cada instante, y `BacktestSpec`, `BacktestResult`, `BacktestDecision` y `BacktestPosition`), que llegan con el PR 3 de su §12. [ADR-0025](adr/0025-protocolo-estadistico.md) fija los de la evaluación (`StrategyPreRegistration`, `ResearchFamilyStats` y `EvidenceReport`), con los campos de `ResearchCandidateFreeze`, que llegan con el PR 3 de su §15, y suma `validation_finalists` por serie a `ResearchSearchSpec`, y los estadísticos suficientes por serie y la PBO a `ResearchSearchSummary`, que llegan antes, en su versión 1.0.0, con el PR 3 de ADR-0023. [ADR-0026](adr/0026-motor-de-senales-shadow.md) fija los del motor `shadow` (`ShadowInput`, `ShadowDecision`, `SignalEvent` y `ShadowEngineStatus`), que llegan con el PR 2 de su §13, y `ShadowPosition`, que llega con su PR 7. Sus conceptos no autorizan crear tablas, APIs o servicios en Fase 1.

## Versionado y compatibilidad

- Cambio aditivo compatible incrementa minor; cambio de semántica, tipo, requiredness, orden o canonicalización incrementa major.
- Contratos internos son estrictos y productores/consumidores se actualizan coordinadamente.
- Payload externo se preserva completo como raw; el adaptador extrae campos validados y tolera extras solo si el esquema fijado lo permite.
- Toda versión mayor conserva lector/replay mientras exista un dataset que la referencie, o documenta migración explícita sin sobrescribir originales. Así conviven hoy las incidencias 1.0.0, 2.0.0, 3.0.0 y 3.1.0. La 3.0.0 es la de las reglas de los lotes 4.0.0, que todavía no producía nada en producción cuando el PR 4d le sumó `candle_repeated` y el 5d1 `candle_missing` sin otra versión, como a esas reglas su normalizador y el tamaño de sus partes. Desde el 5f, la parte del PR 5 que la publica en producción, cada cambio sube su versión: por eso el `tick_gap` del PR 6b llega con la 3.1.0 y las reglas de los lotes 4.1.0, que solo usan las historias, y las 4.0.0 no cambian. Conviven también los conjuntos de reglas 1.0.0, 2.0.0 y 3.0.0, los de los lotes 4.0.0 y 4.1.0, y los snapshots de catálogo 1.0.0 y 2.0.0. `MarketTick` 1.1.0, una versión menor, solo suma el origen `history_download`, y la 1.0.0 sigue siendo la de la captura. Lo mismo `DatasetManifestCore` 1.1.0, que suma los registros de los lotes, con la 1.0.0 en la captura.
- TypeScript y futuro Python comparten JSON Schema generado y vectores.

## Oráculo inicial

[`test-vectors/market-data/v1`](../../test-vectors/market-data/v1/) es normativo para serialización lógica, hashes, calidad, salud y fallo de persistencia. Sus datos son sintéticos. Las reglas 3.0.0 tienen su propio vector sintético, con las expectativas escritas a mano y el `dataset_id` fijado, en [`packages/domain/test/rules-3-0-0.test.ts`](../../packages/domain/test/rules-3-0-0.test.ts), que corre con `pnpm run test:vectors` bajo las mismas guardas de reloj, azar y red, como los de las reglas de los lotes 4.0.0 y 4.1.0, en [`packages/domain/test/batch-rules.test.ts`](../../packages/domain/test/batch-rules.test.ts) y [`batch-series.test.ts`](../../packages/domain/test/batch-series.test.ts), y el de la publicación de sus datasets, en [`batch-publication.test.ts`](../../packages/domain/test/batch-publication.test.ts). Los de `StrategyDefinition`, en [`test-vectors/strategy-definition/v1`](../../test-vectors/strategy-definition/v1/), los comprueba `packages/contracts/test/strategy-definition.test.ts`, con su manifiesto, también con `pnpm run test:vectors`, y los de la biblioteca de indicadores 1.0.0, en [`test-vectors/strategy-indicators/v1`](../../test-vectors/strategy-indicators/v1/), los comprueba `packages/strategy-sdk/test/indicators.test.ts`, también con su manifiesto y con `pnpm run test:vectors`. El verificador limita cada archivo a 8 MiB y cada manifiesto a 64 MiB declarados, rechaza paths absolutos, traversal y symlinks, y valida expectativas/perfiles además de checksums.
