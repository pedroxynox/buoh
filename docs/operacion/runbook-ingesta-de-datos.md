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

Desde F1.3b, `SourceEventLog.open` cubre la parte de los pasos 3–4 que toca al segmento no finalizado: lo continúa y relee y verifica el objeto de cada uno de sus eventos; si alguno falta o no coincide con su hash, el arranque aborta. En F1.5 el high-watermark del paso 3 sale de la derivación del log; los cursores de la fuente dan el símbolo del log, y el último del símbolo se comprueba contra el índice (ver abajo). Si el registro operativo tiene una condición abierta de la ejecución anterior, la entrada sigue cerrada hasta el `ConnectionOpened` que la resuelve.

Desde el PR 3 de [ADR-0015](../arquitectura/adr/0015-reconexion-recuperacion-y-salud-f1-5.md) §13, antes de abrir el WebSocket del paso 5 el adaptador de Deriv repara el cierre que le falte a la última conexión del log, por una caída del proceso o un fallo de persistencia (ver «Adaptador público de Deriv», paso 2). Ese cierre reparado resuelve una condición de persistencia abierta, pero no reabre la entrada: la reabre el `ConnectionOpened`.

Desde F1.4b, antes de abrir el log de una fuente en PostgreSQL se toma su bloqueo (ver «Una sola instancia por fuente»).

Desde el PR 4 de ADR-0015 §13, el paso 3 de la sesión de ingesta (ver «Adaptador público de Deriv», «Sesión de ingesta») sale de la derivación del log, nunca de la memoria del proceso (ADR-0015 §5): después de tomar el bloqueo, abre el log, lo lee entero y lo deriva con el perfil de medición. Desde el PR 5, si la sesión tiene el almacén del cursor (`status`, tabla `ingestion_cursors` de la migración `0004`), lee además de él el último cursor del símbolo y los símbolos que tienen algún cursor de la fuente: los cursores dan el símbolo del log (ADR-0015 §5 dice «el del último cursor»: como todos son del mismo símbolo, basta con que ninguno sea de otro), y el último del símbolo se comprueba contra el índice. Antes de conectar comprueba el log en este orden, y si una comprobación falla no conecta y termina `failed`; en todos los casos hace falta un log nuevo:

| Motivo | Qué indica |
|---|---|
| `connector_version_mismatch` | el log tiene frames de otro conector, por ejemplo de `deriv-options-ws-1.0.0` |
| `log_not_derivable` | las reglas no pueden derivarlo, por ejemplo porque cierra dos veces la misma conexión (`detail`: el nombre del error, como `TypeError`), o su contenido no pasa sus comprobaciones al abrirlo o al leerlo (`detail`: `LogIntegrityError`) |
| `symbol_mismatch` | el log es de otro símbolo: un cursor de la fuente es de otro símbolo, o sus ticks lo son (con el perfil del símbolo pedido, cada uno queda como frame inválido con motivo `symbol_not_allowed`). Un log lo escribe una sesión de un solo símbolo, así que todos sus cursores son de ese símbolo y lo dan aunque el log no tenga ticks, por ejemplo si esa sesión nunca llegó a suscribirse. La comprobación con los ticks se hace también cuando hay cursores |
| `cursor_ahead_of_log` | desde el PR 5, el último cursor del símbolo apunta a un evento (`last_durable_source_event_id`) que no está en el log: el log perdió datos que el índice había confirmado. Un cursor que va por detrás del log, porque el proceso cayó después de escribirlo, no es un fallo |
| `retention_expired` | desde el PR 5, con la retención de la sesión (`retentionMs`; `ingest` pasará 23 horas, ADR-0015 §7): el evento durable más antiguo del log, el primero, tiene esa antigüedad o más. Su hora es la de recepción si es un frame, y `occurred_at_utc` si no. El log de esa captura se borra entero, con su esquema y su bucket (ADR-0015 §7) |

Si un almacén no responde al abrir o leer el log, queda en stderr la alerta JSON `source_log_unavailable` con el motivo saneado (`reason`), y la sesión espera, como entre intentos, y lo vuelve a intentar, con un bloqueo nuevo si mientras tanto perdió el suyo. Si el almacén del cursor no responde, igual, con la alerta `ingestion_status_unavailable`: su motivo es el código o el nombre del error, nunca su mensaje, que en PostgreSQL puede llevar el host, el rol o la base de datos. Cualquier rechazo de ese almacén cuenta así, también el de una fila que no pasa sus comprobaciones al leerla (`TypeError`), porque la interfaz del almacén no separa los dos casos.

### Una sola instancia por fuente

Desde F1.4b ([ADR-0012](../arquitectura/adr/0012-catalogo-y-adaptador-publico-de-deriv.md) §9), todo proceso que escribe el log de una fuente en PostgreSQL toma antes un bloqueo de sesión (`pg_try_advisory_lock`, `SourceLock`). Su clave son los 8 primeros bytes del SHA-256 de `buoh:source-log:<fuente>`, como entero de 64 bits con signo. La clave vale para toda la base de datos: también bloquea la misma fuente en otro `BUOH_POSTGRES_SCHEMA` de la misma base. Lo toma en un cliente propio, fuera del pool, porque el pool cierra los clientes inactivos y el bloqueo se iría con ellos, y lo mantiene mientras escribe. Hoy lo hace `fixture:publish`; `data:smoke` no lo necesita, porque guarda todo en memoria.

- **Si otro proceso lo tiene**, el comando no arranca. `fixture:publish` termina con código 1 y el mensaje «Otro proceso escribe el log de "<fuente>"; no se arranca». Para ver qué sesión lo tiene, con la fuente en lugar de `deriv_options`:

  ```sql
  SELECT pid FROM pg_locks
   WHERE locktype = 'advisory' AND granted AND objsubid = 1
     AND ((classid::bigint << 32) | objid::bigint) =
         ('x' || left(encode(sha256(convert_to('buoh:source-log:deriv_options', 'UTF8')), 'hex'), 16))::bit(64)::bigint;
  ```

