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
- El estado de cada fase coincide con el roadmap y con `PROJECT_STATUS.md`. La línea visual V1 queda «en curso» hasta que el propietario revise las capturas (plan V1, §7).
- Mientras no se publique, todas las páginas llevan `noindex, nofollow`.

Las pruebas de `apps/site/test` comprueban cada regla en las páginas exportadas y comparan las fases con el roadmap.

## 4. Pendiente antes de publicar

- Dominio y alojamiento (ADR-0008).
- Revisión legal del aviso de riesgo y de la nota de marcas.
- Quitar `noindex` en el mismo PR que publique el sitio.
