# Evidencia del PR 2d de F2.5b: dos sesiones de `ingest` y el oro cerrado

Evidencia de las tres partes que [ADR-0021](../arquitectura/adr/0021-mercados-reales-y-fuentes-de-investigacion.md) lleva al PR 2d, antes del PR 3 (§9, «Precisión del PR 2c»): la memoria de dos sesiones de §1, la prueba de integración de §8 con dos sesiones de `ingest` en un proceso y la comprobación de `MarketIsClosed` con el oro de §2. Las tres se cumplen. El oro cabe en `buoh-ingesta`, las dos sesiones capturan cada una en su log, con su bloqueo, y el oro cerrado responde como espera el worker.

## La memoria de dos sesiones

Se midió el 2026-11-24, de 03:25 a 04:48 UTC. Un solo proceso con dos sesiones de ingesta, R_100 y el oro (`frxXAUUSD`), cada una con un log sintético de 7 días, reconstruyendo a la vez sus puntos de control. Su máximo de memoria residente fue de 135,6 MiB, por debajo de los 256 MB de §1, que son MiB (ADR-0016, «Medición»): el oro cabe en `buoh-ingesta`, sin un servidor propio.

La medición no usa datos de mercado: los logs son sintéticos, con precios inventados, y ningún proceso de la medición se conecta a Deriv. Este documento solo trae memoria, tiempos, conteos, estados y, del oro cerrado, el horario y la respuesta de Deriv, sin ningún precio. Las salidas crudas quedaron fuera de Git.

### Entorno

- Sandbox de Kiro, sin Docker: 8 núcleos y 30 GiB de memoria, sin ningún límite de memoria que Node pueda ver. No es Render, así que las cifras absolutas son orientativas, como las de la [evidencia de memoria de F2.1](evidencia-memoria-f2-1.md).
- PostgreSQL 18.4 y SeaweedFS 4.48 portátiles, solo en `127.0.0.1` (`.kiro/steering/sandbox-ocasional.md`, «PostgreSQL y SeaweedFS sin Docker»), con los SHA-256 de sus paquetes comprobados.
- Node.js 24.22.0, con los tamaños de V8 de `ingest` (`WORKER_NODE_FLAGS`: `--max-semi-space-size=1` y `--max-old-space-size=256`).
- La release de esquemas fijada `production_v20260901_0`, descargada de su URL fijada y comprobada con su SHA-256.
- El worker de `main` en `de4e27b`, el del PR #129, con las herramientas de `scripts/evidencia-f2-5b/`, que no son comandos del producto (runbook de ingesta, «Evidencia de las dos sesiones (F2.5b)»).

### Cómo se midió

`scripts/evidencia-f2-5b/medir-memoria.mjs` crea un esquema PostgreSQL y un bucket desechables por mercado, con las migraciones del worker, y los borra al terminar. En cada uno escribe, a la vez, una captura sintética con el `SourceEventLog` del worker: una conexión, un tick cada 2 s en R_100 y cada segundo en el oro, el ritmo medido el 2026-11-16 (ADR-0021, «Medición»), un `pong` cada 45 s y un cierre pedido al final. El oro cierra cada día de 22:00 a 23:00 UTC y los fines de semana, así que 7 días seguidos de ticks son más que lo que puede tener un log suyo. Antes guarda el esquema de fuente, como `ingest`, y en el log de R_100 la fila de su perfil de publicación, como `buoh-operaciones` en producción. El del oro va sin fila, con el perfil de medición (ADR-0021 §2).

| Log | Ticks | Eventos | Segmentos cerrados | Escritura |
|---|---|---:|---:|---:|
| R_100, 7 días | cada 2 s | 315 842 | 2016 | 36,2 min |
| Oro, 7 días | cada segundo | 618 240 | 2016 | 72,0 min |

Después mide, en un proceso aparte cada vez, con `scripts/evidencia-f2-5b/dos-sesiones.mjs`, las dos sesiones en un solo proceso, como las corre `ingest` con dos `--symbol` (ADR-0021 §1), sin lo que `ingest` añade en `production` («Límites»). Cada una tiene sus almacenes, su registro operativo, el bloqueo de su secuencia, su log, su cursor y su latido, y escribe los puntos de control que faltan antes de conectar (`writeLiveCheckpoints`):

1. **`reconstruyendo`**, una vez: los dos logs sin ningún punto de control, así que las dos sesiones los reconstruyen a la vez al arrancar;
2. **`con-punto-de-control`**, tres veces: los dos logs ya con sus puntos de control.

Cada sesión conecta a un canal falso de Deriv en el proceso, recibe 3 ticks y para. La sesión cambia lo mismo que la de F2.1, y nada de lo que se mide: la retención es de 8 días, el canal de Deriv es falso, `schemas.zip` sale de un archivo y la espera entre intentos usa el azar 0. El máximo es el del proceso entero, con el `VmHWM` de `/proc/self/status`, en dos fases. `arranque` va desde el principio hasta que las dos sesiones abren su primera conexión, y `conexion`, desde ahí hasta el final.

