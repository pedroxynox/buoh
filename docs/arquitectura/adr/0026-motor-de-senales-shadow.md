# ADR-0026: Motor de señales shadow (F2.9 y F2.10)

- **Estado:** Aceptada
- **Fecha:** 2026-11-23
- **Ámbito:** Fase 2, incrementos F2.9 (`F2-SHADOW-001`, `F2-SIGNAL-001`, `F2-STOP-001`, `F2-AUDIT-001` en lo de las activaciones, las detenciones y las reanudaciones, y `F2-GOV-001` en lo de `apps/signal-engine`) y F2.10 (`F2-POSITION-001` y `F2-REPLAY-001`) del [plan de Fase 2](../../plan/fase-2-laboratorio-y-bot-shadow.md), §8, punto 8, con los ensayos de la puerta de salida y los cierres programados del mercado. Cambia el [protocolo de validación](../../gobierno/protocolo-de-validacion-de-estrategias.md) §5 y el [catálogo de funciones](../../producto/funciones-y-disponibilidad.md) («Volver a encender»), como pide `F2-STOP-001` (§11).
- **Decisores:** Propietario de buoh (el servidor propio del motor, del 2026-10-29; la reanudación sola tras datos degradados, del 2026-11-16; y el costo de las lecturas del motor, §10), a propuesta de la dirección técnica (lo demás).
- **Complementa:** [ADR-0018](0018-sistema-de-datos-en-produccion.md) §2, §8 y §10, con el servicio, el rol y el token del motor (§1); [ADR-0019](0019-api-cuentas-y-auditoria.md) §5 y §7, con quién es el autor `sistema` y qué lee `buoh_lectura` (§1 y §9); [ADR-0022](0022-modelo-de-estrategia.md) §7 y §8, con lo que impone la salud, el atraso del motor y la reanudación a mano (§4 y §5); [ADR-0024](0024-semantica-del-backtest.md) §3, con las entradas propias del motor (§3); y [ADR-0025](0025-protocolo-estadistico.md) §9, con la cadencia de la deriva y sus falsas alarmas (§8).

## Resumen para el propietario

- **Qué decide.** Cómo funciona el bot en vivo: sigue cada estrategia que tú apruebes con los datos que buoh va guardando, decide como en sus pruebas, guarda cada señal y cada posición hipotética, y nunca manda una orden.
- **Dónde.** En su propio servidor de Render, `buoh-senales`, el que aprobaste el 2026-10-29 por unos 7 USD al mes. Si se cae, la captura y la web siguen.
- **A tiempo.** Lee cada tick en cuanto está guardado, con alrededor de 1 segundo de retraso. Si se atrasa más de 5 segundos o se reinicia, las señales de ese rato quedan como omitidas, con su causa, y vuelve solo al ponerse al día.
- **Se para solo.** Cuando los datos fallan, también cuando Deriv deja de mandar ticks con la conexión abierta, como los 6 min 26 s del 2026-11-12, la estrategia se detiene a los pocos segundos y vuelve sola cuando los datos están bien, como decidiste. Lo demás, como una deriva o la caída del 50 %, solo vuelve si tú lo decides desde Laboratorio.
- **Se puede repetir.** Cada decisión se reproduce después desde los datasets publicados y da el mismo registro, con el mismo hash.
- **Costo.** Leer cada tick suma unos 1,60 USD al mes a lo aprobado (estimación, §10): el total de la fase pasa de unos 56,50 a unos 58,10 USD. Te lo pido antes de fusionar.
- **Riesgo.** Nada opera ni toca dinero. Para la puerta de salida puede hacer falta que suspendas la captura 2 minutos una vez, si en la semana no hay ningún corte natural (§12).
- **Qué apruebas al fusionarla.** Las reglas de esta ADR, que son propuestas de la dirección técnica, los cambios del protocolo de validación y del catálogo, y el orden de doce PR de §13.

## Contexto

El plan pide esta ADR antes del código de F2.9 y F2.10 (§8, punto 8). Las demás ADR del laboratorio le dejaron puntos:

- ADR-0022 §7: de dónde toma el motor la salud y lo que la impone, porque el `HealthReport` no nombra su causa; cómo implementa en vivo la política de datos; y quién registra cada detención en la auditoría. §6: el contenido del `SignalEvent`. §8: qué supuestos de ejecución usa el motor.
- ADR-0024 §3: dar la misma secuencia que el backtest para el mismo log, y guardar como evento cualquier otra entrada, como un latido viejo o la reanudación del propietario.
- ADR-0025 §9: la cadencia de la prueba de deriva, y medir con ella sus falsas alarmas.
- ADR-0018 §8 y §10: el rol y el token del motor, y si `buoh_lectura` lee sus tablas.
- ADR-0021 §3: el horario de cada mercado, con el que el motor no decide ni se detiene fuera de él.

