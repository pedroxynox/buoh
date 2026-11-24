# ADR-0026: Motor de señales `shadow` (F2.9 y F2.10)

- **Estado:** Aceptada
- **Fecha:** 2026-11-24
- **Ámbito:** Fase 2, incrementos F2.9 (`F2-SHADOW-001`, `F2-SIGNAL-001`, `F2-STOP-001`, `F2-AUDIT-001` en lo de las activaciones, detenciones y reanudaciones, y `F2-GOV-001` para `apps/signal-engine`) y F2.10 (`F2-POSITION-001` y `F2-REPLAY-001`) del [plan de Fase 2](../../plan/fase-2-laboratorio-y-bot-shadow.md), §8, punto 8. Cambia el [protocolo de validación](../../gobierno/protocolo-de-validacion-de-estrategias.md) §5 y el [catálogo de funciones](../../producto/funciones-y-disponibilidad.md) («Volver a encender») (§8), y fija los ensayos de la puerta de salida (§11).
- **Decisores:** Propietario de buoh (el servidor del motor, decidido el 2026-10-29; la vuelta sola tras datos degradados, el 2026-11-16; y las lecturas de R2 del motor, el 2026-11-24; plan §12), a propuesta de la dirección técnica (lo demás).
- **Complementa:** [ADR-0018](0018-sistema-de-datos-en-produccion.md) §2, §8, §10 y §12; [ADR-0019](0019-api-cuentas-y-auditoria.md) §5, §7 y §8; [ADR-0020](0020-datasets-vivos.md) §4; [ADR-0021](0021-mercados-reales-y-fuentes-de-investigacion.md) §3; [ADR-0022](0022-modelo-de-estrategia.md) §2, §5, §7, §8 y §10; [ADR-0024](0024-semantica-del-backtest.md) §3, §4 y §5; y [ADR-0025](0025-protocolo-estadistico.md) §9, §10 y §11, con las precisiones que marca cada sección; también ADR-0021 §1, §3 y §4 y el [runbook de ingesta](../../operacion/runbook-ingesta-de-datos.md), «Paso 2, `health`».

## Resumen para el propietario

- **Qué decide.** Cómo funciona el bot `shadow`: qué datos mira, cuándo se para solo, qué guarda de cada decisión y cómo se comprueba después que decidió bien. Sigue en vivo las estrategias que tú apruebas, con señales y posiciones imaginarias, sin enviar órdenes.
- **Ve lo mismo que el backtest.** Lee la captura tick a tick, cada medio segundo, con la misma calculadora que el backtest. No usa el informe de salud de cada 5 minutos, que no ve los cortes breves: el log 5 tuvo 36 reconexiones y 3 fallos de guardado que ese informe no vio.
- **Se para solo.** Si los datos fallan o llevan unos segundos sin llegar, la estrategia se para y vuelve sola cuando están bien, como decidiste el 2026-11-16. Fuera del horario de su mercado no decide ni se para. Una deriva, la caída máxima o un dato alterado la paran hasta que tú la reanudes desde la web, con una explicación escrita.
- **Se comprueba.** Cada decisión queda guardada con lo necesario para repetirla, y la orden `decisions:replay` la repite desde los datos publicados y cuenta las que salen iguales.
- **Costo.** El servidor de unos 7 USD al mes que ya aprobaste. Leer de R2 cada tick nuevo suma unos 2 USD al mes (estimación), que aprobaste el 2026-11-24: el total pasa a unos 58,50 USD al mes. Si al medirlo sale más, te lo vuelvo a preguntar.
- **Riesgo.** Nada opera ni toca dinero. El bot solo lee la captura y escribe en sus propias tablas. Para la puerta de salida reiniciarás a propósito la captura y el bot, como en un despliegue.
- **Qué apruebas al fusionarla.** Todas las reglas de esta ADR, que son propuestas de la dirección técnica, los cambios del protocolo de validación y del catálogo de funciones, los ensayos de §11 y el orden de nueve PR de §13.

## Contexto

El plan pide esta ADR antes del código de F2.9 (§8, punto 8), con los ensayos de la puerta de salida y los cierres programados del mercado (`F2-STOP-001`). Otras fuentes le dejan el instante y el orden de cada evento, con la misma secuencia que el backtest (ADR-0022 §2 y ADR-0024 §3); de dónde toma el motor la causa de la salud, la política de datos en vivo y quién registra cada detención (ADR-0022 §7); los supuestos de ejecución del estado inicial (ADR-0022 §8); cómo ve las marcas de los ticks (ADR-0020 §4); la cadencia de la deriva (ADR-0025 §9); y, en el mismo PR, el protocolo §5 y «Volver a encender» ([decisiones vigentes](../../gobierno/decisiones-vigentes.md), «Disco, VPS y reanudación»). El 2026-11-24 el propietario decidió empezarla sin esperar más días de la salud del log 5 (decisiones vigentes, «Orden del trabajo»).

