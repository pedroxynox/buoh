# Evidencia de memoria del gráfico de F2.4

Evidencia de la ventana máxima del gráfico de [ADR-0019](../arquitectura/adr/0019-api-cuentas-y-auditoria.md) §8, reunida el 2026-11-05 de 12:03 a 12:10 UTC. Con la ventana de 24 horas que decidió el propietario (`DATA_CHART_MAX_HOURS`), el máximo de memoria residente (RSS) del proceso de la API, con el gráfico de 24 horas leído en frío y un alta y un inicio de sesión después (Argon2id real), queda en **219,3 MiB**, por debajo del techo orientativo de 300 MiB de la [evidencia de memoria de F2.3](evidencia-memoria-f2-3.md) y del Starter de 512 MB. Sin gráfico, en las mismas condiciones, es de 159,9 MiB. Con un backtest en curso, el servicio no puede pasar de 435 MB (ADR-0019 §12): con el gráfico de 24 horas le quedan al backtest 205 MB, menos que los 256 MB de `F2-BACKTEST-001`. Por eso el propietario decidió pasar `buoh-api` al plan Standard de Render cuando F2.7 lo necesite (`PROJECT_STATUS.md`, «Decisiones vigentes relevantes»).

La medición no usa datos de mercado: la captura es sintética, con precios inventados, y ningún proceso se conecta a Deriv. Este documento solo trae memoria, tiempos, tamaños, conteos y estados. Las claves y las contraseñas se generaron al vuelo, viajaron solo por el entorno de los procesos y nunca quedaron en Git.

## Entorno

- Sandbox de Kiro, sin Docker: 8 núcleos y 31 GiB de memoria, sin ningún límite que Node pueda ver. No es Render, así que las cifras absolutas son orientativas, como en la [evidencia de memoria de F2.3](evidencia-memoria-f2-3.md).
- PostgreSQL 18.4 y SeaweedFS 4.48 portátiles, el almacenamiento de objetos compatible con S3, los dos solo en `127.0.0.1` y sin TLS, del arnés de integración local que describe el steering del sandbox (`.kiro/steering/entorno-sandbox-kiro.md`). La API corre con `BUOH_DEPLOYMENT_ENVIRONMENT=development`, que no exige `https` ni TLS.
- Node.js 24.22.0 y pnpm 12.14.0. Cada proceso de la API corre con los tamaños de V8 de `API_NODE_FLAGS` (`apps/api/src/node-flags.ts`): `--max-semi-space-size=1` y `--max-old-space-size=256`.
- La release de esquemas fijada `production_v20260901_0`, descargada de su URL fijada y comprobada con su SHA-256.
- El código del primer commit de este PR, `e1450f9`, sobre `main` en `85f16e9`, compilado con `pnpm run build`, y `scripts/evidencia-f2-4/medir-memoria.mjs`, que no es un comando del producto. La medición se repitió con el código después de la revisión (abajo, «Resultado»).

## Cómo se midió

El script crea una base desechable, `buoh_medicion_f2_4`, y en ella el log 1, con las migraciones del worker. Escribe en el log, con el `SourceEventLog` del worker, una captura sintética de R_100 de 25 horas que termina un minuto antes de medir: un tick cada 2 s, como R_100 en producción, un `pong` cada 45 s, segmentos de 5 minutos y un cierre pedido al final. Son 47 002 eventos en 300 segmentos cerrados. Antes guarda el esquema de fuente, como `ingest` al arrancar, y después escribe un punto de control por segmento cerrado, como `ingest` (ADR-0017 §5). Crea `buoh_api_lectura` con los privilegios de `buoh_lectura` y migra `buoh_api`.

Después mide la ventana 0, sin gráfico, que es la línea base, y las de 1, 6, 12 y 24 horas. Cada ventana tiene 3 rondas, cada una en un proceso nuevo de la API, con la caché vacía:

