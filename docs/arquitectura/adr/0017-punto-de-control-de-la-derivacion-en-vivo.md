# ADR-0017: Punto de control de la derivación en vivo

- **Estado:** Aceptada
- **Fecha:** 2026-10-30
- **Ámbito:** Fase 2, incremento F2.1 (`F2-CHECKPOINT-001` y `F2-GOV-001` del [plan de Fase 2](../../plan/fase-2-laboratorio-y-bot-shadow.md))
- **Decisores:** Dirección técnica de buoh. El plan de la Fase 2 no pide al propietario ninguna decisión para F2.1 (§12).
- **Complementa:** [ADR-0015](0015-reconexion-recuperacion-y-salud-f1-5.md) §3, §4, §5 y §8, cuyos lectores parten ahora de un punto de control (§5 lo dejaba para antes de ingerir durante semanas), y sustituye para el estado vivo la frase de su «Relación con ADR-0005» sobre derivar el estado entero sin guardarlo; [ADR-0005](0005-persistencia-local-y-formato-fisico-f1-3.md) §4, que dejaba diferida la calidad incremental en vivo; y la condición «Memoria» de [ADR-0016](0016-alojamiento-del-sistema-de-datos.md) §4. No cambia [ADR-0004](0004-pipeline-y-reproduccion-de-datos-fase-1.md) §9: los datasets y el replay siguen igual.

## Contexto

Cuatro lectores leen el log durable entero de una fuente con `readDurableSegments`, y tres de ellos lo derivan con `deriveMarketData`:

1. el arranque de la sesión de ingesta (`SessionRun.#openLog` y `checkLog`), al empezar y después de cada fallo de lectura del log;
2. la reparación de un cierre no registrado (`RawFirstIngestor.repairUnrecordedClose`), antes de cada socket de una reconexión, que no deriva: solo calcula `previousConnection`;
3. la vigilancia de un hueco (`SessionRun.#watchGap`), que vuelve a derivar el log con cada tick durable posterior al high-watermark del hueco;
4. `data:health` (`readLog` en `src/health/observe.ts`), en cada ejecución.

`readDurableSegments` devuelve todos los source events, ya validados, y vuelve a leer y verificar el objeto de cada segmento cerrado. La derivación los vuelve a validar, guarda todos los ticks y todas las incidencias, y al final ordena y comprueba la causalidad de todo. Con 17,8 horas de log, `ingest` llegó a 358 MB al arrancar y `data:health` a 317 MB, unos 8 KB por evento, y el worker Starter tiene 512 MB (ADR-0016, «Medición»). Con esa derivación, 7 días de log necesitarían unos 2,5 GB (estimación).

Hechos comprobados en el código el 2026-10-30:

- **La derivación es un pliegue.** `deriveMarketData` (`packages/domain/src/quality.ts`) recorre los eventos en el orden del log con cuatro manejadores (`onRawFrame`, `onConnectionClosed`, `onConnectionOpened` y `onHistoryRecovery`). Cada uno depende solo del estado, del evento y del perfil. Después ordena los ticks, las incidencias y las condiciones, y comprueba la causalidad (`validateConditionCausality`).
- **Lo que crece con el log:** los mapas de duplicados (`firstByFingerprint`) y de conflictos de tiempo (`firstByEventTime`), los IDs vistos (`seenIds`), todos los ticks (`observedTicks`), sus marcas (`flags`) y todas las incidencias y condiciones. Lo demás depende de los símbolos y de las condiciones abiertas: el high-watermark, la continuidad pendiente y las condiciones `connection_lost` y `event_gap_unresolved` abiertas.
- **Lo que usan los lectores en vivo:**
  - el arranque usa los veredictos de ADR-0015 §5, la `connection_id` del último evento, el high-watermark del símbolo y el evento más antiguo, que ya da PostgreSQL (`SourceLogState.firstEventTimeUtc`);
  - la reparación usa la última conexión con `ConnectionOpened` y su cierre;
  - la vigilancia usa el hueco pendiente del símbolo y la cotización canónica de sus dos extremos;
  - `data:health` usa los mismos veredictos, la hora del último evento de conexión, las condiciones abiertas, la continuidad pendiente, el último tiempo de evento y el último raw.

  Ninguno lee las marcas de calidad de los ticks ni las incidencias de duplicado, conflicto, fuera de orden o retraso.
