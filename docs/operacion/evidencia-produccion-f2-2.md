# Evidencia de producción de F2.2

Evidencia de los 7 días seguidos de captura en producción que piden `F2-DEPLOY-001` y `F2-RETENTION-001` ([plan de Fase 2](../plan/fase-2-laboratorio-y-bot-shadow.md)) y [ADR-0018](../arquitectura/adr/0018-sistema-de-datos-en-produccion.md) §13, el PR 9 de su §16. Cubre del 2026-11-06 a las 00:00 UTC al 2026-11-13 a las 00:00 UTC, los días que mostraban los paneles de Render que copió el propietario el 2026-11-12. Con ella, F2.2 está hecho.

En esos 7 días, la captura de R_100 corrió sin más paradas que dos despliegues de unos segundos. La salud que guardó `buoh-operaciones` cada 5 minutos fue `healthy` en 2008 de sus 2016 informes, y los otros 8 tienen su causa, abajo. La memoria de `buoh-ingesta` queda por debajo de los 256 MB de `F2-DEPLOY-001`, y la de `buoh-operaciones`, que Render no mide, con lo que decidió el propietario (abajo, «La memoria»); el espacio, por debajo de los umbrales de ADR-0018 §7; y las operaciones de R2 y el tráfico de salida, dentro de lo que estiman sus §13 y §14.

Este documento no trae secretos, IDs de cuenta ni precios.

## Cómo se midió

- **El agente**, con su acceso de solo lectura ([runbook de ingesta](runbook-ingesta-de-datos.md), «Acceso del agente»): el rol `buoh_agente`, con `verify-full`, en una transacción de solo lectura, y el token `agente`. Leyó el 2026-11-17, entre las 17:55 y las 18:00 UTC, los esquemas `buoh_log_000002`, que cubre hasta el corte del 2026-11-09, y `buoh_log_000003`: los latidos de `ingest` (`ingestion_heartbeats`), el índice de los source events (`source_event_index`), los segmentos cerrados (`closed_source_segments`), los incidentes y las condiciones del registro operativo y los informes de `buoh-operaciones` (`operations_reports`). Con el token, contó los objetos de `logs/000002/` y leyó dos segmentos del log 3. Mientras leía, la única sesión de `buoh_agente` era la suya.
- **El propietario** copió el 2026-11-12, con capturas de pantalla y antes de las 21:34 UTC, los paneles de Render y de Cloudflare: en Render, **Metrics** de `buoh-ingesta`, `buoh-operaciones` y `buoh-postgres`, del 2026-11-06 al 2026-11-12; en R2, las tarjetas de «Últimos 30 días», con actividad solo desde el 2026-10-31. Sus cifras son lecturas de los gráficos, que el agente anotó ese día en `PROJECT_STATUS.md`. Las capturas son imágenes de la conversación, no archivos del repositorio, y Render ya no muestra esos días.

## La captura

La captura corrió las 168 horas. Un solo proceso de `ingest` capturó desde antes de la ventana hasta el 2026-11-12 a las 21:50 UTC, también a través del corte semanal, con el mismo bloqueo de la fuente (ADR-0018 §6; la sesión 540181 de PostgreSQL en sus latidos). Después hubo dos despliegues. Los frames de Deriv por día UTC:

| Día | Frames |
|---|---|
| 2026-11-06 | 45 106 |
| 2026-11-07 | 45 120 |
| 2026-11-08 | 45 120 |
| 2026-11-09 | 45 082 |
| 2026-11-10 | 45 124 |
| 2026-11-11 | 45 130 |
| 2026-11-12 | 44 917 |

