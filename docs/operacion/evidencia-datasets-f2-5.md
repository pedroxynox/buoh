# Evidencia de los datasets vivos de F2.5

Evidencia de `F2-THRESHOLD-001` y `F2-DATASET-001` ([plan de Fase 2](../plan/fase-2-laboratorio-y-bot-shadow.md)) en dos partes: la medición local de un dataset en el techo, del PR 3c de [ADR-0020](../arquitectura/adr/0020-datasets-vivos.md) §13, y la producción, del PR 6 («Producción (PR 6)», abajo). Con ella, F2.5 está hecho.

En producción, del 2026-11-14 a las 12:21 UTC al 2026-11-23 a las 00:01 UTC, `buoh-operaciones` publicó 88 datasets, todos con un final limpio, que cubren enteros los logs 1 a 4, y reprodujo cada uno en los dos modos con su mismo `dataset_id`. Ningún log se detuvo ni se atrasó. Desde el corte del 2026-11-23, el estado vivo se deriva con el perfil de publicación y la salud sigue `healthy`. La memoria de `buoh-operaciones`, sumando su proceso principal y su hijo más grande, pasa de los 256 MB de `F2-DEPLOY-001` en las ejecuciones que verifican un dataset, y el propietario lo aceptó el 2026-11-23 («La memoria de `buoh-operaciones`», abajo).

## Medición local (PR 3c)

Evidencia de memoria y de duración de la publicación y de la verificación de un dataset vivo (ADR-0020 §7 y §8), reunida el 2026-11-14 con el código del PR 3c de su §13, el de su primer commit, `b8550ee`. Con un dataset en el techo de 16 000 elementos, el máximo de memoria residente (RSS) de `datasets:publish` llegó a **195,8 MiB**, y el de `data:replay`, a **171,7 MiB** en `--verify-only` y a **191,9 MiB** en recomputación: los tres por debajo de los 256 MiB del criterio de §7, así que el techo de 16 000 elementos se queda. La publicación tardó como mucho **6,1 s**, y cada verificación, como mucho 1,2 s y 2,3 s, dentro del plazo de 60 s de cada paso (§8).

La medición no usa datos de mercado: la captura es sintética, con precios inventados, y ningún proceso se conecta a Deriv. Este documento solo trae memoria, tiempos, conteos y estados. Las credenciales locales se generaron en el sandbox, viajaron solo por el entorno de los procesos y nunca quedaron en Git.

### Entorno

- Sandbox de Kiro, sin Docker, con 31 GiB de memoria que Node ve. No es Render, así que las cifras absolutas son orientativas. Cada proceso corre con los tamaños de V8 de producción (`WORKER_NODE_FLAGS`: `--max-semi-space-size=1 --max-old-space-size=256`), los que eligen el máximo del montón con independencia de la memoria que ve Node (ADR-0017 §9).
- PostgreSQL 18.4 y SeaweedFS 4.48 portátiles, solo en `127.0.0.1` y sin TLS, del arnés de integración local que describe el steering del sandbox (`.kiro/steering/sandbox-ocasional.md`). Producción usa PostgreSQL 18 de Render y R2.
- Node.js 24.22.0, y la release de esquemas fijada `production_v20260901_0`, descargada de su URL fijada y comprobada con su SHA-256.
- `scripts/evidencia-f2-5/medir-datasets.mjs`, que no es un comando del producto, sobre el worker compilado.

### Cómo se midió

El script crea una base y un bucket desechables y escribe en ellos, con el `SourceEventLog` del worker, dos logs sucesivos de una captura sintética de R_100 con la forma de la de producción: un tick cada 2 s, un `pong` cada 45 s y segmentos de 5 minutos.

- El log 1 dura 12 horas: 22 559 eventos en 144 segmentos cerrados. Su primera conexión cae a la hora, sin historia, y la segunda sigue hasta el final. La continuidad queda pendiente, así que ningún final posible es limpio y el primer dataset termina en el último segmento que cabe en el techo (§7).
- El log 2 dura 5 minutos, para que el 1 esté terminado.

