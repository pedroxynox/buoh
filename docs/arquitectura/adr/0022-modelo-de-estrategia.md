# ADR-0022: Modelo de estrategia (F2.6)

- **Estado:** Aceptada
- **Fecha:** 2026-11-16
- **Ámbito:** Fase 2, incremento F2.6 (`F2-STRATEGY-001`, `F2-AUDIT-001` en lo de las estrategias y `F2-GOV-001` para `packages/strategy-sdk`, del [plan de Fase 2](../../plan/fase-2-laboratorio-y-bot-shadow.md), §8, punto 5). Fija también lo que toman de ella F2.6b (la gramática que recorre el motor de investigación y su paridad), F2.7 (el evaluador y la posición hipotética), F2.8 (el ciclo de vida y la puerta a `shadow`) y F2.9 y F2.10 (la política de datos y lo que el motor `shadow` recibe del evaluador).
- **Decisores:** Propietario de buoh (los tipos de contrato, la caída máxima, que la duración la decida cada estrategia, que él autorice cada estrategia que pasa al bot y la reanudación sola tras datos degradados, decididos el 2026-11-16; plan §12), a propuesta de la dirección técnica (lo demás).
- **Complementa:** [ADR-0002](0002-senales-y-ejecucion-controlada.md), con el modelo de la posición hipotética, que nunca es una orden; [ADR-0003](0003-lenguajes-y-limites.md), con las reglas de cálculo que comparten TypeScript y Python (§8 y §11); y [ADR-0021](0021-mercados-reales-y-fuentes-de-investigacion.md), cuyas cotizaciones y horarios usa (§5 y §7).

## Resumen para el propietario

- **Qué decide.** Cómo se escribe una estrategia dentro de buoh: el formato que el motor de investigación usa para proponer millones de ellas, y que el bot entiende igual.
- **Cómo es una estrategia.** Una ficha de reglas, no un programa: «si se cumplen estas condiciones con estos indicadores, abre un multiplicador o un sube/baja». Hay 13 indicadores fijos, como medias, RSI o volatilidad, y como mucho 6 condiciones para entrar. Así se puede leer y explicar.
- **Ganancias y pérdidas.** Se calculan como Deriv: el multiplicador, con su comisión, su stop loss, su take profit y su cierre al perder lo apostado; el sube/baja, con el pago que Deriv ofrecía en ese momento. Cada estrategia apuesta 10 USD de un capital imaginario de 1000 USD, para que todas se comparen igual, y se para si cae un 50 %.
- **Una sola calculadora.** El backtest y el bot usan exactamente la misma, así que una estrategia hace lo mismo con el pasado que en vivo. Python, el del motor, la copia, y unas pruebas compartidas comprueban que coinciden.
- **Versiones.** Cada estrategia tiene una huella de su contenido: cambiar cualquier cosa crea otra versión, y ninguna se edita. Tú autorizas en la web cada una que pasa al bot.
- **Costo y riesgo.** No cuesta nada. No hay órdenes ni dinero: todo es hipotético, en modo `shadow`.
- **Qué apruebas al fusionarla.** El formato, la apuesta fija del 1 % y el orden de cinco PR de §13.

## Contexto

El 2026-11-16 el propietario decidió que las estrategias las busque un motor de investigación, en Python, que pruebe millones de ellas; que buoh opere primero en Deriv con multiplicadores y sube/baja, sin dígitos; que la duración de cada operación la decida la estrategia, de segundos a horas; una caída máxima del 50 % del capital de cada estrategia; que él autorice cada estrategia que pasa al bot; y que una estrategia detenida por datos degradados vuelva a arrancar sola (`PROJECT_STATUS.md`, «Motor de investigación» y «Disco, VPS y reanudación»).

El plan de Fase 2 pide (§4) un solo evaluador puro para el backtest y el motor `shadow`, cada decisión en su instante, datos fijados y TypeScript para la evidencia; y `F2-STRATEGY-001`, una estrategia declarativa con su gramática, su biblioteca de indicadores, su modelo de posición, sus costos, el vencimiento de sus señales, sus límites de frecuencia y su política de datos. Las cinco ADR del laboratorio comparten el evaluador, el instante de decisión y lo que guarda cada decisión (plan §8): esta fija el evaluador y lo que entra y sale de él; la semántica del backtest (punto 6), cómo se reconstruye cada instante desde los datasets; el protocolo estadístico (punto 7), cómo se juzga; el motor `shadow` (punto 8), cómo corre en vivo; y el motor de investigación (punto 10), cómo se busca.

