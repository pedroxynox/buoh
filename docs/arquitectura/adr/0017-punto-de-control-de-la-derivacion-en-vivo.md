# ADR-0017: Punto de control de la derivación en vivo

- **Estado:** Aceptada
- **Fecha:** 2026-10-30
- **Ámbito:** Fase 2, incremento F2.1 (`F2-CHECKPOINT-001` y `F2-GOV-001` del [plan de Fase 2](../../plan/fase-2-laboratorio-y-bot-shadow.md))
- **Decisores:** Dirección técnica de buoh. El plan de la Fase 2 no pide al propietario ninguna decisión para F2.1 (§12).
- **Complementa:** [ADR-0015](0015-reconexion-recuperacion-y-salud-f1-5.md) §5, que dejaba el punto de control para antes de ingerir durante semanas, y la condición «Memoria» de [ADR-0016](0016-alojamiento-del-sistema-de-datos.md) §4. No cambia [ADR-0004](0004-pipeline-y-reproduccion-de-datos-fase-1.md) §9: los datasets y el replay siguen igual.

## Contexto

Cuatro lectores leen y derivan con `deriveMarketData` el log durable entero de una fuente:

1. el arranque de la sesión de ingesta (`SessionRun.#openLog` y `checkLog`), al empezar y después de cada fallo de lectura del log;
2. la reparación de un cierre no registrado (`RawFirstIngestor.repairUnrecordedClose`), antes de cada socket de una reconexión, que solo usa `previousConnection`;
3. la vigilancia de un hueco (`SessionRun.#watchGap`), que vuelve a derivar el log con cada tick durable posterior al high-watermark del hueco;
4. `data:health` (`readLog` en `src/health/observe.ts`), en cada ejecución.

`readDurableSegments` devuelve todos los source events, ya validados, y la derivación los vuelve a validar, guarda todos los ticks y todas las incidencias, y al final ordena y comprueba la causalidad de todo. Con 17,8 horas de log, `ingest` llegó a 358 MB al arrancar y `data:health` a 317 MB, unos 8 KB por evento, y el worker Starter tiene 512 MB (ADR-0016, «Medición»). Con esa derivación, 7 días de log necesitarían unos 2,5 GB (estimación).

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

Un punto de control es el **estado vivo** de un log de una fuente al final de un segmento cerrado *k*: el resumen acotado de lo que la derivación del log, desde su primer evento hasta el último del segmento *k*, deja para los cuatro lectores. Un lector que parte de él y deriva solo los eventos posteriores obtiene lo mismo que derivando el log entero (§4).

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
- **Dominio de la equivalencia.** La equivalencia de §4 vale para los logs que cumplen las reglas de la sesión de ingesta. Un `HistoryRecoveryResult` `partial` o `unavailable` cubre exactamente el hueco pendiente de su símbolo, porque la sesión lo pide con ese rango y solo lo persiste en la misma conexión (ADR-0015 §4). Si un log trae uno con otro rango, la derivación en pliegue no tiene sus extremos y falla con `log_not_derivable`, en lugar de dar otros IDs.

### 4. Lo que obtiene cada lector

La **vista viva** es lo que cada lector usa, y es igual desde un punto de control que desde el log entero:

| Lector | Lo que obtiene |
|---|---|
| Arranque | el veredicto de ADR-0015 §5 o su fallo, y lo que guarda la sesión: la `connection_id` del último evento, el high-watermark del símbolo y el evento más antiguo |
| Reparación de cierres | `PreviousConnection` |
| Vigilancia de huecos | el estado del hueco del símbolo (`none`, `open`, `boundary_unavailable` o `ready`, con su petición) |
| `data:health` | el `HealthReport`, el código de salida y la alerta de ADR-0015 §8, con las mismas entradas de fuera del log |

- **`connector_version_mismatch`** se comprueba en los eventos posteriores al punto de control. El punto de control lleva su conector (§6), así que uno de otro conector no se usa.
- **`cursor_ahead_of_log`** se comprueba buscando en `source_event_index` el evento del último cursor, en lugar de recorrer el log.
- **`retention_expired`** sigue usando `SourceLogState.firstEventTimeUtc`.
- **La regla 4 de `data:health`**, que añade en memoria el cierre que el próximo arranque registrará, aplica ese cierre sobre el estado vivo, sin persistir nada.

