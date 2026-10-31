# Evidencia de memoria de F2.1

Evidencia de la condición «Memoria» de [ADR-0017](../arquitectura/adr/0017-punto-de-control-de-la-derivacion-en-vivo.md) §9 y de la aceptación de `F2-CHECKPOINT-001` ([plan de Fase 2](../plan/fase-2-laboratorio-y-bot-shadow.md) §7), reunida del 2026-10-30 a las 23:32 UTC al 2026-10-31 a las 00:16 UTC. Con un log sintético de 7 días de R_100, el máximo de memoria residente (RSS) de `ingest` y el de `data:health` quedan a menos de un 10 % del de un log de un día y por debajo de sus techos, también cuando reconstruyen el estado vivo sin un punto de control válido. Los cinco criterios pasan.

La medición no usa datos de mercado: los logs son sintéticos, con precios inventados, y ningún proceso se conecta a Deriv. Este documento solo trae memoria, tiempos, conteos y estados. Las salidas crudas quedaron fuera de Git.

## Entorno

- Sandbox de Kiro, sin Docker: 8 núcleos y 31 GiB de memoria. PostgreSQL 18.1 y SeaweedFS 4.48 portátiles, como dice `.kiro/steering/entorno-sandbox-kiro.md`, solo en la interfaz local. No es Render, así que las cifras absolutas son orientativas, como las de [ADR-0016](../arquitectura/adr/0016-alojamiento-del-sistema-de-datos.md) («Medición»).
- Node.js 24.22.0 y pnpm 12.14.0. Cada proceso medido corre con los límites de V8 de `ingest` y `data:health` (`WORKER_NODE_FLAGS`: `--max-semi-space-size=16` y `--max-old-space-size=192`; ver «Lo que encontró la medición»).
- La release de esquemas fijada `production_v20260901_0` (SHA-256 `adaab0acaf33bd159e45912995af2b78101049f43683d223f0ac11be0a39e7c3`), descargada de su URL fijada y comprobada por la sesión con su SHA-256; el conector `deriv-options-ws-1.1.0` y el símbolo `R_100`.
- El código de este PR, sobre `main` en `0052fd3`, con las herramientas de `scripts/evidencia-f2-1/`, que no son comandos del producto (runbook, «Medición de memoria de F2.1»).

## Cómo se midió

`scripts/evidencia-f2-1/medir-memoria.mjs` crea dos esquemas PostgreSQL desechables, con las migraciones del worker, y un bucket desechable común, y borra los tres al terminar. En cada esquema escribe con el `SourceEventLog` del worker una captura sintética de R_100: una conexión, un tick cada 2 s, un `pong` cada 45 s y un cierre pedido al final. Los segmentos rotan por la ventana de 300 000 ms, como en `ingest`. Antes guarda el esquema de fuente, como `ingest` al arrancar, y no escribe puntos de control.

| Log | Desde | Hasta | Eventos | Segmentos cerrados | Escritura |
|---|---|---|---:|---:|---:|
| 1 día | 2026-10-29 23:30:04Z | 2026-10-30 23:30:04Z | 45 122 | 288 | 5,1 min |
| 7 días | 2026-10-23 23:30:04Z | 2026-10-30 23:30:04Z | 315 842 | 2016 | 35,0 min |

Después mide, en este orden y en un proceso aparte cada vez:

1. **`data:health` sin punto de control:** el comando de siempre (`dist/cli/health.js`), que reconstruye el estado vivo en memoria (ADR-0017 §6);
2. **`ingest` reconstruyendo:** la sesión de ingesta con el cableado de `ingest` (`sesion.mjs`), que al arrancar comprueba el log y escribe los puntos de control que faltan antes de conectar;
3. **`ingest` con punto de control:** la misma sesión, ya con los puntos de control;
4. **`ingest` durante una reconexión con hueco:** la sesión conecta, el canal cierra la conexión (código 1001), la sesión espera 500 ms, reconecta, el primer tick deja el hueco con su fin, pide la historia a los 2000 ms y la recupera `complete`;
5. **`data:health` con punto de control:** el del último segmento cerrado.

Las tres últimas se repiten tres veces, y cuenta la mayor. El canal de Deriv es uno falso, en el proceso, que contesta como el público: el catálogo, un tick cada 2 s con la hora real, cada `ping`, `forget_all` y `ticks_history`. La sesión cambia tres cosas respecto de `ingest`, ninguna en lo que se mide: la retención es de 8 días, porque las 23 horas de `ingest` no dejan arrancar con un log de 7 días (`retention_expired`); la espera antes de reconectar usa el azar 0; y `schemas.zip` sale de un archivo.