Hoy `StrategyDefinition` solo está nombrada ([contratos de dominio](../contratos-de-dominio.md), «Contratos futuros»), y `packages/strategy-sdk` no existe.

## Decisión

### 1. Qué es una estrategia

Una estrategia es un `StrategyDefinition` 1.0.0: un documento JSON, sin código, validado en tiempo de ejecución. Tiene:

- **Identidad:** `strategy_id` (el nombre de la familia, estable entre versiones), `semantic_version`, `responsible` (la cuenta de buoh del propietario), `origin` (el motor de investigación, con el identificador de su búsqueda) y una descripción en texto.
- **Mercado:** la fuente, el símbolo, los datos (`ticks` de una secuencia en vivo o `deriv_candles` de los lotes; §2), el perfil de calidad con su hash y la temporalidad.
- **Indicadores:** como mucho 6 instancias de la biblioteca 1.0.0 (§3), cada una con sus parámetros.
- **Reglas:** la dirección (subida o bajada), las condiciones de entrada y, en los multiplicadores, las de salida (§4).
- **Contrato y posición:** el tipo, la apuesta, el multiplicador o la duración, y los límites de la posición (§5).
- **Señales:** el vencimiento y los límites de frecuencia (§6).
- **Datos:** la antigüedad máxima de los datos (§7).
- **Modo:** `execution_mode`, `disabled` hasta que se promueve a `shadow` (§10), y la versión de la que viene.
- **Versiones:** `strategy_schema_version` y `indicator_library_version`.

Una estrategia opera un solo símbolo, en una sola dirección, con un solo tipo de contrato y como mucho una posición abierta. Una idea que opera en las dos direcciones son dos estrategias.

### 2. Datos y reloj

- **Datos.** Solo una estrategia sobre los ticks de una secuencia en vivo (R_100 y el oro) puede ir a `shadow`, porque el backtest y el motor `shadow` tienen que ver los mismos datos (plan §4.1). Una sobre las velas de Deriv de los lotes sirve para investigar, y el motor de investigación no la propone para `shadow` (`F2-RESEARCH-001`).
- **Temporalidad.** `tick`, o velas de 5 y 15 segundos y de 1, 5, 15 y 60 minutos. Las velas las arma buoh con sus ticks, con la regla del [concepto de interfaz](../../diseno/concepto-de-interfaz.md) §9: alineadas en UTC a su múltiplo, por la hora de la fuente de cada tick, con apertura, máximo, mínimo, cierre y número de ticks, y sin vela en un intervalo sin ticks. Con `deriv_candles`, las de 1 minuto de Deriv y sus agregados de 5, 15 y 60 minutos.
- **Instante de decisión.** Con `tick`, el evaluador decide con cada tick durable. Con velas, decide al cerrar cada vela, que es cuando se hace durable el primer tick de un intervalo posterior: así una vela nunca se evalúa antes de estar completa. Un tick que trae la historia de un hueco entra en los indicadores cuando se hace durable, en el orden del log, y nunca dispara una decisión con fecha anterior (plan §4.2). La ADR de la semántica del backtest fija cómo se reconstruye ese orden desde un dataset.

### 3. Biblioteca de indicadores 1.0.0

Cada indicador se calcula sobre la serie de cierres `x` (el precio del tick o el cierre de la vela), y los que lo dicen, sobre el máximo `h` y el mínimo `l` de cada vela; con `tick`, `h = l = x`. `n` es un entero.

