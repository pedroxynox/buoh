# @buoh/api

La API de buoh (Fastify), que se construye en F2.3 con la secuencia de [ADR-0019](../../docs/arquitectura/adr/0019-api-cuentas-y-auditoria.md) §14. Desde el PR 2 tiene su esqueleto: valida cada entrada y cada salida con los contratos de [`packages/contracts`](../../packages/contracts/), responde los errores con `ApiError`, pone las cabeceras de seguridad en todas las respuestas, escribe una línea JSON por petición y tiene la ruta de salud `GET /api/salud`. Desde el PR 3 tiene su esquema de PostgreSQL, `buoh_api`, con la tabla de la auditoría (`AuditEvent`), y su `db:migrate`. Todavía no tiene cuentas ni sesiones, y no está desplegada.

## Comandos

Desde la raíz del repositorio, con `pnpm`:

| Comando | Qué hace |
|---|---|
| `pnpm --filter @buoh/api run build` | compila `src/` en `dist/` |
| `pnpm --filter @buoh/api run test` | las pruebas, sin red ni puertos: `inject` de Fastify y, para los mensajes HTTP que `inject` no puede enviar, una conexión en memoria |
| `pnpm --filter @buoh/api run test:integration` | las pruebas contra el PostgreSQL local (`infra/compose.yaml`); `pnpm run test:integration`, desde la raíz, compila antes y corre también las del worker |
| `pnpm --filter @buoh/api run db:migrate` | aplica las migraciones de `migrations/` al esquema `buoh_api` (ver abajo); usa `dist/`, así que va después de `build` |
| `pnpm run openapi:generate` | escribe `generated/openapi.json` desde `src/routes.ts` y los contratos |
| `pnpm run openapi:check` | comprueba que `generated/openapi.json` está al día; corre en `verify:core` |
| `BUOH_DEPLOYMENT_ENVIRONMENT=development pnpm --filter @buoh/api run start` | arranca la API en `127.0.0.1`, en el puerto de `PORT` o en el 10000 |

`BUOH_DEPLOYMENT_ENVIRONMENT` es obligatoria y no admite `staging`. Con una variable inválida, la API no arranca: escribe en stderr una línea `api_config_error` con los nombres de las variables, nunca sus valores, y sale con 2.

## `db:migrate`

Aplica las migraciones pendientes de `migrations/` en orden, todas en una transacción, con un bloqueo para que dos procesos no migren a la vez, y crea el esquema `buoh_api` si no existe (ADR-0019 §7). Lee `BUOH_DEPLOYMENT_ENVIRONMENT` y `BUOH_POSTGRES_HOST`, `_PORT`, `_DB`, `_USER`, `_PASSWORD` y `_SSLMODE`, con los valores de los servicios locales si faltan, salvo la contraseña. En `production`, `BUOH_POSTGRES_SSLMODE` es `require` o `verify-full`, y `BUOH_POSTGRES_OWNER_ROLE` nombra el rol del que son el esquema y las tablas (`buoh_dueno`). Allí no lo corre nadie a mano: lo corre `buoh-operaciones`, en un proceso con solo la credencial dueña (runbook de ingesta, «Operaciones (`buoh-operaciones`)»).

Escribe una sola línea JSON en stdout, con la forma de la del `db:migrate` del worker:

| Salida | Línea |
|---:|---|
| 0 | `{"applied":[…],"current":[…],"status":"migrated"}`: las aplicadas en esta ejecución y todas las de la API |
| 1 | `{"code":"MIGRATION_INVALID","migration":…,"reason":…,"status":"failed"}` si las migraciones no cuadran (`migration_changed`, `migration_unknown` o `migration_out_of_sequence`), o `{"code":"MIGRATION_FAILED",…,"reason":…,"status":"failed"}` si PostgreSQL no responde o rechaza el SQL, con el SQLSTATE o el código del error y, si rechazó una migración, `migration` |
| 2 | `{"code":"ConfigError","message":"Configuración inválida o ausente: …","status":"failed"}`, con los nombres de las variables rechazadas |

Nunca escribe el mensaje de un error, que puede llevar el usuario, la base o el servidor.

## Dónde está cada cosa

- `src/routes.ts`: la tabla de rutas, que registra Fastify y de la que sale el OpenAPI. Una ruta no existe sin el esquema de su consulta y de cada respuesta.
- `src/app.ts`: la aplicación: compiladores de Zod, errores, cabeceras y registro.
- `src/log.ts`: los campos del registro, una lista cerrada (ADR-0019 §11).
- `src/cli/serve.ts`: el arranque y la parada con `SIGTERM`.
- `migrations/`: las migraciones del esquema `buoh_api`, que solo añaden. `0001_auditoria.sql` crea `audit_events`, append-only.
- `src/postgres/`: la conexión (`config.ts`, `pool.ts`) y las migraciones (`migrate.ts`); `src/migrate-command.ts` y `src/cli/migrate.ts`, el comando `db:migrate`.
