# ADR-0015: Reconexión, recuperación de historia y salud del worker (F1.5)

- **Estado:** Aceptada
- **Fecha:** 2026-10-27
- **Ámbito:** Fase 1, entrega F1.5 (`F1-RECONNECT-001`, `F1-HEALTH-001` y la puerta de salida de Fase 1)
- **Decisores:** Dirección técnica de buoh, dentro de las decisiones del propietario registradas en `PROJECT_STATUS.md` (umbrales live sin inventar y datos live sin publicar)
- **Complementa:** [ADR-0004](0004-pipeline-y-reproduccion-de-datos-fase-1.md) §10, §12 y §13, [ADR-0005](0005-persistencia-local-y-formato-fisico-f1-3.md) §4 y [ADR-0012](0012-catalogo-y-adaptador-publico-de-deriv.md) §1, §5, §6, §8, §9 y §10. No cambia el alcance, el contrato de comandos ni la puerta de salida del [plan de Fase 1](../../plan/fase-1-fundacion-de-datos.md).

## Contexto

F1.5 cierra la Fase 1. El plan §6 pide:

- **`F1-RECONNECT-001`:** ante un `ConnectionClosed` no pedido, conservar la naturaleza del cierre y los símbolos afectados, pasar a `recovering`, reconectar con espera exponencial y jitter inyectable, consultar la historia por símbolo y volver a `healthy` solo con continuidad y persistencia verificadas. Si la recuperación no es posible, `event_gap_unresolved` y `degraded` o `paused`. Evidencia: prueba con reloj y transporte falsos, y un smoke vivo aparte.
- **`F1-HEALTH-001`:** `pnpm run data:health -- --json` emite un `HealthReport` validado con salud, conexión, backlog por conteo y bytes, últimos datos y dataset, y condiciones abiertas. Almacenamiento no disponible da `paused`; contrato o configuración incompatibles, `failed`; nunca `healthy` sin datos persistidos.
- **Puerta de salida (§9):** que reinicio, desconexión y fallo de persistencia no oculten pérdida ni emitan datos no durables, entre otras.

`PROJECT_STATUS.md` añade tres pendientes: el primer proceso que escriba el log de forma continua usa el log protegido por el bloqueo y vuelve a tomarlo o termina (pendiente 6 de F1.3); tras un fallo de persistencia el `ConnectionClosed` no queda en el log, y un evento que el índice confirmó aunque informó error se adopta al reabrir sin reconciliar (pendiente 7 de F1.3); y el `HistoryRecoveryResult` tiene que llegar después del primer tick posterior al cierre (pendiente 6 de F1.2).

Hechos comprobados el 2026-10-27:

**En el código.**

- El adaptador de Deriv termina en cada pérdida de conexión (`runDerivAdapter`, una sola `DerivConnection`). Su `ConnectionOpened` lleva siempre `supersedes_connection_id: null`, así que nunca resuelve `connection_lost`, y el `connection_id` se asigna al abrir el socket, antes de que la apertura sea durable.
- Con el log fallido, `RawFirstIngestor.receiveEvent` solo admite un `ConnectionOpened`, que es además lo único que lo reabre.
- `deriveMarketData` rechaza el perfil de medición antes de leer nada (ADR-0012 §8). Como el perfil de Deriv es de medición, hoy no se puede derivar la continuidad ni la salud de datos vivos.
- La cola en memoria solo existe dentro del proceso que ingiere. `SourceLock` expone la pérdida del bloqueo solo con su propiedad `held`, y su clave vale para toda la base de datos, no para un esquema.
- No hay comando de salud, ni proceso que ingiera de forma continua, ni tabla del `IngestionCursor`.

**`ticks_history` en la release fijada** (`production_v20260901_0`, con las entradas verificadas por su SHA-256):

- la petición exige `ticks_history` (el símbolo) y `end` (texto: `latest` o un epoch en segundos), y admite `start` (entero), `count` (entero, 1000 por defecto), `style` (`ticks` o `candles`), `adjust_start_time` y `subscribe`;
- la respuesta solo exige `echo_req` y `msg_type`. Con `style: ticks` trae `msg_type` `history`, y opcionales `history.times` (enteros), `history.prices` (números) y `pip_size`. El esquema advierte que la respuesta trae siempre el conjunto más reciente de ticks que cumple los parámetros.