### Medición

El agente leyó el log 5 de producción, el primero con el perfil de publicación y las reglas 3.0.0 (ADR-0020 §4), el 2026-11-24 a las 16:24 UTC, con su acceso de solo lectura ([runbook de ingesta](../../operacion/runbook-ingesta-de-datos.md), «Acceso del agente»): consultas a sus tablas y `scripts/evidencia-f2-5/medir-umbrales.mjs --logs 5 --hasta 2026-11-24T16:24:00.000Z`. Desde las 00:00:03 UTC del 2026-11-23:

- **Conexiones.** 42 `connection_opened` y 41 `connection_closed`, alrededor de una por hora, como los 175 cierres de los 7 días del log 4. De los 41, 5 fueron pedidos y 36 no.
- **Historias.** 11 `HistoryRecoveryResult`, todos `complete`; el log 4 tuvo 172 para sus 175 cierres. La diferencia es el perfil: con el de publicación, una separación de 2000 ms demuestra la continuidad sin historia (`applyTickContinuity`, en `packages/domain/src/derivation-rules.ts`), y la tuvieron 25 de las 36 reconexiones; con el de medición del log 4, nunca la demuestra. Las otras 11 tuvieron más de 2000 ms, hasta 40 s, tantas como historias.
- **Salud.** 485 informes de `buoh-operaciones`, de las 00:01 del 2026-11-23 a las 16:21 del 2026-11-24, todos `healthy` y `connected`, sin condiciones, con hasta 6 min 25 s entre dos. El log 4 tuvo 2000 `healthy`, 9 `recovering` y 7 `paused`.
- **Guardado.** 3 `persistence_unavailable` `critical`, por `InternalError` de R2 en `raw_object_write`, reintentadas, que ningún informe de la salud vio: cada una dejó de 12 a 16 s sin eventos durables y un cierre `close_not_recorded`. El log 4 tuvo 151.
- **Huecos.** El mayor entre dos eventos, 38,4 s, tras un cierre por `ping_timeout`. Con la conexión abierta, a las 01:26 y a las 08:02 del 2026-11-24 pasaron 9,4 y 10,8 s sin eventos, y después llegaron ticks con hasta 8,8 y 11,3 s de retraso de entrega. El p99 de ese retraso fue de 205 ms.

La salud observada cada 5 minutos no ve los cortes breves, como tampoco vio el del 2026-11-12, cuando Deriv no mandó ticks de R_100 durante 6 min 26 s con la conexión abierta ([evidencia de producción de F2.2](../../operacion/evidencia-produccion-f2-2.md)). El motor necesita el estado de los datos en cada evento, y detectar él los datos viejos.

## Decisión

### 1. Qué es el motor

`apps/signal-engine` es un servicio de Node, `buoh-senales`, que sigue en producción las versiones `active` en `shadow` (ADR-0022 §10): pasa al evaluador de ADR-0022 §8, con el anfitrión de ADR-0024 §3, lo que llega a la captura de su símbolo, y guarda cada decisión. Nunca envía una orden ni abre una conexión con Deriv o con un bróker: no trae ningún cliente de WebSocket ni de bróker, y una prueba comprueba que importar su entrada no carga `ws` ni `node:child_process` y que su configuración solo admite PostgreSQL y R2. Su `execution_mode` es `shadow`. Sigue como mucho 10 versiones a la vez, de R_100 o del oro (ADR-0022 §2), y la API no promueve una undécima (precisión de ADR-0025 §11). No depende del VPS del motor de investigación (`F2-SHADOW-001`).

### 2. Qué lee y de dónde toma el estado de los datos

