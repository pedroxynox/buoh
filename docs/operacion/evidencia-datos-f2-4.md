# Evidencia de F2.4 en producción

Lo que F2.4 lleva a producción, con lo que vio el agente con su acceso de solo lectura («Acceso del agente», en el [runbook de ingesta](runbook-ingesta-de-datos.md)) y desde fuera, y lo que el propietario copió de Render y de su navegador. F2.4 pide medir en producción las lecturas de R2 y el tráfico de salida (`F2-API-001`; [ADR-0019](../arquitectura/adr/0019-api-cuentas-y-auditoria.md) §8 y §15); esa medición llega después, con el punto 7 de F2.4 en `PROJECT_STATUS.md`. Este documento empieza antes, con el primer despliegue de F2.4 que lee el sistema de datos.

Este documento no trae secretos, ni el nombre de usuario del propietario, que no se publica (ADR-0019 §1).

## La salud de los datos (PR #91)

El PR #91 trajo el rol `buoh_api_lectura` y `GET /api/v1/datos/salud`, que solo lee PostgreSQL (ADR-0019 §7 y §8; [runbook de la API](runbook-api.md), «La credencial de lectura de los datos»). Las horas son UTC del 2026-11-04. Salen de las comprobaciones de CI en GitHub, de las lecturas de producción del agente, de sus `curl` desde fuera y de las capturas y los mensajes del propietario, que usa la hora UTC−3, como dice cada fila.

| Hora | Qué pasó |
|---|---|
| 20:00:00 | El propietario fusiona el PR #91 (`ac6ed2d`, GitHub). El árbol es el de su último commit, `e8a7a17`, el que probó CI en el PR (`git diff --quiet e8a7a17 ac6ed2d` sale con 0): la rama salió de `main`, y `main` no cambió. |
| 20:00 | Llega al propietario un email de Render, «Blueprint sync failed for buoh-datos», sin el motivo. En la captura que mandó el propietario, el email lleva las 17:00 de su hora. |
| 20:02:32 y 20:06:59 | CI sobre `ac6ed2d`: `test:integration` y `verify:pr` terminan bien. |
| antes de 20:09:34 | `buoh-api` ya sirve el código nuevo. Con `curl` desde fuera, a las 20:09:34 y a las 20:10:26, `GET /api/v1/datos/salud` sin sesión responde `401 unauthenticated`, y una ruta que no existe, `404 not_found`: antes del PR, esa ruta no existía. `GET /api/salud` responde `200`. |
| 20:09:58 a 20:16:27 | La captura sigue con la misma sesión del bloqueo de la fuente, `connected`, y la salud de cada ejecución de `buoh-operaciones` es `healthy`. No existe `buoh_api_lectura` (lecturas del agente). |
| 20:19:12 | CI: `desktop:windows` termina bien. Era la última comprobación: el PR toca `pnpm-lock.yaml` y `packages/contracts`, que la activan. |
| 20:22:07.700 a 20:22:11.093 | `buoh-ingesta` se despliega: el último latido de la sesión anterior del bloqueo, que cerró su conexión, y el primero de la nueva. Son unos 3,4 s entre los dos latidos. La salud de las 20:25 es `healthy`. |
| hacia las 20:30 | El propietario mira las variables y lo dice en un mensaje, junto con la captura del email, que hizo a las 17:30 de su hora. `buoh-api` tiene `BUOH_API_LECTURA_POSTGRES_PASSWORD` con un valor. `buoh-operaciones` no la tiene: solo tiene `BUOH_API_POSTGRES_PASSWORD`, con otro valor, que es la contraseña de `buoh_api`. |
| después de 20:38:37 | El agente había pedido el error de la página del Blueprint antes de sincronizar. Llegaron la captura del email, sin el motivo, y lo que se veía en las variables, y con eso, después de su lectura de las 20:38:37, el agente le dio los pasos de la **Manual Sync**: aprobar solo si la lista de cambios traía la variable de `buoh-operaciones`. El propietario pulsa **Manual Sync** en el Blueprint y aprueba el cambio. No anotó la hora. La variable llegó a `buoh-operaciones` entre su ejecución de las 20:45, que no creó el rol, y la de las 20:50, que sí. |
| 20:50:46.882 | `buoh-operaciones` crea `buoh_api_lectura` y le pone la contraseña: su informe `roles_and_logs` termina `completed`, con `passwords_set: ["buoh_api_lectura"]` y sin fallos. La salud de esa ejecución, a las 20:51:05, es `healthy`. |
| 20:50:47 | El agente comprueba el rol (abajo). |
| 21:08 | El primer intento del propietario de abrir `GET /api/v1/datos/salud` responde `401 unauthenticated` (su captura, a las 18:08 de su hora), y un segundo intento, lo mismo (su mensaje). |
| hacia las 21:28 | Después de entrar, el propietario abre de nuevo `GET /api/v1/datos/salud`. La respuesta trae el log 2 y su última observación, `completed`, de las 21:26:06.925: `healthy`, `connected`, `open_condition_types: []` y `alerts: []` (su captura, a las 18:28 de su hora). Es el último informe de la salud que tenía el log 2 en ese momento; el siguiente es de las 21:30:58 (lecturas del agente). |