| Indicador | Definición | Unidad | Parámetros |
|---|---|---|---|
| `price` | `x_t` | precio | — |
| `return(n)` | `x_t / x_{t−n} − 1` | fracción | n de 1 a 500 |
| `sma(n)` | `(x_{t−n+1} + … + x_t) / n`, sumado del más antiguo al más reciente | precio | n de 2 a 500 |
| `ema(n)` | `α = 2/(n+1)`; empieza con `sma(n)` en el valor `n`; `e_t = e_{t−1} + α·(x_t − e_{t−1})` | precio | n de 2 a 500 |
| `rsi(n)` | de Wilder: subidas `g_t = max(x_t − x_{t−1}, 0)` y bajadas `d_t = max(x_{t−1} − x_t, 0)`; empiezan con su media simple de `n` valores; `G_t = (G_{t−1}·(n−1) + g_t)/n`, y lo mismo `D_t`; `100` si `D_t = 0`, si no `100 − 100/(1 + G_t/D_t)` | de 0 a 100 | n de 2 a 100 |
| `atr(n)` | de Wilder: `TR_t = max(h_t − l_t, |h_t − x_{t−1}|, |l_t − x_{t−1}|)`; empieza con la media simple de `n` valores; `A_t = (A_{t−1}·(n−1) + TR_t)/n` | precio | n de 2 a 100 |
| `volatility(n)` | desviación típica poblacional de `return(1)` en los `n` últimos, en dos pasadas: la media `m` y `√(Σ(r − m)²/n)` | fracción | n de 2 a 500 |
| `highest(n)` | máximo de `h` en los `n` últimos | precio | n de 2 a 500 |
| `lowest(n)` | mínimo de `l` en los `n` últimos | precio | n de 2 a 500 |
| `zscore(n)` | `(x_t − sma(n))/s`, con `s` la desviación típica poblacional de `x` en los `n` últimos, en dos pasadas; indefinido si `s = 0` | sin unidad | n de 2 a 500 |
| `bollinger_pct(n, k)` | `(x_t − (sma(n) − k·s))/(2·k·s)`, con el mismo `s`; indefinido si `s = 0` | sin unidad | n de 2 a 500; k de 1, 1,5, 2, 2,5 o 3 |
| `hour_utc` | hora UTC del instante de decisión | de 0 a 23 | — |
| `weekday_utc` | día UTC del instante de decisión, de 0 (lunes) a 6 (domingo) | de 0 a 6 | — |

Un indicador está indefinido hasta que tiene los valores que necesita. Cambiar una definición, un rango o la lista crea otra versión de la biblioteca.

### 4. Reglas

- **Condición:** `{izquierda, operador, derecha}`. A la izquierda va un indicador; a la derecha, otro indicador o una constante decimal. Los operadores son `gt`, `gte`, `lt`, `lte`, `crosses_above` (antes `izquierda ≤ derecha` y ahora `izquierda > derecha`) y `crosses_below`. Una condición con un valor indefinido, también el anterior de un cruce, es falsa.
- **Entrada:** como mucho 2 grupos alternativos, cada uno de como mucho 3 condiciones que se cumplen a la vez, y, si se quiere, una ventana de horas UTC y unos días de la semana.
- **Salida de un multiplicador:** como mucho un grupo de 3 condiciones, además de los límites de §5. Un sube/baja no tiene salida: termina a su vencimiento.
- No hay más: ni expresiones aritméticas, ni código, ni datos externos. Los límites acotan lo que recorre el motor de investigación y lo que hay que explicar de cada estrategia; una gramática más rica es otra versión, con su ADR.

### 5. Contratos y posición hipotética

Los tipos son los que decidió el propietario: `MULTUP` y `MULTDOWN` (multiplicadores) y `CALL` y `PUT` (sube/baja). Una posición nunca es una orden (ADR-0002).