- **La captura.** Por cada secuencia en vivo con una versión activa (ADR-0021 §1), pide cada 500 ms a `source_event_index` de su log activo las filas posteriores a la última aplicada, y lee de R2 el objeto de cada evento con una sola petición `GetObject`: compara su tamaño con el de su fila antes de leer el cuerpo, y su SHA-256 después (precisión de ADR-0019 §8: la ruta `lectura` suma esa lectura, sin `HeadObject`).
- **El estado de los datos de cada decisión** sale de la vista de cada instante de ADR-0024 §2, con el perfil del log, en el mismo evento: la salud que se deriva del log y lo que la impone, tomado de los hechos del pliegue y no del `HealthReport` (las condiciones abiertas, la continuidad pendiente, si el log sigue conectado y, si no se deriva, su código), y cada tick con sus marcas al llegar, también `delivery_delayed`, que el pliegue no da (precisiones de ADR-0022 §7 y ADR-0020 §4). El motor no lee los informes de `buoh-operaciones` ni ejecuta `data:health` (precisión de ADR-0021 §1 y del runbook de ingesta, «Paso 2, `health`», que decían que los leía), y tampoco la cola, el latido ni el registro operativo: no entran en los datasets, así que la réplica no los vería, y su efecto ya lo da la antigüedad de los datos, porque mientras `ingest` no puede guardar no llega ningún evento durable.
- **Los datos viejos** los detecta el reloj del motor: si pasa el próximo plazo del evaluador (ADR-0024 §3) más 1000 ms sin verse ningún evento durable con un instante igual o anterior al plazo, le pasa el paso del tiempo con el instante exacto del plazo. El margen cubre lo que tarda un evento recibido en verse: su escritura durable en R2 y en el índice, la espera de la consulta, de hasta 500 ms, y la lectura de su objeto. No está medido, y lo mide el PR 6 (condiciones de revisión). Con el `max_data_age_ms` por defecto, 5000 ms, el silencio del 2026-11-12 detiene la estrategia 5 s después de su último tick, y un tick que llega con más retraso que ese máximo, como los de las 08:02 del 2026-11-24, es viejo al llegar y no la reanuda.
- **Lo demás.** Lee cada 30 s las cotizaciones, los horarios y los contratos que se ofrecen (ADR-0024 §4) de los logs de los lotes, con sus reglas (ADR-0021 §4); y cada 10 s, del registro de la API, las versiones `active` en `shadow` y las acciones del propietario sobre ellas (ADR-0022 §10). Guarda la definición de cada versión, con su hash, para que la réplica no lea `buoh_api` (§9).
- **El arranque de una versión.** `indicators_from_utc` es su activación menos el mayor de 7 días y su arranque mínimo, como en la prueba fuera de muestra (ADR-0025 §7), y sus supuestos de ejecución, los de la réplica de validación de su versión congelada, sin las variantes (precisión de ADR-0022 §8).
- **El punto de control** (precisión de `F2-SHADOW-001`). El motor sigue desde su propio estado (§5), que contiene el estado vivo de ADR-0017 y lo que el punto de control de `ingest` no tiene: los ticks retenidos y el estado del evaluador. En cada segmento cerrado comprueba que su estado vivo es el `LiveDerivationCheckpoint` del segmento, si sus versiones coinciden, y que lo aplicado tiene el hash lógico de su fila de `closed_source_segments`. Lo que no coincide es un incidente de integridad.

### 3. El orden, el instante y las entradas del motor

La vista y el anfitrión son los de ADR-0024 §2 y §3, con el instante y el orden de cada evento que fijan ahí (precisión de ADR-0022 §2).

- **Las entradas del motor** (`ShadowInput` 1.0.0) son lo que el anfitrión recibe en `shadow` y no sale de la vista: el paso del tiempo, los registros de los lotes, la activación, la pausa, la reanudación y la retirada de la versión, un incidente de integridad o un log que no se deriva (§2), y la falta del motor (§5). Cada una lleva su número en la secuencia de su versión (§6), su posición en el log (la del último evento de la vista aplicado antes), su instante y su objeto: la clase del plazo, el hash del registro o el identificador de la acción en la API. El motor la guarda antes de aplicarla.
- **Su instante.** El paso del tiempo lleva el de su plazo. Un registro de los lotes o una acción del registro de la API, del propietario o la pausa por deriva, el mayor entre su hora (la recepción de su frame o la de la API) y el del último evento aplicado.
- **El paso del tiempo** llega del reloj del motor (§2) o, cuando el evento siguiente ya es durable, como al ponerse al día tras un reinicio, de la regla de ADR-0024 §3.
- **Los lotes** valen en `shadow` desde que el motor los lee, no desde su recepción, porque `buoh-operaciones` los guarda cada 5 minutos (precisión de ADR-0021 §3 y §4 y de ADR-0024 §4, que decían que `shadow` los usaba desde su recepción).
- **Así**, para el mismo log, `shadow` da la secuencia del backtest salvo en las entradas que su registro enumera, como un plazo cumplido antes de verse un tick ya recibido, y la réplica reproduce exactamente la de `shadow` (ADR-0024 §3).

