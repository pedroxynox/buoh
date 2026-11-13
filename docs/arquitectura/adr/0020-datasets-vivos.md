# ADR-0020: Datasets vivos (F2.5)

- **Estado:** Aceptada
- **Fecha:** 2026-11-13
- **Ámbito:** Fase 2, incremento F2.5 (`F2-THRESHOLD-001` y `F2-DATASET-001` del [plan de Fase 2](../../plan/fase-2-laboratorio-y-bot-shadow.md)). Fija también lo que toman de ella F2.4 (la sección Datos y las publicaciones de la Auditoría), F2.7 (la lectura de los datasets por partes) y F2.9 (el perfil del estado vivo).
- **Decisores:** Propietario de buoh (cuánto se guardan los datasets, §6), a propuesta de la dirección técnica (lo demás).
- **Complementa:** [ADR-0004](0004-pipeline-y-reproduccion-de-datos-fase-1.md) §10, cuyos umbrales live fija (§1); [ADR-0005](0005-persistencia-local-y-formato-fisico-f1-3.md) §2, cuyo formato físico de los derivados cambia (§7); [ADR-0015](0015-reconexion-recuperacion-y-salud-f1-5.md) §2 y §4, porque el estado vivo deja el perfil de medición (§4) y los ticks de la historia pasan a `MarketTick` (§3); [ADR-0017](0017-punto-de-control-de-la-derivacion-en-vivo.md) §8, porque la publicación usa la derivación en pliegue para elegir dónde termina un dataset (§7); [ADR-0018](0018-sistema-de-datos-en-produccion.md) §5, cuya historia de las paradas programadas revisa (§4), §7, cuya regla de los datasets fija (§6), §8 y §10, a los que suma un esquema, un rol y una regla de bloqueo (§5), y §11, al que suma dos pasos (§8); y [ADR-0019](0019-api-cuentas-y-auditoria.md) §8, cuyo perfil del gráfico y cuyo lector de publicaciones cambian (§4 y §10).

## Contexto

El plan de la Fase 2 pide esta ADR antes del código de F2.5 (§8, punto 4): los umbrales, el perfil de publicación, la cadencia y el tamaño, las partes y los límites al publicar, los ticks de la historia y la lectura por partes. Se escribe con al menos 7 días seguidos de captura en producción (`F2-THRESHOLD-001`). La captura corre desde el 2026-11-01, y el log 2 cubre una semana entera, del 2026-11-02 al 2026-11-09.

Lo que ya está decidido y esta ADR tiene que respetar:

- **Sin umbrales inventados.** Los datos vivos no se publican mientras no haya umbrales live de retraso y de hueco medidos (ADR-0004 §10 y §13, ADR-0012 §8). El perfil de Deriv es de medición, y la publicación lo rechaza. El perfil sintético v1 usa 2000 ms para los dos, y ningún símbolo real hereda esos valores.
- **El mismo perfil en vivo.** Desde que se fijen, el estado vivo se deriva con el mismo perfil que los datasets, para que el motor *shadow* y la réplica vean las mismas marcas de calidad (`F2-THRESHOLD-001`).
- **Los datasets no viven en un log.** Cada log vence a los 30 días y se borra entero, su esquema y su prefijo (ADR-0018 §6 y §7). Un dataset se guarda al menos 30 días, y el que cita un backtest, una evaluación o una decisión del motor, al menos tanto como esa evidencia. Esta ADR decide dónde, dentro del presupuesto.
- **Pendientes de F1.3** ([`PROJECT_STATUS.md`](../../../PROJECT_STATUS.md)): (1) si la conexión cae durante el `COMMIT`, se informa que no se confirmó aunque pudo confirmarse; (2) publicar no aplica los límites de lectura del replay, y `normalized_ticks` y `quality_incidents` son un solo artefacto que crece con el dataset; (3) los nombres de `PublicationStep` no coinciden con `PersistenceStage`, y los fallos de publicación no entran en el registro operativo.
- **Memoria.** Hoy, publicar y reproducir cargan el dataset entero en memoria (`publishFromLog` lee todos sus segmentos y `deriveMarketData` deriva de una vez). La memoria crece con el dataset (medida abajo), y el plan exige un techo que no dependa de su tamaño (`F2-DATASET-001`).
- **Plano de datos.** Publica un proceso del plano de datos, nunca la API ni el motor (plan §4, punto 5), y lo hace solo, desde segmentos cerrados del log.
- **Términos de Deriv.** Sus términos solo permiten tener sus datos en caché 24 horas, y el propietario decidió guardar 30 días de log igualmente (ADR-0018 §7). La redistribución sigue deshabilitada (ADR-0004 §13).

## Medición

Con [`scripts/evidencia-f2-5/medir-umbrales.mjs`](../../../scripts/evidencia-f2-5/medir-umbrales.mjs), el acceso de solo lectura del agente (ADR-0018 §12) y Node 24.22.0, sobre los logs 2 y 3 de producción, del 2026-11-02 00:00:08 UTC al 2026-11-13 00:00:00 UTC: 11 días seguidos, 3161 segmentos, 495 373 eventos y 473 753 ticks de R_100. El script solo saca horas, tiempos y conteos, nunca una cotización, y con la misma ventana da las mismas cifras mientras los logs no venzan.

```bash
node scripts/evidencia-f2-5/medir-umbrales.mjs --logs 2,3 --hasta 2026-11-13T00:00:00.000Z
```