**Pruebas cortas contra el canal público**, sin guardar datos ni mostrar precios:

- los límites del rango son inclusivos: un rango cuyos extremos caen en ticks devuelve esos dos ticks;
- `count` 5000 y 6000 devolvieron 1000 ticks sin error: con `R_100` (un tick cada 2 s), una petición cubre unos 33 minutos;
- si el rango tiene más ticks que `count`, la respuesta conserva los más recientes y corta los primeros;
- hay historia de al menos 40 días, y un `end` futuro devuelve hasta el último tick;
- un símbolo inexistente responde con `msg_type` `ticks_history` y `error.code` `InvalidSymbol`;
- 1000 ticks ocupan unos 18 KB, muy por debajo del límite de frame;
- con la suscripción abierta, una petición enviada al recibir cada tick no traía todavía ese tick en 2 de 10 casos (terminaba en el anterior). Pedida 2000 ms después, lo traía en los 10.

Ningún documento fija los números de la espera entre reconexiones ni cómo paginar la historia.

## Decisión

### 1. Conector y perfil

- `connector_version = "deriv-options-ws-1.1.0"`: añade `ticks_history` y la reconexión (ADR-0012 §1: cambiar las peticiones crea otra versión).
- El perfil de medición pasa a `deriv_options-measurement-v2-<símbolo>` y declara `history` en `non_tick_msg_types`: `active_symbols`, `forget_all`, `history`, `ping` y `time`. Sigue sin declarar `ticks_history` ni `ticks`: sus respuestas con `error` las registran las reglas 2.0.0 como `source_error_response`, como ya pasa con una suscripción fallida.
- `forget` no se usa: `forget_all` basta para el cierre previsto, y una conexión perdida se lleva su suscripción.
- Antes de conectar, el adaptador comprueba también la petición `ticks_history` contra su esquema, como las otras cinco.

### 2. Derivación en vivo sin umbrales

`deriveMarketData` acepta un perfil de medición para derivar el estado vivo (salud, condiciones y continuidad), nunca para publicar:

- sin `maximum_event_gap_ms`, la separación tras una reconexión nunca demuestra continuidad: todo símbolo pendiente tras un cierre no pedido necesita un `HistoryRecoveryResult` que cubra su hueco. Con los huecos es la política más estricta posible, y no inventa un umbral;
- sin `maximum_delivery_delay_ms` no evalúa `delivery_delayed`, así que el estado vivo no muestra retrasos. No cambia la salud, porque esa incidencia no abre condiciones;
- la publicación sigue rechazando el perfil de medición, ahora con su propia comprobación;
- los perfiles de publicación y los vectores no cambian.

La derivación expone cada hueco pendiente por símbolo: su inicio (`from_event_time_utc`, el high-watermark más 1 ms) y, cuando ya se conoce el primer tick posterior al cierre, su fin (`to_event_time_utc`, ese tick menos 1 ms). Así el worker pide exactamente el rango que las reglas aceptan, sin repetir su lógica. Una derivación que no puede completarse, por ejemplo con un log que cierra dos veces la misma conexión, deja `failed` con motivo `log_not_derivable`.

**Versionado.** No hace falta otra `quality_rule_version`: es una extensión para una entrada que antes se rechazaba. Con perfiles de publicación, las reglas 2.0.0 dan exactamente lo mismo, y nada de lo que se deriva con un perfil de medición se persiste ni se publica.

Esto sustituye el «nada se deriva con él» de ADR-0012 §8: lo que sigue prohibido es publicar.

### 3. Sesión de ingesta y reconexión

Una sesión carga los esquemas una vez, mantiene un solo `RawFirstIngestor` y abre una `DerivConnection` por intento. Decide según cómo terminó cada conexión:

| Fin de la conexión | Qué hace la sesión |
|---|---|
| `completed` (cierre pedido por la parada o por la duración del smoke) | termina, `completed` |
| `failed` (esquemas, catálogo inválido, símbolo ausente, suscripción rechazada, frame sin tamaño) | termina, `failed`. No reintenta con contenido no confiable (ADR-0004 §12) |
| `disconnected` (cualquier motivo) | reconecta tras la espera |
| `paused` (persistencia, límites, almacén del catálogo, entrada cerrada) | reconecta tras la espera; el siguiente `ConnectionOpened` durable resuelve las condiciones operativas |

