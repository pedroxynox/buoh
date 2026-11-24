# ADR-0022: Modelo de estrategia (F2.6)

- **Estado:** Aceptada; complementada por [ADR-0024](0024-semantica-del-backtest.md) (el orden de los ticks de la historia y de los retenidos y las velas incompletas en §2 y §7, los plazos de una posición, la latencia y las velas de Deriv en §5, el instante de una entrada, el vencimiento de la señal y la señal pendiente en §6, el perfil equivalente, los tramos sin datos de los lotes y el resultado estimado en §7, y el próximo plazo, la ventana y los supuestos de ejecución en §8, que implementa su PR 3), por [ADR-0025](0025-protocolo-estadistico.md) (la pausa por deriva, que vuelve solo a mano, en §7 y §10, y la revisión técnica de una candidata del motor en §10) y por [ADR-0026](0026-motor-de-senales-shadow.md) (el instante en `shadow` en §2, la caída tras una reanudación a mano en §5, la causa de la salud, la reapertura y quién registra cada detención en §7, la falta del motor, la pausa del propietario, el incidente de integridad y los supuestos de `shadow` en §8, y las detenciones del motor en §10)
- **Fecha:** 2026-11-16
- **Ámbito:** Fase 2, incremento F2.6 (`F2-STRATEGY-001`, `F2-AUDIT-001` en lo de las estrategias y `F2-GOV-001` para `packages/strategy-sdk`, del [plan de Fase 2](../../plan/fase-2-laboratorio-y-bot-shadow.md), §8, punto 5). Fija también lo que toman de ella F2.6b (la gramática que recorre el motor de investigación y su paridad), F2.7 (el evaluador y la posición hipotética), F2.8 (el ciclo de vida y la puerta a `shadow`) y F2.9 y F2.10 (la política de datos y lo que el motor `shadow` recibe del evaluador).
- **Decisores:** Propietario de buoh (los tipos de contrato, la caída máxima, que la duración la decida cada estrategia y la reanudación sola tras datos degradados, decididos el 2026-11-16; plan §12), a propuesta de la dirección técnica (lo demás, también que el propietario autorice cada estrategia que pasa al bot, que aprobó al fusionar el plan).
- **Complementa:** [ADR-0002](0002-senales-y-ejecucion-controlada.md), con el modelo de la posición hipotética, que nunca es una orden; [ADR-0003](0003-lenguajes-y-limites.md), con las reglas de cálculo que comparten TypeScript y Python (§8 y §11); y [ADR-0021](0021-mercados-reales-y-fuentes-de-investigacion.md), cuyas cotizaciones, horarios y velas usa (§2, §5 y §7).

## Resumen para el propietario

- **Qué decide.** Cómo se escribe una estrategia dentro de buoh: el formato que el motor de investigación usa para proponer millones de ellas, y que el bot entiende igual.
- **Cómo es una estrategia.** Una ficha de reglas, no un programa: «si se cumplen estas condiciones con estos indicadores, abre un multiplicador o un sube/baja». Hay 13 indicadores fijos, como medias, RSI o volatilidad, y como mucho 6 condiciones para entrar. Así se puede leer y explicar.
- **Ganancias y pérdidas.** Se calculan como Deriv: el multiplicador, con su comisión, su stop loss, su take profit y su cierre al perder lo apostado; el sube/baja, con el pago que Deriv ofrecía en ese momento. Cada estrategia apuesta 10 USD de un capital imaginario de 1000 USD, para que todas se comparen igual, y se para si cae un 50 %.
- **Una sola calculadora.** El backtest y el bot usan exactamente la misma, así que una estrategia hace lo mismo con el pasado que en vivo. Python, el del motor, la copia, y unas pruebas compartidas comprueban que coinciden.
- **Versiones.** Cada estrategia tiene una huella de su contenido: cambiar cualquier cosa crea otra versión, y ninguna se edita. Tú autorizas en la web cada una que pasa al bot.
- **Costo y riesgo.** No cuesta nada. No hay órdenes ni dinero: todo es hipotético, en modo `shadow`.
- **Qué apruebas al fusionarla.** Todas las propuestas de la dirección técnica de esta ADR, entre ellas el formato, la apuesta fija del 1 % y el orden de cinco PR de §13.

## Contexto

El 2026-11-16 el propietario decidió que las estrategias las busque un motor de investigación, en Python, que pruebe millones de ellas; que buoh opere primero en Deriv con multiplicadores y sube/baja, sin dígitos; que la duración de cada operación la decida la estrategia, de segundos a horas; una caída máxima del 50 % del capital de cada estrategia; y que una estrategia detenida por datos degradados vuelva a arrancar sola ([decisiones vigentes](../../gobierno/decisiones-vigentes.md), «Motor de investigación» y «Disco, VPS y reanudación»). Que él autorice cada estrategia que pasa al bot lo propuso la dirección técnica, y lo aprobó al fusionar el plan (plan §1 y §12).