Después corre 3 repeticiones, cada una sobre una copia nueva de `buoh_datasets`, y en cada una tres procesos aparte con `WORKER_NODE_FLAGS`. Los objetos del bucket se quedan entre repeticiones, así que solo la primera escribe objetos nuevos, y las otras dos los encuentran ya escritos (`exists`) y los verifican:

1. `datasets:publish` (`dist/cli/publish-dataset.js`), que publica el primer dataset del log 1;
2. `data:replay --verify-only` (`dist/cli/replay.js`), con `buoh_datasets`;
3. `data:replay` en recomputación.

Cada proceso informa en su línea JSON su máximo de memoria residente (`max_rss_bytes`, de `process.resourceUsage().maxRSS`), en MiB de 1 048 576 bytes, y la publicación, su duración (`duration_ms`). Cuenta el mayor de las 3 repeticiones.

```bash
pnpm exec node scripts/evidencia-f2-5/medir-datasets.mjs --salida <archivo.json>
```

### Resultado

En las 3 repeticiones, el dataset es el mismo, de los segmentos 0 a 101, con 15 984 elementos (15 984 source events, sin ticks de la historia) y 15 299 ticks, y un final que no fue limpio. Ningún proceso dejó alertas. Su `dataset_id` cambia en cada ejecución del script, porque las horas de la captura salen del reloj.

| Repetición | Publicar | Su duración | `--verify-only` | Su duración | Recomputación | Su duración |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 195,8 MiB | 6092 ms | 170,5 MiB | 1224 ms | 191,9 MiB | 2313 ms |
| 2 | 183,1 MiB | 6080 ms | 170,3 MiB | 1231 ms | 191,6 MiB | 2157 ms |
| 3 | 194,3 MiB | 6092 ms | 171,7 MiB | 1231 ms | 189,1 MiB | 2302 ms |
| **Máximo** | **195,8 MiB** | **6092 ms** | **171,7 MiB** | 1231 ms | **191,9 MiB** | 2313 ms |

Una ejecución anterior, con el mismo código salvo una corrección de lint en la escritura concurrente, dio 191,0, 168,4 y 191,8 MiB y 6274 ms: la memoria varía unos pocos MiB entre ejecuciones.

La duración de la publicación es la que informa el proceso (`duration_ms`), desde que terminó de cargar sus módulos hasta que escribe su línea: medido desde fuera, el proceso entero tardó unos 0,2 s más (como mucho 6309 ms). Incluye el plan del dataset, la lectura de sus 102 segmentos, su derivación, la escritura de sus objetos 8 a la vez y el `COMMIT`. La de la verificación es la del proceso entero, medida desde fuera.

### Lectura

- **Memoria.** Los tres procesos quedan por debajo de 256 MiB, con unos 60 MiB de margen la publicación, la más alta. Con el código de antes de ADR-0020, unos 15 800 eventos daban 190,7 MiB al publicar y como mucho 229,0 MiB al reproducir en el mismo proceso («Medición» de ADR-0020): ahora cada verificación corre en su propio proceso, como el paso 7 de §8. La memoria de la publicación varía entre repeticiones porque depende de cuándo recoge V8 la basura.
- **Duración.** Unos 6 s en local, por debajo de los 15 a 30 s que estimaba §8 para producción, donde R2 está lejos y la escritura de cada objeto tarda más. La de producción está abajo («Memoria y duración de cada proceso»).
- **Límites.** Un solo dataset sintético en el techo, en el sandbox. No mide un dataset con muchos ticks de la historia ni la red de producción.

## Producción (PR 6)

### Cómo se midió

El agente leyó producción el 2026-11-23, de las 00:25 a las 00:48 UTC, con su acceso de solo lectura ([runbook de ingesta](runbook-ingesta-de-datos.md), «Acceso del agente»): el rol `buoh_agente`, con `verify-full` y en transacciones de solo lectura, y el token `agente`. Mientras leía, la única sesión de `buoh_agente` era la suya. La duración de las ejecuciones sin dataset («El costo») la leyó después, a las 01:06 UTC, y la volvió a leer a las 01:20 UTC, con el mismo resultado, porque el log 4 ya no cambia; en esa última lectura, la única sesión de `buoh_agente` también era la suya.