Dos hechos de producción pesan aquí:

- **Una parada de la fuente con la salud `healthy`.** El 2026-11-12, Deriv no mandó ticks de R_100 durante 6 min 26 s con la conexión abierta, y la salud siguió `healthy`, porque `data:health` no mide la antigüedad del último tick ([evidencia de producción de F2.2](../../operacion/evidencia-produccion-f2-2.md)).
- **La salud con el perfil de publicación.** Desde el corte del 2026-11-23, el log 5 se deriva con el perfil de publicación: tras una reconexión con 2000 ms de separación como mucho, la continuidad queda demostrada sin pedir historia ([evidencia de los datasets vivos](../../operacion/evidencia-datasets-f2-5.md), «El cambio de perfil en el corte»). PENDIENTE: lo medido en sus primeros días.

Lo que ya está fijado, y esta ADR no cambia: un solo evaluador puro, el mismo del backtest, con su vista de cada instante y su anfitrión (plan §4.1; ADR-0022 §8; ADR-0024 §2 y §3); solo `production`, con `execution_mode = shadow`, sin Deriv autenticado, sin bróker y sin `execution-gateway` (plan §4.5 y §4.9); solo las estrategias que aprueba el propietario en la API, desde su registro append-only (ADR-0022 §10; ADR-0025 §11); la política de datos y la caída máxima del 50 % (ADR-0022 §5 y §7); la prueba de deriva (ADR-0025 §9); y un worker Starter propio (decisiones vigentes, «Servidor del motor de señales *shadow*»).

## Decisión

### 1. El servicio y sus credenciales

- **El servicio.** `apps/signal-engine` corre como el background worker Starter `buoh-senales`, en la región `virginia`, definido en `render-datos.yaml` (ADR-0018 §2), con `BUOH_DEPLOYMENT_ENVIRONMENT=production` y los tamaños de V8 de `WORKER_NODE_FLAGS`. Un solo proceso sigue todas las estrategias activas, como mucho 10 a la vez: la API rechaza una promoción más con `shadow_capacity_reached`.
- **PostgreSQL.** El rol `buoh_senales`, con inicio de sesión y 3 conexiones como mucho, miembro de `buoh_lectura`, así que lee los logs de cada secuencia y `buoh_datasets`. Tiene además `SELECT` en las tablas del registro de estrategias de `buoh_api` (el PR 4 de ADR-0022), y nada más de `buoh_api`. Escribe solo en su esquema, `buoh_senales`, con `SELECT` e `INSERT`, y todas sus tablas son append-only, como las de los logs. `buoh_lectura` lee `buoh_senales`: así lo leen la API, por `buoh_api_lectura`, y el agente, por `buoh_agente` (precisión de ADR-0018 §8). Las migraciones de `buoh_senales` y los privilegios los aplica el paso 1 de `buoh-operaciones`, como los de `buoh_datasets`, con la credencial dueña. La conexión va con `require` dentro de Render (ADR-0018 §9), y una prueba lo comprueba.
- **R2.** El token `senales`, de solo lectura (*Object Read only*) sobre `buoh-captura` (precisión de ADR-0018 §10). Lo crea el propietario con los pasos del runbook en el PR del despliegue.
- **Sin red hacia Deriv.** El paquete no depende de `ws` ni de ningún cliente de Deriv, y una prueba comprueba que el proceso solo abre conexiones con PostgreSQL y con R2 (`F2-SHADOW-001`).
- **Lectura.** El motor lee la captura con `@buoh/market-data-worker/lectura` (ADR-0019 §8). Si necesita algo que esa ruta no da sin el código de la captura, la capa de lectura pasa a un paquete en su propio PR, como prevé esa ADR.

### 2. Cómo sigue la captura

