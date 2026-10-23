# ADR-0004: Pipeline y reproducción de datos de Fase 1

- **Estado:** Aceptada; §6–§9 complementadas por [ADR-0005](0005-persistencia-local-y-formato-fisico-f1-3.md) (servicios locales, formato físico transitorio y log raw-first de F1.3)
- **Fecha:** 2026-10-17
- **Ámbito:** Fase 1
- **Decisores:** Dirección técnica de buoh

## Contexto

Fase 1 necesita una única interpretación de evento fuente, tick, incidencia, dataset y replay. Las decisiones anteriores dejaban alternativas abiertas para decimales, IDs, hashes, precisión temporal, formatos y servicios. Dos agentes podían producir implementaciones incompatibles y aun cumplir el texto anterior.

## Decisiones

### 1. Corte de componentes

Fase 1 contiene únicamente toolchain raíz, `apps/market-data-worker`, `packages/contracts`, `packages/domain`, PostgreSQL estándar, almacenamiento S3-compatible local y vectores sintéticos.

TimescaleDB, Redis, API pública de buoh, interfaces web/móvil, Python, señales y ejecución quedan diferidos. Se incorporan solo mediante evidencia y decisión posterior; no se crean como placeholders.

### 2. Fuente Deriv fijada

Hechos verificados el 2026-10-17:

- Endpoint público: `wss://api.derivws.com/trading/v1/options/ws/public`.
- El canal público permite datos de mercado sin autenticación ni OTP y no permite acciones de cuenta.
- `active_symbols`, `ticks` y `ticks_history` son operaciones de datos sin autenticación.
- Deriv recomienda ping cada 30–60 segundos; buoh usa 45 segundos por defecto con reloj inyectable.
- El tiempo de servidor se expresa como epoch Unix en segundos.
- Release de esquemas fijada: `production_v20260901_0`, archivo `schemas.zip`, SHA-256 físico `adaab0acaf33bd159e45912995af2b78101049f43683d223f0ac11be0a39e7c3`.

El conector rechaza una descarga de esquema cuyo hash no coincida. Actualizar la release requiere PR, pruebas del adaptador y registro del cambio; nunca se sigue `latest` en runtime.

### 3. Pipeline y log persistido

```text
Estímulo de transporte
  → SourceEvent append-only
       ├── RawSourceFrame (texto WebSocket exacto)
       └── evento de conexión/recuperación
  → validación de esquema de fuente
  → MarketTick normalizado
  → evaluación de reglas de calidad
  → DataQualityIncident append-only
  → artefactos lógicos cerrados
  → objetos físicos verificados
  → DatasetManifest publicado
```

El driver de prueba no forma parte del dataset. `input-frames.ndjson` contiene estímulos; `expected-source-events-*.ndjson` representa los segmentos que se persisten y firman.

`RawSourceFrame` conserva exactamente el texto UTF-8 recibido y metadatos de recepción. `MarketTick` es una proyección regenerable. Una incidencia referencia eventos; nunca cambia el log fuente.

La pérdida de persistencia raw detiene normalización y cierra la conexión para aplicar backpressure. No se descartan frames para mantener el proceso vivo.

### 4. Representaciones canónicas

- **Tiempo:** UTC RFC 3339 con exactamente milisegundos, por ejemplo `2026-01-01T00:00:00.000Z`. Epoch de fuente en segundos se multiplica exactamente por 1000; no se inventan fracciones.
- **Recepción:** reloj UTC y reloj monotónico inyectados. UTC se persiste; el monotónico controla timeouts dentro de un proceso y no participa en hashes.
- **Cotización:** string decimal sin exponente, separador ni signo `+`; tiene exactamente `pip_size` dígitos decimales. Trailing zeros son significativos. El adaptador usa parsing JSON que preserve el lexema numérico o una librería decimal exacta; `JSON.parse` seguido de aritmética binaria no es suficiente para construir la cotización de dominio.
- **IDs fuente:** UUIDv7 minúsculo generado por fuente inyectable; replay reutiliza los IDs guardados en source events.
- **IDs derivados:** incidencias y condiciones usan `sha256:` + SHA-256 de JCS de todos sus campos salvo el propio ID; así recomputación obtiene la misma identidad sin leer artefactos derivados.
- **Canonicalización:** JSON Canonicalization Scheme RFC 8785, UTF-8 y SHA-256 hexadecimal minúsculo.
- **Orden de source events:** orden de observación persistido.
- **Orden lógico de ticks:** `event_time_utc`, `tick_fingerprint_sha256`, `observation_id`.
- **Orden lógico de incidencias:** `observed_at_utc`, `incident_type`, `incident_id`.