El plan de Fase 2 pide (§4) un solo evaluador puro para el backtest y el motor `shadow`, cada decisión en su instante, datos fijados y TypeScript para la evidencia; y `F2-STRATEGY-001`, una estrategia declarativa con su gramática, su biblioteca de indicadores, su modelo de posición, sus costos, el vencimiento de sus señales, sus límites de frecuencia y su política de datos. Las cinco ADR del laboratorio comparten el evaluador, el instante de decisión y lo que guarda cada decisión (plan §8): esta fija el evaluador y lo que entra y sale de él; la semántica del backtest (punto 6), cómo se reconstruyen desde los datasets sus entradas, en su orden; el protocolo estadístico (punto 7), cómo se juzga; el motor `shadow` (punto 8), cómo corre en vivo; y el motor de investigación (punto 10), cómo se busca.

Hoy `StrategyDefinition` solo está nombrada ([contratos de dominio](../contratos-de-dominio.md), «Contratos futuros»), y `packages/strategy-sdk` no existe.

## Decisión

### 1. Qué es una estrategia

Una estrategia es un `StrategyDefinition` 1.0.0: un documento JSON, sin código, validado en tiempo de ejecución. Tiene:

- **Identidad:** `strategy_id` (el nombre de la familia, estable entre versiones), `semantic_version`, `responsible` (la cuenta de buoh del propietario), `origin` (el motor de investigación, con el identificador de su búsqueda) y una descripción en texto.
- **Mercado:** la fuente, el símbolo, los datos (`ticks` o `deriv_candles`; §2), el perfil de calidad de esos datos con su hash (con `ticks`, el de la secuencia en vivo del símbolo; con `deriv_candles`, el de la secuencia de velas de los lotes, ADR-0021 §3) y la temporalidad.
- **Indicadores:** como mucho 6 instancias de la biblioteca 1.0.0 (§3), cada una con sus parámetros.
- **Reglas:** la dirección (subida o bajada), las condiciones de entrada y, en los multiplicadores, las de salida (§4).
- **Contrato y posición:** el tipo, la apuesta, el multiplicador o la duración, y los límites de la posición (§5).
- **Señales:** el vencimiento y los límites de frecuencia (§6).
- **Datos:** la antigüedad máxima de los datos (§7).
- **Modo:** `execution_mode`, `disabled` hasta que se promueve a `shadow` (§10), y la versión de la que viene.
- **Versiones:** `strategy_schema_version` y `indicator_library_version`.

Una estrategia opera un solo símbolo, en una sola dirección, con un solo tipo de contrato y como mucho una posición abierta. Una idea que opera en las dos direcciones son dos estrategias.

### 2. Datos y reloj

- **Datos.** Solo una estrategia sobre `ticks` de R_100 o del oro puede ir a `shadow`, porque el backtest y el motor `shadow` tienen que ver los mismos datos (plan §4.1): sus backtests usan los ticks de la captura y de la historia del mismo símbolo (ADR-0021 §4). Una estrategia sobre `deriv_candles`, las velas de Deriv de los lotes, sirve para investigar, y el motor de investigación no la propone para `shadow` (`F2-RESEARCH-001`).
- **Temporalidad.** Con `ticks`: `tick`, o velas de 5 y 15 segundos y de 1, 5, 15 y 60 minutos que arma buoh con la regla del [concepto de interfaz](../../diseno/concepto-de-interfaz.md) §9: alineadas en UTC a su múltiplo, por la hora de la fuente de cada tick, con apertura, máximo, mínimo, cierre y número de ticks, y sin vela en un intervalo sin ticks. Con `deriv_candles`: las de 1 minuto de Deriv y sus agregados de 5, 15 y 60 minutos, con la misma regla.
- **El instante de cada evento.** Cada evento que recibe el evaluador (§8) lleva su instante, que es su «ahora». La ADR de la semántica del backtest y la del motor `shadow` fijan qué instante lleva cada evento y en qué orden llegan, y las dos tienen que dar la misma secuencia para los mismos datos (plan §4.2). Esta ADR fija lo que el evaluador hace con ellas:
  - con `tick`, decide con cada tick durable;
  - con las velas de buoh, decide al cerrar cada vela, cuando llega el primer tick de un intervalo posterior, así que una vela nunca se evalúa antes de estar completa;
  - con `deriv_candles`, decide al cerrar cada vela, con el instante de su fin;
  - un tick que trae la historia de un hueco entra en los indicadores cuando llega, en ese orden, y nunca dispara una decisión con un instante anterior;
  - entre dos datos, el anfitrión le pasa el paso del tiempo (§8), para que la estrategia note datos viejos, el vencimiento de una señal o un cambio de día aunque no llegue nada.
- (Precisión de [ADR-0024](0024-semantica-del-backtest.md) §2 y §3, que cambia el punto del tick que trae la historia, el del paso del tiempo en lo del vencimiento de una señal, que se cumple por la hora de la fuente, y, en §7, que los indicadores sigan «con los datos que llegan».) Mientras la continuidad está pendiente, la vista de cada instante retiene los ticks del flujo, y con el resultado de la historia da juntos los que trae y los retenidos, en el orden de su hora de la fuente y con el instante del resultado. Así los indicadores, las velas y las posiciones reciben los precios en el orden en que ocurrieron, y ningún tick dispara una decisión con un instante anterior. Si lo retenido llega a 16 000 ticks, la vista lo da en ese instante y no usa la historia de ese hueco, que para las posiciones cuenta como no recuperado (§7). Una vela que se solapa con un intervalo sin datos registrados dentro del horario entra en los indicadores, pero su cierre no decide.
- (Precisión de [ADR-0026](0026-motor-de-senales-shadow.md) §3.) En `shadow`, el instante y el orden son los de la vista y el anfitrión de ADR-0024. Lo que el motor le pasa aparte de la vista, como el paso del tiempo de su reloj o un registro de los lotes, es una entrada que guarda en su registro con su posición en el log, y la réplica la repite.