- **El log de cada secuencia.** Para cada secuencia en vivo con una estrategia activa, R_100 y, con F2.5b, el oro (ADR-0021 §1), el motor sigue su log activo con la misma búsqueda de ADR-0018 §6. Un log termina cuando el siguiente tiene una escritura: el motor lee lo que queda del terminado y pasa al siguiente. Las secuencias por lotes que usa una estrategia, como las cotizaciones y los horarios (ADR-0021 §3 y §4), se siguen igual, cada 5 s.
- **Cada evento, en cuanto es durable.** Cada 500 ms, el motor pide al índice del log (`source_event_index`) los source events posteriores al último que leyó, en su orden, y lee el objeto de cada uno de R2 con un solo `GetObject`: el índice ya da su tamaño y su SHA-256, que el motor comprueba, así que no hace falta `HeadObject`. Un evento es durable cuando su fila del índice está confirmada, porque `ingest` escribe primero su objeto y después lo indexa ([ADR-0005](0005-persistencia-local-y-formato-fisico-f1-3.md) §4). Los segmentos cerrados se leen enteros, un objeto por segmento, solo para ponerse al día.
- **La vista y su estado.** Los eventos pasan por la vista de cada instante (ADR-0024 §2), la misma del backtest, de cada log entero desde su segmento 0. Sin estado propio para el log activo, la vista arranca del último punto de control de `ingest` de ese log (ADR-0017 §5) si su estado se puede armar desde él, y si no, desde el segmento 0, por partes. El PR 3 fija cuándo se puede, con la equivalencia probada frente a la derivación desde el segmento 0, como ADR-0017 §9. Así cumple `F2-SHADOW-001` («desde el punto de control») sin cambiar la secuencia.
- **La marca de lo durable.** Para saber que no llegará un evento anterior a un instante, el motor usa los latidos de `ingest` (`ingestion_heartbeats`, uno cada 15 s): un latido confirmado con la hora *h* dice que todo lo recibido antes de *h* ya es durable, si `ingest` confirma cada latido detrás de las escrituras de los eventos recibidos antes de él. El PR 3 lo comprueba en el código de `ingest` con una prueba, y si no se cumple, solo cuentan los latidos con `backlog_count` 0.

### 3. La misma secuencia que el backtest

El motor llama al anfitrión (`strategy-host-1.0.0`) y al evaluador (`strategy-evaluator-1.0.0`) igual que el backtest (ADR-0024 §3). Lo que en el backtest sale del dataset, en vivo sale de la misma vista sobre el mismo log, así que da la misma secuencia, con dos reglas:

- **El paso del tiempo.** El anfitrión pide el paso del tiempo en el plazo exacto *D* de su próximo plazo, como la antigüedad máxima de los datos o el cambio de día. En el backtest, llega antes del primer evento con un instante posterior a *D*. En vivo, el motor lo entrega en cuanto sabe que ningún evento posterior tendrá un instante anterior o igual a *D*: al leer un evento con un instante posterior a *D*, o con un latido confirmado posterior a *D* (§2). Como la vista nunca retrocede su reloj (ADR-0024 §3), las dos dan el mismo orden. Lo único que depende del reloj de pared es *cuándo* lo procesa el motor, no *qué* decide.
- **Las entradas propias del motor.** Lo que no sale del log se guarda como evento en el registro del motor, con el lugar del log después del cual se aplicó y el instante que lleva, que nunca es anterior al del último evento aplicado (ADR-0024 §3, «En `shadow`»):
  - la activación de una estrategia, con su versión y el lugar desde el que se calientan sus indicadores;
  - una pausa, una reanudación o un retiro del propietario, con su evento de auditoría de la API;
  - el comienzo y el final de un tramo atrasado del motor (§4).

  La réplica (§9) aplica esas entradas en el mismo lugar. Así se reproduce cada decisión.
- **La activación.** Cuando la API registra una versión en `shadow` y `active` (ADR-0022 §10; ADR-0025 §11), el motor la lee en su siguiente consulta del registro, cada 5 s, y la activa después del último evento que leyó. Sus indicadores se calientan sin decidir desde el segmento 0 del log anterior al activo de su secuencia, si existe y no venció, o del activo, como `indicators_from_utc` en el backtest. Desde la activación, decide. Los indicadores siguen a través de los cortes semanales, como la serie del backtest (ADR-0024 §4).
- **Los supuestos.** El motor usa la latencia, los costos y los demás supuestos de ejecución del `BacktestSpec` de la réplica de la versión congelada que aprobó el propietario (ADR-0022 §8; ADR-0025 §6), guardados con la activación.

### 4. La salud y la detención