`tick_fingerprint_sha256` usa un objeto canónico con únicamente `source`, `symbol`, `event_time_utc`, `quote_decimal` y `pip_size`. No incluye recepción ni ID operativo.

### 5. Identidad lógica y objetos físicos

La identidad de un dataset es independiente del formato físico:

- `logical_content_sha256`: hash de registros ordenados, cada uno JCS, unidos por `\n` y con newline final.
- `object_bytes_sha256`: hash de bytes almacenados después de codificación/compresión.

Para JSON estructurado individual, el hash lógico es SHA-256 de JCS. Para Parquet, el pipeline decodifica registros, los ordena y calcula la representación NDJSON lógica; metadatos del writer no cambian el dataset ID.

Cada `LogicalArtifactRef` tiene `artifact_id = <role>:<índice de seis dígitos>`. Exactamente un `StorageObjectRef` comparte ese ID, rol y hash lógico. El ID, no la posición ni un hash posiblemente repetido, es la clave de unión. Dos datasets pueden deduplicar el mismo objeto físico sin compartir artifact ID.

Cada `StorageObjectRef` declara URI, media type, compresión, tamaño, hash físico y lógico; Parquet/gzip añade nombre/versión de writer. Cambiar writer puede cambiar hash físico, nunca el lógico si los registros son iguales.

### 6. Formatos y almacenamiento

- Source events: NDJSON lógico; objeto físico gzip determinista en producción y `none` en vectores.
- Ticks normalizados: Parquet físico; NDJSON lógico para hash y vectores.
- Incidencias: PostgreSQL append-only y artefacto Parquet/NDJSON referenciado.
- Condiciones operativas: eventos append-only que abren/resuelven condiciones y permiten derivar salud.
- Manifiesto: JSON canónico en object storage y fila transaccional en PostgreSQL.
- Catálogo: snapshots inmutables en object storage con índice PostgreSQL.
- Esquema de fuente y perfil de calidad: objetos JSON referenciados y firmados lógicamente.

Claves finales son content-addressed (`sha256/<object_bytes_sha256>`). Bucket, región y URI no participan en `dataset_id`.

Hasta incorporar un writer Parquet, F1.3 escribe ticks e incidencias como NDJSON sin compresión; servicios locales y formato físico vigente están en [ADR-0005](0005-persistencia-local-y-formato-fisico-f1-3.md).

### 7. Límites de recursos

Defaults versionados de Fase 1:

| Límite | Valor |
|---|---:|
| Frame WebSocket | 1 048 576 bytes |
| Cola en memoria | 1000 eventos y 33 554 432 bytes; se aplica el primero alcanzado |
| Segmento raw sin comprimir | 67 108 864 bytes |
| Frames por segmento | 10 000 |
| Ventana de segmento | 5 minutos UTC de recepción |
| Conexión WebSocket | timeout 10 000 ms |
| Solicitud de datos | timeout 15 000 ms |
| Descarga de schemas.zip | 5 242 880 bytes y timeout 30 000 ms |
| Contenido expandido del ZIP | 52 428 800 bytes, máximo 1000 entradas y 10 485 760 bytes por entrada |

La política `segment_policy_version = 1.0.0` rota por bytes, frames o ventana, lo que ocurra primero. En el harness sintético, `segment_rotation_requested` fuerza una rotación después del source event anterior y no se persiste; existe solo para probar múltiples segmentos. En replay, los límites entre artifacts `source_events:*` ya forman parte del input autenticado y se preservan.

Los límites de segmento por bytes, frames o tiempo son disparadores normales de rotación y no generan incidencia. Los demás límites aplican esta matriz única:

| Recurso | Unidad | Al exceder | Salud |
|---|---|---|---|
| frame WebSocket | bytes | rechazar frame y cerrar entrada | `paused` |
| cola en memoria | eventos o bytes | dejar de aceptar y cerrar entrada | `paused` |
| ZIP de esquema total/entrada/expandido | bytes | abortar carga de esquema | `failed` |
| cantidad de entradas ZIP | entradas | abortar carga de esquema | `failed` |

`source_limit_exceeded` registra `resource`, `unit`, `observed_value` y `maximum_value`. Nunca carga contenido completo fuera del límite. Elevar límites requiere configuración versionada, evidencia de recursos y revisión.

### 8. Publicación atómica

1. Cerrar, ordenar y serializar artefactos lógicos, incluidos artefactos vacíos obligatorios.
2. Calcular hashes lógicos y construir `DatasetManifestCore`; calcular `dataset_id = "sha256:" + SHA256(JCS(core))`.
3. Codificar objetos físicos, calcular hashes, escribir en claves content-addressed y verificar lectura/metadata.
4. Generar un `publication_id` UUIDv7 y construir `DatasetManifest` con referencias físicas.
5. Serializar el documento como JCS sin newline, calcular `manifest_document_sha256` y escribirlo bajo `manifests/<dataset_id>/<publication_id>/<manifest_document_sha256>.json`.
6. Verificar bytes del documento.
7. En una transacción PostgreSQL, insertar `PublishedManifestRecord` y hacerlo `active` junto al dataset visible como `published`.

Los lectores resuelven un `PublishedManifestRecord.active` y exigen fila, documento y hashes válidos. Si falla antes del paso 7, no hay dataset visible; objetos quedan huérfanos hasta limpieza. Relocar o recodificar crea otro `publication_id`; nunca sobrescribe una publicación existente bajo el mismo dataset.

### 9. Semántica de dataset y replay

`DatasetManifestCore` incluye:

- versiones de canonicalización, esquema de source events, ticks, incidencias y condiciones;
- release y digest lógico del esquema de fuente;
- versiones de conector, normalizador, reglas, perfil y segmentación;
- digest lógico del perfil de calidad;
- fuente, símbolos, rango y conteos;
- lista de `LogicalArtifactRef` con `artifact_id`, rol, índice, conteo y hash.

