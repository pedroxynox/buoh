# ADR-0016: Alojamiento del sistema de datos en Render y Cloudflare R2

- **Estado:** Aceptada; la condición «Memoria» de §4 la diseña [ADR-0017](0017-punto-de-control-de-la-derivacion-en-vivo.md)
- **Fecha:** 2026-10-29
- **Ámbito:** despliegue del sistema de datos (`market-data-worker`, PostgreSQL y almacenamiento de objetos) en la Fase 2. Complementa [ADR-0006](0006-alojamiento-en-render.md): decide dos de sus pendientes.
- **Decisores:** Propietario de buoh (proveedores y presupuesto), a propuesta de la dirección técnica (planes y medición).

## Contexto

ADR-0006 eligió Render para PostgreSQL, la API y la web, y dejó pendientes dónde se aloja `market-data-worker` y el proveedor S3-compatible productivo. [`PROJECT_STATUS.md`](../../../PROJECT_STATUS.md) tenía el costo del alojamiento como decisión pendiente, y la Fase 2 la necesita: un bot *shadow* necesita datos vivos todo el día en un servidor.

El 2026-10-29 el propietario pidió: «si comprare el servidor que me mencionas, solo dame indicaciones de cuales y cual comprar, evalua si las consultas de buoh van a necesitar potencia y ram del servidor y demás». El agente midió buoh y le propuso Render Postgres Basic-256mb con 1 GB de disco, un background worker Starter de Render para `ingest`, Cloudflare R2 para los objetos y el workspace Hobby que ya publica el sitio: unos 15 USD al mes, unos 22 cuando exista la API, sin comprar nada hasta que el PR de despliegue esté listo. Le preguntó: «¿Te parece bien un presupuesto de unos 15 USD al mes para el servidor, y unos 22 cuando sumemos el inicio de sesión?». El propietario respondió: «Ok me parece perfecto todo».

### Medición

El 2026-10-29, en el sandbox de Kiro, con el PostgreSQL 18.4 y el SeaweedFS 4.48 portátiles del [steering del sandbox](../../../.kiro/steering/entorno-sandbox-kiro.md) y Node 24.22.0. No es Render, así que las cifras son orientativas.

| Prueba | Memoria (RSS) | CPU y tiempo |
|---|---|---|
| `ingest` en vivo con R_100, 241 s, desde un log vacío | de 107 a 141 MB | 1,79 s de CPU: el 0,7 % de un núcleo |
| `data:health` sobre ese log, al empezar, al minuto y a los 4 minutos | de 100 a 122 MB | de 0,3 a 0,8 s de reloj |
| `ingest` al arrancar sobre un log sintético de 17,8 horas (32 006 eventos) | sube a 358 MB en 6 s y se queda ahí (máximo, 359 MB) | 6,9 s de CPU en los primeros 30 s |
| `data:health` sobre ese log | 317 MB | 2,9 s de reloj y 3,4 s de CPU |

- **Cómo.** La memoria de `ingest` se leyó de `/proc/<pid>/status` (`VmRSS` y `VmHWM`) cada 10 s en la prueba en vivo, y cada 0,5 s al arrancar sobre el log sintético; la de `data:health`, con `getrusage` de su proceso. Las cifras están en MB de 1 048 576 bytes, como las cuenta `/proc`. El log sintético se escribió con el `SourceEventLog` del worker, con frames con la forma de los ticks de Deriv y precios inventados. Cada prueba usó un esquema y un bucket desechables, borrados al terminar.
- **Espacio.** 790 bytes de objetos y 269 bytes de PostgreSQL por evento, índices incluidos. R_100 da unos 45 000 eventos al día (un tick cada 2 s, más los `ping` y las respuestas): unos 35 MB de objetos y 12 MB de PostgreSQL por día.
- **Por qué crece la memoria.** Al arrancar, mientras vigila un hueco y en cada `data:health`, el worker lee y deriva el log durable entero (`readDurableSegments`: `#openLog` y `#watchGap` en `src/deriv/session.ts`, y `readLog` en `src/health/observe.ts`). Son unos 8 KB por evento en `ingest` y 7 KB en `data:health`. Por extrapolación lineal, con un log de 23 horas (unos 45 000 eventos) `ingest` llegaría a unos 460 MB y `data:health` a unos 400 MB.

### Precios comprobados el 2026-10-29