- **De dónde sale la salud.** La que da la vista: `deriveLiveHealthReport` de los hechos del log, con las condiciones abiertas, la continuidad pendiente, si el log quedó conectado y, si es `failed`, su motivo (ADR-0024 §2). Es lo que el anfitrión pasa al evaluador como «lo que la impone» (ADR-0022 §7). El motor no usa los informes guardados de `data:health`, que llegan cada 5 minutos, ni el registro operativo: cuando `ingest` no puede escribir, no llega nada durable, y lo detecta la antigüedad de los datos.
- **Los datos viejos.** Con la parada del 2026-11-12, la salud seguía `healthy`, pero el último tick envejece: en *D*, el instante del último tick más `max_data_age_ms` (5000 ms por defecto), el paso del tiempo detiene la estrategia con la causa de datos viejos, y el tick siguiente la levanta en su mismo evento (ADR-0024 §5). En vivo, el motor lo procesa como mucho unos 15 s después de *D*, con el latido siguiente, y antes si llega un `pong` del keepalive. La decisión lleva el instante *D*.
- **El horario.** Fuera del horario de su mercado, del `TradingSession` guardado de cada día (ADR-0021 §3), una estrategia no decide ni se detiene. Dentro, un mercado que deja de mandar datos la detiene por datos viejos. En la apertura, hasta el primer tick, la estrategia puede detenerse por la salud o por datos viejos, y vuelve sola. Un día con el horario desconocido omite las señales con `schedule_unknown` (ADR-0024 §4). R_100 cotiza todo el día.
- **El atraso del motor.** El atraso de un evento es la hora de pared en que el motor termina de procesarlo menos su instante. Si pasa de 5000 ms, el motor abre un tramo atrasado, que se cierra con el primer evento procesado con 5000 ms o menos. Al arrancar, el tramo empieza en el primer evento posterior a su último estado durable (§6). Mientras dura, el anfitrión pasa al evaluador la salud `paused` impuesta por `signal_engine_behind` (precisión de ADR-0022 §7): la estrategia se detiene por datos degradados, sus señales quedan omitidas con esa causa y vuelve sola al cerrarse el tramo. Así se cumple `F2-SHADOW-001`: las decisiones que el motor no tomó a tiempo quedan omitidas, con su causa, y la réplica las reproduce, porque el tramo es una entrada del registro (§3). El atraso de cada decisión se guarda también fuera del hash (§6), y F2.10 lo compara con la latencia de la estrategia.
- **Cada detención** es una decisión `detener` del evaluador, con su causa y su instante, y se reproduce como las demás (`F2-STOP-001`).

### 5. Cómo vuelve

Es la regla de ADR-0022 §7, con dos precisiones:

- **Sola**, con datos degradados: cualquier salud distinta de `healthy`, una condición `connection_lost` o `event_gap_unresolved` abierta, la continuidad pendiente, los datos viejos y el atraso del motor, sea cual sea la duración, como decidió el propietario el 2026-11-16 ([decisiones vigentes](../../gobierno/decisiones-vigentes.md), «Disco, VPS y reanudación»). El atraso del motor no es un dato degradado, pero tampoco lo causa la estrategia ni sus datos: la dirección técnica lo trata igual.
- **A mano**, con un evento de reanudación del propietario: una salud `failed` por un esquema incompatible o un log que no se deriva, un perfil o un esquema distintos de los declarados, un incidente de integridad, como un objeto que no coincide con su hash, la caída máxima, la deriva y una pausa del propietario. Mientras quede abierta una de ellas, la estrategia no vuelve sola.
- **La reanudación a mano reconoce lo que está abierto.** El propietario también puede reanudar antes una detención por datos degradados, por ejemplo tras un hueco que la historia no cubre, que sigue abierto hasta el corte del log (ADR-0024 §5). La reanudación levanta la detención con las causas abiertas en su instante: la estrategia vuelve a decidir aunque sigan abiertas, y se detiene otra vez con cualquier causa que se abra después (precisión de ADR-0022 §7).
- **Cómo se pide.** Desde Laboratorio, con un motivo escrito de al menos 20 caracteres, que es el análisis documentado, después de ver el informe de la detención que arma la API con las decisiones y los datos de alrededor, que es la evidencia nueva. La API lo guarda como evento de auditoría del propietario (ADR-0019 §5), y el motor lo aplica como entrada (§3).

### 6. Lo que guarda el motor

Todo en `buoh_senales`, append-only y en JCS, con los contratos de `packages/contracts` (§13):

- **Las decisiones** (`ShadowDecision` 1.0.0). Una fila por decisión del evaluador (`entrar`, `salir`, `liquidar`, `omitir`, `detener` y `reanudar`), con dos partes:
  - la reproducible: el hash de la versión de la estrategia, las versiones del motor (`signal-engine-1.0.0`), del anfitrión, de la vista y del evaluador, el perfil y su SHA-256, la secuencia, el log y el lugar del evento que la causó (segmento y posición) o de la entrada del motor después de la cual se tomó, el instante, el tipo, la causa, el contrato y los importes si los hay, y el SHA-256 de la decisión anterior de esa estrategia. Su SHA-256 es su identidad, y la cadena fija el orden: una réplica da los mismos hashes (`F2-REPLAY-001`);
  - la observada, fuera del hash: la hora de pared en que el motor la procesó, su atraso y la sesión del motor.

  Las omisiones seguidas con la misma causa van en una fila, con su número y su primer y su último instante, como en el backtest (ADR-0024 §10).
