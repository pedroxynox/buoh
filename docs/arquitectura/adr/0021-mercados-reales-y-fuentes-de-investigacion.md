# ADR-0021: Mercados reales y fuentes de investigación (F2.5b)

- **Estado:** Aceptada
- **Fecha:** 2026-11-16
- **Ámbito:** Fase 2, incremento F2.5b (`F2-MARKET-001` del [plan de Fase 2](../../plan/fase-2-laboratorio-y-bot-shadow.md), §8, punto 9). Fija también lo que toman de ella F2.6 y F2.7 (las velas, los ticks de la historia y lo que cobra Deriv como datos del backtest) y F2.9 (los horarios de cada mercado, `F2-STOP-001`).
- **Decisores:** Propietario de buoh (los mercados, guardar la historia, el disco de 5 GB y el presupuesto, decididos el 2026-11-16; plan §12), a propuesta de la dirección técnica (lo demás).
- **Complementa:** [ADR-0004](0004-pipeline-y-reproduccion-de-datos-fase-1.md), con una fuente nueva y datos que no son ticks (§3 y §4); [ADR-0012](0012-catalogo-y-adaptador-publico-de-deriv.md) §2, con los esquemas de `trading_times` y `proposal` (§4); [ADR-0018](0018-sistema-de-datos-en-produccion.md) §2 (el disco y el comando de `ingest`), §6 (una secuencia de logs por símbolo), §7 (los umbrales de revisión del espacio), §8 y §11 (el paso nuevo de `buoh-operaciones`); [ADR-0019](0019-api-cuentas-y-auditoria.md) §8 (las publicaciones de la Auditoría, §5); y [ADR-0020](0020-datasets-vivos.md) §1 (los umbrales del oro, §2), §4 (un perfil por log, §1), §6 (la retención de los datasets nuevos y su revisión, §6) y §7 (el tamaño de los datasets de la historia, §4).

## Resumen para el propietario

- **Qué decide.** Cómo entran en buoh el oro en vivo, un año de historia de Deriv y lo que cobra Deriv por sus contratos, para que el motor de investigación tenga con qué estudiar.
- **El oro en vivo.** Se captura como R_100, en su propia serie de cuadernos semanales (logs), en el mismo servidor. Si el servidor no aguanta los dos, el oro necesita uno propio, de 7 USD al mes, y te lo pregunto antes.
- **La historia.** buoh descarga, poco a poco, un año de ticks de R_100 y del oro, un año de velas de 1 minuto de los siete mercados y los horarios de cada día. Se guardan para siempre, solo para tu uso.
- **Lo que cobra Deriv.** Cada 15 minutos, buoh pregunta cuánto paga un sube/baja y cuánto cobra un multiplicador en cada mercado, y lo guarda. Sin eso, el motor no puede saber si una estrategia gana después de los costos.
- **Costo.** El disco de la base pasa a 5 GB (1,20 USD más al mes, aprobado) y R2 queda en unos 13,50 USD al mes, como ya estaba previsto. Total: unos 51 USD al mes.
- **Riesgo.** Nada de esto opera ni usa una cuenta de Deriv. El almacenamiento en R2 llegará a 8 GB en meses, no en años, y ahí revisamos juntos cuánto se guarda.
- **Qué apruebas al fusionarla.** Todo lo de arriba, y el orden de ocho PR de §9.

## Contexto

El 2026-11-16 el propietario decidió que un motor de investigación busque las estrategias, que buoh opere primero en Deriv con multiplicadores y sube/baja, que se capturen en vivo R_100 y el oro, que el motor estudie con un año de velas el oro, la plata, el EUR/USD, el GBP/USD, el USD/JPY, Bitcoin y Ethereum, y que la historia de Deriv se guarde todo el tiempo, para uso propio (`PROJECT_STATUS.md`, «Motor de investigación»). Aprobó también el disco de 5 GB («Disco, VPS y reanudación»). El plan de Fase 2 lo recoge en `F2-MARKET-001` y pone esta ADR antes del código de F2.5b (§8, punto 9).

Lo que el código supone hoy (análisis del repositorio en `main`, `b2f5797`):