- **Render.** El workspace Hobby no tiene cuota mensual e incluye 5 GB al mes de tráfico de salida y 500 minutos de compilación. En julio de 2026, un servicio Starter siempre encendido y un Render Postgres Basic-256mb costaban unos 13 USD al mes, sin contar tráfico ni disco. El disco de PostgreSQL cuesta 0,30 USD por GB al mes y se elige de 1 GB o en múltiplos de 5: se puede ampliar, no reducir. El tráfico de salida que pasa de lo incluido cuesta 0,15 USD por GB. Los background workers no tienen plan gratuito. El cambio de nombres de los planes del 26 de agosto de 2026 no cambió los precios: Starter es 0,5 CPU y 512 MB, y Basic-256mb, 0,1 CPU y 256 MB. La región de un servicio no se puede cambiar después de crearlo. Que el worker Starter cuesta 7 USD y el Standard (1 CPU y 2 GB) 25 USD sale de fuentes secundarias, y los unos 6 USD del Basic-256mb salen de restar esos 7 USD a los 13 del artículo de Render: se confirman al comprar. Los cron jobs se cobran por minuto, con un mínimo de 1 USD al mes por servicio. Lo que llega a los servicios de Render no cuenta como tráfico de salida.
- **Cloudflare R2.** 0,015 USD por GB al mes. Las operaciones de clase A (`PutObject` y `ListObjects`, entre otras) cuestan 4,50 USD por millón, y las de clase B (`HeadObject` y `GetObject`, entre otras), 0,36 USD por millón. Cada mes son gratis 10 GB, un millón de operaciones de clase A y diez millones de clase B. R2 no cobra la salida de datos.

## Decisión

### 1. Proveedores

- **`market-data-worker`:** un background worker de Render, en el mismo workspace que el sitio oficial.
- **PostgreSQL:** Render Postgres, como ya decía ADR-0006.
- **Almacenamiento de objetos:** Cloudflare R2, que es S3-compatible.

### 2. Planes iniciales y presupuesto

| Servicio | Plan | Costo aproximado al mes |
|---|---|---|
| PostgreSQL | Render Postgres Basic-256mb, con 1 GB de disco | 6,30 USD |
| `ingest` | Background worker Starter de Render (0,5 CPU, 512 MB) | 7 USD |
| Objetos | Cloudflare R2 | de 1 a 2 USD |
| Workspace | Hobby | 0 USD |

En total, unos 15 USD al mes, para un solo símbolo, R_100 (`PROJECT_STATUS.md`, «Decisiones vigentes relevantes»): cada símbolo más suma operaciones de R2 y espacio. No cuenta dónde corra `data:health` (§4). La API (`apps/api`), cuando exista, añade otro servicio Starter: unos 22 USD al mes. Cambiar a un plan que suba ese presupuesto necesita el visto bueno del propietario.

### 3. Cuándo se compra

No se crea ni se paga nada hasta que esté listo el PR de despliegue, el incremento del plan de la Fase 2 que defina los servicios, los roles, los secretos y las comprobaciones. Ese PR le da al propietario los pasos exactos: el agente no tiene acceso a Render ni a Cloudflare.

### 4. Condiciones antes de desplegar

Salen de la medición y de pendientes ya registrados. El plan de la Fase 2 las pone antes del incremento de despliegue:

- **Memoria.** Los 512 MB del Starter solo alcanzan si el worker deja de leer y derivar el log entero al arrancar, al vigilar un hueco y en `data:health`, con un punto de control. Sin él, un día de captura casi los llena, y `data:health` no cabe a la vez en la misma instancia.
- **PostgreSQL.** Un rol de ejecución que solo pueda insertar y leer (pendiente 4 de F1.3 y ADR-0006).
- **Retención y entorno.** Hoy `ingest` para a las 23 horas, la captura se borra antes de las 24, y `ingest` rechaza los entornos `staging` y `production` ([ADR-0015](0015-reconexion-recuperacion-y-salud-f1-5.md) §7). El incremento de despliegue cambia esas reglas.
- **R2.** Antes de crear el bucket de producción, se comprueba contra un bucket de prueba de R2 lo que necesita el log: que una escritura condicional (`If-None-Match: *`) sobre una clave que ya existe responde 412, que un objeto se lee justo después de escribirlo y que el cliente S3 funciona con las sumas de comprobación en `WHEN_REQUIRED`.
- **`data:health`.** Dónde corre en producción lo decide el incremento de despliegue. Si va en un proceso aparte, por ejemplo un cron job de Render, suma al presupuesto de §2.
- **Credenciales.** Un token de R2 limitado al bucket de su entorno y las del rol de PostgreSQL, como variables `BUOH_*` del servicio en Render. Nunca en Git.
- **Región.** La de Render y la de R2 se eligen en el PR de despliegue, porque la de Render no se puede cambiar después.

### 5. Qué no autoriza

No autoriza a desplegar, comprar, crear `apps/api` ni añadir servicios a `render.yaml`. Eso llega con un incremento del plan de la Fase 2. [ADR-0013](0013-publicacion-del-sitio-en-render.md) sigue rigiendo el sitio oficial.

