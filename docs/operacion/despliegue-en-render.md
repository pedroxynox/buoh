# Despliegue en Render

## Alcance

Hoy solo se despliega el sitio oficial (`apps/site`), como sitio estático gratuito ([ADR-0013](../arquitectura/adr/0013-publicacion-del-sitio-en-render.md)). La API, el worker, PostgreSQL y el almacenamiento de objetos todavía no están en `render.yaml`: llegarán con su plan y con la decisión del propietario sobre el costo ([ADR-0006](../arquitectura/adr/0006-alojamiento-en-render.md)).

## Qué define `render.yaml`

Un servicio, `buoh-sitio`:

- **Compilación:** con Node 24.22.0 (de `.node-version`) y pnpm 12.14.0, instala solo el sitio y sus dependencias (`--filter "@buoh/site..."`) y ejecuta su `build`. Publica `apps/site/out`.
- **Cuándo despliega:** después de cada commit en `main` cuyos checks de CI pasaron, y solo si el commit toca algo de lo que depende el sitio: `apps/site`, `packages/design-system`, la configuración de pnpm, Node o TypeScript, o `render.yaml`. Los cambios de pruebas y de Markdown no despliegan.
- **Sin vistas previas** de los PR.
- **Cabeceras en todas las rutas:** `X-Robots-Tag: noindex, nofollow`, `Content-Security-Policy`, `Referrer-Policy`, `X-Content-Type-Options` y `Permissions-Policy` (ADR-0013 §3 y §6).

`scripts/render-blueprint.test.mjs` comprueba que `render.yaml` solo tiene ese servicio y que conserva esas cabeceras.

## Primera conexión (una vez, la hace el propietario)

El agente no tiene acceso a Render. El propietario:

1. Entra en [render.com](https://render.com) y crea una cuenta con su GitHub. El plan Hobby es gratuito.
2. En el panel, pulsa **New** y después **Blueprint**.
3. Conecta GitHub. Cuando GitHub pregunte a qué repositorios puede entrar Render, elige **Only select repositories** y solo `pedroxynox/buoh`.
4. Pulsa **Connect** junto a `pedroxynox/buoh`. Deja la rama `main` y el archivo `render.yaml` que propone.
5. Revisa que la lista muestre un solo servicio, `buoh-sitio`, y pulsa **Deploy Blueprint**.
6. Espera a que termine el primer despliegue, unos minutos. La dirección aparece en la página del servicio, con la forma `https://buoh-sitio….onrender.com`. Se la pasa al agente.

## Comprobar un despliegue

Con la dirección del servicio en lugar de `<dirección>`:

```sh
curl -sI https://<dirección>/ | grep -i -E 'x-robots-tag|content-security-policy|set-cookie'
curl -s -o /dev/null -w '%{http_code}\n' https://<dirección>/no-existe/
```

Debe salir `x-robots-tag: noindex, nofollow` y la `content-security-policy`, ningún `set-cookie`, y `404` para la ruta que no existe. Las seis páginas del menú tienen que abrir.

## Volver atrás

- **Despliegue anterior:** en la página de `buoh-sitio`, en la lista de despliegues, elegir uno bueno y pulsar **Rollback**.
- **Apagar el sitio:** en la configuración de `buoh-sitio`, **Suspend**. Mientras está suspendido, la dirección responde con un error 503.
- **Quitarlo del todo:** primero borrar el servicio de `render.yaml` y fusionar, y después borrarlo del panel. Si solo se borra del panel, Render lo vuelve a crear en la siguiente sincronización del Blueprint.

Un despliegue que falla no cambia lo publicado: Render sigue sirviendo el último bueno.

## Costo

Gratis en el plan Hobby. Cuenta contra lo incluido: 5 GB de tráfico de salida y 500 minutos de compilación al mes. Sin tarjeta registrada, si se agotan, Render suspende los servicios gratuitos hasta el mes siguiente.

## Pendiente

- Dominio propio y revisión legal antes de quitar `noindex` o anunciar el sitio (ADR-0013 §4).
- El resto del sistema, cuando el propietario decida su costo.