- **El corte semanal** del log 2 al log 3, el 2026-11-09: el segmento 2012 del log 2 se cerró como `requested` con su último evento a las 00:00:01.786, la conexión del log 3 se abrió a las 00:00:05.594, y el informe final del log 2 (`final_health`) se guardó a las 00:01:32 UTC (runbook, «Corte semanal»).
- **Los dos despliegues** de `buoh-ingesta`, el 2026-11-12, los de los PR #97 y #99 ([evidencia de F2.4](evidencia-datos-f2-4.md), «Las lecturas de R2, Mercados y los eventos de datos»), cerraron su conexión a petición, como pide ADR-0018 §3: el segmento 1121 como `requested` a las 21:50:43.136, y el 1144 a las 23:43:24.380. Ninguno dejó un cierre `close_not_recorded`. Fueron unos 5 y 7,4 s sin mensajes de Deriv.
- **Los huecos más largos entre dos frames**, fuera de la parada de la fuente de abajo, fueron de 45,8 s, el 2026-11-09 a las 17:42:46, por una escritura en R2 que falló; de 25,0, 24,2, 18,6, 14,4 y 8,4 s, por las otras cinco; de 10,5 s, el 2026-11-07 a las 15:38:16, en una reconexión; de 8,7 s, el 2026-11-10 desde las 23:03:54, con el cierre de las 23:04:00 dentro; y de 9,9 s, el 2026-11-09 a las 12:06:05, sin ningún cierre ni incidente.
- **Las reconexiones.** Hubo 46 cierres de la conexión sin `requested`: 6 los hizo `ingest` después de una escritura en R2 que falló (abajo, «La salud»), y 40 llegaron de Deriv o de la red. Después de cada uno, `ingest` volvió a conectar en menos de 10 s y guardó el resultado de la recuperación de la historia (`history_recovery_result`) entre 4 y 16 s después del cierre. Ningún informe de la salud tiene un hueco sin recuperar (`event_gap_unresolved`) abierto.
- **Una parada de la fuente con la salud `healthy`.** El 2026-11-12, Deriv no mandó ningún tick de R_100 entre las 06:16:18.029 y las 06:22:44.075 UTC, 6 min 26 s, ni entre las 06:04:06 y las 06:04:38, 32 s. La conexión siguió abierta: en los segmentos 935 y 936 del log 3 solo llegaron las respuestas al `ping` del keepalive, cada 45 s (`KEEPALIVE_INTERVAL_MS`). Los informes de la salud de esos minutos dieron `healthy`, porque `data:health` mide la conexión, las condiciones y el último dato durable, no la antigüedad del último tick. Una estrategia sí se detiene por eso, con `max_data_age_ms` ([ADR-0022](../arquitectura/adr/0022-modelo-de-estrategia.md) §7), y la ADR del motor `shadow` lo tiene en cuenta.

## La salud

`buoh-operaciones` guardó 2016 informes de la salud en los 7 días, 288 al día, uno por ejecución, todos `completed`, y ninguna ejecución falló. 2008 dieron `healthy`. Los otros 8:

| Hora (UTC) | Salud | Causa |
|---|---|---|
| 2026-11-06 00:35:23 | `paused`, `persistence_unavailable` abierta | el almacenamiento: R2 respondió `InternalError` a la escritura de un evento a las 00:35:18.938; la condición se resolvió a las 00:35:23.256, con la reconexión |
| 2026-11-09 23:16:01, 2026-11-10 00:20:56, 01:11:06 y 03:06:24 | `paused`, con la alerta `data_health_storage_unavailable` y el motivo `deadline_exceeded` | el almacenamiento, para `data:health`: no pudo observar el log en los 30 s de su plazo (runbook, «Salud de datos», regla 3). La captura siguió: ningún hueco entre frames de esas horas pasa de 8 s |
| 2026-11-11 06:25:56 y 10:05:48 | `recovering` | una desconexión de Deriv a las 06:25:44 y a las 10:05:39, con la historia recuperada a las 06:25:53 y a las 10:05:44 |
| 2026-11-12 14:45:42 | `paused`, con `data_health_storage_unavailable` y `ETIMEDOUT` | el almacenamiento, para `data:health`, como los cuatro de arriba; la captura siguió |

