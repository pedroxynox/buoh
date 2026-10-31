# Evidencia de memoria de F2.1

Evidencia de la condición «Memoria» de [ADR-0017](../arquitectura/adr/0017-punto-de-control-de-la-derivacion-en-vivo.md) §9 y de la aceptación de `F2-CHECKPOINT-001` ([plan de Fase 2](../plan/fase-2-laboratorio-y-bot-shadow.md) §7), reunida el 2026-10-31 de 01:24 a 02:24 UTC. Con un log sintético de 7 días de R_100, el máximo de memoria residente (RSS) de `ingest` y el de `data:health` quedan a menos de un 10 % del de un log de un día y por debajo de sus techos, también cuando reconstruyen el estado vivo sin un punto de control válido. Los cinco criterios pasan.

La medición no usa datos de mercado: los logs son sintéticos, con precios inventados, y ningún proceso se conecta a Deriv. Este documento solo trae memoria, tiempos, conteos y estados. Las salidas crudas quedaron fuera de Git.

## Entorno

- Sandbox de Kiro, sin Docker: 8 núcleos y 31 GiB de memoria, sin ningún límite de memoria que Node pueda ver. No es Render, así que las cifras absolutas son orientativas, como las de [ADR-0016](../arquitectura/adr/0016-alojamiento-del-sistema-de-datos.md) («Medición»).
- PostgreSQL 18.1 y SeaweedFS 4.48 portátiles. El steering del sandbox (`.kiro/steering/entorno-sandbox-kiro.md`) describe su instalación y fija PostgreSQL 18.4; aquí corrió el binario 18.1. PostgreSQL solo escuchaba en 127.0.0.1. SeaweedFS corrió sin `-ip.bind`, así que también escuchaba en las demás interfaces del sandbox; los datos eran sintéticos y las credenciales, locales.
- Node.js 24.22.0 y pnpm 12.14.0. Cada proceso medido corre con los tamaños de V8 de `ingest` y `data:health` (`WORKER_NODE_FLAGS`: `--max-semi-space-size=1` y `--max-old-space-size=256`; ver «Por qué se fijan los tamaños de V8»).
- La release de esquemas fijada `production_v20260901_0` (SHA-256 `adaab0acaf33bd159e45912995af2b78101049f43683d223f0ac11be0a39e7c3`), descargada de su URL fijada y comprobada por la sesión con su SHA-256; el conector `deriv-options-ws-1.1.0` y el símbolo `R_100`.
- El código de este PR, sobre `main` en `0052fd3`, con las herramientas de `scripts/evidencia-f2-1/`, que no son comandos del producto (runbook, «Medición de memoria de F2.1»).

## Cómo se midió

`scripts/evidencia-f2-1/medir-memoria.mjs` crea dos esquemas PostgreSQL desechables, con las migraciones del worker, y un bucket desechable común, y borra los tres al terminar. En cada esquema escribe con el `SourceEventLog` del worker una captura sintética de R_100: una conexión, un tick cada 2 s, un `pong` cada 45 s y un cierre pedido al final. Los segmentos rotan por la ventana de 300 000 ms, como en `ingest`. Antes guarda el esquema de fuente, como `ingest` al arrancar, y no escribe puntos de control.

| Log | Desde | Hasta | Eventos | Segmentos cerrados | Escritura |
|---|---|---|---:|---:|---:|
| 1 día | 2026-10-30 01:22:42Z | 2026-10-31 01:22:42Z | 45 122 | 288 | 5,1 min |
| 7 días | 2026-10-24 01:22:42Z | 2026-10-31 01:22:42Z | 315 842 | 2016 | 34,3 min |

Después mide, en este orden y en un proceso aparte cada vez:

1. **`data:health` sin punto de control:** el comando de siempre (`dist/cli/health.js`), que reconstruye el estado vivo en memoria (ADR-0017 §6);
2. **`ingest` reconstruyendo:** la sesión de ingesta con el cableado de `ingest` (`sesion.mjs`), que al arrancar comprueba el log y escribe los puntos de control que faltan antes de conectar;
3. **`ingest` con punto de control:** la misma sesión, ya con los puntos de control;
4. **`ingest` durante una reconexión con hueco:** la sesión conecta, el canal cierra la conexión (código 1001), la sesión espera 500 ms, reconecta, el primer tick deja el hueco con su fin, pide la historia a los 2000 ms y la recupera `complete`;
5. **`data:health` con punto de control:** el del último segmento cerrado.

Las tres últimas se repiten tres veces, y cuenta la mayor. La sesión cambia cuatro cosas respecto de `ingest`, ninguna en lo que se mide:

- el canal de Deriv es uno falso, en el proceso, que contesta como el público: el catálogo, un tick cada 2 s con la hora real, cada `ping`, `forget_all` y `ticks_history`;
- la retención es de 8 días, porque las 23 horas de `ingest` no dejan arrancar con un log de 7 días (`retention_expired`);
- la espera antes de reconectar usa el azar 0;
- `schemas.zip` sale de un archivo.

El máximo de `data:health` es el de su proceso, con `getrusage`, como en ADR-0016. El de `ingest` es el de cada fase, con el `VmHWM` de `/proc/self/status`, que se pone a cero al empezar cada fase escribiendo `5` en `/proc/self/clear_refs`:

- `arranque`: desde que empieza el proceso hasta la primera conexión;
- `reconexion`: desde el cierre del canal hasta el final.

Las cifras van en MiB de 1 048 576 bytes, como las cuenta `/proc`. El script solo da por buena una ejecución que termina como debe: `data:health` en `paused`, sin alertas, y cada sesión `completed`, sin alertas.

