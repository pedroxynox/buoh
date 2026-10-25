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
- Sin cookies ni recogida de datos personales.
- Deriv, MetaTrader 5, MetaQuotes y Vantage aparecen solo como integraciones previstas, con la nota de que buoh no está afiliado a ellos.
- El estado de cada fase coincide con el roadmap y con `PROJECT_STATUS.md`: «hecha» si el roadmap la marca completada, «en curso» si es la fase actual y «prevista» si viene después. La línea visual V1 figura como «hecha» desde su cierre del 2026-10-25 (plan V1, §7).
- Mientras no se publique, todas las páginas llevan `noindex, nofollow`.

Las pruebas de `apps/site/test` comprueban estas reglas en las páginas exportadas y en su JavaScript, y comparan las fases, modos, plataformas e integraciones con el roadmap, el catálogo de funciones y ADR-0007. El texto sobre lo que existe hoy se escribió para la entrega `F1.4b`; una prueba falla cuando `PROJECT_STATUS.md` cambia de entrega, para obligar a revisarlo. La comprobación de «sin métricas» es aproximada: busca porcentajes y cifras con signo en el contenido. Además de las frases prohibidas de la guía de marca §3, las pruebas rechazan «regístrate», «suscríbete» y «compra ahora», por la regla de no tener registro ni compras ([estado del código](../arquitectura/estado-del-codigo.md) D-04).

## 4. Pendiente antes de publicar

- Dominio y alojamiento (ADR-0008).
- Revisión legal del aviso de riesgo y de la nota de marcas.
- Comprobar que el alojamiento elegido no pone cookies y saber cuánto guarda sus registros de acceso; si no se cumple, cambiar la frase de privacidad del pie en el mismo PR.
- Quitar `noindex` en el mismo PR que publique el sitio.
