# Propuesta: motor de investigación de estrategias

- **Estado:** propuesta para que el propietario la corrija. No está vigente y no autoriza código, servicios ni gastos. Lo vigente sigue en [`PROJECT_STATUS.md`](../../PROJECT_STATUS.md) y en el [plan de Fase 2](fase-2-laboratorio-y-bot-shadow.md).
- **Fecha:** 2026-11-16.
- **Qué pasa después:** el propietario la corrige en este PR. Con sus correcciones, el mismo PR cambia el plan de Fase 2, el roadmap y `PROJECT_STATUS.md` (§11), y este archivo se borra. Fusionar ese PR es aprobar el cambio.

## Resumen en palabras simples

buoh tendrá un motor de investigación que estudia solo los datos que guarda buoh y los que se le añadan de mercados reales. Prueba miles de estrategias, se queda con las pocas que siguen funcionando después de pagar los costos y con datos que no vio, y las propone. Nunca opera. Una estrategia que propone sigue el camino que ya existe: bot *shadow* sin dinero, después demo y, solo si pasa todas las puertas, dinero real, primero para el propietario y después para clientes.

El motor corre en un servidor propio (VPS) con más memoria y CPU. La captura, la base de datos, la API y la web siguen en Render, donde ya funcionan.

Lo más importante que hay que saber:

- **R_100 es azar.** Deriv genera sus precios con un generador de números aleatorios ([Deriv](https://deriv.com/markets/derived-indices/synthetic-indices)). En R_100 no hay patrón que encontrar. El motor lo usa como prueba de honestidad: si «encuentra» estrategias ganadoras en R_100, su filtro está mal.
- **Probar miles de estrategias fabrica ganadoras falsas.** Si se prueban muchas, algunas ganan en el pasado por suerte. El motor cuenta todo lo que prueba y le exige más a una ganadora cuanto más probó (§5).
- **Que no encuentre nada es un resultado válido.** Protege el dinero. No hay garantía de que existan estrategias viables.

## 1. Lo que pidió el propietario

El 2026-11-16, en la sesión de Kiro:

- «Es que la verdad yo queria que el motor de estudio sea el que determine las estrategias, no yo mismo».
- «quiero que un motor construido con la mejor tecnologia estudie esos datos buscando estrategias viables, si es necesario meter mercados reales que sean viables, se meten, analizando patrones y demas, sobre el servidor lo alojaremos en una vps con mas ram y mas cpu».
- «Escribe la propuesta completa y yo la corrijo, dejo claro que, quiero que ese motor se mantenga estudiando patrones y miles de estrategias sobre los datos de los brokers para futuras operaciones donde el mismo buoh va a operar tanto por si solo como por el cliente mismo».

Hoy el plan de Fase 2 dice otra cosa: el propietario crea las estrategias en la sección Laboratorio y buoh las prueba (§1 del plan). Por eso esta propuesta cambia el plan.

## 2. Lo que ya existe y lo que dice el repositorio

- **Datos.** buoh captura cada tick de R_100 en producción desde el 2026-11-01 y publica datasets verificados cada 6 horas desde el 2026-11-14 ([ADR-0020](../arquitectura/adr/0020-datasets-vivos.md)).
- **La arquitectura objetivo ya prevé el motor.** Su topología pone «investigación Python» entre el almacenamiento y el «registro versionado de estrategias», y dice que Python puede investigar y proponer una estrategia, pero la versión que corre en vivo la ejecuta el motor controlado con un contrato determinista ([arquitectura objetivo](../arquitectura/arquitectura-objetivo.md), «Topología objetivo» y «Datos e investigación»).
- **Python está permitido para esto.** [ADR-0003](../arquitectura/adr/0003-lenguajes-y-limites.md) limita Python a `research/python`, para investigación por lotes, con contratos versionados, y fuera de la ruta de órdenes.
- **Lo que el plan de Fase 2 deja fuera hoy:** más símbolos que R_100, los datos de MetaTrader 5 y Python (§6 del plan), y su §4.7 pide que el evaluador, el backtest y la estadística sean TypeScript.
- **El protocolo ya admite explorar.** El entrenamiento «explora hipótesis y parámetros» y la validación «selecciona entre alternativas» ([protocolo de validación](../gobierno/protocolo-de-validacion-de-estrategias.md) §2). El informe ya cuenta «cuántas variantes se probaron» (plan, `F2-EVAL-001`).
- **El camino hacia operar ya existe:** `shadow` → `demo` → `real`, y solo `execution-gateway` ejecuta ([ADR-0002](../arquitectura/adr/0002-senales-y-ejecucion-controlada.md); roadmap, Fases 4 a 6). Operar para clientes es la etapa 5 del [modelo de lanzamiento](../producto/modelo-de-lanzamiento.md), «Ejecución autorizada».

## 3. Lo medido el 2026-11-16

Consultas de solo lectura al canal público de Deriv (`wss://api.derivws.com/trading/v1/options/ws/public`), entre las 03:40 y las 04:05 UTC, sin guardar precios:

- **Mercados reales en el mismo canal que ya usa buoh** (`active_symbols`): 4 metales (oro `frxXAUUSD`, plata, paladio y platino), 25 pares de divisas (14 principales y 11 menores), 12 índices de bolsa (`OTC_NDX`, `OTC_SPC`, `OTC_DJI`, `OTC_GDAXI` y otros), y Bitcoin y Ethereum. El adaptador de buoh los puede capturar sin cambiar de fuente.
- **Historia que da Deriv** (`ticks_history`):
  - velas de 1 minuto, 1 hora y 1 día de hasta un año atrás, pidiéndolas por tramos: las más antiguas que devolvió son del 2025-11-17 en el oro y el EUR/USD y del 2025-11-20 en R_100. Una petición más antigua devuelve el último tramo, no la fecha pedida;
  - ticks, solo los últimos: 1000 por petición, unos 16 minutos del oro, y una petición más antigua también devuelve los últimos.
- **Tipos de contrato de R_100** (`contracts_for`): 35, en 14 familias, entre ellos sube/baja, multiplicadores, acumuladores, dígitos y toca/no toca.
- **Precios de VPS** (Hetzner, después de su subida del 2026-06-15, según [CostGoat](https://costgoat.com/pricing/hetzner), actualizado el 2026-10-20, sin IVA): CX43, 8 vCPU compartidas y 16 GB, 15,99 EUR al mes; CX53, 16 vCPU compartidas y 32 GB, 29,49 EUR; CCX33, 8 vCPU dedicadas y 32 GB, 138,49 EUR. Los CX solo existen en Alemania y Finlandia. Se confirman al comprar.

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

### Qué cuenta como viable

Una estrategia es viable solo después de los costos del lugar donde se operaría, y cada lugar cobra distinto:

- **Opciones de Deriv** (por ejemplo sube/baja): el pago que fija Deriv para cada contrato.
- **Multiplicadores de Deriv:** la comisión al abrir.
- **CFD en MT5** (Deriv MT5 o Vantage): el spread, la comisión y el swap, con margen y apalancamiento ([ADR-0007](../arquitectura/adr/0007-varias-fuentes-y-metatrader-5.md) §6).

El motor evalúa cada candidata con el modelo de costos de cada lugar que el propietario elija (§10, decisión 3). Una estrategia viable en uno puede no serlo en otro.

### Qué no hace nunca

- No envía órdenes, no tiene credenciales de ningún bróker y no se conecta a ninguno para operar.
- No modifica una estrategia que ya está en *shadow*: un cambio crea otra versión, que vuelve a empezar.
- No usa los datos de la prueba fuera de muestra para elegir nada.
- No promete ni presenta rentabilidad: cada cifra lleva su modo, período, muestra, costos y pérdidas ([seguridad y rigor](../gobierno/seguridad-y-rigor-cuantitativo.md) §1 y §3).

## 5. Honestidad con miles de estrategias

Es la parte que decide si el motor sirve. Con miles de pruebas, la mejor del pasado casi siempre es suerte.

- **Registro previo de la búsqueda.** Antes de mirar resultados se registra qué puede probar el motor: la gramática, los rangos de parámetros, los datos y la métrica principal. Cambiarlo crea otra búsqueda (protocolo §1).
- **Todo se cuenta.** Cada candidata probada queda en el registro de la búsqueda, también las descartadas.
- **Tiempo separado.** Entrenamiento, validación y prueba fuera de muestra en períodos que no se solapan, en orden, y validación con ventanas que avanzan en el tiempo (*walk-forward*).
- **Corrección por cuántas se probaron.** La ADR del protocolo estadístico fija las pruebas. Las candidatas son el Sharpe deflactado (Bailey y López de Prado, 2014), la probabilidad de sobreajuste del backtest (Bailey, Borwein, López de Prado y Zhu, 2017) y la comparación con la línea base corregida por búsqueda de White (2000) o de Hansen (2005).
- **Controles negativos.** El motor corre la misma búsqueda sobre R_100 y sobre series aleatorias sintéticas. Ahí no hay nada que encontrar: si aprueba más estrategias de las que da el azar, su filtro está mal y se corrige antes de creerle en mercados reales.
- **El futuro decide.** La prueba que cuenta es el *shadow*: datos que no existían cuando la estrategia se congeló.

## 6. Datos y mercados

1. **R_100 sigue** como hoy, y sirve de control negativo (§5).
2. **Historia de Deriv:** el año de velas de 1 minuto de los mercados que elija el propietario (§3), descargado por tramos y guardado como dataset propio, con su procedencia, su hora en UTC y su calidad, como cualquier fuente de buoh.
3. **Captura viva de mercados reales:** los mismos mercados, por el canal público de Deriv y con el adaptador de hoy, para acumular ticks desde ahora. Cada símbolo necesita sus umbrales medidos antes de publicar datasets ([ADR-0020](../arquitectura/adr/0020-datasets-vivos.md) §1).
4. **Exportaciones de MT5 del propietario:** su historia de MT5 entra como fuente importada, con la hora de su servidor convertida a UTC y comprobada, su procedencia y su calidad. Adelanta una parte de la Fase 1B sin el puente MQL5.
5. **Puente de MT5 (Fase 1B):** después, para los datos vivos del lugar donde se opere en MT5.

Propuesta para empezar: el oro (`frxXAUUSD`), el EUR/USD (`frxEURUSD`) y el Nasdaq (`OTC_NDX`), y sumar más después de medir lo que cuestan y lo que aportan.

## 7. Tecnología

### Opciones

| Opción | Cómo | A favor | En contra |
|---|---|---|---|
| **A. Búsqueda en Python y evaluador oficial en TypeScript** (recomendada) | El motor busca en Python, en `research/python`; cada candidata sale como `StrategyDefinition`, y `packages/strategy-sdk`, en TypeScript, la vuelve a evaluar para el backtest oficial y el *shadow* | Lo más rápido para probar miles; el mejor ecosistema de estadística y aprendizaje automático; es lo que ya prevén ADR-0003 y la arquitectura objetivo | Dos evaluadores: hay que demostrar con vectores compartidos que dan lo mismo |
| B. Todo en TypeScript | El mismo evaluador busca y opera | Un solo evaluador | Más lento para explorar y casi sin herramientas de estadística |
| C. Todo en Python, también el bot | Un solo lenguaje | Simple al principio | Pone Python en la ruta de señales y, después, de órdenes, contra ADR-0003 |

### Con la A

- **Solo cuenta lo de TypeScript.** El resultado de Python sirve para elegir candidatas; la evidencia es el backtest oficial. Los vectores compartidos fijan que los dos dan las mismas decisiones (ADR-0003, «Contrato entre lenguajes»).
- **Herramientas candidatas,** que la ADR del motor fija con su versión y su motivo: Polars y DuckDB para leer los datos por partes, NumPy y Numba para evaluar rápido, Optuna o búsqueda evolutiva para recorrer la gramática y, más adelante, modelos de árboles como LightGBM.
- **Modelos de aprendizaje automático:** entran solo si su decisión se puede reproducir byte a byte en el bot y explicar (§10, decisión 6). Primero, reglas.
- **Resultados:** el registro de cada búsqueda y sus candidatas, en un bucket propio de R2 (`buoh-investigacion`), con un resumen que la API muestra en la sección Laboratorio.

## 8. Alojamiento

### Opciones

| Opción | Costo aproximado | A favor | En contra |
|---|---|---|---|
| **A. VPS solo para el motor** (recomendada) | 16 a 30 EUR al mes (CX43 o CX53, §3) | Mucha CPU y memoria por poco dinero; la captura y la web no cambian; el motor puede apagarse o crecer sin tocar producción | Un servidor más que mantener seguro |
| B. Mover todo a un VPS | parecido, sin Render | Un solo proveedor | Rehacer el despliegue que funciona, perder la base gestionada y sus copias, y más trabajo de operación |
| C. Un plan más grande de Render | 25 USD al mes, 2 GB y 1 CPU (Standard) | Nada nuevo que mantener | Poca CPU para miles de pruebas |

### Con la A

- **Datos:** el motor lee los datasets y la historia de R2 con un token de solo lectura propio. R2 no cobra el tráfico de salida. No lee los datos pesados de la base de Render, cuyo tráfico de salida sí se cobra.
- **Seguridad:** acceso solo con llave SSH, cortafuegos cerrado salvo SSH, actualizaciones de seguridad automáticas, ningún secreto en Git y ninguna credencial de bróker en el VPS, nunca. Escribe solo en su bucket. La ADR de alojamiento fija quién lo administra y cómo le llegan sus secretos.
- **Región:** los CX solo existen en Europa, y los datos están en el este de EE. UU. Para un trabajo por lotes no importa; la ADR lo confirma midiendo.
- **Lo crea y lo paga el propietario,** con los pasos del PR de despliegue, como en Render (ADR-0016 §3).

## 9. Operar por sí solo y para clientes

Interpretación del agente, para que el propietario la corrija: «operar por sí solo» es que buoh opere la cuenta del propietario de forma automática, y «por el cliente» es que un cliente vincule su cuenta y autorice a buoh a operar en ella estrategias aprobadas, además de recibir señales.

Las dos cosas ya están en el producto y no cambian sus puertas:

- **Para el propietario:** demo en la Fase 4 y dinero real en las Fases 5 y 6, con `execution-gateway`, `risk-policy`, idempotencia, reconciliación y *kill switch*.
- **Para clientes:** señales pagas en la Fase 3B y ejecución autorizada en la etapa 5 del modelo de lanzamiento, con OAuth de Deriv y sin recibir nunca contraseñas ni fondos. En MT5 no hay hoy una forma permitida de operar cuentas de clientes: MT5 no tiene OAuth, y buoh solo acepta la excepción de las cuentas MT5 del propietario (ADR-0007 §5). Hacerlo necesitaría otra decisión y su ADR.
- **Aviso:** operar o recomendar operaciones para otras personas suele ser una actividad regulada. Antes hace falta la evaluación legal de la jurisdicción, que ya es una decisión pendiente, y que una conclusión técnica no sustituye ([seguridad y rigor](../gobierno/seguridad-y-rigor-cuantitativo.md) §6).

## 10. Decisiones del propietario

Cada una con la recomendación del agente:

1. **Aprobar que el motor busque las estrategias,** en lugar de crearlas el propietario. Recomendación: sí, con los filtros de §5.
2. **Qué mercados se añaden.** Recomendación: el oro, el EUR/USD y el Nasdaq de Deriv (§6), y más después de medir. Cada símbolo capturado en vivo suma escrituras en R2: con el guardado de hoy, entre unos 5 y 15 USD al mes por símbolo (estimación, a medir con su ritmo de ticks), que se pueden bajar cambiando cómo se guarda cada evento.
3. **Dónde se operaría al final y cuánto dura cada operación,** para el modelo de costos (§4). Recomendación: hasta decidirlo, evaluar con multiplicadores de Deriv y con CFD de MT5, y operaciones de minutos a horas, que es lo que permiten las velas de 1 minuto.
4. **El VPS.** Recomendación: Hetzner CX43 (8 vCPU y 16 GB, unos 16 EUR al mes), y subir al CX53 cuando una medición lo pida.
5. **Importar sus exportaciones de MT5.** Recomendación: sí, del bróker donde piensa operar.
6. **Modelos que no se leen como reglas** (aprendizaje automático). Recomendación: empezar solo con reglas y decidir los modelos cuando haya resultados.
7. **Guardar más historia de Deriv.** Los términos de Deriv solo permiten guardar sus datos 24 horas, y el propietario ya aceptó guardar más («Decisiones vigentes relevantes» de `PROJECT_STATUS.md`). Descargar un año de historia de varios mercados agranda ese riesgo. Recomendación: aceptarlo para uso propio y no redistribuir nada, como hoy (ADR-0004 §13).

La dirección técnica decide, y lo deja escrito en las ADR: las herramientas, la gramática, las pruebas estadísticas, el formato de los datos y la forma del registro.

## 11. Qué cambia en los documentos si se aprueba

- **Plan de Fase 2:** el §1 (quién crea las estrategias), el §4.7 (Python entra para la búsqueda), el §6 (`research/python`, más símbolos y la importación de MT5), requisitos nuevos para el motor, la búsqueda honesta y los mercados, el §8 (el orden de las ADR), el §9, el §11 (el presupuesto), el §12 (las decisiones) y el §13 (la estrategia de la puerta de salida sale del motor).
- **Roadmap:** el incremento 2 de la Fase 2 pasa a ser el motor, y la importación de MT5 se adelanta de la Fase 1B.
- **`PROJECT_STATUS.md`:** el paso 6 de «Próximos pasos, en orden» y las decisiones pendientes.
- **ADR nuevas, en este orden:** mercados y fuentes de investigación; alojamiento del motor; el motor y su registro; protocolo estadístico para la búsqueda; modelo de estrategia; backtest; y motor *shadow*. Las cuatro últimas son las del laboratorio que ya preveía el plan (§8, puntos 5 a 8), adaptadas.

Los pasos 1 a 5 de «Próximos pasos, en orden» no cambian. Las ADR empiezan después del PR 6 de ADR-0020, como decidió el propietario el 2026-11-14 («Orden del trabajo»).

## 12. Riesgos y límites

- **Puede no encontrar nada viable.** En R_100 es lo esperado. En mercados reales, nadie lo sabe antes de probar.
- **Pocos datos al principio.** Un año de velas sirve para operaciones de minutos a horas. Para estrategias de ticks hacen falta meses de captura.
- **Dos evaluadores.** Si Python y TypeScript divergen, la evidencia sería falsa. Lo evitan los vectores compartidos y que solo cuente el de TypeScript.
- **Costos.** El VPS y cada símbolo capturado suben el gasto mensual; nada se compra sin el visto bueno del propietario.
- **Términos de Deriv, MT5 y Vantage.** Guardar datos y usar programas automáticos tiene condiciones; las de MT5 y Vantage todavía no se revisaron (ADR-0007 §8).
- **Un servidor más.** El VPS hay que mantenerlo seguro; un fallo suyo no toca la captura ni la web, porque no tiene permisos sobre ellas.

## Referencias

- Bailey, D. H. y López de Prado, M. (2014). «The Deflated Sharpe Ratio: Correcting for Selection Bias, Backtest Overfitting and Non-Normality». *Journal of Portfolio Management*, 40(5).
- Bailey, D. H., Borwein, J., López de Prado, M. y Zhu, Q. J. (2017). «The Probability of Backtest Overfitting». *Journal of Computational Finance*, 20(4).
- White, H. (2000). «A Reality Check for Data Snooping». *Econometrica*, 68(5).
- Hansen, P. R. (2005). «A Test for Superior Predictive Ability». *Journal of Business & Economic Statistics*, 23(4).
- [Deriv: índices sintéticos](https://deriv.com/markets/derived-indices/synthetic-indices) y [documentación de la API](https://developers.deriv.com/docs/).
- [CostGoat: precios de Hetzner Cloud](https://costgoat.com/pricing/hetzner).
