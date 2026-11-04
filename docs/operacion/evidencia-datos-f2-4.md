# Evidencia de F2.4 en producción

Lo que F2.4 lleva a producción, con lo que vio el agente con su acceso de solo lectura («Acceso del agente», en el [runbook de ingesta](runbook-ingesta-de-datos.md)) y desde fuera, y lo que el propietario copió de Render y de su navegador. F2.4 pide medir en producción las lecturas de R2 y el tráfico de salida (`F2-API-001`; [ADR-0019](../arquitectura/adr/0019-api-cuentas-y-auditoria.md) §8 y §15); esa medición llega con el PR que lee R2, y este documento empieza antes, con el primer despliegue de F2.4 que lee el sistema de datos.

Este documento no trae secretos, ni el nombre de usuario del propietario, que no se publica (ADR-0019 §1).

## La salud de los datos (PR #91)

El PR #91 trajo el rol `buoh_api_lectura` y `GET /api/v1/datos/salud`, que solo lee PostgreSQL (ADR-0019 §7 y §8; [runbook de la API](runbook-api.md), «La credencial de lectura de los datos»). Las horas son UTC del 2026-11-04.

| Hora | Qué pasó |
|---|---|
| 20:00:00 | El propietario fusiona el PR #91 (`ac6ed2d`). El árbol es el de su último commit, `e8a7a17`, el que probó CI en el PR, porque la rama salió de `main` y `main` no cambió. |
| 20:00 | Llega al propietario un email de Render, «Blueprint sync failed for buoh-datos», sin el motivo. |
| 20:02:32 y 20:06:59 | CI sobre `ac6ed2d`: `test:integration` y `verify:pr` terminan bien. |
| antes de 20:09:34 | `buoh-api` ya sirve el código nuevo: desde fuera, `GET /api/v1/datos/salud` sin sesión responde `401 unauthenticated`, y una ruta que no existe, `404 not_found`. `GET /api/salud` responde `200`. |
| 20:09:58 a 20:16:27 | La captura sigue con la misma sesión del bloqueo de la fuente, `connected`, y la salud de cada ejecución de `buoh-operaciones` es `healthy`. No existe `buoh_api_lectura`. |
| 20:19:12 | CI: `desktop:windows` termina bien. Era la última comprobación: el PR toca `pnpm-lock.yaml` y `packages/contracts`, que la activan. |
| 20:22:07.700 a 20:22:11.093 | `buoh-ingesta` se despliega: el último latido de la sesión anterior del bloqueo, que cerró su conexión, y el primero de la nueva. Son unos 3,4 s entre los dos latidos. La salud de las 20:25 es `healthy`. |
| hacia las 20:30 | El propietario mira las variables. `buoh-api` tiene `BUOH_API_LECTURA_POSTGRES_PASSWORD` con un valor. `buoh-operaciones` no la tiene: solo tiene `BUOH_API_POSTGRES_PASSWORD`, con otro valor, que es la contraseña de `buoh_api`. |
| entre 20:38 y 20:50 | El propietario pulsa **Manual Sync** en el Blueprint y aprueba el cambio. No anotó la hora. |
| 20:50:46.882 | `buoh-operaciones` crea `buoh_api_lectura` y le pone la contraseña: su informe `roles_and_logs` termina `completed`, con `passwords_set: ["buoh_api_lectura"]` y sin fallos. La salud de esa ejecución, a las 20:51:05, es `healthy`. |
| 20:50:47 | El agente comprueba el rol (abajo). |
| hacia las 21:28 | El propietario, con su sesión abierta, abre `GET /api/v1/datos/salud` en su navegador. La respuesta trae el log 2 y su última observación, `completed`, de las 21:26:06.925: `healthy`, `connected`, sin condiciones abiertas y con `alerts: []` (captura del propietario). Es el último informe de la salud que tenía el log 2 en ese momento; el siguiente es de las 21:30:58. |