### 3. Biblioteca de indicadores 1.0.0

Cada indicador se calcula sobre la serie de cierres `x` (el precio del tick o el cierre de la vela), y los que lo dicen, sobre el máximo `h` y el mínimo `l` de cada vela; con `tick`, `h = l = x`. `n` es un entero.

| Indicador | Definición | Unidad | Parámetros |
|---|---|---|---|
| `price` | `x_t` | precio | — |
| `return(n)` | `x_t / x_{t−n} − 1` | fracción | n de 1 a 500 |
| `sma(n)` | `(x_{t−n+1} + … + x_t) / n`, sumado del más antiguo al más reciente | precio | n de 2 a 500 |
| `ema(n)` | `α = 2/(n+1)`; empieza con `sma(n)` en el valor `n`; `e_t = e_{t−1} + α·(x_t − e_{t−1})` | precio | n de 2 a 500 |
| `rsi(n)` | de Wilder: subidas `g_t = max(x_t − x_{t−1}, 0)` y bajadas `d_t = max(x_{t−1} − x_t, 0)`; empiezan con su media simple de `n` valores; `G_t = (G_{t−1}·(n−1) + g_t)/n`, y lo mismo `D_t`; `50` si `G_t = D_t = 0`, `100` si solo `D_t = 0`, y si no `100 − 100/(1 + G_t/D_t)` | de 0 a 100 | n de 2 a 100 |
| `atr(n)` | de Wilder: `TR_t = max(h_t − l_t, |h_t − x_{t−1}|, |l_t − x_{t−1}|)`; empieza con la media simple de `n` valores; `A_t = (A_{t−1}·(n−1) + TR_t)/n` | tamaño de movimiento, en precio | n de 2 a 100 |
| `volatility(n)` | desviación típica poblacional de `return(1)` en los `n` últimos, en dos pasadas: la media `m` y `√(Σ(r − m)²/n)` | fracción | n de 2 a 500 |
| `highest(n)` | máximo de `h` en los `n` anteriores, sin el actual | precio | n de 2 a 500 |
| `lowest(n)` | mínimo de `l` en los `n` anteriores, sin el actual | precio | n de 2 a 500 |
| `zscore(n)` | `(x_t − sma(n))/s`, con `s` la desviación típica poblacional de `x` en los `n` últimos, en dos pasadas; indefinido si esos `n` valores son todos iguales | sin unidad | n de 2 a 500 |
| `bollinger_pct(n, k)` | `(x_t − (sma(n) − k·s))/(2·k·s)`, con el mismo `s` y la misma regla de indefinido | sin unidad | n de 2 a 500; k de 1, 1,5, 2, 2,5 o 3 |
| `hour_utc` | hora UTC del instante del evento | de 0 a 23 | — |
| `weekday_utc` | día UTC del instante del evento, de 0 (lunes) a 6 (domingo) | de 0 a 6 | — |

Un indicador está indefinido hasta que tiene los valores que necesita. Que `zscore` y `bollinger_pct` comprueben la igualdad de los valores, y no que `s` sea 0, evita que el redondeo dé un valor sin sentido con el precio quieto. Cambiar una definición, un rango o la lista crea otra versión de la biblioteca.

### 4. Reglas

- **Condición:** `{izquierda, operador, derecha}`. A la izquierda va un indicador; a la derecha, otro indicador de la misma unidad o una constante decimal. Un nivel de precio (`price`, `sma`, `ema`, `highest` y `lowest`) no se compara con una constante, porque un precio fijo es un nivel del pasado; `atr`, que mide un tamaño de movimiento y no un nivel, sí, y solo con una constante o con otro `atr`. Los operadores son `gt`, `gte`, `lt`, `lte`, `crosses_above` (antes `izquierda ≤ derecha` y ahora `izquierda > derecha`) y `crosses_below`. Una condición con un valor indefinido, también el anterior de un cruce, es falsa.
- **Entrada:** como mucho 2 grupos alternativos, cada uno de como mucho 3 condiciones que se cumplen a la vez, y, si se quiere, una ventana de horas UTC y unos días de la semana.
- **Salida de un multiplicador:** como mucho un grupo de 3 condiciones, además de los límites de §5. Un sube/baja no tiene salida: termina a su vencimiento.
- No hay más: ni expresiones aritméticas, ni código, ni datos externos. Los límites acotan lo que recorre el motor de investigación y lo que hay que explicar de cada estrategia; una gramática más rica es otra versión, con su ADR.

### 5. Contratos y posición hipotética

Los tipos son los que decidió el propietario: `MULTUP` y `MULTDOWN` (multiplicadores) y `CALL` y `PUT` (sube/baja). Una posición nunca es una orden (ADR-0002).

