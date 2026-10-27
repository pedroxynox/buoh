# ADR-0012: Catálogo y adaptador público de Deriv (F1.4b)

- **Estado:** Aceptada
- **Fecha:** 2026-10-25
- **Ámbito:** Fase 1, entrega F1.4b (`F1-CATALOG-001`, `F1-SOURCE-001` y `pnpm run data:smoke`)
- **Decisores:** Dirección técnica de buoh, dentro de las decisiones del propietario para F1.4b registradas en `PROJECT_STATUS.md`
- **Complementa:** [ADR-0003](0003-lenguajes-y-limites.md) (bibliotecas de la fuente Deriv), [ADR-0004](0004-pipeline-y-reproduccion-de-datos-fase-1.md) §2, §6, §7, §12 y §13, [ADR-0005](0005-persistencia-local-y-formato-fisico-f1-3.md) y [ADR-0007](0007-varias-fuentes-y-metatrader-5.md) §2. No cambia el alcance ni la puerta de salida de Fase 1.
- **Complementada por:** [ADR-0015](0015-reconexion-recuperacion-y-salud-f1-5.md) (F1.5): conector `deriv-options-ws-1.1.0` con `ticks_history` (§1 y §5), la respuesta de historia como respuesta pedida (§6), reconexión con el bloqueo por fuente (§9), el smoke de reconexión (§10) y, en §8, la derivación del estado vivo con el perfil de medición, que sigue sin publicar

## Contexto

F1.4b conecta buoh con el canal público de Deriv, solo para escuchar: el catálogo de símbolos (`active_symbols`) y el flujo de ticks, sin credenciales, sin operar y sin publicar datos vivos. `PROJECT_STATUS.md` y la [especificación de pendientes](../../plan/especificacion-de-pendientes.md) (P-F1-01 a P-F1-03) dejan abiertos estos puntos:

- la forma del registro de snapshot del catálogo y qué incidencia deja un catálogo inválido;
- el validador draft-04 y el cliente WebSocket, dos dependencias nuevas;
- cómo se registran los errores dentro de las respuestas pedidas (pendiente 3 de F1.4a);
- cómo llegan al registro operativo el límite de frame y el de la cola, que actúan antes del `RawFirstIngestor`;
- una sola instancia por fuente (pendiente 6 de F1.3);
- un perfil de medición que nunca pueda publicar;
- cómo se cumple el borrado en 24 horas de los datos del smoke.

### Hechos verificados el 2026-10-25

**Release de esquemas fijada (ADR-0004 §2).** `schemas.zip` de `production_v20260901_0` se descargó de su release en GitHub:

- su SHA-256 coincide con el fijado (`adaab0ac…e7c3`);
- cumple los límites de ADR-0004 §7: 139 891 bytes, 127 entradas, 541 091 bytes expandidos y una entrada máxima de 241 565 bytes;
- las 14 entradas que usa buoh (`<operación>_request.schema.json` y `<operación>_response.schema.json` de `active_symbols`, `ticks`, `ticks_history`, `ping`, `time`, `forget` y `forget_all`) son draft-04. El resto mezcla draft-04 y draft-07, más un `rest-api-openapi.json`;
- las peticiones usan la palabra clave propia `auth_required`, y las respuestas de `ticks` y `ticks_history`, `examples`. Ninguna valida nada.

**Licencia.** El repositorio `deriv-com/deriv-api-schemas` no declara licencia. Sin licencia, buoh no puede copiar sus archivos en Git.

**Respuesta de `active_symbols` en la release fijada.** Cada entrada exige estos diez campos y no admite otros:

| Campos | Valores |
|---|---|
| `underlying_symbol` y `underlying_symbol_name` | texto: código y nombre oficial |
| `underlying_symbol_type`, `market`, `submarket` y `subgroup` | texto |
| `pip_size` | número: la variación mínima, por ejemplo `0.01` |
| `exchange_is_open` e `is_trading_suspended` | 0 o 1 |
| `trade_count` | entero |

