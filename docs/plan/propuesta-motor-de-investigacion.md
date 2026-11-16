# Propuesta: motor de investigación de estrategias

- **Estado:** propuesta para que el propietario la corrija. No está vigente y no autoriza código, servicios ni gastos. Lo vigente sigue en [`PROJECT_STATUS.md`](../../PROJECT_STATUS.md) y en el [plan de Fase 2](fase-2-laboratorio-y-bot-shadow.md).
- **Fecha:** 2026-11-16.
- **Qué pasa después:** el propietario la corrige en este PR. Con sus correcciones, el mismo PR cambia el plan de Fase 2, el roadmap y `PROJECT_STATUS.md` (§12), y este archivo se borra. Fusionar ese PR es aprobar el cambio.

## Resumen en palabras simples

buoh tendrá un motor de investigación que estudia sin parar los datos que guarda buoh y los que se le añadan de mercados reales. Busca patrones y prueba millones de estrategias, siempre buscando rentabilidad después de pagar los costos. Se queda con las pocas que siguen funcionando con datos que no vio, y las propone. Nunca opera. Una estrategia que propone sigue el camino que ya existe: bot *shadow* sin dinero, después demo y, solo si pasa todas las puertas, dinero real, en la cuenta de Deriv del propietario, con multiplicadores y sube/baja. Los clientes quedan fuera de esta propuesta (§9). Lo que se construye, cómo se conecta con buoh y cómo queda la Fase 2 está en §11.

El motor está escrito en Python acelerado (§7) y corre en un servidor propio (VPS) de Contabo, con más memoria y CPU (§8). La captura, la base de datos, la API y la web siguen en Render, donde ya funcionan.

Lo más importante que hay que saber:

- **R_100 es azar.** Deriv genera sus precios con un generador de números aleatorios ([Deriv](https://deriv.com/markets/derived-indices/synthetic-indices)). En R_100 no hay patrón que encontrar. El motor lo usa como prueba de honestidad: si «encuentra» estrategias ganadoras en R_100, su filtro está mal.
- **Probar millones de estrategias fabrica ganadoras falsas.** Si se prueban muchas, algunas ganan en el pasado por suerte. El motor cuenta todo lo que prueba y le exige más a una ganadora cuanto más probó (§5).
- **Que no encuentre nada es un resultado válido.** Protege el dinero. No hay garantía de que existan estrategias viables.

## 1. Lo que pidió el propietario

El 2026-11-16, en la sesión de Kiro:

- «Es que la verdad yo queria que el motor de estudio sea el que determine las estrategias, no yo mismo».
- «quiero que un motor construido con la mejor tecnologia estudie esos datos buscando estrategias viables, si es necesario meter mercados reales que sean viables, se meten, analizando patrones y demas, sobre el servidor lo alojaremos en una vps con mas ram y mas cpu».
- «Escribe la propuesta completa y yo la corrijo, dejo claro que, quiero que ese motor se mantenga estudiando patrones y miles de estrategias sobre los datos de los brokers para futuras operaciones donde el mismo buoh va a operar tanto por si solo como por el cliente mismo».

Su corrección de la primera versión de esta propuesta, el mismo día: «A ver, lo que dijiste está bien, pero, el motor ok, va a estudiar los datos de buoh y mercados reales, va a probar millones de estrategias, va a buscar patrones, va a analizar mercado siempre buscando rentabilidad, en cuanto a tecnologia perfecto, será python, pero será python puro o como, el servidor será un servidor de calebo creo que se llama cuesta 7 euros al mes, primero operará para mi, olvidemos que habrá clientes por los momentos, sigamos desarrollando el plan, dime, preguntame lo que necesites y sigamos desarrollando este plan, quiero algo realmente potente no se si me has entendido».

Sus respuestas siguientes están en §10. El agente toma de esta corrección cinco decisiones (§10): el motor busca las estrategias; prueba millones; Python, con la opción A de §7; el VPS de Contabo, que el agente toma como el «calebo» del mensaje, de unos 7 EUR al mes; y operar solo para el propietario, sin clientes por ahora.

Hoy el plan de Fase 2 dice otra cosa: el propietario crea las estrategias en la sección Laboratorio y buoh las prueba (§1 del plan). Por eso esta propuesta cambia el plan.

## 2. Lo que ya existe y lo que dice el repositorio

- **Datos.** buoh captura cada tick de R_100 en producción desde el 2026-11-01 y publica datasets verificados cada 6 horas desde el 2026-11-14 ([ADR-0020](../arquitectura/adr/0020-datasets-vivos.md)).
- **La arquitectura objetivo ya prevé el motor.** Su topología pone «investigación Python» entre el almacenamiento y el «registro versionado de estrategias», y dice que Python puede investigar y proponer una estrategia, pero la versión que corre en vivo la ejecuta el motor controlado con un contrato determinista ([arquitectura objetivo](../arquitectura/arquitectura-objetivo.md), «Topología objetivo» y «Datos e investigación»).
- **Python está permitido para esto.** [ADR-0003](../arquitectura/adr/0003-lenguajes-y-limites.md) limita Python a `research/python`, para investigación por lotes, con contratos versionados, y fuera de la ruta de órdenes.
- **Lo que el plan de Fase 2 deja fuera hoy:** más símbolos que R_100, los datos de MetaTrader 5 y Python (§6 del plan), y su §4.7 pide que el evaluador, el backtest y la estadística sean TypeScript.
- **El protocolo ya admite explorar.** El entrenamiento «explora hipótesis y parámetros» y la validación «selecciona entre alternativas» ([protocolo de validación](../gobierno/protocolo-de-validacion-de-estrategias.md) §2). El informe ya cuenta «cuántas variantes se probaron» (plan, `F2-EVAL-001`).
- **El camino hacia operar ya existe:** `shadow` → `demo` → `real`, y solo `execution-gateway` ejecuta ([ADR-0002](../arquitectura/adr/0002-senales-y-ejecucion-controlada.md); roadmap, Fases 4 a 6).

## 3. Lo medido el 2026-11-16

Consultas de solo lectura al canal público de Deriv (`wss://api.derivws.com/trading/v1/options/ws/public`), entre las 03:40 y las 04:05 UTC, sin guardar precios:

- **Mercados reales en el mismo canal que ya usa buoh** (`active_symbols`): 4 metales (oro `frxXAUUSD`, plata, paladio y platino), 25 pares de divisas (14 principales y 11 menores), 12 índices de bolsa (`OTC_NDX`, `OTC_SPC`, `OTC_DJI`, `OTC_GDAXI` y otros), y Bitcoin y Ethereum. El adaptador de buoh los puede capturar sin cambiar de fuente.
- **Historia que da Deriv** (`ticks_history`):
  - velas de 1 minuto, 1 hora y 1 día de hasta un año atrás, pidiéndolas por tramos: las más antiguas que devolvió son del 2025-11-17 en el oro y el EUR/USD y del 2025-11-20 en R_100. Una petición más antigua devuelve el último tramo, no la fecha pedida;
  - ticks, solo los últimos: 1000 por petición, unos 16 minutos del oro, y una petición más antigua también devuelve los últimos.
- **Tipos de contrato** (`contracts_for`): R_100 tiene 35, en 14 familias, entre ellos sube/baja, multiplicadores, acumuladores, dígitos y toca/no toca, algunos de 1 a 10 ticks. El oro tiene muchos menos: sube/baja desde 5 minutos, multiplicadores sin vencimiento, y los demás desde 1 o 7 días.
- **Lo que cobra Deriv** (`proposal`, sin cuenta, hacia las 04:20 UTC, con una apuesta de 10 USD):
  - sube/baja de R_100 a 5 ticks y a 5 minutos: paga 19,54 y 19,55. Para no perder hay que acertar el 51,2 % de las veces;
  - sube/baja del oro a 15 minutos y a 1 hora: paga 17,66 y 17,41. Para no perder hay que acertar el 56,6 % y el 57,4 %;
  - multiplicador ×100: comisión de 0,36 USD en R_100 y de 0,18 USD en el oro. Con una exposición de 1000 USD, el precio tiene que moverse a favor un 0,036 % y un 0,018 % para cubrirla.
- **Ritmo de los ticks** (suscripción de 120 s desde las 05:08 UTC): el oro, 120 ticks, uno por segundo; R_100, 61, uno cada 2 segundos. Hoy buoh guarda cada tick como una escritura de clase A en R2, que cobra 4,50 USD por millón por encima del millón gratuito de cada mes, redondeando al millón siguiente (ADR-0018 §14). El oro cotiza unas 23 horas al día, 5 días a la semana: con un tick por segundo son unos 1,8 millones de escrituras al mes, y con los unos 1,35 millones de R_100 el total pasa de 2 a 3 millones cobrados. Son unos 9 USD más al mes (estimación).
- **Costo frente a movimiento** (hacia las 05:20 UTC): la comisión del multiplicador ×100 como porcentaje de la exposición, y la desviación de los retornos de las velas de 1 hora (las últimas 1000) y de 1 día (las últimas 365). Cuanto menor es la última columna, menos se come el costo del movimiento de una hora típica. Es una señal de dónde es más fácil cubrir los costos, no de dónde se gana.

  | Mercado | Comisión | Movimiento típico en 1 hora | En 1 día | Comisión / movimiento en 1 hora |
  |---|---|---|---|---|
  | R_100 | 0,036 % | 1,07 % | 5,12 % | 0,03 |
  | Oro (`frxXAUUSD`) | 0,018 % | 0,27 % | 1,85 % | 0,07 |
  | Bitcoin (`cryBTCUSD`) | 0,070 % | 0,42 % | 2,32 % | 0,17 |
  | Plata (`frxXAGUSD`) | 0,097 % | 0,49 % | 4,47 % | 0,20 |
  | Ethereum (`cryETHUSD`) | 0,117 % | 0,58 % | 3,17 % | 0,20 |
  | EUR/USD | 0,024 % | 0,08 % | 0,34 % | 0,32 |
  | GBP/USD | 0,024 % | 0,07 % | 0,39 % | 0,35 |
  | USD/JPY | 0,030 % | 0,08 % | 0,47 % | 0,40 |

  Los índices de bolsa (`OTC_NDX`, `OTC_SPC`, `OTC_GDAXI`) no tienen multiplicadores: el Nasdaq solo ofrece sube/baja de 15 minutos a 1 hora y contratos de 1 día o más (`contracts_for`). R_100 es el más barato frente a su movimiento, pero es azar: un costo bajo no sirve sin un patrón.
- **Precios de VPS,** que se confirman al comprar:
  - Contabo, según [su blog](https://contabo.com/blog/best-budget-vps-developers/), comprobado por Contabo el 2026-08-17: Cloud VPS 4, 4 vCPU, 8 GB y 100 GB, desde 5,24 EUR al mes con IVA a 24 meses. Según sus páginas de ubicaciones, el Cloud VPS 12, 12 vCPU y 48 GB, 20 EUR al mes, y el Cloud VPS 16, 16 vCPU y 64 GB, 29,60 EUR. El mismo blog avisa de que su CPU puede rendir menos con mucha carga;
  - Hetzner, como comparación, después de su subida del 2026-06-15, según [CostGoat](https://costgoat.com/pricing/hetzner), actualizado el 2026-10-20, sin IVA: CX43, 8 vCPU compartidas y 16 GB, 15,99 EUR al mes; CX53, 16 vCPU compartidas y 32 GB, 29,49 EUR.

Consecuencia: con datos de Deriv, el motor puede estudiar desde el primer día un año de velas de 1 minuto de mercados reales. Los ticks de mercados reales solo existen desde que buoh empiece a capturarlos.

## 4. El motor

### Qué hace, en un ciclo que no para

1. **Datos.** Lee datasets publicados por su `dataset_id` y los archivos de historia importados (§6). Nunca lee la captura viva ni toca el bróker.
2. **Candidatas.** Arma estrategias combinando una gramática fija: indicadores con su definición matemática, condiciones, filtros de horario y de volatilidad, salidas (objetivo, stop, tiempo) y tamaño. Cada candidata es un `StrategyDefinition` declarativo, legible como reglas.
3. **Prueba rápida.** La evalúa con los datos de entrenamiento, con los costos del lugar donde se operaría (§4, «Qué cuenta como viable»).
4. **Selección.** Elige con los datos de validación, que el entrenamiento no tocó.
5. **Filtros de honestidad.** Descarta lo que se explica por suerte (§5).
6. **Congelar y proponer.** La superviviente se congela como versión inmutable. El backtest oficial de buoh, en TypeScript, la vuelve a evaluar y la prueba fuera de muestra se ejecuta una sola vez (plan, `F2-EVAL-001`). Si pasa, se propone para el bot *shadow*.
7. **Vigilar.** Lo que corre en *shadow* se compara con lo esperado. Una deriva la pausa, como ya pide el protocolo §5. Con cada semana de datos nuevos, el ciclo vuelve a empezar.

### Qué lo hace potente

- **Muchos datos y buenos:** varios mercados reales, un año de velas desde el primer día y ticks que se acumulan, con procedencia y calidad comprobadas.
- **Velocidad:** Python acelerado, con los indicadores calculados una sola vez y compartidos por todas las candidatas (§7).
- **Búsqueda inteligente:** en lugar de probar a ciegas, la búsqueda evolutiva y la bayesiana gastan el tiempo en las zonas que prometen.
- **Un filtro duro:** con millones de pruebas, la potencia de verdad es no creerse la suerte (§5).
- **No para:** cada semana estudia los datos nuevos, propone, y retira lo que deja de funcionar.
- **Después, aprendizaje automático:** modelos que encuentran patrones que las reglas no expresan, cuando se puedan reproducir y explicar (§10).

### Qué cuenta como viable

Una estrategia es viable solo después de los costos de Deriv, donde operará primero el propietario (§10, decisión 6). Cada tipo de contrato cobra distinto (§3):

- **Opciones** (por ejemplo sube/baja): el pago que fija Deriv para cada contrato. En el oro, a 15 minutos, hay que acertar el 56,6 % de las veces solo para no perder.
- **Multiplicadores:** la comisión al abrir, que en el oro el precio cubre moviéndose a favor un 0,018 %. Son el tipo más barato medido, y el único del oro que se puede cerrar a los pocos segundos.
- **CFD en MT5** (Deriv MT5 o Vantage), más adelante: el spread, la comisión y el swap, con margen y apalancamiento ([ADR-0007](../arquitectura/adr/0007-varias-fuentes-y-metatrader-5.md) §6).

El tipo de contrato y la duración forman parte de cada candidata: los elige el motor, dentro de los tipos que permitió el propietario (§10, decisión 10). Para evaluar opciones, el motor necesita el pago que Deriv habría ofrecido en cada momento, así que buoh empieza a guardarlo (§6).

### Qué no hace nunca

- No envía órdenes, no tiene credenciales de ningún bróker y no se conecta a ninguno para operar.
- No modifica una estrategia que ya está en *shadow*: un cambio crea otra versión, que vuelve a empezar.
- No usa los datos de la prueba fuera de muestra para elegir nada.
- No promete ni presenta rentabilidad: cada cifra lleva su modo, período, muestra, costos y pérdidas ([seguridad y rigor](../gobierno/seguridad-y-rigor-cuantitativo.md) §1 y §3).

## 5. Honestidad con millones de estrategias

Es la parte que decide si el motor sirve. Con millones de pruebas, la mejor del pasado casi siempre es suerte, así que el listón sube con cada prueba: una ganadora tiene que seguir funcionando en varios períodos y, cuando su patrón lo permita, en varios mercados.

- **Registro previo de la búsqueda.** Antes de mirar resultados se registra qué puede probar el motor: la gramática, los rangos de parámetros, los datos y la métrica principal. Cambiarlo crea otra búsqueda (protocolo §1).
- **Todo se cuenta.** Cada candidata probada queda en el registro de la búsqueda, también las descartadas.
- **Tiempo separado.** Entrenamiento, validación y prueba fuera de muestra en períodos que no se solapan, en orden, y validación con ventanas que avanzan en el tiempo (*walk-forward*).
- **Corrección por cuántas se probaron.** La ADR del protocolo estadístico fija las pruebas. Las candidatas son el Sharpe deflactado (Bailey y López de Prado, 2014), la probabilidad de sobreajuste del backtest (Bailey, Borwein, López de Prado y Zhu, 2017) y la comparación con la línea base corregida por búsqueda de White (2000) o de Hansen (2005).
- **Controles negativos.** El motor corre la misma búsqueda sobre R_100 y sobre series aleatorias sintéticas. Ahí no hay nada que encontrar: si aprueba más estrategias de las que da el azar, su filtro está mal y se corrige antes de creerle en mercados reales.
- **El futuro decide.** La prueba que cuenta es el *shadow*: datos que no existían cuando la estrategia se congeló.

## 6. Datos y mercados

1. **R_100 sigue** como hoy, y sirve de control negativo (§5).
2. **Historia de Deriv:** el año de velas de 1 minuto de los mercados que elija el propietario (§3), descargado por tramos y guardado como dataset propio, con su procedencia, su hora en UTC y su calidad, como cualquier fuente de buoh.
3. **Captura viva del oro,** junto a la de R_100, por el canal público de Deriv y con el adaptador de hoy, para acumular ticks desde ahora (§10, decisión 13). El oro cierra los fines de semana y cada día un rato: la captura tiene que distinguir un mercado cerrado de un fallo, y la ADR de F2.6 lo resuelve con los horarios de Deriv (`trading_times`). Cada símbolo necesita sus umbrales medidos antes de publicar datasets ([ADR-0020](../arquitectura/adr/0020-datasets-vivos.md) §1).
4. **Exportaciones de MT5 del propietario,** más adelante y en velas (§10, decisión 8): su historia de MT5 entra como fuente importada, con la hora de su servidor convertida a UTC y comprobada, su procedencia y su calidad. Adelanta una parte de la Fase 1B sin el puente MQL5.
5. **Puente de MT5 (Fase 1B):** después, para los datos vivos del lugar donde se opere en MT5.
6. **Lo que cobra Deriv:** cada pocos minutos, los pagos de las opciones y las comisiones de los multiplicadores de cada mercado, con `proposal` y sin cuenta, como fuente propia de buoh. Sin ellos, el motor no puede saber cuánto habría pagado una opción en el pasado.

Las estrategias de segundos necesitan ticks, y Deriv solo da los últimos (§3). Por eso la captura viva de los mercados reales empieza pronto: el motor estudia primero estrategias de minutos a horas con las velas, y las de segundos a medida que se acumulan los ticks.

En vivo: R_100, como hoy, y el oro (§10, decisión 13). Con velas, que casi no cuestan, el motor puede estudiar todos los mercados reales que tienen multiplicadores. Propuesta para empezar: el oro, la plata, el EUR/USD, el GBP/USD, el USD/JPY, Bitcoin y Ethereum (§3). Los índices de bolsa no tienen multiplicadores en Deriv, así que quedan fuera hasta que el motor estudie sube/baja.

## 7. Tecnología

### Opciones

| Opción | Cómo | A favor | En contra |
|---|---|---|---|
| **A. Búsqueda en Python y evaluador oficial en TypeScript** (elegida por el propietario el 2026-11-16: «será python») | El motor busca en Python, en `research/python`; cada candidata sale como `StrategyDefinition`, y `packages/strategy-sdk`, en TypeScript, la vuelve a evaluar para el backtest oficial y el *shadow* | Lo más rápido para probar millones; el mejor ecosistema de estadística y aprendizaje automático; es lo que ya prevén ADR-0003 y la arquitectura objetivo | Dos evaluadores: hay que demostrar con vectores compartidos que dan lo mismo |
| B. Todo en TypeScript | El mismo evaluador busca y opera | Un solo evaluador | Más lento para explorar y casi sin herramientas de estadística |
| C. Todo en Python, también el bot | Un solo lenguaje | Simple al principio | Pone Python en la ruta de señales y, después, de órdenes, contra ADR-0003 |

### Python acelerado, no Python puro

Python puro, línea a línea, es demasiado lento para millones de pruebas. En el motor, Python dirige el trabajo, y el cálculo pesado lo hacen bibliotecas compiladas: NumPy, Polars y DuckDB, escritas en C, C++ y Rust, y Numba, que convierte en código de máquina las funciones de Python que recorren los datos. Es la forma habitual de hacer investigación cuantitativa en Python.

Estimación sin medir: con los indicadores ya calculados, una regla simple recorre un año de velas de 1 minuto (unas 370 000) en unos pocos milisegundos en un núcleo, así que un servidor de 4 núcleos prueba millones al día. Con ticks, cada prueba cuesta decenas de veces más. El primer incremento del motor lo mide.

### Con la A

- **Solo cuenta lo de TypeScript.** El resultado de Python sirve para elegir candidatas; la evidencia es el backtest oficial. Los vectores compartidos fijan que los dos dan las mismas decisiones (ADR-0003, «Contrato entre lenguajes»).
- **Herramientas candidatas,** que la ADR del motor fija con su versión y su motivo: Polars y DuckDB para leer los datos por partes, NumPy y Numba para evaluar rápido, Optuna o búsqueda evolutiva para recorrer la gramática y, más adelante, modelos de árboles como LightGBM.
- **Modelos de aprendizaje automático:** ver «La inteligencia artificial», abajo (§10, decisión 9). Primero, reglas.
- **Resultados:** el registro de cada búsqueda y sus candidatas, en un bucket propio de R2 (`buoh-investigacion`), con un resumen que la API muestra en la sección Laboratorio.

### La inteligencia artificial

Una regla dice «si pasa A y B, entra». La arma el motor combinando piezas, y se puede leer. Un modelo de aprendizaje automático no recibe reglas: recibe cientos de miles de ejemplos del pasado, cada uno con cómo estaba el mercado (los indicadores de ese momento) y qué pasó después, y aprende solo qué combinaciones suelen venir antes de una subida o de una bajada. Con datos nuevos da una probabilidad, por ejemplo «58 % de que suba en los próximos 15 minutos», y la estrategia entra solo cuando esa probabilidad paga los costos del contrato (§4).

En buoh funcionaría así:

1. **Entrenar** el modelo con los datos de entrenamiento.
2. **Probarlo** con datos que no vio, con el mismo filtro duro que las reglas (§5): un modelo es una candidata más, y cuenta como muchas pruebas.
3. **Congelarlo:** se guarda como un archivo fijo, con su huella, dentro de la versión de la estrategia. No sigue aprendiendo en vivo, así que da siempre la misma respuesta ante los mismos datos, y cada decisión del bot se puede reproducir (plan, `F2-REPLAY-001`).
4. **Usarlo en el bot:** el bot *shadow*, en TypeScript, evalúa ese archivo y los vectores compartidos comprueban que responde igual que en Python.
5. **Renovarlo:** cada cierto tiempo, el motor entrena una versión nueva con los datos nuevos, y esa versión vuelve a pasar todas las pruebas.

El tipo de modelo propuesto son los árboles de decisión potenciados, como LightGBM, y no las redes neuronales grandes: con datos de mercado en tablas suelen funcionar igual o mejor, entrenan rápido en un servidor pequeño y su evaluación es simple de reproducir. Sus riesgos: aprende el ruido con más facilidad que una regla, explica peor por qué decidió y necesita más datos. Por eso entra cuando el motor de reglas funcione y haya meses de datos (§10, decisión 9).

## 8. Alojamiento

### Opciones

| Opción | Costo aproximado | A favor | En contra |
|---|---|---|---|
| **A. VPS solo para el motor** (recomendada) | unos 7 EUR al mes en Contabo (§3) | Mucha CPU y memoria por poco dinero; la captura y la web no cambian; el motor puede apagarse o crecer sin tocar producción | Un servidor más que mantener seguro |
| B. Mover todo a un VPS | parecido, sin Render | Un solo proveedor | Rehacer el despliegue que funciona, perder la base gestionada y sus copias, y más trabajo de operación |
| C. Un plan más grande de Render | 25 USD al mes, 2 GB y 1 CPU (Standard) | Nada nuevo que mantener | Poca CPU para millones de pruebas |

### El VPS de Contabo

El propietario eligió Contabo el 2026-11-16, por unos 7 EUR al mes (§1). Lo que dice Contabo de sus planes (§3):

- su plan de entrada, el Cloud VPS 4, tiene 4 vCPU, 8 GB y 100 GB de disco, desde 5,24 EUR al mes con IVA si se contrata a 24 meses; el precio depende del plazo y de la ubicación;
- si hace falta más, el Cloud VPS 12 tiene 12 vCPU y 48 GB por unos 20 EUR al mes, y el Cloud VPS 16, 16 vCPU y 64 GB por unos 29,60;
- la misma Contabo avisa de que su CPU puede rendir menos en las horas de más carga. Para un trabajo por lotes eso solo lo hace más lento, no cambia los resultados. El primer incremento mide cuántas estrategias prueba por hora, y se sube de plan, o se cambia a Hetzner, solo si esa medición lo pide.

### Con la A

- **Datos:** el motor lee los datasets y la historia de R2 con un token de solo lectura propio. R2 no cobra el tráfico de salida. No lee los datos pesados de la base de Render, cuyo tráfico de salida sí se cobra.
- **Seguridad:** acceso solo con llave SSH, cortafuegos cerrado salvo SSH, actualizaciones de seguridad automáticas, ningún secreto en Git y ninguna credencial de bróker en el VPS, nunca. Escribe solo en su bucket. La ADR de alojamiento fija quién lo administra y cómo le llegan sus secretos.
- **Región:** Contabo tiene centros de datos en Europa, EE. UU. y Asia, y fuera de la región por defecto cobra un recargo. Los datos están en el este de EE. UU., pero para un trabajo por lotes la distancia apenas importa; la ADR elige la región midiendo.
- **Lo crea y lo paga el propietario,** con los pasos del PR de despliegue, como en Render (ADR-0016 §3).

## 9. Operar para el propietario

El propietario decidió el 2026-11-16 que buoh opere primero para él y dejar fuera a los clientes por ahora («primero operará para mi, olvidemos que habrá clientes por los momentos»). El producto sigue previendo clientes ([visión](../producto/vision-y-alcance.md) y [modelo de lanzamiento](../producto/modelo-de-lanzamiento.md)), pero esta propuesta no diseña nada para ellos.

Para el propietario, el camino ya existe y no cambian sus puertas: demo en la Fase 4 y dinero real en las Fases 5 y 6, con `execution-gateway`, `risk-policy`, idempotencia, reconciliación y *kill switch*. En MT5, sus cuentas propias siguen la excepción de ADR-0007 §5.

## 10. Decisiones del propietario

### Tomadas el 2026-11-16 (§1)

1. **El motor busca las estrategias,** en lugar de crearlas el propietario («el motor ok»), con los filtros de §5.
2. **Prueba millones de estrategias y busca patrones,** siempre buscando rentabilidad («va a probar millones de estrategias, va a buscar patrones, va a analizar mercado siempre buscando rentabilidad»).
3. **Python,** con la opción A de §7 («será python»).
4. **Un VPS de Contabo,** de unos 7 EUR al mes («el servidor será un servidor de calebo creo que se llama cuesta 7 euros al mes»).
5. **Solo para el propietario,** sin clientes por ahora (§9).

Y en su respuesta siguiente, el mismo día: «quiero operar primero en deriv porque creo que mt5 requiere otra serie de cosas para poder tenerlo trabajando 24\7 creo, aun no tengo exportaciones de nada pero lo haremos luego sera siempre en velas, el tiempo que dure la operacion lo determinará la estrategia puede ser segundos minutos o horas»:

6. **Operar primero en Deriv.** MT5 queda para después, porque necesita una terminal encendida todo el día (ADR-0007 §4).
7. **La duración la decide cada estrategia,** de segundos a horas. Las de segundos esperan a tener ticks capturados (§6).
8. **Las exportaciones de MT5, más adelante y siempre en velas.** Hoy no tiene ninguna. El agente lo toma así: las exportaciones serán de velas, no de ticks.

Y en la siguiente: «me parece bien empezar con las reglas y sumar la ia despues, si eso es lo mas viable, prefiero multiplicadores y sube y baja, dejar fuera los digitos»:

9. **Primero reglas, y la inteligencia artificial después** (§7, «La inteligencia artificial»), con su propio incremento y su ADR, después de la puerta de salida de la Fase 2 (§11).
10. **Multiplicadores y sube/baja,** sin dígitos. Sustituye a la decisión pendiente de qué tipo de operación representan las posiciones hipotéticas (`PROJECT_STATUS.md`). Los acumuladores, toca/no toca y los demás tipos quedan fuera hasta otra decisión.

Y en la siguiente: «Acepto la caida maxima de 50% del capital pero las estrategias o buoh operará en demo primero, deriv permite guardar los datos 24h pero asumo el mismo riesgo se guardara durante todo el tiempo, lo acepto para mi uso propio»:

11. **Caída máxima del 50 % del capital de cada estrategia.** El motor busca la mayor rentabilidad neta sin pasar de ese tope, en el backtest, en *shadow* y en demo. El agente había recomendado el 20 % y le explicó el riesgo: con un 50 %, una estrategia puede perder la mitad de su capital antes de pararse, y recuperarse de esa caída exige ganar un 100 %. Antes de operar, buoh pasa por demo, como ya piden las puertas (protocolo §4). El límite para dinero real es otra decisión, «Límites monetarios y política de riesgo para fases `demo` y `real`» (`PROJECT_STATUS.md`), y se toma antes de la Fase 5.
12. **Guardar la historia de Deriv todo el tiempo,** solo para uso propio y sin redistribuirla (ADR-0004 §13), aceptando que los términos de Deriv solo permiten guardar sus datos 24 horas. Es el mismo riesgo que ya aceptó para la captura y los datasets («Decisiones vigentes relevantes» de `PROJECT_STATUS.md`), ahora para un año de velas de varios mercados.

Y en la siguiente: «ok mejor vamos a capturar los dos a ver si le saco algo a r100, si no luego quito r100 y dejo solo el oro». El agente le había dado tres opciones: cambiar R_100 por el oro (su recomendación, con el mismo costo que hoy), capturar los dos, por unos 9 USD más al mes, o no capturar nada nuevo:

13. **Capturar en vivo R_100 y el oro.** Si R_100 no da nada, el propietario lo quita más adelante y deja solo el oro.

### Pendientes, cada una con la recomendación del agente

14. **Qué mercados estudia el motor con velas.** Recomendación: el oro, la plata, el EUR/USD, el GBP/USD, el USD/JPY, Bitcoin y Ethereum, cada uno con su año de velas de 1 minuto y su actualización diaria (§6). Las velas casi no cuestan: unas pocas peticiones al día por mercado.
15. **El presupuesto mensual** (§11, «Costo»): de unos 26 USD hoy a unos 45 a 55 USD. Recomendación: aprobarlo, con el oro como único mercado nuevo capturado en vivo, y revisar cuando haya mediciones.

La dirección técnica decide, y lo deja escrito en las ADR: las herramientas, la gramática, las pruebas estadísticas, el formato de los datos y la forma del registro.

## 11. Qué se construye y cómo

### Las piezas

| Pieza | Qué hace | Lenguaje | Dónde corre | Estado |
|---|---|---|---|---|
| Captura (`apps/market-data-worker`, `ingest`) | escucha Deriv y guarda cada tick | TypeScript | Render, `buoh-ingesta` | existe; suma el oro (F2.6) |
| Operaciones (`buoh-operaciones`) | salud, retención, datasets; suma las velas y lo que cobra Deriv | TypeScript | Render, cada 5 minutos | existe; se amplía (F2.6) |
| `packages/strategy-sdk` | el formato de una estrategia, los indicadores, los costos de los multiplicadores y de sube/baja, y el evaluador oficial, puro | TypeScript | lo usan el backtest oficial y el bot | nueva (F2.7) |
| Motor de investigación (`research/python`) | busca patrones, prueba millones de estrategias y propone candidatas | Python acelerado | VPS de Contabo | nueva (F2.8) |
| Backtest oficial (`apps/backtest`) | vuelve a evaluar cada candidata con `strategy-sdk`, hace la prueba fuera de muestra una sola vez y escribe el informe | TypeScript | VPS de Contabo | nueva (F2.9) |
| API y web (`apps/api`, `apps/web`) | la sección Laboratorio: candidatas, informes y la aprobación del propietario | TypeScript | Render, `buoh-api` | existen; se amplían (F2.9) |
| Bot *shadow* (`apps/signal-engine`) | sigue en vivo las estrategias aprobadas, con señales y posiciones imaginarias, y se para solo si los datos fallan | TypeScript | Render, su propio servidor, de 7 USD al mes, ya aprobado | nueva (F2.10) |

El backtest oficial pasa de la API (plan §11, «Los backtests corren dentro del servicio de la API») al VPS: allí hay CPU y memoria, y la API, con 512 MB, no tiene que repartirlos. Eso cambia lo que ADR-0019 decidió sobre el aislamiento de los backtests, y la ADR del motor lo precisa.

### Cómo se conecta con buoh

```text
Deriv (canal público)
  ├── ticks en vivo ─────────► captura (Render) ──► log en R2 y PostgreSQL
  └── velas y precios ───────► operaciones (Render) ─┐
                                                     ▼
                   datasets publicados en R2 (el motor solo los lee)
                                                     │
                                                     ▼
          VPS de Contabo: motor de investigación (Python)
                    └── candidatas ──► backtest oficial (TypeScript)
                                                     │
                                                     ▼
                         bucket buoh-investigacion (R2)
                                                     │
                                                     ▼
          API y web (Render): Laboratorio ──► el propietario aprueba
                                                     │
                                                     ▼
          registro de estrategias en PostgreSQL (solo se añade, auditado)
                                                     │
                                                     ▼
          bot shadow (Render) ──► señales y posiciones imaginarias
                                                     │
                                                     ▼
          Fase 4: execution-gateway ──► cuenta demo de Deriv
```

Las reglas de la conexión:

- **El VPS solo lee datos** de R2, con un token de solo lectura, y solo escribe en `buoh-investigacion`. No toca la base de producción, ni la captura, ni ningún bróker.
- **Solo el propietario activa.** El motor propone; una estrategia pasa al bot solo cuando el propietario la aprueba en la web, con su sesión de contraseña y código, y la aprobación queda en la auditoría.
- **El bot no depende del VPS.** Lee las estrategias aprobadas de PostgreSQL: si el VPS se apaga, el bot sigue.

### Los incrementos de la Fase 2

F2.1 a F2.5 no cambian, con lo que les falta («Próximos pasos, en orden» de `PROJECT_STATUS.md`). Desde F2.6:

| Incremento | Qué entrega | Depende de |
|---|---|---|
| **F2.6** Mercados reales y lo que cobra Deriv | captura viva del oro, con sus umbrales medidos, junto a la de R_100; el año de velas de 1 minuto de los mercados de §6, y su actualización diaria; los pagos de sube/baja y las comisiones de los multiplicadores cada pocos minutos | su ADR y el PR 6 de ADR-0020 |
| **F2.7** Estrategias | `StrategyDefinition`, los indicadores con sus vectores, los costos de los multiplicadores y de sube/baja, y el evaluador puro (`F2-STRATEGY-001`) | las cuatro ADR del laboratorio |
| **F2.8** Motor de investigación | `research/python` y el VPS: lectura de datos por partes, el evaluador acelerado con los vectores de F2.7, la búsqueda de reglas, el registro de cada búsqueda, los controles negativos y la medición de cuántas estrategias prueba por hora | F2.6 y F2.7 |
| **F2.9** Backtest oficial y evaluación | `apps/backtest` en el VPS, la prueba fuera de muestra una sola vez, el informe con las correcciones por búsqueda, y la sección Laboratorio con la aprobación (`F2-BACKTEST-001` y `F2-EVAL-001`) | F2.8 |
| **F2.10** Bot *shadow* y señales | como el F2.9 de hoy (`F2-SHADOW-001`, `F2-SIGNAL-001` y `F2-STOP-001`), con la semántica de los multiplicadores y de sube/baja | F2.9 |
| **F2.11** Posiciones, comparación y réplica | como el F2.10 de hoy (`F2-POSITION-001` y `F2-REPLAY-001`) | F2.10 |
| **F2.12** Puerta de salida | la evidencia del plan §13 | F2.11 |

F2.6 va primero porque los ticks del oro solo existen desde que buoh los captura: así se acumulan mientras se construye lo demás, como hizo F2.2 con R_100. La inteligencia artificial llega después de F2.12, con su propio incremento y su ADR.

La puerta de salida no cambia: una estrategia del motor en *shadow* al menos 7 días, cada decisión reproducida y detenciones solas ante datos degradados (plan §13). No exige ganancias: si el motor no encuentra nada rentable, la estrategia que pase la puerta lo dirá en su informe.

### ADR antes del código

1. **Mercados y fuentes de investigación** (F2.6): los símbolos, las velas como datos de buoh, lo que cobra Deriv como fuente propia, los umbrales del oro y el costo.
2. **Modelo de estrategia** (F2.7): la gramática, los indicadores, los multiplicadores y sube/baja, sus costos y sus duraciones.
3. **Motor de investigación y su VPS** (F2.8): la versión de Python y sus bibliotecas, la búsqueda, el registro, la seguridad del VPS y sus tokens.
4. **Backtest y protocolo estadístico** (F2.9): cómo se reconstruye cada decisión, la prueba fuera de muestra y las correcciones por búsqueda.
5. **Motor *shadow*** (F2.10), con los ensayos de la puerta de salida y cómo se reanuda una estrategia detenida, que el propietario decide antes (`PROJECT_STATUS.md`, «Decisiones pendientes»).

La 1 va sola, para que la captura del oro empiece pronto. Las 2 a 5 comparten el evaluador y el instante de decisión, así que se escriben seguidas y se fusionan antes del primer PR de código de F2.7, como pedía el plan para las cuatro del laboratorio (§8). Todas empiezan después del PR 6 de ADR-0020 («Orden del trabajo»).

### Lenguajes

- **TypeScript:** todo lo que toca producción o decide: la captura, las operaciones, la API, la web, `strategy-sdk`, el backtest oficial y el bot.
- **Python acelerado:** solo el motor de investigación, en `research/python`, en el VPS (ADR-0003).
- **SQL:** las migraciones de PostgreSQL.
- Ninguno más en la Fase 2.

### Cómo trabajamos

- **Cada incremento:** su ADR, después PR pequeños con sus pruebas, una revisión semántica por PR, CI en verde, la fusión del propietario, el despliegue y su evidencia. Como hasta ahora (`AGENTS.md`).
- **El agente** escribe el código, las pruebas, los documentos y los pasos del runbook.
- **El propietario** decide lo de producto, dinero y riesgo, fusiona, crea y paga los servicios, como el VPS de Contabo y los tokens de R2, con los pasos del runbook, y guarda los secretos.
- **Python con las mismas exigencias que TypeScript:** versiones fijadas con archivo de bloqueo, pruebas sin red con los vectores compartidos, linter y tipos estrictos, todo en CI.
- **Con el motor en marcha:** cada semana, un informe en Laboratorio con lo que probó, cuántas, lo que propone y por qué, y también lo que no encontró.

### Costo

Hoy, unos 26 USD al mes («Siguiente tarea autorizada» de `PROJECT_STATUS.md`). Se suman el bot *shadow*, 7 USD, ya aprobado; el VPS, unos 7 EUR; y el oro en vivo, unos 9 USD (estimación, §3 y §10, decisión 13). Las velas y lo que cobra Deriv caben en la ejecución de `buoh-operaciones` que ya existe. En total, unos 45 a 55 USD al mes (estimación), que necesitan el visto bueno del propietario (§10, decisión 15).

## 12. Qué cambia en los documentos si se aprueba

- **Plan de Fase 2:** el §1 (quién crea las estrategias), el §4.7 (Python entra para la búsqueda), el §6 (`research/python`, `apps/backtest`, más símbolos y la importación de MT5), requisitos nuevos para los mercados, el motor y la búsqueda honesta, el §8 (las ADR de §11), el §9 (los incrementos de §11), el §11 (el presupuesto y dónde corren los backtests), el §12 (las decisiones) y el §13 (la estrategia de la puerta de salida sale del motor).
- **Roadmap:** el incremento 2 de la Fase 2 pasa a ser el motor, y la importación de MT5 se adelanta de la Fase 1B.
- **`PROJECT_STATUS.md`:** el paso 6 de «Próximos pasos, en orden», las decisiones vigentes y las pendientes.
- **ADR-0019:** una precisión, cuando llegue la ADR del motor, porque los backtests ya no corren en la API.

Los pasos 1 a 5 de «Próximos pasos, en orden» no cambian.

## 13. Riesgos y límites

- **Puede no encontrar nada viable.** En R_100 es lo esperado. En mercados reales, nadie lo sabe antes de probar.
- **Pocos datos al principio.** Un año de velas sirve para operaciones de minutos a horas. Para estrategias de ticks hacen falta meses de captura.
- **Las opciones de Deriv cobran mucho en mercados reales.** En el oro a 15 minutos hay que acertar el 56,6 % solo para no perder (§3). Si hay algo viable, es más probable encontrarlo con multiplicadores, que cobran mucho menos.
- **Dos evaluadores.** Si Python y TypeScript divergen, la evidencia sería falsa. Lo evitan los vectores compartidos y que solo cuente el de TypeScript.
- **Costos.** El VPS y cada símbolo capturado suben el gasto mensual; nada se compra sin el visto bueno del propietario.
- **Términos de Deriv, MT5 y Vantage.** Guardar datos y usar programas automáticos tiene condiciones; las de MT5 y Vantage todavía no se revisaron (ADR-0007 §8).
- **Un servidor más.** El VPS hay que mantenerlo seguro; un fallo suyo no toca la captura ni la web, porque no tiene permisos sobre ellas.
- **La CPU de Contabo varía.** Con poca CPU, el motor prueba menos por día; la medición del primer incremento dice si el plan de 7 EUR alcanza.

## Referencias

- Bailey, D. H. y López de Prado, M. (2014). «The Deflated Sharpe Ratio: Correcting for Selection Bias, Backtest Overfitting and Non-Normality». *Journal of Portfolio Management*, 40(5).
- Bailey, D. H., Borwein, J., López de Prado, M. y Zhu, Q. J. (2017). «The Probability of Backtest Overfitting». *Journal of Computational Finance*, 20(4).
- White, H. (2000). «A Reality Check for Data Snooping». *Econometrica*, 68(5).
- Hansen, P. R. (2005). «A Test for Superior Predictive Ability». *Journal of Business & Economic Statistics*, 23(4).
- [Deriv: índices sintéticos](https://deriv.com/markets/derived-indices/synthetic-indices) y [documentación de la API](https://developers.deriv.com/docs/).
- [Contabo: comparación de VPS económicos de 2026](https://contabo.com/blog/best-budget-vps-developers/) y [sus planes en Europa](https://contabo.com/en-us/locations/europe/).
- [CostGoat: precios de Hetzner Cloud](https://costgoat.com/pricing/hetzner).
