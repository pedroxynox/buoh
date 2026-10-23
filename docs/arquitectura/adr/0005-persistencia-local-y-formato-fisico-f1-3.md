# ADR-0005: Persistencia local, formato físico y log raw-first de F1.3

- **Estado:** Aceptada
- **Fecha:** 2026-10-23
- **Ámbito:** Fase 1, incremento F1.3
- **Decisores:** Propietario de buoh, a propuesta de la dirección técnica
- **Complementa:** [ADR-0004](0004-pipeline-y-reproduccion-de-datos-fase-1.md) §6–§9; difiere temporalmente Parquet de §6

## Contexto

ADR-0004 fija PostgreSQL estándar y almacenamiento S3-compatible, pero no qué servicio local usar, qué formato físico se escribe mientras no exista writer Parquet, cómo se materializa el buffer durable del segmento abierto ni cómo se miden los umbrales de rotación. MinIO Community, la opción local habitual, se archivó el 25 de abril de 2026 y dejó de publicar imágenes y binarios. F1.3 se entrega en dos PR: **F1.3a** (`F1-DATASET-001`: servicios, publicación y replay) y **F1.3b** (`F1-STREAM-001`: log raw-first, rotación y registro operativo).

## Decisiones

### 1. Servicios locales (F1.3a)

- `infra/compose.yaml` fija **PostgreSQL 18.6** (imagen oficial) y **SeaweedFS 4.48** en modo `mini` (Apache-2.0) como almacenamiento S3-compatible: S3 en el puerto 8333, una identidad estática por variables de entorno y el bucket creado al arrancar. Telemetría, WebDAV e interfaz de administración desactivadas.
- Imágenes por versión y digest; puertos publicados solo en `127.0.0.1`; credenciales solo por entorno (compose no arranca sin ellas). CI genera credenciales efímeras por ejecución.
- El worker usa `pg` y el SDK oficial `@aws-sdk/client-s3`. Solo depende de operaciones S3 estándar (`PutObject` con `If-None-Match: *`, `GetObject`, `HeadObject`), así que el proveedor productivo sigue siendo una decisión abierta.

### 2. Formato físico transitorio (F1.3a)

- `source_events`: gzip con `writer_name = node:zlib`, `writer_version` = versión de zlib del runtime, nivel 9, sin nombre ni fecha en la cabecera. Es determinista para el mismo writer; replay nunca recodifica, verifica los bytes guardados contra `object_bytes_sha256`.
- `normalized_ticks`, `quality_incidents` y `operational_conditions`: NDJSON lógico sin compresión. Esquema de fuente y perfil: sus bytes JSON firmados.
- Parquet para ticks e incidencias se incorpora en un incremento posterior con su propia decisión de columnas y writer. `dataset_id` no cambia, porque solo depende de hashes lógicos.

### 3. Publicación (F1.3a)

- Claves: `sha256/<object_bytes_sha256>` para objetos y `manifests/<dataset_id>/<publication_id>/<manifest_document_sha256>.json` para el documento; URIs `s3://<bucket>/<clave>`.
- Antes del commit, cada objeto y el documento se escriben solo si la clave no existe y se verifican releyendo sus bytes.
- El commit (ADR-0004 §8 paso 7) inserta en una sola transacción el dataset `published`, sus incidencias derivables y el `PublishedManifestRecord` `active`. Un índice parcial admite un único record activo por dataset y `deployment_environment`; la base comprueba que `dataset_id` es el SHA-256 de `manifest_core`.
- Las tablas son append-only: triggers rechazan `UPDATE`, `DELETE` y `TRUNCATE`. Por eso F1.3 **rechaza** publicar un dataset que ya tiene record activo; reubicar o recodificar (nuevo record y el anterior `superseded`) llega con una migración posterior que permita solo esa transición.
- `data:replay` es de solo lectura y emite un informe JSON. Salida 0: reproducido o verificado; 1: integridad, contrato, versión o recomputación; 2: uso o configuración.

### 4. Log raw-first (F1.3b, aprobado sin implementar)

