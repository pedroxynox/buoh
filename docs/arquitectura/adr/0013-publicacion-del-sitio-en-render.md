# ADR-0013: Publicación del sitio oficial en Render

- **Estado:** Aceptada
- **Fecha:** 2026-10-26
- **Ámbito:** sitio oficial (`apps/site`, `V1-SITE-001`). Complementa [ADR-0006](0006-alojamiento-en-render.md) y [ADR-0008](0008-linea-visual-marca-y-clientes-web.md) §3.
- **Decisores:** Propietario de buoh (publicar, dirección, indexación y revisión legal), a propuesta de la dirección técnica (forma del despliegue y cabeceras).

## Contexto

ADR-0008 §3 dejaba el sitio sin publicar hasta que el propietario decidiera dominio y alojamiento. [`PROJECT_STATUS.md`](../../../PROJECT_STATUS.md) lo tenía como decisión pendiente, junto con la revisión legal del texto. ADR-0006 eligió Render para la web, pero no autorizaba `render.yaml` en Fase 1, y el [plan de Fase 1](../../plan/fase-1-fundacion-de-datos.md) §4 difiere explícitamente el «despliegue productivo de Render». Esta ADR hace una excepción a esa línea del plan, solo para el sitio oficial.

El 2026-10-26 el agente propuso al propietario: «Te recomiendo subirlo ya a la dirección gratis de Render, sin que aparezca en Google. Antes de comprar el nombre y anunciarlo, conviene que un abogado revise el texto. Esa revisión estaba pendiente y la decides tú.» El propietario respondió: «Ok quiero hacer la 1 alojarlo en render».

Hechos verificados el 2026-10-26:

- **Gratis.** En Render, un sitio estático no paga cómputo. Cuenta contra lo incluido en el plan Hobby, que no tiene cuota: 5 GB de tráfico de salida y 500 minutos de compilación al mes. Si se agota el tráfico y no hay tarjeta, Render suspende los servicios gratuitos el resto del mes. Si se agotan los minutos de compilación, deja de compilar y el sitio sigue con lo último publicado. Con tarjeta registrada, Render cobra el exceso: 0,15 USD por GB y 5 USD por cada 1000 minutos.
- **Cómo se sirve.** Render lo sirve desde su CDN con TLS automático, en una dirección `onrender.com` propia del servicio. Las respuestas pasan por Cloudflare, el proveedor de protección contra ataques de denegación de servicio de Render: llevan `server: cloudflare`. Render admite cabeceras HTTP por ruta, filtros de compilación para monorepos y despliegues solo cuando pasa CI (`autoDeployTrigger: checksPass`), todo desde un Blueprint (`render.yaml`).
- **Lo que el Blueprint no controla.** Render conserva las reglas de cabecera que desaparecen de `render.yaml`, hasta que alguien las borra en su panel. Volver a un despliegue anterior desde el panel apaga los despliegues automáticos. Un recurso borrado solo del panel se vuelve a crear en la siguiente sincronización.
- **Sin cookies.** Dos sitios estáticos de ejemplo de Render (`cra.onrender.com` y `hugo.onrender.com`) no ponen cookies. Ya envían `Strict-Transport-Security`, responden 404 con el `404.html` del sitio a una ruta que no existe, y sirven `ruta/index.html` con barra final o sin ella.
- **Sin registros para el cliente.** Render no emite registros de los sitios estáticos. No publica cuánto guarda internamente.
- **Instalación de Render.** Antes del `buildCommand`, Render intenta instalar las dependencias por su cuenta, salvo que la variable `SKIP_INSTALL_DEPS` valga `true`.
- **Build probado.** En un clon limpio, con Node 24.22.0 (el de `.node-version`, que Render respeta) y pnpm 12.14.0, el `buildCommand` de `render.yaml` exporta `apps/site`, también con las cachés vacías, como en el primer despliegue. Instala el sitio, sus paquetes y las herramientas de la raíz, con el Node 24.22.0 que pide `devEngines`. Con `SKIP_INSTALL_DEPS`, Render ejecuta solo ese comando.

## Decisión

### 1. Alojamiento

El sitio se publica como sitio estático gratuito de Render, definido en `render.yaml` en la raíz del repositorio. Es un servicio `buoh-sitio` que:

- se compila desde `main`;
- instala con su propio `buildCommand`, sin la instalación automática de Render (`SKIP_INSTALL_DEPS`);
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

El PR que quite el `noindex` lo quita de la página y de `render.yaml`. Después, alguien con acceso a Render borra la regla `X-Robots-Tag` en su panel, porque Render la conserva, y comprueba con `curl -sI` que ya no sale.

### 4. Revisión legal

La revisión legal va antes de comprar un dominio, de quitar el `noindex` o de anunciar el sitio. Cubre el aviso de riesgo, también su párrafo sobre quién aloja el sitio, la nota de marcas y la frase de privacidad del pie. Sigue siendo una decisión del propietario.

### 5. Privacidad

