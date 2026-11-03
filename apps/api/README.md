# @buoh/api

La API de buoh (Fastify), que se construye en F2.3 con la secuencia de [ADR-0019](../../docs/arquitectura/adr/0019-api-cuentas-y-auditoria.md) §14. Desde el PR 2 tiene su esqueleto: valida cada entrada y cada salida con los contratos de [`packages/contracts`](../../packages/contracts/), responde los errores con `ApiError`, pone las cabeceras de seguridad en todas las respuestas, escribe una línea JSON por petición y tiene la ruta de salud `GET /api/salud`. Desde el PR 3 tiene su esquema de PostgreSQL, `buoh_api`, con la tabla de la auditoría (`AuditEvent`), y su `db:migrate`. Desde el PR 4a tiene las cuentas, las credenciales y los enlaces de alta y de restablecimiento, con la orden `cuenta`. Desde el PR 4b tiene el inicio y el cierre de sesión, las sesiones de servidor con su cookie y su token CSRF, los límites de intentos, `cuenta cerrar-sesiones`, el cierre de las sesiones al restablecer y la sección de auditoría (`GET /api/v1/auditoria`). Desde el PR 5b sirve la web exportada (`apps/web/out-api`) en el mismo origen que `/api/`, con las cabeceras de seguridad y la política de contenido de cada archivo, y calcula el hash de los scripts en línea de cada HTML (§9). No está desplegada.

## Comandos

Desde la raíz del repositorio, con `pnpm`:

| Comando | Qué hace |
|---|---|
| `pnpm --filter @buoh/api run build` | compila `src/` en `dist/` |
| `pnpm --filter @buoh/api run test` | las pruebas, sin red ni puertos: `inject` de Fastify y, para los mensajes HTTP que `inject` no puede enviar, una conexión en memoria |
| `pnpm --filter @buoh/api run test:integration` | las pruebas contra el PostgreSQL local (`infra/compose.yaml`); `pnpm run test:integration`, desde la raíz, compila antes y corre también las del worker |
| `pnpm --filter @buoh/api run db:migrate` | aplica las migraciones de `migrations/` al esquema `buoh_api` (ver abajo); usa `dist/`, así que va después de `build` |
| `pnpm --filter @buoh/api run cuenta -- alta <usuario>` | crea el enlace de alta de una cuenta (ver «La orden `cuenta`»); `… restablecer <usuario>`, el de restablecimiento; `… cerrar-sesiones <usuario>`, cierra sus sesiones; usa `dist/` |
| `pnpm run openapi:generate` | escribe `generated/openapi.json` desde `src/routes.ts` y los contratos |
| `pnpm run openapi:check` | comprueba que `generated/openapi.json` está al día; corre en `verify:core` |
| `pnpm --filter @buoh/api run start` | arranca la API, con la configuración de abajo; fuera de `production`, en `127.0.0.1`, en el puerto de `PORT` o en el 10000 |

## Configuración

La API y la orden `cuenta` leen las mismas variables, las del servicio (ADR-0019 §7 y §10):

| Variable | Contenido |
|---|---|
| `BUOH_DEPLOYMENT_ENVIRONMENT` | `production`, `development` o `test`; nunca `staging` |
| `BUOH_API_ORIGIN` | el origen público exacto, como `https://buoh-api.onrender.com`: el de los enlaces y el único que puede cambiar algo (CSRF). En `production`, con `https` |
| `BUOH_API_PASSWORD_PEPPER`, `BUOH_API_TOTP_KEY` y `BUOH_API_TOKEN_KEY` | las tres claves del servidor, cada una de 32 bytes en base64, como las genera Render, y distintas entre sí (`openssl rand -base64 32` en local) |
| `BUOH_POSTGRES_HOST`, `_PORT`, `_DB`, `_USER`, `_PASSWORD` y `_SSLMODE` | la conexión, con los valores de los servicios locales si faltan, salvo la contraseña. En `production`, el usuario es `buoh_api` y `BUOH_POSTGRES_SSLMODE` es `require` o `verify-full` |
| `PORT` | el puerto, el 10000 si falta |