- **Un símbolo por captura.** `ingest` recibe un solo `--symbol`, fijo en `render-datos.yaml` (`--live --symbol R_100`), y la conexión de Deriv se suscribe a un solo símbolo y recupera la historia de uno solo (`deriv/connection.ts`).
- **Un bloqueo por fuente.** La clave del bloqueo es `buoh:source-log:<fuente>` (`postgres/source-lock.ts`), para toda la base. Un segundo `ingest` de la misma fuente espera ese bloqueo sin fin, y aunque lo tomara, elegiría el mismo log activo, porque la última escritura se busca por fuente (`postgres/successive-logs.ts`), y fallaría con `symbol_mismatch`.
- **Un perfil por log, de un símbolo.** `log_quality_profile` admite una fila (ADR-0020 §4), y `buoh-operaciones` le pone siempre la de R_100 (`deriv/log-profile.ts`, `LOG_PROFILE_SYMBOL`). El dominio sí admite varios símbolos en un perfil, pero sus umbrales son únicos por perfil.
- **Nada sabe de horarios.** No hay ningún temporizador de inactividad de ticks ni ninguna petición `trading_times`. Un silencio dentro de una conexión no abre ninguna condición; un corte durante un mercado cerrado deja la continuidad pendiente hasta el primer tick.
- **La historia solo repara huecos.** `ticks_history` entra como respuesta pedida para cerrar un hueco de la captura, y las reglas 3.0.0 solo convierten en `MarketTick` los ticks de un resultado `complete` que resuelve ese hueco (ADR-0020 §3). No hay contrato de vela ni de cotización de contrato.
- **El disco es de 1 GB** (`diskSizeGB: 1`), y la revisión del espacio está en 600 MB de base y 700 MB de disco (ADR-0018 §7).

## Medición

Consultas de solo lectura al canal público de Deriv, el 2026-11-16, de las 03:40 a las 11:35 UTC, sin guardar precios (los mercados, los tipos de contrato y la historia de velas y de ticks están en el plan, §3):

- **Ritmo.** El oro mandó 120 ticks en 120 s, y R_100, 61.
- **Horarios** (`trading_times`). El lunes, el oro cotiza de 00:00 a 22:00 y de 23:00 a 23:59:59 UTC; el sábado 2026-11-14 no cotizó. El EUR/USD cotiza todo el lunes y tampoco el sábado. Bitcoin cotizó el sábado. Un día pasado se puede pedir por su fecha.
- **Páginas de historia.** Con `count` de 5000 o de 10 000, `ticks_history` devolvió 1000 ticks del oro, unos 19,2 KB. Una página de velas de 1 minuto trajo 940, unos 76 KB.
- **Cotizaciones** (`proposal`, sin cuenta). Responden en unos 600 a 900 bytes. El oro solo acepta multiplicadores de 50, 100, 150, 250 y 500.

## Decisión

### 1. Una secuencia de logs por símbolo

Cada símbolo capturado en vivo tiene su propia secuencia de logs, con su esquema, su prefijo, su bloqueo, su log activo, su corte semanal y su vencimiento a los 30 días, como la de hoy (ADR-0018 §6 y §7). Dos símbolos nunca comparten un log, así que cada log sigue con un perfil de un solo símbolo (ADR-0020 §4).

- **R_100 conserva su secuencia** tal como está: los mismos nombres de esquema y de prefijo y la misma clave de bloqueo. Nada de lo ya guardado cambia.
- **El oro tiene la suya**, con el símbolo en el nombre del esquema, en el prefijo de R2 y en la clave del bloqueo. Su PR fija los nombres exactos.
- **`buoh-operaciones`** prepara, mide, corta y borra cada secuencia por separado, y da a cada log nuevo la fila de perfil de su símbolo. `data:health` se ejecuta para cada secuencia, con su `--symbol`, y guarda su informe en el log de esa secuencia.
- **Un solo proceso `ingest`** captura los dos símbolos, con una sesión, una conexión y un bloqueo por símbolo: `--symbol` se puede repetir. Una sesión que cae no corta la otra. El PR 2 mide la memoria con dos sesiones, como ADR-0017 §9; si el máximo pasa de 256 MiB, la mitad del Starter (`F2-DEPLOY-001`), el oro va a su propio background worker, unos 7 USD más al mes, y el agente pide antes el visto bueno del propietario.

### 2. El oro empieza con el perfil de medición