- **Capital y apuesta.** Cada estrategia tiene un capital inicial hipotético de 1000 USD y apuesta en cada posición una cantidad fija, el 1 % del capital inicial: 10 USD, la misma apuesta con la que buoh cotiza los contratos (ADR-0021 §3), así que el costo cotizado se aplica tal cual. La apuesta no es un parámetro que busque el motor: optimizarla daría ventaja a la estrategia más arriesgada, no a la mejor. Otro tamaño es otra versión de la gramática; en demo y con dinero real lo fija la política de riesgo.
- **Entrada.** Con ticks, la posición empieza en el primer tick posterior a la decisión, que es como empieza un contrato de Deriv; el PR 3 lo comprueba con la documentación de Deriv para cada tipo. La ADR de la semántica del backtest puede sumar una latencia declarada.
- **Multiplicador.** El multiplicador es uno de los que acepta el mercado (`contracts_for`, ADR-0021 §3). La comisión sale de la cotización guardada más cercana anterior a la entrada con ese multiplicador, como fracción de la exposición. El resultado en cada tick es `apuesta × multiplicador × (x_t / x_entrada − 1)` en `MULTUP` (con el signo contrario en `MULTDOWN`) menos la comisión. Se cierra en el primer tick en que se cumple una de estas causas, en este orden de precedencia: pierde la apuesta entera, con resultado `−apuesta`, que es el cierre de Deriv aunque el tick diga más; llega al stop loss o al take profit que declare la estrategia, con el resultado de ese tick, como en Deriv; pasa su tiempo máximo, de 1 segundo a 24 horas, desde la entrada; o, en una decisión, se cumple su salida.
- **Sube/baja.** La duración es una de las que cotiza buoh y ofrece el mercado: 5 ticks, 15 segundos o 1, 5, 15, 60 o 240 minutos (ADR-0021 §3). El contrato vence a la duración desde el instante de la decisión, como en Deriv, donde cuenta desde la compra. El pago sale de la cotización guardada más cercana anterior a la entrada, del mismo tipo y duración. Al vencer, gana si el precio de salida es mayor que el de entrada (`CALL`) o menor (`PUT`), y un empate pierde. El precio de salida es el del quinto tick después del de entrada en una duración de ticks, y el del último tick a la hora del vencimiento o antes en las demás. Gana `pago − apuesta`, o pierde la apuesta. Una señal cuyo contrato vencería con el mercado cerrado se omite (§6). El PR 3 comprueba estas reglas con la documentación de Deriv.
- **Con velas de Deriv** (solo para investigar). La posición empieza con la apertura de la vela siguiente. Un multiplicador se mira con el máximo y el mínimo de cada vela: si una vela toca a la vez el stop loss y el take profit, cuenta el stop loss, y si toca la pérdida de la apuesta, esa. Un sube/baja solo puede durar 1 minuto o más, y sale con el cierre de la última vela de 1 minuto de Deriv que termina en su vencimiento o antes. Son aproximaciones prudentes, con sus vectores, y el informe lo dice.
- **Sin cotización.** Para el tiempo anterior a la primera cotización guardada, la posición usa el costo medido al empezar, declarado como supuesto, y el informe da su sensibilidad (`F2-MARKET-001`).
- **Importes.** En decimal canónico, con aritmética de punto fijo entera: los cocientes con 18 decimales y el resultado de cada posición redondeado al centavo al liquidarla, con redondeo al par.
- **Caída máxima.** La curva de resultados mide el resultado acumulado en % del capital inicial, y su peor caída, la mayor bajada desde un máximo anterior (concepto de interfaz §9), con las posiciones cerradas y el resultado del tick de un multiplicador abierto. Si la caída llega al 50 %, o al tope menor que declare la estrategia, la estrategia se detiene, y esa detención solo se levanta a mano (`F2-STOP-001`). (Precisión de [ADR-0026](0026-motor-de-senales-shadow.md) §4.) Al reanudarla a mano tras la caída máxima, la caída se vuelve a contar desde el resultado de ese instante, y el informe muestra las dos.
- (Precisión de [ADR-0024](0024-semantica-del-backtest.md) §3 y §6.) Con la latencia declarada, la compra es la hora de la fuente del tick que decidió más la latencia: la posición empieza en el primer tick usado posterior al que decidió con una hora de la fuente igual o posterior a la compra, y un sube/baja vence a su duración desde la compra. Una salida por reglas y el tiempo máximo, que son ventas de buoh, pagan la misma latencia; el stop loss, el take profit y la pérdida de la apuesta, que aplica Deriv, no. Los plazos de una posición se cumplen por la hora de la fuente y se deciden al llegar el primer tick con una hora posterior: un sube/baja sale con el último tick con una hora igual o anterior a su vencimiento, y un multiplicador cierra en el primer tick con una hora igual o posterior a su tiempo máximo más la latencia, con la precedencia de este punto, también con el mercado cerrado, con el tick de la reapertura. Con velas de Deriv, una salida por reglas o al cerrar la ventana sale con el cierre de la vela en que se decide; un stop loss o un take profit tocado dentro de una vela da el resultado del umbral exacto, o el de la apertura si la vela ya abre más allá de él; y entrar y salir al precio del instante de la decisión es una aproximación optimista, no prudente, como decía este punto.