- **Espera.** En el intento *n* (desde 1), *d* = mín(60 000, 1000 · 2^(n−1)) ms, y la sesión espera *d*/2 + `random()` · *d*/2, con `random` inyectado en [0, 1): entre 500 ms al principio y entre 30 000 y 60 000 ms con el tope. El contador vuelve a 1 solo después de 60 000 ms seguidos de conexión con ticks durables, para que una conexión que muere enseguida no reintente cada segundo.
- **Conexión anterior.** Es la última conexión con `ConnectionOpened` durable en el log, nunca la de la memoria de la sesión. Un intento cuyo `ConnectionOpened` no quedó durable no existe para el log: no se supera ni se repara. La sesión la vuelve a leer del log al arrancar, después de cada reapertura del log y después de volver a tomar el bloqueo, porque en los segundos que tarda en notarse la pérdida del bloqueo otro proceso puede haber escrito.
- **`supersedes_connection_id`.** Cada `ConnectionOpened` apunta a la conexión anterior. Solo es `null` con el log sin conexiones.
- **Cierre no registrado** (pendiente 7 de F1.3). Antes de abrir el socket siguiente, si la conexión anterior no tiene `ConnectionClosed` durable, la sesión lo persiste: `closure_type: transport_error`, motivo `close_not_recorded`, los símbolos de la sesión como afectados y la hora de la detección. Pasa tras un fallo de persistencia y al arrancar después de una caída del proceso. El `RawFirstIngestor` gana una operación para eso:
  1. reabre el log si había fallado;
  2. vuelve a leer la conexión anterior. Si el índice confirmó el cierre original aunque informó error, el log ya lo tiene y no hay nada que reparar;
  3. escribe el cierre sin reabrir la entrada, que sigue cerrada hasta el `ConnectionOpened`.

  Si el cierre no queda durable, la sesión no abre el socket: vuelve a esperar y lo intenta de nuevo. Así las reglas abren `connection_lost` y la continuidad pendiente, la pérdida no queda oculta y nunca se cierra dos veces la misma conexión. Al reabrir, el cursor y el high-watermark de la sesión también se vuelven a leer del log, así que incluyen los eventos adoptados.
- **Parada.** Con `SIGINT` o `SIGTERM`, la sesión abandona una recuperación en curso sin persistir su resultado, pide `forget_all`, cierra con `requested`, cierra el segmento abierto (motivo `requested`) y suelta el bloqueo. Un hueco pendiente sigue pendiente, porque un cierre pedido no lo cambia, y la próxima ejecución lo recupera.
- **Bloqueo** (ADR-0012 §9, pendiente 6 de F1.3). Se toma antes de abrir el log, y si lo tiene otro proceso, la sesión no arranca. Las escrituras pasan por `lockedSourceLogStore` sobre el bloqueo vigente. Si se pierde, las escrituras fallan, la conexión termina en `paused` y, antes de reconectar, la sesión toma un bloqueo nuevo. Si lo tiene otro proceso, termina con `failed` y motivo `source_lock_taken`; si PostgreSQL no responde, espera y reintenta.

### 4. Recuperación de historia

- **Cuándo.** En una conexión nueva, cuando llega durable el primer tick posterior al cierre de un símbolo con hueco pendiente, la sesión vuelve a derivar el log y obtiene el rango del hueco (§2). Si su fin aún no se conoce, porque ese tick no es posterior al high-watermark del cierre (la suscripción suele repetir el último tick), espera al siguiente. Pide la historia 2000 ms después, porque la historia puede no tener todavía el tick recién recibido (prueba del contexto).
- **Petición.** `ticks_history` con el símbolo, `style: ticks`, `count: 1000`, `start` = el segundo del high-watermark donde empieza el hueco y `end` = el segundo del primer tick posterior, los dos incluidos. Mientras una página no vacía no llegue a `start`, pide la anterior, con `end` = su primer tick − 1 s; para con una página vacía, al llegar a `start` o tras 50 páginas, unas 27 horas de `R_100`. No depende del tope de 1000 que se observó.
- **Raw primero.** Cada respuesta se persiste raw antes de interpretarse (`history` es un tipo declarado). Quien la pidió la comprueba como una respuesta pedida (ADR-0012 §6): contra el esquema de respuesta y, además, que traiga `history.times`, `history.prices` y `pip_size`, que `times` y `prices` tengan la misma longitud, que los tiempos sean enteros estrictamente crecientes y que caigan dentro de lo pedido. Si no cumple, deja su incidencia con motivo `schema_validation_failed` o `history_inconsistent`.
- **Resultado.** Un `HistoryRecoveryResult` con la conexión que recuperó, `from_event_time_utc` = high-watermark + 1 ms y `to_event_time_utc` = primer tick posterior − 1 ms:
  - `complete`: todas las páginas son válidas, cubren desde `start` y traen los dos extremos, el tick del high-watermark y el primero posterior, con la misma cotización que se recibió (en decimal canónico con el `pip_size` de la respuesta). `recovered_event_count` cuenta los ticks entre los dos extremos, sin incluirlos;
  - `partial`: alguna página válida, pero no se cubrió todo: tope de páginas (`history_page_limit`), una página posterior con error (`history_error_response`), inválida (`history_invalid`) o sin respuesta (`history_timeout`), falta un extremo (`history_boundary_missing`) o un extremo trae otra cotización (`history_boundary_mismatch`);
  - `unavailable`: la primera página falla, con uno de esos motivos.