- **Las entradas del motor** (`ShadowEngineInput` 1.0.0), las de §3, también en cadena de hashes.
- **El estado** (`ShadowCheckpoint` 1.0.0): el de la vista de cada secuencia, el del anfitrión y el del evaluador de cada estrategia, en JSON canónico (ADR-0022 §8; ADR-0024 §2), con el lugar del log y el SHA-256 de la última decisión y de la última entrada de cada cadena. Se guarda cada 6 segmentos cerrados de cada secuencia, unos 30 minutos, y en cada corte.
- **El latido del motor**, cada 30 s y fuera de cualquier hash: la sesión, el último lugar leído de cada secuencia, el atraso, si está en un tramo atrasado y `execution_mode: shadow`.
- **Las señales** (§7), **las posiciones** (§8) y **la auditoría** del motor (§9).

### 7. Las señales

Una decisión `entrar` es una señal (ADR-0022 §6), y una que el evaluador omitió por la política de datos, por los límites de frecuencia o por otra causa es una señal omitida (`F2-SIGNAL-001`). Las dos se guardan como `SignalEvent` 1.0.0:

- su identidad, el SHA-256 de su decisión, así que la réplica da la misma;
- la estrategia (`strategy_id`, versión semántica y hash) y el enlace a su evidencia, el `EvidenceReport` con el que la aprobó el propietario (ADR-0025 §11);
- el símbolo, el instante de la decisión y el vencimiento: la hora de la fuente del tick que decidió, más `latency_ms` y `signal_expiry_ms` (ADR-0024 §3);
- la condición: la regla de entrada que se cumplió y los valores de los indicadores que usa, como los guarda el evaluador;
- la calidad de los datos en su instante: la salud, las marcas del tick y el perfil;
- el contrato y la apuesta, `execution_mode: shadow` y, si es omitida, `omitted` con su causa.

La web, por la API, nunca muestra como vigente una señal con el vencimiento pasado, ni una omitida (`F2-SIGNAL-001`). Una señal no es una orden ni lleva permiso para crearla (ADR-0002). La firma del `SignalEvent` que describe la [arquitectura objetivo](../arquitectura-objetivo.md) llega cuando alguien fuera de buoh las reciba: en la Fase 2 nadie las recibe, y la cadena de hashes basta para la réplica.

### 8. Posiciones y deriva (F2.10)

- **El libro de posiciones.** Cada posición hipotética (`ShadowPosition` 1.0.0) nace de una señal emitida y se cierra con su decisión `liquidar`, con la semántica de su contrato de Deriv y los importes del evaluador (ADR-0022 §5): un multiplicador con su comisión, su stop loss, su take profit y su cierre al perder lo apostado; un sube/baja con el pago de la cotización guardada en su instante. Enlaza su señal y sus decisiones, lleva sus marcas de estimada (ADR-0022 §7) y nunca es una orden (`F2-POSITION-001`).
- **La cadencia de la deriva.** La prueba de ADR-0025 §9 corre una vez por día UTC, con el cambio de día del anfitrión, sobre todo lo acumulado desde la activación: las horas en que la estrategia podía decidir, dentro del horario y sin detenciones ni pausas, y sus operaciones en `shadow`. Es una función pura de las decisiones del registro, así que la réplica la reproduce. Una deriva es una decisión `detener` con la causa `drift`, y el motor la audita (§9).
- **Las falsas alarmas.** Mirar cada día los datos acumulados repite la prueba, y la probabilidad de alguna falsa alarma sube. El PR de la deriva (§13) la mide en vectores sin deriva, con 56 miradas diarias, el máximo de la ventana fuera de muestra (ADR-0025 §7): con una estrategia que opera como esperaba, la probabilidad de una pausa falsa en esos 56 días no pasa del 5 %. Si pasa, el PR baja el umbral de cada mirada hasta cumplirlo y lo fija como constante de `signal-engine-1.0.0` (precisión de ADR-0025 §9).
- **El informe.** La API muestra en Laboratorio, juntos, el backtest, la validación, la prueba fuera de muestra y el `shadow`, cada cifra con su modo, su período, su muestra y su caída máxima, también el atraso del motor frente a la latencia que supuso el backtest.