### 4. La política de datos en vivo

El motor aplica ADR-0022 §7 con el estado de §2 (`F2-STOP-001`):

- **Se detiene** con la salud distinta de `healthy`, con `connection_lost` o `event_gap_unresolved` abiertas, con la continuidad pendiente, con datos más viejos que `max_data_age_ms`, o con un perfil o un esquema distintos de los declarados; también con un incidente de integridad (§2). La falta del motor no es una detención (§5).
- **Fuera del horario** de su mercado (ADR-0021 §3), no decide ni se detiene: un cierre programado no es una degradación. Dentro del horario, un mercado que deja de mandar datos la detiene por datos viejos. Un día sin horario no decide, con la causa `schedule_unknown` (ADR-0024 §4).
- **La reapertura** (precisión de ADR-0022 §7 y ADR-0024 §5, igual en el backtest). Al abrir el horario, la antigüedad se cuenta desde la apertura, y una salud distinta de `healthy` que empezó con el mercado cerrado no detiene la estrategia durante `max_data_age_ms`: en ese plazo no decide, con la causa `market_closed`. Si al pasarlo no hay salud `healthy` y un dato fresco, se detiene. Así, el oro, que se vuelve a suscribir a la hora de apertura (ADR-0021 §2), no cuenta como detenido si su primer tick llega a tiempo; en el log 5, el primer tick de cada conexión llegó con un retraso de entrega de 915 ms de mediana y de 1974 ms como mucho.
- **Vuelve sola** una detención por datos degradados, las cuatro primeras causas, cuando los datos vuelven a cumplir la política y no queda abierta una causa a mano, dure lo que dure (decisión del propietario del 2026-11-16).
- **Vuelven a mano** un perfil o un esquema distintos, una salud `failed` porque el log no se deriva, un incidente de integridad, la caída máxima, una deriva (ADR-0025 §9) y una pausa del propietario. El propietario reanuda desde la sección Laboratorio, que le muestra la causa y el registro del motor desde la detención, con un análisis escrito que la API exige y una confirmación explícita. Tras un incidente de integridad, la API exige además que el estado del motor diga que la comprobación que falló vuelve a pasar (operación y control de riesgo §8). Solo levanta las causas a mano: con una por datos degradados abierta, la estrategia sigue detenida. Tras la caída máxima, la caída se vuelve a contar desde ese instante, y el informe muestra las dos; si no, se detendría en el mismo evento (precisión de ADR-0022 §5).
- **Quién registra cada detención** (precisión de ADR-0022 §7 y §10). Las detenciones y las vueltas solas, el motor, en su registro (§6), sin sumar decenas de filas al día al de la API. Las pausas, las reanudaciones y las retiradas del propietario, la API, en su registro y en su auditoría, con `strategy_paused`, `strategy_resumed` y `strategy_retired`, de la cuenta y con su texto (precisión de ADR-0019 §5), como la pausa por deriva (§7); el motor las aplica como entradas. El Laboratorio muestra la estrategia en `paused`, con su causa, mientras el motor la tiene detenida, y la Auditoría muestra los dos registros.

### 5. Reinicios y despliegues

- **Una instancia.** El motor toma un bloqueo propio de PostgreSQL (`buoh:senales`), y una segunda instancia lo espera, como `ingest` el suyo (ADR-0018 §5). Con `SIGTERM`, termina el evento en curso, guarda su estado y suelta el bloqueo.
- **Su estado**, el de cada versión (la vista de su secuencia, el anfitrión, el evaluador y su grupo de omisiones abierto), en JCS y con su hash, se guarda cada 72 segmentos cerrados de su secuencia, unas 6 horas, en cada corte de log y al parar.
- **Tras un reinicio** (`F2-SHADOW-001`), parte de su último estado y vuelve a aplicar lo durable desde ahí; las filas ya registradas tienen que salir iguales, y si no, es un incidente de integridad. Después guarda la entrada `engine_unavailable`, desde su último registro durable (una fila, el estado del servicio o su estado) hasta su reloj al volver.
- **Mientras faltó** (precisión de ADR-0022 §8: un evento nuevo, que el backtest no usa), la estrategia no decide, y cada señal queda omitida con la causa `engine_unavailable`, como pide `F2-SHADOW-001`. No es una detención ni una pausa del protocolo §5: la estrategia sigue `active`, y al terminar el intervalo decide otra vez, si no tiene otra causa abierta. Una venta de buoh, la salida por reglas o el tiempo máximo de un multiplicador, espera a la vuelta del motor y paga su latencia desde ella. El stop loss, el take profit y la pérdida de la apuesta, que aplica Deriv, siguen con los ticks.

