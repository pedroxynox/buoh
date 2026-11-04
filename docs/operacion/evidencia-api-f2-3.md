# Evidencia de la API de F2.3 en producción

Evidencia de lo que [ADR-0019](../arquitectura/adr/0019-api-cuentas-y-auditoria.md) §13 pide en producción, fuera de CI, reunida el 2026-11-03 y el 2026-11-04 contra `https://buoh-api.onrender.com` (§14, PR 7). Con el PR 7a desplegado pasan todas las comprobaciones desde fuera, la de las dos redes con el propietario, y el alta y el primer inicio de sesión del propietario. La primera pasada, antes del 7a, encontró que el límite por dirección no funcionaba y que los archivos estáticos no llevaban política de contenido; el 7a lo corrigió. Falta la memoria y el tráfico de salida de varios días, que el propietario copia de Render desde el 2026-11-08.

Este documento no trae secretos, ni la dirección de salida del sandbox, ni el nombre de usuario del propietario, que no se publica (§1). Los intentos fallidos usaron solo nombres que no existen.

## El despliegue (PR 6b)

Las horas de este cuadro salen de la fusión en GitHub y de los registros y las pantallas de Render que copió el propietario. El `502` con `no-deploy` lo comprobó el agente desde fuera.

| Hora (UTC) | Qué pasó |
|---|---|
| 2026-11-03 18:21 | El propietario fusiona el PR #85 (`a0f1a29`). CI pasa, y Render crea `buoh-api`. |
| 18:38 a 18:39 | La compilación termina bien (`Build successful`). |
| 18:39 a 18:54 | `GET /api/salud` responde `503` cada 10 segundos, y a las 18:54:12 Render marca el despliegue como `Timed Out`, a los 15 minutos. La dirección pública responde `502` con `x-render-routing: no-deploy`. |
| 18:54 a 19:42 | `buoh-operaciones` corre bien cada 5 minutos, pero sin `BUOH_API_POSTGRES_PASSWORD`: sin ella, su paso 1 no toca la API (§14, PR 3), así que el esquema `buoh_api` no existía. Un segundo despliegue a mano agota el tiempo igual, a las 19:42:05. |
| después de las 19:42 | El propietario abre el Blueprint y pulsa **Manual Sync**. Render muestra el cambio que faltaba, «Create environment variable with key `BUOH_API_POSTGRES_PASSWORD` for cron job `buoh-operaciones`», con un botón **Approve**, y el propietario lo aprueba. Con la variable, `buoh-operaciones` crea el rol, migra el esquema y le pone la contraseña, y el propietario despliega `buoh-api` otra vez (**Manual Deploy**). Esta vez `/api/salud` responde `200` y Render dice `Your service is live`. |

La sincronización automática del Blueprint creó `buoh-api`, pero dejó sin aplicar, pendiente de aprobación, la variable nueva de un servicio que ya existía. No encontré en la documentación de Render por qué pasa. El [runbook de la API](runbook-api.md) («Desplegar») y la guía de [despliegue en Render](despliegue-en-render.md) dicen ahora que hay que mirar si el Blueprint tiene cambios pendientes después de fusionar, y qué hacer si el primer despliegue agota el tiempo.

Render dio la dirección normal, `https://buoh-api.onrender.com`, así que `BUOH_API_ORIGIN` no cambió.

## El alta y el primer inicio de sesión

- **El alta**, el 2026-11-03, desde la Shell de `buoh-api`. El primer intento falló en bash con `syntax error near unexpected token 'newline'`: se copiaron literalmente los `<` y `>` de `<tu-usuario>`, y el pegado añadió `^[[200~` delante. El segundo intento, sin esos signos, dio el enlace. La pantalla del enlace terminó con «Tu cuenta quedó dada de alta» (captura del propietario). El runbook muestra ahora un ejemplo sin esos signos.
- **El primer inicio de sesión**, ese mismo día. La sección Auditoría mostró las entradas reales: el enlace creado, el enlace usado, el alta y el inicio de sesión. Palabras del propietario: «Ya entré, en auditoria aparece realmente como dices».

## Comprobaciones desde fuera

