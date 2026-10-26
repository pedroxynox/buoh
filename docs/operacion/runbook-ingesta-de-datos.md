# Runbook: ingesta y calidad de datos de mercado

## Alcance

Este runbook cubre `market-data-worker` durante Fase 1 y Fase 2. Debe leerse junto al [plan de Fase 1](../plan/fase-1-fundacion-de-datos.md), [ADR-0004](../arquitectura/adr/0004-pipeline-y-reproduccion-de-datos-fase-1.md) y [contratos de dominio](../arquitectura/contratos-de-dominio.md).

El servicio recibe datos públicos de Deriv, persiste el evento de fuente antes de normalizar y publica derivados solo con calidad explícita. No cubre credenciales ni ejecución.

## Ejes de estado

- `deployment_environment`: dónde corre el servicio.
- `execution_mode`: `disabled` durante Fase 1.
- `service_health`: salud operativa descrita abajo.

No se usa `paused` como entorno ni modo de ejecución.

## Estados de salud

| Estado | Significado | Acción automática |
|---|---|---|
| `starting` | inicialización y validación de dependencias | no aceptar/publicar ticks aún |
| `healthy` | conexión esperada, almacenamiento disponible y raw confirmado | continuar |
| `degraded` | continuidad no demostrada o incidencia abierta no crítica | conservar datos, marcar calidad y bloquear consumidores que exijan continuidad |
| `recovering` | reconexión o verificación histórica en curso | buffer acotado; no declarar continuidad |
| `paused` | durabilidad/backpressure/configuración operativa impide procesar seguro | cerrar suscripción y no emitir normalizados |
| `failed` | contrato o versión incompatible, corrupción o fallo no recuperable | detener proceso y requerir intervención |

Los umbrales live pertenecen a un perfil versionado por fuente/símbolo. El perfil sintético v1 fija 2000 ms para pruebas; no se copia a producción sin medición y decisión.

## Invariantes operativos

- Persistir `RawSourceFrame` antes de emitir `MarketTick`.
- Conservar tiempo de fuente y recepción por separado.
- No reserializar el texto fuente antes de calcular su hash.
- No descartar frames por presión de memoria: pausar/cerrar y recuperar.
- Verificar hashes, versiones y continuidad después de reinicio o reconexión.
- Mantener incidencias append-only: las derivables se referencian desde el dataset; persistencia/límites no derivables permanecen en el registro operativo PostgreSQL.
- Verificar límites por bytes antes de parsear o descomprimir contenido externo.
- No reportar `healthy` si el último frame aceptado no está confirmado como duradero.

## Procedimientos

### Inicio

1. Validar configuración y versiones de contratos/conector/calidad.
2. Comprobar PostgreSQL y object storage.
3. Recuperar último cursor, high-watermark y segmento no finalizado.
4. Verificar hashes de objetos pendientes.
5. Abrir el WebSocket y pasar de `starting` a `healthy` solo después de persistir/confirmar el primer evento esperado.

Desde F1.3b, `SourceEventLog.open` cubre la parte de los pasos 3–4 que toca al segmento no finalizado: lo continúa y relee y verifica el objeto de cada uno de sus eventos; si alguno falta o no coincide con su hash, el arranque aborta. El cursor y el high-watermark del paso 3 llegan con la reconexión (F1.5). Si el registro operativo tiene una condición abierta de la ejecución anterior, la entrada sigue cerrada hasta el `ConnectionOpened` que la resuelve.

Desde F1.4b, antes de abrir el log de una fuente en PostgreSQL se toma su bloqueo (ver «Una sola instancia por fuente»).

### Una sola instancia por fuente