### 6. Lo que guarda

En un esquema propio, `buoh_senales`, con su secuencia de migraciones, que aplica el paso 1 de `buoh-operaciones` como las de `buoh_datasets` (ADR-0020 §5). Sus tablas son append-only, como las de la Fase 1.

- **Las decisiones** (`ShadowDecision` 1.0.0): cada `entrar`, `salir`, `liquidar`, `omitir`, `detener` y `reanudar`, con lo que pide `F2-REPLAY-001`: la versión de la estrategia por su hash, que incluye sus parámetros; las de la vista, el anfitrión, el evaluador y el motor (`shadow-engine-1.0.0`); el perfil y el esquema de sus datos; su posición en el log, su instante y su causa; y el contrato y los importes, como `BacktestDecision` (ADR-0024 §10). Las omisiones seguidas con la misma causa van en una fila, que se escribe con la decisión siguiente o al guardar el estado. `processed_at_utc`, el reloj del motor al decidir, va fuera del hash: con él la evidencia mide el retraso entre el tick y la decisión.
- **Una cadena por versión.** Sus entradas y sus decisiones comparten una secuencia, y cada fila lleva su número, el SHA-256 de su JCS sin `processed_at_utc` y el de la fila anterior: la réplica compara fila a fila, y la cadena descubre una fila que falta o cambió de orden.
- **Las señales** (`SignalEvent` 1.0.0; `F2-SIGNAL-001` y [seguridad y rigor](../../gobierno/seguridad-y-rigor-cuantitativo.md) §7), una por cada `entrar` y una por cada fila de entradas omitidas, con su número y su primer y su último instante: la estrategia y su versión, el símbolo, el instante y el tick que decidió; la compra y el vencimiento (ADR-0024 §6); el contrato; la condición, con el valor de cada indicador en el texto decimal más corto que lo representa; la calidad, con la salud, la antigüedad de los datos y las marcas del tick; `execution_mode: shadow`; la evidencia, por el hash de su `EvidenceReport` y la entrada de auditoría de su aprobación (ADR-0025 §11); y si se emitió o se omitió, con su causa. La web solo la muestra vigente sin la decisión que la termina y antes de su vencimiento.
- **El estado del servicio** (`ShadowEngineStatus` 1.0.0), cada minuto: la versión del motor, la última posición aplicada en cada secuencia, el retraso medio y el mayor del minuto, y cada versión, en marcha o detenida con su causa, que la web muestra (`F2-SHADOW-001`).
- **Su espacio** (estimación, que mide el PR 6): unos 0,3 MB al día del estado del servicio y, por versión, unos 0,25 MB al día de sus estados y unos cientos de filas al día de entradas, decisiones y señales, de alrededor de 1 KB cada una, que cubre la revisión de la base a 3 GB (ADR-0021 §6).

### 7. Posiciones y deriva (F2.10)

- **Las posiciones** (`ShadowPosition` 1.0.0) tienen los campos de `BacktestPosition` (ADR-0024 §10), su señal y su decisión `entrar`, por su número en la cadena, con la semántica de su contrato de Deriv (ADR-0022 §5) y las cotizaciones que ve el motor (§3). Nunca existe una orden.
- **La deriva** (ADR-0025 §9) la calcula la API en la cola de su proceso hijo, después de los estadísticos de las búsquedas y antes de las réplicas, porque puede pausar una versión que ya está en `shadow` (precisión de ADR-0025 §10), que ya tiene las operaciones de validación y fuera de muestra y lee las del motor con `buoh_api_lectura`. Cadencia: una vez al día, después de las 00:00 UTC, para cada versión en `shadow`, con lo liquidado hasta entonces (precisión de ADR-0025 §9). Una deriva pausa la versión en el registro de la API, con `strategy_drift_detected`, y el motor la aplica como entrada.
- **Sus falsas alarmas.** El PR 7 las mide en vectores sin deriva, con operaciones de Poisson y en rachas con una varianza del doble de su media, durante 56 días de pruebas diarias. Una versión sin deriva tiene que pausarse por azar en esos 56 días como mucho un 5 % de las veces; si no, el PR baja el nivel de cada prueba hasta cumplirlo y lo registra en ADR-0025 §9.
- **El informe** del Laboratorio muestra juntos el backtest, la validación, la prueba fuera de muestra y `shadow`, cada cifra con su modo y su contexto (`F2-POSITION-001`).

