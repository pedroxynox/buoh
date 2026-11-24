# ADR-0021: Mercados reales y fuentes de investigación (F2.5b)

- **Estado:** Aceptada; complementada por [ADR-0024](0024-semantica-del-backtest.md) (el horario del día siguiente en §3, y `ContractOffer` y la recepción de los registros de los lotes en §4) y por [ADR-0026](0026-motor-de-senales-shadow.md) (qué salud lee el motor `shadow` en §1, cuándo valen los lotes en `shadow` en §3 y §4, y que `buoh_lectura` lea los logs de los lotes en §3)
- **Fecha:** 2026-11-16
- **Ámbito:** Fase 2, incremento F2.5b (`F2-MARKET-001` del [plan de Fase 2](../../plan/fase-2-laboratorio-y-bot-shadow.md), §8, punto 9). Fija también lo que toman de ella F2.6 y F2.7 (las velas, los ticks de la historia y lo que cobra Deriv como datos del backtest) y F2.9 (los horarios de cada mercado, `F2-STOP-001`).
- **Decisores:** Propietario de buoh (los mercados, guardar la historia, el disco de 5 GB y el presupuesto, decididos el 2026-11-16; plan §12), a propuesta de la dirección técnica (lo demás).
- **Complementa:** [ADR-0004](0004-pipeline-y-reproduccion-de-datos-fase-1.md), con datos que no son ticks (§4) y una política de segmentos para los lotes (§3); [ADR-0007](0007-varias-fuentes-y-metatrader-5.md) §1, con varios conectores de una misma fuente (§3); [ADR-0012](0012-catalogo-y-adaptador-publico-de-deriv.md) §1, §2 y §5, con un conector por lotes, los esquemas de `trading_times`, `contracts_for` y `proposal`, y el error de mercado cerrado (§2 y §3); [ADR-0015](0015-reconexion-recuperacion-y-salud-f1-5.md) §3, con una sesión que no termina el proceso (§1); [ADR-0017](0017-punto-de-control-de-la-derivacion-en-vivo.md) §9, con el techo de memoria de dos sesiones (§1); [ADR-0018](0018-sistema-de-datos-en-produccion.md) §2 (el disco y el comando de `ingest`), §3 (`ingest` ya no sale por una sesión que falla), §6 (las secuencias de logs), §7 (los umbrales de revisión del espacio), §8 y §10 (el rol y el token de los lotes) y §11 (el paso nuevo de `buoh-operaciones`); [ADR-0019](0019-api-cuentas-y-auditoria.md) §8 (las publicaciones de la Auditoría, §5); y [ADR-0020](0020-datasets-vivos.md) §1 (los umbrales del oro), §4 (un perfil por log), §5 y §8 (la secuencia en `buoh_datasets` y en la publicación), §6 (la retención y su revisión) y §7 (el techo y los datasets de los lotes).

## Resumen para el propietario

- **Qué decide.** Cómo entran en buoh el oro en vivo, un año de historia de Deriv y lo que cobra Deriv por sus contratos, para que el motor de investigación tenga con qué estudiar.
- **El oro en vivo.** Se captura como R_100, en su propia serie de cuadernos semanales (logs), en el mismo servidor. Cuando el oro cierra, buoh espera y vuelve a intentarlo, sin darlo por fallo. Si el servidor no aguanta los dos, el oro necesita uno propio, de 7 USD al mes, y te lo pregunto antes.
- **La historia.** buoh descarga, poco a poco, un año de ticks de R_100 y del oro, un año de velas de 1 minuto de los siete mercados y los horarios de cada día. Se guardan para siempre, solo para tu uso.
- **Lo que cobra Deriv.** Cada 30 minutos, buoh pregunta cuánto paga un sube/baja y cuánto cobra un multiplicador en cada mercado, y lo guarda. Sin eso, el motor no puede saber si una estrategia gana después de los costos.
- **Costo.** Unos 54 USD al mes (estimación): 3 más que los 51 de antes, por el tráfico de salida de Render y las lecturas de R2 que suma el oro. Lo aprobaste el 2026-11-16.
- **Riesgo.** Nada de esto opera ni usa una cuenta de Deriv. R2 llegará a 8 GB en semanas, cuando se descargue la historia, y ahí revisamos juntos cuánto se guarda.
- **Qué apruebas al fusionarla.** Todo lo de arriba, y el orden de ocho PR de §9.

## Contexto