- **Los IDs ya son únicos.** `source_event_index.event_id` es `UNIQUE` en la migración `0002`, así que un log de PostgreSQL no puede repetir un ID.
- **El cursor no sirve de punto de control.** `IngestionCursor` (migración `0004`) da una posición, el high-watermark de un símbolo y la última conexión. No tiene la continuidad pendiente ni las condiciones abiertas, y se escribe a mitad de segmento.

## Decisión

### 1. Qué es un punto de control

Un punto de control es el **estado vivo** de un log de una fuente al final de un segmento cerrado *k*: el resumen acotado de lo que la derivación del log, desde su primer evento hasta el último del segmento *k*, deja para los cuatro lectores. Un lector que parte de él y deriva solo los eventos posteriores obtiene lo mismo que derivando el log entero (§4), salvo que ya no detecta un objeto de segmento anterior al punto de control que falta o cambió; eso lo cubren otros (§4, «Integridad de los objetos»).

Un punto de control nunca entra en un dataset, en un replay ni en un `dataset_id` (§8). Si se pierde, se reconstruye desde el log (§6).

### 2. Estado vivo

El estado vivo tiene, como mucho, una entrada por símbolo, por hueco pendiente o por condición abierta:

- **High-watermark** de cada símbolo: su tiempo de evento y la `observation_id` del tick que lo fijó, y el tick canónico de ese instante, el primero en orden canónico (`tick_fingerprint_sha256`, `observation_id`), con su cotización.
- **Continuidad pendiente** de cada símbolo, como en `deriveMarketData`: el high-watermark del primer cierre no pedido (inicio del hueco), el del último cierre, si ya se sabe que el hueco supera el umbral y, si ya llegó, el fin del hueco (el primer tick posterior al último cierre). Guarda también los ticks de los dos extremos, que necesitan la vigilancia (`gapState`) y la incidencia de un hueco no resuelto (`gapBoundaries`):
  - del inicio, el primer tick observado en ese instante y el canónico de ese instante, que cambia si llega más tarde otro tick con el mismo tiempo;
  - del fin, cuando llega, el canónico del instante siguiente al fin del rango pendiente y el primero observado con el menor tiempo posterior a ese fin.
- **Condiciones abiertas** (`connection_lost` y `event_gap_unresolved`): cada evento de apertura completo, con su incidencia causal, y para `connection_lost`, la `connection_id` cerrada.
- **Conexión anterior:** la última `connection_id` con `ConnectionOpened` y la hora de su `ConnectionClosed`, si lo tiene.
- **Para la salud:** la hora del último `ConnectionOpened` o `ConnectionClosed`, la `observation_id` y la hora de recepción del último raw, y si el log quedó conectado (`connectedInLog` de `deriveHealthReport`).
- **Para el arranque:** la `connection_id` del último evento y si algún frame se rechazó con `symbol_not_allowed` (`isOtherSymbol`).

El último tiempo de evento de todos los ticks, que `HealthReport` da como `last_event_time_utc`, es el mayor high-watermark.

### 3. Derivación desde un punto de control

`packages/domain` gana una derivación en pliegue: parte de un estado vivo, o de ninguno con el log vacío, aplica los eventos en el orden del log y devuelve el estado vivo nuevo y la vista de los lectores (§4).