Desde F1.4b ([ADR-0012](../arquitectura/adr/0012-catalogo-y-adaptador-publico-de-deriv.md) §9), todo proceso que escribe el log de una fuente en PostgreSQL toma antes un bloqueo de sesión (`pg_try_advisory_lock`, `SourceLock`). Su clave son los 8 primeros bytes del SHA-256 de `buoh:source-log:<fuente>`, como entero de 64 bits con signo. La clave vale para toda la base de datos: también bloquea la misma fuente en otro `BUOH_POSTGRES_SCHEMA` de la misma base. Lo toma en un cliente propio, fuera del pool, porque el pool cierra los clientes inactivos y el bloqueo se iría con ellos, y lo mantiene mientras escribe. Hoy lo hace `fixture:publish`; el `data:smoke` del PR 7 no lo necesita, porque guarda todo en memoria.

- **Si otro proceso lo tiene**, el comando no arranca. `fixture:publish` termina con código 1 y el mensaje «Otro proceso escribe el log de "<fuente>"; no se arranca». Para ver qué sesión lo tiene, con la fuente en lugar de `deriv_options`:

  ```sql
  SELECT pid FROM pg_locks
   WHERE locktype = 'advisory' AND granted AND objsubid = 1
     AND ((classid::bigint << 32) | objid::bigint) =
         ('x' || left(encode(sha256(convert_to('buoh:source-log:deriv_options', 'UTF8')), 'hex'), 16))::bit(64)::bigint;
  ```

- **Si la sesión del bloqueo se pierde**, las escrituras siguientes del log fallan con el código `source_lock_lost`. El evento no es durable, queda `persistence_unavailable` con ese motivo y la entrada se pausa. Un `ConnectionOpened` no la reabre mientras falte el bloqueo. `SourceLock` lo nota en unos 10 s: cada 5 s consulta su sesión, y la da por perdida si se cierra, falla o no responde en 5 s. La conexión también usa el keepalive de TCP desde los 10 s de inactividad. Para volver a escribir hace falta un bloqueo nuevo (`SourceLock.acquire`), que devuelve `null` si ya lo tomó otro proceso. `fixture:publish` no lo intenta: termina con error.
- En esos segundos otro proceso podría tomar el bloqueo, y los dos escribirían a la vez. Los triggers de `0002` siguen exigiendo posiciones contiguas, así que el log no queda incoherente: cada posición se acepta para un solo escritor, y el otro falla y pausa su entrada.

### Desconexión de WebSocket

1. Persistir `ConnectionClosed` con `closure_type`, símbolos afectados y motivo. Desde F1.4b lo hace el adaptador de Deriv (ver «Adaptador público de Deriv»); los pasos 2 a 9 llegan con la reconexión (F1.5).
2. Leer y conservar `IngestionCursor` durable por símbolo; no incrustarlo en el evento de cierre.
3. Si no fue solicitado, crear `connection_lost` y `OperationalConditionEvent.opened`; cambiar a `recovering`.
4. Reconectar con espera exponencial y jitter inyectable; no crear bucle agresivo.
5. Consultar `ticks_history` para el intervalo según cursor, perfil y capacidad de fuente.
6. Validar/persistir recuperación antes de liberar frames live del buffer.
7. Al reconectar, persistir `ConnectionOpened.supersedes_connection_id` y resolver la condición de conexión.
8. Si no se demuestra continuidad por símbolo, crear `event_gap_unresolved`, abrir su condición y quedar `degraded`.
9. Volver a `healthy` solo si no queda condición bloqueante y continuidad, hashes y almacenamiento se verifican.

### Frame inválido

1. Persistir el raw exacto.
2. Crear `invalid_source_frame` con hash y error estructurado sanitizado.
3. No emitir `MarketTick` para ese frame.
4. Evaluar `degraded` o `failed` según frecuencia y compatibilidad del esquema fijado.

