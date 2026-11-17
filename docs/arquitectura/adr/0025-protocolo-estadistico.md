# ADR-0025: Protocolo estadístico (F2.8)

- **Estado:** Aceptada
- **Fecha:** 2026-11-17
- **Ámbito:** Fase 2, incremento F2.8 (`F2-EVAL-001`, `F2-SEARCH-001` en lo de las correcciones por búsqueda y las congelaciones, y `F2-AUDIT-001` en lo de las propuestas, los registros previos, las evaluaciones y las aprobaciones, del [plan de Fase 2](../../plan/fase-2-laboratorio-y-bot-shadow.md), §8, punto 7). Cambia el [protocolo de validación](../../gobierno/protocolo-de-validacion-de-estrategias.md) §1, §3 y §4 (§5, §6 y §13). Fija también lo que toman de ella F2.6b (la métrica principal, `validation_finalists`, los estadísticos del resumen, la familia y los controles, §2 a §4), F2.7 (las variantes que tiene que superar una propuesta, §4) y F2.9 y F2.10 (la deriva de `F2-POSITION-001`, §9).
- **Decisores:** Propietario de buoh (que él autorice cada estrategia que pasa al bot, aprobado al fusionar el plan, y la candidata de demostración de `F2-SEARCH-001`; plan §1 y §12), a propuesta de la dirección técnica (lo demás).
- **Complementa:** [ADR-0019](0019-api-cuentas-y-auditoria.md) §5, §7 y §12, con las acciones de auditoría, las tablas y lo que corre en el proceso hijo (§3, §7, §10 y §12); [ADR-0022](0022-modelo-de-estrategia.md) §7 y §10, con la deriva y la revisión técnica de `draft` a `reviewed` (§6 y §9); [ADR-0023](0023-motor-de-investigacion.md) §2, §5, §6 y §14, con la métrica principal, `validation_finalists`, el resumen, la familia, los controles, la congelación, una ruta nueva y el orden de sus PR (§2 a §5 y §15); y [ADR-0024](0024-semantica-del-backtest.md) §6 y §9, con las variantes que hay que superar y dónde guarda la API la réplica (§4 y §10).

## Resumen para el propietario

- **Qué decide.** Cómo sabe buoh si una estrategia que encontró el motor es buena de verdad o solo tuvo suerte, y qué tiene que pasar antes de que tú la veas para aprobarla.
- **El problema.** Si pruebas millones de estrategias, la mejor del pasado casi siempre es suerte. Por eso buoh cuenta cuántas se probaron y exige mucho más a la mejor cuantas más se probaron (el «Sharpe deflactado»). También repite la búsqueda con datos barajados al azar: si ahí también «encuentra» estrategias, el motor está mal y no te propone nada.
- **El examen final.** Cada estrategia congelada se prueba después con datos nuevos, que no existían cuando el motor buscó: como mínimo 14 días y como mucho 56. buoh calcula esa prueba por su cuenta, sin fiarse del motor, y exige que gane de forma clara, no por suerte, aunque se congelen muchas a la vez.
- **Lo más probable.** Con tan pocas semanas de datos nuevos, es difícil que una estrategia real lo demuestre en la Fase 2. Si ninguna pasa, puedes aprobar una de demostración, marcada «sin ventaja demostrada», solo para probar el bot, como ya prevé el plan.
- **Lo que ves.** Un informe con todas las cifras, cada una con su contexto: cuánto ganó y perdió, su peor caída, con cuántas operaciones, cuántas estrategias se probaron y cómo salieron todas las congeladas. Tú apruebas o rechazas.
- **En vivo.** Si en el bot una estrategia gana mucho menos, o opera mucho más o mucho menos que en sus pruebas, se pausa sola, y solo vuelve si tú lo decides.
- **Costo y riesgo.** No cuesta nada nuevo. La espera de los datos nuevos retrasa el final de la Fase 2: como mínimo unas 3 semanas desde la primera congelación, contando los 7 días en el bot. Nada opera ni toca dinero.
- **Qué apruebas al fusionarla.** Todas las reglas de esta ADR, que son propuestas de la dirección técnica, los cambios del protocolo de validación y el orden de ocho PR de §15.

## Contexto

El plan de Fase 2 pide esta ADR antes del código de F2.8 (§8, punto 7): las correcciones por búsqueda (`F2-SEARCH-001`), como el Sharpe deflactado, la probabilidad de sobreajuste del backtest o la comparación con la línea base de White o de Hansen, que una propuesta tiene que superar; las reglas medibles de la evaluación (`F2-EVAL-001`), con la duración de la ventana fuera de muestra; y cómo cumplen las candidatas del motor el registro previo, con su hipótesis y su mecanismo, y la revisión técnica del protocolo de validación §1 y §4, que cambia en el mismo PR. `F2-POSITION-001` le pide la prueba de deriva.

Otras ADR dejaron puntos para esta:

- ADR-0022 §10: qué más exige `draft` → `reviewed` a una candidata que genera una máquina, y si lo comprueba la API sola.
- ADR-0023 §6: la lista de métricas principales; cómo se suman las pruebas de una familia; cuántas aprobadas en un control son demasiadas; lo que guarda el resumen para la familia; los campos de la congelación; y, en «Consecuencias», si la API recalcula los recuentos desde las listas. §2: si hace falta SciPy.
- ADR-0024 §6: cuáles de las cuatro variantes tiene que superar una propuesta. §9 y §10: dónde guarda la API el resultado de la réplica, que no puede escribir en R2, y las métricas que no calcula el backtest.

Lo que ya está fijado:

- **El motor busca** en tres etapas, sobre la ventana de entrenamiento, mide sus finalistas una vez en la de validación y corre la misma búsqueda sobre controles: una serie barajada, armada por Python, y, en las del oro, R_100 (ADR-0023 §6). Lo que calcula no es evidencia (plan §4.7).
- **Las finalistas se repiten** en el VPS con `apps/backtest`, en TypeScript, sobre datasets publicados, con cuatro variantes; su registro en la API cita su paridad con Python en el entrenamiento y la validación, y las variantes van con `not_compared` (ADR-0024 §6, §9 y §10).
- **La API** registra la congelación (`draft`), corre la réplica y la prueba fuera de muestra en su proceso hijo, una a la vez y con 180 MiB como mucho, y un hijo que falla deja su backtest como fallido, con su causa (ADR-0019 §12 y ADR-0024 §9). Solo el propietario pasa una versión a `shadow` (ADR-0022 §10).
- **Las métricas del backtest** son enteras: importes en centavos, fracciones con 6 decimales y tiempos en milisegundos (ADR-0024 §10). Los indicadores no usan la exponencial ni el logaritmo, para la paridad con Python (ADR-0022 §8).
- **La literatura** ([referencias](#referencias-verificadas)): el Sharpe probabilístico y el deflactado de Bailey y López de Prado dan la probabilidad de que el Sharpe verdadero pase de un umbral, `Φ((SR − SR₀) · √(T − 1) / √(1 − γ₃·SR + (γ₄ − 1)/4 · SR²))`, con T observaciones, su asimetría γ₃ y su curtosis γ₄. En el deflactado, el umbral es el máximo que darían N pruebas sin ninguna ventaja, `SR₀ = √V · ((1 − γ) · Φ⁻¹(1 − 1/N) + γ · Φ⁻¹(1 − 1/(N·e)))`, con V la varianza de los Sharpe de las pruebas y γ la constante de Euler-Mascheroni. La probabilidad de sobreajuste (PBO) de Bailey, Borwein, López de Prado y Zhu necesita el rendimiento de muchas configuraciones en bloques de tiempo, y el «Reality Check» de White y la prueba SPA de Hansen, la serie de resultados de todas las alternativas comparadas.

## Decisión

### 1. El camino de una candidata

1. **Búsqueda** (VPS, ADR-0023 §6): entrenamiento, finalistas medidas en validación y controles.
2. **Repetición** (VPS, ADR-0024 §9): cada finalista, con sus variantes y sus vecinas (§4), en `apps/backtest`.
3. **Filtros** (VPS, §4): solo pasan a la congelación las finalistas que superan las correcciones, calculadas con la biblioteca de §8 sobre la repetición y con los estadísticos de la familia que da la API (§3).
4. **Congelación** (API, `draft`): la API la registra y compone su registro previo (§5). Su hora abre la ventana fuera de muestra (§7).
5. **Réplica y revisión técnica** (API, `draft` → `reviewed`): la API repite la candidata y sus variantes, y vuelve a calcular los filtros con su propia réplica (§6).
6. **Prueba fuera de muestra** (API): al terminar la ventana, con datos nuevos y una prueba de significación con su corrección (§7).
7. **Informe y aprobación** (web): el propietario ve el informe de evidencia y aprueba o rechaza la puerta `reviewed` → `shadow` (§11).

Los filtros de los pasos 3 y 5 dependen en parte de lo que afirma el VPS (§3). Lo que no depende de él es el paso 6: datos que no existían al congelar, una prueba que calcula la API y un umbral que no se afloja aunque se congelen muchas candidatas. Un VPS comprometido puede elegir qué congela, pero de las versiones de un símbolo con la ventana abierta a la vez, la probabilidad de que alguna sin ventaja pase por azar es como mucho de un 5 % (§7).

### 2. La métrica principal

La lista de métricas principales de `ResearchSearchSpec` (ADR-0023 §6) tiene una en la versión 1.0.0: `daily_sharpe`.

- **El resultado diario** `r_d` es la suma de los resultados de las posiciones liquidadas el día UTC `d`, en fracción del capital inicial de 1000 USD (ADR-0022 §5), para cada día de la ventana en que su mercado tuvo horario (ADR-0021 §3). Un día sin operaciones cuenta como 0. Se cuenta al liquidarse, sin valorar las posiciones abiertas.
- **El Sharpe diario** es la media de los `r_d` dividida por su desviación típica muestral, con `n − 1`, sin anualizar. `T` es el número de `r_d`. Con todos los `r_d` iguales, no está definido, y la candidata no se puede congelar.
- **La asimetría y la curtosis** (γ₃ y γ₄, con γ₄ = 3 en una normal) son los momentos centrales de orden 3 y 4 de los `r_d`, divididos por la desviación típica poblacional al cubo y a la cuarta.
- **En una lista** (ADR-0023 §6), la métrica de cada candidata va redondeada a 6 decimales, con redondeo al par, como un entero de millonésimas, para que sus sumas sean exactas en Python y en TypeScript (§3). Una candidata con el Sharpe indefinido va con 0.
- **Las métricas auxiliares** son las del backtest (ADR-0024 §10), y la caída máxima, que la tercera etapa del motor optimiza con NSGA-II (ADR-0023 §6).

### 3. La familia de una búsqueda

- **Qué es.** La familia de una candidata son las búsquedas del mismo símbolo y la misma clase de datos (`ticks` o `deriv_candles`) cuyas ventanas de validación se solapan con la suya: reutilizar los mismos datos de validación es seguir probando contra ellos. Los controles de un mismo tipo (la serie barajada, o R_100 en una búsqueda del oro) y del mismo símbolo forman su propia familia.
- **Qué cuenta.** `N_val`, el número de mediciones en validación de la familia, y `V_val`, la varianza muestral de sus Sharpe diarios en validación, con las indefinidas como 0. Cada búsqueda registra antes de empezar cuántas finalistas medirá en validación (`validation_finalists`), y `N_val` suma, de cada búsqueda, el mayor de lo registrado y de lo medido: un VPS no puede contar menos de lo que registró antes de empezar. También se cuentan, como contexto, `N_train`, todas las candidatas evaluadas en entrenamiento, y `V_train`.
- **Quién lo calcula** (precisión de ADR-0023 §6 y «Consecuencias»). El resumen de cada búsqueda trae sus estadísticos suficientes: el número de mediciones y la suma y la suma de cuadrados de su métrica, en millonésimas, en entrenamiento y en validación. Al registrarlo, la API los recalcula en su proceso hijo (ADR-0019 §12) desde las listas de la búsqueda, por partes y con sus techos (ADR-0023 §7), con aritmética entera exacta. Si no coinciden, la búsqueda queda como inconsistente y no se congela nada de su familia mientras se solape con ella. Los guarda para siempre en PostgreSQL, así que la familia se puede calcular aunque las listas venzan a los 30 días.
- **Los campos llegan antes que F2.8** (precisión de ADR-0023 §14). `validation_finalists` en `ResearchSearchSpec` 1.0.0 y los estadísticos suficientes y la PBO en `ResearchSearchSummary` 1.0.0 entran con el PR 3 de ADR-0023, y el motor los calcula desde su PR 4, así que toda búsqueda de producción los trae. Cuando llega el PR 4 de esta ADR, la API recalcula los de las búsquedas ya registradas cuyas listas todavía existen. De las demás usa los del resumen, marcados en el informe como afirmados por el VPS.
- **Hasta cuándo.** Los estadísticos de la familia de una candidata se fijan en su congelación: las búsquedas posteriores no cambian su evaluación. La API rechaza una congelación (`family_pending`) mientras una búsqueda de su familia registrada antes no tenga sus estadísticos calculados, y el motor espera a `research_family_computed` antes de pedirlos.
- **El motor los pide** con `GET /api/v1/investigacion/familias/{busqueda}`, con su credencial (precisión de ADR-0023 §5), para calcular sus filtros con las mismas cifras que usará la API.
- **Lo que no puede comprobar la API.** La métrica de cada fila de una lista la calcula Python en el VPS: la API comprueba sus hashes, sus recuentos y sus sumas, no cada valor. Un VPS comprometido podría bajar `V_val` y aflojar el Sharpe deflactado. Por eso lo que decide es la prueba fuera de muestra, que no depende de ninguna de esas cifras (§7).

### 4. Las correcciones por búsqueda

Una finalista se congela solo si supera todo esto, calculado sobre su repetición en el VPS (paso 3 de §1). La API vuelve a comprobar con su réplica lo que depende de la candidata, en la revisión técnica (§6).

- **Muestra mínima.** En validación, al menos 30 días UTC con horario y al menos 30 operaciones.
- **Sharpe deflactado** (`F2-SEARCH-001`). El de validación, con `N = N_val` y `V = V_val` de su familia (§3), `T` los `r_d` de la ventana, y la asimetría y la curtosis de sus `r_d`, tiene que dar al menos 0,95. Con `N_val = 1` no hay selección, y `SR₀ = 0`. Si el radicando del denominador no es positivo, no está definido, y la finalista no se congela. El de entrenamiento, con `N_train` y `V_train`, se informa como contexto.
- **Costos y latencia** (precisión de ADR-0024 §6). El resultado neto de validación tiene que ser positivo con `cost_scale` de 1,5 y con la latencia de 2000 ms. Las variantes de `cost_scale` 2 y de latencia 0 se informan.
- **Vecinas.** Las vecinas de una finalista son las definiciones que cambian un solo parámetro: un `n`, un 20 % arriba o abajo, redondeado al entero más cercano, con los empates hacia arriba, y al menos en 1; un valor de una lista, como la `k` de `bollinger_pct`, un multiplicador o una duración, al anterior o al siguiente de la lista; y una constante de una condición, un 5 % del ancho de su rango en la búsqueda arriba o abajo. Un valor fuera de su rango no da vecina. Son como mucho 24, las primeras en el orden de los campos de la definición. Se repiten en el mismo recorrido (ADR-0024 §1), y al menos 2 de cada 3 tienen que tener un resultado neto positivo en validación. Una finalista sin ninguna vecina no pasa este filtro sin ellas: el informe lo dice. Es la sensibilidad a los parámetros del protocolo §3.
- **Subventanas.** La validación se parte en tres tramos seguidos con el mismo número de días naturales, el último con los que sobran. El resultado neto tiene que ser positivo en al menos 2. Es la sensibilidad a las ventanas.
- **Sobreajuste de la búsqueda** (PBO). El motor calcula en Python, con NumPy, la probabilidad de sobreajuste de la búsqueda con la validación cruzada combinatoria de 16 bloques seguidos de días de la ventana de entrenamiento, sobre las 50 mejores estructuras distintas, cada una con su mejor juego de parámetros. Dos candidatas tienen la misma estructura si solo cambian sus valores numéricos, porque tras el afinado las mejores suelen ser casi copias, y entre copias el ganador es ruido. Los empates de rango se resuelven por el número de la candidata. Si la PBO pasa de 0,5, la búsqueda no congela nada.
- **Controles negativos** (precisión de ADR-0023 §6). La serie barajada no es un dataset, así que `apps/backtest` no puede recorrerla. En un control, el motor calcula estos mismos filtros con su evaluador de Python, que da las mismas decisiones (ADR-0023 §3), sobre la serie de control y con la familia de su control. Un control aprueba una candidata si una de sus finalistas los pasa. Un solo control así es poco: el Sharpe deflactado de 0,95 deja pasar por azar como mucho un 5 %. Por eso un control falla cuando, en los últimos 20 controles de la versión del motor, o en los que haya si son menos, 4 o más aprobaron alguna: con un 5 %, eso pasa por azar menos de un 2 % de las veces (binomial de 20 con p = 0,05, P(≥ 4) ≈ 1,6 %). Con un control que falla, el motor no congela nada, de ningún mercado, hasta una versión nueva (ADR-0023 §6).
- **Lo que afirma el VPS.** Las vecinas, la PBO y los controles los calcula el VPS, y llegan a la API con la congelación (§5). Solo pueden impedir una congelación, nunca justificarla, y el informe los marca así.
- **White y Hansen.** El «Reality Check» de White y la SPA de Hansen se podrían calcular sobre las series de validación de las finalistas, pero los calcularía el VPS, como la PBO, y solo servirían para impedir, como el Sharpe deflactado, que ya cuenta todas las mediciones en validación de la familia. No se suman: lo que decide es la prueba fuera de muestra de §7.

Si ninguna finalista de una búsqueda pasa, el motor puede congelar como candidata de demostración la de mayor Sharpe diario en validación de un mercado capturado en vivo, marcada «candidata de demostración, sin ventaja demostrada» (`F2-SEARCH-001`). La API la rechaza (`demonstration_pending`) si ya hay otra de demostración esperando su prueba, en `reviewed` o en `shadow`.

### 5. La congelación y el registro previo

- **La congelación** (`ResearchCandidateFreeze`, con F2.8; precisión de ADR-0023 §6). La envía el motor y trae la búsqueda y el número de la candidata; su definición en JCS y su huella; la huella de sus reglas; las repeticiones registradas que cita, por el hash de su `BacktestSpec`; el resultado neto en validación de cada vecina, por su huella; la PBO y el estado de los controles de su búsqueda; el código de su mecanismo; y si es de demostración. La huella de las reglas es el SHA-256 del JCS de la definición sin sus campos de identidad (`strategy_id`, `semantic_version`, `responsible`, `origin` y la descripción; ADR-0022 §1).
- **Lo que comprueba la API.** El contrato; lo de ADR-0023 §6; que las repeticiones están registradas, `completed`, con la paridad en `match` en el entrenamiento y la validación; que la familia tiene sus estadísticos (§3); que el símbolo no tiene ya 10 versiones con la ventana fuera de muestra abierta (`too_many_open`, §7); y que la huella de sus reglas no se congeló nunca antes. Congelar otra vez las mismas reglas, desde otra búsqueda, es un segundo intento de su prueba fuera de muestra (`F2-EVAL-001`): se rechaza y queda en la auditoría (§12).
- **El registro previo** (`StrategyPreRegistration` 1.0.0). La API lo compone con la congelación, que es la petición del motor de la evaluación y de la prueba fuera de muestra (`F2-EVAL-001`), y lo guarda append-only con su hash y su entrada de auditoría. No cambia después. Lo que se fija antes de validar ya está registrado en `ResearchSearchSpec`, con sus ventanas, sus rangos y su métrica, y en esta ADR; lo que se fija antes de la prueba fuera de muestra está aquí. Tiene lo que pide el protocolo §1:
  - **la hipótesis falsable:** «con estas reglas y estos costos, el resultado por operación fuera de muestra es positivo, con la significación de §7»;
  - **el mecanismo:** un código de una lista cerrada, el del patrón del estudio que usa su regla (`hour_of_day`, `day_of_week`, `volatility_regime`, `autocorrelation` o `cross_market`; ADR-0023 §1, paso 2), o `not_identified`. Lo afirma el VPS, y el informe lo muestra tal cual: una regla que encontró una máquina puede no tener un porqué conocido;
  - la estrategia y su versión, su responsable, el universo, la fuente, la serie con sus `dataset_id`, las ventanas en UTC, las reglas y los rangos de su búsqueda;
  - los costos, la latencia y los supuestos de su `BacktestSpec` (ADR-0024 §6);
  - la métrica principal y las auxiliares (§2), y la línea base (§11);
  - los criterios de promoción (§7), de pausa y de retiro (§9);
  - la ventana fuera de muestra, con su fin ya calculado (§7);
  - y si es una candidata de demostración.

### 6. La revisión técnica (`draft` → `reviewed`)

Para una candidata del motor, la revisión técnica del protocolo §4 la hace la API sola, sin esperar a nadie (precisión de ADR-0022 §10):

- la definición es válida y es la de la congelación, con la misma huella;
- el registro previo está completo;
- la réplica de entrenamiento, de validación y de sus cuatro variantes, en el proceso hijo, da los mismos hashes lógicos que las repeticiones registradas del VPS (ADR-0024 §7), y la paridad con Python de las de entrenamiento y validación fue `match`; las variantes van con `not_compared`, porque Python no las corre;
- los filtros de §4 que dependen de la candidata (la muestra mínima, el Sharpe deflactado con los estadísticos de su familia, los costos, la latencia y las subventanas) dan lo mismo con la réplica que con la repetición.

Si se cumple, la API la pasa a `reviewed`, con el sistema como autor. Si no, la retira (`retired`), con su causa, y deja la entrada de auditoría: el propietario la ve en el informe, como cualquier rechazo (protocolo §4).

### 7. La prueba fuera de muestra

- **La ventana** empieza en la hora de la congelación, que registró la API, y dura `D` días naturales: los que tardaría en hacer 60 operaciones al ritmo de su validación (sus operaciones divididas por los días naturales de la ventana de validación), redondeados hacia arriba, con un mínimo de 14 días y un máximo de 56. `D` se calcula y se guarda en el registro previo, antes de ver ningún dato de la ventana. La API comprueba que no se solapa con ninguna ventana de su búsqueda (`F2-EVAL-001`).
- **Su arranque.** `indicators_from_utc` es el principio de la ventana menos el mayor de 7 días y el arranque mínimo de la estrategia (ADR-0024 §7). Son datos anteriores a la congelación, que ya veía el motor.
- **Cuándo corre.** Cuando los datasets publicados y verificados cubren la ventana entera, la API la corre en su proceso hijo, en la cola de §10, para todas las versiones congeladas, no solo para las que pide el motor. Da un solo resultado por versión.
- **Si falla.** Un corte por un despliegue, un reinicio o una señal (`interrupted`) se repite, como mucho tres veces. Un fallo que sale igual cada vez, como `out_of_memory`, `timeout`, `series_not_contiguous` o `log_not_derivable` (ADR-0024 §7), no se repite: la prueba termina como fallida, con su código, y la versión queda como «no validada». Si los datasets de la ventana no están verificados 7 días después de su fin, la versión queda «no validada» con `data_unavailable`. Así un fallo nunca bloquea la cola.
- **La prueba de significación.** Se hace sobre los resultados de cada operación fuera de muestra, en fracción del capital inicial, y no sobre los días, porque en 14 a 56 días hay más operaciones que días. Su Sharpe probabilístico frente a 0, con la fórmula de Bailey y López de Prado, `T` el número de operaciones y su asimetría y su curtosis, tiene que dar al menos `1 − 0,05/10`, es decir 0,995.
- **Por qué 0,995.** Es la corrección de Bonferroni para las 10 versiones de un símbolo que pueden tener la ventana abierta a la vez (§5, `too_many_open`): de cualquier tanda de versiones de un símbolo cuyas ventanas se solapan, la probabilidad de que alguna sin ventaja pase por azar es como mucho de un 5 %, sea cual sea la dependencia entre ellas y aunque el VPS las elija. Repetir las mismas reglas desde otra búsqueda no da otra oportunidad, porque la API lo rechaza (§5).
- **El criterio de promoción**, el mismo para todas, salvo las de demostración:
  - al menos 30 operaciones fuera de muestra: si no, la versión queda como «no validada» por muestra (protocolo §3);
  - el Sharpe probabilístico de sus operaciones, de al menos 0,995;
  - el resultado neto, positivo, con los costos de las cotizaciones;
  - la caída máxima no llega al tope de la estrategia (ADR-0022 §5).
- **El contexto.** El informe da también el Sharpe diario fuera de muestra y la comparación con la validación: con 10 000 remuestreos con reemplazo de las operaciones de validación, cada uno con tantas operaciones como tuvo la ventana, qué fracción suma lo mismo o menos que la ventana. No decide, pero muestra si empeoró.
- **Una candidata de demostración** no tiene criterio de ventaja: su prueba fuera de muestra se corre y se informa igual, y el informe dice que no demuestra nada.
- **El resultado** guarda su `BacktestResult` y su comparación con la validación (§10).

### 8. Los números

- **Dónde.** La estadística de la evidencia es TypeScript (plan §4.7): una biblioteca pura de `apps/backtest`, exportada por la ruta `@buoh/backtest/estadistica`, que usan la API y `buoh-backtest` en el VPS. Python la necesita solo para lo que afirma el VPS: la PBO, con NumPy, y los filtros de los controles (§4).
- **Desde los enteros.** Los `r_d` y los resultados por operación salen de los centavos del resultado (ADR-0024 §10) y se pasan a binario64. Las sumas van en orden cronológico, de izquierda a derecha. Los estadísticos suficientes de las listas son enteros exactos (§2 y §3).
- **Funciones propias.** La exponencial, el logaritmo, la función de distribución de la normal y su inversa se calculan con funciones propias, solo con las operaciones básicas y la raíz cuadrada, en un orden fijo, como los indicadores (ADR-0022 §8): la inversa de la normal con el algoritmo AS 241 de Wichura (PPND16), y la distribución con las aproximaciones racionales de la función de error de Cody. Así dan los mismos bits en cualquier máquina y en cualquier versión de Node, al contrario que `Math.exp` y `Math.log`, que la especificación de ECMAScript no fija bit a bit.
- **El azar.** Los remuestreos usan `xoshiro256**`, con una semilla que sale del SHA-256 de la versión de la estrategia y del nombre de la prueba. El mismo informe se repite byte a byte.
- **La prueba de Poisson** (§9) da su p de dos colas como el doble de la menor de sus dos colas, con un máximo de 1.
- **Lo que se muestra** se redondea a 6 decimales, con redondeo al par.

### 9. La deriva en `shadow`

`F2-POSITION-001` compara lo que hace una estrategia en `shadow` con lo que esperaba su evaluación. La cadencia la fija la ADR del motor `shadow`; la prueba, esta:

- **La base de tiempo** son las horas en que la estrategia estuvo `active` dentro del horario de su mercado, sin sus pausas ni sus detenciones. El ritmo esperado es el de sus operaciones de validación y fuera de muestra por hora dentro del horario.
- **Frecuencia.** Con al menos 72 de esas horas, el número de operaciones frente al que espera ese ritmo, con una prueba de Poisson de dos colas (§8): con p < 0,01, hay deriva.
- **Resultado.** Con al menos 10 operaciones en `shadow`, el remuestreo de §7, con las operaciones de validación y fuera de muestra: si menos del 1 % de los remuestreos suman lo mismo o menos que las de `shadow`, hay deriva.
- **Qué hace.** Una deriva material pausa la estrategia (protocolo §5), con la causa `drift`, y solo vuelve a mano, con la decisión auditada del propietario (`F2-STOP-001`; precisión de ADR-0022 §7 y §10).
- **El criterio de pausa** del registro previo es la deriva y la caída máxima. **El de retiro** lo decide el propietario, y el informe le propone retirar una estrategia pausada dos veces por deriva.

Las pruebas usan un 1 % y no un 5 % porque se repiten con cada evaluación. Las operaciones llegan a veces en rachas, con más varianza que una Poisson, así que las falsas alarmas pueden pasar de ese 1 %: la ADR del motor `shadow` lo mide con su cadencia, en sus vectores, y si hace falta lo corrige.

### 10. Lo que guarda la API y su cola

- **Tablas nuevas** del esquema `buoh_api`, append-only como las demás, de la cuenta de su estrategia (ADR-0019 §4 y §7; precisión de su §7):
  - los estadísticos de cada búsqueda y su consistencia (§3);
  - las congelaciones y los registros previos (§5);
  - los resultados de las réplicas, con su manifiesto (`BacktestResult`, 1 MiB como mucho) y su comparación con la repetición del VPS. Sus partes ya están en `permanente/` de `buoh-investigacion`, escritas por el VPS, y la réplica solo comprueba que salen iguales, así que la API no las guarda de nuevo (precisión de ADR-0024 §9). Si salen distintas, guarda el manifiesto de su réplica, con sus hashes;
  - los resultados fuera de muestra, con su manifiesto y sus partes, que el VPS no tiene, en gzip, 8 MiB como mucho por resultado. Si pasan, la prueba falla con `result_too_large` y se informa;
  - los informes de evidencia (§11), en JCS, de 1 MiB como mucho.
- **Cuánto ocupa.** Con como mucho 56 días y las omisiones agrupadas (ADR-0024 §10), un resultado fuera de muestra son unos cientos de KB, y cada congelación, con sus seis manifiestos de réplica y su informe, alrededor de 1 MB (estimación). Con las 20 congelaciones por semana que permite ADR-0023 §5, alrededor de 1 GB al año; con los techos, hasta unos 19 MB por congelación. La revisión del espacio de la base, a 3 GB (ADR-0021 §6), lo cubre, y el PR 8 lo mide.
- **La cola** del proceso hijo (precisión de ADR-0019 §12) corre de uno en uno los estadísticos de las búsquedas, las réplicas y las pruebas fuera de muestra, en ese orden de prioridad y, dentro de cada uno, por su hora de registro. No vive en memoria: sale de PostgreSQL, de lo registrado que no tiene resultado, así que un despliegue no la pierde. El hijo recibe, además de `buoh_api_lectura` y el token `api`, el token `api-investigacion`, de solo lectura, para las listas (ADR-0023 §7), y nada más.
- **Su carga** (estimación, que mide el PR 8). Leer las listas de un día, de 1 a 3 millones de filas (ADR-0023 §12), ocupa minutos de los 0,5 CPU del Starter; una réplica de un año puede pasar de una hora (ADR-0024, «Consecuencias»); y una prueba fuera de muestra, de como mucho 56 días, minutos.

### 11. El informe de evidencia y la aprobación

- **`EvidenceReport` 1.0.0.** La API lo compone después de la prueba fuera de muestra. Trae todas las métricas del protocolo §3: las del backtest (ADR-0024 §10) de entrenamiento, validación y fuera de muestra; el Sharpe diario, su Sharpe deflactado y lo que lo calcula; el Sharpe probabilístico fuera de muestra y su umbral; la línea base; las variantes, las vecinas y las subventanas; la PBO, los controles y el mecanismo, marcados como afirmados por el VPS; cuántas candidatas probó la familia y cuántas se congelaron, cada una con su resultado fuera de muestra o con que todavía lo espera (`F2-EVAL-001`); el registro previo; y las limitaciones y los supuestos.
- **La línea base.** «No operar», que da 0, y el costo de operar sin ventaja: el resultado esperado de las mismas operaciones con un precio sin tendencia, que es menos su comisión en un multiplicador y `(1 − e) · pago / 2 − apuesta` en un sube/baja, con `e` la fracción de empates de sus propias operaciones, porque un empate pierde (ADR-0022 §5). Se calcula con las cotizaciones de cada posición, sin otra pasada por los datos, y es una aproximación declarada.
- **«No validada».** Una versión sin muestra, costos, línea base o prueba fuera de muestra sale como «no validada» (protocolo §3), y el informe lo dice arriba.
- **La aprobación.** En la sección Laboratorio, el propietario ve el informe, cada cifra con su contexto (concepto de interfaz §1 y §4), y aprueba o rechaza la versión, con una confirmación explícita y un motivo si la rechaza. Solo puede aprobar una que superó su criterio de promoción, o una de demostración, que la web marca así en cada pantalla. Aprobar crea la versión de `shadow` (ADR-0022 §10); rechazar la retira.

### 12. La auditoría

Acciones nuevas de `AuditEvent` (precisión de ADR-0019 §5), con sus objetos por su identificador o su hash:

| Acción | Autor | Motivos | Objetos |
|---|---|---|---|
| `research_family_computed` | el sistema | `consistent` o `inconsistent` | la cuenta, la búsqueda y sus estadísticos |
| `research_candidate_frozen` (ADR-0023 §5) | el motor | `frozen` o `demonstration` | la cuenta, la búsqueda, la congelación, la versión y su registro previo |
| `research_freeze_rejected` | el motor | `already_frozen`, `family_pending`, `too_many_open` o `demonstration_pending` | la cuenta, la búsqueda y la huella de las reglas |
| `strategy_reviewed` | el sistema | `passed`, o `failed` con su código | la cuenta, la versión, su réplica y su registro previo |
| `oos_test_completed` | el sistema | `passed`, `failed`, `not_validated` o `demonstration`, con su código si no se completó | la cuenta, la versión y su resultado |
| `strategy_drift_detected` | el sistema | `frequency` o `result` | la cuenta y la versión; llega con F2.10 |
| `strategy_promoted` | la cuenta | `approved`, con el texto del propietario si lo escribe | la versión congelada, la de `shadow` y el informe |
| `strategy_rejected` | la cuenta | `rejected`, con su texto | la versión y el informe |

`research_freeze_rejected` con `already_frozen` es el segundo intento rechazado de `F2-EVAL-001`. Los cambios de ciclo de vida que provocan estas acciones son los eventos del registro de estrategias de ADR-0022 §10.

### 13. El protocolo de validación

En el mismo PR, el [protocolo de validación](../../gobierno/protocolo-de-validacion-de-estrategias.md) cambia así:

- **§1:** para una candidata del motor de investigación, la API compone el registro previo al congelarla (§5). Su hipótesis falsable es la predicción fuera de muestra registrada, y su mecanismo puede ser «no identificado», que el informe muestra.
- **§3:** las reglas medibles, con los umbrales, están en esta ADR.
- **§4:** para una candidata del motor, la revisión técnica de `draft` → `reviewed` la hace la API sola, con su réplica (§6).

### 14. Pruebas

- **La biblioteca** (§8), sin red, reloj real ni azar sin semilla, como `F1-VECTOR-001`: vectores con los bits de la exponencial, el logaritmo, la normal y su inversa, también en las colas; el Sharpe diario, sus momentos y el Sharpe deflactado con el ejemplo numérico de Bailey y López de Prado, también con el radicando en 0; el Sharpe probabilístico por operación; el remuestreo con su semilla; la prueba de Poisson y su p de dos colas; y la binomial de los controles.
- **Python**, en `research/python`: la PBO con un ejemplo de resultado conocido y con estructuras casi iguales; el generador de vecinas, también con `n` de 1 y 2 y sin ninguna vecina; los estadísticos suficientes, iguales en millonésimas a los de TypeScript; y los filtros de un control, iguales a los de TypeScript en los vectores compartidos.
- **La evaluación**, con vectores sintéticos en `test-vectors/`: una estrategia que gana en entrenamiento y pierde fuera de muestra produce exactamente ese informe (`F2-EVAL-001`); un vector sin patrón no congela nada, y uno con un patrón sembrado sí (`F2-SEARCH-001`); cada filtro de §4, en el borde; un control que falla con 4 de 20; una búsqueda inconsistente y una familia pendiente; una ventana fuera de muestra de 14, de `D` y de 56 días; una con menos de 30 operaciones; una que pasa el umbral de 0,995 y una que no; una candidata de demostración; las mismas reglas congeladas otra vez; y la deriva por frecuencia y por resultado, con su base de tiempo.
- **La API**, sin red y con PostgreSQL local, como ADR-0019 §13: los estadísticos desde las listas, con sus techos y sus sumas exactas; `N_val` desde lo registrado; la congelación, sus rechazos y su registro previo; la revisión técnica con una réplica que coincide y una que no; la cola que sale de PostgreSQL, un hijo cortado que se repite y un fallo determinista que no; las tablas append-only (`42501`); las entradas de auditoría; que solo se aprueba lo que pasó o lo de demostración; y el OpenAPI.

### 15. Secuencia de entrega

El código de F2.8 empieza cuando están fusionadas las cinco ADR del laboratorio (plan §8) y lo que cita cada PR. Antes, por la precisión de ADR-0023 §14 de §3, el PR 3 de ADR-0023 trae `validation_finalists` y los estadísticos y la PBO del resumen en sus contratos, y su PR 4, su cálculo en Python. Ocho PR:

1. Esta ADR, con el protocolo de validación y sus precisiones al plan de Fase 2, a `PROJECT_STATUS.md`, a ADR-0019, ADR-0022, ADR-0023 y ADR-0024, a los contratos de dominio y al `README.md`.
2. **La biblioteca estadística** en `apps/backtest`, con sus vectores, después del PR 4 de ADR-0024.
3. **Los contratos** `StrategyPreRegistration`, `ResearchFamilyStats`, `EvidenceReport` y `ResearchCandidateFreeze`, con los campos de §5, con su JSON Schema y su semántica en los contratos de dominio.
4. **La familia, la cola y la congelación en la API**, después del PR 3 de ADR-0023 y del PR 5 de ADR-0024: la cola del proceso hijo de §10, los estadísticos desde las listas, también de las búsquedas ya registradas, `GET /api/v1/investigacion/familias/{busqueda}`, `POST /api/v1/investigacion/congelaciones` con sus comprobaciones y su registro previo, sus tablas, su auditoría y su OpenAPI.
5. **La réplica, la revisión técnica y la prueba fuera de muestra** en la API: el guardado de §10, `draft` → `reviewed`, la ventana y su prueba, y el informe.
6. **Los filtros en el VPS**, después del PR 4 de ADR-0023: los encargos de `buoh-backtest` con las vecinas y la estadística, la PBO y los filtros de los controles en Python, la regla de los controles y la candidata de demostración.
7. **El informe y la aprobación** en la sección Laboratorio, con su confirmación, que crea la versión de `shadow` (ADR-0022 §10).
8. **La evidencia**: las primeras congelaciones, réplicas y pruebas fuera de muestra en producción, la duración y la memoria del proceso hijo en Render, el espacio de §10 y las comprobaciones de §14. Con ella, F2.8 está hecho.

### Relación con ADR anteriores

- **ADR-0019:** §5 suma las acciones de §12; §7, las tablas de §10; §12, la cola de §10, con el token `api-investigacion`, y que un `interrupted` se repite y los demás fallos no.
- **ADR-0022:** §7 y §10, la pausa por deriva, que vuelve a mano (§9); §10, la revisión técnica de una candidata del motor la hace la API (§6).
- **ADR-0023:** §2, SciPy no hace falta; §5, la ruta de la familia; §6, la métrica principal, `validation_finalists`, los estadísticos del resumen, la familia, los controles, la PBO y la congelación; §14, esos campos con sus PR 3 y 4.
- **ADR-0024:** §6, las variantes que hay que superar; §9, dónde guarda la API la réplica.

## Consecuencias

- Una estrategia necesita al menos 14 días de datos nuevos antes de llegar al propietario, y hasta 56 si opera poco. Con los 7 días de `shadow` de la puerta de salida, el final de la Fase 2 queda al menos unas 3 semanas después de la primera congelación.
- La prueba fuera de muestra exige mucho: con 30 operaciones, un Sharpe por operación de alrededor de 0,5, y con 60, de unos 0,35 (con resultados normales). Es probable que ninguna estrategia real lo demuestre en la Fase 2, y entonces la puerta de salida usa una de demostración, como prevé el plan. Es el precio de que el VPS no pueda hacer pasar estrategias por azar.
- La API recalcula los recuentos y las sumas desde las listas, pero no cada métrica: un VPS comprometido podría aflojar los filtros previos. No llega a la aprobación, porque la decide la prueba fuera de muestra.
- La PBO, las vecinas, los controles y el mecanismo los afirma el VPS: solo pueden impedir una congelación.
- Las pruebas de deriva al 1 % tardan en detectar un deterioro pequeño: con pocas operaciones, solo ven los grandes.
- La biblioteca estadística no usa `Math.exp` ni `Math.log`: más código propio, a cambio de los mismos bits en cualquier máquina.

## Alternativas descartadas

| Alternativa | Por qué no |
|---|---|
| El Sharpe deflactado con todas las pruebas de entrenamiento | Mide la selección sobre datos que la validación ya deja fuera; se informa como contexto. |
| White o Hansen como filtro | Los calcularía el VPS, como la PBO, y solo podrían impedir, como el Sharpe deflactado; no suman a la prueba fuera de muestra. |
| La PBO como evidencia | Necesita el rendimiento de muchas configuraciones por bloques, que la API no puede repetir en su Starter. |
| Solo pedir un resultado neto positivo fuera de muestra | Una candidata sin ventaja lo consigue a menudo por azar, y con muchas congelaciones el propietario vería varias «aprobadas» cada semana. |
| Corregir por las versiones que de verdad se solapan | Ese número cambia después de la prueba de cada una; con el tope de 10 y un umbral fijo, la corrección vale siempre. |
| Terminar la ventana al llegar a un número de operaciones | Habría que correr la estrategia sobre la ventana para saber cuándo termina, y la prueba fuera de muestra se corre una vez; `D` se fija antes con el ritmo de la validación. |
| Que el VPS calcule la evidencia | Un VPS comprometido podría fabricarla (plan §4.7). |
| `Math.exp` y `Math.log` | ECMAScript no los fija bit a bit, y el informe tiene que repetirse igual. |
| SciPy en el motor | La PBO cabe en NumPy, y la estadística de la evidencia es TypeScript. |
| Pruebas de deriva al 5 % | Se repiten en cada evaluación: pausarían por azar una estrategia sana. |

## Condiciones de revisión

- Ninguna candidata real pasa en varias semanas de búsqueda: revisar con el propietario si conviene alargar la ventana fuera de muestra, sin bajar su umbral.
- Los controles fallan a menudo, o nunca aprueban nada.
- Una deriva pausa estrategias que, vistas después, estaban sanas.
- La cola del proceso hijo tiene trabajo pendiente de más de 24 horas.
- Las tablas de §10 pasan de 500 MB.
- Llega la inteligencia artificial, con otra forma de buscar.

## Referencias verificadas

Consultadas el 2026-11-17:

- D. H. Bailey y M. López de Prado, «The Deflated Sharpe Ratio: Correcting for Selection Bias, Backtest Overfitting and Non-Normality», *Journal of Portfolio Management*, 2014 ([SSRN 2460551](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2460551); [PDF del autor](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf)).
- D. H. Bailey, J. M. Borwein, M. López de Prado y Q. J. Zhu, «The Probability of Backtest Overfitting», *Journal of Computational Finance* ([PDF del autor](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf); [SSRN 2326253](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2326253)).
- H. White, «A Reality Check for Data Snooping», *Econometrica* 68 (2000), y P. R. Hansen, «A Test for Superior Predictive Ability», *Journal of Business & Economic Statistics* 23 (2005).
- M. J. Wichura, «Algorithm AS 241: The Percentage Points of the Normal Distribution», *Applied Statistics* 37 (1988) ([copia](https://csg.sph.umich.edu/abecasis/gas_power_calculator/algorithm-as-241-the-percentage-points-of-the-normal-distribution.pdf); [implementación de referencia](https://people.math.sc.edu/Burkardt/c_src/asa241/asa241.html)).
- W. J. Cody, «Rational Chebyshev Approximations for the Error Function», *Mathematics of Computation* 23 (1969).
- En el repositorio: el [protocolo de validación](../../gobierno/protocolo-de-validacion-de-estrategias.md), [seguridad y rigor](../../gobierno/seguridad-y-rigor-cuantitativo.md) §2 y §3, el [plan de Fase 2](../../plan/fase-2-laboratorio-y-bot-shadow.md) (`F2-SEARCH-001`, `F2-EVAL-001` y `F2-POSITION-001`) y las ADR 0019, 0021, 0022, 0023 y 0024.

El contenido de fuentes externas fue reformulado para cumplir restricciones de licencia.