- **Las mismas reglas.** Las transiciones del high-watermark, de la continuidad, de las condiciones de conexión y de los huecos salen del mismo código que usa `deriveMarketData`, que se reorganiza para compartirlo. Sus resultados no cambian: los vectores v1 se reproducen byte a byte.
- **Las mismas identidades.** Las incidencias y condiciones que abren o resuelven algo se construyen como en `deriveMarketData`, con los mismos cuerpos y los mismos IDs derivados (ADR-0004 §4).
- **Lo que no reproduce:** las incidencias de duplicado, conflicto de tiempo, fuera de orden y retraso, las marcas de los ticks y la lista de ticks, porque ningún lector en vivo las usa (Contexto).
- **Comprobaciones.** Aplica a cada evento las de `deriveMarketData`: versión del contrato, fuente y conector (`assertProvenance`), un ID que no se repite dentro de lo que deriva y una conexión que no se cierra dos veces mientras sigue abierta. Entre el punto de control y lo posterior, los IDs únicos los garantiza el índice. Cada resolución nueva se comprueba contra su apertura, con las reglas y el orden de `validateConditionCausality` (`occurred_at_utc` y después `condition_event_id`): si la resolución quedaría antes que su apertura, o no la supera como esas reglas piden, la derivación falla igual que la completa.
- **Dominio de la equivalencia.** La equivalencia de §4 vale para los logs que cumplen tres reglas de la sesión de ingesta:
  1. un `HistoryRecoveryResult` `partial` o `unavailable` cubre exactamente el hueco pendiente de su símbolo, con su fin ya conocido, porque la sesión lo pide con ese rango y solo lo persiste en la misma conexión (ADR-0015 §4);
  2. ningún ID se repite en el log. En PostgreSQL lo garantiza el índice (`event_id UNIQUE`), y la sesión genera UUIDv7 nuevos;
  3. una clave de condición resuelta no se vuelve a abrir: la sesión cierra cada conexión una vez y no vuelve a pedir un hueco resuelto.

  Si un log trae un resultado `partial` o `unavailable` sin fin de hueco o con otro rango, la derivación en pliegue no tiene sus extremos y falla con `log_not_derivable`, en lugar de dar otros IDs. Las otras dos reglas no las puede comprobar a través del punto de control. La equivalencia supone además que los objetos de los segmentos hasta *k* siguen intactos (§4, «Integridad de los objetos»).

### 4. Lo que obtiene cada lector

La **vista viva** es lo que cada lector usa, y es igual desde un punto de control que desde el log entero cuando los objetos anteriores al punto de control siguen intactos:

| Lector | Lo que obtiene |
|---|---|
| Arranque | el veredicto de ADR-0015 §5 o su fallo, y lo que guarda la sesión: la `connection_id` del último evento, el high-watermark del símbolo y el evento más antiguo |
| Reparación de cierres | `PreviousConnection` |
| Vigilancia de huecos | el estado del hueco del símbolo (`none`, `open`, `boundary_unavailable` o `ready`, con su petición) y el high-watermark del símbolo, que sube el del cursor |
| `data:health` | el `HealthReport`, el código de salida y la alerta de ADR-0015 §8, con las mismas entradas de fuera del log |

- **`connector_version_mismatch`** se comprueba en los eventos posteriores al punto de control. El punto de control lleva su conector (§6), así que uno de otro conector no se usa.
- **`cursor_ahead_of_log`** se comprueba buscando en `source_event_index` el evento del último cursor, en lugar de recorrer el log.
- **`retention_expired`** y la retención que arma la sesión pasan a usar `SourceLogState.firstEventTimeUtc` en lugar del primer evento leído (`events[0]`). Es el mismo valor, porque la primera fila del índice guarda la hora de ese evento, pero sin leerlo.
- **La regla 4 de `data:health`**, que añade en memoria el cierre que el próximo arranque registrará, aplica ese cierre sobre el estado vivo, sin persistir nada.

Cada lector lee el último punto de control válido y después los segmentos cerrados posteriores, uno a uno, y los eventos del segmento abierto. `data:health`, que no toma el bloqueo, lee el punto de control en la misma instantánea que el estado del log (`readLogState`, `REPEATABLE READ`), y rechaza uno cuyo segmento no esté por debajo del abierto, para no aplicar dos veces un segmento recién cerrado.

La vigilancia de huecos sigue volviendo a leer y derivar con cada tick, como en ADR-0015 §4 («Cuándo»), y el estado sigue saliendo del log durable, nunca de la memoria de la sesión (ADR-0015 §3, «Conexión anterior»). Lo que vuelve a derivar queda acotado por lo que hay después del punto de control.

**Integridad de los objetos.** Los lectores en vivo verifican los objetos de lo que leen, después del punto de control, como hoy. Ya no vuelven a leer los de los segmentos anteriores:

- el objeto de cada segmento se verificó al escribirlo, releyéndolo (`writeVerified`), antes de escribir su punto de control;
- la publicación y el replay vuelven a verificar los objetos de los segmentos que usan (ADR-0004 §8 y §9);
- la verificación periódica por partes de todos los segmentos la programa la ADR de despliegue, con su costo en R2.

