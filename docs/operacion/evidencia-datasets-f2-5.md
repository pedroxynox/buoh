# Evidencia de los datasets vivos de F2.5

Evidencia de memoria y de duración de la publicación y de la verificación de un dataset vivo ([ADR-0020](../arquitectura/adr/0020-datasets-vivos.md) §7 y §8), reunida el 2026-11-14 con el código del PR 3c de su §13. Con un dataset en el techo de 16 000 elementos, el máximo de memoria residente (RSS) de `datasets:publish` llegó a **191,0 MiB**, y el de `data:replay`, a **168,4 MiB** en `--verify-only` y a **191,8 MiB** en recomputación: los tres por debajo de los 256 MiB del criterio de §7, así que el techo de 16 000 elementos se queda. La publicación tardó como mucho **6,3 s**, y cada verificación, como mucho 1,3 s y 2,3 s, dentro del plazo de 60 s de cada paso (§8).

La medición no usa datos de mercado: la captura es sintética, con precios inventados, y ningún proceso se conecta a Deriv. Este documento solo trae memoria, tiempos, conteos y estados. Las credenciales locales se generaron en el sandbox, viajaron solo por el entorno de los procesos y nunca quedaron en Git.

El PR 6 de §13 añade aquí la evidencia de producción: los datasets publicados y verificados en los dos modos, con la memoria y la duración que informa cada proceso, el costo y el cambio de perfil en el corte.

## Entorno

- Sandbox de Kiro, sin Docker, con 31 GiB de memoria que Node ve. No es Render, así que las cifras absolutas son orientativas. Cada proceso corre con los tamaños de V8 de producción (`WORKER_NODE_FLAGS`: `--max-semi-space-size=1 --max-old-space-size=256`), los que eligen el máximo del montón con independencia de la memoria que ve Node (ADR-0017 §9).
- PostgreSQL 18.4 y SeaweedFS 4.48 portátiles, solo en `127.0.0.1` y sin TLS, del arnés de integración local que describe el steering del sandbox (`.kiro/steering/entorno-sandbox-kiro.md`). Producción usa PostgreSQL 18 de Render y R2.
- Node.js 24.22.0, y la release de esquemas fijada `production_v20260901_0`, descargada de su URL fijada y comprobada con su SHA-256.
- `scripts/evidencia-f2-5/medir-datasets.mjs`, que no es un comando del producto, sobre el worker compilado.

## Cómo se midió

El script crea una base y un bucket desechables y escribe en ellos, con el `SourceEventLog` del worker, dos logs sucesivos de una captura sintética de R_100 con la forma de la de producción: un tick cada 2 s, un `pong` cada 45 s y segmentos de 5 minutos.

- El log 1 dura 12 horas: 22 559 eventos en 144 segmentos cerrados. Su primera conexión cae a la hora, sin historia, y la segunda sigue hasta el final. La continuidad queda pendiente, así que ningún final posible es limpio y el primer dataset termina en el último segmento que cabe en el techo (§7).
- El log 2 dura 5 minutos, para que el 1 esté terminado.

Después corre 3 repeticiones, cada una sobre una copia nueva de `buoh_datasets`, y en cada una tres procesos aparte con `WORKER_NODE_FLAGS`:

1. `datasets:publish` (`dist/cli/publish-dataset.js`), que publica el primer dataset del log 1;
2. `data:replay --verify-only` (`dist/cli/replay.js`), con `buoh_datasets`;
3. `data:replay` en recomputación.

Cada proceso informa en su línea JSON su máximo de memoria residente (`max_rss_bytes`, de `process.resourceUsage().maxRSS`), en MiB de 1 048 576 bytes, y la publicación, su duración (`duration_ms`). Cuenta el mayor de las 3 repeticiones.

```bash
pnpm exec node scripts/evidencia-f2-5/medir-datasets.mjs --salida <archivo.json>
```

## Resultado

En las 3 repeticiones, el dataset es el mismo: `sha256:6a295377bf93437ec793d131a3f7557d5044c1940000f72aaa5080e8d565b8c6`, de los segmentos 0 a 101, con 15 984 elementos (15 984 source events, sin ticks de la historia) y 15 299 ticks, y un final que no fue limpio. Ningún proceso dejó alertas.

| Repetición | Publicar | Su duración | `--verify-only` | Su duración | Recomputación | Su duración |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 167,0 MiB | 6246 ms | 167,2 MiB | 1297 ms | 187,4 MiB | 2280 ms |
| 2 | 175,3 MiB | 6204 ms | 168,4 MiB | 1302 ms | 189,8 MiB | 2287 ms |
| 3 | 191,0 MiB | 6274 ms | 166,9 MiB | 1299 ms | 191,8 MiB | 2299 ms |
| **Máximo** | **191,0 MiB** | **6274 ms** | **168,4 MiB** | 1302 ms | **191,8 MiB** | 2299 ms |

La duración de la publicación es la que informa el proceso, desde que arranca hasta que escribe su línea, e incluye el plan del dataset, la lectura de sus 102 segmentos, su derivación, la escritura de sus objetos 8 a la vez y el `COMMIT`. La de la verificación es la del proceso entero, medida desde fuera.

## Lectura

- **Memoria.** Los tres procesos quedan por debajo de 256 MiB, con 64 MiB de margen la recomputación, la más alta. Con el código de antes de ADR-0020, unos 15 800 eventos daban 190,7 MiB al publicar y como mucho 229,0 MiB al reproducir en el mismo proceso («Medición» de ADR-0020): ahora cada verificación corre en su propio proceso, como el paso 7 de §8. La memoria de la publicación varía entre repeticiones porque depende de cuándo recoge V8 la basura.
- **Duración.** Unos 6 s en local, por debajo de los 15 a 30 s que estimaba §8 para producción, donde R2 está lejos y la escritura de cada objeto tarda más. El PR 6 la mide en producción.
- **Límites.** Un solo dataset sintético en el techo, en el sandbox. No mide un dataset con muchos ticks de la historia ni la red de producción.