Con reglas 2.0.0 (Deriv), los mensajes cuyo `msg_type` declara el perfil en `non_tick_msg_types` (ping, catálogo, historia) también se persisten raw, pero no son frames inválidos: el ingestor los entrega a quien los correlaciona (`nonTickFrame`). Cualquier otro mensaje sigue siendo candidato a tick; si trae un objeto `error` de la fuente es inválido con motivo `source_error_response`. Si no se puede atribuir el símbolo, la incidencia queda sin símbolo y la ingesta continúa ([contratos de dominio, reglas 2.0.0](../arquitectura/contratos-de-dominio.md#semántica-ejecutable-de-reglas-200)).

### Duplicado, conflicto, retraso o fuera de orden

1. Conservar cada observación con ID propio.
2. Calcular fingerprint y high-watermark según ADR-0004.
3. Añadir flag al tick e incidencia append-only.
4. No borrar, sobrescribir ni reordenar el log de fuente.
5. Los consumidores usan la política de calidad; el worker no oculta la observación.

### Límite de fuente excedido

1. Rechazar antes de reservar memoria fuera del límite.
2. Crear `source_limit_exceeded` con recurso, unidad, valor observado y máximo cuando exista persistencia segura.
3. Aplicar exactamente la matriz de ADR-0004: frame/cola → `paused`; esquema/ZIP → `failed`.
4. No truncar ni interpretar parcialmente un frame o archivo como válido.
5. Reabrir solo con configuración versionada y continuidad verificada.

Desde F1.4b, los límites de `schemas.zip` se aplican al cargar los esquemas de Deriv (ver «Carga de los esquemas de Deriv»).

Desde F1.3b, un frame de más de 1 048 576 bytes se rechaza antes de crear el `RawSourceFrame`. Queda una incidencia `source_limit_exceeded` con severidad `error` y una condición abierta en el registro operativo, y la entrada se cierra; solo se admite después el `ConnectionClosed` del cierre. Un `ConnectionOpened` durable resuelve la condición (`input_reopened`) y reabre la entrada. En F1.3b esa reapertura no verifica todavía la continuidad del paso 5: la verificación llega con la reconexión (F1.5).

Desde F1.4b, el transporte de Deriv aplica dos límites antes del ingestor: el de frame, que `ws` corta con su tamaño declarado, y el de la cola en memoria. Los dos dejan la misma incidencia y la misma condición con `RawFirstIngestor.pauseForSourceLimit`, que solo escribe en el registro operativo, y cierran la entrada con `transport_error` (ver «Adaptador público de Deriv»).

### Carga de los esquemas de Deriv

Desde F1.4b ([ADR-0012](../arquitectura/adr/0012-catalogo-y-adaptador-publico-de-deriv.md) §2), el worker sabe cargar el `schemas.zip` de la release fijada en ADR-0004 §2 (`apps/market-data-worker/src/deriv/schema-archive.ts`). Lo descarga de su release en GitHub, porque buoh no guarda esos esquemas en Git. El adaptador lo carga al arrancar, antes de abrir el WebSocket: aplica el tiempo máximo de 30 000 ms con su temporizador inyectado y no se conecta si la carga falla. La carga comprueba, en este orden:

1. la descarga: como mucho 5 242 880 bytes. Un `Content-Length` mayor se rechaza sin leer el cuerpo, y una descarga sin él se corta en cuanto lo supera;
2. el SHA-256 del archivo, antes de abrirlo;
3. el directorio del ZIP, sin descomprimir: no puede usar ZIP64, y admite como mucho 1000 entradas, 10 485 760 bytes declarados por entrada y 52 428 800 en total;
4. que estén las 14 entradas que usa buoh (petición y respuesta de `active_symbols`, `forget`, `forget_all`, `ping`, `ticks`, `ticks_history` y `time`). Solo esas se descomprimen, y cada una tiene que medir lo que declara, tener el SHA-256 fijado para ella y compilar con su validador estricto.

Las huellas de las 14 entradas cubren lo que el lector de ZIP no comprueba: no valida el CRC-32, y una entrada más larga de lo que declara saldría cortada. Cambiar de release exige un PR con pruebas del adaptador (ADR-0004 §2) que fije el SHA-256 del archivo y el de sus 14 entradas, calculados con un lector independiente que compruebe el CRC-32, como `zipfile` de Python.

Cualquier fallo deja la salud en `failed`. No se reintenta con contenido no confiable (ADR-0004 §12). El resultado da un motivo y un dato saneado (`detail`):

| Motivo | Qué indica | Qué hacer |
|---|---|---|
| `source_limit_exceeded` | se superó un límite (`detail` dice cuál) | queda una incidencia `critical` y una condición abierta en el registro operativo. Revisar si la release cambió; nunca subir el límite sin configuración versionada y revisión |
| `archive_sha256_mismatch` | el archivo no es el fijado (`detail` da el hash recibido) | no usarlo. Comprobar la release en GitHub. Cambiar de release exige un PR con pruebas del adaptador (ADR-0004 §2), nunca seguir `latest` |
| `archive_invalid` | el ZIP está roto o usa ZIP64 (`detail` dice `zip64`), o una entrada extraída no mide lo que declara o no tiene su SHA-256 fijado (`detail` la nombra) | igual que un hash distinto: no se usa |
| `schema_entry_missing` | faltan entradas (`detail` las nombra) | la release no es la esperada; no se usa |
| `schema_entry_invalid` | una entrada no es JSON, tiene otro `$schema` o no compila en modo estricto (`detail` la nombra) | igual |
| `download_status` (`detail` da el código HTTP), `download_failed` o `download_timeout` | GitHub no respondió bien, no se pudo conectar o venció el tiempo | reintentar más tarde. No hay incidencia, porque no se recibió contenido |

La condición de un límite de esquema se resuelve con el primer `ConnectionOpened` durable de una ejecución posterior que sí cargó los esquemas.

### Adaptador público de Deriv

Desde F1.4b ([ADR-0012](../arquitectura/adr/0012-catalogo-y-adaptador-publico-de-deriv.md) §3 a §7), el worker tiene el adaptador del canal público (`apps/market-data-worker/src/deriv/`), con la fuente `deriv_options` y el conector `deriv-options-ws-1.0.0`. Todavía no hay un comando que lo ejecute: `pnpm run data:smoke` llega con el PR 7. El catálogo y las incidencias de respuestas pedidas se guardan en PostgreSQL desde el PR 6 (`PostgresCatalogStore` y `PostgresRequestedResponseIncidentStore`, migración `0003`). Una conexión sigue estos pasos:

1. Carga los esquemas (sección anterior) y comprueba que sus cinco peticiones (`active_symbols`, `ticks`, `ping`, `time` y `forget_all`) cumplen su esquema de petición. Si algo falla, no se conecta.
2. Abre el WebSocket con `ws` 8.22.0: sin compresión, mensajes de hasta 1 048 576 bytes, sin seguir redirecciones y con 10 000 ms para abrir. Al abrir persiste `ConnectionOpened`. Si después sigue abierta una condición del registro operativo, cierra sin suscribirse.
3. Pide `active_symbols` (`brief`). Un snapshot válido se guarda como versión nueva solo si cambia su contenido. Un catálogo inválido deja su incidencia y no crea versión, y sigue vigente la última versión válida.
4. Se suscribe a `ticks` solo si el símbolo está en ese snapshot. El primer tick confirma la suscripción, y el adaptador guarda su `subscription.id`.
5. Envía un `ping` cada 45 000 ms. Cada petición lleva un `req_id` creciente por conexión, desde 1, y espera su respuesta 15 000 ms.
6. Al cumplirse la duración pedida, pide `forget_all` y cierra con `requested`.

Cada mensaje de texto recibe su `observation_id` y su `received_at_utc` al llegar, y pasa por la cola en memoria hacia el `RawFirstIngestor`. Una respuesta se interpreta solo después de que su frame quede durable, y se empareja por `req_id` y por el `msg_type` que espera su petición. Una respuesta que no empareja se conserva raw y no cambia nada; su petición vence a los 15 000 ms.

**Respuestas pedidas.** Si la respuesta a `active_symbols`, `ping`, `time` o `forget_all` trae `error` o no cumple su esquema, queda una incidencia `invalid_source_frame` sin símbolo en el almacén de respuestas pedidas, fuera de los datasets y del registro operativo (ADR-0012 §6). Si ese almacén no responde, queda la alerta JSON `requested_response_incident_unavailable` en stderr, y la incidencia se puede volver a derivar del frame durable. Una suscripción rechazada (`ticks` con `error`) ya la registran las reglas 2.0.0. Una respuesta que queda durable después de decidir el cierre ya no cambia el flujo, pero deja igual su incidencia o, si es un catálogo válido, su versión; si entonces el almacén del catálogo no responde, queda la alerta `catalog_store_unavailable`.

**Cola en memoria.** Admite 1000 frames y 33 554 432 bytes, y se aplica el primer límite que se alcance. Un frame cuenta desde que llega hasta que el ingestor termina con él. Si un frame no cabe, el adaptador deja de aceptar, vacía la cola y corta el socket. Después registra `source_limit_exceeded` (`in_memory_queue_events` o `in_memory_queue_bytes`) con el `observation_id` del frame que no cupo, y persiste el `ConnectionClosed`. Los frames que esperaban no se persisten: la pérdida queda en la incidencia, en el cierre y en la continuidad pendiente. Un frame cortado por `ws` sigue el mismo camino con `websocket_frame` y su tamaño declarado.

**Cierres.** Ninguno reconecta todavía (F1.5). El adaptador termina con un resultado: `completed`, `disconnected`, `paused` o `failed`, con un motivo (`reason`) y un dato saneado (`detail`): el código de error o de cierre, la etapa, la operación vencida o el motivo de la incidencia. El motivo del resultado puede no ser el del `ConnectionClosed`:

| Causa | `closure_type` | Motivo del `ConnectionClosed` | Resultado y su motivo |
|---|---|---|---|
| los esquemas no cargan, o una petición propia no cumple su esquema | no conecta | ninguno | `failed`: el motivo de la carga, o `request_invalid` |
| no abre en 10 000 ms, o falla al conectar | no hay `ConnectionOpened` | ninguno | `disconnected`: `connect_timeout` o `connect_failed` |
| cierre previsto, tras la respuesta a `forget_all` (con error o sin él) | `requested` | `requested` | `completed` |
| sin snapshot válido, símbolo ausente del catálogo o suscripción rechazada | `requested` | `catalog_invalid`, `symbol_not_in_catalog` o `subscription_failed` | `failed`, con el mismo motivo |
| el almacén del catálogo no responde, o una condición operativa sigue abierta tras la apertura | `requested` | `catalog_store_unavailable` o `input_closed` | `paused`, con el mismo motivo |
| frame cortado por `ws` o cola llena | `transport_error` | `websocket_frame`, `in_memory_queue_events` o `in_memory_queue_bytes` | `paused`, con el mismo motivo. Si `ws` no dio el tamaño declarado: `failed` con `frame_size_unavailable`, sin incidencia |
| el log no confirma un evento | `transport_error`, que no se persiste porque el log fallido no lo admite | `persistence_unavailable` | `paused`: `persistence_unavailable` |
| mensaje binario | `transport_error` | `binary_frame` | `disconnected`: `binary_frame` |
| error del transporte | `transport_error` | el código saneado del error | `disconnected`: `transport_error` |
| cierre del servidor | `remote`; `transport_error` si se cortó sin cierre ordenado (1006) | `close_code_<código>` | `disconnected`: `remote_closed`, o `transport_error` con 1006 |
| una petición sin respuesta en 15 000 ms | `timeout` | `<operación>_timeout` | `disconnected`: `request_timeout` |
| una respuesta a `ping` con error o que no cumple su esquema | `timeout` | `ping_invalid` | `disconnected`: `ping_invalid` |

Los cierres `requested` no pierden datos: o no hubo suscripción, o se pidió `forget_all`. Los demás abren `connection_lost` en las reglas y dejan pendiente la continuidad del símbolo suscrito. Si el `ConnectionClosed` no queda durable, el log falló: un resultado `completed` o `disconnected` pasa a `paused` con `persistence_unavailable`.

### Almacenamiento no disponible o backlog lleno por conteo/bytes

1. Cambiar inmediatamente a `paused`.
2. Dejar de emitir normalizados.
3. Cerrar la suscripción/conexión de forma controlada antes de desbordar el buffer.
4. Registrar `persistence_unavailable` donde exista durabilidad disponible; si no, emitir alerta operativa sin afirmar persistencia.
5. Recuperar desde el último frame confirmado.
6. Verificar continuidad y publicar/reconciliar segmentos pendientes antes de reabrir.

Desde F1.3b, si la escritura del objeto (`raw_object_write`) o la fila del índice (`source_event_index`) no se confirma, el evento no cuenta como durable y no se emite su tick. Además:

- se registra `persistence_unavailable` con severidad `critical`; el motivo es el código del error, nunca su mensaje;
- la entrada se pausa y el informe fail-closed indica `close_connection_then_recover`;
- si PostgreSQL tampoco responde, solo queda una alerta JSON en stderr (`operational_registry_unavailable`);
- para recuperar, el siguiente `ConnectionOpened` reabre el log desde el estado durable y, si queda durable, resuelve la condición (`persistence_restored`). En F1.3b no se verifica antes la continuidad ni se publican o reconcilian los segmentos pendientes (paso 6); eso llega con la reconexión (F1.5).

### Publicación interrumpida

1. No exponer un dataset hasta que objetos, manifiesto canónico y hashes estén verificados y la transacción final lo marque `published`.
2. Si falla antes del commit, dejar objetos como huérfanos no visibles y reanudar desde contenido verificado.
3. No reescribir contenido bajo una clave cuyo hash físico sea distinto.
4. Si object storage deja de estar disponible después del commit, cambiar salud a `degraded`/`paused`; nunca afirmar replay exitoso hasta recuperar y verificar.
5. Limpiar huérfanos solo después del período de seguridad y sin referencias publicadas.

En F1.3 el fallo se informa como `PublicationError` con el paso (`precondition`, `object_write`, `manifest_write`, `commit`). Reanudar es repetir la publicación con un `publication_id` nuevo: los objetos ya verificados se reutilizan porque sus claves son content-addressed. Publicar un dataset que ya tiene record activo se rechaza (`PublicationConflictError`); no se reubica ni se recodifica todavía.

### Despliegue o reinicio programado

1. Cambiar a drenaje y no aceptar una nueva partición de símbolos.
2. Confirmar frames en curso y persistir cursor/high-watermark.
3. Cerrar segmento y conexión.
4. Reiniciar; validar versiones y dependencias.
5. Ejecutar recuperación de inicio y confirmar continuidad antes de `healthy`.

## Entorno local y replay (F1.3)

Servicios de [`infra/compose.yaml`](../../infra/compose.yaml): PostgreSQL 18 y SeaweedFS (S3-compatible), según [ADR-0005](../arquitectura/adr/0005-persistencia-local-y-formato-fisico-f1-3.md). Solo escuchan en `127.0.0.1`.

1. Copiar `infra/.env.example` a `infra/.env` (ignorado por Git) y completar `BUOH_POSTGRES_PASSWORD`, `BUOH_S3_ACCESS_KEY_ID` y `BUOH_S3_SECRET_ACCESS_KEY` con valores locales.
2. Levantar servicios: `docker compose -f infra/compose.yaml --env-file infra/.env up -d --wait`.
3. Exportar las mismas variables al shell (`set -a; . infra/.env; set +a`) y compilar: `pnpm run build`.
4. Aplicar migraciones: `pnpm --filter @buoh/market-data-worker run db:migrate`.
5. Opcional, para ensayar: `pnpm --filter @buoh/market-data-worker run fixture:publish` pasa los dos escenarios sintéticos de `test-vectors/market-data/v1` por el log raw-first (fuente `synthetic`) y publica cada uno desde sus segmentos cerrados. Es idempotente: un escenario ya activo se informa como `already_published`. Requiere que el log de `synthetic` esté vacío o tenga exactamente la forma del fixture, y que ningún otro proceso tenga su bloqueo (ver «Una sola instancia por fuente»).
6. Reproducir: `pnpm run data:replay -- --dataset <dataset_id>` (recomputación) o añadir `--verify-only` (solo integridad).

`data:replay` no contacta a Deriv, no escribe nada y emite una línea JSON en stdout. Antes compila el worker, y esos mensajes van a stderr (`scripts/data-replay.mjs`). Una salida distinta de 0 sin línea JSON significa que falló esa compilación o que se interrumpió el proceso; el detalle está en stderr:

| Salida | `status` | Significado |
|---:|---|---|
| 0 | `reproduced` | recomputación idéntica: core, hashes lógicos, conteos y `dataset_id` |
| 0 | `verified` | `--verify-only`: record activo, documento, hashes físicos y lógicos, contratos, invariantes entre artefactos, versiones de contrato y core |
| 1 | `failed` | `code`: `DATASET_NOT_PUBLISHED`, `MANIFEST_INTEGRITY`, `OBJECT_INTEGRITY`, `OBJECT_LOCATION_UNSUPPORTED`, `FORMAT_UNSUPPORTED`, `CONTRACT_INVALID`, `VERSION_UNSUPPORTED`, `RECOMPUTATION_FAILED`, `RECOMPUTATION_MISMATCH`, `STORAGE_UNAVAILABLE` o `UNEXPECTED` |
| 2 | `failed` | argumentos o variables de entorno inválidos; se nombran las variables, nunca sus valores |

Límites de lectura del replay: documento de manifiesto 16 MiB, objeto 256 MiB y descompresión gzip hasta el tamaño máximo de segmento raw (64 MiB, ADR-0004 §7). Un objeto por encima del límite se rechaza sin cargarlo.

`pnpm run test:integration` ejecuta las pruebas de integración contra estos servicios con las mismas variables. Usa sus propios esquemas PostgreSQL (`buoh_integration` y `buoh_integration_log`) y los recrea en cada ejecución.

Tablas append-only del log y del registro (migración `0002_log_raw_first`):

- `source_event_index`: una fila por source event durable, con la clave de su objeto;
- `closed_source_segments`: el segmento cerrado, su objeto gzip y el motivo de cierre (`bytes`, `raw_frames`, `window` o `requested`);
- `operational_incidents` y `operational_conditions`: el registro operativo.

Desde F1.4b, la migración `0003_catalogo_y_respuestas_pedidas` añade dos tablas append-only más:

- `source_catalog_versions`: una versión del catálogo por fila, contigua desde 1 por fuente y formato. Su trigger rechaza una versión que no siga a la última o que no cambie el contenido. El documento JCS del snapshot vive en el objeto `sha256/<document_sha256>`, y al leer se comprueba su hash y que corresponda a su fila;
- `requested_response_incidents`: las incidencias de respuestas pedidas (siempre `invalid_source_frame`, con el `observation_id` del frame). Guardar otra vez la misma incidencia no añade fila.

## Reporte y evidencia

`pnpm run data:health -- --json` emitirá el `HealthReport` canónico (F1.5). Todo incidente conserva:

- IDs y rango UTC;
- fuente, símbolos y conexión;
- versiones de worker, conector, contratos y reglas;
- último frame confirmado y objetos afectados;
- eventos append-only de apertura/resolución de condiciones;
- transición de salud;
- acción, resultado y responsable operativo.

No se registran payloads completos, secretos ni datos personales en logs operativos; el raw se consulta por referencia con acceso controlado.

## Verificación periódica

- Pruebas offline y vectores en cada cambio relevante.
- Smoke público de Deriv opt-in, con resultado sanitizado y fecha.
- Ensayo de reinicio y fallo de almacenamiento antes de cerrar Fase 1.
- Verificación de replay y `dataset_id` en la puerta de salida.

## Puerta de salida de Fase 1

Aplican exactamente la Definition of Done y matriz de evidencia del [plan de Fase 1](../plan/fase-1-fundacion-de-datos.md). Este runbook no define una puerta alternativa.