### 6. Señales

- **Vencimiento.** Una decisión de entrar es una señal. Vence si en `signal_expiry_ms` (de 1000 a 60 000 ms; 5000 por defecto) desde su instante no llega el tick que abre la posición, y entonces queda como omitida, con su motivo. En un sube/baja, `signal_expiry_ms` tiene que ser menor que la duración del contrato (con 5 ticks, como mucho 5000 ms), para que nunca abra un contrato ya vencido; si no, la definición se rechaza con `signal_expiry_too_long`.
- **Frecuencia.** Un mínimo de segundos entre dos entradas (de 0 a 86 400) y un máximo de entradas por día UTC (de 1 a 500), contados con el instante de cada evento. Una señal que los pasaría queda omitida, con su motivo. (Precisión de [ADR-0024](0024-semantica-del-backtest.md) §6.) Una entrada cuenta con el instante de la decisión que abrió su posición, y su día UTC es el de ese instante; una señal que venció o quedó omitida no cuenta. Con la latencia declarada, la señal vence por la hora de la fuente: si su tick de entrada tendría una hora posterior a la compra más `signal_expiry_ms`, siendo la compra la hora de la fuente del tick que decidió más la latencia. Con una señal pendiente la estrategia no da otra: la que habría dado queda omitida, con la causa `signal_pending`.
- El motor `shadow` convierte cada señal en un `SignalEvent` (`F2-SIGNAL-001`), con lo que fija su ADR.

### 7. Política de datos

Una estrategia solo decide si se cumple todo esto; si no, se detiene, con la causa:

- la salud de su secuencia es `healthy`, sin `connection_lost` ni `event_gap_unresolved` abiertas y sin continuidad pendiente; con `deriv_candles`, que solo se usan en backtests, cuentan en su lugar las marcas de calidad de sus datasets, como fije la ADR de la semántica del backtest;
- el último dato no tiene más de `max_data_age_ms` (de 1000 a 60 000 ms; 5000 por defecto, más el intervalo de la vela si usa velas), contado con el instante del evento;
- el perfil de calidad y el esquema de la fuente son los que declara, o uno que la ADR de la semántica del backtest declare equivalente para los mismos datos, como el de la historia del mismo símbolo. Cada decisión guarda el perfil con el que se tomó.

El anfitrión le pasa la salud junto con lo que la impone: las condiciones abiertas, la continuidad y, si es `failed`, su motivo. La ADR del motor `shadow` fija de dónde lo toma, porque el `HealthReport` no nombra su causa ([contratos de dominio](../contratos-de-dominio.md), «Cómo se lee la causa»). (Precisión de [ADR-0026](0026-motor-de-senales-shadow.md) §2.) La toma de la vista de cada instante, en el mismo evento: de los hechos del pliegue, con las condiciones abiertas, la continuidad pendiente, si el log sigue conectado y, si no se deriva, su código.

- **Fuera del horario** de su mercado (ADR-0021 §3), no decide ni se detiene. (Precisión de [ADR-0026](0026-motor-de-senales-shadow.md) §4.) Al abrir el horario, la antigüedad de los datos se cuenta desde la apertura, y una salud distinta de `healthy` que empezó con el mercado cerrado no la detiene durante `max_data_age_ms`: en ese plazo no decide, con la causa `market_closed`, y si al pasarlo no hay salud `healthy` y un dato fresco, se detiene.
- **Cómo vuelve.** Una detención por datos degradados, que es cualquier salud distinta de `healthy` (también `starting` en un corte semanal y `paused` en un despliegue), una condición abierta, la continuidad pendiente o datos viejos, se levanta sola cuando los datos vuelven a cumplir esta política, como decidió el propietario y pide `F2-STOP-001`. Solo vuelven a mano una salud `failed` por un esquema incompatible o un log que no se deriva, un perfil o un esquema distintos de los declarados y la caída máxima: con el evento de reanudación del propietario (§8). Mientras quede abierta una causa que vuelve a mano, la estrategia no vuelve sola.
- **Mientras está detenida:**
  - los indicadores siguen con los datos que llegan;
  - una señal que habría dado queda omitida, con la causa de la detención, como pide `F2-SIGNAL-001`, y una salida por reglas que se habría cumplido también queda omitida, con su causa;
  - una posición abierta sigue abierta, porque en Deriv el contrato sigue: su take profit, su stop loss, su cierre al perder la apuesta, su tiempo máximo y su vencimiento se aplican con los ticks en el orden de su hora de la fuente. Tras un cierre no pedido, la posición espera al resultado de la recuperación de ese hueco y aplica primero los ticks que trae la historia; tras un cierre pedido, como un despliegue o un corte semanal, no hay historia (ADR-0018 §5), y sigue con los ticks que llegan;
  - si un hueco no se recupera, la posición se liquida con el primer tick posterior, o con el último anterior en un sube/baja que venció dentro del hueco, y su resultado queda marcado como estimado y se cuenta aparte en el informe.