- **Si la sesión del bloqueo se pierde**, las escrituras siguientes del log fallan con el código `source_lock_lost`. El evento no es durable, queda `persistence_unavailable` con ese motivo y la entrada se pausa. Un `ConnectionOpened` no la reabre mientras falte el bloqueo. `SourceLock` lo nota en unos 10 s: cada 5 s consulta su sesión, y la da por perdida si se cierra, falla o no responde en 5 s. La conexión también usa el keepalive de TCP desde los 10 s de inactividad. Para volver a escribir hace falta un bloqueo nuevo (`SourceLock.acquire`), que devuelve `null` si ya lo tomó otro proceso. `fixture:publish` no lo intenta: termina con error.
- En esos segundos otro proceso podría tomar el bloqueo, y los dos escribirían a la vez. Los triggers de `0002` siguen exigiendo posiciones contiguas, así que el log no queda incoherente: cada posición se acepta para un solo escritor, y el otro falla y pausa su entrada.
- **La sesión de ingesta** (desde el PR 4 de ADR-0015 §13, ADR-0015 §3, «Bloqueo») toma el bloqueo antes de abrir el log y escribe siempre con el vigente. Si al arrancar lo tiene otro proceso, termina `failed` con `source_lock_taken`, sin abrir el log. Si PostgreSQL no responde al tomarlo, espera, como entre intentos, y lo vuelve a intentar. Si lo pierde, una escritura falla con `source_lock_lost` y la conexión termina en `paused`; antes de reconectar, suelta el bloqueo perdido y toma uno nuevo: si lo tiene otro proceso, termina `failed` con `source_lock_taken`, y si PostgreSQL no responde, espera y lo vuelve a intentar. Con el bloqueo nuevo, lo primero que usa el log (la reparación del intento siguiente o, si llega la parada, el cierre del segmento) lo reabre desde los almacenes; también lo reabriría antes una lectura del log para la recuperación del hueco, aunque la sesión solo lee después de la reparación. La reparación relee la conexión anterior antes de escribir, aunque el bloqueo se perdiera sin conexión: en los segundos que tardó en notarse, otro proceso pudo escribir, y si dejó una conexión sin cierre, la sesión lo repara y la supera. Todavía no hay un comando que la ejecute sobre PostgreSQL: `ingest` llega con el PR 5.
- **Cada intento fallido de tomarlo** deja en stderr la alerta JSON `source_lock_unavailable` con el motivo saneado (`reason`), antes de esperar. El proveedor del bloqueo dice que PostgreSQL no responde lanzando `SourceLockUnavailableError` con la causa, el error de la conexión o de la consulta (`apps/market-data-worker/src/deriv/session.ts`). El de PostgreSQL lo hace desde el PR 5 (ver «El proveedor de PostgreSQL», abajo). El motivo de la alerta sale de esa causa saneado: su código o su nombre, nunca su mensaje, que puede llevar el rol, la base de datos o el host. Cualquier otro error al tomarlo es de programación: la sesión suelta su bloqueo y se rechaza con él, sin reintentar. Un bloqueo que ya no está tomado cuando llega (`held` en `false`) cuenta como un intento fallido, con el motivo `source_lock_lost`: la sesión lo suelta y espera antes de pedir otro, en lugar de volver a pedirlo enseguida.
- **El proveedor de PostgreSQL** (desde el PR 5 de ADR-0015 §13, `PostgresSessionLockProvider` en `apps/market-data-worker/src/postgres/session-lock.ts`) toma el bloqueo para la sesión con `SourceLock.acquire`, en un cliente nuevo cada vez: devuelve el bloqueo tomado, o `null` si lo tiene otro proceso. Cualquier fallo de la conexión o de la consulta, también una credencial rechazada, lo convierte en `SourceLockUnavailableError` con esa causa, así que la sesión espera y lo vuelve a intentar; con una contraseña mal puesta, la alerta se repite con el motivo `28P01`. `SourceLock` lee el PID de PostgreSQL de su sesión (`pg_backend_pid()`) en la misma consulta que toma el bloqueo y lo expone como `backendPid`: es el `pid` que da la consulta de `pg_locks` de arriba, y el que la sesión de ingesta escribe en cada latido (ADR-0015 §6; ver «Adaptador público de Deriv», «Sesión de ingesta»), para que `data:health` (ADR-0015 §8, PR 6) reconozca al escritor vivo de este esquema. `openLockedSourceLog` abre el log de la sesión sobre `lockedSourceLogStore` con el bloqueo que recibe, así que el log solo escribe con el bloqueo vigente y deja de hacerlo al soltarlo; un bloqueo que no es un `SourceLock` de la fuente del log se rechaza con `TypeError`, sin leer nada. Todavía no lo usa ningún comando: lo usará `ingest`, también del PR 5.

### Desconexión de WebSocket

1. Persistir `ConnectionClosed` con `closure_type`, símbolos afectados y motivo. Desde F1.4b lo hace el adaptador de Deriv (ver «Adaptador público de Deriv»). Si no queda durable, desde el PR 3 de ADR-0015 §13 lo repara la ejecución siguiente antes de abrir su socket, con el motivo `close_not_recorded`. Desde ese mismo PR, cada `ConnectionOpened` ya lleva el `supersedes_connection_id` del paso 7, y una conexión ya sabe pedir y persistir la historia de los pasos 5 y 6 (ver «Adaptador público de Deriv», «Recuperación de historia»); desde el PR 4, la sesión de ingesta reconecta (paso 4) y la pide. Desde el PR 5, la sesión persiste el cursor del paso 2 después de cada `ConnectionClosed` durable, también uno reparado (ver «Sesión de ingesta», «Cursor»). `data:health`, que deriva la salud de los pasos 3, 8 y 9, llega con el PR 6.
2. Leer y conservar `IngestionCursor` durable por símbolo; no incrustarlo en el evento de cierre.
3. Si no fue solicitado, crear `connection_lost` y `OperationalConditionEvent.opened`; cambiar a `recovering`.
4. Reconectar con espera exponencial y jitter inyectable; no crear bucle agresivo.
5. Consultar `ticks_history` para el hueco que dan las reglas al derivar el log, no el cursor: desde el high-watermark del cierre hasta el primer tick posterior ([ADR-0015](../arquitectura/adr/0015-reconexion-recuperacion-y-salud-f1-5.md) §2 y §4). Desde el PR 4 de ADR-0015 §13 la pide la sesión de ingesta, por la conexión nueva (ADR-0015 §4, «Cuándo»): al empezar cada conexión deriva el log y, si el símbolo tiene un hueco pendiente, anota el high-watermark donde empieza. Con el primer tick durable estrictamente posterior a él vuelve a derivar el log; si el hueco ya tiene fin, pide la historia 2000 ms después, con la cotización de los dos extremos que dan los ticks derivados, porque la historia puede no tener todavía el tick recién recibido. Si ese tick no es posterior al high-watermark del último cierre (la suscripción suele repetir el último tick), espera al siguiente. Pide una sola recuperación por conexión. Si la conexión termina antes de pedirla, no la pide: la siguiente conexión recupera el rango que den entonces las reglas, porque un cierre nuevo conserva el inicio del hueco y espera un fin nuevo.
6. Validar cada página y persistir el resultado de la recuperación. Los frames vivos no se retienen, porque eso chocaría con raw primero y con los límites de la cola: la salud sigue en `recovering` hasta que el resultado queda en el log, y los consumidores que exigen continuidad la miran (ADR-0015 §10). Desde el PR 4, mientras la sesión espera el primer tick posterior, los 2000 ms o la recuperación, la conexión sigue entregando cada tick en cuanto es durable; el resultado pasa por la misma cola que los frames, así que queda en el log detrás del primer tick posterior al cierre.
7. Al reconectar, persistir `ConnectionOpened.supersedes_connection_id` y resolver la condición de conexión.
8. Si no se demuestra continuidad por símbolo, crear `event_gap_unresolved`, abrir su condición y quedar `degraded`.
9. Volver a `healthy` solo si no queda condición bloqueante y continuidad, hashes y almacenamiento se verifican.

Desde el PR 4 de ADR-0015 §13, la sesión de ingesta reconecta (paso 4; ver «Adaptador público de Deriv», «Sesión de ingesta»). Tras una conexión que termina `disconnected` o `paused`, o un intento que no llegó a conectar, espera d/2 + `random` · d/2 ms, con d = mín(60 000, 1000 · 2^(n−1)) en el intento n desde 1: de 500 a 999 ms al principio y de 30 000 a 59 999 ms con el tope, desde el séptimo intento. El contador vuelve a 1 solo si la conexión que acaba de terminar tuvo ticks durables durante 60 000 ms seguidos, desde el primero hasta su fin, para que una conexión que muere enseguida no reintente cada segundo (ADR-0015 §3, «Espera»). Antes del socket siguiente repara el cierre que no quedó durable, y el `ConnectionOpened` supera la última conexión durable del log (paso 7). Una conexión que termina `failed` no se reintenta. Desde ese mismo PR, la sesión pide además la historia de los pasos 5 y 6 por cada conexión nueva (ver «Sesión de ingesta», «Recuperación del hueco»).

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

Desde F1.3b, un frame de más de 1 048 576 bytes se rechaza antes de crear el `RawSourceFrame`. Queda una incidencia `source_limit_exceeded` con severidad `error` y una condición abierta en el registro operativo, y la entrada se cierra; solo se admite después el `ConnectionClosed` del cierre. Un `ConnectionOpened` durable resuelve la condición (`input_reopened`) y reabre la entrada. Esa reapertura no verifica antes la continuidad del paso 5 (ADR-0015 §10): la entrada se reabre con el `ConnectionOpened`, porque la historia se pide por esa misma conexión, y la continuidad se verifica después, con esa historia (ver «Desconexión de WebSocket», pasos 5 y 6). Nunca hay `healthy` antes.

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

