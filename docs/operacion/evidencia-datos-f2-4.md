# Evidencia de F2.4 en producción

Lo que F2.4 lleva a producción, con lo que vio el agente con su acceso de solo lectura («Acceso del agente», en el [runbook de ingesta](runbook-ingesta-de-datos.md)) y desde fuera, y lo que el propietario copió de Render y de su navegador. F2.4 pide medir en producción las lecturas de R2 y el tráfico de salida (`F2-API-001`; [ADR-0019](../arquitectura/adr/0019-api-cuentas-y-auditoria.md) §8 y §15); esa medición llega después, con el punto 7 de F2.4 en `PROJECT_STATUS.md`. Este documento empieza antes, con el primer despliegue de F2.4 que lee el sistema de datos.

Este documento no trae secretos, ni el nombre de usuario del propietario, que no se publica (ADR-0019 §1).

## La salud de los datos (PR #91)

El PR #91 trajo el rol `buoh_api_lectura` y `GET /api/v1/datos/salud`, que solo lee PostgreSQL (ADR-0019 §7 y §8; [runbook de la API](runbook-api.md), «La credencial de lectura de los datos»). Las horas son UTC del 2026-11-04. Salen de las comprobaciones de CI en GitHub, de las lecturas de producción del agente, de sus `curl` desde fuera y de las capturas y los mensajes del propietario, que usa la hora UTC−3, como dice cada fila.

| Hora | Qué pasó |
|---|---|
| 20:00:00 | El propietario fusiona el PR #91 (`ac6ed2d`, GitHub). El árbol es el de su último commit, `e8a7a17`, el que probó CI en el PR (`git diff --quiet e8a7a17 ac6ed2d` sale con 0): la rama salió de `main`, y `main` no cambió. |
| 20:00 | Llega al propietario un email de Render, «Blueprint sync failed for buoh-datos», sin el motivo (su captura, a las 17:00 de su hora). |
| 20:02:32 y 20:06:59 | CI sobre `ac6ed2d`: `test:integration` y `verify:pr` terminan bien. |
| antes de 20:09:34 | `buoh-api` ya sirve el código nuevo. Con `curl` desde fuera, a las 20:09:34 y a las 20:10:26, `GET /api/v1/datos/salud` sin sesión responde `401 unauthenticated`, y una ruta que no existe, `404 not_found`: antes del PR, esa ruta no existía. `GET /api/salud` responde `200`. |
| 20:09:58 a 20:16:27 | La captura sigue con la misma sesión del bloqueo de la fuente, `connected`, y la salud de cada ejecución de `buoh-operaciones` es `healthy`. No existe `buoh_api_lectura` (lecturas del agente). |
| 20:19:12 | CI: `desktop:windows` termina bien. Era la última comprobación: el PR toca `pnpm-lock.yaml` y `packages/contracts`, que la activan. |
| 20:22:07.700 a 20:22:11.093 | `buoh-ingesta` se despliega: el último latido de la sesión anterior del bloqueo, que cerró su conexión, y el primero de la nueva. Son unos 3,4 s entre los dos latidos. La salud de las 20:25 es `healthy`. |
| antes de 20:30 | El propietario mira las variables y lo dice en un mensaje, junto con la captura del email, que hizo a las 17:30 de su hora. `buoh-api` tiene `BUOH_API_LECTURA_POSTGRES_PASSWORD` con un valor. `buoh-operaciones` no la tiene: solo tiene `BUOH_API_POSTGRES_PASSWORD`, con otro valor, que es la contraseña de `buoh_api`. |
| después de 20:38 | Con los pasos que le da el agente a las 20:38, el propietario pulsa **Manual Sync** en el Blueprint y aprueba el cambio. No anotó la hora. La variable llegó a `buoh-operaciones` entre su ejecución de las 20:45, que no creó el rol, y la de las 20:50, que sí. |
| 20:50:46.882 | `buoh-operaciones` crea `buoh_api_lectura` y le pone la contraseña: su informe `roles_and_logs` termina `completed`, con `passwords_set: ["buoh_api_lectura"]` y sin fallos. La salud de esa ejecución, a las 20:51:05, es `healthy`. |
| 20:50:47 | El agente comprueba el rol (abajo). |
| 21:08 | El primer intento del propietario de abrir `GET /api/v1/datos/salud` responde `401 unauthenticated` (su captura, a las 18:08 de su hora), y un segundo intento, lo mismo (su mensaje). |
| hacia las 21:28 | Después de entrar, el propietario abre de nuevo `GET /api/v1/datos/salud`. La respuesta trae el log 2 y su última observación, `completed`, de las 21:26:06.925: `healthy`, `connected`, `open_condition_types: []` y `alerts: []` (su captura, a las 18:28 de su hora). Es el último informe de la salud que tenía el log 2 en ese momento; el siguiente es de las 21:30:58 (lecturas del agente). |