El sitio no pone cookies ni tiene formularios, y buoh no recoge datos personales: Render no le entrega registros de los sitios estáticos. Render entrega el sitio a través de la red de Cloudflare, así que los servidores de los dos reciben la dirección IP de cada visita para entregar las páginas. El aviso de riesgo lo dice. El pie de todas las páginas dice que buoh no recoge datos personales, no que el sitio no los recoge. Tras el primer despliegue, se comprueba en la dirección propia que no hay cookies.

### 6. Cabeceras de seguridad

Además de `X-Robots-Tag`, Render envía en todas las rutas:

- `Content-Security-Policy`: solo recursos del propio sitio, sin formularios, sin marcos y sin objetos. Los scripts en línea se permiten (`'unsafe-inline'`), porque Next.js genera tres en cada página y su contenido cambia con el de la página: cada cambio de texto exigiría nuevos hashes en `render.yaml`;
- `Referrer-Policy: no-referrer`;
- `X-Content-Type-Options: nosniff`;
- `Permissions-Policy`, sin cámara, ubicación, micrófono, pagos ni USB.

`Strict-Transport-Security` no se repite, porque Render ya la envía.

### 7. Volver atrás

Desde el panel de Render, el servicio se puede suspender o volver a un despliegue anterior. Volver atrás desde el panel apaga los despliegues automáticos: cuando el problema esté corregido, se encienden otra vez en la configuración del servicio. Para quitarlo del todo, primero se borra de `render.yaml` y después del panel: un recurso borrado solo del panel se vuelve a crear en la siguiente sincronización.

### 8. Qué no autoriza

Ningún otro servicio de Render: ni API, ni worker, ni PostgreSQL, ni el prototipo `apps/web`, ni nada de pago. Esos llegan con su plan y con la decisión del propietario sobre el costo. ADR-0006 sigue valiendo para ellos.

## Consecuencias

- Cuando el propietario conecte el repositorio, el sitio queda en internet, gratis, y se actualiza solo con cada fusión en `main` que lo afecte y pase CI.
- Render instala su app de GitHub solo en `pedroxynox/buoh`. Lee todo el código, su historia y las alertas de Dependabot, y el correo de la cuenta de GitHub con que se entra. Puede escribir en checks, estados de commit, despliegues, entornos, issues, PR y webhooks del repositorio, y en GitHub Actions: lanzar, relanzar, cancelar o borrar ejecuciones, y activar o desactivar flujos. No puede cambiar el código, porque su permiso sobre el contenido es de solo lectura (`gh api apps/render`, 2026-10-26).
- Quien entre en la cuenta de Render puede cambiar lo que publica el sitio. El propietario entra con su GitHub, así que la verificación en dos pasos de GitHub protege también el sitio.
- Un fallo de compilación en Render no cambia lo publicado: sigue el último despliegue bueno.
- La seguridad de las cabeceras depende de `render.yaml` y del panel: una regla que se quita del Blueprint, o que se añade a mano, sigue en Render hasta borrarla allí. Una prueba de `scripts/` comprueba que `render.yaml` conserva las cabeceras y no define nada más.

## Alternativas descartadas

| Alternativa | Motivo |
|---|---|
| Esperar al dominio y a la revisión legal para publicar | El propietario prefirió publicar ya, sin indexar ni anunciar. |
| GitHub Pages | El repositorio es privado y Pages en un repositorio privado necesita un plan de pago. Además, añadiría otro proveedor cuando el propietario ya eligió Render (ADR-0006). |
| Cloudflare Pages o Netlify | Otro proveedor más, por la misma razón. |
| Un servicio web de Render con servidor Node | El sitio es una exportación estática: un servidor sería coste y superficie sin uso. |
| `robots.txt` con `Disallow: /` | Impide que el buscador lea el `noindex`, y la dirección puede aparecer igual si alguien la enlaza. |
| CSP con hashes de los scripts en línea | Los hashes cambian con cada cambio de contenido, así que `render.yaml` tendría que cambiar con cada texto; una lista desfasada rompería el sitio. |

## Referencias verificadas

- [Render: sitios estáticos](https://render.com/docs/static-sites) y [sus cabeceras](https://render.com/docs/static-site-headers)
- [Render: despliegue gratuito y sus límites](https://render.com/docs/free)
- [Render: referencia del Blueprint](https://render.com/docs/blueprint-spec) y [esquema JSON de `render.yaml`](https://render.com/schema/render.yaml.json)
- [Render: Blueprints](https://render.com/docs/infrastructure-as-code)
- [Render: despliegues](https://render.com/docs/deploys) y [vuelta a un despliegue anterior](https://render.com/docs/rollbacks)
- [Render: protección contra denegación de servicio](https://render.com/docs/ddos-protection)
- [Render: versión de Node.js](https://render.com/docs/node-version)
- [Render: registros](https://render.com/docs/logging)
- [Render: costes y planes de workspace](https://render.com/articles/how-much-does-cloud-application-hosting-cost-for-small-businesses)
- [GitHub: permisos de las GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)

El contenido de fuentes externas fue reformulado para cumplir restricciones de licencia.