- **Reintentos.** `history_error_response`, `history_timeout` y `history_boundary_missing` se reintentan dos veces más en la misma conexión, con 30 000 ms entre intentos. Solo se persiste el resultado del último intento.
- **Tiempo de espera.** Cada página espera 15 000 ms, pero vencer no cierra la conexión, a diferencia de las demás peticiones: el flujo de ticks sigue.
- **Conexión perdida o parada.** Si la conexión se pierde durante la recuperación, no se persiste ningún resultado. La siguiente conexión recupera el rango que den entonces las reglas: un cierre nuevo conserva el inicio del hueco y espera un fin nuevo. El cierre previsto por duración (el smoke) espera a que termine la recuperación en curso; la parada no (§3).
- **Orden.** El resultado pasa por la misma cola que los frames, así que siempre queda en el log después del primer tick posterior al cierre (pendiente 6 de F1.2).
- **Ticks recuperados.** En F1.5 no se convierten en `MarketTick`: quedan en el raw durable de las respuestas de historia. `origin: history_recovery` llegará cuando se publiquen datasets vivos.

### 5. Estado al arrancar

Después de tomar el bloqueo y abrir el log, la sesión deriva el estado vivo de todo el log durable con el perfil de medición: la conexión anterior y si se cerró, los huecos pendientes, el high-watermark y el símbolo. El costo crece con el log; en Fase 1 lo acota la retención de 24 horas (§7). Antes de ingerir en producción durante semanas hará falta un punto de control, con el plan de alojamiento.

La sesión no arranca, con `failed`, si:

- el log se escribió con otro `connector_version` (`connector_version_mismatch`) o no se puede derivar (`log_not_derivable`);
- el símbolo del log, el del último cursor o, si no hay cursor, el de sus ticks, no es el pedido (`symbol_mismatch`);
- el último cursor apunta a un evento que no está en el índice (`cursor_ahead_of_log`): el log perdió datos confirmados.

En los tres casos hace falta un log nuevo.

### 6. Cursor y latido

- La migración `0004` crea dos tablas append-only:
  - `ingestion_cursors`: versiones del `IngestionCursor` 1.0.0 por fuente y símbolo, contiguas desde 1, como el catálogo;
  - `ingestion_heartbeats`: el latido de cada ejecución, con la fuente, la ejecución (UUIDv7), la hora, el PID de PostgreSQL de la sesión que tiene el bloqueo (`pg_backend_pid()`), el estado de la conexión (`connecting`, `connected` o `disconnected`) y el backlog por conteo y bytes.
- La sesión lleva el cursor de cada símbolo en memoria, y solo avanza con eventos durables. Lo persiste después de cada `ConnectionClosed` durable, incluidos los reparados (contratos de dominio, `IngestionCursor`), y al parar. Sus lectores son el arranque (§5) y `data:health` (§8): el símbolo del log y la comprobación contra el índice.
- El latido se escribe al arrancar, en cada cambio de estado de la conexión (`connecting` al intentar, `connected` con el `ConnectionOpened` durable y `disconnected` al cerrar) y cada 15 000 ms, siempre que el bloqueo siga tomado (`held`).
- Un fallo al escribir el cursor o el latido no detiene la ingesta, porque no es la durabilidad de los datos: deja la alerta `ingestion_status_unavailable` en stderr, y `data:health` verá el latido vencido.