**El rol** a las 20:50:47, en los catálogos:

- inicia sesión y hereda; no es superusuario ni tiene `CREATEROLE`, `CREATEDB`, `REPLICATION` ni `BYPASSRLS`; sin límite de conexiones propio, sin vencimiento y sin ajustes, como decidió ADR-0019 §7;
- es miembro solo de `buoh_lectura`, con `INHERIT` y `SET` y sin `ADMIN OPTION`, una pertenencia que dio `buoh_dueno`, y lo administra `buoh_dueno`;
- en el log activo, tiene el uso del esquema y `SELECT` en `operations_reports`, y no puede crear en el esquema ni insertar, cambiar ni borrar en esa tabla. No tiene el uso de `buoh_api` ni puede crear en `public` ni en la base.

**Los dos primeros intentos del propietario** respondieron `401 unauthenticated` porque su navegador no tenía ninguna sesión válida: la de la prueba de las dos redes, del 2026-11-04 hacia la 01:18, la cerró él, y la del primer inicio de sesión, del 2026-11-03, había vencido. A las 21:22:16, las estadísticas de PostgreSQL (`pg_stat_all_tables`) decían que en `buoh_api.sessions` se habían insertado 2 filas, las de los dos inicios de sesión de la [evidencia de F2.3](evidencia-api-f2-3.md). Después de entrar, a las 21:31:05, eran 3, con un paso TOTP usado más y una entrada de auditoría más. Son estadísticas: el rol del agente ve la actividad de las tablas de `buoh_api`, como cualquier rol, y no lee ninguna de sus filas (precisión de ADR-0019 §7). Además, abrir esa dirección desde un enlace de otra página, como el chat del agente, no envía la sesión, porque la cookie es `SameSite=Strict` (ADR-0019 §2). Por eso el runbook de la API pide entrar primero y escribir la dirección.

## Lo que se aprendió