La ADR del motor `shadow` lo implementa en vivo, y la de la semántica del backtest, sobre las marcas de calidad del dataset. Quién registra cada detención en la auditoría lo fija la ADR del motor `shadow`. (Precisión de [ADR-0026](0026-motor-de-senales-shadow.md) §4.) Las detenciones y las vueltas solas las registra el motor, en su registro; las pausas, las reanudaciones y las retiradas del propietario y la pausa por deriva, la API, en su registro y en su auditoría.

(Precisión de [ADR-0024](0024-semantica-del-backtest.md) §4 y §5.) El backtest no usa las marcas finales de los datasets, sino la vista de cada instante, con la salud que se deriva del log. El único perfil equivalente al declarado es el de la historia descargada del mismo símbolo, y solo antes de su primer tick en vivo. Con `deriv_candles` y en la historia descargada, un tramo sin datos dentro del horario detiene la estrategia por datos viejos, y vuelve sola con el primer dato después. El tiempo máximo de un multiplicador no lo aplica Deriv: es una venta de buoh, con su latencia, que también sigue mientras la estrategia está detenida. Hay un resultado estimado cuando un intervalo sin datos registrados se solapa con el horario de su mercado: tras un hueco sin recuperar, tras un cierre pedido, como un despliegue, o en un tramo sin datos de la historia. Lo tienen un multiplicador o un sube/baja de ticks que cruzan ese intervalo, aunque salgan después, y un sube/baja de tiempo cuyo vencimiento cae dentro.

(Precisión de [ADR-0025](0025-protocolo-estadistico.md) §9.) Una pausa por una deriva material, con la causa `drift` (§10), también vuelve solo a mano, con el evento de reanudación del propietario (§8), como la caída máxima.

### 8. El evaluador

- **Interfaz.** Una función pura: `evaluar(definición, estado, evento) → (estado, decisiones)`. Cada evento lleva su instante (§2) y es uno de estos: un tick con sus marcas, el resultado de la recuperación de un hueco, el cierre de una vela, un cambio de la salud con lo que la impone, un cambio de horario, una cotización, el paso del tiempo o la reanudación a mano del propietario, auditada. Las decisiones son `entrar` (una señal, con su contrato), `salir` (con su causa), `liquidar` (con su resultado), `omitir` (con su causa), `detener` y `reanudar`. El estado se serializa en JSON canónico, para que el motor `shadow` lo guarde y la réplica lo compare.
- **Sin efectos.** No lee el reloj, la red, el azar ni ningún archivo: lo que necesita le llega en cada evento. El backtest y el motor `shadow` lo llaman igual, y una estrategia no puede saber si corre en vivo o en una réplica (plan §4.1).
- **Números.** Los precios y las constantes son decimales canónicos. Los indicadores se calculan en binario64 de IEEE 754, desde esos decimales, solo con suma, resta, multiplicación, división, raíz cuadrada, máximo, mínimo y valor absoluto, cada operación por separado, en el orden que da su definición, y las sumas de izquierda a derecha, del valor más antiguo al más reciente. Así dan el mismo resultado, bit a bit, en TypeScript y en Python. No valen funciones como la exponencial o el logaritmo, ni la potencia, ni la multiplicación y suma fusionadas, ni sumas que reordenan o compensan, como `sum()` de Python 3.12, `math.fsum` o las reducciones de NumPy; en Numba, sin `fastmath` ni reducciones en paralelo. Los importes van en punto fijo entero (§5).
- **Versión.** `strategy-evaluator-1.0.0`. Quien llama guarda esa versión con cada decisión y cada backtest; un cambio de lo que decide es otra versión. Cada versión del evaluador, de la gramática y de la biblioteca que use una estrategia registrada sigue disponible mientras exista una decisión o un backtest que la cite, para su réplica (`F2-REPLAY-001`).
- (Precisión de [ADR-0024](0024-semantica-del-backtest.md) §3 y §6, que implementan el PR 3 de §13 en TypeScript y el PR 2 de ADR-0023 en Python.) El evaluador suma una función pura, el próximo plazo de su estado (la antigüedad máxima de los datos, el siguiente día UTC y el siguiente cambio de horario; los plazos de una señal y de una posición se cumplen por la hora de la fuente, con los ticks), con la que el anfitrión le pasa el paso del tiempo en el instante exacto de cada plazo; cuatro eventos, la apertura y el cierre de la ventana, el cambio de los contratos que se ofrecen y el día con el horario desconocido; la marca de la vela incompleta; las causas de omisión `signal_pending`, `window_closing`, `market_closed`, `candle_incomplete`, `schedule_unknown` y `contract_not_offered`; y la marca de estimado y la de liquidada al cerrar la ventana en una posición. Antes de la apertura actualiza sus indicadores y su política de datos sin decidir, y al cierre liquida su multiplicador abierto. El estado inicial lleva los supuestos de ejecución, la latencia y los costos, y el motor `shadow` usa los de la réplica de su versión congelada, como fije su ADR.
- (Precisión de [ADR-0026](0026-motor-de-senales-shadow.md) §2 a §5, que implementan los mismos PR.) El evaluador suma tres eventos que el backtest no usa: la falta del motor `shadow`, con su intervalo, que no es una detención: en él la estrategia no decide, cada señal queda omitida con la causa `engine_unavailable` y una venta de buoh espera a la vuelta del motor y paga su latencia desde ella; y la pausa del propietario y un incidente de integridad o un log que no se deriva, que la detienen hasta una reanudación a mano, como la caída máxima. En `shadow`, el estado inicial lleva los supuestos de ejecución del `BacktestSpec` de la réplica de validación de su versión congelada, sin las variantes.