El máximo de `data:health` es el de su proceso, con `getrusage`, como en ADR-0016. El de `ingest` es el de cada fase, con el `VmHWM` de `/proc/self/status`, que se pone a cero al empezar cada fase escribiendo `5` en `/proc/self/clear_refs`:

- `arranque`: desde que empieza el proceso hasta la primera conexión;
- `reconexion`: desde el cierre del canal hasta el final.

Las cifras van en MiB de 1 048 576 bytes, como las cuenta `/proc`.

## Resultado

| Medición | Fase | 1 día | 7 días | Crecimiento | Techo | Resultado |
|---|---|---:|---:|---:|---:|---|
| `ingest` reconstruyendo los puntos de control | `arranque` | 149,8 | 151,6 | +1,2 % | 200 | pasa |
| `ingest` con punto de control | `arranque` | 124,7 | 125,4 | +0,6 % | 200 | pasa |
| `ingest` durante una reconexión con hueco | `reconexion` | 127,6 | 127,4 | −0,2 % | 200 | pasa |
| `data:health` sin punto de control | proceso | 145,2 | 148,4 | +2,2 % | 160 | pasa |
| `data:health` con punto de control | proceso | 97,3 | 97,0 | −0,3 % | 160 | pasa |

- **Tiempos.** Con 7 días, `data:health` sin punto de control tardó 16,8 s, dentro de sus 30 s (`HEALTH_DEADLINE_MS`), e `ingest` tardó 39,9 s en arrancar reconstruyendo, contra 6,6 s con un día. Con punto de control, `ingest` conectó a los 0,25–0,28 s con los dos logs, y `data:health` tardó 0,4 s.
- **Puntos de control.** Tras arrancar reconstruyendo, el log de 7 días tenía 2017 puntos de control, uno por segmento cerrado, contando el que cerró la propia sesión al parar.
- **Las sesiones.** Todas terminaron `completed`, sin alertas. Cada reconexión recuperó el hueco `complete`, con 2 o 3 ticks entre sus extremos.
- **`data:health`.** Dio `paused` en todas las mediciones, por la regla 4 de ADR-0015 §8: ninguna captura tenía el bloqueo. No dejó ninguna alerta.

## Lo que encontró la medición

Sin límites explícitos de V8, la reconstrucción sin punto de control pasaba de los techos, y su máximo crecía con el log. Lo midió el mismo script, con un log de 6 horas y otro de un día y una sola repetición:

| Límites de V8 | `ingest` reconstruyendo, 6 h → 1 día | `data:health` sin punto de control, 6 h → 1 día |
|---|---|---|
| ninguno | 196,9 → 295,9 MiB | 167,8 → 252,0 MiB |
| `--max-semi-space-size=16` | 169,3 → 219,2 MiB | 143,2 → 183,2 MiB |
| `--max-semi-space-size=16` y `--max-old-space-size=192` | 136,3 → 154,8 MiB | 131,4 → 143,5 MiB |

Con los puntos de control válidos, el máximo no cambiaba con o sin límites. La memoria que el proceso guarda viva no crece con el log. Un diagnóstico local, fuera de Git, plegó el log de un día forzando la recolección cada 50 segmentos: la memoria de V8 en uso se quedó en unos 22 MiB.

Lo que crecía era el espacio que V8 reserva:

- V8 dejaba crecer la generación joven hasta 128 MiB.
- La generación vieja acumulaba basura entre recolecciones, porque su límite sale de la memoria de la máquina: Node le daba a V8 un límite total de 4288 MiB.

El mismo diagnóstico, con Node viendo un límite de 512 MiB como el del worker Starter de Render (un `memory.max` de cgroup v2 en un espacio de montaje propio), bajó ese límite total a 259 MiB, pero la generación joven volvió a crecer hasta 128 MiB y el máximo fue el mismo. En el Starter, sin los límites, la reconstrucción se comportaría igual.

Por eso `ingest` y `data:health` corren desde este PR con dos límites, `WORKER_NODE_FLAGS` en `apps/market-data-worker/src/node-flags.ts`:

- el script `ingest` del paquete los pasa a Node;
- `scripts/data-health.mjs` los pasa a la CLI de salud.

La reconstrucción no se volvió más lenta: `data:health` reconstruyó el log de un día en unos 3 s con y sin límites.

## Reproducir

El runbook, «Medición de memoria de F2.1», da la orden. Escribir el log de 7 días lleva unos 35 minutos en local, y medir, unos 8 más. La ejecución se puede partir: con `--minutos` y `--parar-tras-escribir`, el script sale con 3 y otra ejecución con el mismo `--estado` sigue donde quedó.