Un objeto antiguo que falta o cambió deja así de dar `log_not_derivable` en el arranque, en la reparación, en la vigilancia de huecos y en `data:health`, y lo encuentra esa verificación. Por la misma razón, mientras un log está en uso, ninguna regla de ciclo de vida borra objetos de su `sha256/`: los de segmento y los de evento comparten ese prefijo (ADR-0005 §3). Borrar entero el bucket de un log terminado, al vencer su retención, sigue permitido.

### 5. Dónde se guarda y quién lo escribe

- **Tabla.** La migración `0005` crea `live_derivation_checkpoints` en el esquema de la captura, append-only como las de la Fase 1: rechaza `UPDATE`, `DELETE` y `TRUNCATE`. Cada fila guarda la fuente, el símbolo, el segmento *k*, el enlace y las versiones de §6, el SHA-256 de esas versiones, el punto de control entero en JCS, con su estado vivo, el SHA-256 de ese JCS y la hora de escritura. La hora no entra en el hash, así que el mismo log da siempre el mismo punto de control.
- **Clave.** Es única por fuente, segmento y SHA-256 de las versiones de §6, así que conviven filas de versiones distintas para el mismo segmento. El último punto de control válido de un lector es el de mayor segmento entre los que pasan las tres comprobaciones de §6.
- **Conflicto.** Si al cerrar un segmento la inserción encuentra una fila con la misma clave y el mismo SHA-256 del punto de control, por ejemplo al reintentar una inserción ambigua, cuenta como escrito. Con otro SHA-256, el mismo log dio dos puntos de control distintos, que solo puede ser un error de programación: deja la alerta `checkpoint_conflict` y la sesión termina `failed` con ese motivo. No hace falta un log nuevo, sino corregir el código con una versión nueva del formato (§6), que cambia la clave.
- **Contrato.** `LiveDerivationCheckpoint` 1.0.0 va en `packages/contracts`, con su JSON Schema generado, y su semántica en los [contratos de dominio](../contratos-de-dominio.md).
- **Escritor.** Solo lo escribe `ingest`, con el bloqueo de la fuente, a través del log protegido por él (ADR-0015 §3), después de que el cierre del segmento *k* sea durable. El estado vivo de *k* sale del punto de control anterior y de los eventos del segmento *k*.
- **Fallo al guardarlo.** Si PostgreSQL no lo guarda, la ingesta sigue, porque no es la durabilidad de los datos: deja una alerta saneada en stderr, como el cursor y el latido (ADR-0015 §6), y el siguiente cierre lo vuelve a intentar desde el último punto de control escrito.
- **Fallo de la derivación.** Si el pliegue falla, el log ya no se puede derivar, y la sesión termina `failed` con `log_not_derivable`, como cuando falla la vigilancia de huecos: seguir escribiendo un log cuyo próximo arranque fallará no tiene sentido.
- **Rol.** El rol de ejecución que solo inserta y lee (`F2-ROLE-001`) también lo cubre.

### 6. Validez, enlace y reconstrucción

Un lector usa un punto de control solo si cumple todo esto:

- **Enlace con el log.** Su segmento *k* existe en `closed_source_segments` con el mismo `logical_content_sha256`, y la suma de `event_count` y `raw_frame_count` de los segmentos 0 a *k* es la que guarda el punto de control. Se comprueba con filas de PostgreSQL, sin leer objetos.
- **Identidad.** La fuente y el símbolo son los del lector.
- **Versiones.** Coinciden el conector, el conjunto de reglas de calidad, el SHA-256 del perfil, el SHA-256 del esquema de fuente guardado, la política de segmentos, la versión del contrato de los source events y la del formato del estado vivo. Son las que forman el SHA-256 de la clave (§5).
- **Integridad.** El SHA-256 de su JCS coincide.

Si el último no cumple, el lector no lo usa ni lo migra, y reconstruye el estado vivo por partes:

- empieza por el último punto de control válido anterior, o por el log vacío;
- lee cada segmento cerrado posterior de uno en uno y lo descarta después de aplicarlo, así que la memoria no crece con el log;
- `ingest` escribe un punto de control por cada segmento que reconstruye, salvo en un segmento que ya tiene fila con esa clave, como uno rechazado por su enlace o su SHA-256: esa fila no se puede reemplazar, y el punto de control del segmento siguiente la supera;
- `data:health`, que no escribe nada, reconstruye en memoria. Si no termina en su plazo (`HEALTH_DEADLINE_MS`, 30 s), da `paused`, salida 1, con su propia alerta, `data_health_checkpoint_rebuild_incomplete`, y no la de un almacén que no responde. Es lo que informa mientras `ingest` todavía no escribió los puntos de control de una versión nueva.

Un punto de control con otro enlace, con otro SHA-256 o de otra fuente o símbolo no es un cambio de versión, sino una corrupción o un error de programación: el lector deja una alerta saneada con el motivo (`checkpoint_binding_mismatch`, `checkpoint_digest_mismatch` o `checkpoint_identity_mismatch`) antes de reconstruir. Uno de otra versión se ignora sin alerta.

**Versión del formato.** Todo cambio de lo que el pliegue produce para un mismo log, aunque no cambie ninguna regla de calidad, sube la versión del formato del estado vivo, un campo propio del punto de control, distinto del `schema_version` de su contrato. Un vector fija el JCS y el SHA-256 del punto de control en cada límite de segmento del vector v1 y de los logs sintéticos de §9, así que un cambio sin versión que altere cualquiera de esos estados falla en CI.

Una versión nueva del formato o de las reglas se pone así en producción: el primer arranque reconstruye por partes y escribe los puntos de control de la versión nueva. Derivar el log entero con `deriveMarketData` nunca es la salida, porque su memoria crece con el log.

### 7. Logs sucesivos

Un punto de control pertenece a un solo log. Si la retención de producción parte la captura en logs sucesivos, por ejemplo con un esquema y un bucket nuevos (`F2-RETENTION-001`), el log nuevo empieza vacío y sin punto de control, como cualquier captura nueva. Nada de su estado pasa de un log a otro.

Para que un corte no oculte una pérdida, solo se corta después de un cierre pedido, sin continuidad pendiente ni condiciones derivables abiertas en el log que termina. Si no se cumple, se espera, o la ADR de despliegue diseña un traspaso explícito al log nuevo. Cuándo y cómo se corta lo decide esa ADR.

Como el estado vivo no necesita los segmentos anteriores a su punto de control, también permitiría derivar un log al que se le borraran segmentos antiguos. Hoy las tablas no lo permiten (ADR-0005 §3).

### 8. Datasets y replay

La publicación y el replay siguen derivando cada dataset desde sus propios segmentos cerrados, desde el estado vacío y con `deriveMarketData` (ADR-0004 §9), y nunca leen un punto de control. `deriveMarketData` no cambia su resultado, y los vectores v1 tampoco. Publicar datasets largos con memoria acotada es otro problema (pendiente 2 de F1.3), que resuelve `F2-DATASET-001`.

### 9. Pruebas y evidencia

- **Corpus.** Los vectores v1 y logs sintéticos dentro del dominio de §3, con:
  - reconexiones, cierres pedidos y no pedidos y cierres reparados (`close_not_recorded`);
  - duplicados, conflictos de tiempo y ticks fuera de orden, también en el instante de un extremo de hueco;
  - huecos que demuestra la separación, con un perfil de publicación con umbrales, y huecos que solo decide la historia, con un perfil de medición;
  - historias `complete`, `partial` y `unavailable`;
  - un log que no se puede derivar: una conexión cerrada dos veces o una resolución anterior a su apertura.
- **Equivalencia en el dominio** (`packages/domain`, sin red, reloj real ni azar). En cada límite de segmento cerrado del corpus, el estado vivo y la vista que da el pliegue desde el punto de control de ese límite más el resto del log son los que da `deriveMarketData` sobre el log entero.
- **Equivalencia en el worker** (sin red, con almacenes en memoria). En cada límite del mismo corpus, los cuatro lectores dan lo mismo desde el punto de control que desde el log entero:
  - `checkLog`: el veredicto y lo que guarda la sesión;
  - la reparación: `previousConnection`;
  - `GapWatch`: la petición de historia y el high-watermark del cursor;
  - `evaluateDataHealth`: el informe, el código de salida y la alerta, con las reglas 4 a 6.

  Cuentan también `cursor_ahead_of_log` contra el índice, `retention_expired` con `SourceLogState` y `connector_version_mismatch` después del punto de control.
