# ADR-0015: Reconexión, recuperación de historia y salud del worker (F1.5)

- **Estado:** Aceptada
- **Fecha:** 2026-10-27
- **Ámbito:** Fase 1, entrega F1.5 (`F1-RECONNECT-001`, `F1-HEALTH-001` y la puerta de salida de Fase 1)
- **Decisores:** Dirección técnica de buoh, dentro de las decisiones del propietario registradas en `PROJECT_STATUS.md` (umbrales live sin inventar y datos live sin publicar)
- **Complementa:** [ADR-0004](0004-pipeline-y-reproduccion-de-datos-fase-1.md) §10, §12 y §13, [ADR-0005](0005-persistencia-local-y-formato-fisico-f1-3.md) §4 y [ADR-0012](0012-catalogo-y-adaptador-publico-de-deriv.md) §1, §5, §8 y §9. No cambia el alcance ni la puerta de salida de Fase 1.

## Contexto

F1.5 cierra la Fase 1. El [plan](../../plan/fase-1-fundacion-de-datos.md) §6 pide:

- **`F1-RECONNECT-001`:** ante un `ConnectionClosed` no pedido, conservar la naturaleza del cierre y los símbolos afectados, pasar a `recovering`, reconectar con espera exponencial y jitter inyectable, consultar la historia por símbolo y volver a `healthy` solo con continuidad y persistencia verificadas. Si la recuperación no es posible, `event_gap_unresolved` y `degraded` o `paused`. Evidencia: prueba con reloj y transporte falsos, y un smoke vivo aparte.
- **`F1-HEALTH-001`:** `pnpm run data:health -- --json` emite un `HealthReport` validado con salud, conexión, backlog por conteo y bytes, últimos datos y dataset, y condiciones abiertas. Almacenamiento no disponible da `paused`; contrato o configuración incompatibles, `failed`; nunca `healthy` sin datos persistidos.
- **Puerta de salida (§9):** que reinicio, desconexión y fallo de persistencia no oculten pérdida ni emitan datos no durables, entre otras.

`PROJECT_STATUS.md` añade tres pendientes: el primer proceso que escriba el log de forma continua usa el log protegido por el bloqueo y vuelve a tomarlo o termina (pendiente 6 de F1.3); tras un fallo de persistencia el `ConnectionClosed` no queda en el log (pendiente 7 de F1.3); y el `HistoryRecoveryResult` tiene que llegar después del primer tick posterior al cierre (pendiente 6 de F1.2).

Hechos comprobados el 2026-10-27:

**En el código.**

- El adaptador de Deriv termina en cada pérdida de conexión (`runDerivAdapter`, una sola `DerivConnection`) y su `ConnectionOpened` lleva siempre `supersedes_connection_id: null`, así que nunca resuelve `connection_lost`.
- `deriveMarketData` rechaza el perfil de medición antes de leer nada (ADR-0012 §8). Como el perfil de Deriv es de medición, hoy no se puede derivar la continuidad ni la salud de datos vivos.
- La cola en memoria solo existe dentro del proceso que ingiere. `SourceLock` expone la pérdida del bloqueo solo con su propiedad `held`.
- No hay comando de salud, ni proceso que ingiera de forma continua, ni tabla del `IngestionCursor`.

**`ticks_history` en la release fijada** (`production_v20260901_0`, entradas ya verificadas por su SHA-256):

- la petición exige `ticks_history` (el símbolo) y `end` (texto: `latest` o un epoch en segundos), y admite `start` (entero), `count` (entero), `style` (`ticks` o `candles`), `adjust_start_time` y `subscribe`;
- la respuesta de `style: ticks` tiene `msg_type` `history`, `history.times` (enteros) y `history.prices` (números), y `pip_size`. El esquema advierte que la respuesta trae siempre el conjunto más reciente de ticks que cumple los parámetros.

**Prueba corta contra el canal público**, sin guardar datos ni precios:

- los límites del rango son inclusivos: un rango cuyos extremos caen en ticks devuelve esos dos ticks;
- `count` 5000 y 6000 devolvieron 1000 ticks sin error: el máximo efectivo es 1000 por petición, unos 33 minutos de `R_100` (un tick cada 2 s);
- si el rango tiene más ticks que `count`, la respuesta conserva los más recientes y corta los primeros;
- hay historia de al menos 40 días; un `end` futuro devuelve hasta el último tick, que ya incluye el tick recién recibido por la suscripción;
- un símbolo inexistente responde con `msg_type` `ticks_history` y `error.code` `InvalidSymbol`;
- 1000 ticks ocupan unos 18 KB, muy por debajo del límite de frame.