1. da de alta una cuenta con la orden `cuenta`, usa su enlace e inicia sesión, con el Argon2id real de las dos operaciones;
2. pide `GET /api/v1/datos/grafico?hours=<n>` dos veces: la primera, en frío, lee los segmentos del almacenamiento, y la segunda, de la caché;
3. da de alta otra cuenta, usa su enlace e inicia sesión, con lo que guarda la caché del gráfico ya en memoria;
4. lee el máximo de memoria residente del proceso (`VmHWM` de `/proc/<pid>/status`), en MiB de 1 048 576 bytes.

Cuenta el mayor de las 3 rondas de cada ventana. El criterio es que, con la ventana máxima, el máximo no pase de 300 MiB, el techo orientativo del proceso de la API de F2.3. El script solo da por buena una ejecución en la que todas las peticiones del gráfico responden 200.

El primer criterio que probó el agente, el 2026-11-05 antes de la decisión del propietario, era otro: dejarle al backtest sus 256 MB enteros, es decir, que la API no pasara de 179 MB (435 − 256), unos 170,7 MiB. No lo cumplía ninguna ventana, ni la de 1 hora, porque la API sin gráfico ya llegaba a unos 160 MiB, y el agente lo descartó. Esa cuenta sigue en la salida del script, que da para cada ventana lo que le queda a un backtest de los 435 MB, en MB. F2.7 fija el techo del backtest.

## Resultado

| Ventana | Máximo RSS | RSS tras el gráfico | Gráfico en frío | En caché | Respuesta | Ticks | Le queda a un backtest |
|---|---:|---:|---:|---:|---:|---:|---:|
| sin gráfico | 159,9 MiB | — | — | — | — | — | 267 MB |
| 1 hora | 171,0 MiB | 105,8 a 106,8 MiB | 284 a 291 ms | 19 a 21 ms | 28 KB | 1 591 a 1 593 | 256 MB |
| 6 horas | 193,5 MiB | 119,5 a 130,3 MiB | 978 a 990 ms | 39 a 45 ms | 196 KB | 10 587 a 10 590 | 232 MB |
| 12 horas | 205,7 MiB | 138,5 a 141,8 MiB | 1 725 a 1 746 ms | 66 a 67 ms | 401 KB | 21 381 a 21 385 | 219 MB |
| 24 horas | 219,3 MiB | 148,1 a 155,4 MiB | 3 182 a 3 263 ms | 115 a 124 ms | 811 KB | 42 974 a 42 979 | 205 MB |

- **Pasa:** con 24 horas, 219,3 MiB, por debajo de los 300 MiB. Las 12 rondas con gráfico respondieron 200 las dos veces, y las 15 rondas dieron de alta e iniciaron sesión las dos veces.
- «RSS tras el gráfico» es la memoria residente justo después de las dos lecturas del gráfico, antes de la segunda alta. La respuesta es el JSON sin comprimir, en KB de 1000 bytes.
- Cada gráfico trae un hueco, el `capture_stopped` del cierre pedido al final de la captura, sin fin porque después no llegó ningún tick. Los ticks bajan de 1 a 3 de una ronda a la siguiente porque la ventana termina en la hora de cada lectura y la captura no tiene ticks nuevos.
- Un tick cada 2 s, el ritmo de R_100, son unos 1 800 por hora, así que la ventana de 24 horas trae unos 43 000.
- **Repetida con el código después de la revisión del PR**, que corrige la parada al principio de la ventana y corta cada lectura de R2 a los 10 s (ADR-0019 §8), el mismo día de 15:28 a 15:35 UTC: máximos de 158,6 MiB sin gráfico y de 170,4, 190,5, 205,6 y 220,1 MiB con 1, 6, 12 y 24 horas. A un backtest le quedan 269, 256, 235, 219 y 204 MB, y el gráfico de 24 horas en frío tardó de 3 404 a 3 444 ms. Pasa igual, y la diferencia con la tabla, de menos de 1 MiB, está dentro de lo que varía entre rondas.

## Por qué crece la memoria