Desde F1.4b ([ADR-0012](../arquitectura/adr/0012-catalogo-y-adaptador-publico-de-deriv.md) §3 a §7), el worker tiene el adaptador del canal público (`apps/market-data-worker/src/deriv/`), con la fuente `deriv_options`. Desde el PR 3 de [ADR-0015](../arquitectura/adr/0015-reconexion-recuperacion-y-salud-f1-5.md) §13, su conector es `deriv-options-ws-1.1.0` (en F1.4b, `deriv-options-ws-1.0.0`) y su perfil de medición, `deriv_options-measurement-v2-<símbolo>`, que declara como respuestas pedidas `active_symbols`, `forget_all`, `history` (la respuesta a `ticks_history`), `ping` y `time` (ADR-0015 §1). `pnpm run data:smoke` lo ejecuta en memoria, desde el PR 4 de ADR-0015 §13 con la sesión de ingesta (ver «Smoke público de Deriv»); todavía no hay un proceso que ingiera de forma continua. El catálogo y las incidencias de respuestas pedidas se guardan en PostgreSQL desde el PR 6 (`PostgresCatalogStore` y `PostgresRequestedResponseIncidentStore`, migración `0003`). Una conexión sigue estos pasos:

1. Carga los esquemas (sección anterior) y comprueba que sus seis peticiones (`active_symbols`, `ticks`, `ticks_history`, `ping`, `time` y `forget_all`) cumplen su esquema de petición. Si algo falla, no se conecta. `ticks_history` es la petición de la recuperación de historia (ADR-0015 §4), que la conexión envía cuando recupera un hueco (ver «Recuperación de historia», más abajo): se comprueba con un rango representativo (`start` y `end` en 0), porque el rango real se conoce después.
2. Repara el cierre de la conexión anterior, si falta (ADR-0015 §3, «Cierre no registrado», desde su PR 3). La conexión anterior es la última con `ConnectionOpened` durable en el log, nunca la que recuerda el proceso: un intento cuyo `ConnectionOpened` no quedó durable no existe para el log. Si no tiene un `ConnectionClosed` durable, por una caída del proceso o un fallo de persistencia, el adaptador lo persiste antes de abrir el socket, con `closure_type: transport_error`, motivo `close_not_recorded`, el símbolo como afectado y la hora de la detección. Si el log había fallado, antes lo reabre; y si el índice confirmó el cierre original aunque informó un error, el log reabierto ya lo tiene y no se repara nada, así que nunca se cierra dos veces la misma conexión. El cierre reparado no reabre la entrada. Si no queda durable, no se conecta, y tampoco si al reabrir o leer el log no responde el almacenamiento de objetos o el índice. Si el contenido del log no pasa sus comprobaciones al reabrirlo (desde el PR 4 de ADR-0015 §13) o al leerlo (un objeto alterado, que falta o mayor que su fila, un hash o unos conteos que no cuadran, una línea que no es el source event JCS de su fila, filas fuera de su posición o segmentos sin cerrar), no se reintenta con él (ADR-0004 §12): la ejecución termina con el error `LogIntegrityError`, sin conectar ni registrar nada. Un objeto que falta o que crece no es un almacén que no responde: el almacenamiento respondió, pero el contenido que el índice confirmó ya no está. El replay trata igual un objeto ausente o excedido, y ADR-0015 §8 separa del mismo modo lo guardado que falta (regla 2, `failed`) de un almacén que no responde (regla 3, `paused`).

   Después, con cierre reparado o sin él, el adaptador abre el socket solo cuando el reloj pasa la hora del cierre de la conexión anterior. Si no la pasa, espera con su temporizador hasta el milisegundo siguiente y vuelve a mirar el reloj: 1 ms tras un cierre reparado, o más si el reloj va por detrás de un cierre anterior; si el reloj retrocede durante la espera, espera otra vez. Así el `ConnectionOpened`, que toma su hora al abrir el socket, queda siempre después del cierre que supera. Con la misma hora, las reglas podrían ordenar la resolución de `connection_lost` antes de su apertura, y el log no se podría derivar. Límite: un reloj que retrocede durante el handshake, entre crear el socket y abrirlo, no está cubierto.

   Desde el PR 4 de ADR-0015 §13, la espera va en tramos de 60 000 ms como mucho, y después de cada uno vuelve a mirar el reloj: un ajuste del reloj hacia delante se nota en un minuto, y una espera enorme nunca llega entera al temporizador. Si falta más de 60 000 ms, el reloj va por detrás del log: queda una vez la alerta JSON `clock_behind_log` en stderr, con la hora del cierre (`previous_close_utc`) y la del reloj (`now_utc`), y la espera sigue, sin socket. Qué hacer: comprobar la sincronización del reloj del host; si el log se escribió con un reloj adelantado, la espera dura lo que falte para pasar ese cierre. Una parada durante la reparación o la espera la corta: la espera se cancela y el socket no se abre (ver «Sesión de ingesta», más abajo). Un cierre reparado ya escrito se queda, porque registra una pérdida real.
3. Abre el WebSocket con `ws` 8.22.0: sin compresión, mensajes de hasta 1 048 576 bytes, sin seguir redirecciones y con 10 000 ms para abrir. Al abrir persiste `ConnectionOpened`, que supera la conexión anterior con su `supersedes_connection_id` (`null` solo si el log no tiene conexiones). Si después sigue abierta una condición del registro operativo, cierra sin suscribirse.
4. Pide `active_symbols` (`brief`). Un snapshot válido se guarda como versión nueva solo si cambia su contenido. Un catálogo inválido deja su incidencia y no crea versión, y sigue vigente la última versión válida.
5. Se suscribe a `ticks` solo si el símbolo está en ese snapshot. El primer tick confirma la suscripción, y el adaptador guarda su `subscription.id`.
6. Envía un `ping` cada 45 000 ms. Cada petición lleva un `req_id` creciente por conexión, desde 1, y espera su respuesta 15 000 ms.
7. Al cumplirse la duración pedida, pide `forget_all` y cierra con `requested`. Si en ese momento hay una recuperación de historia en curso, pide `forget_all` cuando termina (ver «Recuperación de historia»). Desde el PR 4 de ADR-0015 §13, la duración es opcional en la conexión: sin ella, nunca pide el cierre previsto por su cuenta, y termina cuando se pierde o cuando quien la sigue la cierra (ver «Cierres a pedido»).

Desde el PR 4 de ADR-0015 §13, estos pasos se reparten en dos, que reutiliza la sesión (§3; ver «Sesión de ingesta», más abajo): la preparación (`prepareDerivAdapter`, `apps/market-data-worker/src/deriv/adapter.ts`), una sola vez, es el paso 1 y arma además el perfil de medición; el intento (`startDerivAttempt`), uno por conexión y con el `RawFirstIngestor` de la sesión, es el paso 2 y el arranque de la conexión. El intento devuelve la conexión que corre, para pedirle la historia o cerrarla (ver «Cierres a pedido»), y la promesa de su resultado; si el cierre reparado no queda durable o un almacén no responde al reabrir o leer el log, devuelve el fin en pausa sin conectar, y si el log no pasa sus comprobaciones, se rechaza con `LogIntegrityError`. `runDerivAdapter` es una preparación, un `RawFirstIngestor` nuevo y un intento, y termina con el resultado de su conexión; desde el PR 4 el smoke ya no lo usa, porque corre la sesión.

Cada mensaje de texto recibe su `observation_id` y su `received_at_utc` al llegar, y pasa por la cola en memoria hacia el `RawFirstIngestor`. Una respuesta se interpreta solo después de que su frame quede durable, y se empareja por `req_id` y por el `msg_type` que espera su petición. Una respuesta que no empareja se conserva raw y no cambia nada; su petición vence a los 15 000 ms.

