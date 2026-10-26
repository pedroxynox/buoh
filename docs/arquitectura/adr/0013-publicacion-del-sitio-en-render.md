# ADR-0013: Publicación del sitio oficial en Render

- **Estado:** Aceptada
- **Fecha:** 2026-10-26
- **Ámbito:** sitio oficial (`apps/site`, `V1-SITE-001`). Complementa [ADR-0006](0006-alojamiento-en-render.md) y [ADR-0008](0008-linea-visual-marca-y-clientes-web.md) §3.
- **Decisores:** Propietario de buoh (publicar, dirección, indexación y revisión legal), a propuesta de la dirección técnica (forma del despliegue y cabeceras).

## Contexto

ADR-0008 §3 dejaba el sitio sin publicar hasta que el propietario decidiera dominio y alojamiento. [`PROJECT_STATUS.md`](../../../PROJECT_STATUS.md) lo tenía como decisión pendiente, junto con la revisión legal del texto. ADR-0006 eligió Render para la web, pero no autorizaba `render.yaml` en Fase 1.

El 2026-10-26 el agente propuso al propietario: «subirlo ya a la dirección gratis de Render, sin que aparezca en Google. Antes de comprar el nombre y anunciarlo, conviene que un abogado revise el texto». El propietario respondió: «Ok quiero hacer la 1 alojarlo en render».

Hechos verificados el 2026-10-26:

- **Gratis.** En Render, un sitio estático no paga cómputo. Cuenta contra lo incluido en el plan Hobby, que no tiene cuota: 5 GB de tráfico de salida y 500 minutos de compilación al mes. Sin tarjeta registrada, si se agotan, Render suspende los servicios gratuitos hasta el mes siguiente.
- **Cómo se sirve.** Render lo sirve desde su CDN con TLS automático, en una dirección `onrender.com` propia del servicio. Admite cabeceras HTTP por ruta, filtros de compilación para monorepos y despliegues solo cuando pasa CI (`autoDeployTrigger: checksPass`), todo desde un Blueprint (`render.yaml`).
- **Sin cookies.** Dos sitios estáticos de ejemplo de Render (`cra.onrender.com` y `hugo.onrender.com`) no ponen cookies. Ya envían `Strict-Transport-Security`, responden 404 con el `404.html` del sitio a una ruta que no existe, y sirven `ruta/index.html` con barra final o sin ella.
- **Sin registros para el cliente.** Render no emite registros de los sitios estáticos. No publica cuánto guarda internamente.
- **Build probado.** La exportación de `apps/site` se compila en un clon limpio con Node 24.22.0, el de `.node-version` que Render respeta, y pnpm 12.14.0, instalando solo el sitio y sus dependencias. También con las cachés vacías, como en el primer despliegue.

## Decisión

### 1. Alojamiento

El sitio se publica como sitio estático gratuito de Render, definido en `render.yaml` en la raíz del repositorio. Es un servicio `buoh-sitio` que:

- se compila desde `main`;
- publica `apps/site/out`;
- se despliega solo cuando los checks de CI de ese commit pasaron;
- no tiene vistas previas de los PR;
- se recompila solo cuando cambia algo de lo que depende: el sitio, el sistema de diseño, la configuración de pnpm, Node o TypeScript, o el propio `render.yaml`.

El propietario conecta el repositorio en Render una vez, con los pasos de [despliegue en Render](../../operacion/despliegue-en-render.md). El agente no tiene acceso a Render.

### 2. Dirección

La dirección es la `onrender.com` que asigne Render. No se compra dominio propio todavía.

### 3. Sin indexar ni anunciar

Hasta la revisión legal y el dominio propio:

- cada página lleva `<meta name="robots" content="noindex, nofollow">`, como ya hacía;
- Render añade la cabecera `X-Robots-Tag: noindex, nofollow` a todas las rutas, también a los archivos que no son HTML;
- no hay `robots.txt` que bloquee: un buscador que no pudiera leer la página no vería el `noindex`;
- la dirección no se anuncia.

