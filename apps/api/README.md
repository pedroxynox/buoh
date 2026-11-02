# @buoh/api

La API de buoh (Fastify), que se construye en F2.3 con la secuencia de [ADR-0019](../../docs/arquitectura/adr/0019-api-cuentas-y-auditoria.md) §14. Hoy es el esqueleto del PR 2: valida cada entrada y cada salida con los contratos de [`packages/contracts`](../../packages/contracts/), responde los errores con `ApiError`, pone las cabeceras de seguridad en todas las respuestas, escribe una línea JSON por petición y tiene la ruta de salud `GET /api/salud`. Todavía no tiene base de datos, cuentas ni sesiones, y no está desplegada.

## Comandos

Desde la raíz del repositorio, con `pnpm`:

| Comando | Qué hace |
|---|---|
| `pnpm --filter @buoh/api run build` | compila `src/` en `dist/` |
| `pnpm --filter @buoh/api run test` | las pruebas sin red, con `inject` de Fastify, sin abrir puertos |
| `pnpm run openapi:generate` | escribe `generated/openapi.json` desde `src/routes.ts` y los contratos |
| `pnpm run openapi:check` | comprueba que `generated/openapi.json` está al día; corre en `verify:core` |
| `BUOH_DEPLOYMENT_ENVIRONMENT=development pnpm --filter @buoh/api run start` | arranca la API en `127.0.0.1`, en el puerto de `PORT` o en el 10000 |

`BUOH_DEPLOYMENT_ENVIRONMENT` es obligatoria y no admite `staging`. Con una variable inválida, la API no arranca: escribe en stderr una línea `api_config_error` con los nombres de las variables, nunca sus valores, y sale con 2.

## Dónde está cada cosa

- `src/routes.ts`: la tabla de rutas, que registra Fastify y de la que sale el OpenAPI. Una ruta no existe sin el esquema de su consulta y de cada respuesta.
- `src/app.ts`: la aplicación: compiladores de Zod, errores, cabeceras y registro.
- `src/log.ts`: los campos del registro, una lista cerrada (ADR-0019 §11).
- `src/cli/serve.ts`: el arranque y la parada con `SIGTERM`.