Cada lector lee el último punto de control válido y después los segmentos cerrados posteriores, uno a uno, y los eventos del segmento abierto. La vigilancia de huecos sigue volviendo a leer y derivar con cada tick, como en ADR-0015 §4 («Cuándo»), y el estado sigue saliendo del log durable, nunca de la memoria de la sesión (ADR-0015 §3, «Conexión anterior»). Lo que vuelve a derivar queda acotado por lo que hay después del punto de control.

### 5. Dónde se guarda y quién lo escribe

- **Tabla.** La migración `0005` crea `live_derivation_checkpoints` en el esquema de la captura, append-only como las de la Fase 1: rechaza `UPDATE`, `DELETE` y `TRUNCATE`. Cada fila guarda la fuente, el símbolo, el segmento *k*, el enlace y las versiones de §6, el estado vivo en JCS, su SHA-256 y la hora de escritura. La hora no entra en el hash, así que el mismo log da siempre el mismo punto de control.
- **Contrato.** `LiveDerivationCheckpoint` 1.0.0 va en `packages/contracts`, con su JSON Schema generado, y su semántica en los [contratos de dominio](../contratos-de-dominio.md).
- **Escritor.** Solo lo escribe `ingest`, con el bloqueo de la fuente, a través del log protegido por él (ADR-0015 §3), después de que el cierre del segmento *k* sea durable. El estado vivo de *k* sale del punto de control anterior y de los eventos del segmento *k*.
- **Fallo al escribirlo.** No detiene la ingesta, porque no es la durabilidad de los datos: deja una alerta saneada en stderr, como el cursor y el latido (ADR-0015 §6), y el siguiente cierre lo vuelve a intentar desde el último punto de control escrito.
- **Rol.** El rol de ejecución que solo inserta y lee (`F2-ROLE-001`) también lo cubre.

### 6. Validez, enlace y reconstrucción

Un lector usa un punto de control solo si cumple todo esto:

- **Enlace con el log.** Su segmento *k* existe en `closed_source_segments` con el mismo `logical_content_sha256`, y la suma de `event_count` y `raw_frame_count` de los segmentos 0 a *k* es la que guarda el punto de control. Se comprueba con filas de PostgreSQL, sin leer objetos.
- **Versiones.** Coinciden la fuente, el símbolo, el conector, el conjunto de reglas de calidad, el SHA-256 del perfil, el SHA-256 del esquema de fuente guardado, la política de segmentos, la versión del contrato de los source events y la del formato del estado vivo.
- **Integridad.** El SHA-256 de su JCS coincide.

Si el último no cumple, el lector no lo usa ni lo migra, y reconstruye el estado vivo por partes:

- empieza por el último punto de control válido anterior, o por el log vacío;
- lee cada segmento cerrado posterior de uno en uno y lo descarta después de aplicarlo, así que la memoria no crece con el log;
- `ingest` escribe un punto de control por cada segmento que reconstruye;
- `data:health`, que no escribe nada, reconstruye en memoria y puede pasar su plazo de 30 s (ADR-0015 §8), con `paused` y `deadline_exceeded`.

Una versión nueva del formato del estado vivo o de las reglas se pone así en producción: el primer arranque reconstruye por partes y escribe los puntos de control de la versión nueva. Derivar el log entero con `deriveMarketData` nunca es la salida, porque su memoria crece con el log.

### 7. Logs sucesivos

Un punto de control pertenece a un solo log. Si la retención de producción parte la captura en logs sucesivos, por ejemplo con un esquema y un bucket nuevos (`F2-RETENTION-001`), el log nuevo empieza vacío y sin punto de control, como cualquier captura nueva. Nada de su estado pasa de un log a otro. Cómo se parte la captura lo decide la ADR de despliegue.

Como el estado vivo no necesita los segmentos anteriores a su punto de control, también permitiría derivar un log al que se le borraran segmentos antiguos. Hoy las tablas no lo permiten (ADR-0005 §3).

### 8. Datasets y replay

La publicación y el replay siguen derivando cada dataset desde sus propios segmentos cerrados, desde el estado vacío y con `deriveMarketData` (ADR-0004 §9), y nunca leen un punto de control. `deriveMarketData` no cambia su resultado, y los vectores v1 tampoco. Publicar datasets largos con memoria acotada es otro problema (pendiente 2 de F1.3), que resuelve `F2-DATASET-001`.

### 9. Pruebas y evidencia