El oro se captura con el perfil de medición, `deriv_options-measurement-v2-frxXAUUSD`, sin publicar datasets vivos, como R_100 entre ADR-0018 y ADR-0020. Con al menos 7 días de esa captura, el PR 7 fija sus umbrales con la regla de ADR-0020 §1 y su script de medición, en un perfil de publicación propio, y el estado vivo del oro pasa a él en el corte siguiente de su secuencia, como R_100 con el PR 5 de ADR-0020. Desde ahí se publican sus datasets.

**Mercado cerrado.** La captura no cambia su derivación: un silencio dentro de una conexión sigue sin abrir condiciones, y un corte con el mercado cerrado deja la continuidad pendiente hasta el primer tick, con la salud en `recovering`. Lo que distingue un mercado cerrado de un fallo es el horario guardado de cada día (§3): lo usa el motor `shadow`, que fuera del horario no decide ni se detiene (`F2-STOP-001`), y lo usa la evidencia para explicar la salud del oro. La salud no cambia de contrato.

### 3. Una fuente nueva, por lotes

Lo que no llega por la suscripción en vivo entra por una fuente propia, `deriv_lotes`: el mismo canal público de Deriv, sin cuenta, pero con peticiones sueltas en lugar de una suscripción. Tiene su conector, su perfil, su secuencia de logs y su bloqueo, como cualquier fuente (ADR-0007 §1), así que no toca la captura en vivo ni sus perfiles.

- **Raw primero.** Cada respuesta se guarda como `RawSourceFrame`, con su texto exacto y su hash, antes de normalizarla (ADR-0004). Lo derivado se regenera desde ahí.
- **Qué recoge:**
  - **horarios:** `trading_times` del día siguiente, una vez al día, y el de cada día del último año en la descarga de la historia (§4);
  - **lo que cobra Deriv:** cada 15 minutos, en cada mercado de `F2-MARKET-001` y en R_100, `proposal` con una apuesta fija de 10 USD de `MULTUP` con cada multiplicador que acepte ese mercado, y de `CALL` y `PUT` en las duraciones de una lista fija que ofrezca ese mercado (5 ticks y 1, 5, 15 y 60 minutos), como mucho unas 120 peticiones. La lista y la apuesta van en el perfil, y cambiarlas crea otro perfil;
  - **velas:** las de 1 minuto del día anterior de los siete mercados, una vez al día.
- **Dónde corre.** En `buoh-operaciones`, como un paso nuevo, en un proceso aparte con un rol de PostgreSQL que solo inserta en los logs de esta fuente y con un token de R2 de escritura, como los demás pasos (ADR-0018 §11). Ese proceso no recibe la credencial dueña ni la de otros roles. Su PR fija el rol, con su prueba de `42501`, y el plazo del paso dentro de cada ejecución.
- **Ritmo con Deriv.** Una petición a la vez, por una sola conexión. Si Deriv responde con un límite de peticiones, el paso para y la ejecución siguiente sigue donde quedó.
- **Datasets.** Sus logs se publican como datasets que no vencen (§6), con los mismos pasos 6 y 7 de `buoh-operaciones` (ADR-0020 §8): uno por día de cotizaciones, y los de velas y de la historia por tramos (§4).

### 4. Contratos y la historia de un año

**Contratos nuevos**, en `packages/contracts`, con su JSON Schema y su semántica en los [contratos de dominio](../contratos-de-dominio.md):

- **`MarketCandle`:** una vela de Deriv (apertura, máximo, mínimo y cierre en decimal canónico, su hora UTC y su intervalo), con la procedencia de `MarketTick`. Son velas que calcula Deriv: nunca se mezclan con las que buoh arma con sus ticks, y una estrategia declara cuáles usa (ADR del modelo de estrategia).
- **`ContractQuote`:** lo que Deriv ofrecía por un contrato en un instante: tipo, símbolo, apuesta, duración o multiplicador, precio, pago o comisión, y la hora UTC de la cotización.
- **`TradingSession`:** los intervalos de un día en que un símbolo cotiza, en UTC.
- **`MarketTick`** suma un origen, el de los ticks de la descarga de la historia, aparte de `stream` y `history_recovery`. Un tick de ese origen no tiene retraso de entrega, porque se recibe mucho después de su hora.
- Los roles de los artefactos de un dataset suman los de esos datos. Las reglas de calidad de la fuente por lotes son un conjunto propio, con sus vectores sintéticos. Cada cambio de contrato sube su versión según los contratos de dominio.