**Retraso de entrega**, la recepción menos la hora de fuente. Deriv da la hora en segundos enteros, así que el retraso medido puede pasar del real hasta en 999 ms. El primer tick de cada conexión va aparte, porque espera la suscripción.

| Ticks | n | mín. | p50 | p90 | p99 | p99,9 | p99,99 | máx. | > 1000 ms | > 2000 ms | > 3000 ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Todos salvo el primero de cada conexión | 473 638 | 12 | 37 | 158 | 319 | 476 | 755 | 8922 | 36 | 15 | 9 |
| El primero de cada conexión | 115 | 46 | 913 | 1891 | 2012 | 2014 | 2014 | 2014 | 51 | 3 | 0 |

Los 9 que pasan de 3000 ms llegaron en un solo minuto, del 2026-11-09 12:05:22 al 12:06:14 UTC.

**Intervalo** entre ticks seguidos de una misma conexión: 473 638 intervalos, y todos son de 2000 ms salvo 7. Esos 7 son silencios con la conexión abierta, de 4 s a 466 s: el 2026-11-02 de 12:59:58 a 13:07:44 UTC, el 11-03 de 02:42:52 a 02:45:42, el 11-04 de 03:02:38 a 03:03:30, el 11-05 de 01:40:34 a 01:40:38 y de 11:02:10 a 11:02:14, y el 11-12 de 06:04:06 a 06:04:38 y de 06:16:18 a 06:22:44. El 2026-11-13, la historia de Deriv (`ticks_history`) devolvió para cada uno solo sus dos extremos y ningún tick dentro: Deriv no generó ticks en esos silencios, y no se perdió ninguno.

**Separación tras una reconexión**, del high-watermark del primer cierre no pedido al primer tick posterior al high-watermark del último cierre, como en las reglas de continuidad (contratos de dominio, reglas 1.0.0):

| n | mín. | p50 | p90 | máx. | = 2000 ms | > 2000 ms |
|---:|---:|---:|---:|---:|---:|---:|
| 99 | 2000 | 4000 | 24 000 | 1 080 000 | 34 | 65 |

La mayor es la del 2026-11-03, de 03:40:48 a 03:58:48 UTC, con tres cierres por `ticks_timeout`. Los motivos de los cierres: `close_code_1006` 61, `close_not_recorded` 28, `close_code_1001` 5, `ping_timeout` 4 y `ticks_timeout` 1. A esas separaciones les faltaban 867 ticks. Los 99 `HistoryRecoveryResult` fueron `complete` y recuperaron exactamente esos 867. En cada uno, `recovered_event_count` coincide con los tiempos distintos entre sus extremos de las páginas `history` de su último intento (§3), y todos tuvieron una sola página y un solo intento.

**Paradas pedidas**, como las de un despliegue: 14, con separaciones de 4000 a 8000 ms y 23 ticks sin recuperar en total.

**Memoria de publicar y reproducir con el código de hoy**, como estimación para §7. En el sandbox, con Node 24.22.0 y los tamaños de V8 de producción (`WORKER_NODE_FLAGS`: `--max-semi-space-size=1 --max-old-space-size=256`), sobre segmentos reales del log 2 desde el 300, con almacenes en memoria y un perfil de publicación de prueba. Es el máximo de memoria residente del proceso (`maxRSS`):

| Segmentos | Eventos | Ticks | Publicar | Reproducir después, en el mismo proceso |
|---:|---:|---:|---:|---:|
| 72 (6 horas) | 10 768 | 10 248 | 157,6 MiB | 184,6 MiB |
| 105 | 15 849 | 15 109 | 190,1 MiB | 229,1 MiB |
| 288 (1 día), solo construir | 44 450 | 42 454 | 348,1 MiB | — |

La cifra de reproducir es un techo: incluye lo que dejó la publicación en el mismo proceso. Con un día, `normalized_ticks` ocupa 21,9 MB en NDJSON y 4,4 MB en gzip de nivel 9, y los segmentos, 3,4 MB en gzip.

## Decisión

### 1. Umbrales (`F2-THRESHOLD-001`)

| Umbral | Valor | Regla |
|---|---:|---|
| `maximum_delivery_delay_ms` | 3000 | el intervalo nominal del símbolo más la resolución de su hora de fuente |
| `maximum_event_gap_ms` | 2000 | el intervalo nominal del símbolo |

- **El intervalo nominal** de R_100 es de 2000 ms: son los 473 631 intervalos medidos que no son silencios de la fuente, del mínimo al p99,99.
- **Retraso.** Un tick va tarde cuando llega después de que la fuente debió generar el siguiente, contando el segundo que trunca su hora: 2000 + 1000 ms. El umbral tiene que quedar por encima del p99,99 medido (755 ms), para que la marca señale un episodio y no el ruido de la red. Con 3000 ms, `delivery_delayed` habría marcado 9 de los 473 638 ticks (un 0,002 %), todos del minuto malo del 2026-11-09.
- **Hueco.** Tras una reconexión, una separación igual al intervalo nominal demuestra que no falta ningún tick. Una mayor no lo demuestra, aunque pueda ser un silencio de la fuente, así que la decide la historia. Con 2000 ms, 34 de las 99 reconexiones medidas no habrían pedido historia. Coincide con el valor del perfil sintético v1, pero sale de la medición y no de él (ADR-0004 §10).
- **Por símbolo.** Los umbrales son de R_100. Otro símbolo, o un cambio del intervalo de R_100, se mide aparte y lleva otro perfil.

### 2. Perfil de publicación y reglas 3.0.0