- **Equivalencia** (`packages/domain`, sin red, reloj real ni azar). En cada límite de segmento cerrado, la vista viva desde el punto de control de ese límite más el resto del log es igual a la vista viva derivada con `deriveMarketData` del log entero, fallos incluidos. Se comprueba sobre los vectores v1 y sobre logs sintéticos con:
  - reconexiones, cierres pedidos y no pedidos y cierres reparados (`close_not_recorded`);
  - duplicados, conflictos de tiempo y ticks fuera de orden, también en el instante de un extremo de hueco;
  - historias `complete`, `partial` y `unavailable`, con hueco excedido y sin él;
  - perfiles de publicación con umbrales y perfiles de medición;
  - un log que no se puede derivar: una conexión cerrada dos veces o una resolución anterior a su apertura.
- **Rechazos.** Un punto de control de otra versión, con otro enlace o con otro SHA-256 no se usa, y la reconstrucción por partes da el mismo estado vivo. Un resultado `partial` o `unavailable` con otro rango falla con `log_not_derivable` (§3).
- **Integración** (PostgreSQL y almacenamiento S3-compatible locales): la tabla de la migración `0005` y su append-only, la escritura de `ingest` al cerrar cada segmento y la lectura de los cuatro lectores.
- **Memoria.** Con un log sintético de al menos 7 días de R_100, se mide el máximo de RSS de `ingest` al arrancar y durante una reconexión con hueco, y el de `data:health`. Tiene que quedar a menos de un 10 % del de un log de un día, y por debajo de 200 MB y de 160 MB, medido como en ADR-0016 («Medición»). El script de la medición queda en `scripts/`, fuera de los comandos del producto, como en la evidencia de la Fase 1.

### 10. La vista de cada instante de decisión

El plan de la Fase 2 pide que el backtest y el motor `shadow` decidan con lo que era durable en cada instante (§4, punto 2). Este pliegue es su base: aplica los eventos de uno en uno y en el orden del log, y su estado después de cada evento es lo que se sabía en ese instante.

Un tick que llega en orden, con un tiempo posterior al high-watermark de su símbolo, no puede ser un duplicado ni un conflicto de tiempo, porque ningún tick anterior tiene ese tiempo. Por eso esa vista también puede quedar acotada. La ADR de la semántica del backtest decide cómo la extiende. Este incremento no implementa nada para estrategias.

### 11. Secuencia de entrega

Cada PR es pequeño, con su revisión semántica:

1. Esta ADR y los contratos de dominio.
2. En `packages/domain` y `packages/contracts`: la derivación en pliegue, con las reglas compartidas con `deriveMarketData`, el contrato `LiveDerivationCheckpoint` y las pruebas de equivalencia de §9. El mismo PR añade la regla de `packages/domain/**` al mapa de impacto (`F2-GOV-001`).
3. En el worker: la migración `0005`, el almacén, la escritura de `ingest` y la reconstrucción por partes, y el arranque, la reparación y la vigilancia de huecos desde el punto de control, con el runbook.
4. `data:health` desde el punto de control, con el runbook.
5. La evidencia de memoria de §9 y el estado del proyecto: F2.1 queda hecho, y F2.2 pasa a ser la siguiente tarea.

## Consecuencias

- La memoria de los cuatro lectores deja de crecer con el log: depende de los símbolos, de las condiciones abiertas y de lo que hay después del último punto de control, normalmente el segmento abierto y, como mucho, un segmento cerrado.
- `data:health` lee menos de R2: el esquema guardado, los eventos del segmento abierto y, normalmente, como mucho un segmento cerrado, en lugar de todos. Eso también abarata su frecuencia (ADR-0016, «Consecuencias»).
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
- [ADR-0015](0015-reconexion-recuperacion-y-salud-f1-5.md) §3, §4, §5, §6 y §8.
- [ADR-0016](0016-alojamiento-del-sistema-de-datos.md), «Medición» y §4.
- Código leído el 2026-10-30: `packages/domain/src/quality.ts`, `packages/domain/src/health.ts`, `packages/contracts/src/conditions.ts`, `apps/market-data-worker/src/deriv/log-check.ts`, `src/deriv/gap-watch.ts`, `src/health/evaluate.ts`, `src/source-log/previous-connection.ts`, `src/source-log/source-event-log.ts` y `migrations/0002_log_raw_first.sql`.