**Respuestas pedidas.** Si la respuesta a `active_symbols`, `ping`, `time` o `forget_all` trae `error` o no cumple su esquema, queda una incidencia `invalid_source_frame` sin símbolo en el almacén de respuestas pedidas, fuera de los datasets y del registro operativo (ADR-0012 §6). Si ese almacén no responde, queda la alerta JSON `requested_response_incident_unavailable` en stderr, y la incidencia se puede volver a derivar del frame durable. Una suscripción rechazada (`ticks` con `error`) ya la registran las reglas 2.0.0. Una respuesta que queda durable después de decidir el cierre ya no cambia el flujo, pero deja igual su incidencia o, si es un catálogo válido, su versión; si entonces el almacén del catálogo no responde, queda la alerta `catalog_store_unavailable`. Las páginas de historia tienen además sus comprobaciones propias (ver «Recuperación de historia»).

**Recuperación de historia.** Desde el PR 3 de ADR-0015 §13 (§4), una conexión suscrita recupera con `recoverHistory` la historia de un hueco: el rango pendiente que dan las reglas al derivar el log y la cotización canónica de sus dos extremos, el tick del high-watermark y el primer tick posterior al cierre. Desde el PR 4 la pide la sesión de ingesta, 2000 ms después de ese primer tick (ver «Sesión de ingesta», «Recuperación del hueco», más abajo), que ejecuta `data:smoke`. Hace hasta tres intentos:

- Pide páginas `ticks_history` de 1000 ticks con `style: ticks`, `start` en el segundo del high-watermark y `end` en el del primer tick posterior, los dos incluidos. Mientras una página no vacía no llega a `start`, pide la anterior, con `end` en su primer tick − 1 s. Para con una página vacía, al llegar a `start` o tras 50 páginas.
- Cada página lleva su `req_id` y espera 15 000 ms. A diferencia de las demás peticiones, vencer no cierra la conexión: la página cuenta como sin respuesta y, si la respuesta llega después, se guarda raw y no se interpreta. Los ticks siguen llegando mientras tanto.
- Cada respuesta se guarda raw antes de interpretarse. Una petición rechazada (`ticks_history` con `error`) ya la registran las reglas 2.0.0. Una respuesta `history` deja su incidencia de respuesta pedida ([contratos de dominio](../arquitectura/contratos-de-dominio.md#incidencias-de-respuestas-pedidas)): con motivo `source_error_response` si trae `error`, `schema_validation_failed` si no cumple su esquema y `history_inconsistent` si lo cumple pero no trae `history`, `history.times`, `history.prices` o `pip_size`, o no es coherente. Su `pip_size` y sus tiempos siguen las mismas reglas de lexema que los de un tick, con la misma función del dominio (ADR-0004 §4): enteros sin fracción ni exponente, y `pip_size` de 0 a 18.
- El `HistoryRecoveryResult` pasa por la misma cola que los frames, así que queda en el log después del primer tick posterior al cierre. Es `complete` si todas las páginas son válidas, llegan a `start` y traen los dos extremos con la cotización recibida, comparada en decimal canónico con el `pip_size` de la respuesta. Si no, es `partial`, o `unavailable` si falló la primera página, con el primer motivo que se cumple en este orden: una página que falla (`history_error_response`, `history_invalid` o `history_timeout`), un extremo con otra cotización (`history_boundary_mismatch`), el tope de páginas sin llegar a `start` (`history_page_limit`) y un extremo que falta (`history_boundary_missing`). `recovered_event_count` cuenta los ticks de las páginas válidas entre los dos extremos, sin incluirlos.
- Reintentos: si un intento termina con `history_error_response`, `history_timeout` o `history_boundary_missing`, la conexión espera 30 000 ms y repite el intento entero, con el mismo rango y desde la primera página, hasta tres intentos en total. Los demás motivos (`history_invalid`, `history_page_limit` y `history_boundary_mismatch`) no se reintentan. Solo se persiste el resultado del último intento, y `recoverHistory` informa cuántos hubo.
- Si la conexión se cierra antes de encolar el resultado, también durante la espera entre intentos, la recuperación se abandona y no se persiste nada: la conexión siguiente recupera el rango que den entonces las reglas. Si falla por un error inesperado, la recuperación se abandona aunque su resultado ya estuviera en la cola, y ese resultado no se persiste, salvo que el fallo llegue mientras ya se escribe: esa escritura puede terminar igual, y el log es la fuente de verdad. Si el resultado no queda durable, la conexión se cierra como con un frame que no quedó durable, y termina en `paused`.
- El cierre previsto (por duración o con `finish`) espera a la recuperación en curso cuando llega, con sus reintentos: pide `forget_all` cuando el resultado pasó por la cola; si antes la conexión se cierra por otro motivo, ese cierre manda y no se pide `forget_all`. Nunca empieza una recuperación: desde el PR 4 de ADR-0015 §13, una que se pide después de `finish` o de `stop` se resuelve enseguida como `abandoned`, sin pedir ninguna página. Ningún otro cierre espera: la parada (`stop`) abandona la recuperación aunque su resultado ya esté en la cola, salvo que ya se esté escribiendo: el log es la fuente de verdad. Una pérdida de la conexión, un corte (`interrupt`), un tiempo vencido o un límite cierran enseguida y la abandonan.
- Los ticks recuperados no se entregan como ticks normalizados ni se convierten en `MarketTick`: quedan en el raw durable de las respuestas.

**Cola en memoria.** Admite 1000 frames y 33 554 432 bytes, y se aplica el primer límite que se alcance. Un frame cuenta desde que llega hasta que el ingestor termina con él. Si un frame no cabe, el adaptador deja de aceptar, vacía la cola y corta el socket. Después registra `source_limit_exceeded` (`in_memory_queue_events` o `in_memory_queue_bytes`) con el `observation_id` del frame que no cupo, y persiste el `ConnectionClosed`. Los frames que esperaban no se persisten: la pérdida queda en la incidencia, en el cierre y en la continuidad pendiente. Un frame cortado por `ws` sigue el mismo camino con `websocket_frame` y su tamaño declarado.

**Cierres a pedido.** Desde el PR 4 de ADR-0015 §13, quien sigue la conexión la cierra con tres operaciones de `DerivConnection`. Ninguna hace nada si el cierre ya está decidido:

- `finish()`, el cierre previsto: el mismo que llega al cumplirse la duración. Con la suscripción pedida, envía `forget_all` una sola vez y cierra con `requested` cuando su respuesta queda durable; si hay una recuperación de historia en curso, primero espera a que termine. Sin suscripción no hay nada que olvidar: cierra enseguida con `requested`. Desde el PR 4 de ADR-0015 §13 dice si el cierre previsto quedó pedido: si el cierre ya estaba decidido, por ejemplo porque el servidor cortó justo antes, no hace nada, devuelve `false` y la conexión termina con ese cierre.
- `stop()`, la parada por señal (ADR-0015 §3, «Parada»): no espera a la recuperación en curso, sino que la abandona, y su resultado no se persiste aunque ya esté en la cola, salvo que ya se esté escribiendo: el log es la fuente de verdad. Después cierra como `finish()`: con `forget_all` y `requested` si la suscripción está pedida, o enseguida con `requested` si no. Si `forget_all` no responde en 15 000 ms, cierra con `timeout`, como cualquier petición.
- Después de `finish()` o de `stop()`, la conexión ya no empieza ninguna recuperación de historia: `recoverHistory` se resuelve como `abandoned` sin pedir páginas, aunque `forget_all` todavía no haya respondido.
- `interrupt(motivo)`, un corte del propio transporte, como una pérdida de la conexión: cierra con `transport_error` y ese motivo, corta el socket y termina con `disconnected`. Los frames que ya llegaron se persisten antes del cierre. El motivo es un código estable, como `smoke_interrupt`, el del smoke de reconexión (ADR-0015 §9).

**Cierres.** Una conexión no reconecta: termina con un resultado, `completed`, `disconnected`, `paused` o `failed`, con un motivo (`reason`) y un dato saneado (`detail`): el código de error o de cierre, la etapa, la operación vencida o el motivo de la incidencia. Desde el PR 4 de ADR-0015 §13, la sesión de ingesta decide con ese resultado si reconecta (ver «Sesión de ingesta», más abajo); `runDerivAdapter` no reconecta. El motivo del resultado puede no ser el del `ConnectionClosed`:

| Causa | `closure_type` | Motivo del `ConnectionClosed` | Resultado y su motivo |
|---|---|---|---|
| los esquemas no cargan, o una petición propia no cumple su esquema | no conecta | ninguno | `failed`: el motivo de la carga, o `request_invalid` |
| un almacén no responde al reabrir o leer el log, o el cierre reparado de la conexión anterior no queda durable (paso 2) | no conecta | ninguno | `paused`: `persistence_unavailable`, con la etapa |
| el contenido del log no pasa sus comprobaciones al reabrirlo o al leerlo, incluido un objeto que falta o que es mayor que su fila (paso 2) | no conecta | ninguno | ninguno: la ejecución se rechaza con `LogIntegrityError` |
| una parada durante la reparación o la espera para pasar el cierre anterior (paso 2) | no conecta | ninguno | `completed`, sin socket |
| no abre en 10 000 ms, o falla al conectar | no hay `ConnectionOpened` | ninguno | `disconnected`: `connect_timeout` o `connect_failed` |
| cierre previsto (la duración o `finish`) o parada (`stop`), tras la respuesta a `forget_all` (con error o sin él). El cierre previsto la pide cuando termina la recuperación de historia en curso, si la hay; la parada abandona esa recuperación | `requested` | `requested` | `completed` |
| `finish` o `stop` antes de pedir la suscripción | `requested`; sin `ConnectionOpened`, ninguno | `requested` | `completed` |
| corte propio (`interrupt`) | `transport_error` | el motivo dado, por ejemplo `smoke_interrupt` | `disconnected`, con ese motivo |
| sin snapshot válido, símbolo ausente del catálogo o suscripción rechazada | `requested` | `catalog_invalid`, `symbol_not_in_catalog` o `subscription_failed` | `failed`, con el mismo motivo |
| el almacén del catálogo no responde, o una condición operativa sigue abierta tras la apertura | `requested` | `catalog_store_unavailable` o `input_closed` | `paused`, con el mismo motivo |
| frame cortado por `ws` o cola llena | `transport_error` | `websocket_frame`, `in_memory_queue_events` o `in_memory_queue_bytes` | `paused`, con el mismo motivo. Si `ws` no dio el tamaño declarado: `failed` con `frame_size_unavailable`, sin incidencia |
| el log no confirma un evento: un frame o el resultado de una recuperación de historia | `transport_error`, que no se persiste porque el log fallido no lo admite | `persistence_unavailable` | `paused`: `persistence_unavailable` |
| mensaje binario | `transport_error` | `binary_frame` | `disconnected`: `binary_frame` |
| error del transporte | `transport_error` | el código saneado del error | `disconnected`: `transport_error` |
| cierre del servidor | `remote`; `transport_error` si se cortó sin cierre ordenado (1006) | `close_code_<código>` | `disconnected`: `remote_closed`, o `transport_error` con 1006 |
| una petición sin respuesta en 15 000 ms, salvo una página de historia, que no cierra | `timeout` | `<operación>_timeout` | `disconnected`: `request_timeout` |
| una respuesta a `ping` con error o que no cumple su esquema | `timeout` | `ping_invalid` | `disconnected`: `ping_invalid` |

Los cierres `requested` no pierden datos: o no hubo suscripción, o se pidió `forget_all`. Los demás, incluido el reparado, abren `connection_lost` en las reglas y dejan pendiente la continuidad del símbolo suscrito. El `ConnectionOpened` siguiente supera esa conexión, así que las reglas resuelven su `connection_lost` (`connection_reestablished`), pero la continuidad sigue pendiente: con el perfil de medición, solo la decide un `HistoryRecoveryResult` (ADR-0015 §2). Si el `ConnectionClosed` no queda durable, el log falló: un resultado `completed` o `disconnected` pasa a `paused` con `persistence_unavailable`, y la ejecución siguiente repara ese cierre (paso 2).

**Sesión de ingesta.** Desde el PR 4 de ADR-0015 §13 (§3 y §4), `startDerivSession` (`apps/market-data-worker/src/deriv/session.ts`) sigue la fuente con una conexión por intento, hasta la parada, la retención (desde el PR 5), el cierre previsto o un fallo, y por cada conexión pide la historia del hueco pendiente. La ejecuta `data:smoke`, en memoria (ver «Smoke público de Deriv»); `ingest` llega con el PR 5.

- **Arranque**, en este orden: la preparación (paso 1), una sola vez; el bloqueo de la fuente (ver «Una sola instancia por fuente»); el log, abierto con el almacén protegido por ese bloqueo, leído entero y comprobado, desde el PR 5 también con el cursor si la sesión tiene su almacén (`status`) y con la retención si la tiene (ver «Inicio»); y un solo `RawFirstIngestor` para toda la sesión, que reabre el log siempre con el bloqueo vigente. Si la preparación falla, termina `failed` con su motivo, sin tomar el bloqueo.
- **Intentos.** Cada uno es el paso 2 y la conexión que lo sigue. Antes de cada uno, si el bloqueo se perdió, toma uno nuevo y el intento reabre el log con él. Según cómo termina:

  | Fin | Qué hace la sesión |
  |---|---|
  | la conexión termina `completed`, por la parada o el cierre previsto | termina `completed` |
  | la conexión termina `failed` | termina `failed`, con el motivo y el dato de la conexión. No reintenta con contenido no confiable (ADR-0004 §12) |
  | la conexión termina `disconnected` o `paused`, o el intento no conecta porque el cierre reparado no quedó durable o un almacén no respondió | espera y lo intenta otra vez (ver «Desconexión de WebSocket»), salvo después de la parada o del cierre previsto |
  | el log no pasa sus comprobaciones al reparar el cierre, durante la conexión, al volver a derivarlo para la recuperación del hueco o al reabrirlo con un bloqueo nuevo para cerrar el segmento al terminar (`LogIntegrityError`), o las reglas no pueden derivarlo | para la conexión, si la hay, y termina `failed` con `log_not_derivable` (`detail`: `LogIntegrityError` o el nombre del error), sin cerrar el segmento |
  | cualquier otro error | es de programación: suelta el bloqueo y se rechaza con ese error |

- **Recuperación del hueco** (ADR-0015 §4, «Cuándo»; ver «Desconexión de WebSocket», pasos 5 y 6): al empezar cada conexión, ya con el cierre reparado, la sesión deriva el log con el perfil de medición. Si el símbolo tiene un hueco pendiente, cada tick durable de esa conexión con hora estrictamente posterior al high-watermark donde empieza el hueco (`from_event_time_utc` − 1 ms) hace volver a derivarlo, también el que llega mientras deriva. Cuando el hueco tiene fin, toma de los ticks derivados la cotización de sus dos extremos, el tick del high-watermark y el primero posterior al cierre, y 2000 ms después pide la historia por esa conexión (`recoverHistory`, ver «Recuperación de historia»); si todavía no tiene fin, espera al tick siguiente. Pide una sola recuperación por conexión. Si la conexión termina o llega la parada antes de pedirla, no la pide: la pide la conexión siguiente o, tras la parada, la ejecución siguiente. Además:
  - si falta el tick de un extremo, no la pide: queda en stderr la alerta JSON `history_boundary_unavailable` con el símbolo (`symbol`), y el hueco sigue pendiente;
  - si un almacén no responde al volver a derivar el log, queda la alerta `source_log_unavailable` con el motivo saneado (`reason`), y lo intenta otra vez con el tick siguiente;
  - si el log tuvo un fallo de persistencia, no la pide ni avisa: el fallo ya quedó en el registro operativo, la conexión termina en pausa y la siguiente la pide. Igual si la lectura encuentra el log desactualizado tras volver a tomar el bloqueo, lo reabre y un almacén no responde: queda `persistence_unavailable`, como tras un fallo.
- **Cierre previsto** (`durationMs`, ADR-0015 §4 y §9): la duración de toda la sesión, en milisegundos enteros y positivos; con otro valor, `startDerivSession` lanza `TypeError` sin empezar nada. Nunca pasa a sus conexiones. El plazo cuenta desde el primer tick durable de la sesión, como el corte del smoke; sin ningún tick durable no empieza. Al cumplirse, la sesión pide `finish()` a la conexión en curso (ver «Cierres a pedido»), salvo que quede una recuperación pendiente: porque reconecta tras un cierre no pedido, porque espera el primer tick posterior al cierre o los 2000 ms, o porque la recuperación corre. Entonces pide `finish()` cuando esa recuperación termina, como mucho 300 000 ms después del plazo; pasado ese tope, para como con `stop`, y la recuperación se abandona sin persistir su resultado. Después de `finish()` no reconecta ni empieza ninguna recuperación: si la conexión se pierde antes de que responda `forget_all`, la sesión termina `completed`, y el hueco que deja esa pérdida queda pendiente para la ejecución siguiente. Si al cumplirse el plazo la conexión en curso ya había decidido otro cierre, por ejemplo porque el servidor cortó justo antes, `finish()` no hace nada (ver «Cierres a pedido»): la sesión lo trata como cualquier cierre no pedido, reconecta y recupera el hueco, y pide `finish()` a la conexión siguiente cuando termina esa recuperación.
- **Corte del smoke** (`interruptAfterMs`, ADR-0015 §9): opcional, en milisegundos enteros y positivos; con otro valor, `startDerivSession` lanza `TypeError` sin empezar nada. Cuenta desde el primer tick durable de la sesión y, al cumplirse, corta una sola vez la conexión en curso con `interrupt('smoke_interrupt')`. La sesión lo trata como cualquier cierre no pedido: espera, reconecta y recupera el hueco. No corta nada si en ese momento no hay conexión en curso o si ya se cumplió el plazo del cierre previsto, que cuenta desde el mismo tick: eso solo pasa con un corte que no es menor que la duración. Lo usa `data:smoke` con `--interrupt-after-seconds` (ver «Smoke público de Deriv»).
- **Parada** (`stop`, ADR-0015 §3, «Parada»): con una conexión en curso, la para (ver «Cierres a pedido»), y la sesión termina cuando esa conexión termina, sin reconectar, aunque termine `disconnected` porque `forget_all` no respondió. Si espera, entre intentos, para volver a tomar el bloqueo o para pasar el cierre anterior, corta la espera y no abre ningún socket. Una parada durante la carga de los esquemas termina cuando la carga acaba, sin tomar el bloqueo. Una recuperación de historia que espera sus 2000 ms ya no se pide, y una en curso se abandona sin persistir su resultado: el hueco sigue pendiente, porque un cierre pedido no lo cambia, y la ejecución siguiente lo recupera. Después de la parada la sesión termina `completed`, salvo que antes falle algo que no se puede reintentar (`failed`).
- **Retención** (`retentionMs`, desde el PR 5 de ADR-0015 §13, §7): opcional, en milisegundos enteros y positivos; con otro valor, `startDerivSession` lanza `TypeError` sin empezar nada. `ingest` pasará 23 horas; el smoke no la usa. Si al arrancar el evento durable más antiguo del log ya la cumplió, la sesión no conecta y termina `failed` con `retention_expired` (ver «Inicio»). Si no, cuenta desde ese evento, el primero del log. Con un log vacío, empieza a contar cuando la sesión hace durable su primer evento, desde el evento durable más antiguo del log. Casi siempre es ese mismo evento; si antes el índice confirmó otro aunque informó error, el log lo adoptó al reabrirse, y cuenta desde ese. Si el reloj retrocedió y el evento nuevo tiene una hora anterior, cuenta desde la más temprana. Cuando el reloj llega a esa hora más la retención, la sesión para exactamente como con `stop`: cierre pedido, segmento cerrado con `requested` y bloqueo suelto, también si en ese momento espera para reconectar. Un hueco que estaba pendiente queda pendiente, como tras cualquier parada: el log se va a borrar, así que esperar a su recuperación no sirve de nada. Espera en tramos de 60 000 ms como mucho y vuelve a mirar el reloj después de cada uno, así que un ajuste del reloj, o un temporizador que se retrasa porque el equipo se suspendió, se nota en un minuto como mucho.
- **Cursor** (`status`, desde el PR 5 de ADR-0015 §13, §6): la sesión lleva en memoria el `IngestionCursor` 1.0.0 de su símbolo, hecho solo de lo durable. `connection_id` es la conexión del último evento durable. `active_segment_index`, `source_event_count`, `last_durable_source_event_id` y `last_durable_observation_id` son el segmento abierto, los eventos durables, el último evento y el último raw del log; tras reabrirse, el log incluye los eventos que adoptó. `high_watermark_event_time_utc` es la hora más tardía de los ticks durables del símbolo: parte de la derivación del arranque y sube con cada tick durable y con cada derivación del log al empezar una conexión, así que un tick que el log adoptó al reabrirse entra desde la conexión siguiente. `updated_at_utc` es la hora de la escritura. La sesión lo escribe en `ingestion_cursors`, como la versión siguiente, después de cada `ConnectionClosed` durable, también uno reparado, y al terminar (ver «Al terminar»). Nunca lo escribe antes de que el log tenga un evento, y un evento que no quedó durable no lo cambia. Tampoco lo escribe sin el bloqueo tomado: como el latido, lo mira justo antes de escribirlo, así que no se escribe uno que esperaba detrás de otra escritura cuando se perdió el bloqueo, ni el del final si se perdió mientras se cerraba el segmento. Otro proceso pudo tomar el bloqueo y escribir sus cursores, y uno viejo que llegara después haría retroceder el último. No hace falta: el arranque siguiente deriva el estado del log, y un cursor que va por detrás del log no es un fallo (ver «Inicio»).
- **Latido** (`status` y un bloqueo con `backendPid`, desde el PR 5, §6): la sesión escribe en `ingestion_heartbeats` la fuente, su ejecución (`run_id`, un UUIDv7 que toma al empezar), la hora, el PID de PostgreSQL del bloqueo, el estado de la conexión y el backlog por conteo y bytes: los frames en la cola de la conexión en curso, o 0 sin conexión. Escribe uno al tomar el primer bloqueo (`connecting`), otro al empezar cada intento (`connecting`), otro con el `ConnectionOpened` durable (`connected`) y otro con el `ConnectionClosed` durable de esa conexión (`disconnected`), aunque el socket todavía no haya terminado de cerrarse: `ws` espera hasta 30 000 ms la respuesta del servidor a un cierre pedido. Si el cierre no quedó durable o la conexión no llegó a abrirse, el `disconnected` se escribe al terminar el intento. Además escribe uno cada 15 000 ms desde el de arranque, con el estado de ese momento. Nunca escribe sin el bloqueo tomado: mientras está perdido no escribe, tampoco uno que esperaba detrás de otra escritura, y con el bloqueo nuevo escribe con su PID. El smoke no escribe latidos: no tiene almacén, y su bloqueo no tiene PID.
- **Si el cursor o el latido no se pueden escribir**, la ingesta sigue, porque no es la durabilidad de los datos (ADR-0015 §6): queda en stderr la alerta JSON `ingestion_status_unavailable` con el motivo saneado (`reason`), el código o el nombre del error, nunca su mensaje, que en PostgreSQL puede llevar texto del servidor. `data:health` (PR 6) verá el latido vencido. Las escrituras van en orden, una detrás de otra.
- **Al terminar**, si el log está sano y el bloqueo sigue tomado, cierra el segmento abierto con motivo `requested`, también tras un fin `failed` de una conexión; con un fallo de las comprobaciones del arranque o `log_not_derivable` no escribe nada. Si acababa de tomar un bloqueo nuevo, antes reabre el log con él; si entonces el contenido del log no pasa sus comprobaciones, termina `failed` con `log_not_derivable` y deja el segmento abierto. Con `status`, después de cerrar el segmento escribe el cursor una última vez, con el segmento siguiente como abierto, si el bloqueo sigue tomado, y espera a que terminen las escrituras del cursor y del latido: así ninguna llega después de soltar el bloqueo ni después de `done`. Siempre suelta el bloqueo.
- **Resultado:** el fin (`completed`, o `failed` con `reason` y `detail`); si paró por la retención (`stopped_for_retention`); por cada conexión, su ID (`null` si no llegó a abrirse), su cierre y su fin; las esperas en milisegundos y en orden (`waits_ms`); cómo terminó cada recuperación de historia pedida, en orden (`recoveries`: lo que da `recoverHistory`, `abandoned` o `finished` con el `HistoryRecoveryResult`, si quedó durable, los intentos y las páginas); el resumen de los esquemas; y el catálogo, el `subscription.id` y el desfase con el servidor del último intento, cada uno `null` si ese intento no llegó a abrirse o no lo obtuvo.

### Smoke público de Deriv (`data:smoke`)

Desde F1.4b ([ADR-0012](../arquitectura/adr/0012-catalogo-y-adaptador-publico-de-deriv.md) §10), `pnpm run data:smoke -- --live` prueba el adaptador contra el canal público de Deriv. Desde el PR 4 de [ADR-0015](../arquitectura/adr/0015-reconexion-recuperacion-y-salud-f1-5.md) §13 (§9 y §10) corre la sesión de ingesta, que reconecta, y con `--interrupt-after-seconds` es el smoke de reconexión. Es opt-in y nunca es el único criterio de fusión, porque la red y el mercado no son deterministas. Su evidencia es la fecha, la release de esquemas y el resultado saneado (plan de Fase 1 §7); la de F1.4b está en `PROJECT_STATUS.md`.

- **Uso:** `pnpm run data:smoke -- --live [--symbol R_100] [--duration-seconds 120] [--interrupt-after-seconds <n>]`. La duración va de 1 a 3600 s y cuenta desde el primer tick durable de la sesión. El corte *n* es un entero de segundos, desde 1 y menor que la duración. Sin `--live`, o con una duración o un corte que no cumplen esto, no abre ninguna conexión y responde con un error de uso.
- **Recorrido:** el de «Sesión de ingesta» (ver «Adaptador público de Deriv»), con el perfil de medición, un bloqueo en memoria siempre tomado, la espera entre intentos con el azar de `node:crypto` y el cierre previsto a la duración pedida. Cada conexión pide `time` después de su primer tick. Si la conexión se pierde sin pedirlo, la sesión espera, reconecta y recupera la historia del hueco por la conexión nueva, y el cierre previsto espera a esa recuperación, como mucho 300 000 ms después del plazo. El plazo solo empieza con el primer tick durable: si Deriv no acepta la conexión, la sesión lo sigue intentando con la espera, y si la acepta pero no envía ningún tick, el plazo no empieza. Por eso el smoke pone su propio límite: si a la duración pedida, contada desde su inicio, todavía no llegó ningún tick durable, para la sesión como con `stop` y falla con `no_ticks` (ver `end`). Si la carga de los esquemas sigue en curso, la parada no la corta: la sesión termina cuando la carga acaba, que tiene su propio tiempo máximo. Como el límite cuenta desde el inicio, con una duración de pocos segundos la carga de los esquemas, la primera conexión y su primer tick tienen que caber en ella. No necesita variables `BUOH_*` ni servicios.
- **Corte** (`--interrupt-after-seconds`, ADR-0015 §9): *n* segundos después del primer tick durable de la sesión, la sesión corta una sola vez su propio socket con `interrupt` (`transport_error`, motivo `smoke_interrupt`; ver «Cierres a pedido»). Para la sesión es un cierre no pedido: espera, reconecta y recupera el hueco que deja el corte contra el canal real. Si en ese momento no hay conexión en curso, porque la sesión ya está reconectando tras otra pérdida, no corta nada, y el smoke falla. El plazo del cierre previsto no lo impide: cuenta desde el mismo tick, y *n* es menor que la duración.
- **Retención (ADR-0004 §13):** todo queda en la memoria del proceso (log, registro operativo, objetos, catálogo e incidencias) y se borra al terminar. Nada se escribe en disco, PostgreSQL ni almacenamiento de objetos, y nada se publica.
- **Salida:** antes compila el worker, con sus mensajes en stderr (`scripts/data-smoke.mjs`). stdout lleva una sola línea JSON saneada, sin payloads ni precios; las alertas de la sesión van a stderr:

| Campo | Contenido |
|---|---|
| `status` | `passed` si `end` es `completed`, llegó al menos un tick y el último intento cerró con el cierre previsto (`closure` con `requested`, motivo `requested` y durable). Además, sin corte, no hubo ninguna reconexión; con corte, hubo exactamente una, la que siguió al cierre `smoke_interrupt` de la primera conexión abierta, y `recovery.status` es `complete`. Si no, `failed` |
| `started_at_utc`, `finished_at_utc` y `duration_seconds` | inicio, fin y duración pedida |
| `interrupt_after_seconds` | el corte pedido, en segundos, o `null` |
| `schemas` | release y SHA-256 de `schemas.zip`, o `null` si no cargaron |
| `source`, `connector_version`, `symbol` y `symbol_name` | fuente, conector, código y nombre oficial del símbolo en el catálogo del último intento; el nombre es `null` si ese intento no llegó a abrirse o el símbolo no está en su catálogo |
| `catalog` | número de entradas y `content_sha256` del catálogo del último intento, o `null` si ese intento no llegó a abrirse o no lo obtuvo |
| `connections` | las conexiones que llegaron a abrirse (con `connection_id`). Un intento que no llegó a abrirse no cuenta: se ve en `reconnect_waits_ms` y, si fue el último, en `closure` `null` |
| `reconnections` | las conexiones abiertas después de la primera: la sesión solo vuelve a conectar después de una que terminó `disconnected` o `paused`, sin el cierre previsto, también la del corte. Un intento que no llegó a abrirse no cuenta |
| `reconnect_waits_ms` | las esperas antes de cada reintento, en milisegundos y en orden (ver «Desconexión de WebSocket») |
| `recovery` | la última recuperación de historia cuyo resultado quedó en el log: `status` (`complete`, `partial` o `unavailable`), `reason` (`null` con `complete`), `attempts`, `pages` (las del último intento) y `recovered_event_count` (`null` con `unavailable`), sin horas ni precios; o `null`. Una recuperación abandonada, que puede no haber pedido ninguna página, no cuenta |
| `frames` | de toda la sesión: frames de texto durables (`raw`), ticks normalizados, frames inválidos y respuestas pedidas por `msg_type` |
| `incidents` | de toda la sesión: frames inválidos por motivo (reglas 2.0.0), respuestas pedidas inválidas por motivo y registro operativo por tipo |
| `first_tick_delay_ms` | retraso del primer tick de la primera suscripción. Va aparte porque puede ser un tick que Deriv ya tenía al suscribirse, así que puede incluir su antigüedad |
| `delivery_delay_ms` y `tick_interval_ms` | `received_at_utc` menos la hora del tick, sin el primero de cada suscripción, y tiempo entre las horas de ticks consecutivos de una misma suscripción: mínimo, p50, p90, p99 y máximo, por rango más cercano. Con menos de 100 valores, p99 es el máximo. Tras una reconexión, la suscripción nueva suele repetir el último tick: ni su retraso ni el intervalo con la conexión anterior entran |
| `server_time_offset_ms` | recepción local menos la hora del servidor (`time`) en el último intento, o `null` si ese intento no llegó a abrirse o no la obtuvo |
| `end` | cómo terminó la sesión: `completed`, o `failed` con `reason` y `detail` (ver «Sesión de ingesta»). Si el smoke la paró porque a la duración pedida no había llegado ningún tick durable y la sesión terminó `completed`, es `failed` con `reason` `no_ticks` y, en `detail`, el motivo del último intento que terminó por su cuenta (por ejemplo `connect_failed`, `connect_timeout` o `remote_closed`) o `null`. Un fin `failed` de la propia sesión conserva su motivo |
| `closure` | el cierre del último intento (tabla de «Cierres»), o `null` si ese intento no llegó a abrirse |
| `source_time_resolution_ms` y `note` | Deriv da sus horas en segundos enteros, así que el retraso y el desfase medidos pueden superar a los reales hasta en 999 ms |

| Salida | Significado |
|---:|---|
| 0 | `passed` |
| 1 | `failed`: esquemas, catálogo inválido, símbolo ausente del catálogo, ningún tick durable a la duración pedida (`no_ticks`), un último cierre que no es el previsto, una reconexión no pedida, un corte que no llegó a cortar o una recuperación que no es `complete` (ver `end`, `closure`, `reconnections` y `recovery`); o `code: UNEXPECTED` |
| 2 | error de uso: `code: UsageError`, por ejemplo sin `--live` o con un corte que no es menor que la duración, o un símbolo que el esquema de la petición `ticks` no admite (`end.reason: request_invalid`) |

Una salida distinta de 0 sin línea JSON significa que falló la compilación o que se interrumpió el proceso; el detalle está en stderr. Sus números sirven para fijar después los umbrales live de retraso y de hueco, que el perfil de medición no lleva (ADR-0012 §8).

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
- para recuperar, el siguiente `ConnectionOpened` reabre el log desde el estado durable y, si queda durable, resuelve la condición (`persistence_restored`). Desde el PR 3 de ADR-0015 §13, el adaptador de Deriv repara antes el cierre que falte (ver «Adaptador público de Deriv», paso 2): la reparación reabre el log si había fallado y, si hace falta un cierre, lo escribe. Ese cierre reparado es el primer evento durable y resuelve la condición, sin reabrir la entrada. Si no hace falta un cierre, la resuelve el `ConnectionOpened`, como hasta ahora. La entrada siempre la reabre el `ConnectionOpened` durable. En F1.3b no se publican ni se reconcilian antes los segmentos pendientes (paso 6). La continuidad tampoco se verifica antes (ADR-0015 §10): la entrada se reabre con el `ConnectionOpened`, porque la historia se pide por esa misma conexión, y la continuidad se verifica después, con esa historia (ver «Desconexión de WebSocket», pasos 5 y 6). Nunca hay `healthy` antes.
- desde el PR 4 de ADR-0015 §13, reabrir el log separa un almacén que no responde de un contenido que no pasa sus comprobaciones. Si el almacenamiento de objetos o el índice no responden, se registra `persistence_unavailable` (etapa `source_event_index`, con el motivo saneado) y se puede reintentar, como hasta ahora. Si el contenido del segmento abierto no pasa sus comprobaciones (una fila fuera de su posición, un objeto alterado, que falta o mayor que su fila, o una línea que no es el source event JCS de su fila), no se reintenta (ADR-0004 §12): la reapertura lanza `LogIntegrityError` sin registrar nada, y se rechaza lo que la pedía, la reparación del cierre o el `ConnectionOpened`; una conexión en curso falla entonces como un error inesperado. Un objeto que falta no es un almacén caído: el índice lo confirmó y ya no está, como al leer un segmento cerrado. Cualquier otro error al reabrir, que no sea un almacén que no responde (por ejemplo, uno de programación), tampoco se reintenta como una pausa: se rechaza igual, sin registrar nada.

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

Desde el PR 4 de ADR-0015 §13, la parada de la sesión de ingesta (ADR-0015 §3, «Parada»; `SIGINT` o `SIGTERM` cuando llegue `ingest`) cierra la conexión con `requested`: si estaba suscrita, antes pide `forget_all`. Después cierra el segmento abierto con motivo `requested`, desde el PR 5 escribe el cursor (paso 2) si la sesión tiene su almacén, y suelta el bloqueo, y la sesión termina `completed`. Un cierre pedido no deja hueco pendiente (paso 5): el intervalo parado queda visible en el log como un cierre pedido seguido de la apertura siguiente, y no se recupera. Un hueco que ya estaba pendiente sigue pendiente, porque un cierre pedido no lo cambia (ADR-0015 §10). Rellenar la historia de una parada programada queda para el plan de alojamiento.

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

`pnpm run test:integration` ejecuta las pruebas de integración contra estos servicios con las mismas variables. Usa sus propios esquemas PostgreSQL (`buoh_integration`, `buoh_integration_log`, `buoh_integration_catalog` y `buoh_integration_status`) y los recrea en cada ejecución.

Tablas append-only del log y del registro (migración `0002_log_raw_first`):

- `source_event_index`: una fila por source event durable, con la clave de su objeto;
- `closed_source_segments`: el segmento cerrado, su objeto gzip y el motivo de cierre (`bytes`, `raw_frames`, `window` o `requested`);
- `operational_incidents` y `operational_conditions`: el registro operativo.

Desde F1.4b, la migración `0003_catalogo_y_respuestas_pedidas` añade dos tablas append-only más:

- `source_catalog_versions`: una versión del catálogo por fila, contigua desde 1 por fuente y formato. Su trigger rechaza una versión que no siga a la última o que no cambie el contenido. El documento JCS del snapshot vive en el objeto `sha256/<document_sha256>`, y al leer se comprueba su hash y que corresponda a su fila;
- `requested_response_incidents`: las incidencias de respuestas pedidas (siempre `invalid_source_frame`, con el `observation_id` del frame). Guardar otra vez la misma incidencia no añade fila.

Desde el PR 5 de [ADR-0015](../arquitectura/adr/0015-reconexion-recuperacion-y-salud-f1-5.md) §13 (§6), la migración `0004_cursor_y_latido` añade dos tablas append-only más, que guarda `PostgresIngestionStatusStore`:

- `ingestion_cursors`: una versión del `IngestionCursor` 1.0.0 por fila, contigua desde 1 por fuente y símbolo, con cada campo del cursor en su columna y el cursor entero en JCS (`cursor_jcs`). Su trigger rechaza una versión que no siga a la última. Al leer la última versión se comprueba que las columnas forman un cursor válido y que `cursor_jcs` es exactamente su JCS. `cursorSymbols` da además los símbolos que tienen algún cursor de una fuente, para la comprobación del símbolo al arrancar (ver «Inicio»);
- `ingestion_heartbeats`: un latido por fila, con la fuente, la ejecución (`run_id`), la hora (`observed_at_utc`), el PID de PostgreSQL de la sesión que tiene el bloqueo (`pg_backend_pid`), el estado de la conexión (`connecting`, `connected` o `disconnected`) y el backlog por conteo y bytes. El último latido de una fuente es el último escrito (`write_order`), aunque el reloj haya retrocedido.

La misma migración amplía el `CHECK` del motivo de `requested_response_incidents` con `history_inconsistent`, el de una página de historia incoherente, y conserva los seis de la `0003`. La sesión de ingesta, con este almacén, lee el cursor al arrancar (ver «Inicio») y escribe el cursor y el latido (ver «Adaptador público de Deriv», «Sesión de ingesta»). Todavía no hay un comando que la ejecute sobre PostgreSQL: `ingest` llega con el PR 5.

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
- Smoke público de Deriv opt-in (`pnpm run data:smoke -- --live`), con resultado saneado y fecha; nunca es el único criterio de fusión.
- Ensayo de reinicio y fallo de almacenamiento antes de cerrar Fase 1.
- Verificación de replay y `dataset_id` en la puerta de salida.

## Puerta de salida de Fase 1

Aplican exactamente la Definition of Done y matriz de evidencia del [plan de Fase 1](../plan/fase-1-fundacion-de-datos.md). Este runbook no define una puerta alternativa.