**La descarga de la historia.** `buoh-operaciones` la hace por partes en cada ejecución, hasta completarla:

- un año de ticks de R_100 y del oro, por tramos contiguos que no se solapan, pedidos con `start` y `end`; cada página trae hasta 1000 ticks;
- un año de velas de 1 minuto de los siete mercados, y el horario de cada día de ese año;
- como mucho unas 100 páginas por ejecución, así que la descarga tarda unos pocos días (estimación).

Un tramo sin ticks, o con menos de los esperados, dentro del horario de su mercado queda como incidencia: nunca se rellena. Un tick repetido entre páginas es una incidencia, y el primero cuenta. Cada dataset de la historia tiene como mucho 16 páginas, unos 16 000 ticks, para quedar dentro de la memoria medida en ADR-0020 §7.

Así, para R_100 y el oro, el backtest y el motor `shadow` usan los mismos datos, ticks y lo que buoh arme con ellos (plan §4.1). Para los otros cinco mercados solo hay velas: el motor de investigación informa lo que encuentre, pero no los propone para `shadow` (`F2-RESEARCH-001`).

### 5. Lo que cambia en las pantallas y la Auditoría

- La API y la web siguen mostrando R_100. Mostrar el oro es un PR pequeño de `apps/api` y `apps/web`, que no pide `F2-MARKET-001`.
- La Auditoría muestra las 200 publicaciones más recientes (ADR-0019 §8). La descarga de la historia publica unos 2500 datasets en pocos días y las taparía: el PR 6 hace que la Auditoría las agrupe o las filtre, con una precisión de ADR-0019 §8.

### 6. Espacio, retención y costo

Estimaciones, que los PR miden:

- **PostgreSQL.** El oro manda un evento por segundo mientras cotiza, unos 59 000 al día de media, así que su secuencia ocupa unos 16 MB por log y por día, unos 0,6 GB con 38 días, como ADR-0018 §7. Con R_100 (0,55 GB), la fuente por lotes (unos 3 MB al día) y las filas de los datasets nuevos, la base queda en unos 1,4 GB. El disco pasa de 1 a 5 GB antes de capturar el oro, como aprobó el propietario, y la revisión de ADR-0018 §7 y de ADR-0020 §6 pasa de 600 MB de base y 700 MB de disco a 3 GB y 3,5 GB.
- **R2, escrituras.** Unos 1,35 millones de clase A al mes de R_100, unos 1,8 del oro y unos 0,35 de las cotizaciones: unos 3,5 millones, de los que R2 cobra 3 millones, unos 13,50 USD al mes, la cifra del plan §11. La historia suma unas 45 000, una vez.
- **R2, espacio.** La historia de ticks ocupa unos 4 GB, casi todo en los ticks normalizados en gzip (unos 100 bytes por tick, ADR-0020, «Medición»), y la de velas unos 100 MB. Con los logs de 30 días de las dos secuencias, unos 3 GB, R2 llega a unos 7 a 8 GB en pocos meses: la revisión de ADR-0020 §6 con el propietario, a los 8 GB, llega en meses y no en dos años. R2 cobra el espacio por encima de 10 GB, a 0,015 USD por GB al mes (ADR-0016).
- **Retención.** Los logs de la fuente por lotes vencen a los 30 días, como los demás. Los datasets que salen de ellos no vencen, como decidió el propietario para la historia de Deriv («Motor de investigación»), con la misma revisión de ADR-0020 §6.
- **Total.** Unos 51 USD al mes con el disco, lo aprobado (plan §11).

### 7. Términos de Deriv

Los términos de la API de Deriv solo permiten tener sus datos en caché 24 horas, y el propietario aceptó guardarlos todo el tiempo, para uso propio («Motor de investigación»). La redistribución sigue deshabilitada (ADR-0004 §13): nada de esto sale de buoh, y ningún precio, cotización ni vela entra en Git.

### 8. Pruebas