### 7. Captura viva continua y retención

- `pnpm --filter @buoh/market-data-worker run ingest -- --live [--symbol R_100]` ejecuta la sesión con PostgreSQL y almacenamiento de objetos. Es un script del paquete, como `fixture:publish` y `db:migrate`, fuera del contrato de comandos raíz del plan §5. Es opt-in, como el smoke: sin `--live` responde con un error de uso y no abre conexiones. Ingiere un solo símbolo.
- Rechaza `BUOH_DEPLOYMENT_ENVIRONMENT` `staging` y `production`: desplegar no está autorizado en Fase 1 (ADR-0006).
- **Retención (ADR-0004 §13).** Es la primera vez que buoh guarda datos reales fuera de la memoria, así que la retención de 24 horas se impone, no se pide:
  - `ingest` rechaza el esquema `public` y el bucket `buoh-local` por defecto: la captura necesita un `BUOH_POSTGRES_SCHEMA` y un `BUOH_S3_BUCKET` propios, que no comparte con los datos sintéticos;
  - no arranca si el evento durable más antiguo del log tiene más de 24 horas (`retention_expired`), y para con un cierre pedido cuando las alcanza;
  - como las tablas no admiten borrados, al terminar se borran el esquema y el bucket enteros. El runbook dará los comandos con el PR 5;
  - nada se publica. La retención en producción llegará con el plan de alojamiento.

  El smoke sigue en memoria. ADR-0012 descartó un esquema y un bucket desechables para él porque el smoke no necesita persistir; la captura continua existe precisamente para persistir.
- Guarda en el almacenamiento de objetos el esquema `ticks_response.schema.json` de la release, con la clave de su SHA-256 fijado, para que `data:health` derive sin descargar nada.

### 8. `data:health`

`pnpm run data:health -- --json [--symbol R_100]` es un proceso aparte, de solo lectura, que nunca toma el bloqueo. Lo ejecuta `scripts/data-health.mjs`, que deja stdout limpio, como `data-replay.mjs` (ADR-0003).

- **Entradas:**
  - el log durable, derivado con el perfil de medición y el esquema que guardó la ingesta;
  - el registro operativo;
  - el último latido y el último cursor;
  - si hay escritor vivo: la sesión que tiene el bloqueo de la fuente según `pg_locks`, con el mismo PID que el último latido de este esquema;
  - el último dataset activo de la fuente en el entorno.
- **Reglas:**
  1. argumentos o variables de entorno inválidos del propio comando: código 2 y un error saneado en stderr, sin informe, como `data:replay` y `data:smoke`;
  2. lo incompatible que se observa: otro conector en el log, un esquema guardado que falta o no coincide con su SHA-256 fijado con el log no vacío, otro símbolo o un log que no se puede derivar → `failed`, con el motivo saneado en stderr;
  3. PostgreSQL o el almacenamiento de objetos no responden → `paused`;
  4. sin escritor vivo: `connection_state` `disconnected`, backlog 0 y salud como mínimo `paused`, porque nada procesa la entrada. Si la última conexión no tiene cierre durable, se deriva como si ya tuviera el cierre `close_not_recorded` que registrará el próximo arranque (§3), así que muestra `connection_lost`;
  5. con escritor vivo y un latido de hace 45 000 ms o menos: el backlog sale del latido, y la conexión también si el latido es posterior al último evento de conexión del log; si no, sale del log. Con una conexión que no es `connected`, la salud es como mínimo `recovering`;
  6. con escritor vivo y un latido más viejo, o de otro PID: salud como mínimo `paused`, porque el proceso no avanza;
  7. en los demás casos, la salud es la de la derivación (§2), con las condiciones del registro operativo sumadas, y nunca `healthy` sin raw durable (contrato `HealthReport`).
- **Salida:** una línea JSON con el `HealthReport`. Código 0 si la salud es `healthy`, 1 si es otra y 2 en la regla 1.

### 9. Smoke de reconexión