- **Capital y apuesta.** Cada estrategia tiene un capital inicial hipotético de 1000 USD y apuesta en cada posición una cantidad fija, el 1 % del capital inicial: 10 USD, la misma apuesta con la que buoh cotiza los contratos (ADR-0021 §3), así que el costo cotizado se aplica tal cual. La apuesta no es un parámetro que busque el motor: optimizarla daría ventaja a la estrategia más arriesgada, no a la mejor. Otro tamaño es otra versión de la gramática; en demo y con dinero real lo fija la política de riesgo.
- **Entrada.** La posición empieza en el primer tick durable posterior a la decisión, como un contrato de Deriv, que empieza en el tick siguiente a la compra. La ADR de la semántica del backtest puede sumar una latencia declarada.
- **Multiplicador.** El multiplicador es uno de los que acepta el mercado (`contracts_for`, ADR-0021 §3). La comisión sale de la cotización guardada más cercana anterior a la entrada con ese multiplicador, como fracción de la exposición. El resultado en cada tick es `apuesta × multiplicador × (x_t / x_entrada − 1)` en `MULTUP` (con el signo contrario en `MULTDOWN`) menos la comisión. Se cierra en el primer tick en que el resultado llega al take profit o al stop loss que declare la estrategia, en el que pierde la apuesta entera (con resultado `−apuesta`, el cierre de Deriv), en una decisión en que se cumple la salida, o al pasar su tiempo máximo, de 1 segundo a 24 horas. El resultado es el de ese tick, como en Deriv.
- **Sube/baja.** La duración es una de las que cotiza buoh y ofrece el mercado: 5 ticks, 15 segundos o 1, 5, 15, 60 o 240 minutos (ADR-0021 §3). El pago sale de la cotización guardada más cercana anterior a la entrada, del mismo tipo y duración. Al vencer, gana si el precio de salida es mayor que el de entrada (`CALL`) o menor (`PUT`), y un empate pierde, como en Deriv. El precio de salida es el del quinto tick después del de entrada en una duración de ticks, y el del último tick a la hora del vencimiento o antes en las demás, como documenta Deriv; el PR 3 lo comprueba con su documentación. Gana `pago − apuesta`, o pierde la apuesta.
- **Sin cotización.** Para el tiempo anterior a la primera cotización guardada, la posición usa el costo medido al empezar, declarado como supuesto, y el informe da su sensibilidad (`F2-MARKET-001`).
- **Importes.** En decimal canónico, con aritmética de punto fijo entera, y redondeados al centavo al liquidar cada posición, con redondeo al par.
- **Caída máxima.** La curva de resultados mide el resultado acumulado en % del capital inicial, y su peor caída, la mayor bajada desde un máximo anterior (concepto de interfaz §9), con las posiciones cerradas y el resultado del tick de un multiplicador abierto. Si la caída llega al 50 %, o al tope menor que declare la estrategia, la estrategia se detiene, y esa detención solo se levanta a mano (`F2-STOP-001`).

### 6. Señales

- **Vencimiento.** Una decisión de entrar es una señal. Vence si en `signal_expiry_ms` (de 1000 a 60 000 ms; 5000 por defecto) no llega el tick que abre la posición, y entonces queda como omitida, con su motivo.
- **Frecuencia.** Un mínimo de segundos entre dos entradas (de 0 a 86 400) y un máximo de entradas por día UTC (de 1 a 500). Una señal que los pasaría queda omitida, con su motivo.
- El motor `shadow` convierte cada señal en un `SignalEvent` (`F2-SIGNAL-001`), con lo que fija su ADR.

### 7. Política de datos

Una estrategia solo decide si se cumple todo esto; si no, se detiene, con la causa:

- la salud de su secuencia es `healthy`, sin `connection_lost` ni `event_gap_unresolved` abiertas y sin continuidad pendiente;
- el último dato durable no tiene más de `max_data_age_ms` (de 1000 a 60 000 ms; 5000 por defecto, más el intervalo de la vela si usa velas);
- el perfil de calidad y el esquema de la fuente son los que declara.

Fuera del horario de su mercado (ADR-0021 §3) no decide ni se detiene. Lo que vuelve sola y lo que vuelve a mano lo fija `F2-STOP-001`: una detención por datos degradados se levanta sola cuando los datos vuelven a cumplir esta política, y una por perfil o esquema, a mano. La ADR del motor `shadow` lo implementa en vivo, y la de la semántica del backtest, sobre las marcas de calidad del dataset.

### 8. El evaluador