**El pico es el Argon2id.** El máximo de cada ronda llega con la segunda alta, cuando el Argon2id reserva sus 64 MiB de memoria nativa encima de lo que ya tiene el proceso: con 24 horas, 155,4 MiB tras el gráfico y 219,3 MiB de máximo, unos 64 MiB más. La API calcula un Argon2id a la vez, así que el pico es la memoria tras el gráfico más esos 64 MiB.

**La lectura en frío deja crecido el heap.** Para leer el gráfico, la API verifica y recorre cada segmento cerrado de la ventana, así que el heap de V8 crece con la ventana y el proceso no devuelve al sistema toda esa memoria al terminar. Lo muestran unas pruebas exploratorias de ese mismo día, fuera del repositorio y de una sola ejecución cada una, en un proceso que lee el gráfico con el lector de la API (`createMarketDataReader`) sin el servidor, con los mismos tamaños de V8 y sin forzar ninguna recolección. Con 24 horas:

- antes de leer, unos 88 MiB de memoria residente, con un heap de unos 24 MiB y unos 21,5 MiB en uso;
- justo después de la lectura en frío, de 142,9 a 146,3 MiB residentes en 5 ejecuciones, con un heap de 63 a 67 MiB y unos 58 en uso;
- tras una espera sin hacer nada, el uso baja a unos 32 MiB, unos 10,5 MiB más que antes, entre ellos lo que guarda la caché, pero el heap queda en unos 45 MiB y la memoria residente, de 137,1 a 141,3 MiB en 4 ejecuciones.

**Ningún ajuste la bajó.** Con las mismas pruebas, la memoria residente justo después de la lectura en frío de 24 horas, frente a los 142,9 a 146,3 MiB de los tamaños de `API_NODE_FLAGS`:

| Ajuste | Memoria residente | Resultado |
|---|---:|---|
| `--initial-old-space-size=16` o `32` | 143,7 y 144,1 MiB | no baja |
| `--max-old-space-size=128` | 145,2 MiB | no baja |
| `--max-semi-space-size=4` | 141,7 MiB | no baja |
| `--max-semi-space-size=16` | 162,5 MiB | peor |
| `--v8-pool-size=1` | 152,7 MiB | peor |
| `MALLOC_ARENA_MAX=2` | 143,8 MiB | no baja |
| `MALLOC_MMAP_THRESHOLD_=65536` | 148,8 MiB | no baja |
| `MALLOC_TRIM_THRESHOLD_` | 148,1 MiB | no baja |
| leer un segmento a la vez, en lugar de 4 | 143,8 MiB | no baja, y tarda 0,3 s más |
| leer las líneas del segmento sin volver a codificarlas | 143,0 y 145,5 MiB | no baja |

Por eso la API conserva los tamaños de V8 de F2.3 y su lectura de 4 segmentos a la vez, y la ventana se decidió con la memoria que se mide así.

## Qué falta medir

- El Starter real de Render no se midió. Allí la API lee R2 por internet y con TLS, así que la primera vista de 24 horas tardará más que los 3,2 s del sandbox, y la memoria puede ser algo distinta. El punto 7 de F2.4 mide en producción las lecturas de R2 y el tráfico de salida (`F2-API-001`), y el propietario copia la memoria de `buoh-api` del panel de Render (ADR-0018 §13).
- Esta medición no incluye un backtest. F2.7 fija su techo con el plan de `buoh-api` de ese momento.

## Reproducir

Desde la raíz, con todo compilado (`pnpm run build`), Node 24.22.0, y el PostgreSQL y el SeaweedFS locales del arnés de integración, con sus variables `BUOH_POSTGRES_*` y `BUOH_S3_*`:

```text
node scripts/evidencia-f2-4/medir-memoria.mjs --horas 1,6,12,24 --rondas 3
```

`--captura-horas` cambia las horas de la captura sintética, 25 por omisión, y `--esquemas <schemas.zip>` usa una copia local de la release fijada en lugar de descargarla. Escribe una línea JSON con cada ventana y cada ronda, sin precios ni claves, y sale con 0 si se cumple el criterio. Al terminar borra la base y el rol. La medición entera lleva unos 7 minutos, casi todos para escribir la captura.