**El rol** a las 20:50:47, en los catálogos:

- inicia sesión y hereda; no es superusuario ni tiene `CREATEROLE`, `CREATEDB`, `REPLICATION` ni `BYPASSRLS`; sin límite de conexiones propio, sin vencimiento y sin ajustes, como decidió ADR-0019 §7;
- es miembro solo de `buoh_lectura`, con `INHERIT` y `SET` y sin `ADMIN OPTION`, una pertenencia que dio `buoh_dueno`, y lo administra `buoh_dueno`;
- en el log activo, tiene el uso del esquema y `SELECT` en `operations_reports`, y no puede crear en el esquema ni insertar, cambiar ni borrar en esa tabla. No tiene el uso de `buoh_api` ni puede crear en `public` ni en la base.

**Los primeros intentos del propietario** respondieron `401 unauthenticated`, porque su navegador no tenía sesión. A las 21:22:16, las estadísticas de PostgreSQL (`pg_stat_all_tables`), que cualquier rol puede leer, decían que en `buoh_api.sessions` se habían insertado 2 filas, las de los dos inicios de sesión de la [evidencia de F2.3](evidencia-api-f2-3.md). Son cuentas, y el agente las leyó sin leer ninguna fila de `buoh_api`, que su rol no puede leer (ADR-0019 §7). Después de entrar, a las 21:31:05, eran 3, con un paso TOTP usado más y una entrada de auditoría más. Además, abrir esa dirección desde un enlace de otra página, como el chat del agente, no envía la sesión: la cookie es `SameSite=Strict` (ADR-0019 §2). Por eso el runbook de la API pide entrar primero y escribir la dirección.

## Lo que se aprendió

- **La sincronización automática no copia en el mismo paso una variable nueva de otro servicio.** El PR añadía `BUOH_API_LECTURA_POSTGRES_PASSWORD` a `buoh-api`, con `generateValue`, y la misma a `buoh-operaciones`, con `fromService` desde `buoh-api`. La sincronización creó la de `buoh-api` y falló con la de `buoh-operaciones`. Ni el email ni lo que vio el propietario dicen por qué, y el error de la página del Blueprint no se copió. Lo más probable es que buscara la variable de `buoh-api` antes de que existiera: Render toma de cada referencia el valor que tiene la variable de origen en cada sincronización ([Render: Blueprint YAML Reference](https://render.com/docs/blueprint-spec)). Una **Manual Sync** después la creó. El 2026-11-03 pasó algo parecido con `BUOH_API_POSTGRES_PASSWORD`, que quedó pendiente de aprobar en lugar de fallar ([evidencia de F2.3](evidencia-api-f2-3.md)).
- **Una sincronización despliega lo que cambia sin esperar a CI.** `buoh-api` sirvió el código nuevo antes de que terminara `desktop:windows`, y `buoh-ingesta`, con el mismo `autoDeployTrigger: checksPass`, lo esperó. La diferencia es que el PR cambiaba la sección de `buoh-api` en `render-datos.yaml` y no la de `buoh-ingesta`: Render despliega los recursos que cambia un push al archivo del Blueprint ([Render: Blueprints](https://render.com/docs/infrastructure-as-code)). El agente no ve los eventos de Render, así que la hora exacta de ese despliegue no está. Lo que se desplegó era el mismo árbol que CI ya había probado en el PR, y después CI también pasó en `main`. La [guía de despliegue](despliegue-en-render.md) («Cuándo despliegan») lo explica.
- **La memoria de `buoh-api`.** El código nuevo, que carga la ruta `lectura` con unos 8 MiB más al arrancar (ADR-0019 §8), corre en `buoh-api` desde el 2026-11-04 entre las 20:00 y las 20:09:34. El PR 7c de F2.3 separa los días de antes y de después (`PROJECT_STATUS.md`, F2.4).

Lo que este documento dice del comportamiento de Render resume con otras palabras su documentación enlazada.