- **Qué es fallar igual.** Se compara el motivo (`log_not_derivable`, `symbol_mismatch` y los demás de ADR-0015 §5). El detalle saneado de `log_not_derivable` puede ser otro, porque el pliegue comprueba cada resolución al aplicarla y `deriveMarketData` al final.
- **Rechazos.** Un punto de control de otra versión, con otro enlace o con otro SHA-256 no se usa: los dos últimos dejan su alerta, y la reconstrucción por partes da el mismo estado vivo sin reescribir esa fila. Un resultado `partial` o `unavailable` sin fin de hueco o con otro rango falla con `log_not_derivable` (§3).
- **Caminos de fallo** (PR 3 y 5): el pliegue que falla al escribir termina la sesión con `log_not_derivable`; el reintento de una inserción ambigua cuenta como escrito con el mismo SHA-256 y termina con `checkpoint_conflict` con otro; y `data:health` da `data_health_checkpoint_rebuild_incomplete` cuando la reconstrucción pasa su plazo.
- **Integración** (PostgreSQL y almacenamiento S3-compatible locales): la tabla de la migración `0005`, su clave y su append-only, la escritura de `ingest` al cerrar cada segmento, la lectura de `data:health` en la misma instantánea y la de los cuatro lectores.
- **Memoria.** Con un log sintético de al menos 7 días de R_100, se mide el máximo de RSS de `ingest` al arrancar con puntos de control válidos, al arrancar reconstruyéndolos y durante una reconexión con hueco, y el de `data:health` con un punto de control válido y sin él. Tiene que quedar a menos de un 10 % del de un log de un día, y por debajo de 200 MB y de 160 MB, medido como en ADR-0016 («Medición»). El script de la medición queda en `scripts/`, fuera de los comandos del producto, como en la evidencia de la Fase 1.

### 10. La vista de cada instante de decisión

El plan de la Fase 2 pide que el backtest y el motor `shadow` decidan con lo que era durable en cada instante (§4, punto 2). Este pliegue es su base: aplica los eventos de uno en uno y en el orden del log, y su estado después de cada evento es lo que se sabía en ese instante.

Un tick que llega en orden, con un tiempo posterior al high-watermark de su símbolo, no puede ser un duplicado ni un conflicto de tiempo, porque ningún tick anterior tiene ese tiempo. Por eso esa vista también puede quedar acotada. La ADR de la semántica del backtest decide cómo la extiende. Este incremento no implementa nada para estrategias.

### 11. Secuencia de entrega

Cada PR es pequeño, con su revisión semántica:

1. Esta ADR y los contratos de dominio.
2. En `packages/domain` y `packages/contracts`: la derivación en pliegue, con las reglas compartidas con `deriveMarketData`, el contrato `LiveDerivationCheckpoint`, el vector de §6 y la equivalencia en el dominio de §9. El mismo PR añade la regla de `packages/domain/**` al mapa de impacto, con sus pruebas (`F2-GOV-001`).
3. En el worker: la migración `0005`, el almacén, la escritura de `ingest` en cada cierre y la reconstrucción por partes, con una prueba de que lo escrito es el pliegue del log entero. Los lectores todavía no lo usan.
4. En el worker: el arranque, la reparación y la vigilancia de huecos desde el punto de control, con su equivalencia en el worker y el runbook.
5. `data:health` desde el punto de control, con su equivalencia en el worker y el runbook.
6. La evidencia de memoria de §9 y el estado del proyecto: F2.1 queda hecho, y F2.2 pasa a ser la siguiente tarea.

### Relación con ADR-0005 y ADR-0015

ADR-0005 §4 dejó diferida la calidad incremental en vivo, y la sección «Relación con ADR-0005» de ADR-0015 dice que el estado vivo «se vuelve a derivar entero cuando hace falta, sin calidad incremental y sin guardar lo derivado». ADR-0017 sustituye esa frase para el estado vivo: ahora se deriva por partes y se guarda en un punto de control. No cambia la calidad de los datasets: sus incidencias se siguen calculando al publicar (ADR-0005 §4). Para los lectores, ADR-0017 cambia cómo leen el log ADR-0015 §3 (conexión anterior), §4 (vigilancia de huecos), §5 (arranque) y §8 (entradas y regla 2 de `data:health`).