La primera pasada fue el 2026-11-03, con `main` en `a0f1a29`, y la segunda el 2026-11-04, con el PR 7a (#86, `b638c4c`) en producción. El agente vio la versión nueva a las 00:59:44 UTC, cuando `/icon.svg` empezó a traer la política de contenido estricta; antes de esa hora, la consultaba cada 20 segundos.

| Comprobación (§13) | Antes del 7a | Con el 7a |
|---|---|---|
| Las cabeceras de §9 en JSON (`/api/salud`), en el 404 JSON, en HTML (`/`, `/acceso/`), en el 404 HTML y en un `.js` estático | todas, salvo la política de contenido del `.js` | todas, también la política estricta en `.js`, `.css` y `.svg` |
| Una sola `Strict-Transport-Security` | una en cada respuesta | una en cada respuesta |
| `http://` redirige a `https://` | `301` | `301` |
| Los hashes de `script-src` coinciden con los scripts en línea, sin `unsafe` (`/`, `/acceso/`, `/enlace/`, `/auditoria/`, `/datos/` y el 404) | 6 de 6 | 6 de 6 |
| Ninguna dirección absoluta en `src` ni `href` (`/`, `/acceso/`, `/enlace/`, `/auditoria/`) | ninguna | sin cambio (la web no cambió) |
| Un inicio de sesión fallido no deja ninguna cookie | ningún `Set-Cookie` en 24 | ningún `Set-Cookie` en 26 |
| CSRF: sin `Origin`, con otro `Origin` y con `text/plain` | `403 csrf_rejected` las tres | `403 csrf_rejected` las tres |
| Cambiar `X-Forwarded-For` en cada intento no esquiva el límite por dirección | **falla**: 24 fallos seguidos, todos `401` | **pasa**: 10 `401` y después `429`, también con `True-Client-IP` distinto y con `CF-Connecting-IP` vacía |
| El límite general, 121 GET a `/api/salud` en un minuto | **falla**: en la revisión del 7a, 125 seguidos, todos `200` | **pasa**: 120 `200` y un `429` (de 01:01:04 a 01:01:12), y lo mismo cuando lo repitió la revisión del 7b |
| Una `CF-Connecting-IP` con valor enviada por el cliente | `403` de Cloudflare («error code: 1000») | `403` de Cloudflare («error code: 1000») |
| Dos redes distintas cuentan por separado | — | **pasa** (abajo) |

Los 12 intentos del runbook («El límite por dirección»), del 2026-11-04 de 01:02:15 a 01:02:20 UTC, con nombres `prueba-limite-1` a `prueba-limite-12`: los diez primeros, `401 invalid_credentials`; el 11 y el 12, este con `CF-Connecting-IP` vacía, `429 rate_limited` con `retry_after_seconds` 896. Ninguno trajo `set-cookie`.

**Las dos redes.** El 2026-11-04, con el propietario esperando en la pantalla de inicio de sesión, en una ventana de incógnito:

1. A las 01:09:23, el sandbox seguía bloqueado por la prueba anterior, con 472 s de espera. Se esperó a que venciera, para dar 15 minutos enteros.
2. De 01:17:18 a 01:17:22, diez fallos seguidos con nombres que no existen. El siguiente intento recibió `429` con 895 s de espera: el sandbox quedó bloqueado hasta las 01:32:17.
3. Entonces el propietario entró desde su casa con su usuario, su contraseña y un código, y cerró la sesión. Sus palabras: «Pude entrar y salir normalmente».
4. A las 01:20:48, después de su respuesta, el sandbox seguía bloqueado: `429` con 689 s de espera. El bloqueo cubrió entero su inicio de sesión.

Fuera de estas comprobaciones, la dirección de salida del sandbox fue la misma en 6 consultas seguidas. Así los intentos de cada prueba salieron de una sola dirección.

## Lo que se aprendió al comprobar

- **La dirección del cliente.** En Render, la última dirección de `X-Forwarded-For` es una interna que cambia en cada petición. Por eso, antes del 7a, ningún límite por dirección contaba. Un servicio de terceros alojado en Render que devuelve lo que recibe mostró la forma de la cabecera: lo que mandó el cliente, el cliente, Cloudflare y la interna. Ese servicio no se vuelve a usar, porque su respuesta pide a los agentes que le envíen datos; solo recibió peticiones GET, sin ningún dato nuestro. El 7a toma la dirección de `CF-Connecting-IP`, como aprobó el propietario el 2026-11-03 («Ok hazlo como recomiendas»; ADR-0019 §1). Render no documenta esa cabecera, así que el runbook repite las comprobaciones en cada evidencia.
- **Los intentos de estas pruebas** fueron 50, todos con nombres que no existen: 24 antes del 7a y 26 después (20 `401` y 6 `429`). Quedan en la auditoría como fallos sin cuenta, agrupados, que la sección Auditoría del propietario no muestra. Ningún intento usó el nombre del propietario, así que su límite por nombre y su tope de 100 no se tocaron.

## Lo que falta

- **La memoria y el tráfico de salida de varios días** (`F2-API-001`, §10). Desde el 2026-11-08, el propietario copia de Render el panel de memoria de `buoh-api` y su tráfico de salida, junto con los paneles de la evidencia de 7 días de F2.2. El PR siguiente los registra y deja F2.3 hecho.
- **Lo que las pruebas cubren sin red.** Que cada secreto solo aparece en su canal lo comprueban las pruebas de §13 (`apps/api/test/secrets.test.ts` y la integración de las cuentas). Desde fuera solo se ve que ninguna respuesta lleva una cookie que no toca. Las líneas `api_request` que el propietario copió del registro de Render traen solo `event`, `method`, `route`, `status`, `duration_ms` y `request_id`.