Con una variable inválida, la API no arranca: escribe en stderr una línea `api_config_error` con los nombres de las variables, nunca sus valores, y sale con 2. Al arrancar comprueba sus migraciones, y cada 5 s mientras le falten: hasta entonces, `GET /api/salud` y las rutas de los enlaces responden 503 `not_ready`.

## Rutas

| Ruta | Qué hace |
|---|---|
| `GET /api/salud` | 200 si el proceso responde y tiene sus migraciones; si no, 503 `not_ready` |
| `POST /api/v1/enlace/secreto` | con el token de un enlace válido, un secreto TOTP nuevo, en base32 y en su URI `otpauth://`; el anterior del enlace deja de valer |
| `POST /api/v1/enlace` | con el token, la contraseña nueva y un código del último secreto, da de alta la cuenta o restablece su credencial, y gasta el enlace |
| `POST /api/v1/sesion` | inicia sesión con el nombre, la contraseña y un código de 6 cifras; pone la cookie de la sesión y devuelve su token CSRF |
| `GET /api/v1/sesion` | el token CSRF de la sesión actual, que la web recupera al abrir cada página; necesita la cookie |
| `DELETE /api/v1/sesion` | cierra la sesión actual y borra su cookie; necesita la cookie y el `X-CSRF-Token` |
| `DELETE /api/v1/sesiones` | cierra las demás sesiones de la cuenta, menos la actual |
| `GET /api/v1/auditoria` | las entradas de auditoría de la cuenta, de la más nueva a la más vieja; necesita la cookie |

Las rutas que cambian algo (`POST` y `DELETE`) exigen el `Origin` de `BUOH_API_ORIGIN`, `Sec-Fetch-Site: same-origin` si llega y `Content-Type: application/json`, o responden 403 `csrf_rejected`; con una sesión abierta exigen además el `X-CSRF-Token` de esa sesión. Los errores y sus códigos están en el OpenAPI (`generated/openapi.json`) y en los [contratos de dominio](../../docs/arquitectura/contratos-de-dominio.md), «Mensajes de la API».

## La orden `cuenta`

`node dist/cli/cuenta.js alta <usuario>` crea el enlace para dar de alta la cuenta, que se crea sin credencial si no existe; `… restablecer <usuario>`, el enlace para ponerle una contraseña y un código nuevos; `… cerrar-sesiones <usuario>`, cierra todas las sesiones abiertas de la cuenta (ADR-0019 §2 y §3). En producción se ejecuta en la consola de `buoh-api`, en Render, con el entorno del servicio. El usuario tiene de 3 a 32 caracteres: minúsculas sin acentos, cifras, `-` y `_`.

- Escribe en stdout una línea con lo que es el enlace y su vencimiento, y en la siguiente su dirección, `<BUOH_API_ORIGIN>/enlace/#<token>`. Nadie más ve ese token: la base solo guarda su HMAC.
- El enlace vale 15 minutos y un solo uso. Uno nuevo de la cuenta anula el anterior.
- En `production`, `alta` no crea ningún enlace si ya hay una cuenta dada de alta.

| Salida | Significado |
|---:|---|
| 0 | el enlace, o cuántas sesiones cerró `cerrar-sesiones`, en stdout |
| 1 | no se pudo: el motivo y su código en stderr, como `account_already_enrolled`, `account_not_found`, `not_ready` o el SQLSTATE de PostgreSQL, nunca su mensaje |
| 2 | un uso o una configuración que no valen, sin abrir la base |

Son los códigos de `node dist/cli/cuenta.js`. Con `pnpm --filter @buoh/api run cuenta -- …`, pnpm devuelve 1 también en lugar del 2; el motivo sigue en stderr.

## `db:migrate`