El `pip_size` del catálogo no es el del tick: en `ticks_response` es el número de decimales, por ejemplo `2`. Los esquemas no describen el objeto `error`. Una respuesta con `error` cumple el esquema de `active_symbols`, `ping`, `time` y `forget_all`, porque su raíz admite campos extra; no cumple el de `ticks`, cuyo `msg_type` solo admite `tick`.

**Prueba corta contra el canal público** (`wss://api.derivws.com/trading/v1/options/ws/public`), sin guardar datos ni precios:

- **Conexión:** sin autenticación, en menos de 100 ms, con frames de texto y sin extensiones si el cliente no ofrece compresión.
- **Catálogo:** `{"active_symbols":"brief"}` devolvió 89 entradas (unos 23 KB) que cumplen el esquema fijado. Mercados: `synthetic_index`, `indices`, `cryptocurrency`, `forex` y `commodities`.
- **Volatility 100:** `R_100` se llama «Volatility 100 Index» (`synthetic_index` / `random_index` / `synthetics`, `pip_size` 0.01), y `1HZ100V`, «Volatility 100 (1s) Index».
- **Contador:** `trade_count` cambió en las 89 entradas entre dos consultas separadas por 8 s.
- **Números:** los `pip_size` llegan sin exponente, de `0.1` a `0.00001`.
- **Ticks:** con `{"ticks":"R_100","subscribe":1}` llegó uno cada 2 s, de 288 bytes como máximo, que cumple el esquema fijado. Cada tick repite el `req_id` de la suscripción y trae `subscription.id`.
- **Otras respuestas:** `time`, `ping` y `forget_all` cumplen sus esquemas y devuelven el `req_id`.
- **Errores:** un símbolo inexistente responde con `msg_type` `ticks` y `error.code` `InvalidSymbol`; un método desconocido, con `msg_type` `error` y `UnknownMethod`.

**Cliente WebSocket.**