### 9. Identidad, versiones y errores

- **Identidad.** El identificador de una versión es el SHA-256 del JSON canónico (JCS) de la definición entera: cambiar cualquier cosa, también la descripción, crea otra versión. Ninguna versión se modifica en su lugar.
- **Versión semántica.** Sube la mayor al cambiar el mercado, los datos, la temporalidad, el tipo de contrato o una versión de la gramática o de la biblioteca; la menor, al cambiar indicadores, parámetros, reglas o límites; y la de parche, al cambiar solo la descripción. El registro rechaza una versión nueva que no sube respecto de la mayor versión semántica registrada de su `strategy_id`, salvo una promoción a `shadow` (§10), que conserva la versión semántica de la congelada: la distinguen su modo y su referencia, y así no choca con versiones posteriores de la familia.
- **Errores.** Una definición inválida se rechaza con una lista de errores estructurados: un código, la ruta del campo y un mensaje. Los códigos son cerrados, por ejemplo `unknown_indicator`, `parameter_out_of_range`, `too_many_conditions`, `unit_mismatch`, `contract_not_allowed`, `duration_not_quoted`, `multiplier_not_accepted`, `symbol_not_supported`, `version_unsupported`, `side_contract_mismatch` y `signal_expiry_too_long`. Una versión de la gramática o de la biblioteca que el código no conoce se rechaza, nunca se adivina.

### 10. Ciclo de vida, promoción y aprobación

Los estados son los de [seguridad y rigor](../../gobierno/seguridad-y-rigor-cuantitativo.md) y del [protocolo de validación](../../gobierno/protocolo-de-validacion-de-estrategias.md) §4: `draft`, `reviewed`, `active`, `paused` y `retired`. Un cambio de estado es un evento append-only del registro de la API, con su autor, su hora UTC, su motivo y los objetos afectados (`F2-AUDIT-001`); no cambia la versión.

- **`draft`.** El motor de investigación registra en la API la versión que congela (`F2-SEARCH-001`).
- **`draft` → `reviewed`.** Cuando se cumple la revisión técnica del protocolo §4. Esta ADR solo exige que la definición sea válida; lo demás para candidatas que genera una máquina, y si lo comprueba la API sola, lo fija la ADR del protocolo estadístico, que cambia el protocolo en su PR. (Precisión de [ADR-0025](0025-protocolo-estadistico.md) §6.) Para una candidata del motor, la API la pasa sola a `reviewed`, con el sistema como autor, si la definición es la congelada, su registro previo está completo, su réplica y la de sus variantes dan los mismos hashes lógicos que su repetición en el VPS, con la paridad en `match` en el entrenamiento y la validación (las variantes van con `not_compared`), y los filtros de ADR-0025 §4 que dependen de ella dan lo mismo con la réplica. Si no, la retira, con su causa.
- **`reviewed` → `active` en `shadow`.** Solo el propietario, desde la sección Laboratorio de la web, con su sesión, después de ver el informe de evidencia (F2.8), con una confirmación explícita. La promoción crea una versión nueva, igual a la congelada, también en su versión semántica, salvo `execution_mode: shadow` y la referencia a la congelada y a su evaluación. La API comprueba esa igualdad: el evaluador no lee el modo, así que la nueva versión toma las mismas decisiones, y la evidencia de la congelada vale para ella.
- **`active` → `paused`.** Por una detención (§7), por la caída máxima (§5) o por el propietario. Vuelve a `active` sola o a mano, como fija §7. (Precisión de [ADR-0025](0025-protocolo-estadistico.md) §9.) También por una deriva material, con la causa `drift`, que vuelve solo a mano, como la caída máxima: es una de las causas del protocolo §5 que nunca se levantan solas (`F2-STOP-001`). (Precisión de [ADR-0026](0026-motor-de-senales-shadow.md) §4.) Las detenciones del motor, por cualquier causa, y sus vueltas solas quedan en el registro del motor, no en el de la API, que registra las pausas, las reanudaciones y las retiradas del propietario y la pausa por deriva, y la sección Laboratorio muestra la versión en `paused`, con su causa, mientras el motor la tiene detenida.
- **`retired`.** El propietario retira una versión, o la rechaza en `reviewed`, con un motivo. Es el último estado.

La sección Laboratorio muestra cada versión con sus reglas en palabras, su ciclo de vida y, desde F2.7 y F2.8, su informe. Nunca edita una versión.

### 11. Paridad con Python

El motor de investigación genera definiciones con esta gramática, y el JSON Schema generado desde Zod, en `packages/contracts`, es su contrato (ADR-0003). Python implementa la biblioteca 1.0.0 con las reglas de números de §8, y unos vectores compartidos en `test-vectors/` fijan:

- las series de cada indicador, con cada valor binario64 escrito exacto, también los indefinidos, con series elegidas para que un atajo de suma cambie los bits;
- las decisiones y los resultados de estrategias sintéticas, con multiplicadores y sube/baja, sus cierres y sus vencimientos;
- definiciones inválidas, con sus errores esperados.