## Consecuencias

- **Operaciones de R2.** Cada evento durable es una escritura (`PutObject`, de clase A) y su verificación, que lo relee (`HeadObject` y `GetObject`, de clase B). Con R_100, al mes son 1,35 millones de clase A, que pasan lo gratuito en unos 1,6 USD, y 2,7 millones de clase B.
- **Frecuencia de `data:health`.** Cada ejecución lee de R2 cada segmento cerrado y cada evento del segmento abierto, con un `HeadObject` y un `GetObject` cada uno. Con un día de log (276 segmentos cerrados y unos 157 eventos abiertos) son unas 870 lecturas de clase B (estimación). Cada 5 minutos son unos 7,5 millones al mes, que con los 2,7 millones de la captura pasan por poco los 10 millones gratuitos (unos 0,07 USD); cada minuto serían unos 37 millones, unos 11 USD más al mes. El incremento de despliegue fija la frecuencia, y el punto de control también abarata cada lectura.
- **Tráfico de salida.** Render cuenta lo que sus servicios envían fuera de Render: los cuerpos de `PutObject`, unos 35 MB al día, y la petición firmada de cada operación de R2, de alrededor de 1 KB, que con millones de operaciones al mes probablemente pesa más que los objetos (estimación). Lo que devuelve R2, como el contenido de `GetObject`, entra en Render y no se cobra. Todo comparte los 5 GB incluidos con el sitio. No se midió: el incremento de despliegue lo mide, y lo que pase de 5 GB cuesta 0,15 USD por GB.
- **Guardar más tiempo cuesta poco.** Un mes de R_100 ocuparía unos 1,1 GB de objetos, dentro de los 10 GB gratuitos de R2, y 0,4 GB de PostgreSQL (estimación con el espacio medido por evento). El disco de 1 GB alcanzaría para unos dos meses; después pasa a 5 GB, 1,50 USD al mes. Cuánto se guarda lo decide la retención de producción.
- **Backtests.** Con la derivación de hoy, todo en memoria, un mes de datos ocuparía unos 10 GB (estimación con los 8 KB por evento), así que el motor de backtest de la Fase 2 tiene que leer los datos por partes. Derivar 32 000 eventos llevó unos 3 s de CPU en el sandbox: un mes, unos 2 minutos de un núcleo, y más con 0,5 CPU (estimación). Dónde corren los backtests lo decide el plan de la Fase 2.
- **Salida si el punto de control no llega.** El worker Standard (1 CPU y 2 GB) cabe sin cambiar el código, pero sube el total a unos 33 USD al mes y necesita el visto bueno del propietario.

## Alternativas descartadas

| Alternativa | Motivo |
|---|---|
| Un servidor propio, por ejemplo un Hetzner CX23 (2 vCPU y 4 GB, unos 5,49 € al mes según fuentes secundarias) | Es más barato y tiene más memoria, pero el propietario, que no es programador, tendría que mantener el sistema operativo, los parches, las copias de seguridad y la seguridad. Además, ADR-0006 ya eligió Render Postgres. |
| Worker Standard de Render desde el principio | Cabe sin el punto de control, pero cuesta unos 18 USD más al mes, y el punto de control hace falta igual para guardar más de un día. Queda como salida (Consecuencias). |
| Disco persistente de Render en lugar de almacenamiento de objetos | El log raw-first escribe en PostgreSQL y en almacenamiento S3-compatible ([ADR-0005](0005-persistencia-local-y-formato-fisico-f1-3.md)), y un disco ata los datos a un solo servicio. |
| Otros proveedores S3 (AWS S3, Backblaze B2) | No se compararon en detalle. R2 no cobra la salida de datos, y su plan gratuito cubre casi todo el uso medido. |

## Referencias verificadas

- [Render: costes y planes de workspace](https://render.com/articles/how-much-does-cloud-application-hosting-cost-for-small-businesses)
- [Render: nombres nuevos de los planes, sin cambio de precios](https://render.com/docs/compute-plans-update)
- [Render: referencia del Blueprint (región y disco de PostgreSQL)](https://render.com/docs/blueprint-spec)
- [Render: tráfico de salida](https://render.com/docs/outbound-bandwidth)
- [Render: planes flexibles de Render Postgres y precio del disco](https://render.com/docs/postgresql-refresh)
- [Render: documentación en texto, con la tabla de planes de Render Postgres](https://render.com/llms-full.txt)
- [Cloudflare R2: precios y clases de operaciones](https://developers.cloudflare.com/r2/pricing/)

El contenido de fuentes externas fue reformulado para cumplir restricciones de licencia.