Aplica las migraciones pendientes de `migrations/` en orden, todas en una transacción, con un bloqueo para que dos procesos no migren a la vez, y crea el esquema `buoh_api` si no existe (ADR-0019 §7). Lee `BUOH_DEPLOYMENT_ENVIRONMENT` y `BUOH_POSTGRES_HOST`, `_PORT`, `_DB`, `_USER`, `_PASSWORD` y `_SSLMODE`, con los valores de los servicios locales si faltan, salvo la contraseña. En `production`, `BUOH_POSTGRES_SSLMODE` es `require` o `verify-full`, y `BUOH_POSTGRES_OWNER_ROLE` nombra el rol del que son el esquema y las tablas (`buoh_dueno`). Allí no lo corre nadie a mano: lo corre `buoh-operaciones`, en un proceso con solo la credencial dueña (runbook de ingesta, «Operaciones (`buoh-operaciones`)»).

Escribe una sola línea JSON en stdout, con la forma de la del `db:migrate` del worker:

| Salida | Línea |
|---:|---|
| 0 | `{"applied":[…],"current":[…],"status":"migrated"}`: las aplicadas en esta ejecución y todas las de la API |
| 1 | `{"code":"MIGRATION_INVALID","migration":…,"reason":…,"status":"failed"}` si las migraciones no cuadran (`migration_changed`, `migration_unknown` o `migration_out_of_sequence`), o `{"code":"MIGRATION_FAILED",…,"reason":…,"status":"failed"}` si PostgreSQL no responde o rechaza el SQL, con el motivo saneado (el SQLSTATE, el código del error o el nombre de su clase, como `Error` con un servidor sin TLS) y, si rechazó una migración, `migration` |
| 2 | `{"code":"ConfigError","message":"Configuración inválida o ausente: …","status":"failed"}`, con los nombres de las variables rechazadas |

Nunca escribe el mensaje de un error, que puede llevar el usuario, la base o el servidor.

## Dónde está cada cosa

- `src/routes.ts`: la tabla de rutas (`API_ROUTE_SPECS`), que registra Fastify y de la que sale el OpenAPI, y sus manejadores (`apiRoutes`). Una ruta no existe sin el esquema de su consulta, de su cuerpo si es `POST` y de cada respuesta.
- `src/app.ts`: la aplicación: compiladores de Zod, errores, CSRF (`src/csrf.ts`), cabeceras y registro, y la ruta comodín que sirve la web.
- `src/headers.ts` y `src/web.ts`: las cabeceras de seguridad por tipo de respuesta, y la lectura de `apps/web/out-api` con la política de contenido y los hashes de cada HTML (§9).
- `src/log.ts`: los campos del registro, una lista cerrada (ADR-0019 §11).
- `src/config.ts`: la configuración; `src/readiness.ts` y `src/postgres/readiness.ts`, la espera de las migraciones.
- `src/auth/`: la contraseña (`password-policy.ts`, `common-passwords.ts`, `password-hash.ts`), el TOTP (`totp.ts`, `base32.ts`), el secreto guardado (`seal.ts`), los tokens de los enlaces (`tokens.ts`) y las sesiones y su token CSRF (`session-token.ts`), todo con `node:crypto`.
- `src/accounts/`: las cuentas y los enlaces (`links.ts`, `store.ts`), las sesiones y el inicio de sesión (`sessions.ts`), los límites de intentos en memoria (`limits.ts`) y el agrupado de los fallos (`login-failures.ts`); `src/audit.ts` guarda cada entrada de auditoría; `src/account-command.ts` y `src/cli/cuenta.ts`, la orden `cuenta`.
- `src/cli/serve.ts`: el arranque y la parada con `SIGTERM`.
- `data/`: la lista de bloqueo de las contraseñas, con su origen y su licencia (`data/README.md`); `scripts/build-common-passwords.ts` la vuelve a construir.
- `migrations/`: las migraciones del esquema `buoh_api`, que solo añaden. `0001_auditoria.sql` crea `audit_events`; `0002_cuentas.sql`, las tablas de las cuentas; y `0003_sesiones.sql`, las de las sesiones, todas append-only.
- `src/postgres/`: la conexión (`config.ts`, `pool.ts`, `errors.ts`, `transaction.ts`) y las migraciones (`migrate.ts`); `src/migrate-command.ts` y `src/cli/migrate.ts`, el comando `db:migrate`.