- En `buoh_datasets`: `published_manifest_records`, `dataset_log_ranges`, `dataset_verifications`, `dataset_quality_incidents` y el registro de la publicación (`operational_incidents` y `operational_conditions`).
- En los logs 1 a 6: los informes de `buoh-operaciones` (`operations_reports`), los segmentos cerrados, los latidos y el índice de los source events, los puntos de control del estado vivo (`live_derivation_checkpoints`) y la fila de `log_quality_profile`.
- En `buoh-captura`, con `ListObjectsV2` por páginas de 1000, los objetos del prefijo `datasets/`.
- `data:health` de producción, con el comando de «Acceso del agente», a las 00:25 UTC: `healthy`, `connected`, sin condiciones abiertas y con salida 0.

Las cifras de memoria están en bytes en las tablas, y aquí en MB de 10⁶ bytes, la unidad de `F2-DEPLOY-001`, con los MiB de 1 048 576 bytes de la medición local cuando hay que compararlas. Este documento no trae secretos, precios ni identificadores de cuenta.

### Los datasets publicados

`buoh-operaciones` empezó a publicar en la ejecución de las 12:20 UTC del 2026-11-14, la primera después de fusionar el PR 4 (PR #107): su informe `roles_and_logs` lleva `datasets_migrated: ["0001_datasets.sql"]`, `passwords_set: ["buoh_publicacion"]` y ningún fallo, y `buoh_datasets` tiene sus ocho tablas. La regla `datasets-indefinido` sobre `datasets/` la creó el propietario antes de fusionarlo, y su captura de la tarjeta de Cloudflare la mostraba junto a `logs-30-dias` (comentario del PR #107). El token `agente` no puede escribir, así que el agente no la ha probado de otra forma.

| Log | Datasets | Segmentos | Publicados (UTC) |
|---:|---:|---|---|
| 1 | 4 | 0 a 286, los 287 cerrados | 2026-11-14, de 12:21 a 12:36 |
| 2 | 28 | 0 a 2012, los 2013 cerrados | 2026-11-14, de 12:40 a 14:56 |
| 3 | 28 | 0 a 2013, los 2014 cerrados | del 2026-11-14 a las 15:01 al 2026-11-16 a las 00:02 |
| 4 | 28 | 0 a 2007, los 2008 cerrados | del 2026-11-16 a las 06:11 al 2026-11-23 a las 00:01 |

- **Al ponerse al día**, publicó 54 datasets seguidos, uno por ejecución, de las 12:21 a las 16:46 UTC del 2026-11-14: los de los logs 1 y 2 y los primeros 22 del log 3. Después, cuatro al día, unos minutos después de cada marca de 6 horas (ADR-0020 §7). El último del log 4, el de sus segmentos 1937 a 2007, se publicó a las 00:01:34 UTC del 2026-11-23, en la primera ejecución después del corte, sin esperar la marca, como un log terminado.
- **Los 88** tienen su publicación activa en `production` y su fila de rango, con un final limpio y sin condiciones abiertas. Tienen de 10 612 a 11 490 elementos, lejos del techo de 16 000: 990 531 source events, 948 780 ticks normalizados y 323 incidencias, como mucho 38 en un dataset. De esos elementos, 1843 son ticks que trajo la historia (`origin: history_recovery`), que las reglas 3.0.0 convierten en `MarketTick` (ADR-0020 §3).
- **Ningún informe de la publicación** falló ni llevó un log detenido, una cuenta de ejecuciones sin resultado o `behind`. Ninguno nombra `publication_not_derivable`. El registro de la publicación en `buoh_datasets` no tiene incidencias ni condiciones: ninguna escritura falló.

### La verificación

`dataset_verifications` tiene 176 filas: para cada uno de los 88 datasets, un `passed` en `verify-only` y otro en `recompute`, los dos en la misma ejecución que lo publicó. Cada informe guardado (`ReplayReport`) lleva el `dataset_id` y el `publication_id` de su fila, `production` y el estado `verified` o `reproduced`: cada dataset se reproduce en los dos modos con su mismo `dataset_id` (`F2-DATASET-001`). La primera verificación terminó como mucho 35,0 s después de publicarse el dataset, y la recomputación, como mucho 49,9 s (medianas de 18,1 y 31,4 s).

### Memoria y duración de cada proceso

La memoria de cada proceso hijo sale del paso `memory` de `buoh-operaciones` (runbook de ingesta, «Paso 8, `memory`»), que lo guarda en cada ejecución desde la de las 21:56 UTC del 2026-11-17, cuando llegó el PR #121. Es el `VmHWM` de cada hijo, que no arrastra la memoria del principal. Ventana: 1471 ejecuciones, del 2026-11-17 a las 21:56:10 al 2026-11-23 a las 00:25:57 UTC, una cada 5 minutos, ninguna sin su informe `memory`: 288 al día cada día entero, y nunca más de 6 min 49 s entre dos informes de la salud.

| Proceso | Memoria máxima | Mediana | Lanzado en la ventana |
|---|---:|---:|---:|
| `buoh-operaciones`, el principal | 94,8 MB (90,4 MiB) | 91,0 MB | 1471 veces |
| `datasets:publish` (`publish`) | 162,1 MB (154,5 MiB) | 91,5 MB | 1471 |
| `data:replay` (`replay`), los dos modos | 178,7 MB (170,4 MiB) | 147,8 MB | 42 |
| `data:health` (`health`) | 105,7 MB | 97,2 MB | 1472 |
| `db:migrate` de los logs (`migrate`) | 83,0 MB | 76,1 MB | 7361 |
| `db:migrate` de la API (`api_migrate`) | 81,6 MB | 77,4 MB | 1471 |
| las migraciones de `buoh_datasets` (`datasets_migrate`) | 79,9 MB | 76,1 MB | 1471 |

Ningún hijo dejó su memoria en `null`. La mediana de `publish` es la de las ejecuciones sin nada pendiente, casi todas. Las líneas de los procesos de los 88 datasets, que traen su `process.resourceUsage().maxRSS` y pueden incluir parte de la memoria del principal (runbook, «Paso 8, `memory`»), llegaron a 168,3 MB (160,5 MiB) al publicar, 149,7 MB (142,7 MiB) en `verify-only` y 181,7 MB (173,3 MiB) en recomputación. Todo queda por debajo de lo medido en local con un dataset en el techo («Medición local (PR 3c)»).

**Duración.** La publicación tardó de 13,1 a 20,2 s (mediana 16,3 s), en el extremo bajo de los 15 a 30 s que estimaba ADR-0020 §8 y dentro del plazo de 60 s del paso: es el `duration_ms` de su línea. La verificación, medida entre las horas que guarda cada ejecución, desde el informe de la publicación hasta cada fila de `dataset_verifications`, incluida la carga de cada proceso, tardó de 7,9 a 26,0 s en `verify-only` (mediana 11,2 s) y de 10,7 a 18,3 s en recomputación (mediana 13,1 s). Los dos modos juntos tardaron como mucho 40,8 s: más que los unos 10 s que estimaba §8, y dentro de los 60 s del paso.

### La memoria de `buoh-operaciones`

`F2-DEPLOY-001` pide comparar con los 256 MB, la mitad de los 512 MB del Starter, la memoria del proceso principal y la de uno de sus hijos juntos, con el mayor de lo medido en producción y en el techo de ADR-0020 §7. Los pasos y sus procesos corren de uno en uno, así que el máximo de la instancia no pasa de la suma del principal y del mayor de sus hijos (runbook, «Paso 8, `memory`»).

- **Medido en producción.** La suma más alta de una ejecución fue de 269,4 MB (256,9 MiB), el 2026-11-20 a las 18:11:49 UTC: 90,7 MB del principal y 178,7 MB de `data:replay`. Pasa de 256 MB en 20 de las 21 ejecuciones de la ventana que verificaron un dataset, y de 256 MiB en 2. Las 1450 que no verificaron ninguno llegaron como mucho a 198,2 MB.
- **Con el techo.** El principal, 94,8 MB, y la publicación de un dataset de 16 000 elementos, 205,3 MB (195,8 MiB en local), suman unos 300 MB.
- **Lo que la suma cuenta dos veces.** El código y las bibliotecas de Node que el principal y su hijo cargan del mismo archivo son páginas compartidas. En el sandbox, un proceso de Node 24.22.0 sin nada cargado tiene 35,8 MB (34,1 MiB) de memoria residente de archivos (`RssFile`), que la suma cuenta en los dos procesos. Es una medición local, no de Render, así que la instancia probablemente usa menos que la suma, sin que esté medido cuánto.
- **Ninguna ejecución se cortó**, y lo más alto queda a más de 200 MB de los 512 MB del Starter.

Así que el principal y su hijo más grande juntos no caben en los 256 MB. El agente se lo presentó al propietario con tres opciones: A, aceptarlo y dejarlo escrito aquí, su recomendación; B, medir la memoria de la instancia con un PR de código, si Render deja leerla; y C, bajarla con código, por ejemplo con datasets más pequeños. El propietario eligió la A el 2026-11-23, y cuándo se le vuelve a presentar lo dicen las [decisiones vigentes](../gobierno/decisiones-vigentes.md) («Memoria medida de `buoh-operaciones`»).

### El cambio de perfil en el corte

El log 4 se derivó con el perfil de medición y el log 5 es el primero con el de publicación, `deriv_options-publication-v1-R_100` y las reglas 3.0.0 ([runbook de ingesta](runbook-ingesta-de-datos.md), «El perfil de cada log (ADR-0020 §4)»).

- **El corte.** El último latido del log 4 es de las 00:00:01.298 UTC del 2026-11-23, el primero del log 5 de las 00:00:02.805, y su primer source event de las 00:00:03.662.
- **La fila del log 5** en `log_quality_profile` es `deriv_options-publication-v1-R_100`, con el SHA-256 `1c81b3aba106d53bae9acfd7c666bad14c16830025aa4e095c55307960aea775`, que le dio `buoh-operaciones` el 2026-11-16 a las 00:01:35.975 UTC. Es la misma fila que arma el código de `main` (`derivLogProfileRow('R_100')`, en `6807265`).
- **Los puntos de control del log 5**, los 5 escritos hasta las 00:25:06 UTC, de los segmentos 0 a 4, llevan ese `quality_profile_sha256` y `quality_rule_version` 3.0.0. Los 2008 del log 4, que no tiene fila, llevan todos otro SHA-256, el del perfil de medición, y las reglas 2.0.0.
- **La salud.** Los 6 informes de la salud del log 5, de las 00:01 a las 00:25 UTC, dan `healthy` y `connected`, sin condiciones abiertas ni alertas, como el `data:health` del agente a las 00:25. El informe final del log 4 (`final_health`), a las 00:01:13, da `paused` y `disconnected`, sin condiciones abiertas: el de un log terminado sin escritor (runbook, «Paso 2, `final_health`»).
- **El log 6** ya está preparado, desde las 00:01:02 UTC, con la misma fila.

La línea de `ingest` con `quality_profile_id` solo se escribe al terminar el proceso, en los **Logs** de Render, así que el agente no la ve: lo comprueban los puntos de control.

### El costo

Lo que suman los datasets, medido con lo que ve el agente, frente a lo que estima ADR-0020 §11. Al mes son unos 120 datasets, cuatro al día.

| Recurso | Medido | Al mes | Estimación de §11 |
|---|---|---|---|
| Espacio de R2 | `datasets/` tiene 6805 objetos y 180,2 MB: 6717 objetos de contenido (175,4 MB) y 88 documentos de manifiesto (4,8 MB), unos 2,05 MB por dataset | unos 0,25 GB | unos 0,24 GB |
| Operaciones de clase A | unos 77 objetos nuevos por dataset | unas 9300 | unas 11 000 |
| Operaciones de clase B | cálculo con los conteos: cada lectura es un `HeadObject` y un `GetObject`, la verificación lee los unos 78 objetos del dataset en cada modo y la publicación sus unos 72 segmentos, unas 450 por dataset | unas 55 000 | unas 75 000 |
| Tráfico de salida de Render | cálculo: los bytes escritos y alrededor de 1 KB por petición | unos 0,3 GB | unos 0,3 GB |
| Cómputo del cron job | unos 40 s por dataset (publicación y verificación). Además, en cada ejecución sin dataset, 1,5 s de media entre el informe de la verificación periódica y el de la memoria, que incluyen `datasets:publish` sin nada pendiente (1445 ejecuciones del log 4). La preparación de `buoh_datasets` del paso 1 (su rol, sus migraciones, sus privilegios y la comprobación de la contraseña de `buoh_publicacion`) corre en todas, y los informes no dejan medir su duración | unos 300 minutos: unos 80 de los datasets y, como mucho, unos 220 de las unas 8520 ejecuciones sin dataset, más esa preparación | unos minutos más, dentro del mínimo de 1 USD |
| PostgreSQL | `buoh_datasets` ocupa 1,7 MB con 88 datasets; la base, 319,2 MB el 2026-11-23, por debajo de los 600 MB de ADR-0018 §7 | unos 2,3 MB | unos 3 MB |

Las escrituras que encuentran la clave ya escrita no dejan un objeto nuevo, así que la clase A puede ser algo mayor que el conteo. El espacio, las operaciones de R2, el tráfico de salida y PostgreSQL caben en lo que estima §11, que no sube el presupuesto (plan §11). El cómputo, unas 5 horas al mes, es más que los «unos minutos» de §11: Render cobra el cron job por segundo, con un mínimo de 1 USD al mes (ADR-0018, «Contexto»), y el agente no ve si con ellas lo pasa. Los paneles de Cloudflare y de Render no se copiaron para este PR, y dan totales, sin separar lo de los datasets. Los que copia el propietario el día del primer borrado, el 2026-12-02 ([runbook de ingesta](runbook-ingesta-de-datos.md), «El primer borrado»), dicen si el total sigue en lo que estima el plan (§11), y ese día el agente le pide también el uso de `buoh-operaciones` en la facturación de Render (`PROJECT_STATUS.md`, «Siguiente tarea autorizada»).

### Límites

- **La memoria de la instancia** de `buoh-operaciones` no está medida: la suma del principal y de un hijo es un techo, que cuenta dos veces lo compartido.
- **La clase B y el tráfico de salida** son cálculos con los conteos, no lecturas de los paneles. El cómputo del cron job no cuenta la duración de la preparación de `buoh_datasets` del paso 1, y su costo no lo ve el agente.
- **Los datasets de producción** no traen un hueco de muchas horas ni uno que pase el techo, así que la producción no ha recorrido `publication_segment_too_large` ni los finales que no son limpios. Los cubren las pruebas (ADR-0020 §12) y la medición local.
- **La regla de bloqueo** solo se conoce por la captura del propietario: el agente no puede escribir para probarla.
- **El último dataset del informe de la salud.** El `data:health` de producción y los informes de la salud que guarda `buoh-operaciones` daban `last_published_dataset_id: null` con los 88 datasets publicados: `data:health` lo buscaba en las tablas de publicación del log observado (`lastActiveDatasetId`, en `apps/market-data-worker/src/postgres/metadata-store.ts`), y los de producción viven en `buoh_datasets` (ADR-0020 §5). No es un criterio de `F2-DATASET-001`, sino del último dataset del Observatorio de `F2-UI-001`. Lo corrigió el PR #130: en `production`, `data:health` lo lee de `buoh_datasets` (runbook de ingesta, «Salud de datos (`data:health`)»).