### 9. La réplica, la auditoría y lo que ve la web

- **`decisions:replay`.** El comando raíz del plan (§9, «Comandos»), `pnpm run decisions:replay -- --from <UTC> --to <UTC> --json`, corre sin contactar a Deriv con un rol y un token de solo lectura. Para cada estrategia con decisiones en el período, recorre desde el lugar de calentamiento de su activación los datasets publicados que cubren cada log (`dataset_log_ranges`, ADR-0020 §5), en orden, con las entradas del registro del motor en su lugar y las mismas versiones, y compara cada decisión del período con la guardada por su hash. Escribe una línea JSON con, por estrategia, las decisiones que coinciden, las que no, con su lugar, y las que todavía no cubre ningún dataset publicado, que se cuentan aparte (`F2-REPLAY-001`). Sale con 0 si todas las cubiertas coinciden, 1 si alguna no y 2 con un error de uso o de configuración. Lee por partes, con el techo de memoria del motor.
- **La auditoría.** El motor escribe en su propia tabla, `buoh_senales.audit_events`, con el contrato `AuditEvent` y el autor `sistema` (precisión de ADR-0019 §5: el autor `sistema` es la API o el motor). Sus acciones nuevas son `shadow_engine_started`, `shadow_strategy_activated`, `shadow_strategy_stopped` y `shadow_strategy_resumed`, y `strategy_drift_detected` llega con F2.10 (ADR-0025 §12). Cada una nombra la versión de la estrategia y la decisión por su hash. La sección Auditoría de la web las lee de esa tabla junto a las de la API, como ya lee los eventos de datos de cada log (ADR-0019 §8). Las pausas, las reanudaciones y los retiros del propietario los audita la API.
- **La web.** La API lee `buoh_senales` con `buoh_api_lectura` y muestra: en Observatorio y en Laboratorio, el estado del motor (en marcha, atrasado o sin latido desde hace más de 90 s) y el de cada estrategia (decidiendo, detenida o pausada, y por qué); en Señales, las señales con su modo, su vencimiento, su calidad y su evidencia (`F2-SIGNAL-001`); y en Laboratorio, el informe de §8. El modo del Observatorio sale del latido del motor (concepto de interfaz §10).

### 10. Memoria y costo

- **Memoria.** La vista retiene como mucho 16 000 ticks por secuencia (ADR-0024 §2), y el estado de cada estrategia está acotado por su definición. El PR del motor mide en local el máximo con dos secuencias y 10 estrategias en el techo, y la evidencia de F2.9 lo mide en Render, que muestra la memoria de un background worker: no pasa de 256 MB (`F2-SHADOW-001`).
- **R2.** Una lectura de clase B por evento, tantas como escrituras de eventos de la captura: unos 1,35 millones al mes con R_100 y unos 1,8 con el oro (ADR-0021 §6), unos 3,2 millones. Con los unos 12,1 millones que ya suman ADR-0021 y ADR-0023, pasan de 3 millones cobrados a 6, por el redondeo de R2: unos 1,10 USD más al mes. Ponerse al día y la réplica leen segmentos enteros, unos pocos miles al mes.
- **Tráfico de salida.** Cada petición sale de Render con alrededor de 1 KB (ADR-0016): unos 3,2 GB al mes, unos 0,50 USD a 0,15 USD por GB, porque el tráfico ya pasa de los 5 GB incluidos.
- **PostgreSQL.** Cada 500 ms, una consulta por secuencia al índice por su clave primaria, y cada 5 s, al registro de estrategias y a los latidos: lo mide la evidencia de F2.9 frente a los 0,1 CPU de la base (plan §14). Lo que escribe el motor, sin contar las decisiones, que son pocas, son menos de 1 MB al día.
- **Total.** El worker, 7 USD ya aprobados (plan §11), y unos 1,60 USD más al mes por las lecturas y el tráfico (estimación): la fase pasa de unos 56,50 a unos 58,10 USD. Con solo R_100, hasta que se capture el oro, son unos 0,55 USD. La evidencia de F2.9 los mide (`F2-SHADOW-001`).

### 11. El protocolo y el catálogo

Como pide `F2-STOP-001`, el mismo PR de esta ADR cambia:

- el [protocolo de validación](../../gobierno/protocolo-de-validacion-de-estrategias.md) §5: en `shadow`, una detención por datos degradados vuelve sola cuando los datos vuelven a cumplir la política de la estrategia; las demás pausas, también las de un incidente, exigen análisis documentado, nueva evidencia y una decisión auditada, y nunca se reactivan solas; en `demo` y `real` lo decide su política de riesgo;
- el párrafo del [catálogo de funciones](../../producto/funciones-y-disponibilidad.md) sobre «Volver a encender»: en `shadow`, desde la Fase 2, el propietario reanuda a mano desde Laboratorio con lo que pide el protocolo, y lo demás sigue en la Fase 4.

### 12. Pruebas y ensayos de la puerta

- **Sin red** (plan §10), con log, reloj y temporizador falsos (`F2-SHADOW-001`):
  - la misma secuencia que el backtest sobre los mismos logs sintéticos, también con eventos que se vuelven durables tarde y con el paso del tiempo en cada plazo;
  - cada causa de detención con su vector, la reanudación sola tras cada dato degradado, su ausencia con una causa a mano abierta, la reanudación a mano que reconoce lo abierto, el horario del oro y el día sin horario (`F2-STOP-001`);
  - el reinicio en cada punto de un tramo, con el estado durable y las omitidas, y el atraso del motor;
  - las señales con la condición sin cumplir, que no dan señal (`F2-SIGNAL-001`), y la vencida, que la API no muestra como vigente;
  - un dato tardío que no cambia las decisiones anteriores, y la réplica con el mismo hash (`F2-REPLAY-001`);
  - que el proceso no abre conexiones fuera de PostgreSQL y R2.
- **Integración**: `buoh_senales`, su rol y sus privilegios, con `42501` al modificar o borrar y al leer lo que no le toca de `buoh_api`; y el motor sobre un log que escribe el `ingest` sintético, con su corte.
- **La puerta de salida** (plan §13). Las detenciones naturales de la ventana de 7 días, las reconexiones de Deriv y el corte semanal, demuestran la detención y la reanudación sola en producción. Si en la ventana no hay ninguna detención por la salud y otra por datos viejos, el ensayo las provoca: el propietario suspende `buoh-ingesta` 2 minutos con los pasos del runbook («Parar»), lo que deja un hueco visible en la captura. La reanudación a mano se ensaya con una pausa del propietario desde Laboratorio. `decisions:replay` sobre la ventana da todas las cubiertas iguales.

### 13. Secuencia de entrega

F2.9 empieza después de F2.8, y F2.10 después de F2.9 (plan §9). Doce PR, cada uno con su revisión semántica:

1. Esta ADR, con el protocolo, el catálogo, `PROJECT_STATUS.md` y las precisiones de las ADR que complementa.
2. Los contratos de F2.9 en `packages/contracts`: `ShadowDecision`, `ShadowEngineInput`, `ShadowCheckpoint`, `SignalEvent` y las acciones de `AuditEvent`, con su JSON Schema y sus vectores.
3. `apps/signal-engine` con la lectura en vivo: el log de cada secuencia, la lectura sin `HeadObject`, la vista desde el punto de control, la marca de lo durable y el corte, con su prueba de `ingest`. Lo añade a `docs/impact-map.json` (`F2-GOV-001`).
4. `buoh_senales`, su rol, sus migraciones y sus privilegios en el paso 1 de `buoh-operaciones`. No cambia producción hasta el PR 6.
5. El motor: el registro de estrategias, el anfitrión con las entradas del motor, las decisiones, las señales, el estado, el reinicio, el atraso, las detenciones, las reanudaciones, la auditoría y el latido, con la medición local de memoria.
6. El despliegue: `buoh-senales` en `render-datos.yaml`, el token `senales` y el runbook (preparar, desplegar, parar, recuperar y borrar).
7. La API y la web: el estado del motor, Señales, la Auditoría con el registro del motor y la reanudación a mano en Laboratorio.
8. La evidencia de F2.9: la memoria en Render, las lecturas de R2, el tráfico de salida y la carga de la base. Con ella, F2.9 está hecho.
9. Los contratos y el libro de posiciones, `ShadowPosition`, y el informe de Laboratorio con el `shadow` junto a las pruebas.
10. La deriva: su cadencia, la medición de las falsas alarmas y la pausa con `strategy_drift_detected`.
11. `decisions:replay`.
12. La evidencia de F2.10. Con ella, F2.10 está hecho, y F2.11 puede empezar.

## Consecuencias

