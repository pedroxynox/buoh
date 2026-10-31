# ADR-0018: Sistema de datos en producción (F2.2)

- **Estado:** Aceptada
- **Fecha:** 2026-10-31
- **Ámbito:** Fase 2, incremento F2.2 (`F2-DEPLOY-001`, `F2-ROLE-001` y `F2-RETENTION-001` del [plan de Fase 2](../../plan/fase-2-laboratorio-y-bot-shadow.md))
- **Decisores:** Propietario de buoh (región, retención frente a los términos de Deriv, el cron job de unos 1 USD al mes y la base de datos abierta a internet), a propuesta de la dirección técnica (lo demás).
- **Complementa:** [ADR-0016](0016-alojamiento-del-sistema-de-datos.md) §4, cuyas condiciones resuelve, y §2, cuyo presupuesto sube en unos 1 USD; [ADR-0015](0015-reconexion-recuperacion-y-salud-f1-5.md) §7, que sustituye en `production`, y §10, que decide la historia de las paradas programadas; [ADR-0017](0017-punto-de-control-de-la-derivacion-en-vivo.md) §4, cuya verificación periódica programa, y §7, cuyo corte entre logs decide; [ADR-0005](0005-persistencia-local-y-formato-fisico-f1-3.md) §3, cuyas claves llevan en `production` el prefijo del log; y [ADR-0006](0006-alojamiento-en-render.md), cuya región fija. No cambia los datasets, el replay ni los vectores, ni la retención de `development` y `test` ([ADR-0004](0004-pipeline-y-reproduccion-de-datos-fase-1.md) §13).

## Contexto

El plan de la Fase 2 pide esta ADR antes del código de F2.2 (§8, punto 2): las condiciones de ADR-0016 §4 que quedan después del punto de control (los roles, la retención, las reglas de `ingest` en producción, las comprobaciones de R2, dónde y cada cuánto corre `data:health`, las credenciales y la región), el cifrado de la conexión a PostgreSQL, el Blueprint de Render, la historia tras una parada programada, el solape de dos instancias durante un despliegue, la medición del tráfico de salida y el canal de la evidencia de producción (§4, punto 10). La condición «Memoria» ya se cumple: con un log de 7 días, `ingest` llegó como mucho a 124 MiB y `data:health` a 118 MiB, arrancados con `WORKER_NODE_FLAGS` ([evidencia de memoria de F2.1](../../operacion/evidencia-memoria-f2-1.md)).

**En el código, el 2026-10-31:**

- `checkIngestConfig` (`apps/market-data-worker/src/ingest-args.ts`) rechaza `staging` y `production`, el esquema `public` y el bucket `buoh-local`. `ingest` para cuando el evento durable más antiguo cumple 23 horas (`INGEST_RETENTION_MS`) y no arranca con un log que ya las cumplió (`retention_expired`).
- Al arrancar, si otro proceso tiene el bloqueo de la fuente, la sesión termina `failed` con `source_lock_taken` (`src/deriv/session.ts`).
- `createPool` (`src/postgres/metadata-store.ts`) conecta sin TLS, con 4 conexiones como mucho y el `search_path` del esquema de la configuración. Un solo rol, el de `BUOH_POSTGRES_USER`, ejecuta y migra, y `db:migrate` deja salir sus errores sin sanear.
- Las claves de los objetos son `sha256/<hash>` y `manifests/…`, sin prefijo, en el bucket de la configuración (`src/object-keys.ts`), y las tablas de datasets (`0001`) viven en el mismo esquema que el log.
- El cliente S3 escribe con `IfNoneMatch: '*'` y calcula y valida sumas de comprobación solo cuando hacen falta (`WHEN_REQUIRED`, `src/s3/object-store.ts`). `ingestion_heartbeats.write_order` es una columna de identidad (`0004`).

**De los proveedores, el 2026-10-31:**

- **Render.**
  - El despliegue sin corte vale también para background workers y cron jobs: Render arranca la instancia nueva junto a la vieja y, 60 s después, manda `SIGTERM` a la vieja. Si no termina en `maxShutdownDelaySeconds` (30 s por defecto, hasta 300), le manda `SIGKILL`. Un disco persistente desactiva el despliegue sin corte. Los health checks solo existen en servicios web y privados.
  - Un cron job se cobra por segundo, con un mínimo de 1 USD al mes por servicio, y corre una ejecución a la vez: si una se alarga, la siguiente espera. El comando previo al despliegue (`preDeployCommand`) no existe en los cron jobs.
  - Render Postgres acepta TLS en la conexión interna, con certificados autofirmados, así que solo admite `sslmode=require`. La externa siempre va cifrada. Sin `ipAllowList`, la base acepta conexiones de cualquier IP con credenciales válidas, y una lista vacía cierra el acceso externo. La región, la versión mayor, la base y el usuario no se cambian después. Si la base llena su disco, Render la suspende.
  - Un push que cambia el archivo de un Blueprint enlazado aplica el cambio (*Auto Sync*, encendido por defecto). Las variables `sync: false` solo se piden al crear el Blueprint. `generateValue: true` genera un valor aleatorio de 256 bits, y los grupos de entorno lo admiten, pero no `sync: false` ni referencias a la base. Un Blueprint puede leer otro archivo que `render.yaml` (*Blueprint Path*).
  - En el plan Hobby, Render guarda los logs 7 días, y la página *Metrics* de cada servicio muestra su memoria y su tráfico de salida. Sus claves de API dan acceso a toda la cuenta ([`PROJECT_STATUS.md`](../../../PROJECT_STATUS.md), «Decisiones vigentes relevantes»).