También restringe los «huérfanos limpiables» de ADR-0005 §4: mientras un log está en uso, sus objetos por evento no se limpian con una regla de ciclo de vida, porque comparten prefijo con los de segmento (§4).

## Consecuencias

- La memoria de los cuatro lectores deja de crecer con el log: depende de los símbolos, de las condiciones abiertas y de lo que hay después del último punto de control, normalmente el segmento abierto y, como mucho, un segmento cerrado.
- `data:health` lee menos de R2: el esquema guardado, los eventos del segmento abierto y, normalmente, como mucho un segmento cerrado, en lugar de todos. Eso también abarata su frecuencia (ADR-0016, «Consecuencias»).
- Los lectores en vivo ya no detectan un objeto antiguo que falta o cambió. Lo detecta la verificación periódica por partes, que programa la ADR de despliegue y suma sus propias lecturas de R2 (§4).
- Hay dos caminos de derivación: el completo, para datasets y replay, y el de pliegue, para el estado vivo. Comparten las reglas, y la prueba de equivalencia los ata.
- Entra una tabla append-only más, con una fila por segmento cerrado, unos 288 al día con R_100.
- Un log sin puntos de control válidos, como una captura de la Fase 1, se puede seguir usando: el primer arranque los reconstruye por partes.

## Alternativas descartadas

| Alternativa | Motivo |
|---|---|
| Seguir derivando el log entero, con menos copias en memoria | Baja la cifra por evento, pero la memoria sigue creciendo con el log. |
| Extender `IngestionCursor` | No tiene la continuidad pendiente ni las condiciones abiertas, se escribe a mitad de segmento y cambiarlo obliga a otra versión mayor de su contrato y de su tabla. |
| Llevar el estado vivo solo en la memoria de la sesión | ADR-0015 §3 manda leer el estado del log durable, porque un evento adoptado al reabrir o escrito por otro proceso durante una pérdida del bloqueo no está en esa memoria. |
| Guardar el punto de control en el almacenamiento de objetos | El estado es pequeño, y una fila de PostgreSQL se enlaza y se comprueba con las filas de `closed_source_segments` sin leer objetos. |
| Escribirlo cada hora en lugar de en cada segmento | Ahorra filas, pero cada lector tendría que leer hasta 12 segmentos cerrados. |
| Reproducir todas las incidencias y marcas en el pliegue | Necesita los mapas que crecen con el log, y ningún lector en vivo las usa. |
| Worker Standard (2 GB) sin punto de control | Cuesta unos 18 USD más al mes y solo retrasa el problema (ADR-0016, «Alternativas descartadas»). |

## Referencias

- [Plan de Fase 2](../../plan/fase-2-laboratorio-y-bot-shadow.md), `F2-CHECKPOINT-001`, `F2-GOV-001` y §8, punto 1.
- [ADR-0004](0004-pipeline-y-reproduccion-de-datos-fase-1.md) §4, §8 y §9, y [ADR-0005](0005-persistencia-local-y-formato-fisico-f1-3.md) §3 y §4.
- [ADR-0015](0015-reconexion-recuperacion-y-salud-f1-5.md) §3, §4, §5, §6 y §8.
- [ADR-0016](0016-alojamiento-del-sistema-de-datos.md), «Medición» y §4.
- Código leído el 2026-10-30:
  - en `packages/domain/src`, `quality.ts` y `health.ts`, y en `packages/contracts/src`, `conditions.ts`;
  - en `apps/market-data-worker/src`, `deriv/session.ts`, `deriv/log-check.ts`, `deriv/gap-watch.ts`, `health/evaluate.ts`, `health/observe.ts`, `health/command.ts`, `ingestion/raw-first-ingestor.ts`, `postgres/source-log-store.ts`, `source-log/previous-connection.ts` y `source-log/source-event-log.ts`;
  - en `apps/market-data-worker/migrations`, `0002_log_raw_first.sql` y `0004_cursor_y_latido.sql`.