### 8. Volver a encender

En el mismo PR, el protocolo de validación §5 suma que, en `shadow`, una detención por datos degradados vuelve sola cuando los datos vuelven a cumplir la política de la estrategia y no queda otra causa abierta; que fuera del horario de su mercado la estrategia no decide ni se detiene; y que un incidente de integridad no es una degradación de los datos. El catálogo de funciones adelanta «Volver a encender» a la Fase 2 para `shadow`, en la web, con la vuelta sola tras datos degradados. Las demás pausas siguen pidiendo el análisis, la evidencia y la decisión auditada. En demo y con dinero real se decide con su política de riesgo (`PROJECT_STATUS.md`, «Decisiones pendientes»).

### 9. La réplica (`decisions:replay`)

- **El comando** es el del plan §9, `pnpm run decisions:replay -- --from <UTC> --to <UTC> --json`. Para cada versión con decisiones en el período, lee su registro y su definición guardada, y los datasets publicados y verificados de su serie desde su `indicators_from_utc`, también los de los lotes, con `buoh_datasets`. Repite la vista, el anfitrión y el evaluador con las entradas del registro, cada una en su posición.
- **Comprueba cada entrada:** un paso del tiempo tiene que ser el próximo plazo en su posición, y no puede faltar ninguno anterior al evento siguiente; un registro de los lotes tiene que estar en su dataset, con su hash y una recepción anterior a su instante; y una acción del registro de la API se comprueba por lo que guardó el motor, porque la réplica no lee `buoh_api`, y el informe lo dice.
- **Su salida:** las decisiones que coinciden, las que no, con su número y sus hashes, y las que esperan su dataset, que se publica cada 6 horas (ADR-0020 §7). Sale con 0 si todas coinciden, con 1 si alguna no y con 2 por un error de uso. No escribe nada ni contacta a Deriv, y su memoria es la de la vista. Lo corre el agente con su acceso de solo lectura, y las pruebas, sin red.

### 10. Dónde corre, credenciales y costo

- **El servicio.** `buoh-senales`, un background worker Starter de `render-datos.yaml`, en `virginia`, con una instancia, `maxShutdownDelaySeconds: 60` y `WORKER_NODE_FLAGS` (ADR-0018 §2). Su memoria máxima medida en Render no pasa de 256 MB (`F2-SHADOW-001`), y en local tampoco, con 10 versiones de los dos símbolos y las dos vistas en el techo de lo retenido (ADR-0024 §2).
- **Su rol**, `buoh_senales` (complementa ADR-0018 §8): miembro de `buoh_lectura`, para los logs en vivo y de los lotes; `SELECT` en las tablas del registro de estrategias de `buoh_api`, y nada más en ese esquema (precisión de ADR-0019 §7); e `INSERT` y `SELECT` en `buoh_senales`. `buoh_lectura` y `buoh_api_lectura` reciben `SELECT` en `buoh_senales`, para el agente y la API. `buoh-operaciones` crea el rol y le da sus permisos, con la contraseña que genera Render, como a los demás, y el motor se conecta con `require` (ADR-0018 §9), con su prueba.
- **Su token de R2**, `senales`, con *Object Read only* solo sobre `buoh-captura`, lo crea el propietario (complementa ADR-0018 §10). El PR 4 comprueba que `buoh_lectura` lee los logs de los lotes, y si no, se lo da (complementa ADR-0021 §3).
- **El costo.** El Starter, unos 7 USD al mes, ya está aprobado dentro de los unos 56,50 USD de la Fase 2 (decisiones vigentes, «Servidor del motor de señales *shadow*»), y se compra con el PR 4, que conviene fusionar cuando haya, o esté por haber, una versión aprobada (ADR-0025 §11). Sus lecturas de R2 no estaban contadas (plan §11): con una petición por evento, unos 1,35 millones al mes de R_100 (45 139 eventos el 2026-11-23), unos 1,8 millones del oro (unos 59 000 al día, ADR-0021 §6) y unos 0,3 millones de las cotizaciones. Con los unos 12 millones de clase B de ADR-0021 §6, R2 cobraría 6 millones en lugar de 2, unos 1,44 USD más, y Render contaría cada petición como alrededor de 1 KB de tráfico de salida (ADR-0018 §13), unos 0,51 USD más. En total, unos 2 USD más al mes, alrededor de 1 con solo versiones de R_100 (estimaciones, que mide el PR 6): unos 58,50 USD al mes, que aprobó el propietario el 2026-11-24 («Ok opcion A, creo que es mas efectiva»; [decisiones vigentes](../../gobierno/decisiones-vigentes.md), «Lecturas de R2 del motor *shadow*»). Si lo medido pasa de lo aprobado, el agente se lo vuelve a presentar antes de seguir (plan §4, punto 8).