Cada rol (`source_events`, `normalized_ticks`, `quality_incidents`, `operational_conditions`) aparece al menos una vez. Una secuencia vacía es un objeto de cero bytes con SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`; no se representa omitiendo el rol ni con un newline.

`DatasetManifest` añade `publication_id`, fecha y objetos. `PublishedManifestRecord` autentica el documento completo y selecciona la publicación activa. Así, URIs/writers pueden variar sin colisionar bajo una clave basada solo en `dataset_id`.

Replay tiene dos modos sin red:

1. **`--verify-only`:** valida record activo, documento, hashes físicos, contratos, hashes lógicos y core; no demuestra el normalizador.
2. **Recomputación (default):** usa solo source events + esquema + perfil + versiones, regenera ticks, incidencias derivables y condiciones derivables, y compara hashes lógicos, conteos, core e ID.

`persistence_unavailable` y `source_limit_exceeded` ocurridos fuera de un dataset se prueban por la ruta operativa fail-closed, no se inventan durante replay. Una versión, perfil, objeto o causa requerida ausente aborta; no migra silenciosamente.

Si no hay ticks válidos, tiempos de evento son `null` y los artefactos vacíos siguen presentes; el subvector `zero-valid-ticks` fija su identidad.

### 10. Calidad y evidencia estricta

Las uniones exactas de `SourceEvent` y evidencia de incidencias están en [contratos de dominio](../contratos-de-dominio.md). Fase 1 define:

- `invalid_source_frame`
- `duplicate_exact`
- `source_time_conflict`
- `out_of_order`
- `delivery_delayed`
- `connection_lost`
- `event_gap_unresolved`
- `persistence_unavailable`
- `source_limit_exceeded`

Duplicado usa fingerprint. Conflicto significa mismo `source + symbol + event_time_utc` con fingerprint distinto. Fuera de orden compara contra high-watermark por símbolo. Retraso compara recepción y evento con el perfil. Un salto temporal no prueba pérdida universal: el perfil declara cuándo investigar y, tras reconexión, buoh intenta `ticks_history`. Sin continuidad demostrable, conserva incidencia no resuelta.

El perfil sintético v1 fija 2000 ms para retraso y separación tras reconexión. Valores live no se heredan de ese perfil.

Incidencia y condición son conceptos distintos: la incidencia registra lo observado; `OperationalConditionEvent` abre o resuelve estado operativo. Salud se deriva del último evento por `condition_key`, no de borrar o mutar incidencias.

### 11. Estados separados

- `deployment_environment`: `development | test | staging | production`
- `execution_mode`: `disabled | shadow | demo | real`
- `strategy_lifecycle`: `draft | reviewed | active | paused | retired`
- `service_health`: `starting | healthy | degraded | recovering | paused | failed`

Fase 1 usa `execution_mode = disabled`. `paused` no es entorno. El worker no reporta `healthy` si el último frame aceptado no está confirmado como durable.

### 12. Fallos y backpressure

Ante pérdida de almacenamiento o límites recuperables de frame/cola, el worker:

1. cambia a `paused`;
2. deja de emitir normalizados;
3. cierra entrada;
4. registra incidencia/condición si existe persistencia;
5. recupera desde último evento confirmado;
6. verifica continuidad antes de `healthy`.

Un esquema que excede límites o no coincide con digest deja el servicio `failed`; no reintenta con contenido no confiable. Los umbrales de rotación solo cierran segmento y no cambian salud.

El evento sintético `persistence_fault_armed` arma exactamente la siguiente operación indicada por `scope` y se consume una vez. Aparece antes del estímulo afectado. Un resultado ambiguo nunca se interpreta como durable.

### 13. Retención de desarrollo

Datos live de smoke son efímeros, no se publican por defecto como dataset y se eliminan en 24 horas. Publicar un dataset real requiere acción explícita y no lo incorpora a Git. La redistribución de datos de Deriv queda deshabilitada hasta revisar términos aplicables; Fase 1 solo usa datos para validación interna.

## Consecuencias

- Pipeline auditable desde frame exacto hasta dataset.
- Hashes y vectores independientes del lenguaje, writer físico o modelo de IA.
- PostgreSQL y object storage bastan para Fase 1.
- Guardar source events y normalizados ocupa más espacio, aceptado por reproducción.
- Los límites evitan que contenido externo agote recursos antes del control de backlog.
- El endpoint puede cambiar; release fijada y smoke detectan deriva sin romper pruebas offline.

## Alternativas descartadas

| Alternativa | Motivo |
|---|---|
| Guardar solo ticks normalizados | Impide reprocesar errores y auditar el payload fuente. |
| Firmar estímulos del test como log raw | Mezcla driver de prueba con contrato persistido. |
| Usar bytes Parquet como identidad del dataset | Acopla identidad a writer y metadatos físicos. |
| Usar `number` para cotizaciones de dominio | Introduce ambigüedad binaria en precisión y hashes. |
| UUID regenerado en replay | Rompe reproducción byte a byte. |
| Marcar PostgreSQL `published` antes del manifiesto físico | Permite lectores observar un dataset incompleto. |
| Redis/TimescaleDB desde el primer incremento | No resuelven un requisito actual que PostgreSQL/S3 no cubra. |
| Smoke live como prueba principal | Red y mercado no son deterministas. |

## Referencias verificadas

- [WebSocket público de Deriv](https://developers.deriv.com/docs/options/ws-public/)
- [Active Symbols](https://developers.deriv.com/docs/data/active-symbols/)
- [Ticks](https://developers.deriv.com/docs/data/ticks/)
- [Ticks History](https://developers.deriv.com/docs/data/ticks-history/)
- [Ping](https://developers.deriv.com/docs/system/ping/)
- [Server Time](https://developers.deriv.com/docs/system/time/)
- [Release fijada de esquemas](https://github.com/deriv-com/deriv-api-schemas/releases/tag/production_v20260901_0)

El contenido de fuentes externas fue reformulado para cumplir restricciones de licencia.