- **La variable de `buoh-operaciones` que copia una variable nueva de `buoh-api` no se creó en la sincronización automática.** El PR añadía `BUOH_API_LECTURA_POSTGRES_PASSWORD` a `buoh-api`, con `generateValue`, y la misma a `buoh-operaciones`, con `fromService` desde `buoh-api`. Después de la sincronización automática, que falló, `buoh-api` tenía la suya y `buoh-operaciones` no. Por qué falló no se sabe: el email no lo dice, y el agente dio los pasos de la sincronización sin haber visto el error de la página del Blueprint, que nadie copió. Una hipótesis es que buscó la variable de `buoh-api` antes de que existiera, porque cada referencia toma el valor que tiene su origen en cada sincronización ([Render: Blueprint YAML Reference](https://render.com/docs/blueprint-spec)); la documentación de Render no describe este caso. El 2026-11-03, un cambio de la misma forma, `BUOH_API_POSTGRES_PASSWORD`, quedó pendiente de aprobar sin que la sincronización fallara ([evidencia de F2.3](evidencia-api-f2-3.md)). Las dos veces la creó una **Manual Sync** con **Approve**.
- **Esta vez, la sincronización desplegó `buoh-api` sin esperar a CI.** `buoh-api` sirvió el código nuevo antes de que terminara `desktop:windows`, y `buoh-ingesta`, con el mismo `autoDeployTrigger: checksPass`, lo esperó. La diferencia es que el PR cambiaba la sección de `buoh-api` en `render-datos.yaml` y no la de `buoh-ingesta`. Render documenta que un push que cambia el archivo del Blueprint despliega los recursos que cambia ([Render: Blueprints](https://render.com/docs/infrastructure-as-code)), sin decir si espera a los checks de CI: eso es lo que se vio ese día, deducido de las horas. El agente no ve los eventos de Render, así que la hora exacta de ese despliegue no está. Lo que se desplegó era el mismo árbol que CI ya había probado en el PR, y después CI también pasó en `main`. La [guía de despliegue](despliegue-en-render.md) («Cuándo despliegan») dice cómo se evita desplegar un árbol sin probar.
- **La memoria de `buoh-api`.** El código nuevo, que carga la ruta `lectura` con unos 8 MiB más al arrancar (ADR-0019 §8), corre en `buoh-api` desde el 2026-11-04 entre las 20:00 y las 20:09:34. El PR 7c de F2.3 separa los días de antes y de después (`PROJECT_STATUS.md`, F2.4).

## El Observatorio y la barra superior (PR #94)

El PR #94 trajo el Observatorio y las insignias de modo y salud de la barra superior de `out-api` con la salud real de los datos, la de `GET /api/v1/datos/salud`, y la marca «Datos ficticios» solo en las secciones que siguen con ellos ([concepto de interfaz](../diseno/concepto-de-interfaz.md) §10). Fuera del Markdown, solo cambió `apps/web`, así que, por los `buildFilter` de `render-datos.yaml`, que ignoran el Markdown, solo volvió a desplegar `buoh-api`. No cambió la API, los contratos ni `render-datos.yaml`. Las horas son UTC del 2026-11-05 y salen de GitHub y de las comprobaciones del agente desde fuera, sin sesión ni credenciales.

| Hora | Qué pasó |
|---|---|
| 02:41:01 | El propietario fusiona el PR #94 (`312fb5d`, GitHub). El árbol es el de su último commit, `50319e7`, el que probó CI en el PR (`git diff --quiet 50319e7 312fb5d` sale con 0). |
| 02:43:29, 02:47:55 y 02:52:16 | CI sobre `312fb5d`: `test:integration`, `verify:pr` y `desktop:windows` terminan bien. |
| hacia las 02:43:29 | Un `curl` de `/` y de `/mercados/` trae todavía la web anterior: su barra dice «Modo: Shadow», el modo ficticio. |
| 02:43:53 a 02:54:34 | Con `curl` de `/` cada unos 20 s (33 lecturas hasta las 02:54:54), la página todavía no trae el Observatorio real. |
| 02:54:54 | `buoh-api` ya sirve la web nueva: `/` trae el Observatorio real. Su HTML lleva `Last-Modified: Thu, 05 Nov 2026 02:53:25 GMT`, la hora del archivo que escribió la compilación de Render, así que la instancia nueva arrancó probablemente después de esa hora. Render despliega después de que pasen los checks de CI (`autoDeployTrigger: checksPass`), como describe la [guía de despliegue](despliegue-en-render.md) («Cuándo despliegan») para un commit que no cambia `render-datos.yaml`. El agente no ve los eventos de Render, así que no están ni el arranque de la instancia nueva ni la parada de la anterior. |
| 02:55:20 | Comprobación desde fuera (abajo). |
| 02:55:29 a 02:55:33 | Un navegador sin cabeza (Chrome 157) abre `/` sin sesión (abajo). |

**Desde fuera**, a las 02:55:20:

- la barra superior de `/`, `/auditoria/`, `/mercados/` y `/acceso/` dice «Modo: Desactivado» y «Salud: Leyendo…», el estado de la página antes de que su JavaScript lea la salud;
- la marca «Datos ficticios» sale en `/mercados/`, que sigue con datos ficticios, y no en `/`, `/auditoria/` ni `/acceso/`;
- en las cuatro páginas, el hash SHA-256 de cada uno de sus 3 scripts en línea está en el `script-src` de su `Content-Security-Policy`, y ese `script-src` no lleva `'unsafe-inline'`, así que el navegador los ejecuta;
- `GET /api/v1/datos/salud` sin sesión responde `401 unauthenticated`, con `Cache-Control: no-store`.

Un `curl -I` de `/` a las 03:24:10 trajo la política entera y el `Last-Modified` de la fila de las 02:54:54. Además de los hashes, la política lleva `style-src-attr 'unsafe-inline'`, que ADR-0019 §9 pide por los atributos `style` que escribe React.

**En el navegador**, sin sesión: la página se carga y su JavaScript se ejecuta. La barra pasa a «Salud: Sin sesión», con el enlace «Iniciar sesión», y el Observatorio dice «No se pudo leer la salud. Tu sesión no es válida. Vuelve a iniciar sesión.», también con el enlace. La herramienta del navegador no registró mensajes de la consola ni errores de la página.

**Para el PR 7c de F2.3.** `buoh-api` empezó a servir la web nueva entre las 02:54:34 y las 02:54:54, dentro de los días que mide el 7c, del 2026-11-03 al 2026-11-07 (`PROJECT_STATUS.md`, «Decisiones vigentes relevantes»). La instancia nueva arrancó antes, probablemente después de las 02:53:25, y la anterior se paró después, a horas que el agente no ve. El despliegue no cambió el código del servidor: solo los archivos de la web que sirve. Desde entonces, mientras una página de la web está abierta, con la pestaña a la vista, la insignia de salud de la barra superior lee la salud cada minuto, unos 1,5 KB de tráfico de salida por lectura (estimación del PR #94).

## Los despliegues del arreglo de CI (PR #96)

El PR #96 no es de F2.4, pero volvió a desplegar los servicios dentro de los días del 7c, y este documento registra los despliegues de esos días. `verify:pr` falló en `main` sobre `2a05955`, la fusión del PR #95, porque ESLint se quedó sin memoria (`JavaScript heap out of memory`, salida 134). El PR #96 le dio 4 GB en el script `lint` del `package.json` de la raíz ([ADR-0003](../arquitectura/adr/0003-lenguajes-y-limites.md)). Ese archivo está en el `buildFilter` de los cuatro servicios de Render, así que el PR los volvió a desplegar a todos, sin cambios de código. Las horas son UTC del 2026-11-05 y salen de GitHub, de las comprobaciones del agente desde fuera, sin sesión ni credenciales, y de sus lecturas de producción.

| Hora | Qué pasó |
|---|---|
| 11:43:33 | El propietario fusiona el PR #96 (`85f16e9`, GitHub). El árbol es el de su último commit, `2d644c5`, el que probó CI en el PR (`git diff --quiet 2d644c5 85f16e9` sale con 0). |
| 11:46:02, 11:49:52 y 11:58:33 | CI sobre `85f16e9`: `test:integration`, `verify:pr` y `desktop:windows` terminan bien. `verify:pr` vuelve a pasar en `main`. |
| 11:59:12 | La hora de la compilación de `buoh-sitio`: su `/` lleva `Last-Modified: Thu, 05 Nov 2026 11:59:12 UTC`. |
| 11:59:31 | La hora del archivo que escribió la compilación de `buoh-api`: su `/` lleva `Last-Modified: Thu, 05 Nov 2026 11:59:31 GMT`. Un `curl` de las 12:02:03 ya la trae. La instancia nueva arrancó probablemente después de esa hora, y la anterior se paró después, a horas que el agente no ve. |
| 12:01:24.016 | `buoh-ingesta` recibe el último frame de tick del proceso anterior. |
| 12:01:25.227 a 12:01:26.105 | El proceso anterior para: envía `forget_all` a las 12:01:25.227, pide el cierre a las 12:01:25.596, que cierra el segmento 1008 como `requested` (de 12:00:24.024 a 12:01:25.596), y escribe su último latido, `disconnected`, a las 12:01:26.105. |
| 12:01:29.088 a 12:01:31.150 | El proceso nuevo: su primer latido, `connecting`, a las 12:01:29.088; la conexión abierta a las 12:01:30.004 y `connected` a las 12:01:30.543; el catálogo, de 26 468 bytes, a las 12:01:30.571; y el primer frame de tick a las 12:01:31.150. |

Las horas de `buoh-ingesta` son las de recepción de los eventos del log 2 y las de sus latidos. Entre el último frame de tick del proceso anterior y el primero del nuevo pasaron unos 7,1 s sin ticks. El cierre fue pedido, así que ese hueco no se recupera (ADR-0015 §10, «Despliegue o reinicio programado»), y el gráfico del 5a lo marca como `capture_stopped` (ADR-0019 §8). El agente no vio cuándo se desplegó `buoh-operaciones`, que no deja rastro en el log.

**Para el PR 7c de F2.3 y para la evidencia de 7 días de F2.2.** `buoh-api` volvió a arrancar el 2026-11-05 hacia las 12:00. Antes, dentro de los días del 7c, había arrancado con el PR #91, el 2026-11-04 entre las 20:00 y las 20:09, y con el PR #94, el 2026-11-05 hacia las 02:54. La memoria de cada instancia empieza de cero al arrancar, así que esas horas cuentan al leer la gráfica de memoria del 7c. La captura tuvo un corte pedido de unos 7 s, de las 12:01:24 a las 12:01:31.

Lo que este documento cita de la documentación de Render la resume con otras palabras; lo demás es lo que se vio o se dedujo el 2026-11-04 y el 2026-11-05.