- **Perfil.** `deriv_options-publication-v1-R_100`, de publicación (sin `purpose`): `allowed_symbols` `["R_100"]`, `gap_detection` `after_reconnection`, los dos umbrales de §1, los mismos `non_tick_msg_types` del perfil de medición v2, `quality_rule_version` `3.0.0` y `source` `deriv_options`. Sus bytes son su JCS, como los del perfil de medición, y su esquema de fuente es el mismo, el que guardó `ingest` en cada log (`readStoredSourceSchema`). El perfil de medición no cambia.
- **Reglas 3.0.0** (normalizador 3.0.0, esquema de incidencias 2.0.0): las reglas 2.0.0 más los ticks de la historia (§3). Es una versión mayor porque cambia el resultado de entradas que 2.0.0 ya define: una respuesta `history` deja de producir solo raw. Con las demás entradas dan lo mismo que 2.0.0, y el pliegue del estado vivo, que no produce ticks (ADR-0017 §3), da lo mismo con las dos.
- **Compatibilidad.** El replay conserva el lector y la recomputación de 1.0.0, 2.0.0 y 3.0.0 (contratos de dominio, «Versionado y compatibilidad»). Los vectores v1 se reproducen byte a byte y no cambian.

### 3. Los ticks de la historia pasan a `MarketTick`

Lo pide decidir ADR-0015 §4 al publicar datasets vivos. Sí pasan: sin ellos, un dataset diría que la historia demostró la continuidad, con un `complete`, y le faltarían los ticks que la demuestran, unos 79 al día en la medición. Las reglas 3.0.0 los derivan así:

- **Qué resultado.** Solo un `HistoryRecoveryResult` `complete`. Uno `partial` o `unavailable` deja el hueco sin resolver (`event_gap_unresolved`), y sus páginas siguen solo en el raw: las reglas no tienen el esquema de respuesta de `ticks_history` para separar sus páginas válidas de las inválidas.
- **Qué páginas.** Las del último intento, las mismas que contó la sesión. Son los `raw_source_frame` con `msg_type` `history` de la misma conexión, cuya petición (`echo_req.ticks_history`) es el símbolo del resultado, desde el último de ellos cuya petición termina en E (`echo_req.end`, como entero) hasta el resultado, sin pasar por el resultado anterior de esa conexión y ese símbolo. S y E son los segundos de los extremos: S = `from_event_time_utc` − 1 ms y E = `to_event_time_utc` + 1 ms (ADR-0015 §4).
- **Qué ticks.** Los de esas páginas con un tiempo estrictamente entre S y E. Cada página pasa las comprobaciones de ADR-0015 §4 que no necesitan el esquema: `history.times`, `history.prices` y `pip_size`, las dos listas de la misma longitud, tiempos enteros estrictamente crecientes dentro de lo pedido y precios que la regla de `quote_decimal` acepta con ese `pip_size`. Esas comprobaciones pasan a `packages/domain` como una función pura, que usan la sesión y las reglas. Si una página no las pasa, o los tiempos distintos no suman `recovered_event_count`, la derivación aborta, como con cualquier invariante rota: la sesión ya comprobó esas páginas, así que solo puede ser un error de programación.
- **Sus campos.** `origin` `history_recovery`. `observation_id`, `raw_payload_sha256`, `source`, `connector_version` y `received_at_utc` son los del frame que lo trajo, así que la comprobación de procedencia de los datasets (`validateDatasetConsistency`, «Tick sin raw correspondiente») vale igual. Varios ticks comparten así el `observation_id` de su frame y se distinguen por su `event_time_utc`. `event_time_utc` es su segundo en UTC con milisegundos, y `quote_decimal` sale del lexema de su precio con el `pip_size` de la página, como en la sesión.
- **Sus reglas.** Entran en la derivación en la posición de su resultado, en orden de tiempo, y les aplican `duplicate_exact` y `source_time_conflict`, contra todos los ticks anteriores, del flujo y de la historia. No mueven el high-watermark ni deciden la continuidad, y no se evalúan con `out_of_order` ni con `delivery_delayed`: esas reglas describen cómo llega el flujo, y un tick de la historia es, por definición, anterior y recibido tarde. Tampoco son extremos de un hueco (`gapBoundaries`), para que la derivación completa y la del pliegue, que solo ve el flujo, sigan dando los mismos extremos.
- **El manifiesto.** `normalized_tick_count` los cuenta, y `event_time_from_utc` y `event_time_to_utc` son los extremos de todos los ticks.
- **Pruebas.** Un vector sintético nuevo, de reglas 3.0.0, fija los ticks, las marcas, las incidencias y el `dataset_id` con una historia de una página y de varias, un reintento cuyo primer intento dejó páginas, una página que llega tarde, un `partial` y una reconexión de 2000 ms cuya continuidad queda demostrada sin historia.

### 4. El estado vivo con el perfil de publicación