- **Cloudflare R2.**
  - La indicación de ubicación `enam` (este de Norteamérica) es orientativa y solo cuenta la primera vez que se crea un bucket con ese nombre. Una jurisdicción sí obliga, pero solo garantiza el país y necesita su propio endpoint.
  - Los tokens *Object Read & Write* y *Object Read only* se limitan a buckets concretos. Los de administración crean y borran buckets de toda la cuenta.
  - `PutObject` con `If-None-Match: *` se evalúa de forma atómica y responde 412 si la clave ya existe, y R2 es fuertemente consistente. Varias operaciones no admiten las cabeceras de suma de comprobación de los SDK.
- **Kiro Web.** Los *Secrets* de *Settings > Sandbox* se guardan cifrados y llegan al sandbox como variables de entorno durante la tarea. Su documentación advierte que el agente podría filtrarlos, y recomienda dar solo los necesarios. La IP de salida del sandbox es de AWS en us-east-1 y no es fija.
- **Deriv.** Sus [términos para usuarios de la API](https://deriv.com/terms-and-conditions/api-users) dicen:
  - no se puede guardar ningún contenido de su sitio o de su API, como los datos del feed (2.1);
  - se puede tener en caché hasta 24 horas desde la petición (2.3);
  - al terminar la relación hay que borrarlo todo (2.4);
  - Deriv puede bloquear el acceso a quien abuse de sus límites (1.3) y terminar el uso de la API en cualquier momento, sin aviso (8.1).

  Sus términos generales para socios llaman «API User» a quien usa la API para consumir sus datos y construir aplicaciones de trading que interactúan con sus plataformas (2.2), como buoh.

**Decisiones del propietario del 2026-10-31.** El agente le preguntó, con opciones y su recomendación:

- **Región.** Respondió: «Virginia (EE. UU. este), la que recomendaste, con el bucket de R2 en el este de Norteamérica».
- **Retención frente a los términos de Deriv.** Las opciones eran A, guardar como mucho 24 horas y pedir a Deriv permiso por escrito (la recomendación); B, guardar 30 días igual, aunque Deriv pueda cortar el acceso; y C, no desplegar hasta que Deriv respondiera. Respondió: «En la pregunta nro1 elijo la B, guardar 30 dias los datos igualmente, este proyecto es para trabajar contra el broker y no a favor del broker». Antes había delegado la retención en la dirección técnica («cuanto tiempo guarda los datos lo decides tu»).
- **Un cron job de unos 1 USD al mes** para las operaciones de §11: «la respuesta nro 2, apruebo 1 usd mas».
- **La base de datos.** Las opciones eran cerrarla a internet, con la salud al alcance del agente a través de informes (la recomendación), o abrirla con contraseña y cifrado. Respondió: «la respuesta nro 3, abierta a internet para que trabaje libremente». El acceso del agente ya estaba decidido: «si te dare acceso de produccion tambien acceso total», y la dirección técnica usa el mínimo que cada tarea necesita.

## Decisión

### 1. Región

Todo el sistema de datos va en la región `virginia` de Render: la base, el worker, el cron job y, cuando lleguen, la API y el motor, porque los servicios de Render solo comparten red privada dentro de una región. Los buckets de R2 se crean con la indicación `enam`. Es la decisión del propietario. No se usa una jurisdicción de R2: garantizaría el país, no el este, y obligaría a otro endpoint.

### 2. Servicios y Blueprint

El sistema de datos tiene su propio Blueprint, `render-datos.yaml`, en la raíz del repositorio. `render.yaml` sigue con solo el sitio oficial, y su prueba no cambia ([ADR-0013](0013-publicacion-del-sitio-en-render.md)). Así, fusionar el PR de despliegue no crea ni cobra nada (ADR-0016 §3): ningún Blueprint lee ese archivo hasta que el propietario lo crea con los pasos del runbook, y en ese momento Render le pide cada valor `sync: false`. Si estuviera en `render.yaml`, Auto Sync crearía los servicios al fusionar, sin pedir sus secretos. La API (F2.3) y el motor (F2.9) entran en `render-datos.yaml`. Como Render ya no pide los valores de un Blueprint existente, el PR que añada un secreto dirá dónde lo pone el propietario.

| Recurso | Tipo y plan | Qué hace |
|---|---|---|
| `buoh-postgres` | Render Postgres `basic-256mb`, 1 GB de disco, PostgreSQL 18, sin almacenamiento autoescalado | la base del sistema de datos, con `databaseName` y `user` `buoh` |
| `buoh-ingesta` | background worker `starter`, una instancia | `ingest --live --symbol R_100` (§4) |
| `buoh-operaciones` | cron job `starter`, `*/5 * * * *` | salud, roles, logs, retención y verificación (§11) |

- Los dos servicios usan el runtime de Node, con el Node de `.node-version` (24.22.0), e instalan y compilan con pnpm 12.14.0 solo el worker y sus paquetes, como el sitio. Despliegan después de CI (`autoDeployTrigger: checksPass`) y solo cuando cambia algo de lo que depende el worker (`buildFilter`).
- `buoh-ingesta` tiene `maxShutdownDelaySeconds: 60`, el minuto que el runbook da a la parada antes de `SIGKILL`. Tiene siempre una instancia: una segunda esperaría el bloqueo sin fin.
- Ningún servicio lleva disco persistente: desactivaría el despliegue sin corte, y el log no confía su durabilidad al disco local (ADR-0006).
- El almacenamiento autoescalado de la base queda apagado: subiría el presupuesto sin el visto bueno del propietario. El espacio lo vigilan §7 y el runbook.
- La prueba de `render-datos.yaml`, en `scripts/`, fija los recursos y sus claves, la región, los planes, el disco, la versión, `ipAllowList`, los comandos con `WORKER_NODE_FLAGS`, el plazo de parada y la única instancia. Comprueba también que ninguna contraseña, token ni endpoint de la cuenta lleva su valor en el archivo: llegan con `sync: false`, `generateValue`, `fromDatabase` o `fromGroup`.

### 3. Arranque y parada

- Los comandos de Render ejecutan Node directamente, con `WORKER_NODE_FLAGS` delante del script (`node --max-semi-space-size=1 --max-old-space-size=256 apps/market-data-worker/dist/cli/<comando>.js …`), sin pnpm de por medio, para que el `SIGTERM` de Render llegue al proceso de `ingest` (ADR-0017 §9). El `data:health` que lanza `buoh-operaciones` arranca con las mismas opciones. La prueba del Blueprint lee las opciones de `src/node-flags.ts` y las compara con cada comando.
- Con `SIGTERM`, `ingest` para como hoy (ADR-0015 §3, «Parada»): `forget_all`, cierre `requested`, segmento cerrado, cursor y bloqueo suelto. La evidencia de producción (§13) comprueba en el log que, en cada despliegue, la conexión anterior cerró con `requested` y no con `close_not_recorded`.
- Si el proceso termina con error, Render lo vuelve a arrancar. Un fallo que se repite, como `log_not_derivable`, queda en sus logs y en la salud.

### 4. `ingest` en `production`

En `production`, estas reglas sustituyen a las de ADR-0015 §7:

- `ingest` admite `BUOH_DEPLOYMENT_ENVIRONMENT=production`. Sigue rechazando `staging`, que no existe en la Fase 2 (plan §4, punto 9).
- No para a las 23 horas ni comprueba `retention_expired`: la retención la llevan los logs sucesivos (§6 y §7).
- No admite `BUOH_POSTGRES_SCHEMA`: el esquema y el prefijo de cada log salen de su número (§6), y `BUOH_S3_BUCKET` es el bucket de la captura.
- Exige `BUOH_POSTGRES_SSLMODE` distinto de `disable` (§9).
- Al arrancar, espera sin escribir nada hasta que haya un log preparado con todas sus migraciones y el bloqueo de la fuente esté libre, en ese orden. Mientras espera, deja cada minuto la alerta saneada `ingest_waiting`, con el motivo (`log_not_prepared`, `migrations_pending` o `source_lock_taken`). Así, un despliegue o una migración nueva no hacen que termine ni que se reinicie en bucle (§5).
- Si pierde el bloqueo mientras captura y lo tiene otro proceso, termina con `source_lock_taken`, como hoy: el otro es el escritor.

En `development` y `test` todo sigue como en ADR-0015 §7: la parada a las 23 horas, `retention_expired`, el esquema y el bucket propios, distintos de `public` y `buoh-local`, `MIGRATIONS_PENDING` con salida 2 y `source_lock_taken` al arrancar. La retención de desarrollo sigue siendo de 24 horas (ADR-0004 §13).

### 5. Despliegues: solape e historia

- **Solape.** Durante un despliegue, la instancia nueva espera el bloqueo (§4) mientras la vieja sigue capturando. Cuando la vieja recibe `SIGTERM`, para y suelta el bloqueo, y la nueva lo toma y sigue el mismo log. El bloqueo de la fuente garantiza un solo escritor (ADR-0012 §9 y ADR-0015 §3). El hueco dura unos segundos y queda visible en el log como un cierre `requested` seguido de la apertura siguiente. Render hace un solo despliegue de cada servicio a la vez, y con su política *Wait*, uno que llega durante otro espera a que termine.
- **Migraciones.** Si el despliegue trae una migración, la instancia nueva espera a que `buoh-operaciones` la aplique en su primera ejecución con el código nuevo (§11). Como la vieja recibe `SIGTERM` 60 s después de que arranca la nueva, la captura puede parar unos minutos, solo en esos despliegues. Las migraciones de los logs solo añaden, para que el código anterior siga funcionando mientras dura un despliegue.
- **Historia.** Una parada programada (un despliegue, un corte semanal o una parada a mano) no recupera su historia. Un cierre pedido no deja hueco pendiente (ADR-0015 §10), y recuperarla exigiría que lo dejara, una regla que ADR-0015 descartó. Además, los ticks de la historia no se convierten en `MarketTick` hasta que lo decida la ADR de datasets vivos (F2.5), que puede revisarlo con los huecos medidos.

### 6. Logs sucesivos

En `production`, la captura es una sucesión de logs numerados desde 1:

- **Nombres.** El log *n* tiene el esquema `buoh_log_<n>` y el prefijo `logs/<n>/` en el bucket `buoh-captura`, con *n* en seis cifras (`buoh_log_000001` y `logs/000001/`). Todas sus claves, también las de ADR-0005 §3, van bajo ese prefijo. Nada del estado de un log pasa a otro (ADR-0017 §7). En `development` y `test`, un log sigue como hoy: el esquema de `BUOH_POSTGRES_SCHEMA` y el bucket de `BUOH_S3_BUCKET`, sin prefijo.
- **Log activo.** Es el de mayor número que tiene algún evento, o el preparado de menor número si ninguno tiene eventos. `ingest`, `data:health` y el agente lo buscan igual: los esquemas con ese nombre en `pg_namespace` y una lectura del índice de cada uno. Normalmente hay siete como mucho (§7), así que no hace falta una tabla de registro.
- **Preparación.** `buoh-operaciones` crea el log *n*+1 en cuanto el log *n* tiene eventos: el esquema, sus migraciones y sus privilegios (§8). Así siempre hay un log vacío y preparado por delante.
- **Corte.** Es semanal, desde el lunes a las 00:00 UTC. `ingest` corta en el primer momento posterior en que el log activo está limpio: conectado, sin continuidad pendiente y sin `connection_lost` abierta. El mismo proceso para la sesión del log *n* como una parada (ADR-0015 §3), vuelve a tomar el bloqueo y abre una sesión nueva sobre el log *n*+1, con su catálogo, su esquema de fuente guardado y una primera conexión con `supersedes_connection_id: null`. Si el log *n*+1 no está preparado, no corta: sigue en el log *n*, deja una alerta y lo intenta en el siguiente momento limpio. Si muere después de parar el log *n* y antes de escribir en el *n*+1, el arranque siguiente retoma el *n* y vuelve a cortar.
- **Condiciones que no bloquean.** Una `event_gap_unresolved` abierta no impide el corte. F1.5 no vuelve a intentar una recuperación agotada, así que esa condición bloquearía para siempre. La pérdida queda registrada en el log *n*, que cubre su período, y el log *n*+1 cubre otro. Esto precisa ADR-0017 §7, que pedía cortar sin condiciones derivables abiertas: bloquean la continuidad pendiente y `connection_lost`, que todavía pueden recuperarse.

### 7. Retención

- **30 días.** Es la decisión del propietario, aunque los términos de Deriv solo permiten tener sus datos en caché 24 horas («Contexto»). El log *n* se borra cuando no es el activo y su evento más reciente tiene 30 días o más. Con logs semanales, producción guarda siempre al menos los últimos 30 días y, como mucho, unos 37, o más si un corte se retrasa.
- **Borrado.** Lo hace `buoh-operaciones` (§11), un log por ejecución como mucho. Primero borra los objetos del prefijo `logs/<n>/`, por partes y de forma que una ejecución cortada siga en la siguiente. Después, con el rol dueño, borra el esquema `buoh_log_<n>` entero (`DROP SCHEMA … CASCADE`). Ninguna fila de una tabla append-only se modifica (`F2-RETENTION-001`). Nunca borra el log activo ni el preparado, así que se mantiene la regla de ADR-0017 §4: nada borra objetos de un log en uso. Borrar el prefijo entero de un log terminado ocupa el lugar de borrar su bucket.
- **Datasets.** No viven en el esquema ni en el prefijo de un log. Se guardan al menos 30 días. El que cita un backtest, una evaluación o una decisión del motor se guarda al menos tanto como esa evidencia, también si la estrategia se rechazó ([protocolo de validación](../../gobierno/protocolo-de-validacion-de-estrategias.md) §4). La ADR de datasets vivos (F2.5) decide dónde, dentro del presupuesto.
- **Espacio.** Con R_100, cada log ocupa unos 14 MB de PostgreSQL al día: 269 bytes por evento (ADR-0016, «Medición») por unos 45 000 eventos, más los puntos de control, los latidos y los informes de §11. Con 37 días son unos 0,55 GB, y en R2, unos 1,3 GB (estimación). `buoh-operaciones` anota cada día el tamaño de la base y el de cada log. Hay que revisar la retención con 700 MB de PostgreSQL, el 70 % del disco, porque Render suspende la base si lo llena, o con 8 GB en R2, el 80 % de lo gratuito. El disco de 5 GB (1,50 USD al mes en lugar de 0,30) necesita antes el visto bueno del propietario (plan §12).

### 8. Roles de PostgreSQL

| Rol | Inicio de sesión | Privilegios | Lo usa |
|---|---|---|---|
| `buoh`, el usuario de Render, dueño de la base | sí | dueño de los esquemas de los logs | `buoh-operaciones`: migraciones, preparación, retención y roles |
| `buoh_ingesta` | sí | en cada log: uso del esquema, `SELECT` e `INSERT` en sus tablas y uso de sus secuencias | `ingest` |
| `buoh_lectura` | no | en cada log: uso del esquema y `SELECT` en sus tablas | grupo de los dos siguientes |
| `buoh_salud` | sí, miembro de `buoh_lectura` | los de `buoh_lectura` | `data:health` en `buoh-operaciones` |
| `buoh_agente` | sí, miembro de `buoh_lectura`, con un límite de conexiones y de tiempo por consulta | los de `buoh_lectura` | el agente, desde el sandbox (§12) |

- Ningún rol de ejecución puede actualizar, borrar, vaciar ni cambiar el esquema de una tabla. Los límites de `buoh_agente` evitan que una consulta suya le quite a la captura los 0,1 CPU de Basic-256mb.
- La API (F2.3) y el motor (F2.9) tendrán sus propios roles, que fijan sus ADR. `buoh_lectura` no lee sus tablas salvo que esas ADR lo digan.
- `buoh-operaciones`, con `buoh`, crea los roles que falten y les da sus privilegios en cada log después de migrarlo. Les pone su contraseña solo cuando no pueden iniciar sesión con ella, para no reescribirla cada 5 minutos, y envía el verificador SCRAM calculado en el cliente, nunca la contraseña en claro.
- Render genera las contraseñas (`generateValue`). La de `buoh_ingesta` va en un grupo de entorno enlazado solo a `buoh-ingesta` y `buoh-operaciones`. Las de `buoh_salud` y `buoh_agente` son variables de `buoh-operaciones`.
- `db:migrate` usa las credenciales de `buoh`, separadas de las de ejecución, y sus errores salen saneados como los de `ingest`: un código o el nombre del error, nunca su mensaje.
- En `development` y `test` puede seguir bastando un solo rol. Las pruebas de integración crean los de ejecución para comprobar sus privilegios (§15).

### 9. Cifrado y acceso a PostgreSQL

- **Variable.** `BUOH_POSTGRES_SSLMODE` admite `disable`, `require` o `verify-full`. En `production` es obligatoria y no admite `disable`. `require` cifra sin verificar el certificado (`ssl: { rejectUnauthorized: false }` en `pg`), y `verify-full` comprueba además la autoridad y el nombre del servidor (`ssl: true`). Ninguno de los dos vuelve a una conexión sin cifrar si el servidor no admite TLS.
- **Dentro de Render**, los servicios usan la dirección interna con `require`, porque su certificado es autofirmado y no se puede verificar.
- **Desde fuera**, el agente y cualquier herramienta usan la dirección externa, que Render siempre cifra. Con la base creada, el PR de despliegue comprueba si su certificado se valida con las autoridades de Node: si se valida, el runbook fija `verify-full`; si no, `require`.
- **Internet.** La base acepta conexiones de cualquier IP (`ipAllowList` con `0.0.0.0/0`), como decidió el propietario. La protegen el cifrado, las contraseñas generadas y los roles mínimos. Una credencial filtrada se puede usar desde cualquier lugar, y la más poderosa, la de `buoh`, solo está en `buoh-operaciones` y en el panel de Render. Cerrar la base es cambiar la lista por `[]` en un PR: solo perdería su acceso directo el agente.

### 10. Cloudflare R2

- **Buckets**, creados por el propietario con la indicación `enam`: `buoh-captura`, para los logs de producción, y `buoh-prueba`, solo para las comprobaciones de abajo, que se borra al terminarlas. El bucket de los datasets lo decide F2.5.
- **Tokens.** Cada proceso tiene el suyo, con el endpoint de la cuenta (`https://<ACCOUNT_ID>.r2.cloudflarestorage.com`) y la región `auto`:

  | Token | Permiso | Bucket | Lo usa |
  |---|---|---|---|
  | `ingesta` | Object Read & Write | `buoh-captura` | `ingest` |
  | `operaciones` | Object Read & Write | `buoh-captura` | la retención y la verificación de §11 |
  | `salud` | Object Read only | `buoh-captura` | `data:health` en `buoh-operaciones` |
  | `agente` | Object Read only | `buoh-captura` | el agente (§12) |
  | `prueba` | Object Read & Write, que vence en un día | `buoh-prueba` | el agente, solo para las comprobaciones |

  Ninguno es de administración: crear y borrar buckets queda para el propietario, en el panel. El prefijo de cada log evita crear un bucket por semana.
- **Comprobaciones previas** (ADR-0016 §4). Antes de crear `buoh-captura`, un script de `scripts/evidencia-f2-2/`, fuera de los comandos del producto, las hace contra `buoh-prueba` con el `S3ObjectStore` del worker:
  1. escribir con `writeVerified` en una clave que ya existe responde 412 y deja el objeto como estaba;
  2. leer justo después de escribir devuelve los mismos bytes, y `HeadObject`, el mismo tamaño;
  3. el cliente, con las sumas de comprobación en `WHEN_REQUIRED`, escribe y lee sin error.

  Un PR registra el resultado, saneado: sin el ID de la cuenta ni las claves.

### 11. Operaciones (`buoh-operaciones`)

Es el cron job de Render que aprobó el propietario: corre cada 5 minutos, y una ejecución a la vez. Cada ejecución hace, en orden:

1. **Salud.** Ejecuta `data:health` (`apps/market-data-worker/dist/cli/health.js --json`) en un proceso aparte, con `WORKER_NODE_FLAGS`, el rol `buoh_salud` y el token `salud`, sobre el log activo. Guarda su línea, el `HealthReport` sin precios, en una tabla append-only del log activo, con la hora y la ejecución, y la escribe en stdout, que Render guarda 7 días. `data:health` sigue sin escribir nada (ADR-0015 §8): quien guarda el informe es este servicio, con `buoh`.
2. **Roles y logs.** Crea y ajusta los roles (§8), aplica las migraciones pendientes a cada log que existe, le da los privilegios y prepara el log siguiente (§6).
3. **Retención.** Borra el log que haya vencido (§7).
4. **Verificación por partes.** Es la verificación periódica de ADR-0017 §4. Vuelve a leer una parte de los segmentos cerrados de los logs guardados (el segmento *i*, en la ejecución número *i* mod 288 del día UTC) y compara sus hashes con `closed_source_segments`. Cada segmento se relee así una vez al día. Guarda cuántos leyó y cuáles no coinciden, y uno que no coincide deja además una alerta saneada.
5. **Espacio.** Una vez al día, guarda el tamaño de la base y el de cada log (§7).

- **Lecturas de R2**, en operaciones de clase B: cada `data:health` lee el esquema de fuente guardado, los eventos del segmento abierto y, normalmente, como mucho un segmento cerrado. Son unas 160 de media, con un segmento abierto de 5 minutos a medio llenar, y unas 320 como mucho: unos 1,4 millones al mes. La verificación suma unos 0,64 millones (unos 10 700 segmentos guardados, con una lectura de cabecera y otra de contenido cada día). Con los 2,7 millones de la captura son unos 4,7 millones, dentro de los 10 millones gratuitos (estimación).
- **Cómputo.** Cada ejecución dura unas decenas de segundos en su propia instancia Starter, que no comparte memoria con `ingest`. Al mes suman menos que el mínimo de 1 USD (estimación).
- **El agente** ejecuta además `data:health` cuando lo necesita, desde el sandbox, con `buoh_agente` y el token `agente`.

### 12. Credenciales

- **En producción**, solo como variables `BUOH_*` de cada servicio de Render y de sus grupos de entorno:
  - `sync: false` para el endpoint y los tokens de R2, que el propietario pega al crear el Blueprint;
  - `generateValue` para las contraseñas de los roles;
  - `fromDatabase` para el servidor, el puerto y la base;
  - las credenciales de `buoh`, solo en `buoh-operaciones`.

  Nunca en Git ni en el chat.
- **El agente** las recibe por los *Secrets* de Kiro Web (*Settings > Sandbox*):
  - con nombres propios (`BUOH_AGENTE_*` y `BUOH_PRUEBA_*`), nunca los `BUOH_*` que lee el worker, para que ninguna prueba ni comando local use producción por error. El agente solo los pasa al comando que los necesita, y nunca los muestra;
  - por defecto, solo de lectura: `buoh_agente`, con la contraseña que el propietario copia de `buoh-operaciones`, y el token `agente`;
  - un permiso de escritura, como el token `prueba`, solo para una tarea concreta, con el visto bueno del propietario ese día, y se retira al terminarla, borrando el token en Cloudflare y el secreto en Kiro. Los secretos están en todas las sesiones de Kiro del propietario mientras existen, y por eso los permanentes son de solo lectura.
- **Render.** El agente no recibe una clave de la API de Render, porque en Hobby da acceso a toda la cuenta. Lo que solo mide Render lo copia el propietario de su panel (§13).
- **Rotación**, con los pasos del runbook:
  - un token de R2: se crea otro, se cambia la variable, el servicio se vuelve a desplegar y se borra el viejo;
  - la contraseña de un rol: Render genera otra y `buoh-operaciones` la aplica en su ejecución siguiente;
  - la credencial de `buoh`: con la rotación de credenciales de Render Postgres, que el PR de despliegue comprueba antes de documentarla.

### 13. Evidencia de producción

- **Canal** (plan §4, punto 10):
  - el agente lee producción con `buoh_agente`: `data:health`, los informes de §11 y los eventos de conexión y de cierre de los logs;
  - el propietario copia, con los pasos del runbook, lo que solo miden Render y Cloudflare: la memoria máxima de `buoh-ingesta` y `buoh-operaciones` y el tráfico de salida de cada servicio en *Metrics*, y las operaciones de clase A y B y el espacio de R2. Basta una captura de pantalla sin datos de la cuenta.
- **Documento.** `docs/operacion/evidencia-produccion-f2-2.md` reúne los 7 días: las horas de captura, los episodios en que la salud no fue `healthy`, con su causa (un despliegue, un corte semanal, una desconexión de Deriv o el almacenamiento), la memoria máxima, que no puede pasar de 256 MB, el espacio de PostgreSQL y de R2 frente a los umbrales de §7, y las operaciones de R2 y el tráfico de salida frente al presupuesto (§14). Sin secretos, IDs de cuenta ni precios.
- **Tráfico de salida.** Render cuenta todo lo que sale de sus servicios, también las peticiones a R2 (ADR-0016, «Consecuencias»). La estimación, sin medir, es de unos 1,1 GB al mes de cuerpos de `PutObject` y unos 6,1 millones de peticiones de alrededor de 1 KB: unos 7 GB al mes. Pasa de los 5 GB incluidos, que comparte con el sitio, y costaría unos 0,30 USD más. La evidencia lo mide. Si lo medido no cabe en el presupuesto, se presenta al propietario antes de seguir (plan §11).

### 14. Costo

| Servicio | Al mes (aproximado) |
|---|---|
| Render Postgres Basic-256mb, 1 GB | 6,30 USD |
| `buoh-ingesta`, worker Starter | 7 USD |
| `buoh-operaciones`, cron job | 1 USD, el mínimo |
| Cloudflare R2: las operaciones de clase A que pasan de lo gratuito | unos 1,60 USD |
| Tráfico de salida por encima de 5 GB | unos 0,30 USD (estimación) |

En total, unos 16 USD al mes: unos 23 con la API (F2.3) y unos 30 con el motor (F2.9). Cada despliegue del Blueprint de datos compila dos servicios con los minutos de compilación del workspace, que caben en los 500 incluidos (estimación).

### 15. Pruebas

- **Sin red, reloj real ni azar:**
  - las reglas de configuración por entorno (§4 y §9);
  - las opciones de TLS del pool en cada modo;
  - las tres esperas del arranque en `production`, sin escribir nada;
  - el log activo y la preparación;
  - el corte: la hora, el log limpio, el log siguiente preparado, una continuidad pendiente que bloquea y una `event_gap_unresolved` que no;
  - qué logs vencen, sin el activo ni el preparado;
  - el reparto de la verificación por partes y el orden de §11.
- **Integración** (PostgreSQL y almacenamiento S3-compatible locales):
  - `F2-ROLE-001`: con `buoh_ingesta`, `UPDATE`, `DELETE`, `TRUNCATE` y el DDL fallan con `42501`, e `ingest` funciona; con `buoh_salud`, `data:health` funciona y un `INSERT` falla con `42501`;
  - `db:migrate` con las credenciales de `buoh` y sus errores saneados;
  - `require` contra un servidor sin TLS falla en lugar de conectar sin cifrar;
  - dos logs en un mismo bucket: borrar uno no toca el otro;
  - la retención en un entorno desechable: tres logs, vence el primero, se borran su esquema y su prefijo, y las filas de los otros no cambian;
  - el corte de un log al siguiente, con el socket falso.
- **Blueprint:** la prueba de `render-datos.yaml` (§2 y §3).
- **En vivo, fuera de CI:** las comprobaciones de R2 (§10) y la evidencia de 7 días (§13).
- Los vectores v1, los datasets y el replay no cambian.

### 16. Secuencia de entrega

Cada PR es pequeño, con su revisión semántica:

1. Esta ADR, el estado del proyecto y el plan.
2. Roles y cifrado: `BUOH_POSTGRES_SSLMODE`, los roles y sus privilegios, `db:migrate` con sus errores saneados y las pruebas de `F2-ROLE-001`.
3. Logs sucesivos en el worker: el prefijo de los objetos, el log activo y `data:health` en `production`.
4. `ingest` en `production` (§4), con las esperas del arranque, sus pruebas, el comentario de `checkIngestConfig` y el runbook.
5. `buoh-operaciones` (§11), con su tabla de informes en una migración nueva, sin la retención.
6. El PR de despliegue: `render-datos.yaml` y su prueba, el script de las comprobaciones de R2, la regla del mapa de impacto, la guía de [despliegue en Render](../../operacion/despliegue-en-render.md) y la sección de producción del runbook (preparar, desplegar, parar, recuperar, rotar credenciales y borrar). Fusionarlo no crea nada.
7. El resultado de las comprobaciones de R2: el propietario crea `buoh-prueba` y el token `prueba` con los pasos del PR 6, y el agente las hace. Después, el propietario crea los recursos de producción y la captura empieza. Desde ahí puede empezar F2.3 (plan §9).
8. El corte semanal y el borrado (§6 y §7), con la prueba en un entorno desechable. Llega a producción antes de que el log 1 cumpla 14 días.
9. La evidencia de 7 días (§13) y el estado del proyecto: F2.2 queda hecho.

### Relación con ADR anteriores

- **ADR-0016 §4:** la retención y el entorno, en §4, §6 y §7; los roles, en §8; R2, en §10; `data:health`, en §11; las credenciales, en §12; y la región, en §1. §2 sube en unos 1 USD (§14).
- **ADR-0015:** §7 queda sustituida en `production` (§4) y sigue en `development` y `test`. Lo que §10 dejaba para el plan de alojamiento, la historia de las paradas programadas, queda decidido en §5.
- **ADR-0017:** la verificación periódica de §4 es el paso 4 de §11. El borrado del prefijo de un log terminado ocupa el lugar del borrado de su bucket. El corte de §7 está en §6, con la precisión sobre `event_gap_unresolved`.
- **ADR-0005 §3:** en `production`, las claves van bajo `logs/<n>/`.
- **ADR-0006:** la región es `virginia`.
- **ADR-0004 §13:** la retención de desarrollo no cambia, y la redistribución de los datos de Deriv sigue deshabilitada.
- **ADR-0013:** `render.yaml` sigue siendo solo el sitio.

## Consecuencias

- **Términos de Deriv.** buoh guarda en producción 30 días de datos de Deriv, aunque sus términos (2.1 y 2.3) no lo permiten, por decisión del propietario. Si Deriv bloquea o termina el acceso (1.3 y 8.1), la captura se detiene y la salud lo muestra. buoh no intenta sortear un bloqueo. Sus términos piden borrarlo todo al terminar la relación (2.4).
- **Base abierta.** La base acepta conexiones de cualquier IP, y su seguridad depende del cifrado, de las contraseñas generadas y de los roles mínimos.
- **Huecos visibles.** La captura tiene huecos cortos en cada despliegue (segundos, o unos minutos si trae una migración) y en cada corte semanal (segundos).
- **Espacio.** Producción guarda entre 30 y unos 37 días: unos 0,55 GB de PostgreSQL y 1,3 GB de R2.
- **Varios logs.** La API (F2.3), los datasets (F2.5) y el motor (F2.9) leen una sucesión de logs con la misma búsqueda del log activo, y un dataset no puede abarcar dos logs.
- **Costo.** El sistema de datos pasa a costar unos 16 USD al mes.
- **Registros.** Los informes de la salud y de la verificación se borran con su log. Los logs de Render solo duran 7 días.
- **Evidencia.** El agente lee producción directamente, solo con permisos de lectura, y el propietario copia los números que solo dan los paneles.

## Alternativas descartadas

| Alternativa | Motivo |
|---|---|
| Guardar como mucho 24 horas y pedir permiso a Deriv | Era la recomendación de la dirección técnica. El propietario eligió 30 días. |
| No desplegar hasta que Deriv responda | La Fase 2 se pararía sin fecha. |
| Añadir el sistema de datos a `render.yaml` | Auto Sync crearía y cobraría los servicios al fusionar, sin pedir sus secretos. |
| Migrar con el `preDeployCommand` del worker | El worker, que recibe los datos de internet, tendría las credenciales del rol dueño. |
| `data:health` y el mantenimiento dentro del worker | `ingest` y `data:health` juntos rozarían los 256 MB del criterio de memoria, y el worker tendría las credenciales del rol dueño. |
| Dos cron jobs, uno de salud y otro de mantenimiento | Cuestan otro 1 USD al mes y aportan poca seguridad: corren el mismo código, con las mismas dependencias. |
| Un bucket por log | Crearlos exigiría un token de administración de toda la cuenta, o que el propietario creara uno cada semana. |
| Una tabla de registro de los logs | Con siete logs como mucho, sus nombres numerados bastan para encontrar el activo. |
| Logs diarios o mensuales | Los diarios dejan unos 31 esquemas vivos y un corte al día. Los mensuales guardarían hasta unos 60 días, unos 0,85 GB del disco de 1 GB. |
| Un disco persistente para que no se solapen dos instancias | Desactiva el despliegue sin corte, y el bloqueo ya garantiza un solo escritor. |
| Recuperar la historia de cada parada programada | Un cierre pedido tendría que dejar un hueco pendiente, una regla que ADR-0015 descartó. |
| Cerrar la base a internet | Era la recomendación de la dirección técnica. El propietario eligió abrirla. |
| Una clave de la API de Render para el agente | En Hobby da acceso a toda la cuenta. |
| Almacenamiento autoescalado de la base | Subiría el presupuesto sin el visto bueno del propietario. |

## Referencias verificadas

- [Deriv: términos para usuarios de la API](https://deriv.com/terms-and-conditions/api-users) y [términos generales para socios](https://deriv.com/terms-and-conditions/business-partners-general-terms)
- [Render: despliegues, comando previo y despliegue sin corte](https://render.com/docs/deploys) y [cómo funciona el despliegue sin corte](https://render.com/articles/how-render-handles-zero-downtime-deploys)
- [Render: cron jobs](https://render.com/docs/cronjobs)
- [Render: crear y conectar Render Postgres](https://render.com/docs/databases) y [credenciales de Render Postgres](https://render.com/docs/postgresql-credentials)
- [Render: referencia del Blueprint](https://render.com/docs/blueprint-spec)
- [Render: documentación en texto](https://render.com/llms-full.txt), con Auto Sync, *Blueprint Path*, health checks, retención de logs, *Metrics* y la suspensión de una base llena
- [Cloudflare R2: ubicación de los datos](https://developers.cloudflare.com/r2/reference/data-location/), [tokens](https://developers.cloudflare.com/r2/api/tokens/), [API S3](https://developers.cloudflare.com/r2/api/s3/api/) y [consistencia](https://developers.cloudflare.com/r2/reference/consistency/)
- [Kiro Web: variables de entorno y secretos del sandbox](https://kiro.dev/docs/web/sandbox/environment-variables.md)
- Código leído el 2026-10-31, en `apps/market-data-worker`: `src/config.ts`, `src/ingest-args.ts`, `src/ingest.ts`, `src/runtime.ts`, `src/node-flags.ts`, `src/object-keys.ts`, `src/postgres/metadata-store.ts`, `src/postgres/migrate.ts`, `src/s3/object-store.ts`, `src/cli/ingest.ts`, `src/cli/migrate.ts` y `migrations/0001` a `0005`; y `scripts/data-health.mjs` y `scripts/render-blueprint.test.mjs`.

El contenido de fuentes externas fue reformulado para cumplir restricciones de licencia.