- El motor ve lo mismo que el backtest y decide lo mismo, y lo que solo pasa en vivo, como su atraso o una reanudación del propietario, queda en su registro para la réplica.
- Una detención por datos viejos se registra con su instante exacto, aunque el motor la procese hasta unos 15 s después.
- Si `ingest` se para del todo, el motor no puede saber que no llegarán datos y no registra la detención hasta que vuelvan; mientras tanto no decide nada, y la web lo dice con el estado del motor.
- Una estrategia puede detenerse varias veces al día, en cada reconexión de Deriv, y cada detención queda en la auditoría.
- Un tramo atrasado omite señales que el backtest habría dado: la comparación de F2.10 lo cuenta aparte.
- Las tablas del motor no vencen: crecen menos de 1 MB al día sin contar las decisiones.

## Alternativas descartadas

- **Que `ingest` avise al motor con `NOTIFY` de PostgreSQL.** Ahorraría las lecturas de R2, pero un motor que no lee sus avisos llena la cola de avisos en el disco de la base, y la captura dejaría de poder confirmar sus escrituras: un fallo del bot cortaría la captura (decisiones vigentes, «Servidor del motor de señales *shadow*»).
- **Leer solo los segmentos cerrados.** Casi no cuesta, pero cada evento llegaría hasta 5 minutos tarde: con vencimientos de 1 a 60 s, todas las señales saldrían vencidas.
- **Entregar el paso del tiempo con el reloj de pared.** Un evento que se vuelve durable tarde llegaría después del plazo en vivo y antes en el backtest, y las dos secuencias no coincidirían.
- **Guardar cada paso del tiempo como entrada.** Funcionaría, pero haría la secuencia del motor distinta de la del backtest sin necesidad.
- **Escribir las detenciones en el registro de la API.** El motor escribiría en las tablas de otro servicio, contra `F2-SHADOW-001`.
- **Usar los informes guardados de `data:health`.** Llegan cada 5 minutos y no nombran su causa.
- **Firmar cada señal ya.** Nadie fuera de buoh las recibe en la Fase 2.

## Condiciones de revisión

- La réplica de una decisión no da el mismo hash.
- La memoria medida en Render pasa de 256 MB, o la base no da abasto con las consultas del motor.
- El atraso del motor pasa de 5000 ms más del 1 % del tiempo, o la mediana pasa de la latencia por defecto de 1000 ms.
- Las falsas alarmas de la deriva pasan del 5 % con el umbral fijado, o una pausa por deriva resulta, vista después, de una estrategia sana (ADR-0025, «Condiciones de revisión»).
- Las lecturas de R2 o el tráfico de salida medidos no caben en lo aprobado.
- Alguien fuera de buoh empieza a recibir señales: firmarlas.

## Referencias verificadas

- [Plan de Fase 2](../../plan/fase-2-laboratorio-y-bot-shadow.md): §4, §8, punto 8, §9, §10, §11, §13, `F2-SHADOW-001`, `F2-SIGNAL-001`, `F2-POSITION-001`, `F2-STOP-001`, `F2-REPLAY-001` y `F2-AUDIT-001`.
- [Decisiones vigentes](../../gobierno/decisiones-vigentes.md): «Servidor del motor de señales *shadow*», «Disco, VPS y reanudación», «Orden del trabajo» y «Motor de investigación».
- [ADR-0002](0002-senales-y-ejecucion-controlada.md), [ADR-0005](0005-persistencia-local-y-formato-fisico-f1-3.md), [ADR-0016](0016-alojamiento-del-sistema-de-datos.md), [ADR-0017](0017-punto-de-control-de-la-derivacion-en-vivo.md), [ADR-0018](0018-sistema-de-datos-en-produccion.md), [ADR-0019](0019-api-cuentas-y-auditoria.md), [ADR-0020](0020-datasets-vivos.md), [ADR-0021](0021-mercados-reales-y-fuentes-de-investigacion.md), [ADR-0022](0022-modelo-de-estrategia.md), [ADR-0024](0024-semantica-del-backtest.md) y [ADR-0025](0025-protocolo-estadistico.md).
- [Evidencia de producción de F2.2](../../operacion/evidencia-produccion-f2-2.md) («Una parada de la fuente con la salud `healthy`») y [evidencia de los datasets vivos](../../operacion/evidencia-datasets-f2-5.md).
- [Contratos de dominio](../contratos-de-dominio.md): «Cómo se lee la causa», `HealthReport` y `AuditEvent`.
- Código: `apps/market-data-worker/src/lectura.ts`, `src/s3/object-store.ts` (`get`, con `HeadObject` y `GetObject`) y `src/deriv/session.ts` (`INGESTION_HEARTBEAT_INTERVAL_MS`, 15 000 ms, y el latido con su `backlog_count`).