Ningún documento fija los números de la espera entre reconexiones ni cómo paginar la historia.

## Decisión

### 1. Conector y perfil

- `connector_version = "deriv-options-ws-1.1.0"`: añade `ticks_history` y la reconexión (ADR-0012 §1: cambiar las peticiones crea otra versión).
- El perfil de medición pasa a `deriv_options-measurement-v2-<símbolo>` y declara `history` en `non_tick_msg_types`: `active_symbols`, `forget_all`, `history`, `ping` y `time`. Sigue sin declarar `ticks_history` ni `ticks`: sus respuestas con `error` las registran las reglas 2.0.0 como `source_error_response`, como ya pasa con una suscripción fallida.
- `forget` no se usa: `forget_all` basta para el cierre previsto, y una conexión perdida se lleva su suscripción.
- Antes de conectar, el adaptador comprueba también la petición `ticks_history` contra su esquema, como las otras cinco.

### 2. Derivación en vivo sin umbrales

`deriveMarketData` acepta un perfil de medición para derivar el estado vivo (salud, condiciones y continuidad), nunca para publicar:

- sin `maximum_delivery_delay_ms` no evalúa `delivery_delayed`;
- sin `maximum_event_gap_ms`, la separación tras una reconexión nunca demuestra continuidad: todo símbolo pendiente tras un cierre no pedido necesita un `HistoryRecoveryResult` que cubra su hueco. Es la política más estricta posible y no inventa un umbral;
- la publicación sigue rechazando el perfil de medición, ahora con su propia comprobación;
- los perfiles de publicación y los vectores no cambian.

Además, la derivación expone cada hueco pendiente por símbolo: su inicio (`from_event_time_utc`, el high-watermark más 1 ms) y, cuando ya se conoce el primer tick posterior al cierre, su fin (`to_event_time_utc`, ese tick menos 1 ms). Así el worker pide exactamente el rango que las reglas aceptan, sin repetir su lógica.

Esto sustituye el «nada se deriva con él» de ADR-0012 §8: lo que sigue prohibido es publicar.

### 3. Sesión de ingesta y reconexión

Una sesión carga los esquemas una vez, mantiene un solo `RawFirstIngestor` y abre una `DerivConnection` por intento. Decide según cómo terminó cada conexión:

| Fin de la conexión | Qué hace la sesión |
|---|---|
| `completed` (cierre pedido por la parada o por la duración del smoke) | termina, `completed` |
| `failed` (esquemas, catálogo inválido, símbolo ausente, suscripción rechazada, frame sin tamaño) | termina, `failed`. No reintenta con contenido no confiable (ADR-0004 §12) |
| `disconnected` (cualquier motivo) | reconecta tras la espera |
| `paused` (persistencia, límites, almacén del catálogo, entrada cerrada) | reconecta tras la espera; el siguiente `ConnectionOpened` durable resuelve las condiciones operativas |

- **Espera.** En el intento *n* (desde 1), *d* = mín(60 000, 1000 · 2^(n−1)) ms, y la sesión espera *d*/2 + `random()` · *d*/2, con `random` inyectado en [0, 1). Nunca espera menos de 500 ms, y con el tope reconecta como mucho una vez cada 30 a 60 s. El contador vuelve a 1 cuando una conexión recibe su primer tick durable.
- **`supersedes_connection_id`.** Cada `ConnectionOpened` apunta a la conexión anterior de la fuente: la de la sesión o, al arrancar, la última del log. Solo es `null` con el log vacío.
- **Cierre no registrado.** Antes de un `ConnectionOpened`, si la conexión anterior no tiene `ConnectionClosed` durable, la sesión lo persiste: `closure_type: transport_error`, motivo `close_not_recorded`, los símbolos de la sesión como afectados y la hora de la detección. Pasa tras un fallo de persistencia (pendiente 7 de F1.3) y al arrancar después de una caída del proceso. Si al reabrir el log ya tiene el cierre original, porque el índice lo confirmó aunque informó error, no se repara. Así las reglas abren `connection_lost` y la continuidad pendiente, y la pérdida no queda oculta.
- **Parada.** Con `SIGINT` o `SIGTERM`, la sesión pide `forget_all`, cierra con `requested`, cierra el segmento abierto (motivo `requested`) y suelta el bloqueo.
- **Bloqueo** (ADR-0012 §9, pendiente 6 de F1.3). Se toma antes de abrir el log, y si lo tiene otro proceso, la sesión no arranca. Las escrituras pasan por `lockedSourceLogStore` sobre el bloqueo vigente. Si se pierde, las escrituras fallan, la conexión termina en `paused` y, antes de reconectar, la sesión toma un bloqueo nuevo. Si lo tiene otro proceso, termina con `failed` y motivo `source_lock_taken`; si PostgreSQL no responde, espera y reintenta.