- **Cuándo.** Cada log se deriva entero con un solo perfil, para que sus puntos de control sigan valiendo. Un log preparado por `buoh-operaciones` (ADR-0018 §6) con el código de esta ADR guarda su perfil en una tabla nueva de una fila, `log_quality_profile` (migración `0007` de los logs, append-only), entre sus migraciones y los privilegios: así existe antes de que ningún rol de ejecución pueda leer el log. Un log sin esa fila sigue con el perfil de medición. Así, el estado vivo cambia de perfil en el corte semanal que entra en el primer log preparado con ese código, entre una y dos semanas después del despliegue, y no hay que reconstruir puntos de control ni parar la captura.
- **Quién.** El arranque de `ingest`, la reparación de cierres, la vigilancia de huecos, `data:health` y el gráfico de la API (ADR-0019 §8) arman el perfil de cada log desde esa fila y el esquema de fuente guardado. Un perfil que el código no conoce falla cerrado, con `log_not_derivable`, como cualquier versión que no tiene lector.
- **Qué cambia.** Tras una reconexión con 2000 ms de separación, la continuidad queda demostrada sin pedir historia, y la salud vuelve antes a `healthy`. El pliegue sigue sin producir `delivery_delayed` ni las marcas de los ticks (ADR-0017 §3): la ADR del motor (F2.9) decide cómo ve esas marcas en el instante de cada decisión, con este mismo perfil.
- **El gráfico** sigue dibujando los ticks del flujo y marcando los huecos con el perfil del log. No dibuja los recuperados.
- **Paradas programadas.** Revisada con lo medido, la regla de ADR-0018 §5 sigue: una parada programada no recupera su historia. En 11 días fueron 14 paradas y 23 ticks, y recuperarlos exigiría que un cierre pedido dejara la continuidad pendiente, otra versión de las reglas y del pliegue. La parada queda en los source events del dataset como un cierre `requested` seguido de una apertura, y la ADR de la semántica del backtest (F2.7) decide cómo la trata una estrategia.

### 5. Dónde viven los datasets