### 4. Revisión legal

La revisión legal del aviso de riesgo, de la nota de marcas y de la frase de privacidad va antes de comprar un dominio, de quitar el `noindex` o de anunciar el sitio. Sigue siendo una decisión del propietario.

### 5. Privacidad

El sitio no pone cookies ni recoge datos, y Render no se los entrega a buoh. El aviso de riesgo dice quién lo aloja y que sus servidores reciben la dirección IP de cada visita para entregar las páginas. Tras el primer despliegue, se comprueba en la dirección propia que no hay cookies.

### 6. Cabeceras de seguridad

Además de `X-Robots-Tag`, Render envía en todas las rutas:

- `Content-Security-Policy`: solo recursos del propio sitio, sin formularios, sin marcos y sin objetos. Los scripts en línea se permiten (`'unsafe-inline'`), porque Next.js genera tres en cada página con contenido que cambia en cada compilación, y una lista de hashes fija en `render.yaml` se rompería;
- `Referrer-Policy: no-referrer`;
- `X-Content-Type-Options: nosniff`;
- `Permissions-Policy`, sin cámara, ubicación, micrófono, pagos ni USB.

`Strict-Transport-Security` no se repite, porque Render ya la envía.

### 7. Volver atrás

Desde el panel de Render, el servicio se puede suspender o volver a un despliegue anterior. Para quitarlo del todo, primero se borra de `render.yaml` y después del panel: un recurso borrado solo del panel se vuelve a crear en la siguiente sincronización.

### 8. Qué no autoriza

Ningún otro servicio de Render: ni API, ni worker, ni PostgreSQL, ni el prototipo `apps/web`, ni nada de pago. Esos llegan con su plan y con la decisión del propietario sobre el costo. ADR-0006 sigue valiendo para ellos.

## Consecuencias

- El sitio queda en internet, gratis, y se actualiza solo con cada fusión en `main` que lo afecte y pase CI.
- Render puede leer el repositorio privado para compilarlo: el propietario le da acceso solo a `pedroxynox/buoh`.
- Un fallo de compilación en Render no cambia lo publicado: sigue el último despliegue bueno.
- La seguridad de las cabeceras depende de `render.yaml`. Una prueba de `scripts/` comprueba que siguen ahí.

## Alternativas descartadas

| Alternativa | Motivo |
|---|---|
| Esperar al dominio y a la revisión legal para publicar | El propietario prefirió publicar ya, sin indexar ni anunciar. |
| GitHub Pages | El repositorio es privado y Pages en un repositorio privado necesita un plan de pago. Además, añadiría otro proveedor cuando el propietario ya eligió Render (ADR-0006). |
| Cloudflare Pages o Netlify | Otro proveedor más, por la misma razón. |
| Un servicio web de Render con servidor Node | El sitio es una exportación estática: un servidor sería coste y superficie sin uso. |
| `robots.txt` con `Disallow: /` | Impide que el buscador lea el `noindex`, y la dirección puede aparecer igual si alguien la enlaza. |
| CSP con hashes de los scripts en línea | Los hashes cambian con cada compilación y `render.yaml` es fijo; una lista desfasada rompería el sitio. |

## Referencias verificadas

- [Render: sitios estáticos](https://render.com/docs/static-sites)
- [Render: despliegue gratuito y sus límites](https://render.com/docs/free)
- [Render: referencia del Blueprint](https://render.com/docs/blueprint-spec) y [esquema JSON de `render.yaml`](https://render.com/schema/render.yaml.json)
- [Render: Blueprints](https://render.com/docs/infrastructure-as-code)
- [Render: versión de Node.js](https://render.com/docs/node-version)
- [Render: registros](https://render.com/docs/logging)
- [Render: costes y planes de workspace](https://render.com/articles/how-much-does-cloud-application-hosting-cost-for-small-businesses)

El contenido de fuentes externas fue reformulado para cumplir restricciones de licencia.