Una medición se cortó a mitad: la reconexión de la primera ronda con el log de 7 días, porque se interrumpió el comando que la corría. Se repitió, después de una sesión de arranque sin medir que reparó el cierre que había dejado la sesión cortada (`close_not_recorded`) y recuperó su hueco. Las demás no se repitieron.

## Resultado

| Medición | Fase | 1 día | 7 días | Crecimiento | Techo | Resultado |
|---|---|---:|---:|---:|---:|---|
| `ingest` reconstruyendo los puntos de control | `arranque` | 122,6 | 123,7 | +0,9 % | 200 | pasa |
| `ingest` con punto de control | `arranque` | 104,9 | 112,8 | +7,5 % | 200 | pasa |
| `ingest` durante una reconexión con hueco | `reconexion` | 110,3 | 117,5 | +6,5 % | 200 | pasa |
| `data:health` sin punto de control | proceso | 119,2 | 118,0 | −1,0 % | 160 | pasa |
| `data:health` con punto de control | proceso | 88,6 | 86,5 | −2,4 % | 160 | pasa |

- **Repeticiones.** Con 7 días, las tres repeticiones de `ingest` con punto de control y las de la reconexión quedaron entre 2 y 9 MiB por encima de las de un día (99,6, 104,9 y 104,2 MiB al arrancar con un día, y 106,1, 112,8 y 108,9 con 7). La mayor diferencia, +7,5 %, cumple el criterio. Esta medición no explica la diferencia.
- **Tiempos.** Con 7 días, `data:health` sin punto de control tardó 18,2 s, dentro de sus 30 s (`HEALTH_DEADLINE_MS`), e `ingest` tardó 44,1 s en arrancar reconstruyendo, contra 6,8 s con un día. Con punto de control, `ingest` conectó a los 0,22–0,30 s con los dos logs, y `data:health` tardó 0,3–0,4 s.
- **Puntos de control.** Tras arrancar reconstruyendo, el log de 7 días tenía 2017 puntos de control, uno por segmento cerrado, contando el que cerró la propia sesión al parar.
- **Las sesiones.** Todas terminaron `completed`, sin alertas. Cada reconexión recuperó el hueco `complete`, con 2 o 3 ticks entre sus extremos.
- **`data:health`.** Dio `paused` en todas las mediciones, por la regla 4 de ADR-0015 §8: ninguna captura tenía el bloqueo. No dejó ninguna alerta.

## Por qué se fijan los tamaños de V8

Node dimensiona V8 con la memoria que ve. En este sandbox no ve ningún límite, solo los 31 GiB de la máquina: V8 recibe un heap de 4288 MiB y deja crecer la generación joven hasta 128 MiB. Así, sin opciones, la reconstrucción sin punto de control pasaba de los techos, y su máximo crecía con el log. Cuando Node ve un límite de 512 MiB, como el del worker Starter de Render, elige semiespacios de 1 MiB y una generación vieja de 256 MiB, un heap de 259 MiB, y el máximo queda muy por debajo. Desde este PR, `ingest` y `data:health` arrancan con esos mismos tamaños (`WORKER_NODE_FLAGS`, en `apps/market-data-worker/src/node-flags.ts`), así que su memoria no depende de que la plataforma deje ver su límite. El Starter no se midió.

Con el log de un día, en este sandbox:

| Cómo corrió Node | `ingest` reconstruyendo | `data:health` sin punto de control |
|---|---:|---:|
| sin opciones, viendo 31 GiB | 295,9 MiB | 252,0 MiB |
| `--max-semi-space-size=16`, viendo 31 GiB | 219,2 MiB | 183,2 MiB |
| `--max-semi-space-size=16 --max-old-space-size=192`, viendo 31 GiB | 154,8 MiB | 143,5 MiB |
| sin opciones, viendo 512 MiB | 124,1 MiB | 117,8 MiB |
| `WORKER_NODE_FLAGS` (1 y 256 MiB), viendo 31 GiB | 122,6 MiB | 119,2 MiB |

- Las tres primeras filas salen de mediciones de una sola repetición, con un log de 6 horas y otro de un día. Con 6 horas y sin opciones daban 196,9 y 167,8 MiB: el máximo crecía con el log.
- La cuarta es de la revisión semántica de este PR. Node veía 512 MiB por un cgroup v2 con `memory.max` y `memory.high`, montado en un espacio de montaje propio.
- La última es la de esta medición.

Una primera versión de este PR fijaba 16 y 192 MiB. Con un límite de 512 MiB visible, esos tamaños subían el máximo entre 13 y 28 MiB, porque Node habría elegido unos menores. Por eso se fijan los que elige Node.

Con los puntos de control válidos, el máximo apenas depende de los tamaños. La memoria que el proceso guarda viva no crece con el log. Un diagnóstico local, fuera de Git, plegó el log de un día forzando la recolección cada 50 segmentos, y la memoria de V8 en uso se quedó en unos 22 MiB.

Las opciones solo cuentan si el proceso arranca con ellas:

- el script `ingest` del paquete las pasa a Node;
- `scripts/data-health.mjs`, el de `pnpm run data:health`, las pasa a la CLI de salud;
- una orden que arranque `dist/cli/ingest.js` o `dist/cli/health.js` directamente las tiene que poner delante del script.

## Reproducir

El runbook, «Medición de memoria de F2.1», da la orden. Escribir el log de 7 días lleva unos 35 minutos en local, y medir, unos 8 más. La ejecución se puede partir: con `--minutos` y `--parar-tras-escribir`, el script sale con 3 y otra ejecución con el mismo `--estado` sigue donde quedó.
