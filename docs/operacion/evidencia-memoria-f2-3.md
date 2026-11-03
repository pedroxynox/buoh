# Evidencia de memoria de la API de F2.3

Evidencia de la condición «Memoria» de [ADR-0019](../arquitectura/adr/0019-api-cuentas-y-auditoria.md) §10 y §12, reunida el 2026-11-03. Con los tamaños de V8 que fija el PR 6a, el máximo de memoria residente (RSS) del proceso de la API, mientras da de alta una cuenta, inicia sesión (Argon2id real las dos veces) y sirve la web, queda en **152,2 MiB**, muy por debajo del servicio Starter de 512 MB de Render y del techo de 435 MB que §12 reserva para el servicio entero con un backtest en curso (F2.7). Fija los tamaños de V8 de la API en `--max-semi-space-size=1 --max-old-space-size=256`, los mismos que el worker.

La medición no usa datos de mercado ni red externa: la base es local y sintética, las cuentas y las claves se generan al vuelo. Este documento solo trae memoria, tiempos, conteos y estados. Las claves y las contraseñas nunca salieron del entorno del proceso ni quedaron en Git.

## Entorno

- Sandbox de Kiro, sin Docker: 8 núcleos y 31 GiB de memoria, sin ningún límite que Node pueda ver. No es Render, así que las cifras absolutas son orientativas, como en [ADR-0016](../arquitectura/adr/0016-alojamiento-del-sistema-de-datos.md) («Medición») y en la [evidencia de memoria de F2.1](evidencia-memoria-f2-1.md).
- PostgreSQL 18.4 portátil, solo en `127.0.0.1`, sin TLS, levantado por el arnés de integración local. La medición corre con `BUOH_DEPLOYMENT_ENVIRONMENT=development`, que no exige `https`, el usuario `buoh_api` ni TLS; el comportamiento de memoria (Argon2id, Fastify, el pool) es el mismo que en `production`.
- Node.js 24.22.0. El proceso de la API corre con los tamaños de V8 de `API_NODE_FLAGS` (`apps/api/src/node-flags.ts`): `--max-semi-space-size=1` y `--max-old-space-size=256`.
- El código de este PR, con `apps/api` compilado, `apps/web/out-api` presente (la API sirve sus páginas en la medición) y las herramientas de `scripts/evidencia-f2-3/`, que no son comandos del producto.

## Cómo se midió

`scripts/evidencia-f2-3/medir-memoria.mjs` migra el esquema `buoh_api` en la base local, arranca `apps/api/dist/cli/serve.js` con los tamaños de V8 de arriba, espera a que `/api/salud` responda 200 y lo somete a 3 series de 3 rondas. Cada ronda:

1. da de alta una cuenta nueva con `node apps/api/dist/cli/cuenta.js alta <usuario>` y toma su enlace de la salida;
2. pide el secreto TOTP (`POST /api/v1/enlace/secreto`), calcula el código y usa el enlace (`POST /api/v1/enlace`): aquí la API calcula el hash **Argon2id real** de la contraseña nueva (64 MiB, 3 pasadas, 1 hilo), el pico de memoria;
3. inicia sesión (`POST /api/v1/sesion`) con un código del paso siguiente: Argon2id de nuevo, para verificar;
4. lee la sesión (`GET /api/v1/sesion`) y la auditoría (`GET /api/v1/auditoria`), y pide dos páginas estáticas (`/` y `/acceso/`).

El máximo de cada serie es el `VmHWM` de `/proc/<pid>/status` del proceso de la API, en MiB de 1 048 576 bytes. Cuenta el mayor de las tres series. El script solo da por buena una ejecución en la que cada ronda responde como debe (alta y uso del enlace 200, inicio 201, sesión y auditoría 200, las dos páginas 200).

## Resultado

| Cómo corrió la API | Series × rondas | Máximo RSS | Techo orientativo | Starter | Resultado |
|---|---:|---:|---:|---:|---|
| con `API_NODE_FLAGS` (1 y 256 MiB) | 3 × 3 | 152,2 MiB | 300 MiB | 512 MB | pasa |
| sin opciones, viendo 31 GiB | 1 × 3 | 166,2 MiB | — | 512 MB | (contraste) |

- Las 9 rondas con los tamaños de V8 terminaron bien: alta y enlace 200, inicio 201, sesión y auditoría 200, las dos páginas 200. Las tres series dieron 151,8, 152,1 y 152,2 MiB.
- El proceso tardó algo menos de 2 s por serie, con el Argon2id real de dos operaciones por ronda.

## Por qué se fijan los tamaños de V8

Node dimensiona V8 con la memoria que ve, así que sin un límite visible elegiría un heap enorme y una generación joven grande, como explica la [evidencia de memoria de F2.1](evidencia-memoria-f2-1.md) («Por qué se fijan los tamaños de V8»). Se fijan los tamaños que Node elegiría al ver 512 MiB, el del Starter, para que la memoria no dependa de que la plataforma le muestre su límite, igual que `ingest` y `data:health` (ADR-0018 §3).

A diferencia del worker, la API no guarda un estado vivo que crezca con el tiempo: su pico es el Argon2id de un inicio o un alta (64 MiB de memoria nativa, uno a la vez), y las páginas estáticas se sirven como un flujo, sin cargarlas en memoria. Por eso el contraste entre correr con los tamaños y sin ellos es pequeño (152,2 frente a 166,2 MiB): los tamaños acotan sobre todo la generación joven y el heap reservado, no un estado acumulado. En los dos casos el máximo queda muy por debajo del Starter. El Starter real de Render no se midió; la cifra se confirmará al desplegar (`F2-API-001`, §12).

Los tamaños solo cuentan si el proceso arranca con ellos, delante del script: en el `startCommand` del Blueprint (PR 6b) y en el script `start` del paquete (`apps/api/package.json`).

## Reproducir

Desde la raíz, con `apps/api` compilado (`pnpm --filter @buoh/api run build`), Node 24.22.0 y el PostgreSQL local del arnés de integración:

```text
.buoh-local/integration.sh node scripts/evidencia-f2-3/medir-memoria.mjs
```

Escribe una línea JSON con los máximos, los tiempos y el resultado de cada ronda, sin claves ni contraseñas. Con `--sin-opciones` arranca la API sin los tamaños de V8, para el contraste. La medición entera lleva menos de un minuto.