### Resultado

Las cifras van en MiB de 1 048 576 bytes, como las cuenta `/proc` y como cuenta los MB ADR-0016 («Medición»), a la que remiten ADR-0017 §9 y ADR-0021 §1.

| Medición | `arranque` | `conexion` | Hasta conectar las dos |
|---|---:|---:|---:|
| `reconstruyendo` | 135,6 MiB | 133,0 MiB | 80,7 s |
| `con-punto-de-control`, la mayor de 3 | 109,0 MiB | 110,4 MiB | 0,41 s |

- **El criterio de §1 se cumple:** el máximo, 135,6 MiB, queda 120,4 MiB por debajo de 256 MiB. La ejecución del 2026-11-24 lo comparó con 256 000 000 bytes (244,1 MiB), un techo más estricto que el de §1; después, el script pasó a 256 MiB. El máximo queda por debajo de los dos.
- **Todas las sesiones** terminaron `completed`, sin alertas.
- **La reconstrucción** dejó un punto de control por segmento cerrado en los dos logs: 2017 en cada uno, con los 2016 segmentos de la escritura más el de la propia sesión.

### Límites

- **Es el sandbox, no Render.** La memoria de `buoh-ingesta` en Render se lee en su panel **Metrics** después del PR 3, que añade el oro.
- **El ritmo del oro** es el de los 120 s medidos el 2026-11-16, durante 7 días seguidos y sin sus cierres. Un log real del oro tiene menos ticks.
- **No es `ingestCommand`.** `dos-sesiones.mjs` arranca las dos sesiones con `startDerivSession`, fuera de `production`, como `sesion.mjs` en F2.1. Deja fuera lo que `ingest` añade en `production`: la espera del arranque (`waitForProductionStart`), con las lecturas de cada secuencia (`openStartupReads`, con su pool y su cliente S3), y la vigilancia del corte (`LogCutWatch`). La lectura de Render del punto anterior lo incluye.
- **No mide** la reconexión con hueco de las dos sesiones a la vez, que F2.1 midió con una sola, ni `data:health`, que corre en su propio proceso con su propio log.

## La prueba de dos sesiones

`apps/market-data-worker/integration/ingest-two-sequences.test.ts` corre `ingestCommand` en `production` con `--symbol R_100 --symbol frxXAUUSD`, contra PostgreSQL y almacenamiento S3 locales, como `pnpm run test:integration` en CI. Cada símbolo captura en el log de su secuencia, con su bloqueo, en dos sesiones de PostgreSQL distintas, y R_100 con la clave de siempre. Una sesión del oro que termina `failed` vuelve a empezar tras su espera, y R_100 sigue con su conexión. A la hora de corte, el oro corta a su log siguiente con el mismo bloqueo, y R_100, sin el suyo, sigue en su log con `log_cut_blocked`. Las dos pruebas pasaron. Dos mutaciones de `src/ingest.ts`, una a una, hicieron fallar la primera, que cubre las dos: sin volver a empezar una captura, y con el bloqueo de R_100 para todas las secuencias. Con cada una falló también la segunda, pero eso no cuenta como detección: el comando de la primera, que no terminó, siguió vivo con sus bloqueos.

## El oro con el mercado cerrado

`scripts/evidencia-f2-5b/sonda-mercado-cerrado.mjs`, desde el sandbox, con Node 24.22.0 y el worker de la rama del PR 2d sobre `main` en `dcd4cd7`, el 2026-11-24 a las 22:05:03 UTC, en el cierre diario del oro. Se conecta al canal público de Deriv, sin cuenta, y no guarda ninguna cotización (runbook de ingesta, «Evidencia de las dos sesiones (F2.5b)»).

- **El catálogo** (`active_symbols`): `frxXAUUSD` con `exchange_is_open` 0 e `is_trading_suspended` 0.
- **El horario** (`trading_times` del 2026-11-24): abre a las 00:00:00 y a las 23:00:00 y cierra a las 22:00:00 y a las 23:59:59 UTC, de lunes a viernes.
- **La suscripción `ticks`**, pedida a las 22:05:03.812 y respondida a las 22:05:04.169: `msg_type` `ticks`, `error.code` `MarketIsClosed` y el mensaje «This market is presently closed. Market will open at 2026-11-24 23:00:00.». `marketOpensAt`, el código del worker, lee de él las 23:00:00.000 UTC, la reapertura del horario. En 20 s no llegó ningún tick.
- **Resultado:** salida 0, `market_closed_as_expected`.

Así responde el oro cerrado como `OTC_HSI` y `OTC_N225` en el PR 2c, y como espera el worker: la hora del mensaje, sin zona, es la de la reapertura en UTC del horario de Deriv. La sesión del oro no falla, cierra como pedido y vuelve a intentarlo a las 23:00 UTC (ADR-0021 §2). El mismo día, a las 11:53 UTC, con el oro abierto, la sonda salió con 1, con ticks, y con `OTC_HSI`, cerrado, con 0.
