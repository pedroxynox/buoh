# Sitio oficial de buoh

Diseño y reglas de contenido del sitio público (`V1-SITE-001`). Lo implementa `apps/site` con el [sistema de diseño](../../packages/design-system/README.md), bajo [ADR-0008](../arquitectura/adr/0008-linea-visual-marca-y-clientes-web.md) §3 y la [guía de marca](marca-buoh.md).

## 1. Para qué sirve

Explicar qué es buoh, cómo trabaja, qué nunca hará y en qué estado está, en el mismo tono de evidencia que el producto. No vende, no capta usuarios y no publica resultados.

## 2. Páginas

| Ruta | Página | Qué responde |
|---|---|---|
| `/` | Inicio | Qué es buoh, sus tres planos, sus cuatro modos, en qué fases está y preguntas frecuentes |
| `/como-funciona/` | Cómo funciona | El ciclo del dato a la decisión, la calidad de los datos, modo y salud, y quién puede enviar una orden |
| `/principios/` | Principios | Cómo trabaja buoh, lo que nunca hará y cómo se mostrará un resultado |
| `/plataformas/` | Plataformas | Web, móvil y Windows; integraciones previstas (Deriv, Deriv MT5 y Vantage); credenciales |
| `/hoja-de-ruta/` | Hoja de ruta | Las fases del [roadmap](../producto/roadmap.md) con su estado |
| `/aviso-de-riesgo/` | Aviso de riesgo | Riesgo de pérdida, qué no es buoh, marcas y datos de terceros, privacidad del sitio |

Todas las páginas comparten cabecera con menú y un pie con el aviso de riesgo corto, la nota de marcas de terceros y la declaración de privacidad.

## 3. Reglas de contenido

- Sin formularios, registro, botones de compra, pagos, suscripciones ni métricas de desempeño.
- Sin recursos de terceros: tipografías y estilos se sirven desde el propio sitio.
- Sin cookies, y buoh no recoge datos personales; los servidores que entregan el sitio sí reciben la IP de cada visita (§4).
- Deriv, MetaTrader 5, MetaQuotes y Vantage aparecen solo como integraciones previstas, con la nota de que buoh no está afiliado a ellos.
- El estado de cada fase coincide con el roadmap y con `PROJECT_STATUS.md`: «hecha» si el roadmap la marca completada, «en curso» si es la fase actual y «prevista» si viene después. La línea visual V1 figura como «hecha» desde su cierre del 2026-10-25 (plan V1, §7), y la Fase 1, desde el suyo del 2026-10-29 (plan de Fase 1, §9).
- Hasta la revisión legal y el dominio propio, todas las páginas llevan `noindex, nofollow`, en la página y en la cabecera `X-Robots-Tag` que envía Render ([ADR-0013](../arquitectura/adr/0013-publicacion-del-sitio-en-render.md) §3).

Las pruebas de `apps/site/test` comprueban estas reglas en las páginas exportadas y en su JavaScript, y comparan las fases, modos, plataformas e integraciones con el roadmap, el catálogo de funciones y ADR-0007. El texto sobre lo que existe hoy se escribió para la entrega `F2.1`; una prueba falla cuando `PROJECT_STATUS.md` cambia de entrega, para obligar a revisarlo. La comprobación de «sin métricas» es aproximada: busca porcentajes y cifras con signo en el contenido. Además de las frases prohibidas de la guía de marca §3, las pruebas rechazan «regístrate», «suscríbete» y «compra ahora», por la regla de no tener registro ni compras ([estado del código](../arquitectura/estado-del-codigo.md) D-04).

## 4. Publicación

Desde el 2026-10-26, por decisión del propietario, el sitio se publica en Render como sitio estático gratuito, en la dirección `onrender.com` que asigne Render, sin indexar y sin anunciar ([ADR-0013](../arquitectura/adr/0013-publicacion-del-sitio-en-render.md)). Lo define `render.yaml`. El propietario conectó el repositorio el 2026-10-27, y el sitio está en `https://buoh-sitio.onrender.com`; la primera conexión y las comprobaciones están en [despliegue en Render](../operacion/despliegue-en-render.md).

Comprobado el 2026-10-26:

- dos sitios estáticos de ejemplo de Render no ponen cookies. El 2026-10-27, tras el primer despliegue, se comprobó lo mismo en la dirección del sitio: ninguna de sus páginas, ni la de una ruta que no existe, devuelve `set-cookie`;
- Render entrega los sitios a través de la red de Cloudflare, no da registros de acceso de los sitios estáticos y no publica cuánto guarda internamente.

La regla anterior de esta sección pedía cambiar la frase de privacidad del pie si no se sabía cuánto guarda el alojamiento sus registros de acceso. No se sabe, y además los servidores de Render y de Cloudflare reciben la dirección IP de cada visita. Por eso el pie dice que el sitio no tiene formularios ni usa cookies y que buoh no recoge datos personales, y el aviso de riesgo dice quién aloja el sitio y qué reciben sus servidores.

Antes de comprar un dominio, quitar el `noindex` o anunciar el sitio:

- revisión legal del aviso de riesgo, también de su párrafo sobre quién aloja el sitio, de la nota de marcas y de la frase de privacidad del pie;
- quitar el `noindex` de la página y la regla `X-Robots-Tag` de `render.yaml` en el mismo PR, borrar después esa regla en el panel de Render, que conserva las reglas de cabecera que ya no están en el Blueprint, y comprobar con `curl -sI` que ya no sale.