### 4. Recuperación de historia

- **Cuándo.** En una conexión nueva, cuando llega durable el primer tick posterior al cierre de un símbolo con hueco pendiente, la sesión vuelve a derivar el log y obtiene el rango del hueco (§2). Si su fin aún no se conoce, porque ese tick no es posterior al high-watermark del cierre, espera al siguiente. Pide la historia 2000 ms después, para que la fuente ya la tenga.
- **Petición.** `ticks_history` con el símbolo, `style: ticks`, `count: 1000`, `start` = el segundo del high-watermark donde empieza el hueco y `end` = el segundo del primer tick posterior, los dos incluidos. Si una página trae 1000 ticks y no llega a `start`, pide la anterior, con `end` = su primer tick − 1 s. Como mucho 50 páginas, unas 27 horas de `R_100`.
- **Raw primero.** Cada respuesta se persiste raw antes de interpretarse (`history` es un tipo declarado). Quien la pidió la comprueba como una respuesta pedida (ADR-0012 §6): contra el esquema de respuesta y, además, que `times` y `prices` tengan la misma longitud, que los tiempos sean enteros estrictamente crecientes y que caigan dentro de lo pedido. Si no cumple, deja su incidencia con motivo `schema_validation_failed` o `history_inconsistent`.
- **Resultado.** Un `HistoryRecoveryResult` con la conexión que recuperó, `from_event_time_utc` = high-watermark + 1 ms y `to_event_time_utc` = primer tick posterior − 1 ms:
  - `complete`: todas las páginas son válidas, cubren desde `start` y traen los dos extremos (el tick del high-watermark y el primero posterior), así que la historia coincide con lo recibido en sus dos bordes. `recovered_event_count` cuenta los ticks entre los dos extremos, sin incluirlos;
  - `partial`: alguna página válida, pero no se cubrió todo: tope de páginas (`history_page_limit`), una página posterior con error (`history_error_response`), inválida (`history_invalid`) o sin respuesta (`history_timeout`), o falta un extremo (`history_boundary_missing`);
  - `unavailable`: la primera página falla, con uno de esos motivos.
- **Reintentos.** Un resultado que no es `complete`, salvo `history_page_limit` y `history_invalid`, se reintenta dos veces más en la misma conexión, con 30 000 ms entre intentos. Solo se persiste el resultado del último intento.
- **Tiempo de espera.** Cada página espera 15 000 ms, pero vencer no cierra la conexión, a diferencia de las demás peticiones: el flujo de ticks sigue.
- **Conexión perdida.** Si la conexión se pierde durante la recuperación, no se persiste ningún resultado. La siguiente conexión recupera el rango que den entonces las reglas: un cierre nuevo conserva el inicio del hueco y espera un fin nuevo.
- **Orden.** El resultado pasa por la misma cola que los frames, así que siempre queda en el log después del primer tick posterior al cierre (pendiente 6 de F1.2).
- **Ticks recuperados.** En F1.5 no se convierten en `MarketTick`: quedan en el raw durable de las respuestas de historia. `origin: history_recovery` llegará cuando se publiquen datasets vivos.

### 5. Estado al arrancar

Después de tomar el bloqueo y abrir el log, la sesión deriva el estado vivo de todo el log durable con el perfil de medición: la última conexión y si se cerró, los huecos pendientes y el high-watermark. El costo crece con el log. En Fase 1 es aceptable porque los datos vivos de desarrollo duran como mucho 24 horas (§7). Antes de ingerir en producción durante semanas hará falta un punto de control, con el plan de alojamiento.

Un log escrito con otro `connector_version` no se puede derivar con el perfil actual. La sesión termina con `failed` y motivo `connector_version_mismatch`, y hace falta un log nuevo.

### 6. Cursor y latido

- La migración `0004` crea dos tablas append-only:
  - `ingestion_cursors`: versiones del `IngestionCursor` 1.0.0 por fuente y símbolo, contiguas desde 1, como el catálogo;
  - `ingestion_heartbeats`: el latido de cada ejecución, con la fuente, la ejecución (UUIDv7), la hora, el estado de la conexión (`connecting`, `connected` o `disconnected`) y el backlog por conteo y bytes.