`pnpm run data:smoke -- --live --interrupt-after-seconds <n>` corta su propio socket una vez, *n* segundos después del primer tick (`transport_error`, motivo `smoke_interrupt`). La sesión reconecta y recupera la historia contra el canal real, en memoria como siempre (ADR-0012 §10), y el cierre previsto espera a que la recuperación termine (§4). Pasa si reconectó, la recuperación fue `complete` y el cierre final fue el previsto. *n* tiene que ser menor que la duración pedida. El resultado añade las reconexiones, la espera y el resultado de la recuperación, sin precios. Es el smoke vivo aparte que pide `F1-RECONNECT-001`.

### 10. Cambios en el runbook

El runbook es la fuente canónica de la operación. Cada PR de §13 lo actualiza con lo que implementa, en estos puntos:

| Procedimiento del runbook | Cambio |
|---|---|
| «Inicio», paso 3 (recuperar cursor, high-watermark y segmento) | el estado se deriva del log (§5); el último cursor da el símbolo y se comprueba contra el índice |
| «Desconexión de WebSocket», paso 5 (historia «según cursor») | el rango sale de la derivación del log (§2 y §4) |
| «Desconexión de WebSocket», paso 6 (validar la recuperación antes de liberar frames vivos) | los frames vivos no se retienen, porque eso chocaría con raw primero y con los límites de la cola. La salud sigue en `recovering` hasta que el resultado queda en el log, y los consumidores que exigen continuidad la miran |
| «Límite de fuente excedido», paso 5, y «Almacenamiento no disponible», paso 6 (verificar la continuidad antes de reabrir) | la entrada se reabre con el `ConnectionOpened`, porque la historia se pide por esa misma conexión, y la continuidad se verifica después. Nunca hay `healthy` antes |
| «Despliegue o reinicio programado», paso 5 (confirmar la continuidad antes de `healthy`) | la parada cierra con `requested`, que no deja hueco pendiente: el intervalo parado queda visible en el log como un cierre pedido seguido de una apertura, y no se recupera. Un hueco que ya estaba pendiente sigue pendiente (§3). Rellenar la historia de una parada programada queda para el plan de alojamiento |
| «Reporte y evidencia» (conservar la transición de salud) | la salud no se guarda: se deriva en cualquier momento de los eventos durables y del registro operativo con `data:health` |
| «Adaptador público de Deriv» y «Una sola instancia por fuente» | reconexión, reparación de cierres, `ticks_history`, bloqueo vigente y comando `ingest` |

### 11. Pruebas

- Offline, sin red, reloj real ni azar: socket, reloj, temporizador, IDs y `random` falsos, y almacenes en memoria. Cubren la tabla de §3, la espera y su reinicio, la conexión anterior tras un `ConnectionOpened` no durable, la reparación con el log fallido y con el cierre adoptado, el bloqueo perdido, cada estado y motivo de §4 y las reglas de §8, incluida la ventana entre una reconexión y su latido.
- `pnpm run test:integration`: las tablas de la migración `0004`, el cursor contra el índice y `data:health` contra PostgreSQL y el almacenamiento S3-compatible locales. El endpoint de Deriv está fijado, así que la sesión se prueba con su fábrica de sockets inyectada.
- Los vectores v1 no cambian.

### 12. Puerta de salida

Un último PR reúne la evidencia en un entorno desechable, con los servicios locales:

1. captura viva continua con `ingest`;
2. desconexión: el smoke de §9 y su recuperación `complete`;
3. reinicio sin aviso: matar la ingesta y arrancarla otra vez: cierre `close_not_recorded`, recuperación y vuelta a `healthy`;
4. reinicio programado: parar con `SIGTERM` y arrancar: cierre `requested`, apertura que lo supera y ningún hueco oculto;
5. fallo de persistencia: parar unos segundos el almacenamiento de objetos y, aparte, PostgreSQL, durante la ingesta: `persistence_unavailable`, `paused`, reparación, reconexión, recuperación y `healthy`;
6. ningún dato no durable emitido: los ticks entregados durante los ensayos son exactamente los de frames durables;
7. incidencias visibles tras reiniciar: las incidencias y condiciones derivadas del log antes y después de cada reinicio, y `data:health` en cada paso;
8. replay: los datasets sintéticos con el mismo `dataset_id`.

La Fase 1 pasa a `done` en `PROJECT_STATUS.md` solo con esa evidencia y con la decisión del propietario sobre el orden entre la Fase 1B y la Fase 2.

### 13. Secuencia de entrega

Cada PR es pequeño, con su revisión semántica:

1. Esta ADR y los contratos de dominio.
2. En `packages/domain`: derivación con el perfil de medición, huecos pendientes por rango y entradas nuevas de la salud (condiciones operativas, latido y escritor vivo).
3. En el worker: conector 1.1.0, perfil v2, `ticks_history` y recuperación en `DerivConnection`, `supersedes_connection_id` y la reparación de cierres en el `RawFirstIngestor`.
4. En el worker: la sesión con reconexión, espera, parada, estado al arrancar y bloqueo, y el smoke de reconexión.
5. En el worker: migración `0004` con cursor y latido, el comando `ingest` con su retención y los comandos de borrado en el runbook.
6. `pnpm run data:health -- --json`.
7. La evidencia de la puerta de salida.

## Consecuencias

- Una desconexión, una caída del proceso o un fallo de persistencia dejan siempre un cierre no pedido en el log: la pérdida se ve como `connection_lost` y continuidad pendiente hasta que la historia la cubre.
- Con el perfil de medición, toda reconexión pide historia, aunque el hueco sea de un solo tick, y el estado vivo nunca muestra `delivery_delayed`. Es más tráfico que con un umbral, pero no inventa uno.
- Tras cada reconexión, mientras falta la recuperación, la salud es `recovering` con `open_condition_types` vacío: el pendiente 2 de F1.2 deja de ser raro.
- Un hueco que la historia no cubre deja `degraded` hasta que una recuperación `complete` del mismo rango lo resuelva. F1.5 no la vuelve a intentar después de sus reintentos.
- Los ticks recuperados existen solo como raw hasta la publicación de datasets vivos.
- El arranque, cada recuperación y `data:health` leen todo el log, acotado por las 24 horas de retención. Antes de ingerir en producción durante semanas hará falta un punto de control.
- La captura viva exige un esquema y un bucket propios y se detiene a las 24 horas.
- Entran dos tablas append-only más. El rol de solo inserción y lectura que pide el pendiente 4 de F1.3 antes de desplegar también las cubrirá.

## Alternativas descartadas

| Alternativa | Motivo |
|---|---|
| Umbrales provisionales en el perfil de Deriv | Los umbrales live no se inventan (decisión del propietario). |
| Fijar ya los umbrales con el smoke de F1.4b | Dos minutos de medición no bastan para fijarlos. |
| Repetir en el worker la lógica de continuidad del dominio | Podría desviarse de las reglas; la derivación ya da el rango. |
| Tomar la conexión anterior de la memoria de la sesión | Un `ConnectionOpened` que no quedó durable dejaría abierto para siempre el `connection_lost` de la conexión real. |
| Convertir ya los ticks de la historia en `MarketTick` | Cambia el normalizador sin consumidor: los datos vivos no se publican, y el raw ya los conserva. |
| Retener los ticks vivos hasta persistir la recuperación | Choca con raw primero y con los límites de la cola (§10). |
| Recuperar la historia de cada parada programada | Exigiría que un cierre pedido dejara un hueco pendiente, otra regla. Queda para el plan de alojamiento. |
| Calcular la salud dentro del proceso de ingesta y guardarla | Exigiría derivar todo el log una y otra vez, o repetir las reglas en el proceso. |
| Informar siempre backlog 0 en `data:health` | No sería un dato observado. |
| Descargar los esquemas desde GitHub en `data:health` | La salud dependería de GitHub. |
| Persistir el cursor con cada tick o con cada latido | Miles de filas por día y símbolo, sin ningún lector que las necesite. |
| No reparar los cierres no registrados | Una caída o un fallo de persistencia ocultarían el hueco. |
| Reconectar sin espera o con espera fija | ADR-0004 y el runbook piden no crear un bucle agresivo, y la espera exponencial reparte los reintentos. |
| Pedir a quien captura que borre los datos a mano en 24 horas | Es la primera captura persistente de datos reales; la retención se impone. |

## Referencias verificadas

- [Ticks History de Deriv](https://developers.deriv.com/docs/data/ticks-history/)
- [Release `production_v20260901_0` de los esquemas de Deriv](https://github.com/deriv-com/deriv-api-schemas/releases/tag/production_v20260901_0)
- [WebSocket público de Deriv](https://developers.deriv.com/docs/options/ws-public/)

El contenido de fuentes externas fue reformulado para cumplir restricciones de licencia.