Los dos lados los pasan en CI. Solo cuenta como evidencia el evaluador de TypeScript (plan §4.7).

### 12. Pruebas

- La validación, con los vectores de definiciones inválidas y una prueba de que una versión desconocida se rechaza.
- Cada indicador, con su vector y sus casos límite: los valores indefinidos, el precio quieto en `zscore`, `bollinger_pct` y `rsi`, y una ruptura de `highest` y `lowest`.
- El evaluador, con vectores de decisiones: los cruces, la ventana de horas, los límites de frecuencia, el vencimiento de una señal con el paso del tiempo, el stop out, el take profit, el stop loss y la precedencia entre ellos, el empate de un sube/baja, la caída máxima, cada causa de la política de datos, la reanudación sola tras datos degradados, la que no vuelve sola con una causa a mano abierta, la estrategia detenida con una posición abierta y la espera a la historia, el mercado cerrado, y las reglas con velas de Deriv.
- Las pruebas prohíben red, reloj real y azar, como `F1-VECTOR-001`, y comprueban que la identidad de una versión es el hash de su JSON canónico.
- (Precisión de [ADR-0024](0024-semantica-del-backtest.md) §3 y §11.) El vencimiento de una señal se prueba por la hora de la fuente de su tick de entrada, no con el paso del tiempo, y el evaluador suma los vectores de lo que le añade la precisión de §8.

### 13. Secuencia de entrega

El código de F2.6 empieza cuando las cinco ADR del laboratorio están fusionadas (plan §8). Cinco PR:

1. Esta ADR, con sus precisiones al plan de Fase 2 y a `PROJECT_STATUS.md`.
2. `StrategyDefinition` 1.0.0 en `packages/contracts`, con su JSON Schema, la validación con sus errores, los vectores de definiciones inválidas y su semántica en los contratos de dominio.
3. `packages/strategy-sdk`: la biblioteca 1.0.0, los importes de punto fijo, la posición y el evaluador, con sus vectores, y su regla en el mapa de impacto (`F2-GOV-001`). Comprueba con la documentación de Deriv el inicio y el cierre de cada tipo de contrato.
4. El registro de estrategias en la API: sus tablas append-only, sus eventos de ciclo de vida y sus entradas de auditoría, las rutas de lectura y su OpenAPI (`F2-AUDIT-001`).
5. La sección Laboratorio en la web, con las versiones, sus reglas en palabras y su ciclo de vida, sin datos ficticios. La aprobación llega con F2.8, cuando existe el informe que la justifica.

## Consecuencias

- El motor de investigación sabe exactamente qué puede probar, y cada candidata es una definición que el bot entiende igual.
- Las estrategias se comparan con la misma apuesta, y un resultado no depende de cuánto arriesga cada una.
- Sin exponencial ni logaritmo, los rendimientos son simples y no logarítmicos; es el precio de la paridad bit a bit entre TypeScript y Python.
- Una posición a la vez y una dirección por estrategia simplifican el riesgo y la explicación, y dejan fuera estrategias que piramidan.
- El costo del pasado, antes de las cotizaciones guardadas, es un supuesto declarado, y los resultados con velas de Deriv son aproximaciones prudentes.

## Alternativas descartadas

| Alternativa | Por qué no |
|---|---|
| Estrategias como código | El roadmap pide reglas declarativas limitadas, y código ajeno en el bot es un riesgo de seguridad y de reproducción. |
| Un lenguaje de expresiones | Multiplica lo que recorre el motor y lo que hay que explicar; puede llegar con otra versión de la gramática. |
| Indicadores en decimal | Más lento para millones de pruebas, y la raíz cuadrada no da decimales finitos: hace falta una regla de redondeo igual de arbitraria. |
| Optimizar la apuesta | Premia arriesgar más, no decidir mejor. |
| Varias posiciones a la vez | Más riesgo y más estados que explicar, sin que el plan lo pida. |
| Las velas de Deriv en `shadow` | Son datos distintos de los ticks que ve el bot en vivo (plan §4.1). |
| Promover subiendo la versión de parche, o con `+shadow` | La primera chocaría con una versión posterior de la misma familia; la segunda no la acepta el esquema de versiones del repositorio, y las bibliotecas de semver la quitan. |

## Condiciones de revisión

- El motor de investigación necesita indicadores o reglas que la gramática no tiene.
- Python y TypeScript dejan de coincidir en un vector.
- Deriv cambia cómo empieza o cierra un multiplicador, cómo paga un sube/baja o qué duraciones ofrece.
- El propietario cambia la caída máxima, la apuesta o los tipos de contrato.

## Referencias verificadas

- [Plan de Fase 2](../../plan/fase-2-laboratorio-y-bot-shadow.md), §4, §8 y `F2-STRATEGY-001`; [protocolo de validación](../../gobierno/protocolo-de-validacion-de-estrategias.md); [concepto de interfaz](../../diseno/concepto-de-interfaz.md) §9.
- [Deriv: tipos de contrato](https://developers.deriv.com/llms/contract-types.md), consultada el 2026-11-16.