El 2026-11-16 el propietario decidió que un motor de investigación busque las estrategias, que buoh opere primero en Deriv con multiplicadores y sube/baja, que se capturen en vivo R_100 y el oro, que el motor estudie con un año de velas el oro, la plata, el EUR/USD, el GBP/USD, el USD/JPY, Bitcoin y Ethereum, y que la historia de Deriv se guarde todo el tiempo, para uso propio ([decisiones vigentes](../../gobierno/decisiones-vigentes.md), «Motor de investigación»). Aprobó también el disco de 5 GB («Disco, VPS y reanudación»). El plan de Fase 2 lo recoge en `F2-MARKET-001` y pone esta ADR antes del código de F2.5b (§8, punto 9).

Lo que el código supone hoy (análisis del repositorio en `main`, `b2f5797`):

- **Un símbolo por captura.** `ingest` recibe un solo `--symbol`, fijo en `render-datos.yaml` (`--live --symbol R_100`), y la conexión de Deriv se suscribe a un solo símbolo y recupera la historia de uno solo (`apps/market-data-worker/src/deriv/connection.ts`). Si la suscripción responde con un error, la sesión termina con `subscription_failed`, la salud es `failed` y `ingest` sale, para que Render lo reinicie (ADR-0012 §5 y ADR-0018 §3).
- **Un bloqueo y una secuencia por fuente.** La clave del bloqueo es `buoh:source-log:<fuente>` (`src/postgres/source-lock.ts`), para toda la base. El log activo se elige por la última escritura de la fuente (`src/successive-logs.ts`), y en `buoh_datasets`, `dataset_log_ranges` identifica cada log solo por su número (`migrations-datasets/0001_datasets.sql`). Un segundo `ingest` de la misma fuente espera el bloqueo sin fin, y aunque lo tomara, elegiría el mismo log y fallaría con `symbol_mismatch`.
- **Un perfil por log, de un símbolo.** `log_quality_profile` admite una fila (ADR-0020 §4), y `buoh-operaciones` le pone siempre la de R_100 (`src/deriv/log-profile.ts`). El dominio admite varios símbolos en un perfil, pero sus umbrales son únicos por perfil.
- **Nada sabe de horarios.** No hay ningún temporizador de inactividad de ticks ni ninguna petición `trading_times`. Un silencio dentro de una conexión no abre ninguna condición.
- **La historia solo repara huecos.** `ticks_history` entra como respuesta pedida para cerrar un hueco de la captura, y las reglas 3.0.0 solo convierten en `MarketTick` los ticks de un resultado `complete` que resuelve ese hueco (ADR-0020 §3). No hay contrato de vela ni de cotización de contrato.
- **El disco es de 1 GB** (`diskSizeGB: 1`), y la revisión del espacio está en 600 MB de base y 700 MB de disco (ADR-0018 §7).

## Medición

Consultas de solo lectura al canal público de Deriv, el 2026-11-16, de las 03:40 a las 12:05 UTC, sin guardar precios (los mercados, los tipos de contrato y la historia de velas y de ticks están en el plan, §3):

- **Ritmo.** El oro mandó 120 ticks en 120 s, y R_100, 61.
- **Horarios** (`trading_times`, pedidos para el día en curso y para un día pasado). El lunes, el oro cotiza de 00:00 a 22:00 y de 23:00 a 23:59:59 UTC; el sábado 2026-11-14 no cotizó. El EUR/USD cotiza todo el lunes y tampoco el sábado. Bitcoin cotizó el sábado.
- **Mercado cerrado.** A las 12:04 UTC, la suscripción `ticks` a `OTC_HSI`, cerrado entonces según `active_symbols`, respondió con el error `MarketIsClosed`, con la hora de apertura en el mensaje, y no mandó ningún tick en 20 s. No se midió con el oro cerrado; el PR 2 lo confirma.
- **Páginas de historia.** Con `count` de 5000 o de 10 000, `ticks_history` devolvió 1000 ticks del oro, unos 19,2 KB. Una página de velas de 1 minuto cubre unos 1000 minutos: trajo 940 velas, con la hora cerrada del oro, unos 76 KB.
- **Cotizaciones** (`proposal`, sin cuenta). Responden en unos 600 a 900 bytes. El oro solo acepta multiplicadores de 50, 100, 150, 250 y 500.

## Decisión

### 1. Secuencias de logs

Una **secuencia** es una serie de logs de una fuente con su nombre, su esquema y su prefijo por log, su bloqueo, su log activo, su corte semanal y su vencimiento a los 30 días, como la de hoy (ADR-0018 §6 y §7). Cada símbolo capturado en vivo tiene la suya, y también cada clase de datos por lotes (§3). Dos secuencias nunca comparten un log, así que cada log sigue con un perfil de un solo símbolo o de una sola clase de datos (ADR-0020 §4).