### 11. Los ensayos de la puerta de salida

La puerta (plan §13) pide que, en los 7 días de su ventana, el motor se detenga sin intervención ante cada degradación, natural o provocada, y que cada reanudación siga su regla. En F2.11, el agente lee el log y el registro del motor con su acceso y comprueba:

1. **Las degradaciones naturales.** Cada reconexión no pedida, continuidad pendiente, tramo de datos viejos y fallo de guardado dentro del horario tiene su detención, con su causa y su instante, y su vuelta sola. Al ritmo del log 5 son unas 150 en 7 días, más las de los despliegues.
2. **Un reinicio de `buoh-ingesta`**, que lanza el propietario en Render (**Manual Deploy → Restart service**): un cierre pedido, con su detención y su vuelta sola. No corta la captura más que un despliegue.
3. **Un reinicio de `buoh-senales`**, igual: su entrada `engine_unavailable`, sus señales omitidas y el motor siguiendo desde su estado.
4. **Una pausa del propietario** desde la web, con un reinicio de `buoh-ingesta` mientras dura: con los datos ya bien, sigue detenida hasta que la reanuda, con su análisis escrito.
5. **El mercado cerrado**, si la estrategia es del oro: de 22:00 a 23:00 UTC, ninguna decisión ni detención, y la reapertura con su regla (§4).
6. **La réplica:** `decisions:replay` sobre la ventana da todas las decisiones iguales.

Un perfil o un esquema distintos, un log que no se deriva, un incidente de integridad, la caída máxima y una deriva no se provocan en producción: los cubren los vectores (§12).

### 12. Pruebas

- **El motor**, sin red y con log, reloj y temporizador falsos, como `F1-VECTOR-001`: cada causa de §4, con su vuelta sola o a mano, y la que no vuelve con una causa a mano abierta; la reapertura; el plazo del reloj y un tick tardío anterior a él; un reinicio, con filas iguales y distintas; un objeto, un segmento o un estado vivo alterados; las omisiones agrupadas; y la cadena. Sin la condición no hay señal, la prueba de falsos positivos de seguridad y rigor §9, y una señal vencida nunca es vigente (`F2-SIGNAL-001`).
- **La equivalencia y la réplica:** sin entradas distintas, `shadow` da la secuencia del backtest, evento a evento; las decisiones se repiten iguales desde datasets sintéticos; un dato tardío no cambia las anteriores (`F2-REPLAY-001`); y se detectan una fila alterada, un plazo falso o que falta y un registro de los lotes que no está en su dataset.
- **La integración**, con PostgreSQL y almacenamiento locales: el bloqueo, las tablas append-only (`42501`), el rol, `require` y la lectura con una petición. **La memoria**, con el criterio de §10.

### 13. Secuencia de entrega

El código empieza con las cinco ADR del laboratorio fusionadas (plan §8), después de F2.8 (plan §9) y de lo que cita cada PR. Lo que esta ADR suma al evaluador (la reapertura, la falta del motor, la pausa del propietario, el incidente de integridad y la caída tras una reanudación; ADR-0022 §5, §7 y §8) lo implementan el PR 3 de ADR-0022 y el PR 2 de ADR-0023. Nueve PR:

1. Esta ADR, con el protocolo de validación, el catálogo de funciones, las dos decisiones del propietario del 2026-11-24 en las decisiones vigentes y sus precisiones al plan, a `PROJECT_STATUS.md`, a ADR-0019, ADR-0020, ADR-0021, ADR-0022, ADR-0024 y ADR-0025, al runbook de ingesta, a los contratos de dominio y al `README.md`.
2. **Los contratos** `ShadowInput`, `ShadowDecision`, `SignalEvent` y `ShadowEngineStatus`, con su JSON Schema y su semántica en los contratos de dominio.
3. **`apps/signal-engine`** sin desplegar, con las pruebas de §12 y la memoria en local, después del PR 4 de ADR-0024 (el anfitrión) y del PR 4 de ADR-0022 (el registro de estrategias). Suma su regla al mapa de impacto (`F2-GOV-001`).
4. **El despliegue:** las migraciones de `buoh_senales`, el rol, el token, `buoh-senales` en `render-datos.yaml` con su prueba, y el runbook, fuera de la rotación de la credencial dueña, como los PR 3 y 5 de ADR-0021.
5. **La API y la web:** el estado del motor, la sección Señales, las acciones del propietario con su auditoría y los eventos del motor en la Auditoría.
6. **La evidencia de F2.9**, con la primera versión aprobada: la memoria, las lecturas de R2 y el tráfico de salida, el retraso entre el tick y la decisión, la carga de la base y las comprobaciones de §10. Con ella, F2.9 está hecho.
7. **Las posiciones y la deriva** (§7).
8. **`decisions:replay`** (§9), con el runbook.
9. **La evidencia de F2.10:** la réplica de los primeros días en producción y la deriva medida. Con ella, F2.10 está hecho, y F2.11 corre los ensayos de §11.

