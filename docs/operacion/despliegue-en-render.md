# Despliegue en Render

## Alcance

`render.yaml` solo define el sitio oficial (`apps/site`), como sitio estático gratuito ([ADR-0013](../arquitectura/adr/0013-publicacion-del-sitio-en-render.md)). La API, el worker y PostgreSQL no estarán en `render.yaml`, sino en un Blueprint aparte, `render-datos.yaml` ([ADR-0018](../arquitectura/adr/0018-sistema-de-datos-en-produccion.md) §2), que llega con los incrementos del [plan de Fase 2](../plan/fase-2-laboratorio-y-bot-shadow.md): el sistema de datos en F2.2, la API con la web en F2.3 y el motor de señales `shadow` en F2.9. Así, fusionar esos cambios no crea ni cobra nada hasta que el propietario crea ese Blueprint con los pasos de F2.2. El propietario ya decidió los proveedores, el presupuesto y la región ([ADR-0016](../arquitectura/adr/0016-alojamiento-del-sistema-de-datos.md) y ADR-0018), y el almacenamiento de objetos irá en Cloudflare R2, fuera de Render y de sus Blueprints.

## Qué define `render.yaml`

Un servicio, `buoh-sitio`:

- **Compilación:** con Node 24.22.0 (de `.node-version`) y pnpm 12.14.0, instala el sitio, sus paquetes y las herramientas de la raíz (`--filter "@buoh/site..."`), con el Node 24.22.0 que pide `devEngines`, y ejecuta su `build`. Publica `apps/site/out`. La variable `SKIP_INSTALL_DEPS` impide que Render instale antes por su cuenta con npm o yarn.
- **Cuándo despliega:** después de cada commit en `main` cuyos checks de CI pasaron, y solo si el commit toca algo de lo que depende el sitio: `apps/site`, `packages/design-system`, la configuración de pnpm, Node o TypeScript, o `render.yaml`. Los cambios de pruebas y de Markdown no despliegan.
- **Sin vistas previas** de los PR.
- **Cabeceras en todas las rutas:** `X-Robots-Tag: noindex, nofollow`, `Content-Security-Policy`, `Referrer-Policy`, `X-Content-Type-Options` y `Permissions-Policy` (ADR-0013 §3 y §6).

`scripts/render-blueprint.test.mjs` comprueba que `render.yaml` solo tiene ese servicio, sin claves de más, y que conserva esas cabeceras.

Render conserva las reglas de cabecera que se quitan de `render.yaml` y las que se añaden a mano en su panel: para quitar una, hay que borrarla también allí.

## Primera conexión (una vez, la hace el propietario)

El agente no tiene acceso a Render. El propietario:

1. Activa la verificación en dos pasos en GitHub, si no la tiene: quien entre en su cuenta de Render puede cambiar lo que publica el sitio.
2. Entra en [render.com](https://render.com) y crea una cuenta con su GitHub. El plan Hobby es gratuito.
3. En el panel, pulsa **New** y después **Blueprint**.
4. Conecta GitHub. Cuando GitHub pregunte a qué repositorios puede entrar Render, elige **Only select repositories** y solo `pedroxynox/buoh`. Render podrá leer todo el código y su historia, y escribir comentarios, estados y avisos en los PR, en los issues y en GitHub Actions, pero no cambiar el código (lista completa en ADR-0013, «Consecuencias»).
5. Pulsa **Connect** junto a `pedroxynox/buoh`. Deja la rama `main` y el archivo `render.yaml` que propone.
6. Revisa que la lista muestre un solo servicio, `buoh-sitio`, y pulsa **Deploy Blueprint**.
7. Espera a que termine el primer despliegue, unos minutos. La dirección aparece en la página del servicio, con la forma `https://buoh-sitio….onrender.com`. Se la pasa al agente.

El 2026-10-27, el servicio `buoh-sitio` respondía en `https://buoh-sitio.onrender.com` y pasó la comprobación de abajo (detalle en P-V1-07 de la [especificación de pendientes](../plan/especificacion-de-pendientes.md)).

## Comprobar un despliegue

Con la dirección del servicio en lugar de `<dirección>`:

```sh
curl -sI https://<dirección>/ | grep -i -E 'x-robots-tag|content-security-policy|set-cookie'
curl -s -o /dev/null -w '%{http_code}\n' https://<dirección>/no-existe/
```

Debe salir `x-robots-tag: noindex, nofollow` y la `content-security-policy`, ningún `set-cookie`, y `404` para la ruta que no existe. Las seis páginas del menú tienen que abrir.

La comprobación completa, como la del primer despliegue, repite con GET (`curl -s -D - -o /dev/null`) en las seis páginas, con barra final y sin ella, y en una ruta que no existe:

- las cinco cabeceras de `render.yaml` en todas las respuestas, y la `strict-transport-security` que añade Render;
- ningún `set-cookie`;
- la ruta que no existe responde `404` con la página propia del sitio;
- `http://` redirige a `https://`;
- lo que cargan las páginas (scripts, hoja de estilos, icono y fuentes) es del propio sitio y responde `200`.

Con HEAD (`curl -sI`), una ruta que no existe recibe el `404` de texto de Render, que no lleva esas cabeceras: compruébalas siempre con GET. Buscadores y navegadores piden las páginas con GET.

## Volver atrás

- **Despliegue anterior:** en la página de `buoh-sitio`, en la lista de despliegues, elegir uno bueno y pulsar **Rollback**. Render apaga entonces los despliegues automáticos. Cuando el problema esté corregido, se vuelven a encender en **Settings → Auto-Deploy → After CI Checks Pass**.
- **Apagar el sitio:** en la configuración de `buoh-sitio`, **Suspend**. Mientras está suspendido, la dirección responde con un error 503.
- **Quitarlo del todo:** primero borrar el servicio de `render.yaml` y fusionar, y después borrarlo del panel. Si solo se borra del panel, Render lo vuelve a crear en la siguiente sincronización del Blueprint.

Un despliegue que falla no cambia lo publicado: Render sigue sirviendo el último bueno.

## Costo

Gratis en el plan Hobby. Cuenta contra lo incluido: 5 GB de tráfico de salida y 500 minutos de compilación al mes. Si se agota el tráfico y no hay tarjeta, Render suspende los servicios gratuitos el resto del mes. Si se agotan los minutos de compilación, deja de compilar y el sitio sigue con lo último publicado. Con tarjeta registrada, Render cobra el exceso: 0,15 USD por GB y 5 USD por cada 1000 minutos.

## Pendiente

- Dominio propio y revisión legal antes de quitar el `noindex` o anunciar el sitio (ADR-0013 §4). El PR que lo quite borra el `noindex` de la página y la regla `X-Robots-Tag` de `render.yaml`. Después, alguien con acceso a Render borra esa regla en el panel, que conserva las reglas de cabecera que ya no están en el Blueprint, y comprueba con `curl -sI` que ya no sale.
- El resto del sistema llega con los incrementos F2.2, F2.3 y F2.9 del [plan de Fase 2](../plan/fase-2-laboratorio-y-bot-shadow.md), con los proveedores y el presupuesto de [ADR-0016](../arquitectura/adr/0016-alojamiento-del-sistema-de-datos.md).