El informe final del log 2, a las 00:01:32 del 2026-11-09, da `paused` y `disconnected`, sin condiciones abiertas: es el de un log que terminó en el corte, sin escritor (runbook, «Paso 2, `final_health`»).

Entre dos informes hubo además 5 escrituras en R2 que fallaron y no cayeron en ninguno, con su `persistence_unavailable` abierta y resuelta en el registro operativo: el 2026-11-06 a las 00:10:04, 4,6 s, y a las 00:48:56, 20,6 s, con `InternalError`; y el 2026-11-09 a las 14:00:00, 11,0 s, y a las 15:32:32, 17,4 s, con `ServiceUnavailable`, y a las 17:43:14, 16,9 s, con `InternalError`. En las seis, `ingest` cerró la conexión, volvió a conectar y recuperó la historia del hueco (ADR-0015).

## La memoria

| Servicio | Memoria máxima, del 2026-11-06 al 2026-11-12 | Techo de `F2-DEPLOY-001` |
|---|---|---|
| `buoh-ingesta` | unos 100 MB, leídos del gráfico de **Metrics** | 256 MB |
| `buoh-operaciones` | no medida: Render no la muestra (abajo) | 256 MB |
| `buoh-postgres` | de 100 a 170 MB, como contexto | — |

**La memoria de `buoh-operaciones`.** En su página **Metrics** de Render solo salen las métricas de red: lo vio el propietario el 2026-11-12 y lo confirmó su captura del 2026-11-17, aunque la [documentación de Render](https://render.com/docs/service-metrics) dice que muestra la memoria de todos los servicios salvo los sitios estáticos. Lo que sí se sabe:

- **Ninguna ejecución se cortó.** Las 2016 de la ventana guardaron sus informes `health` y `verification`, todos `completed`. Render corta la instancia que pasa de los 512 MB del Starter, y un corte antes de su último paso habría dejado alguna ejecución sin el informe de ese paso: no falta ninguno.
- **Su proceso hijo, medido aparte.** En la ventana, el único hijo de cada ejecución era `data:health`, porque la publicación de los datasets empezó el 2026-11-14. Con un log de 7 días, `data:health` llegó a 118 MiB con los tamaños de V8 con los que arranca («Evidencia de F2.1» en `PROJECT_STATUS.md`; [evidencia de memoria de F2.1](evidencia-memoria-f2-1.md)). Desde el 2026-11-14 también corren la publicación y la verificación de ADR-0020, que llegaron a 195,8 y 191,9 MiB en el techo, medidas en local ([evidencia de los datasets vivos](evidencia-datasets-f2-5.md)).
- **Lo que falta.** El proceso principal de `buoh-operaciones` no se ha medido, y la instancia corre a la vez el principal y su hijo. Así que no está demostrado que el total quede por debajo de los 256 MB de `F2-DEPLOY-001`.

El propietario decidió el 2026-11-17 cerrar F2.2 con lo que sí se sabe («A»; precisión del PR 9 de ADR-0018 §13 y de `F2-DEPLOY-001`). Un PR de código suma a los informes de `buoh-operaciones` la memoria máxima de su proceso principal y de cada hijo, y la evidencia de F2.5 la registra con lo medido en producción.

## El espacio

| Medida | Valor | Umbral para revisar la retención (ADR-0018 §7) |
|---|---|---|
| La base, con `pg_database_size`, en el paso `space` | de 80,0 MB el 2026-11-06 a 163,2 MB el 2026-11-12, unos 13,9 MB más al día | 600 MB |
| El disco de la base en **Metrics**, con el WAL | unos 250 MB de 1 GB, el 2026-11-12 | 700 MB |
| `buoh-captura` en R2 | unos 410 MB, el 2026-11-12 | 8 GB |

El log 2, con 7 días, ocupa 96,4 MB de la base, y el log 3 llevaba 41,7 MB el 2026-11-12 a las 00:00 UTC. Es lo que estima §7, unos 14 MB al día por log.

**Los objetos de `logs/000002/`** (precisión del PR 8b de ADR-0018 §16). El 2026-11-17, entre las 17:58:25 y las 17:59:38 UTC, con el token `agente`, `ListObjectsV2` por páginas de 1000 contó 317 068 objetos, todos bajo `logs/000002/sha256/`, con 248 588 076 bytes, en 318 páginas. El log 2 se cortó el 2026-11-09, y `ingest` nunca vuelve a escribir en un log terminado, así que es el mismo recuento que justo después de su corte. Son los 2013 objetos de sus segmentos cerrados, los 315 018 de sus eventos, los 35 documentos de sus versiones del catálogo y 2 que no cita ninguna de esas tablas. Después del primer borrado, el 2026-12-02, el agente los vuelve a contar, y tienen que salir 317 068 (runbook, «El primer borrado»).

## Las operaciones de R2 y el tráfico de salida

| Medida, el 2026-11-12 | Lo que mostró | Al mes, al mismo ritmo | Lo que estima ADR-0018 |
|---|---|---|---|
| Operaciones de clase A, desde el 2026-10-31 | 538 710, unas 45 000 al día | unos 1,35 millones | unos 1,35 millones (§14) |
| Operaciones de clase B, desde el 2026-10-31 | 1,67 millones, unas 140 000 al día | unos 4,2 millones | unos 4,7 millones, dentro de los 10 millones gratuitos (§14) |
| Tráfico de salida en el mes, del 2026-11-01 al 2026-11-12 | `buoh-ingesta`, 1,96 GB; `buoh-operaciones`, 423 MB; `buoh-api`, 12 MB ([evidencia de F2.3](evidencia-api-f2-3.md)): unos 2,4 GB | unos 6 GB | unos 7 GB (§13); unos 8,4 GB desde el primer borrado, el 2026-12-02, que esta ventana no incluye |

No consta si las tarjetas eran del bucket o de la cuenta. Si eran de la cuenta, incluyen también las pocas operaciones de las comprobaciones previas en `buoh-prueba`, el 2026-10-31; desde entonces, `buoh-captura` es el único bucket. Las tarjetas mostraban también 51 errores en esos días: 26 `500` y, por diferencia con el total, 4 `503`, errores de R2 como los de las escrituras fallidas de «La salud»; 14 `409`, la respuesta de la regla de bloqueo a una clave que ya existe (precisión de ADR-0018 §10); y 7 `404`. Después de la ventana, el 2026-11-17, ya con la publicación de los datasets vivos, `buoh-operaciones` llevaba 817 MB en el mes, todos iniciados por el servicio, de 1 a 5 MB por hora y con unos 35 MB por hora el 2026-11-14, cuando la publicación se puso al día (captura del propietario). Todo cabe en el presupuesto del plan §11: la clase A pasa del millón gratuito, como prevé §14, y el tráfico de salida pasa de los 5 GB incluidos menos de lo que estima.

## Límites

- **La memoria de `buoh-operaciones`** no la mide Render, y su proceso principal no se ha medido. Lo que se sabe, arriba, acota su instancia por debajo de los 512 MB del Starter, no de los 256 MB; la medida completa llega con un PR de código.
- **Las cifras de los paneles** son lecturas de los gráficos, sin una hora de copia exacta, salvo que fue antes de las 21:34 UTC del 2026-11-12. Los dos despliegues de esa noche quedan fuera de esos paneles.
- **Los episodios entre dos informes.** La salud se guarda cada 5 minutos, así que lo que dura menos puede no caer en ningún informe. Los cortes de la conexión y las escrituras fallidas salen del log y del registro operativo, con todas sus horas.
- **La parada de la fuente** del 2026-11-12 no la ve `data:health`, que dio `healthy`. Lo que hace una estrategia con ella lo fija la ADR del motor `shadow`.