## Consecuencias

- El motor ve cada degradación en su evento, también las breves, y la réplica la repite. Al ritmo del log 5, una estrategia de R_100 se detendrá unas 25 veces al día, casi siempre unos segundos, y el informe suma el tiempo detenida.
- `shadow` y el backtest dan la misma secuencia salvo en las entradas que el registro enumera: la comparación con la evaluación es estadística (ADR-0025 §9).
- Una decisión lleva el instante de su tick, no el de su proceso: si el motor se atrasa más que la latencia declarada, `shadow` sale optimista, y la evidencia lo mide.
- Un cambio del perfil o del esquema de un símbolo, como una release nueva de Deriv, detiene sus estrategias hasta una versión nueva, con su validación.
- La base Basic-256mb suma dos consultas por segundo y secuencia, y R2, unos 2 USD al mes.

## Alternativas descartadas

| Alternativa | Por qué no |
|---|---|
| La salud de `operations_reports` | Llega cada 5 minutos o más, no vio ninguno de los cortes del log 5 y no está en los datasets. |
| `data:health` en cada decisión | Tarda hasta 30 s, llega a 118 MiB (ADR-0019 §8) y usa el latido, que la réplica no tiene. |
| El latido y el registro operativo | No están en los datasets, y la antigüedad de los datos ya da su efecto. |
| Leer solo los segmentos cerrados | No cuesta, pero cada decisión llegaría hasta 5 minutos tarde, con su señal ya vencida. |
| `HeadObject` y `GetObject` por evento | Doblan el costo, y el tamaño de la fila y el hash bastan. |
| Un aviso de `ingest` con `NOTIFY` | Cambia la captura, y se pierde si el motor no está conectado. |
| El reloj del motor como instante | El backtest no lo tiene, y ninguna decisión se podría repetir. |
| Decidir con normalidad al ponerse al día | Un bot real no habría operado mientras faltaba (`F2-SHADOW-001`). |
| Las detenciones en el registro de la API, o la deriva en el motor | El motor tendría que escribir en `buoh_api`, o leer sus tablas y `buoh-investigacion`. |

## Condiciones de revisión

- El retraso entre el tick y la decisión pasa a menudo de la latencia declarada, o el de verse un tick durable pasa del margen de 1000 ms.
- Las lecturas de R2 o el tráfico de salida medidos no caben en el presupuesto.
- La memoria en Render pasa de 256 MB, o la base nota la carga del motor.
- Son frecuentes los plazos cumplidos antes de verse un tick ya recibido.
- La deriva pausa versiones que, vistas después, estaban sanas.
- `decisions:replay` encuentra una decisión distinta.
- Las tablas de `buoh_senales` pasan de 500 MB.
- Llega la Fase 4, con demo.

## Referencias verificadas

En `main` (`cfcadfd`), el 2026-11-24: el [plan de Fase 2](../../plan/fase-2-laboratorio-y-bot-shadow.md), §4, §8, §9, §11, §13 y los requisitos del «Ámbito»; el protocolo de validación §5; [seguridad y rigor](../../gobierno/seguridad-y-rigor-cuantitativo.md) §7 y §9; [operación y control de riesgo](../../gobierno/operacion-y-control-de-riesgo.md) §6; el catálogo de funciones; los [contratos de dominio](../contratos-de-dominio.md), «Cómo se lee la causa»; `packages/domain/src/derivation-rules.ts`, `apps/market-data-worker/src/s3/object-store.ts`, `apps/market-data-worker/migrations/0002_log_raw_first.sql` y `scripts/evidencia-f2-5/medir-umbrales.mjs`; y la lectura del log 5 de «Medición».
