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

### Desconexión de WebSocket

1. Persistir `ConnectionClosed` con `closure_type`, símbolos afectados y motivo.
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

Desde F1.3b, un frame de más de 1 048 576 bytes se rechaza antes de crear el `RawSourceFrame`. Queda una incidencia `source_limit_exceeded` con severidad `error` y una condición abierta en el registro operativo, y la entrada se cierra; solo se admite después el `ConnectionClosed` del cierre. Un `ConnectionOpened` durable resuelve la condición (`input_reopened`) y reabre la entrada. En F1.3b esa reapertura no verifica todavía la continuidad del paso 5: la verificación llega con la reconexión (F1.5). Los límites de la cola en memoria llegan con el transporte real (F1.4/F1.5).

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
5. Opcional, para ensayar: `pnpm --filter @buoh/market-data-worker run fixture:publish` pasa los dos escenarios sintéticos de `test-vectors/market-data/v1` por el log raw-first (fuente `synthetic`) y publica cada uno desde sus segmentos cerrados. Es idempotente: un escenario ya activo se informa como `already_published`. Requiere que el log de `synthetic` esté vacío o tenga exactamente la forma del fixture.
6. Reproducir: `pnpm run data:replay -- --dataset <dataset_id>` (recomputación) o añadir `--verify-only` (solo integridad).

`data:replay` no contacta a Deriv, no escribe nada y emite una línea JSON en stdout:

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
