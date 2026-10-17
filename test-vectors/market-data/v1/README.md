# Vectores de datos de mercado v1

Oráculo sintético, offline y neutral al lenguaje para Fase 1. No contiene datos de Deriv ni información real de mercado.

## Perfil

- Fuente: `synthetic`
- Conector: `fixture-v1`
- Esquema de fuente: `synthetic-v1`
- Normalizador: `1.0.0`
- Reglas de calidad: `1.0.0`
- Perfil de calidad: `synthetic-v1`
- Retraso máximo: 2000 ms
- Separación máxima tras reconexión: 2000 ms
- Reloj e IDs: inyectados
- Hash estructurado: SHA-256 sobre RFC 8785

Los umbrales existen solo para este perfil sintético y no se transfieren a símbolos reales.

## Escenario principal

- `input-frames.ndjson`: estímulos del driver; **no** es el log persistido.
- `expected-source-events-000000.ndjson` y `000001`: dos segmentos persistidos, en orden de observación.
- `expected-ticks.ndjson`: ticks del dataset en orden canónico (`event_time_utc`, fingerprint, `observation_id`).
- `expected-incidents.ndjson`: observaciones de calidad en orden canónico.
- `expected-conditions.ndjson`: apertura/resolución append-only de condiciones operativas.
- `expected-dataset.json`: representación legible del documento de publicación.
- `expected-dataset.canonical.json`: bytes JCS exactos almacenables del documento.
- `expected-publication-record.json`: identidad física y estado de la publicación.
- `expected-health.json`: salud final derivada de condiciones abiertas.

Los dos segmentos de source events obligan a unir `LogicalArtifactRef` y `StorageObjectRef` mediante `artifact_id`; posición o hash repetido no son claves de unión válidas.

## Escenarios adicionales

- `input-persistence-failure.ndjson`: arma el fallo de la siguiente escritura raw antes de entregar el frame.
- `expected-persistence-failure.json`: resultado fail-closed esperado.
- `zero-valid-ticks/`: dataset publicable con un raw inválido, cero ticks, artefactos vacíos de cero bytes y tiempos de evento nulos.

## Artefactos compartidos

- `source-schema.json`: esquema ejecutable del proveedor sintético.
- `quality-profile.json`: umbrales y política sintética firmada.
- `manifest.json`: configuración y hashes de los artefactos; el subvector vacío tiene manifiesto propio.

## Reglas de bytes e identidad

Todos los NDJSON no vacíos terminan con newline y cada línea está en forma JSON canónica para los tipos usados. Una secuencia vacía tiene **cero bytes**, sin newline, y SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

- `logical_content_sha256`: hash de la representación lógica canónica.
- `object_bytes_sha256`: hash de bytes realmente almacenados.
- `dataset_id`: hash del `DatasetManifestCore`; no identifica una ubicación.
- `publication_id`: identifica una publicación física del dataset.
- `manifest_document_sha256`: autentica el documento completo con URIs, writer y fecha.
- `incident_id` y `condition_event_id`: SHA-256 de JCS del evento sin su propio ID; se recomputan sin aleatoriedad.

El consumidor verifica los hashes antes de ejecutar el vector.

## Estímulos y resultados

`segment_rotation_requested` fuerza una rotación del harness después del evento fuente anterior, no se persiste y permite probar múltiples segmentos sin reducir los límites de producción.

`source_frame` entrega texto UTF-8 al adaptador, que produce un `raw_source_frame` completo antes de normalizar. Los eventos de conexión/recuperación incluyen naturaleza del cierre y símbolo afectado para que el replay no dependa de contexto externo.

`persistence_fault_armed` afecta exactamente la siguiente operación indicada por `scope` y se consume una vez. En el escenario incluido, falla la escritura raw: no hay evento durable, tick emitido ni dataset publicado.

Ninguna prueba puede leer el reloj del sistema, contactar la red o generar IDs fuera de la secuencia inyectada.

## Replay esperado

1. **Verificación:** validar publicación, hashes físicos, contratos, hashes lógicos y conteos sin recalcular derivados.
2. **Recomputación:** usar source events + esquema + perfil + versiones para regenerar ticks, incidencias derivables y condiciones; comparar hashes lógicos y `dataset_id`.

El escenario de persistencia fallida prueba la ruta operativa no publicable y no forma parte de replay de dataset.