- El `WebSocket` global de Node 24 (undici) no tiene un límite configurable de tamaño de mensaje y reúne el mensaje entero antes de entregarlo ([undici #4899](https://github.com/nodejs/undici/issues/4899)).
- `ws` 8.22.0 (MIT, 2026-09-26) rechaza con `maxPayload` un mensaje cuyo tamaño declarado lo supera, al leer la cabecera del fragmento que cruza el límite y antes de leer su contenido: error `WS_ERR_UNSUPPORTED_MESSAGE_LENGTH` y cierre 1009. El error no trae el tamaño. El receptor (`WebSocket#_receiver`, propiedad interna) guarda en `_totalPayloadLength` la suma de las longitudes declaradas hasta ese fragmento: en un mensaje sin fragmentar, su tamaño. Una longitud de 64 bits mayor que 2^53 − 1 falla antes, con `WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH`, sin dejar ese valor.

**Validador y lector de ZIP.**

- `ajv-draft-04` 1.0.0 (MIT, del equipo de Ajv, sin dependencias, requiere `ajv` ^8.5.0) compila las 14 entradas en modo estricto con el `ajv` 8.20.0 del repositorio, si `auth_required` y `examples` se registran como anotaciones.
- `fflate` 0.8.3 (MIT, sin dependencias) lee el archivo fijado y da el tamaño declarado de cada entrada antes de descomprimirla.

## Decisión

### 1. Fuente, conector y operaciones

- `source = "deriv_options"`: el canal de opciones de Deriv, distinto de los futuros servidores Deriv MT5 (ADR-0007 §1).
- `connector_version = "deriv-options-ws-1.0.0"`. Cambiar las peticiones, los límites o el transporte crea otra versión.
- El adaptador pide `active_symbols` (`"brief"`), `ticks` con `subscribe: 1`, `ping`, `time` y `forget_all` (`"ticks"`). `ticks_history` y `forget` llegan con la reconexión (F1.5).
- El primer smoke usa `R_100`, «Volatility 100 Index» en el catálogo (decisión del propietario: un solo índice sintético, con el nombre exacto del catálogo). Antes de suscribirse, el adaptador comprueba que el código existe en el último snapshot válido.

### 2. Esquemas de Deriv: descarga, límites y validador

- El adaptador descarga `schemas.zip` de la release fijada en tiempo de ejecución, con los límites de ADR-0004 §7: 5 242 880 bytes y 30 000 ms. Comprueba el SHA-256 antes de abrirlo.
- Con `fflate` cuenta las entradas y suma sus tamaños declarados antes de descomprimir. Solo extrae las 14 que usa. Superar cualquier límite, un hash distinto o una entrada que falte abortan la carga: se registra `source_limit_exceeded` (`schema_archive`, `schema_entry`, `schema_entries` o `schema_expanded`) cuando corresponde, y la salud pasa a `failed`.
- buoh no copia los esquemas de Deriv en Git, porque su repositorio no tiene licencia. Las pruebas usan esquemas draft-04 sintéticos propios con los campos que buoh lee, y archivos ZIP sintéticos.
- **Validador por dialecto (ADR-0007 §2).** El validador se elige por el `$schema` del documento de esquema:
  - 2020-12: `Ajv2020`, como hoy en los vectores;
  - draft-04: `ajv` con `ajv-draft-04`;
  - cualquier otro: la creación del perfil falla.

  Ambos en modo estricto. En draft-04 solo se admiten como anotación `auth_required` y `examples`, que aparecen en la release fijada. El replay obtiene el mismo validador del esquema que el dataset ya publica, sin configuración externa.
- El esquema de fuente de los ticks es `ticks_response.schema.json`, y el `source_schema_sha256` del manifiesto es el SHA-256 de su JCS. El del catálogo es el SHA-256 del JCS de `active_symbols_response.schema.json`.
- El normalizador 2.0.0 ya lee las rutas de Deriv (`tick.symbol`, `tick.epoch`, `tick.quote`, `tick.pip_size` y `echo_req.ticks`), y sigue siendo uno por versión.
- El adaptador valida cada petición propia contra su esquema de petición antes de enviarla.

### 3. Transporte WebSocket

`ws` 8.22.0, con:

- `maxPayload: 1_048_576`;
- `perMessageDeflate: false`: sin compresión, las longitudes declaradas son los bytes del mensaje y no hay bombas de descompresión;
- `handshakeTimeout: 10_000` y sin redirecciones.

Se descarta el `WebSocket` global de Node porque reúne el mensaje entero antes de que buoh pueda rechazarlo, y ADR-0004 §7 prohíbe cargar contenido fuera del límite.

- Cada mensaje de texto recibe su `observation_id` (UUIDv7 inyectado) y su `received_at_utc` (reloj inyectado) al llegar.
- Un mensaje binario no puede guardarse como `RawSourceFrame`, que solo admite texto UTF-8. Cierra la entrada con `ConnectionClosed` (`transport_error`, motivo `binary_frame`); Deriv no los usa.
- **Frame demasiado grande.** Si `ws` corta un mensaje por `maxPayload`, el adaptador lee `_receiver._totalPayloadLength`: la suma de las longitudes declaradas hasta el fragmento que supera el límite, que en un mensaje sin fragmentar es su tamaño. Ese valor, siempre observado y mayor que el máximo, es el `observed_value` de `source_limit_exceeded` (`websocket_frame`). La entrada se pausa y se cierra como en §4.
  - Son dos propiedades internas, así que la versión de `ws` queda fijada. Una prueba con un servidor local en el mismo proceso comprueba que existen y valen lo declarado, con un mensaje entero y con uno fragmentado.
  - Si una versión futura las quita, o si el error es `WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH`, el adaptador no inventa un tamaño: termina con salud `failed`.
  - El tope propio del `RawFirstIngestor` sigue como segunda barrera.

### 4. Cola en memoria y pausa desde el transporte

- **Cola.** Entre `ws` y el ingestor hay una cola con un solo consumidor que espera cada llamada al `RawFirstIngestor` antes de entregar el siguiente frame. Su límite es de 1000 eventos y 33 554 432 bytes, y se aplica el primero que se alcance.
- **Al llenarse** (ADR-0004 §12):
  1. deja de aceptar y vacía la cola;
  2. cierra el socket;
  3. pausa el ingestor y registra `source_limit_exceeded` (`in_memory_queue_events` o `in_memory_queue_bytes`) con el `observation_id` del frame que no cupo;
  4. persiste el `ConnectionClosed`.

  Los frames que esperaban no se persisten: ADR-0004 §12 exige dejar de emitir de inmediato. La pérdida queda en la incidencia, en el `ConnectionClosed` y en la continuidad pendiente.
- **Pausa desde el transporte.** `RawFirstIngestor` gana un método para que el transporte registre una violación de límite y pause la entrada, como ya hace `receiveFrame` con el frame de más de 1 MiB. Ese método solo escribe en el registro operativo, nunca en el log. Lo usan el corte de `ws` y la cola, y la llamada pasa por el mismo consumidor de la cola, después del frame en curso, así que el ingestor sigue recibiendo una sola llamada a la vez.
- **Cierre.** Después de una violación de límite, el adaptador persiste `ConnectionClosed` con `closure_type: transport_error` y el recurso como motivo, igual que con un mensaje binario. No es un cierre pedido: se pierden datos, así que las reglas abren `connection_lost` y dejan pendiente la continuidad de los símbolos afectados, que la reconexión de F1.5 verificará (ADR-0004 §12, paso 6). La prueba de F1.3b que cierra con `requested` usa un valor de prueba, no una regla. Reabrir sigue exigiendo un `ConnectionOpened` durable.

### 5. Correlación, keepalive y tiempos de espera

- Cada petición lleva un `req_id` entero creciente por conexión, desde 1, y espera respuesta 15 000 ms con reloj inyectable.
- Una respuesta se empareja por `req_id` y por el `msg_type` que espera cada petición:

  | Petición | `msg_type` esperado | Si la respuesta trae `error` o no cumple su esquema |
  |---|---|---|
  | `active_symbols` | `active_symbols` | §7: no crea versión; sin snapshot válido, salud `failed` |
  | `ticks` con `subscribe` | `tick`; si falla, `ticks` con `error` | solo para la respuesta `ticks` con `error`: la ingesta termina con salud `failed` y el cierre es `requested`, porque sin suscripción no hay datos que perder. Un `tick` que no cumple el esquema sigue las reglas 2.0.0 |
  | `ping` | `ping` | como un keepalive sin respuesta: cierre `timeout` |
  | `time` | `time` | solo lo pide el smoke, que da el desfase como no disponible |
  | `forget_all` | `forget_all` | se registra y el cierre previsto sigue (`requested`) |

  Un método desconocido responde con `msg_type` `error`. Los ticks de la suscripción repiten su `req_id`; el adaptador guarda `subscription.id`.
- **Raw primero.** El adaptador interpreta una respuesta solo después de que el ingestor confirme su frame como durable. Como el transporte conserva el texto que entregó, no necesita releer el log; esto resuelve el pendiente 3 de F1.4a sin cambiar el sink `nonTickFrame`.
- **Keepalive.** Un `ping` cada 45 000 ms. Sin respuesta en 15 000 ms, el adaptador cierra la conexión con `closure_type: timeout`; una petición vencida hace lo mismo. Reconectar llega en F1.5.
- **Perfil Deriv.** `non_tick_msg_types` declara `active_symbols`, `forget_all`, `ping` y `time`, que son las respuestas pedidas que no son ticks.
  - No declara `ticks`: una suscripción fallida llega con ese `msg_type` y un `error`, y las reglas 2.0.0 ya la registran como `source_error_response`, atribuida por `echo_req.ticks`.
  - Tampoco declara `error`, la respuesta a un método desconocido, que las reglas tratan igual.

### 6. Errores en respuestas pedidas

Las reglas 2.0.0 no miran las respuestas declaradas. Quien pidió una respuesta declarada la comprueba contra el esquema de respuesta de su operación en la release fijada. Si trae `error`, no cumple ese esquema o, en el catálogo, no se puede convertir en snapshot (§7), registra un `DataQualityIncident` con:

- `incident_type: invalid_source_frame`, esquema de incidencias 2.0.0, reglas 2.0.0 y severidad `error`;
- `observed_ref`: el `observation_id` del frame; `observed_at_utc`: su `received_at_utc`; `related_refs: []`;
- `symbol: null`, porque ninguna respuesta declarada es de un símbolo. Es una diferencia deliberada con la atribución de las reglas 2.0.0, que acabaría en el único símbolo del perfil;
- `evidence`: `raw_payload_sha256` y el motivo, por ejemplo `source_error_response` o `schema_validation_failed`.

Así, la incidencia se puede volver a derivar del frame durable. Se guarda en una tabla PostgreSQL append-only propia (`requested_response_incidents`), fuera de los datasets y del registro operativo, porque no abre condiciones ni cambia la salud. Las consecuencias para el flujo están en §5 y §7.

### 7. Catálogo: forma del snapshot y versiones

La forma exacta de `SourceCatalogSnapshot` 1.0.0 está en los [contratos de dominio](../contratos-de-dominio.md#sourcecatalogsnapshot) y se implementa en `packages/contracts`. En resumen:

- se deriva de un frame durable de respuesta a `active_symbols`, con su procedencia (`observation_id`, `raw_payload_sha256`, `received_at_utc`, `connector_version`, release y hash del esquema) y su identidad derivada (`snapshot_id`);
- conserva los nombres y valores oficiales sin traducirlos, con los números como lexema decimal;
- deja fuera `trade_count`, que cambia en cada consulta y haría de cada consulta una versión nueva. El raw lo conserva;
- conserva `exchange_is_open` e `is_trading_suspended`, que siguen el horario de cada mercado: habrá una versión nueva cuando un mercado abra, cierre o se suspenda, porque el catálogo publicado cambia;
- `content_sha256` es el hash de secuencia de las entradas ordenadas por código.

**Versiones.**

- Un índice PostgreSQL append-only asigna versiones contiguas (1, 2, 3…) por fuente y formato de catálogo.
- Solo se guarda un snapshot si su `content_sha256` difiere del de la última versión. Volver a un contenido anterior también crea versión.
- El documento JCS del snapshot va al almacenamiento de objetos con clave por contenido (ADR-0004 §6).

**Catálogo inválido.**

- **Qué lo invalida.** Las comprobaciones van en este orden, y la primera que falla da el motivo, para que la incidencia se derive siempre igual:
  1. trae `error`: `source_error_response`;
  2. no cumple el esquema fijado: `schema_validation_failed`;
  3. la lista falta o está vacía: `catalog_empty`;
  4. un `pip_size` trae exponente: `catalog_exponent_not_supported`;
  5. una entrada no cumple el contrato del snapshot, por ejemplo un código vacío: `catalog_entry_invalid`;
  6. un código se repite: `catalog_duplicate_symbol`.
- **Qué pasa:** no crea versión, y el último snapshot válido sigue vigente. Además deja la incidencia de §6 con ese motivo.
- **Sin snapshot válido:** el adaptador no se suscribe y termina con salud `failed`.

Así se cumple la aceptación de `F1-CATALOG-001`. El catálogo no decide el universo comercial, que sigue pendiente en `PROJECT_STATUS.md`.

### 8. Perfil de medición

- El perfil de calidad admite el campo opcional `purpose: "measurement"`. Sin él, el perfil es de publicación, como hoy, así que los perfiles existentes y los vectores conservan sus bytes y sus hashes.
- Un perfil de medición usa las reglas 2.0.0 y no lleva umbrales de retraso ni de hueco: los umbrales live no se inventan, y nada se deriva con él.
- `deriveMarketData` y la publicación lo rechazan, así que nunca publica (ADR-0004 §13). El ingestor y el normalizador lo aceptan.

### 9. Una sola instancia por fuente

- El adaptador entrega los frames de uno en uno, desde una cola con un solo consumidor.
- Todo proceso que escriba el log de una fuente en PostgreSQL toma antes un bloqueo de sesión `pg_try_advisory_lock` derivado del nombre de la fuente. Lo toma en un cliente dedicado que no vuelve al pool, porque el pool cierra los clientes inactivos y el bloqueo se iría con ellos, y lo mantiene mientras ingiere. Si otro proceso lo tiene, no arranca. Si esa conexión se pierde, deja de escribir y no reabre la entrada hasta volver a tomar el bloqueo; si para entonces lo tiene otro proceso, termina. Esto resuelve el pendiente 6 de F1.3.
- El smoke usa almacenamiento en memoria de su propio proceso, así que no comparte log.

### 10. Smoke opt-in

`pnpm run data:smoke` corre `scripts/data-smoke.mjs` (ADR-0003), que compila el worker y ejecuta su CLI dejando en stdout una sola línea JSON.

- **Opt-in.** Sin `--live` no abre conexiones: responde con un error de uso y código 2. Así ningún `verify` ni CI toca la red. Por defecto usa `--symbol R_100` y `--duration-seconds 120`, con un máximo de 3600.
- **Recorrido:** esquemas, conexión, catálogo, suscripción, ticks con keepalive, `forget_all` y cierre. Usa el `RawFirstIngestor` con el perfil de medición y almacenamiento en memoria.
- **Retención (ADR-0004 §13).** Nada se escribe en disco, PostgreSQL ni almacenamiento de objetos, y todo se borra al terminar el proceso; el plazo de 24 horas se cumple de sobra.
- **Resultado saneado**, sin payloads ni precios:
  - fecha de inicio y fin, release y hash de los esquemas;
  - conector, símbolo y nombre del catálogo;
  - número y hash del catálogo;
  - conteos de frames por tipo e incidencias por tipo;
  - distribuciones de retraso de entrega (`received_at_utc` − tiempo del tick) y de intervalo entre ticks (mínimo, p50, p90, p99 y máximo);
  - desfase con la hora del servidor (`time`).

  El tiempo de Deriv viene en segundos enteros, así que el retraso medido puede incluir hasta 999 ms de redondeo. El resultado lo advierte.
- **Códigos de salida:** 0 si pasa, 1 si falla (catálogo inválido, símbolo ausente, sin ticks, límites, desconexión) y 2 si es un error de uso o configuración.
- **Uso.** El smoke nunca es criterio único de fusión. Sus números sirven para fijar después los umbrales live de retraso y de hueco.

### 11. Pruebas sin red

- Las pruebas del adaptador usan un transporte, un reloj y un generador de IDs falsos, con esquemas y ZIP sintéticos. La única red es la del smoke.
- Las pruebas de PostgreSQL y almacenamiento de objetos (catálogo, incidencias de respuestas pedidas y bloqueo por fuente) van en `pnpm run test:integration`. También va ahí la del corte de `ws`, con un servidor local en el mismo proceso.
- Los vectores v1 no cambian.

### 12. Secuencia de entrega

Cada PR es pequeño, con su revisión semántica:

1. Esta ADR y los contratos de dominio.
2. `SourceCatalogSnapshot` en `packages/contracts`, con su JSON Schema.
3. En `packages/domain`: validador por dialecto (dependencia `ajv-draft-04`), perfil de medición y conversión pura de la respuesta de `active_symbols` en snapshot.
4. En el worker: carga de `schemas.zip` (dependencia `fflate`).
5. En el worker: transporte `ws`, cola, correlación, keepalive y pausa del ingestor desde el transporte (dependencia `ws`).
6. En el worker: catálogo e incidencias de respuestas pedidas en PostgreSQL y almacenamiento de objetos (migración `0003`) y bloqueo por fuente.
7. `pnpm run data:smoke`, con almacenamiento en memoria en `src/` (log, registro operativo, objetos, catálogo e incidencias de respuestas pedidas), porque los almacenes en memoria de `test/support` no se compilan. También el runbook y la evidencia de F1.4b en `PROJECT_STATUS.md`.

## Consecuencias

- buoh escucha Deriv con los mismos contratos, log y reglas que los vectores sintéticos. Solo se añaden el validador draft-04, el transporte y el catálogo.
- Entran tres dependencias pequeñas y sin dependencias propias (`ws`, `ajv-draft-04` y `fflate`). Cada PR justifica la suya.
- El corte de `ws` depende de dos propiedades internas; quedan fijadas y probadas, y sin ellas el adaptador falla cerrado.
- El catálogo deja de ser un dato suelto: cada versión tiene procedencia, y un catálogo roto no borra el anterior.
- Las comprobaciones de las respuestas pedidas quedan fuera de los datasets: un dataset publicado no muestra un error de `active_symbols`, pero la tabla `requested_response_incidents` sí.
- El smoke en memoria no prueba la persistencia real con datos vivos; eso lo cubren las pruebas de integración con datos sintéticos.

## Alternativas descartadas

| Alternativa | Motivo |
|---|---|
| `WebSocket` global de Node 24 | Sin límite de tamaño configurable: reúne el mensaje entero antes de que buoh pueda rechazarlo. |
| Inventar el tamaño de un frame cortado (por ejemplo, el máximo más uno) | `observed_value` dejaría de ser un valor observado. |
| Copiar los esquemas de Deriv en el repositorio | Su repositorio no tiene licencia; además, ADR-0004 ya decide descargarlos con hash fijado. |
| Un lector de ZIP propio con `node:zlib` | Más código delicado de mantener que una librería pequeña, probada y sin dependencias. |
| Validar las respuestas declaradas dentro de las reglas | Cambiaría las reglas 2.0.0, que dejan esa comprobación a quien pide la respuesta. |
| Guardar las incidencias de respuestas pedidas en el registro operativo | Ese registro abre condiciones y cambia la salud, y sus incidencias están fijadas a 1.0.0 y nunca son `invalid_source_frame`. |
| Versionar el catálogo con `trade_count` | Cada consulta sería una versión nueva sin que cambie el catálogo. |
| Smoke contra PostgreSQL y almacenamiento de objetos reales | Las tablas son append-only y el almacenamiento no borra: cumplir las 24 horas exigiría un esquema y un bucket desechables, y el propietario necesitaría Docker para cada prueba. |
| Umbrales provisionales en el perfil del smoke | Los umbrales live no se inventan (decisión del propietario); el perfil de medición no los lleva. |
| Cerrar con `closure_type: requested` después de un límite | Las reglas tratan ese cierre como sin pérdida: no abren `connection_lost` ni dejan pendiente la continuidad, y la pérdida de la cola quedaría oculta en un dataset. |

## Referencias verificadas

- [Release `production_v20260901_0` de los esquemas de Deriv](https://github.com/deriv-com/deriv-api-schemas/releases/tag/production_v20260901_0)
- [WebSocket público de Deriv](https://developers.deriv.com/docs/options/ws-public/)
- [Active Symbols de Deriv](https://developers.deriv.com/docs/data/active-symbols/)
- [undici #4899: sin límite de tamaño en mensajes WebSocket sin comprimir](https://github.com/nodejs/undici/issues/4899)
- [`ws` en npm](https://www.npmjs.com/package/ws), [`ajv-draft-04` en npm](https://www.npmjs.com/package/ajv-draft-04) y [`fflate` en npm](https://www.npmjs.com/package/fflate)

El contenido de fuentes externas fue reformulado para cumplir restricciones de licencia.