- **R_100 conserva su secuencia** tal como está: los mismos nombres de esquema (`buoh_log_NNNNNN`) y de prefijo (`logs/NNNNNN/`) y la misma clave de bloqueo. Nada de lo ya guardado cambia.
- **Las demás** llevan su nombre en el esquema, sin casar con `^buoh_log_[0-9]{6}$`, en el prefijo, bajo `logs/` para que las cubran la regla de 30 días de `buoh-captura` (ADR-0018 §10) y la retención, y en la clave del bloqueo. Su PR fija los nombres exactos.
- **`buoh_datasets`** identifica cada log por su secuencia y su número. Una migración nueva de ese esquema añade la secuencia a `dataset_log_ranges`, con R_100 como valor de las filas que ya existen, y la contigüidad y la clave única pasan a ser por secuencia. `datasets:publish`, el paso 6 de `buoh-operaciones` y `data:health --log` nombran la secuencia del log.
- **`buoh-operaciones`** prepara, mide, corta, publica y borra cada secuencia por separado. `data:health` se ejecuta para cada secuencia en vivo, con su `--symbol`, y guarda su informe en su log. (Precisión del PR 2b: las secuencias de `buoh-operaciones` son las de los símbolos de `BUOH_OPERACIONES_SIMBOLOS`, que sin la variable es solo R_100 y siempre la incluye, porque su log activo guarda los informes que no son de un log; el PR 3 añade el oro. La salud y el informe final dejan un informe por secuencia, en su log, y el de otra secuencia que falla sin log no se guarda, porque la salud del log activo de R_100 es la que lee la API. (Precisión de [ADR-0026](0026-motor-de-senales-shadow.md) §2: el motor `shadow`, que esta frase nombraba, no lee esos informes, sino la salud que deriva del log.) La retención borra un log vencido por ejecución: de los de menor número de cada secuencia, el de la última escritura más antigua. El paso 6 publica solo R_100, con `--symbol`, hasta el PR 7, y su estado solo nombra la secuencia de un log que no es de R_100: una entrada sin ella es de R_100, como las de antes, y así el código anterior lo sigue leyendo si se vuelve atrás un despliegue. La retención mira los logs de todas las secuencias de la tabla, también la de un símbolo que salió de la configuración. En `production`, `data:health` solo admite el símbolo de una secuencia, y su escritor vivo es el del bloqueo de esa secuencia: el de R_100 es el de la fuente, y el de otra sale de `buoh:source-log:<fuente>:<nombre>`.) (Precisión del PR #130: en `production`, el último dataset del informe de `data:health` (`last_published_dataset_id`) es el de los logs de su secuencia, en `buoh_datasets`.)
- **Un solo proceso `ingest`** captura los dos símbolos, con una sesión, una conexión y un bloqueo por símbolo: `--symbol` se puede repetir. Una sesión que termina `failed` deja de capturar su símbolo, espera y vuelve a empezar dentro del proceso, como hoy hace Render al reiniciarlo, y la otra sigue. El proceso solo sale con un fallo que afecta a todas, como la configuración o la memoria.
- **Memoria.** Las dos sesiones comparten un proceso y su espacio de V8 (`WORKER_NODE_FLAGS`). El techo de 200 MB de ADR-0017 §9 era para una sola sesión; con dos, el PR 2 mide el proceso entero como en ADR-0017 §9, con las dos sesiones reconstruyendo a la vez sus puntos de control, y tiene que quedar por debajo de 256 MB, la mitad del Starter, que es también el techo en Render (`F2-DEPLOY-001`). Si lo pasa, el oro va a su propio background worker, unos 7 USD más al mes, y el agente pide antes el visto bueno del propietario.

### 2. El oro en vivo

- **Perfil de medición primero.** El oro se captura con `deriv_options-measurement-v2-frxXAUUSD`, sin publicar datasets vivos, como R_100 entre ADR-0018 y ADR-0020. Sus logs van sin fila de perfil, que es como un log se deriva con el de medición (ADR-0020 §4). Con al menos 7 días de esa captura, el PR 7 fija sus umbrales con la regla de ADR-0020 §1 y su script de medición, en un perfil de publicación propio, y desde el corte siguiente de su secuencia cada log nuevo lleva su fila. El mismo PR publica con ese perfil los logs del oro ya capturados, desde su segmento 0, como el PR 4 de ADR-0020 con R_100, para que no quede ningún hueco entre su historia y sus datasets. El PR 7 no espera a los PR 4 a 6: va en cuanto hay 7 días, y tiene que estar en producción al menos 7 días antes de que venza el primer log del oro, 30 días después de su última escritura, porque publicar sus unos 30 datasets lleva su tiempo y la retención no espera a la publicación; el PR 3 deja esa fecha en `PROJECT_STATUS.md`. Si el PR 7 llega antes que el PR 5, trae él la agrupación por secuencia de §5, para que los datasets del oro no se mezclen con los de R_100.
- **Su techo.** El oro manda unos 22 000 elementos en 6 horas, más que el techo de 16 000 de ADR-0020 §7. El techo se mantiene, porque es el que cabe en la memoria medida, y sus datasets terminan en el techo, unas 4 horas, y no en la marca de 6 horas. Es la revisión que ADR-0020 («Condiciones de revisión») pedía con un segundo símbolo.
- **Mercado cerrado.** Si Deriv responde a la suscripción con `MarketIsClosed`, la sesión del oro no falla. Guarda el frame como hoy, que las reglas registran como `source_error_response`, cierra la conexión como cierre pedido, y vuelve a intentarlo a la hora de apertura que trae el mensaje de Deriv. Si el mensaje no la trae o no se entiende, o si a esa hora sigue cerrado, espera de forma creciente, de 1 minuto a 1 hora. Así pierde muy poco al abrir, porque un cierre pedido no recupera historia (ADR-0018 §5). Es una regla de la sesión, no de las peticiones. Si el PR 2 concluye que ADR-0012 §1 pide otra versión del conector, esa versión entra solo desde un log nuevo de cada secuencia, como un perfil.
- **Silencio.** Con la conexión abierta, un silencio sigue sin abrir condiciones, y un corte no pedido con el mercado cerrado deja la continuidad pendiente hasta el primer tick, con la salud en `recovering`. La salud no cambia de contrato. Lo que distingue un mercado cerrado de un fallo es el horario guardado de cada día (§3): lo usa el motor `shadow`, que fuera del horario no decide ni se detiene (`F2-STOP-001`), y lo usa la evidencia para explicar la salud del oro.

### 3. Secuencias por lotes

Lo que no llega por la suscripción en vivo entra por peticiones sueltas al mismo canal público de Deriv, sin cuenta. Sigue siendo la fuente `deriv_options`, el mismo instrumento (ADR-0007 §1), con su propio conector, `deriv-options-lotes-1.0.0`, porque cambian las peticiones (ADR-0012 §1). Tiene cinco secuencias, cada una con su perfil: la historia de R_100, la historia del oro, las velas, las cotizaciones y los horarios.

- **Raw primero.** Cada respuesta se guarda como `RawSourceFrame`, con su texto exacto y su hash, antes de normalizarla (ADR-0004). Lo derivado se regenera desde ahí.
- **Qué recoge:**
  - **horarios:** una vez al día, `trading_times` del día en curso, `active_symbols`, como catálogo de los lotes, y `contracts_for` de cada mercado, para saber qué multiplicadores y duraciones acepta; y en la descarga de la historia, `trading_times` de cada día del último año. (Precisión de [ADR-0024](0024-semantica-del-backtest.md) §4.) Pide también el `trading_times` del día siguiente, para que el horario de un día esté guardado antes de que empiece: desde el día siguiente al primer horario que guarda este paso, un backtest y el motor `shadow` usan cada horario desde que se recibe, y antes, desde las 00:00 de su día, como supuesto declarado. (Precisión de [ADR-0026](0026-motor-de-senales-shadow.md) §3, que cambia «y el motor `shadow`».) En `shadow`, cada registro de los lotes vale desde que el motor lo lee, porque este paso los guarda cada 5 minutos, y queda como entrada en su registro;
  - **cotizaciones:** cada 30 minutos, en cada mercado de `F2-MARKET-001` y en R_100, `proposal` con una apuesta fija de 10 USD de `MULTUP` y `MULTDOWN` con cada multiplicador que acepte ese mercado, y de `CALL` y `PUT` en las duraciones de una lista fija que ofrezca ese mercado (5 ticks, 15 segundos y 1, 5, 15, 60 y 240 minutos). Son como mucho unas 190 peticiones por vuelta, repartidas entre las seis ejecuciones de cada media hora. La lista y la apuesta van en el perfil, y cambiarlas crea otro perfil;
  - **velas:** las de 1 minuto del día anterior de los siete mercados, una vez al día.
- **Dónde corre.** En `buoh-operaciones`, como un paso nuevo, en un proceso aparte, como los demás pasos (ADR-0018 §11), con un rol nuevo, `buoh_lotes`, que solo inserta y lee en las secuencias por lotes y no tiene ningún privilegio en las secuencias en vivo, mientras `buoh_ingesta`, que ADR-0018 §8 pone en cada log, no tiene ninguno en las secuencias por lotes, con sus pruebas de `42501`, y con un token de R2 nuevo, `lotes`, de lectura y escritura solo en `buoh-captura`, que el propietario crea antes del PR 5. Ese proceso no recibe la credencial dueña ni la de otros roles. R2 no limita un token por prefijo, así que un token `lotes` filtrado podría escribir en todo el bucket, pero las reglas de bloqueo de `logs/` y de `datasets/` impiden reescribir o borrar lo que ya existe.
- **Ritmo con Deriv.** Una petición a la vez, por una sola conexión. Si Deriv responde con un límite de peticiones, el paso para y la ejecución siguiente sigue donde quedó.
- **Segmentos y datasets.** Una página de historia o de velas trae hasta unos 1000 elementos, así que las secuencias por lotes usan una política de segmentos nueva, que además cierra un segmento a las 15 respuestas. En los lotes, el techo de 16 000 de un dataset cuenta sus elementos normalizados (ticks, velas, cotizaciones o horarios) más las respuestas que no dan ninguno, como un error; en las secuencias en vivo sigue la cuenta de ADR-0020 §7. Así ningún segmento de los lotes pasa de unos 15 000 elementos, y ninguno detiene su log con `publication_segment_too_large`. Cada secuencia publica sus propios datasets, en rangos contiguos de sus segmentos (ADR-0020 §7), que no vencen (§6): uno por día de cotizaciones (unos 9100 elementos), uno por semana de horarios, y los de velas y de historia de como mucho 15 páginas.
- **Prioridad.** El paso 6 publica primero lo pendiente de las secuencias en vivo, y solo con el tiempo que sobra, un dataset de una secuencia por lotes.
- **Corte y log activo.** En los lotes no hay una conexión continua: el log activo es el de mayor número con escrituras, el corte semanal se hace al empezar el paso y no espera un momento limpio, y `buoh-operaciones` guarda el informe final del log terminado, con sus conteos y su último segmento cerrado. No ejecuta `data:health`, que es de las secuencias en vivo.

### 4. Contratos y la historia de un año

**Contratos nuevos**, en `packages/contracts`, con su JSON Schema y su semántica en los [contratos de dominio](../contratos-de-dominio.md). (Precisión de [ADR-0024](0024-semantica-del-backtest.md) §4.) Se suma `ContractOffer`, los multiplicadores y las duraciones que acepta un mercado, de `contracts_for`, y `ContractQuote`, `TradingSession` y `ContractOffer` llevan la recepción y la observación de su frame, como `MarketTick`, porque un backtest los usa desde que se reciben (en `shadow`, desde que el motor los lee; precisión de [ADR-0026](0026-motor-de-senales-shadow.md) §3):

- **`MarketCandle`:** una vela de Deriv (apertura, máximo, mínimo y cierre en decimal canónico, su hora UTC y su intervalo), con la procedencia de `MarketTick`. Son velas que calcula Deriv: nunca se mezclan con las que buoh arma con sus ticks, y una estrategia declara cuáles usa (ADR del modelo de estrategia).
- **`ContractQuote`:** lo que Deriv ofrecía por un contrato en un instante: tipo, símbolo, apuesta, duración o multiplicador, precio, pago o comisión, y la hora UTC de la cotización.
- **`TradingSession`:** los intervalos de un día en que un símbolo cotiza, en UTC.
- **`MarketTick`** suma un origen, el de los ticks de la descarga de la historia, aparte de `stream` y `history_recovery`. Un tick de ese origen no tiene retraso de entrega, porque se recibe mucho después de su hora.
- Los roles de los artefactos de un dataset suman los de esos datos. Las reglas de calidad de los lotes son un conjunto propio, con sus vectores sintéticos. Cada cambio de contrato sube su versión según los contratos de dominio.

**La descarga de la historia.** `buoh-operaciones` la hace por partes, unas 100 páginas por ejecución como mucho:

- los ticks de R_100 y del oro desde un año antes de su primer tick en vivo hasta ese tick, que para R_100 es el del log 1, del 2026-11-01, por tramos contiguos que no se solapan, pedidos con `start` y `end`; así la historia y la captura no se solapan. Esa hora es un parámetro del perfil de cada historia, que el agente lee de la captura con su acceso (runbook de ingesta, «Acceso del agente»), así que el paso no necesita leer la captura ni `buoh_datasets`;
- las velas de 1 minuto del último año de los siete mercados, y el horario de cada día de ese año;
- la descarga tarda unos 2 días (estimación), y su publicación, con un dataset por ejecución detrás de las secuencias en vivo, al menos unos 9 días.

Un tramo sin ticks, o con menos de los esperados, dentro del horario de su mercado queda como incidencia: nunca se rellena. Un tick repetido entre páginas es una incidencia, y el primero cuenta. Como la historia y la captura son de la misma fuente, un mismo tick tiene la misma huella en las dos. Para el PR 6, el agente descarga desde el sandbox un día ya capturado de R_100, sin guardarlo, y comprueba con su acceso que sus ticks coinciden con los de la captura; ese día no entra en ninguna secuencia.

Así, para R_100 y el oro, el backtest y el motor `shadow` usan los mismos datos, ticks y lo que buoh arme con ellos (plan §4.1). Para los otros cinco mercados solo hay velas: el motor de investigación informa lo que encuentre, pero no los propone para `shadow` (`F2-RESEARCH-001`).

### 5. Las pantallas y la Auditoría

- La API y la web siguen mostrando R_100. Mostrar el oro es un PR pequeño de `apps/api` y `apps/web`, que no pide `F2-MARKET-001`.
- La Auditoría y la sección Datos leen los datasets de la fuente `deriv_options` (ADR-0019 §8), y la Auditoría muestra los 200 eventos de datos más recientes. Los datasets de los lotes, unos 2600 con la historia, taparían los de la captura en vivo, y los contratos de la API identifican un log solo por su número. El PR 5, el primero que publica datasets de los lotes, hace que las dos secciones los agrupen por secuencia y que los contratos de la API nombren la secuencia, con una precisión de ADR-0019 §8 y del [concepto de interfaz](../../diseno/concepto-de-interfaz.md) §12 y §14.

### 6. Espacio, retención y costo

Estimaciones, que los PR miden:

- **PostgreSQL.** El oro manda un evento por segundo mientras cotiza, unos 59 000 al día de media, que con los pings, los latidos, los puntos de control y los informes son unos 18 MB por log y por día, unos 0,7 GB con 38 días (como ADR-0018 §7 para R_100). Con R_100 (0,55 GB), las secuencias por lotes (unos 0,1 GB) y las filas de los datasets nuevos (unos 0,07 GB), la base queda en unos 1,5 GB. El disco pasa de 1 a 5 GB antes de capturar el oro, como aprobó el propietario, y la revisión de ADR-0018 §7 y de ADR-0020 §6 pasa de 600 MB de base y 700 MB de disco a 3 GB y 3,5 GB.
- **R2, escrituras de clase A.** Unos 1,35 millones al mes de R_100, unos 1,8 del oro y unos 0,3 de las cotizaciones y los demás lotes: unos 3,45 millones, de los que R2 cobra 3 millones, unos 13,50 USD al mes, la cifra del plan §11. La historia suma unas 60 000, una vez.
- **R2, lecturas de clase B.** Pasan de unos 4,7 millones al mes (ADR-0018 §11) a unos 12 millones, con las lecturas de la salud, la verificación y la publicación del oro y de los lotes: R2 cobra 2 millones por encima de los 10 gratuitos, unos 0,72 USD al mes. El mes de la publicación de la historia suma unos 1,5 millones.
- **Tráfico de salida de Render.** Render cuenta lo que sus servicios envían a R2, también las peticiones (ADR-0016). Con la cuenta de ADR-0018 §13, el oro suma unos 11 GB al mes y los lotes unos 1,5 GB, unos 1,95 USD al mes a 0,15 USD por GB por encima de los 5 GB incluidos. La historia suma una vez unos 5 GB, unos 0,75 USD.
- **R2, espacio.** Los datasets de la historia de ticks ocupan unos 4 GB, casi todo en los ticks normalizados en gzip (unos 100 bytes por tick, ADR-0020, «Medición»), y los de velas unos 100 MB. Con los logs de 30 días de las secuencias en vivo, unos 3 GB, y los de la descarga mientras no vencen, unos 1,5 GB, R2 pasa de 8 GB el mes de la descarga: la revisión de ADR-0020 §6 con el propietario llega en semanas y no en dos años. R2 cobra el espacio por encima de 10 GB, a 0,015 USD por GB al mes (ADR-0016).
- **Retención.** Los logs de las secuencias por lotes vencen a los 30 días, como los demás. Los datasets que salen de ellos no vencen, como decidió el propietario para la historia de Deriv («Motor de investigación»), con la misma revisión de ADR-0020 §6.
- **Total.** Unos 54 USD al mes (estimación), unos 3 más que los 51 aprobados antes (plan §11). El plan pide el visto bueno del propietario antes de subir el presupuesto (§4, punto 8), y lo dio el 2026-11-16, después de fusionarla, en el mensaje en que lo avisó («ya hice merge apruebo 54 usd al mes»).

### 7. Términos de Deriv

Los términos de la API de Deriv solo permiten tener sus datos en caché 24 horas, y el propietario aceptó guardarlos todo el tiempo, para uso propio («Motor de investigación»). La redistribución sigue deshabilitada (ADR-0004 §13): nada de esto sale de buoh, y ningún precio, cotización ni vela entra en Git.

### 8. Pruebas

- **Secuencias:** con PostgreSQL y almacenamiento locales, dos sesiones de `ingest` en un proceso, cada una con su log, su bloqueo y su corte; que R_100 conserva sus nombres y su clave; que una sesión `failed` no corta la otra y vuelve a empezar; que `buoh_datasets` admite el mismo número de log en dos secuencias; y que `buoh-operaciones` da a cada log el perfil que le toca.
- **Mercado cerrado:** vectores con `MarketIsClosed` en la suscripción, con y sin hora de apertura en el mensaje: la sesión no falla, cierra como pedido y reintenta a la hora de apertura o con su espera.
- **Lotes:** el raw primero, las reglas con sus vectores sintéticos (un tramo vacío dentro del horario, un tick repetido, una respuesta de error, un límite de peticiones), la política de segmentos y el techo, el rol que solo inserta y lee, con `42501` en las secuencias en vivo, `buoh_ingesta` con `42501` en las secuencias por lotes, y `data:replay` de un dataset de cada clase en los dos modos.
- **Sin red, reloj real ni azar** en las pruebas offline, como `F1-VECTOR-001`. Ninguna prueba se conecta a Deriv.

### 9. Secuencia de entrega

El código empieza después del PR 6 de ADR-0020 (plan §9). Ocho PR:

1. Esta ADR, con sus precisiones al plan de Fase 2, a `PROJECT_STATUS.md` y a `CONTRIBUTING.md`.
2. Las secuencias en el worker, en `buoh-operaciones` y en `buoh_datasets`, `ingest` con varias sesiones y el mercado cerrado, con la medición de memoria de §1 y la comprobación de `MarketIsClosed` con el oro. No cambia lo que se captura. (Precisión del PR 2a: llega en tres partes, y ninguna cambia lo que se captura. El 2a trae los nombres de las secuencias, en la tabla `LOG_SEQUENCES`: R_100 con los suyos de siempre y el oro, `frxXAUUSD`, con el esquema `buoh_frxxauusd_log_<n>` y el prefijo `logs/frxxauusd/<n>/`; la lista, la búsqueda y la lectura de los logs de cada secuencia; y `buoh_datasets` por secuencia, con la migración `0002_secuencias`, que da `R_100` a los rangos que ya existen, y `sequence` en las líneas de `datasets:publish`. En producción solo cambia esa migración. El 2b trae `buoh-operaciones` y `data:health` por secuencia: la clave del bloqueo de cada una, la preparación de sus logs con su perfil, la salud con su `--symbol` y su informe final, la retención, la verificación, el espacio y el estado de la publicación. El 2c trae `ingest` con varias sesiones, con `--symbol` repetible y el reinicio de una sesión dentro del proceso, y el mercado cerrado, con la medición de memoria de §1 y la comprobación de `MarketIsClosed` con el oro.) (Precisión del PR 2c: la medición de memoria de §1, la comprobación con el oro cerrado y la prueba de integración de §8 con dos sesiones de `ingest` en un proceso van en un PR 2d, antes del PR 3, porque el oro cotiza a la hora del 2c y las tres usan los servicios locales con las dos sesiones a la vez; el 2c midió la forma de `MarketIsClosed` con `OTC_HSI` y `OTC_N225`, cerrados: `msg_type` `ticks` y la hora de apertura en UTC en el mensaje. En `production`, cada `--symbol` tiene que tener su secuencia. Con un solo `--symbol`, una sesión que falla termina el proceso, como antes, y Render lo reinicia: no hay otra que deba seguir. Con varios, vuelve a empezar dentro del proceso, de 5 s a 5 minutos, salvo con una salida 2, como un símbolo que la petición `ticks` no admite, que volver a empezar no cambia: esa captura termina con su alerta y las demás siguen. El conector sigue en `deriv-options-ws-1.1.0`: no cambian las peticiones, los límites ni el transporte (§2).)
3. El oro en producción: el disco de 5 GB y `--symbol frxXAUUSD` en `render-datos.yaml`, con su prueba, y los pasos del runbook. Va fuera de la rotación de la credencial dueña, como el PR 5, que también cambia `render-datos.yaml`: la rotación no empieza con un PR abierto que lo cambie, y entre sus pasos 1 y 3 no se fusiona ni se sincroniza ninguno (runbook de ingesta, «Rotar credenciales»).
4. Los contratos de §4, las reglas y la política de segmentos de los lotes, con sus vectores y los esquemas de `trading_times`, `contracts_for` y `proposal` de la release fijada de Deriv. No cambia producción.
5. El paso de los lotes en `buoh-operaciones`, con el rol `buoh_lotes` y el token `lotes`, la publicación de sus datasets, y la Auditoría, la sección Datos y los contratos de la API que los agrupan por secuencia (§5).
6. La descarga de la historia, con la comprobación de un día ya capturado.
7. Los umbrales del oro, con al menos 7 días de su captura, su perfil de publicación y la publicación de sus logs desde el segmento 0 (§2). No espera a los PR 4 a 6.
8. La evidencia: lo capturado, lo descargado, la memoria, el espacio y el costo medidos. Con ella, F2.5b está hecho.

## Consecuencias

- El motor de investigación tiene desde el principio un año de datos de ocho mercados y lo que cuesta cada contrato desde que se empieza a guardar. Para el tiempo anterior, el backtest declara el costo medido al empezar, con su sensibilidad (`F2-MARKET-001`).
- La captura en vivo de R_100 no cambia de nombres, de bloqueo ni de perfil.
- `buoh-operaciones` hace más trabajo en cada ejecución; su plazo de 5 minutos se mide en el PR 5 y el PR 6.
- El oro puede necesitar su propio servidor si la memoria no alcanza (§1).
- La revisión del espacio de R2 con el propietario llega en semanas (§6).

## Alternativas descartadas

| Alternativa | Por qué no |
|---|---|
| Los dos símbolos en un mismo log | Un log tiene un perfil y unos umbrales (ADR-0020 §4), y R_100 ya tiene el de publicación mientras el oro necesita el de medición. Además la salud, la vigilancia de huecos y la recuperación suponen un símbolo. |
| Una fuente nueva para los lotes | Sería el mismo canal con otras peticiones, que ADR-0012 §1 trata como otro conector. Como fuente aparte, ADR-0007 §1 la trataría como otro instrumento, y la huella de un tick, que incluye la fuente, no coincidiría con la de la captura. |
| Todos los lotes en una sola secuencia | Un dataset es un rango contiguo de segmentos (ADR-0020 §7), y cotizaciones, velas, horarios e historia mezclados no se podrían publicar por separado. |
| Un worker propio para el oro desde el principio | Cuesta unos 7 USD al mes que quizá no hacen falta: se elige solo si la memoria lo pide (§1). |
| Pedir horarios y cotizaciones dentro de la captura en vivo | Cambia el conector y el perfil de R_100, y obliga a un corte y a otro perfil de publicación. |
| Cotizar cada 5 o 15 minutos | Suma escrituras y lecturas de R2 y tráfico de salida; cada 30 minutos da una muestra suficiente para empezar, y el perfil se puede cambiar. |
| Solo velas armadas por buoh, sin historia | El motor esperaría meses para tener un año de datos. |
| Un proveedor de datos de pago | Sus precios no son los de Deriv, donde se opera, y suma un costo y unos términos nuevos. |
| El oro por MetaTrader 5 | Necesita la terminal encendida todo el día; queda para la Fase 1B, como decidió el propietario. |

## Condiciones de revisión

- La memoria de `ingest` con dos sesiones pasa de 256 MiB (§1).
- R2 pasa de 8 GB, o la base de 3 GB (§6).
- Deriv responde al oro cerrado de otra forma que `MarketIsClosed`, limita las peticiones de los lotes, cambia la historia que da o deja de dar cotizaciones sin cuenta.
- Los ticks del oro dejan de llegar a un ritmo regular, lo que cambia cómo se miden sus umbrales.
- El costo medido pasa del presupuesto aprobado.
- El propietario suma o quita un mercado.

## Referencias verificadas

- [Deriv: `ticks_history`](https://developers.deriv.com/llms/ticks-history.md), [`trading_times`](https://developers.deriv.com/llms/trading-times.md), [`proposal`](https://developers.deriv.com/llms/proposal.md) y [`contracts_for`](https://developers.deriv.com/llms/contracts-for.md), consultadas el 2026-11-16.
- Medición del 2026-11-16 (§«Medición»), con scripts fuera del repositorio que no guardaron precios.