**El rol** a las 20:50:47, en los catálogos:

- inicia sesión y hereda; no es superusuario ni tiene `CREATEROLE`, `CREATEDB`, `REPLICATION` ni `BYPASSRLS`; sin límite de conexiones propio, sin vencimiento y sin ajustes, como decidió ADR-0019 §7;
- es miembro solo de `buoh_lectura`, con `INHERIT` y `SET` y sin `ADMIN OPTION`, una pertenencia que dio `buoh_dueno`, y lo administra `buoh_dueno`;
- en el log activo, tiene el uso del esquema y `SELECT` en `operations_reports`, y no puede crear en el esquema ni insertar, cambiar ni borrar en esa tabla. No tiene el uso de `buoh_api` ni puede crear en `public` ni en la base.

**Los dos primeros intentos del propietario** respondieron `401 unauthenticated` porque su navegador no tenía sesión: no había entrado ese día. A las 21:22:16, las estadísticas de PostgreSQL (`pg_stat_all_tables`) decían que en `buoh_api.sessions` se habían insertado 2 filas, las de los dos inicios de sesión de la [evidencia de F2.3](evidencia-api-f2-3.md). Después de entrar, a las 21:31:05, eran 3, con un paso TOTP usado más y una entrada de auditoría más. Son cuentas: el rol del agente ve las estadísticas de las tablas de `buoh_api`, como cualquier rol, y no lee ninguna de sus filas (precisión de ADR-0019 §7). Además, abrir esa dirección desde un enlace de otra página, como el chat del agente, no envía la sesión, porque la cookie es `SameSite=Strict` (ADR-0019 §2). Por eso el runbook de la API pide entrar primero y escribir la dirección.

## Lo que se aprendió

- **La variable de `buoh-operaciones` que copia una variable nueva de `buoh-api` no se creó en la sincronización automática.** El PR añadía `BUOH_API_LECTURA_POSTGRES_PASSWORD` a `buoh-api`, con `generateValue`, y la misma a `buoh-operaciones`, con `fromService` desde `buoh-api`. Después de la sincronización automática, que falló, `buoh-api` tenía la suya y `buoh-operaciones` no. Por qué falló no se sabe: el email no lo dice, y el error de la página del Blueprint no se copió. Una hipótesis es que buscó la variable de `buoh-api` antes de que existiera, porque cada referencia toma el valor que tiene su origen en cada sincronización ([Render: Blueprint YAML Reference](https://render.com/docs/blueprint-spec)); la documentación de Render no describe este caso. El 2026-11-03, un cambio de la misma forma, `BUOH_API_POSTGRES_PASSWORD`, quedó pendiente de aprobar sin que la sincronización fallara ([evidencia de F2.3](evidencia-api-f2-3.md)). Las dos veces la creó una **Manual Sync** con **Approve**.
- **Esta vez, la sincronización desplegó `buoh-api` sin esperar a CI.** `buoh-api` sirvió el código nuevo antes de que terminara `desktop:windows`, y `buoh-ingesta`, con el mismo `autoDeployTrigger: checksPass`, lo esperó. La diferencia es que el PR cambiaba la sección de `buoh-api` en `render-datos.yaml` y no la de `buoh-ingesta`. Render documenta que un push que cambia el archivo del Blueprint despliega los recursos que cambia ([Render: Blueprints](https://render.com/docs/infrastructure-as-code)), sin decir si espera a los checks de CI: eso es lo que se vio ese día, deducido de las horas. El agente no ve los eventos de Render, así que la hora exacta de ese despliegue no está. Lo que se desplegó era el mismo árbol que CI ya había probado en el PR, y después CI también pasó en `main`. La [guía de despliegue](despliegue-en-render.md) («Cuándo despliegan») dice cómo se evita desplegar un árbol sin probar.
- **La memoria de `buoh-api`.** El código nuevo, que carga la ruta `lectura` con unos 8 MiB más al arrancar (ADR-0019 §8), corre en `buoh-api` desde el 2026-11-04 entre las 20:00 y las 20:09:34. El PR 7c de F2.3 separa los días de antes y de después (`PROJECT_STATUS.md`, F2.4).

Lo que este documento cita de la documentación de Render la resume con otras palabras; lo demás es lo que se vio el 2026-11-04.
