# Evidencia de memoria de dos sesiones de `ingest` (F2.5b)

Evidencia de la memoria de [ADR-0021](../arquitectura/adr/0021-mercados-reales-y-fuentes-de-investigacion.md) §1, que el PR 2d lleva antes del PR 3 (§9, «Precisión del PR 2c»). Se midió el 2026-11-24, de 03:25 a 04:48 UTC. Un solo proceso con dos sesiones de ingesta, R_100 y el oro (`frxXAUUSD`), cada una con un log sintético de 7 días, reconstruyendo a la vez sus puntos de control. Su máximo de memoria residente fue de 142,2 MB, por debajo de los 256 MB de §1: el oro cabe en `buoh-ingesta`, sin un servidor propio.

La medición no usa datos de mercado: los logs son sintéticos, con precios inventados, y ningún proceso se conecta a Deriv. Este documento solo trae memoria, tiempos, conteos y estados. Las salidas crudas quedaron fuera de Git.

## Entorno

- Sandbox de Kiro, sin Docker: 8 núcleos y 30 GiB de memoria, sin ningún límite de memoria que Node pueda ver. No es Render, así que las cifras absolutas son orientativas, como las de la [evidencia de memoria de F2.1](evidencia-memoria-f2-1.md).
- PostgreSQL 18.4 y SeaweedFS 4.48 portátiles, solo en `127.0.0.1` (`.kiro/steering/sandbox-ocasional.md`, «PostgreSQL y SeaweedFS sin Docker»), con los SHA-256 de sus paquetes comprobados.
- Node.js 24.22.0, con los tamaños de V8 de `ingest` (`WORKER_NODE_FLAGS`: `--max-semi-space-size=1` y `--max-old-space-size=256`).
- La release de esquemas fijada `production_v20260901_0`, descargada de su URL fijada y comprobada con su SHA-256.
- El worker de `main` en `de4e27b`, el del PR #129, con las herramientas de `scripts/evidencia-f2-5b/`, que no son comandos del producto (runbook de ingesta, «Medición de memoria de dos sesiones (F2.5b)»).

## Cómo se midió

`scripts/evidencia-f2-5b/medir-memoria.mjs` crea un esquema PostgreSQL y un bucket desechables por mercado, con las migraciones del worker, y los borra al terminar. En cada uno escribe, a la vez, una captura sintética con el `SourceEventLog` del worker: una conexión, un tick cada 2 s en R_100 y cada segundo en el oro, el ritmo medido el 2026-11-16 (ADR-0021, «Medición»), un `pong` cada 45 s y un cierre pedido al final. El oro cierra cada día de 22:00 a 23:00 UTC y los fines de semana, así que 7 días seguidos de ticks son más que lo que puede tener un log suyo. Antes guarda el esquema de fuente, como `ingest`, y en el log de R_100 la fila de su perfil de publicación, como `buoh-operaciones` en producción. El del oro va sin fila, con el perfil de medición (ADR-0021 §2).

| Log | Ticks | Eventos | Segmentos cerrados | Escritura |
|---|---|---:|---:|---:|
| R_100, 7 días | cada 2 s | 315 842 | 2016 | 36,2 min |
| Oro, 7 días | cada segundo | 618 240 | 2016 | 72,0 min |

Después mide, en un proceso aparte cada vez, con `scripts/evidencia-f2-5b/dos-sesiones.mjs`, las dos sesiones en un solo proceso, como `ingest` con dos `--symbol` (ADR-0021 §1). Cada una tiene sus almacenes, su registro operativo, el bloqueo de su secuencia, su log, su cursor y su latido, y escribe los puntos de control que faltan antes de conectar (`writeLiveCheckpoints`):

1. **`reconstruyendo`**, una vez: los dos logs sin ningún punto de control, así que las dos sesiones los reconstruyen a la vez al arrancar;
2. **`con-punto-de-control`**, tres veces: los dos logs ya con sus puntos de control.

Cada sesión conecta a un canal falso de Deriv en el proceso, recibe 3 ticks y para. La sesión cambia lo mismo que la de F2.1, y nada de lo que se mide: la retención es de 8 días, el canal de Deriv es falso, `schemas.zip` sale de un archivo y la espera entre intentos usa el azar 0. El máximo es el del proceso entero, con el `VmHWM` de `/proc/self/status`, en dos fases. `arranque` va desde el principio hasta que las dos sesiones abren su primera conexión, y `conexion`, desde ahí hasta el final.

## Resultado

| Medición | `arranque` | `conexion` | Hasta conectar las dos |
|---|---:|---:|---:|
| `reconstruyendo` | 142,2 MB (135,6 MiB) | 139,4 MB (133,0 MiB) | 80,7 s |
| `con-punto-de-control`, la mayor de 3 | 114,3 MB (109,0 MiB) | 115,8 MB (110,4 MiB) | 0,41 s |

- **El criterio de §1 se cumple:** el máximo, 142,2 MB, queda 113,8 MB por debajo de 256 MB.
- **Todas las sesiones** terminaron `completed`, sin alertas.
- **La reconstrucción** dejó un punto de control por segmento cerrado en los dos logs: 2017 en cada uno, con los 2016 segmentos de la escritura más el de la propia sesión.

## Límites

- **Es el sandbox, no Render.** La memoria de `buoh-ingesta` en Render se lee en su panel **Metrics** después del PR 3, que añade el oro.
- **El ritmo del oro** es el de un minuto del 2026-11-16, durante 7 días seguidos y sin sus cierres. Un log real del oro tiene menos ticks.
- **No mide** la reconexión con hueco de las dos sesiones a la vez, que F2.1 midió con una sola, ni `data:health`, que corre en su propio proceso con su propio log.