- **Secuencias por símbolo:** con PostgreSQL y almacenamiento locales, dos sesiones de `ingest` en un proceso, cada una con su log, su bloqueo y su corte; que R_100 conserva sus nombres y su clave; que una sesión que cae no corta la otra; y que `buoh-operaciones` da a cada log el perfil de su símbolo.
- **Fuente por lotes:** el raw primero, las reglas con sus vectores sintéticos (un tramo vacío dentro del horario, un tick repetido, una respuesta de error, un límite de peticiones), el rol que solo inserta, con `42501`, y `data:replay` de un dataset de cada tipo en los dos modos.
- **Sin red, reloj real ni azar** en las pruebas offline, como `F1-VECTOR-001`. Ninguna prueba se conecta a Deriv.

### 9. Secuencia de entrega

El código empieza después del PR 6 de ADR-0020 (plan §9). Ocho PR:

1. Esta ADR, con sus precisiones al plan de Fase 2 y a `PROJECT_STATUS.md`.
2. Las secuencias por símbolo en el worker y en `buoh-operaciones`, y `ingest` con varias sesiones, con la medición de memoria de §1. No cambia lo que se captura.
3. El oro en producción: el disco de 5 GB y `--symbol frxXAUUSD` en `render-datos.yaml`, con su prueba, y los pasos del runbook. Se fusiona fuera de la rotación de la credencial dueña, que pide no tener abierto ningún PR que cambie `render-datos.yaml` (runbook de ingesta, «Rotar credenciales»).
4. Los contratos de §4 y las reglas de la fuente por lotes, con sus vectores y los esquemas de `trading_times` y `proposal` de la release fijada de Deriv. No cambia producción.
5. El paso de recolección de `buoh-operaciones` y la publicación de sus datasets.
6. La descarga de la historia, y la Auditoría que agrupa sus publicaciones.
7. Los umbrales del oro, con al menos 7 días de su captura, y su perfil de publicación.
8. La evidencia: lo capturado, lo descargado, la memoria, el espacio y el costo medidos. Con ella, F2.5b está hecho.

## Consecuencias

- El motor de investigación tiene desde el principio un año de datos de ocho mercados y lo que cuesta cada contrato desde que se empieza a guardar. Para el tiempo anterior, el backtest declara el costo medido al empezar, con su sensibilidad (`F2-MARKET-001`).
- La captura en vivo de R_100 no cambia de nombres, de bloqueo ni de perfil.
- `buoh-operaciones` hace más trabajo en cada ejecución; su plazo de 5 minutos se mide en el PR 5 y el PR 6.
- El oro puede necesitar su propio servidor si la memoria no alcanza (§1).
- La revisión del espacio de R2 con el propietario llega antes (§6).

## Alternativas descartadas

| Alternativa | Por qué no |
|---|---|
| Los dos símbolos en un mismo log | Un log tiene un perfil y unos umbrales (ADR-0020 §4), y R_100 ya tiene el de publicación mientras el oro necesita el de medición. Además la salud, la vigilancia de huecos y la recuperación suponen un símbolo. |
| Un worker propio para el oro desde el principio | Cuesta unos 7 USD al mes que quizá no hacen falta: se elige solo si la memoria lo pide (§1). |
| Pedir horarios y cotizaciones dentro de la captura en vivo | Cambia el conector y el perfil de R_100, y obliga a un corte y a otro perfil de publicación. |
| Solo velas armadas por buoh, sin historia | El motor esperaría meses para tener un año de datos. |
| Un proveedor de datos de pago | Sus precios no son los de Deriv, donde se opera, y suma un costo y unos términos nuevos. |
| El oro por MetaTrader 5 | Necesita la terminal encendida todo el día; queda para la Fase 1B, como decidió el propietario. |

## Condiciones de revisión

- La memoria de `ingest` con dos sesiones pasa de 256 MiB (§1).
- R2 pasa de 8 GB, o la base de 3 GB (§6).
- Deriv limita las peticiones de la fuente por lotes, cambia la historia que da o deja de dar cotizaciones sin cuenta.
- Los ticks del oro dejan de llegar a un ritmo regular, lo que cambia cómo se miden sus umbrales.
- El propietario suma o quita un mercado.

## Referencias verificadas

- [Deriv: `ticks_history`](https://developers.deriv.com/llms/ticks-history.md), [`trading_times`](https://developers.deriv.com/llms/trading-times.md), [`proposal`](https://developers.deriv.com/llms/proposal.md) y [`contracts_for`](https://developers.deriv.com/llms/contracts-for.md), consultadas el 2026-11-16.
- Medición del 2026-11-16 (§«Medición»), con scripts fuera del repositorio que no guardaron precios.