- La sesión lleva el cursor de cada símbolo en memoria, y solo avanza con eventos durables. Lo persiste en una transacción, junto con un latido, cada 15 000 ms, después de cada `ConnectionClosed` durable (contratos de dominio, `IngestionCursor`) y al parar.
- Al arrancar, el último cursor de cada símbolo se compara con el log: su último evento durable tiene que estar en el índice. Si no está, el log perdió datos confirmados y la sesión termina con `failed` y motivo `cursor_ahead_of_log`.
- Un fallo al escribir el cursor o el latido no detiene la ingesta, porque no es la durabilidad de los datos: deja la alerta `ingestion_status_unavailable` en stderr, y `data:health` verá el latido vencido.

### 7. Captura viva continua y retención

- `pnpm --filter @buoh/market-data-worker run ingest -- --live [--symbol R_100]` ejecuta la sesión con PostgreSQL y almacenamiento de objetos. Es opt-in, como el smoke: sin `--live` responde con un error de uso y no abre conexiones. Ingiere un solo símbolo.
- Rechaza `BUOH_DEPLOYMENT_ENVIRONMENT` `staging` y `production`: desplegar no está autorizado en Fase 1 (ADR-0006).
- **Retención (ADR-0004 §13).** Los datos vivos que capture en `development` o `test` van a un `BUOH_POSTGRES_SCHEMA` y un bucket propios, se borran en 24 horas y nunca se publican. Como las tablas no admiten borrados, se borran el esquema y el bucket enteros; el runbook dirá cómo. La retención en producción llegará con el plan de alojamiento.
- Guarda en el almacenamiento de objetos el esquema `ticks_response.schema.json` de la release, con la clave de su SHA-256 fijado, para que `data:health` derive sin descargar nada.

### 8. `data:health`

`pnpm run data:health -- --json [--symbol R_100]` es un proceso aparte, de solo lectura, que nunca toma el bloqueo. Lo ejecuta `scripts/data-health.mjs`, que deja stdout limpio, como `data-replay.mjs` (ADR-0003).

- **Entradas:**
  - el log durable, derivado con el perfil de medición y el esquema que guardó la ingesta;
  - el registro operativo;
  - el último latido y el último cursor;
  - si hay un escritor vivo: la sesión que tiene el bloqueo de la fuente, según `pg_locks`;
  - el último dataset activo de la fuente en el entorno.
- **Reglas**, en orden:
  1. configuración inválida, versión o contrato incompatibles (otro conector en el log, o un esquema guardado que falta o no coincide con su SHA-256 fijado cuando el log no está vacío) → `failed`;
  2. PostgreSQL o el almacenamiento de objetos no responden → `paused`;
  3. sin escritor vivo: `connection_state` `disconnected` y backlog 0. Si la última conexión no tiene cierre durable, se deriva como si ya tuviera el cierre `close_not_recorded` que registrará el próximo arranque (§3), así que muestra `connection_lost` y `recovering`;
  4. con escritor y latido de hace 45 000 ms o menos: la conexión y el backlog salen del latido;
  5. con escritor y latido más viejo: salud como mínimo `paused`, porque el proceso no avanza;
  6. la salud es la de la derivación (§2), con las condiciones del registro operativo sumadas, y nunca `healthy` sin raw durable (contrato `HealthReport`).
- **Salida:** una línea JSON con el `HealthReport`. Código 0 si la salud es `healthy`, 1 si es otra, y 2 si es un error de uso, sin informe.

### 9. Smoke de reconexión

`pnpm run data:smoke -- --live --interrupt-after-seconds <n>` corta su propio socket una vez, *n* segundos después del primer tick (`transport_error`, motivo `smoke_interrupt`). La sesión reconecta y recupera la historia contra el canal real, en memoria como siempre (ADR-0012 §10). Pasa si reconectó, la recuperación fue `complete` y el cierre final fue el previsto. El resultado añade las reconexiones, la espera y el resultado de la recuperación, sin precios. Es el smoke vivo aparte que pide `F1-RECONNECT-001`.

### 10. Pruebas

- Offline, sin red, reloj real ni azar: socket, reloj, temporizador, IDs y `random` falsos, y almacenes en memoria. Cubren la tabla de §3, la espera, la reparación de cierres, el bloqueo, cada estado de §4 y las reglas de §8.
- `pnpm run test:integration`: las tablas de la migración `0004`, el cursor contra el índice y `data:health` contra PostgreSQL y el almacenamiento S3-compatible locales. El endpoint de Deriv está fijado, así que la sesión se prueba con su fábrica de sockets inyectada.
- Los vectores v1 no cambian.

### 11. Puerta de salida

Un último PR reúne la evidencia en un entorno desechable, con los servicios locales:

1. captura viva continua con `ingest`;
2. desconexión: el smoke de §9 y su recuperación `complete`;
3. reinicio: matar la ingesta sin aviso y arrancarla otra vez: cierre `close_not_recorded`, recuperación y vuelta a `healthy`, con `data:health` antes y después;
4. fallo de persistencia: parar el almacenamiento de objetos unos segundos durante la ingesta y volver a levantarlo: `persistence_unavailable`, `paused`, reconexión, reparación, recuperación y `healthy`;
5. replay: los datasets sintéticos con el mismo `dataset_id`.

La Fase 1 pasa a `done` en `PROJECT_STATUS.md` solo con esa evidencia y con la decisión del propietario sobre el orden entre la Fase 1B y la Fase 2.

### 12. Secuencia de entrega

Cada PR es pequeño, con su revisión semántica:

1. Esta ADR y los contratos de dominio.
2. En `packages/domain`: derivación con el perfil de medición, huecos pendientes por rango y entradas nuevas de la salud (condiciones operativas y escritor vivo).
3. En el worker: conector 1.1.0, perfil v2, `ticks_history` y recuperación en `DerivConnection`, `supersedes_connection_id` y cierres no registrados.
4. En el worker: la sesión con reconexión, espera, parada, estado al arrancar y bloqueo, y el smoke de reconexión.
5. En el worker: migración `0004` con cursor y latido, y el comando `ingest`.
6. `pnpm run data:health -- --json`.
7. La evidencia de la puerta de salida.

## Consecuencias

- Una desconexión, una caída del proceso o un fallo de persistencia dejan siempre un cierre no pedido en el log: la pérdida se ve como `connection_lost` y continuidad pendiente hasta que la historia la cubre.
- Con el perfil de medición, toda reconexión pide historia, aunque el hueco sea de un solo tick. Es más tráfico que con un umbral, pero no inventa uno.
- Un hueco que la historia no cubre deja `degraded` hasta que una recuperación `complete` del mismo rango lo resuelva. F1.5 no la vuelve a intentar después de sus reintentos.
- Los ticks recuperados existen solo como raw hasta la publicación de datasets vivos.
- El arranque, cada recuperación y `data:health` leen todo el log. Antes de ingerir en producción durante semanas hará falta un punto de control.
- `data:health` depende de un latido para el backlog y la conexión; sin escritor vivo informa backlog 0, porque no existe ninguna cola.
- Entran dos tablas append-only más. El rol de solo inserción y lectura que pide el pendiente 4 de F1.3 antes de desplegar también las cubrirá.

## Alternativas descartadas

| Alternativa | Motivo |
|---|---|
| Umbrales provisionales en el perfil de Deriv | Los umbrales live no se inventan (decisión del propietario). |
| Fijar ya los umbrales con el smoke de F1.4b | Dos minutos de medición no bastan para fijarlos. |
| Repetir en el worker la lógica de continuidad del dominio | Podría desviarse de las reglas; la derivación ya da el rango. |
| Convertir ya los ticks de la historia en `MarketTick` | Cambia el normalizador sin consumidor: los datos vivos no se publican, y el raw ya los conserva. |
| Retener los ticks vivos hasta persistir la recuperación (runbook, «Desconexión», paso 6, al pie de la letra) | Choca con raw primero y con los límites de la cola. Los consumidores ven `recovering` hasta que la recuperación queda en el log. |
| Calcular la salud dentro del proceso de ingesta y guardarla | Exigiría derivar todo el log una y otra vez, o repetir las reglas en el proceso. |
| Informar siempre backlog 0 en `data:health` | No sería un dato observado. |
| Descargar los esquemas desde GitHub en `data:health` | La salud dependería de GitHub. |
| Pedir `count` 5000 | La fuente devuelve como mucho 1000 por petición. |
| Persistir el cursor con cada tick | Unas 43 200 filas por día y símbolo, sin ningún lector que las necesite. |
| No reparar los cierres no registrados | Una caída o un fallo de persistencia ocultarían el hueco. |
| Reconectar sin espera o con espera fija | ADR-0004 y el runbook piden no crear un bucle agresivo, y la espera exponencial reparte los reintentos. |

## Referencias verificadas

- [Ticks History de Deriv](https://developers.deriv.com/docs/data/ticks-history/)
- [Release `production_v20260901_0` de los esquemas de Deriv](https://github.com/deriv-com/deriv-api-schemas/releases/tag/production_v20260901_0)
- [WebSocket público de Deriv](https://developers.deriv.com/docs/options/ws-public/)

El contenido de fuentes externas fue reformulado para cumplir restricciones de licencia.