- **Objetos.** En el bucket de la captura, `buoh-captura`, bajo el prefijo `datasets/`: `datasets/sha256/<object_bytes_sha256>` y `datasets/manifests/<dataset_id>/<publication_id>/<manifest_document_sha256>.json` (ADR-0005 §3). La retención solo borra `logs/<n>/` (ADR-0018 §7), así que nunca los toca, y una prueba lo comprueba. Un dataset lleva su propia copia de los segmentos de su log, porque el log se borra a los 30 días.
- **Regla de bloqueo.** Antes de la primera publicación, el propietario crea en Cloudflare la regla `datasets-indefinido` sobre `datasets/`, de retención indefinida: nadie puede borrar ni sobrescribir un objeto de un dataset, tampoco con un token filtrado. R2 admite reglas por prefijo e indefinidas ([referencias](#referencias-verificadas)). El worker ya trata como una clave que ya existe el 409 `ObjectLockedByBucketPolicy` (precisión del PR 6c de ADR-0018 §10), que dan también dos datasets con un objeto igual, como el artefacto vacío. Los objetos de una publicación que falló antes del `COMMIT` quedan huérfanos y no se pueden borrar mientras la regla exista: son pocos y pequeños.
- **PostgreSQL.** Un esquema propio, `buoh_datasets`, de `buoh_dueno`, con su propia secuencia de migraciones (`apps/market-data-worker/migrations-datasets/`), que el paso 1 de `buoh-operaciones` aplica como las de los logs y la de la API (ADR-0018 §11 y ADR-0019 §7). Todas sus tablas son append-only, con los mismos disparadores que las de la Fase 1:
  - `datasets`, `published_manifest_records` y `dataset_quality_incidents`, con la forma de la migración `0001` de los logs;
  - `dataset_log_ranges`: el log y los segmentos, primero y último, de cada dataset, que inserta el mismo `COMMIT` que lo hace visible. Un índice único por log y primer segmento, y la comprobación de que cada dataset empieza en el segmento siguiente al último del anterior, impiden solapes y huecos;
  - `dataset_verifications`: el resultado de cada verificación (§8);
  - `operational_incidents` y `operational_conditions`: el registro operativo de la publicación (§9).

  Las tablas de publicación de cada log siguen existiendo, vacías: en producción nada escribe en ellas.
- **Roles** (complementa ADR-0018 §8):

  | Rol | En `buoh_datasets` | Lo usa |
  |---|---|---|
  | `buoh_publicacion`, nuevo, con inicio de sesión y miembro de `buoh_lectura` | uso del esquema, `SELECT` e `INSERT` en sus tablas, salvo `dataset_verifications`, y uso de sus secuencias | la publicación (§8) |
  | `buoh_lectura` | uso del esquema y `SELECT` | `buoh_salud`, para la verificación (§8), y `buoh_agente` |
  | `buoh_api_lectura` | uso del esquema y `SELECT` | la API: Datos y la Auditoría (§10) |
  | `buoh_ingesta` | nada | `ingest` |

  Ningún rol de ejecución puede actualizar, borrar, vaciar ni cambiar el esquema de una tabla, y una prueba de integración lo comprueba con `42501`, como `F2-ROLE-001`. `buoh-operaciones` guarda las verificaciones como `buoh_dueno`, como guarda los informes de la salud. La contraseña de `buoh_publicacion` la genera Render (`generateValue`) como una variable nueva de `buoh-operaciones`, `BUOH_PUBLICACION_POSTGRES_PASSWORD`.
- **Tokens de R2** (complementa ADR-0018 §10). Ninguno nuevo. La publicación usa el token `operaciones`, de lectura y escritura en `buoh-captura`, que ya tiene `buoh-operaciones`: un token propio tendría el mismo permiso, porque los de R2 se limitan por bucket y no por prefijo, y lo que protege los objetos es la regla de bloqueo. La verificación usa el token `salud`, de solo lectura, y la API, el token `api`.

### 6. Cuánto se guardan los datasets

**Los datasets no vencen.** Es la decisión del propietario del 2026-11-13 («B»). El agente le dio dos opciones:

- **A:** borrarlos a los 30 días, como la captura, salvo los que cite una evidencia: el laboratorio tendría como mucho los últimos 30 días de datos, más los que ya use alguna prueba;
- **B:** guardarlos todos y revisar cuando R2 llegue a 8 GB, unos 2 años al ritmo medido: el laboratorio acumularía meses de datos para entrenar, validar y probar estrategias.

Le recomendó la B, porque validar bien una estrategia necesita varios meses de datos (protocolo de validación §1), el costo es casi cero y los datos son solo para su uso, sin compartirlos. Le explicó el riesgo: los términos de Deriv solo permiten guardar sus datos 24 horas, y con la B se guardan mucho más que los 30 días que ya había aceptado.

- **Revisión.** La retención se revisa con el propietario cuando R2 pasa de 8 GB o la base de 600 MB, los umbrales de ADR-0018 §7, que `buoh-operaciones` ya mide. Al ritmo medido, los datasets suman unos 8 MB al día en R2 (unos 2,9 GB al año), así que R2 llegaría a 8 GB en algo más de 2 años, con los unos 1,3 GB de los logs. En PostgreSQL suman unos 3 MB al mes, y la base pasaría los 600 MB en aproximadamente un año y medio, con los unos 0,55 GB de los logs (estimaciones).
- **Si Deriv termina la relación**, o el propietario decide borrar antes, la sección «borrar» del runbook empieza por quitar las dos reglas de bloqueo, y borra el prefijo `datasets/` y el esquema `buoh_datasets`, además de los logs.
- La regla de ADR-0018 §7 para los datasets que cita una evidencia queda cubierta: ninguno vence.

### 7. Cadencia, tamaño, partes y límites

- **Un dataset** es un rango contiguo de segmentos cerrados de un solo log, nunca de dos, y cada segmento de un log entra en un solo dataset. El primero de un log empieza en su segmento 0, y cada siguiente, en el segmento siguiente al último del anterior.
- **Cada 6 horas.** Las marcas son las 00:00, 06:00, 12:00 y 18:00 UTC. Si un dataset empieza en el segmento *s*, su marca *M* es la primera posterior a la hora del primer evento de *s* (`first_event_time_utc` de `closed_source_segments`). Su objetivo es el último segmento que empieza antes de *M*.
- **Un final limpio.** El dataset termina en el primer segmento, desde el objetivo y entre los que empiezan antes de *M* + 1 hora, tras el cual su propia derivación, desde el estado vacío en *s*, no deja continuidad pendiente ni un `connection_lost` abierto. Una `event_gap_unresolved` abierta no cuenta, porque una recuperación agotada no se vuelve a intentar, como en el corte de los logs (ADR-0018 §6). Si en esa hora no hay un final limpio, termina en el último de esos segmentos, y lo que quedó abierto se ve en sus propias incidencias y condiciones. Así, casi siempre, un dataset empieza y termina sin nada abierto y se entiende solo.
- **Cómo se elige.** La publicación aplica a los segmentos, de uno en uno, la derivación en pliegue de ADR-0017 §3 desde el estado vacío, que da lo mismo que la derivación completa de esos segmentos y cuesta poco. No lee un punto de control. El contenido y el `dataset_id` solo dependen de los segmentos elegidos y del perfil, y el replay sigue sin leer el pliegue ni los puntos de control (ADR-0017 §8).
- **Cuándo se publica.** Cuando el log ya tiene cerrado un segmento que empieza en *M* + 1 hora o después, así que el dataset de las 00:00 a las 06:00 se publica hacia las 07:05. Un log terminado, cuyo sucesor ya tiene escrituras (ADR-0018 §6), publica lo que le quede sin esperar: su último dataset termina en su último segmento.
- **Techo.** Un dataset no pasa de 16 000 elementos, la suma de sus source events y de los ticks que recupera la historia (`recovered_event_count` de sus resultados `complete`). Si el segmento siguiente lo pasaría, termina antes, aunque no sea limpio. Con R_100, 6 horas son unos 11 000 eventos, y 7 horas, unos 13 000. Si un solo segmento lo pasa, por ejemplo con la historia de un hueco de muchas horas, la publicación de ese log se detiene con la alerta `publication_segment_too_large`, que el runbook trata como urgente, en lugar de cargarlo: el techo de memoria es lo primero (ADR-0004 §7).
- **Partes.** `normalized_ticks`, `quality_incidents` y `operational_conditions` se dividen en partes de 5000 registros como mucho, en su orden canónico: un rol con *n* registros tiene ⌈*n* / 5000⌉ partes, y al menos una, la vacía si no tiene ninguno (ADR-0004 §9). Cada parte es un `LogicalArtifactRef` con su índice, su conteo y su hash lógico, como los `source_events:*`. Los vectores v1 tienen menos de 5000 registros por rol, así que siguen con un artefacto cada uno y con el mismo `dataset_id`.
- **Formato físico.** Los artefactos derivados se guardan en gzip, con el mismo writer que los segmentos (`node:zlib`, nivel 9; ADR-0005 §2): en la medición, los ticks ocupan 4,9 veces menos. El `dataset_id` no cambia, porque solo depende de los hashes lógicos (ADR-0004 §5), y los vectores siguen sin comprimir. Parquet sigue diferido.
- **Límites del replay.** Antes de escribir nada, la publicación comprueba que cada objeto, en sus bytes físicos y en los lógicos, no pasa de `MAX_REPLAY_OBJECT_BYTES` (256 MiB), y el documento del manifiesto, de `MAX_MANIFEST_DOCUMENT_BYTES` (16 MiB). Si alguno pasa, no publica y deja la alerta `publication_limit_exceeded`: nunca publica lo que el replay rechazaría. Con el techo, quedan muy lejos.
- **Memoria.** Con el techo, la memoria de publicar y de verificar no depende del tamaño del dataset. Criterio: con un log sintético de R_100 que lleva a un dataset hasta el techo, el máximo de memoria residente de la publicación y de cada verificación (§8), con `WORKER_NODE_FLAGS`, no pasa de 256 MiB. Con el código de hoy, unos 15 800 eventos dieron 190 MiB al publicar y como mucho 229 MiB al reproducir («Medición»). Cada proceso informa su propio máximo (`process.resourceUsage().maxRSS`) en su salida, porque Render no tiene panel de memoria para un cron job.

### 8. Quién publica y cómo se verifica

`buoh-operaciones` (ADR-0018 §11) suma dos pasos, después del espacio. Cada uno corre en un proceso aparte, con `WORKER_NODE_FLAGS`, un entorno explícito con solo sus credenciales y los nombres `BUOH_*` que lee el worker, y su propio plazo de 60 s. Un paso que falla deja su alerta saneada y su informe, si PostgreSQL responde, y no impide los demás.

6. **Publicación.** `datasets:publish` (`apps/market-data-worker/dist/cli/publish-dataset.js --json`), con `buoh_publicacion` y el token `operaciones`. Publica como mucho un dataset por ejecución: el siguiente de §7 del log de menor número que no venció y tiene uno pendiente. Así, los logs que ya existen al desplegarlo se publican desde su segmento 0, del más viejo al más nuevo, a uno por ejecución: unos 12 datasets por hora, unas 7 horas para tres semanas de captura. Escribe una línea JSON con `published` (con el `dataset_id`, el log, los segmentos, los conteos y su memoria máxima), `nothing_due` o `failed` (con el paso y un motivo saneado), y el servicio la guarda en el informe del paso, en el log activo, solo si publicó o falló. Si al log más viejo con segmentos sin publicar le quedan menos de 3 días para vencer, deja la alerta `publication_behind`, que el runbook trata como urgente. La retención no espera a la publicación: los 30 días del log son la decisión del propietario.
7. **Verificación.** Para la publicación activa de `production` más antigua que todavía no tiene resultado en los dos modos, ejecuta `data:replay --json`, primero con `--verify-only` y después en recomputación, con `buoh_salud` y el token `salud`. En `production`, `data:replay` lee siempre `buoh_datasets` y el prefijo `datasets/`, sin `BUOH_POSTGRES_SCHEMA`, como `data:health` busca el log activo. El servicio guarda cada resultado concluyente en `dataset_verifications`, como `buoh_dueno`: el dataset, la publicación, el modo, `passed` o `failed`, el código de salida, el código de error saneado (`ReplayErrorCode`), el informe (`ReplayReport`, sin precios), la ejecución y la hora. Un resultado `failed` deja la alerta `dataset_verification_failed`, urgente en el runbook. Si un almacén no responde, no guarda nada y lo intenta en la ejecución siguiente. Así, cada dataset publicado se reproduce en los dos modos con el mismo `dataset_id` (`F2-DATASET-001`) poco después de publicarse.

En una ejecución normal, la publicación dura unos 15 s y la verificación unos 10 s, y solo corren cuando hay algo pendiente: cuatro veces al día, salvo al ponerse al día.

### 9. Fallos de publicación (pendientes 1 y 3 de F1.3)

- **Nada visible antes del `COMMIT`** (ADR-0004 §8). Lo hace visible una sola transacción que inserta el dataset, sus incidencias, su `PublishedManifestRecord` activo y su fila de `dataset_log_ranges`.
- **Un `COMMIT` ambiguo** (pendiente 1). Si la conexión cae durante el `COMMIT`, el fallo es `commit_outcome_unknown`, y no «no se confirmó». La ejecución siguiente vuelve a calcular el mismo dataset, con el mismo `dataset_id`, y comprueba antes de repetirlo si ya está: si tiene su publicación activa y su fila de rango, cuenta como publicado y sigue con el siguiente; si no, lo publica otra vez con otro `publication_id`. Una publicación activa sin la fila de rango, o con otro rango, es un error de programación: falla con `publication_conflict`. Una prueba de integración corta la conexión durante el `COMMIT`, en los dos casos.
- **Los nombres** (pendiente 3). `PublicationStep` toma los de `PersistenceStage`, sin cambiar ese contrato: `normalized_object_write` para cada objeto del dataset, también las copias de los segmentos, que son salidas de la publicación; `manifest_write` para el documento; y `manifest_commit` para la transacción. La consulta previa, si el dataset ya está publicado, es una lectura: su fallo queda en el informe del paso y en su alerta, no en el registro.
- **El registro operativo** (pendiente 3). Una escritura de la publicación que falla abre `persistence_unavailable`, con su etapa, en el registro de `buoh_datasets`, con el mismo `OperationalRegistry` que el log y las mismas reglas de causalidad (contratos de dominio, «Registro operativo de persistencia y límites»). La publicación siguiente que termina la resuelve. Si PostgreSQL no responde, solo quedan la alerta y el informe, como en el log.

### 10. La sección Datos, la Auditoría y la lectura por partes

- **Datos** (F2.4, 6b de [`PROJECT_STATUS.md`](../../../PROJECT_STATUS.md)) lee de `buoh_datasets`, con `buoh_api_lectura`, cada dataset de `production` con su identificador, su período (`event_time_from_utc` y `event_time_to_utc`), su log, sus conteos, sus incidencias y la última verificación de cada modo. No lee R2.
- **La Auditoría** (ADR-0019 §5 y §8) lee las publicaciones de `buoh_datasets` en lugar de las tablas de cada log, y así las publicaciones de producción llegan a la sección (`F2-AUDIT-001`). Como los datasets no vencen, sus publicaciones quedan en la sección, al contrario que los eventos de un log.
- **Lectura por partes** (F2.7). Cada parte de §7 se lee y se verifica por su hash antes de usarla, como pide `F2-BACKTEST-001`, y un lector nunca necesita más de una parte de cada rol a la vez. La ADR de la semántica del backtest decide cómo las recorre.

### 11. Costo

| Recurso | Al mes, aproximado |
|---|---|
| Espacio de R2 | unos 0,24 GB más; dentro de los 10 GB gratuitos durante unos 2 años |
| Operaciones de clase A de R2 | unas 11 000 más (unas 90 escrituras por dataset); la captura sigue en el segundo millón, así que no cambia los 4,50 USD |
| Operaciones de clase B de R2 | unas 45 000 más (unas 360 lecturas por dataset, al publicarlo y al verificarlo), dentro de los 10 millones gratuitos |
| Tráfico de salida de Render | unos 0,3 GB más (los cuerpos y las peticiones a R2): unos 0,05 USD |
| Cómputo del cron job | unos minutos más, dentro del mínimo de 1 USD |
| PostgreSQL | unos 3 MB más, dentro del disco de 1 GB |

En total, el sistema de datos sigue en unos 19 USD al mes, y la Fase 2, en unos 26 hoy y unos 33 con el motor (plan §11). No sube el presupuesto. Son estimaciones, y el PR de la evidencia (§13) las mide.

### 12. Pruebas

- **Sin red, reloj real ni azar:**
  - el perfil de publicación, sus bytes y su hash, y que el de medición no cambia;
  - las reglas 3.0.0 con el vector nuevo de §3, y que con las demás entradas dan lo mismo que 2.0.0;
  - el pliegue con el perfil de publicación, en cada límite de segmento de los logs sintéticos de ADR-0017 §9, frente a la derivación completa;
  - la elección del final de un dataset: la marca, el final limpio, la hora sin final limpio, el techo, un segmento que lo pasa solo y el último dataset de un log terminado;
  - las partes, con un dataset sintético de más de 5000 ticks, y que los vectores v1 no cambian;
  - los límites del replay al publicar;
  - los nombres de las etapas, el registro operativo y el `COMMIT` ambiguo, con almacenes falsos;
  - el perfil de cada log desde `log_quality_profile`, uno desconocido que falla cerrado, y los pasos 6 y 7 con sus entornos explícitos.
- **Integración** (PostgreSQL y almacenamiento S3-compatible locales):
  - `buoh_datasets`, sus migraciones y sus roles: con `buoh_publicacion` y `buoh_api_lectura`, `UPDATE`, `DELETE`, `TRUNCATE` y el DDL fallan con `42501`, y con `buoh_ingesta` no se lee nada;
  - publicar desde un log, en gzip, con sus rangos, y reproducir el dataset en los dos modos con el mismo `dataset_id`;
  - el `COMMIT` cortado, que se confirmó y que no;
  - la retención de un log que no toca `datasets/` ni `buoh_datasets`;
  - la fila de `log_quality_profile` antes de los privilegios, al preparar un log.
- **Memoria:** el criterio de §7, con un script de `scripts/evidencia-f2-5/`.
- **En producción, fuera de CI:** los datasets de los logs que existan, publicados y verificados en los dos modos, con la memoria que informa cada proceso, y la regla de bloqueo comprobada.

### 13. Secuencia de entrega

Cada PR es pequeño, con su revisión semántica:

1. Esta ADR, con su medición, el estado del proyecto y la decisión del propietario en el plan (§12).
2. Las reglas 3.0.0 y las partes en `packages/domain`, con el vector de §3 y la semántica en los [contratos de dominio](../contratos-de-dominio.md). Los vectores v1 no cambian.
3. La publicación en el worker: el perfil de publicación, el gzip de los derivados, los límites, el final de cada dataset, los rangos, el registro y el `COMMIT` ambiguo; `buoh_datasets` con sus migraciones y sus roles; `datasets:publish` y `data:replay` sobre los datasets en `production`; y la evidencia de memoria de §7. Si sale grande, en dos partes.
4. Los pasos 6 y 7 de `buoh-operaciones`, `BUOH_PUBLICACION_POSTGRES_PASSWORD` en `render-datos.yaml` y el runbook: la regla `datasets-indefinido`, que el propietario crea antes de fusionar, y la sección «borrar». Al fusionarlo, se publican los logs que existan. Tiene que llegar a producción antes de que venza el log 1, el 2026-12-02 a las 00:00:03 UTC, para guardar su día de datos, y antes de que venza el log 2, hacia el 2026-12-09, para guardar su semana.
5. El perfil de cada log: la migración `0007` de los logs y los lectores de §4, también el gráfico de la API.
6. La evidencia: los datasets publicados y verificados en producción, la memoria de cada proceso, el costo y el cambio de perfil en el corte. Con ella, F2.5 está hecho.

La sección Datos de F2.4 (6b) llega después del PR 4, cuando `buoh_datasets` existe en producción.

### Relación con ADR anteriores

- **ADR-0004:** §10 recibe sus umbrales live (§1). §8 y §9 no cambian: los datasets se publican y se reproducen igual, con sus artefactos por partes (§7). §13 es la retención de desarrollo: en `production`, la publicación es automática, como pide el plan (`F2-DATASET-001`).
- **ADR-0005:** el formato físico de §2 cambia para los derivados, que pasan a gzip (§7). §3 sigue: las claves llevan ahora el prefijo `datasets/`.
- **ADR-0015:** el estado vivo deja el perfil de medición de §2 en cada log preparado con el código del PR 5 (§4). Los ticks recuperados de §4 pasan a `MarketTick` (§3).
- **ADR-0017:** §8 sigue: la publicación y el replay no leen puntos de control. La publicación usa el pliegue de §3 solo para elegir dónde termina un dataset (§7).
- **ADR-0018:** la historia de las paradas programadas de §5 sigue, revisada con lo medido (§4). §7: los datasets no vencen (§6). §8 suma `buoh_publicacion` y los privilegios de `buoh_datasets`, y §10, el prefijo `datasets/` y su regla de bloqueo (§5). §11 suma los pasos 6 y 7 (§8).
- **ADR-0019:** §8: el gráfico arma el perfil del log, y el lector de las publicaciones de la Auditoría pasa a `buoh_datasets` (§4 y §10).

## Consecuencias

- Los datos de la captura dejan de perderse a los 30 días: cada 6 horas queda un dataset inmutable, verificado en los dos modos, que el laboratorio puede citar.
- Los datasets de producción guardan datos de Deriv sin plazo, más allá de lo que permiten sus términos (§6). Deriv puede cortar el acceso a su API sin aviso. La redistribución sigue deshabilitada.
- Hasta el corte que cambia el perfil, el estado vivo y los datasets usan perfiles distintos: un dataset puede marcar retrasos y resolver huecos de 2000 ms que el estado vivo de ese log no marca ni resuelve. No afecta a ninguna decisión, porque el motor llega en F2.9.
- Un dataset puede terminar con algo abierto si la captura no queda limpia en una hora, y entonces el siguiente empieza sin saberlo. Lo dicen sus incidencias y condiciones.
- Si un segmento pasa el techo por sí solo, la publicación de su log se detiene hasta un cambio del código.
- La regla indefinida impide borrar los huérfanos de una publicación fallida.
- La base y R2 crecen sin un borrado que los frene, y la revisión de §6 llega en un año y medio o dos.

## Alternativas descartadas

| Alternativa | Por qué no |
|---|---|
| Umbral de retraso en un percentil, como el p99,9 (476 ms) | Marcaría como tarde 1 de cada 1000 ticks, el ruido normal de la red, y no un episodio. |
| Umbral de hueco de 0 ms, que siempre pide la historia | Una separación de 2000 ms ya demuestra que no falta ningún tick, y la historia no lo demostraría mejor. |
| Un dataset por log, cada semana | Construir un día ya llega a 348 MiB con el código de hoy, y bajarlo exigiría una derivación por partes con orden canónico y duplicados en todo el dataset. |
| Un dataset por día | La misma memoria de un día. |
| Cortes cada 6 horas exactas, sin buscar un final limpio | Partirían huecos y conexiones caídas entre dos datasets, que no se entenderían solos. |
| Elegir el final con los puntos de control del log | ADR-0017 §8 no deja a la publicación leerlos, y el pliegue de sus propios segmentos da lo mismo sin depender de ellos. |
| Dejar los ticks de la historia en el raw | Los datasets tendrían huecos en los ticks con la continuidad demostrada. |
| Convertir también los de un resultado `partial` | Las reglas no tienen el esquema de `ticks_history` para separar sus páginas válidas, y el hueco sigue sin resolver. |
| Recuperar la historia de las paradas programadas | Exige otra regla de continuidad para 23 ticks en 11 días. |
| Cambiar el perfil del estado vivo al desplegar | Obliga a reconstruir los puntos de control del log en curso al arrancar `ingest`, con la captura parada mientras tanto. |
| Un bucket propio para los datasets | Necesita tokens nuevos sin quitar ningún permiso, porque el token `operaciones` ya escribe en `buoh-captura`, y lo protege igual la regla de bloqueo. |
| Las tablas de publicación de cada log | Se borran con el log a los 30 días (ADR-0018 §7). |
| Derivados sin comprimir | Ocupan casi 5 veces más en R2, y con datasets que no vencen eso adelanta la revisión de §6. |
| Opción A de §6, 30 días | La decidió el propietario: la B. |

## Condiciones de revisión

- Si en un mes más del 0,1 % de los ticks llevan `delivery_delayed`, o el intervalo de R_100 deja de ser de 2 s, se vuelven a medir los umbrales.
- Si R2 pasa de 8 GB o la base de 600 MB (§6).
- Si un segundo símbolo entra en la captura: sus umbrales, su perfil y el techo de §7.
- Si un backtest de F2.7 necesita leer por tiempo dentro de una parte.

## Referencias verificadas

- Cloudflare, [Bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/) (R2): las reglas de bloqueo impiden borrar y sobrescribir los objetos de un bucket o de un prefijo durante un plazo o de forma indefinida. Consultado el 2026-11-13.
- Deriv, la historia de R_100 (`ticks_history`, `style: ticks`) de los 7 silencios de «Medición», pedida por el WebSocket público el 2026-11-13: cada respuesta trajo solo los dos extremos.