- Cada source event se escribe como objeto content-addressed con su línea JCS (`raw_object_write`) y después se indexa en PostgreSQL con segmento y posición (`source_event_index`). Solo es durable cuando ambos confirman; antes no se normaliza ni se emite tick, y el `IngestionCursor` avanza después.
- Al cerrar un segmento se escribe su objeto NDJSON content-addressed, se verifica y se marca cerrado. Los objetos por evento quedan como huérfanos limpiables tras el período de seguridad.
- Tras la durabilidad, `normalizeRawFrame` entrega el tick a un sink inyectado. Las incidencias derivables se calculan con `deriveMarketData` al publicar; la calidad incremental en vivo queda diferida.
- Publicar es una acción explícita sobre un rango contiguo de segmentos cerrados de una fuente.

### 5. Rotación `segment_policy_version = 1.0.0` (F1.3b, aprobado sin implementar)

Se evalúa antes de añadir cada source event a un segmento no vacío; rota si se cumple cualquiera:

- **Bytes:** la suma de bytes NDJSON lógicos del segmento (todas las clases de evento, cada línea JCS más `\n`) más el evento nuevo superaría 67 108 864.
- **Frames:** el evento es un `raw_source_frame` y el segmento ya contiene 10 000.
- **Ventana:** el tiempo del evento (`received_at_utc` para raw, `occurred_at_utc` para el resto) es mayor o igual que el del primer evento del segmento más 300 000 ms.

No hay temporizador: un segmento inactivo sigue abierto hasta el siguiente evento o un cierre explícito (drenaje o apagado). La política es una función pura en `packages/domain`. Rotar no crea incidencia ni cambia salud.

### 6. Registro operativo (F1.3b, aprobado sin implementar)

La semántica de `persistence_unavailable` y `source_limit_exceeded` (severidad, referencias, apertura y resolución) está en [contratos de dominio](../contratos-de-dominio.md#registro-operativo-de-persistencia-y-límites).

### 7. Pruebas

- `pnpm run test` sigue siendo offline: adaptadores en memoria, sin red, reloj real ni aleatoriedad.
- `pnpm run test:integration` ejecuta contra los servicios de `infra/compose.yaml` y corre en CI en cada PR. Solo conecta por loopback; IDs y tiempos del pipeline se inyectan. El cliente S3 usa el reloj del sistema únicamente para firmar peticiones (SigV4), y ninguna aserción ni hash depende de él.

## Consecuencias

- Un clon limpio puede levantar PostgreSQL y S3 locales, publicar los vectores sintéticos y reproducirlos con el mismo `dataset_id`.
- Dos escrituras por source event en F1.3b: aceptado por el volumen de Fase 1 y porque coincide con ADR-0001 §4 (raw en S3, metadatos en PostgreSQL) y con las etapas `PersistenceStage`.
- Mientras no haya Parquet, los derivados ocupan más espacio.
- El SDK de AWS añade dependencias transitivas; se fija versión exacta y se revisa en cada actualización.

## Alternativas descartadas

| Alternativa | Motivo |
|---|---|
| MinIO Community | Archivado; sin imágenes ni binarios mantenidos. |
| Garage | AGPL-3.0 y requiere inicializar layout y llaves con su CLI tras arrancar. |
| RustFS | Proyecto más joven; sin ventaja para un nodo local. |
| Buffer durable en PostgreSQL y S3 solo al cerrar | `raw_object_write` dejaría de significar durabilidad por frame, como modela el vector. |
| Parquet ya en F1.3a | Writer JavaScript aún pre-1.0 y mapeo de columnas sin decidir; no cambia `dataset_id`. |
| Firma SigV4 propia | Menos dependencias, pero código criptográfico de protocolo propio. |
| Ventanas UTC alineadas | Igualmente válidas; se eligió medir desde el primer evento del segmento. |

## Referencias verificadas

- [Estado de MinIO Community: distribución solo como código fuente](https://github.com/minio/minio)
- [SeaweedFS: modo `mini` y S3](https://github.com/seaweedfs/seaweedfs)
- [PostgreSQL 19 RC 1: fecha prevista de disponibilidad general](https://www.postgresql.org/about/news/postgresql-19-rc-1-released-3409/)

El contenido de fuentes externas fue reformulado para cumplir restricciones de licencia.