- **Interfaz.** Una función pura: `evaluar(definición, estado, entrada) → (estado, decisiones)`. La entrada es un evento en el orden del log: un tick durable con sus marcas, el cierre de una vela, un cambio de la salud o de las condiciones, un cambio de horario o una cotización. Las decisiones son `entrar` (una señal, con su contrato), `salir` (con su causa), `liquidar` (con su resultado), `omitir` (con su causa), `detener` y `reanudar`. El estado se serializa en JSON canónico, para que el motor `shadow` lo guarde y la réplica lo compare.
- **Sin efectos.** No lee el reloj, la red, el azar ni ningún archivo: lo que necesita le llega en la entrada. El backtest y el motor `shadow` lo llaman igual, y una estrategia no puede saber si corre en vivo o en una réplica (plan §4.1).
- **Números.** Los precios y las constantes son decimales canónicos. Los indicadores se calculan en binario64 de IEEE 754, desde esos decimales, solo con suma, resta, multiplicación, división, raíz cuadrada, máximo, mínimo y valor absoluto, en el orden que da su definición, sin funciones como la exponencial o el logaritmo y sin reordenar sumas. Esas operaciones dan el mismo resultado, bit a bit, en TypeScript y en Python. Los importes van en punto fijo entero (§5).
- **Versión.** `strategy-evaluator-1.0.0`. Quien llama guarda esa versión con cada decisión y cada backtest; un cambio de lo que decide es otra versión.

### 9. Identidad, versiones y errores

- **Identidad.** El identificador de una versión es el SHA-256 del JSON canónico (JCS) de la definición entera: cambiar cualquier cosa, también la descripción, crea otra versión. Ninguna versión se modifica en su lugar.
- **Versión semántica.** Sube la mayor al cambiar el mercado, los datos, la temporalidad, el tipo de contrato o una versión de la gramática o de la biblioteca; la menor, al cambiar indicadores, parámetros, reglas o límites; y la de parche, al cambiar solo la descripción o al promover a `shadow` (§10). El registro rechaza una versión que no sube respecto de la anterior de su `strategy_id`.
- **Errores.** Una definición inválida se rechaza con una lista de errores estructurados: un código, la ruta del campo y un mensaje. Los códigos son cerrados, por ejemplo `unknown_indicator`, `parameter_out_of_range`, `too_many_conditions`, `contract_not_allowed`, `duration_not_quoted`, `multiplier_not_accepted`, `symbol_not_supported`, `version_unsupported` y `side_contract_mismatch`. Una versión de la gramática o de la biblioteca que el código no conoce se rechaza, nunca se adivina.

### 10. Ciclo de vida, promoción y aprobación

Los estados son los de [seguridad y rigor](../../gobierno/seguridad-y-rigor-cuantitativo.md) y del [protocolo de validación](../../gobierno/protocolo-de-validacion-de-estrategias.md) §4: `draft`, `reviewed`, `active`, `paused` y `retired`. Un cambio de estado es un evento append-only del registro de la API, con su autor, su hora UTC, su motivo y los objetos afectados (`F2-AUDIT-001`); no cambia la versión.

- **`draft`.** El motor de investigación registra en la API la versión que congela (`F2-SEARCH-001`).
- **`draft` → `reviewed`.** La API la pasa sola cuando la definición es válida, sus datasets están publicados y verificados y su registro previo está completo. Qué más pide la revisión técnica para candidatas que genera una máquina lo fija la ADR del protocolo estadístico, que cambia el protocolo en su PR.
- **`reviewed` → `active` en `shadow`.** Solo el propietario, desde la sección Laboratorio de la web, con su sesión, después de ver el informe de evidencia (F2.8), con una confirmación explícita. La promoción crea una versión nueva, igual a la congelada salvo `execution_mode: shadow` y la referencia a la congelada y a su evaluación, y sube su versión de parche. La API comprueba esa igualdad: el evaluador no lee el modo, así que la nueva versión toma las mismas decisiones, y la evidencia de la congelada vale para ella.
- **`active` → `paused`.** Por una detención del motor `shadow` (§7), por la caída máxima (§5) o por el propietario. Vuelve a `active` sola o a mano, como fija `F2-STOP-001`.
- **`retired`.** El propietario retira una versión, o la rechaza en `reviewed`, con un motivo. Es el último estado.

La sección Laboratorio muestra cada versión con sus reglas en palabras, su ciclo de vida y, desde F2.7 y F2.8, su informe. Nunca edita una versión.

### 11. Paridad con Python

El motor de investigación genera definiciones con esta gramática, y el JSON Schema generado desde Zod, en `packages/contracts`, es su contrato (ADR-0003). Python implementa la biblioteca 1.0.0 con el mismo orden de operaciones de §8, y unos vectores compartidos en `test-vectors/` fijan:

- las series de cada indicador, con cada valor binario64 escrito exacto, también los indefinidos;
- las decisiones y los resultados de estrategias sintéticas, con multiplicadores y sube/baja, sus cierres y sus vencimientos;
- definiciones inválidas, con sus errores esperados.

Los dos lados los pasan en CI. Solo cuenta como evidencia el evaluador de TypeScript (plan §4.7).

### 12. Pruebas

- La validación, con los vectores de definiciones inválidas y una prueba de que una versión desconocida se rechaza.
- Cada indicador, con su vector y sus casos límite: los valores indefinidos, `s = 0` y `D_t = 0`.
- El evaluador, con vectores de decisiones: los cruces, la ventana de horas, los límites de frecuencia, el vencimiento de una señal, el stop out, el take profit y el stop loss de un multiplicador, el empate de un sube/baja, la caída máxima y cada causa de la política de datos.
- Las pruebas prohíben red, reloj real y azar, como `F1-VECTOR-001`, y comprueban que la identidad de una versión es el hash de su JSON canónico.

### 13. Secuencia de entrega

El código de F2.6 empieza cuando las cinco ADR del laboratorio están fusionadas (plan §8). Cinco PR:

1. Esta ADR, con sus precisiones al plan de Fase 2 y a `PROJECT_STATUS.md`.
2. `StrategyDefinition` 1.0.0 en `packages/contracts`, con su JSON Schema, la validación con sus errores, los vectores de definiciones inválidas y su semántica en los contratos de dominio.
3. `packages/strategy-sdk`: la biblioteca 1.0.0, los importes de punto fijo, la posición y el evaluador, con sus vectores, y su regla en el mapa de impacto (`F2-GOV-001`).
4. El registro de estrategias en la API: sus tablas append-only, sus eventos de ciclo de vida y sus entradas de auditoría, las rutas de lectura y su OpenAPI (`F2-AUDIT-001`).
5. La sección Laboratorio en la web, con las versiones, sus reglas en palabras y su ciclo de vida, sin datos ficticios. La aprobación llega con F2.8, cuando existe el informe que la justifica.

## Consecuencias

- El motor de investigación sabe exactamente qué puede probar, y cada candidata es una definición que el bot entiende igual.
- Las estrategias se comparan con la misma apuesta, y un resultado no depende de cuánto arriesga cada una.
- Sin exponencial ni logaritmo, los rendimientos son simples y no logarítmicos; es el precio de la paridad bit a bit entre TypeScript y Python.
- Una posición a la vez y una dirección por estrategia simplifican el riesgo y la explicación, y dejan fuera estrategias que piramidan.
- El costo del pasado, antes de las cotizaciones guardadas, es un supuesto declarado.

## Alternativas descartadas

| Alternativa | Por qué no |
|---|---|
| Estrategias como código | El roadmap pide reglas declarativas limitadas, y código ajeno en el bot es un riesgo de seguridad y de reproducción. |
| Un lenguaje de expresiones | Multiplica lo que recorre el motor y lo que hay que explicar; puede llegar con otra versión de la gramática. |
| Indicadores en decimal | Más lento para millones de pruebas, y la raíz cuadrada no da decimales finitos: hace falta una regla de redondeo igual de arbitraria. |
| Optimizar la apuesta | Premia arriesgar más, no decidir mejor. |
| Varias posiciones a la vez | Más riesgo y más estados que explicar, sin que el plan lo pida. |
| Las velas de Deriv en `shadow` | Son datos distintos de los ticks que ve el bot en vivo (plan §4.1). |

## Condiciones de revisión

- El motor de investigación necesita indicadores o reglas que la gramática no tiene.
- Python y TypeScript dejan de coincidir en un vector.
- Deriv cambia cómo cierra un multiplicador, cómo paga un sube/baja o qué duraciones ofrece.
- El propietario cambia la caída máxima, la apuesta o los tipos de contrato.

## Referencias verificadas

- [Plan de Fase 2](../../plan/fase-2-laboratorio-y-bot-shadow.md), §4, §8 y `F2-STRATEGY-001`; [protocolo de validación](../../gobierno/protocolo-de-validacion-de-estrategias.md); [concepto de interfaz](../../diseno/concepto-de-interfaz.md) §9.
- [Deriv: tipos de contrato](https://developers.deriv.com/llms/contract-types.md), consultada el 2026-11-16.
