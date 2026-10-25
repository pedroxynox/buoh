# ADR-0008: Línea visual, marca y clientes web

- **Estado:** Aceptada
- **Fecha:** 2026-10-24
- **Ámbito:** trabajo en paralelo a Fase 1, sin cambiar su alcance ni su puerta de salida
- **Decisores:** Propietario de buoh, a propuesta de la dirección técnica
- **Complementada por:** [ADR-0009](0009-prototipo-movil.md) (prototipo móvil)
- **Complementa:** [ADR-0001](0001-plataforma-y-stack.md) y [ADR-0003](0003-lenguajes-y-limites.md) (web con Next.js y React) y la [arquitectura objetivo](../arquitectura-objetivo.md) (`packages/design-system` y `apps/web`); añade `apps/site`.

## Contexto

El 2026-10-24 el propietario pidió empezar ya la parte visual:

- el concepto de la interfaz del cliente;
- qué funciones tendrá buoh y cuándo estará disponible cada una;
- el front end, bien desarrollado;
- la marca: paleta de colores y demás;
- un sitio oficial;
- después, móvil y escritorio.

El plan de Fase 1 difiere `apps/web`, `apps/mobile` y el escritorio, y AGENTS.md solo permite crear lo que pide un plan activo. Hace falta una decisión que autorice este trabajo sin mezclarlo con los datos ni adelantar señales o ejecución.

## Decisión

### 1. Una línea visual en paralelo

Se abre la **línea visual V1**, con su propio plan ([`docs/plan/linea-visual-v1.md`](../../plan/linea-visual-v1.md)). Corre en paralelo a Fase 1 y no cambia su alcance, sus requisitos ni su puerta de salida.

La línea visual autoriza:

| Pieza | Qué es | Qué no es |
|---|---|---|
| `packages/design-system` | Tokens de marca (colores, tipografía, espacios, movimiento), CSS base y componentes React para web | No contiene lógica de dominio, riesgo ni red |
| `apps/web` | Prototipo navegable de la interfaz del producto con datos ficticios | No tiene API, autenticación, cuentas, conexión a fuentes ni brókeres |
| `apps/site` | Sitio oficial estático de buoh | No tiene formularios, registro, pagos, suscripciones ni métricas de desempeño |

Móvil (`apps/mobile`) y escritorio (`apps/desktop`) siguen diferidos. Cada uno necesitará su propio incremento del plan.

### 2. Reglas del prototipo

- Todo dato del prototipo es ficticio, está fijado en el código y se muestra con la marca visible «Datos ficticios». No se generan valores al azar ni se leen relojes reales.
- Toda pantalla muestra, separados, el modo de ejecución (`disabled`, `shadow`, `demo`, `real`) y la salud del servicio, con texto e icono además del color.
- Toda métrica de desempeño ficticia muestra modo, período, muestra, costes, pérdidas, *drawdown*, versión y limitaciones, como exigen los fundamentos. No se muestran métricas aisladas.
- Ninguna pantalla envía órdenes, guarda credenciales ni simula una conexión real.
- Las funciones de las fases 1, 1B, 2 y 3 se dibujan con datos ficticios. Las de la Fase 3B en adelante aparecen marcadas como «Disponible en Fase N», sin controles activos.

### 3. Reglas del sitio oficial

- Describe qué es buoh, sus principios, sus planos, su estado y su hoja de ruta, en el mismo tono de evidencia.
- No promete ganancias, no publica resultados, no capta usuarios, no vende señales y no recoge datos personales.
- Incluye una advertencia de riesgo sobre opciones y CFD, y nombra a Deriv, MetaTrader 5 y Vantage solo como integraciones previstas, con una nota de marcas de terceros y sin afirmar afiliación.
- No se publica en internet hasta que el propietario decida dominio y alojamiento. Esa decisión queda pendiente.

### 4. Stack

- **Next.js 16.4** con App Router y exportación estática (`output: 'export'`), en las dos apps. El mínimo es 16.4.1, que corrige dos fallos críticos de ejecución remota y uno de denegación de servicio publicados el 2026-10-14, incluido el de los paquetes `react-server-dom-*` que Next.js incluye dentro ([The Hacker News](https://thehackernews.com/2026/10/nextjs-ships-out-of-band-patch-for-two.html)). Se fija la versión más reciente que tenga al menos un día publicada, como exige la política de pnpm (`minimumReleaseAge`); el 2026-10-24 es 16.4.2, porque 16.4.3 salió el 2026-10-23. La exportación estática no ejecuta un servidor Next.js, así que no expone Server Actions ni la caché de componentes.
- **React 19.3.1** para `react` y `react-dom`, la versión vigente.
- **CSS Modules y variables CSS** generadas desde los tokens. Sin framework de utilidades.
- **Tipografías** Manrope y JetBrains Mono, licencia SIL OFL 1.1, alojadas dentro del sitio mediante Fontsource. No se cargan desde servicios externos.
- **Iconos y gráficos** propios en SVG, sin bibliotecas de iconos ni de gráficos.
- La telemetría de Next.js se desactiva en los scripts.

Los tokens de `packages/design-system` no dependen de React ni del navegador, para que la futura app móvil (React Native) y el escritorio (Tauri 2) usen los mismos valores.

## Consecuencias

- La marca y la interfaz se pueden revisar y corregir antes de que existan datos reales.
- El prototipo fija el diseño de la información de las fases 2 a 6 antes de construirlas; cuando llegue cada fase, sus datos reales sustituyen a los ficticios y su plan puede cambiar el diseño.
- Se añaden dependencias de interfaz (Next.js, React y tipografías) que no tocan el worker ni los contratos.
- Hay más superficie que mantener actualizada, en especial Next.js y sus avisos de seguridad.

## Alternativas descartadas

| Alternativa | Motivo de descarte |
|---|---|
| Esperar a Fase 2 o 3 para diseñar | El propietario quiere ver y validar la marca y la interfaz desde ahora. |
| Tailwind u otro framework de utilidades | Añade una dependencia y un segundo vocabulario de estilos; las variables CSS bastan y sirven de base a móvil. |
| Astro u otro generador para el sitio | Introduce un segundo framework web frente a Next.js, ya elegido en ADR-0001. |
| Un solo proyecto para sitio y producto | El producto tendrá autenticación y API; el sitio debe seguir estático y público. |
| Bibliotecas de gráficos o de iconos | Más dependencias para gráficos simples; SVG propio mantiene la identidad y el control. |
| Fuentes cargadas desde Google Fonts | Añade una petición a un tercero en cada visita. |

## Pendientes

- Dominio y alojamiento del sitio oficial.
- Incremento de móvil (React Native) y de escritorio (Tauri 2).
- Revisión legal del texto del sitio antes de publicarlo.

## Referencias verificadas

- [Next.js en npm](https://www.npmjs.com/package/next) (16.4.1 el 2026-10-14, 16.4.2 el 2026-10-15 y 16.4.3 el 2026-10-23)
- [React en npm](https://www.npmjs.com/package/react) (19.3.1, publicada el 2026-10-14)
- [Aviso de seguridad de Next.js de octubre de 2026](https://thehackernews.com/2026/10/nextjs-ships-out-of-band-patch-for-two.html)
- [Fontsource: Manrope](https://fontsource.org/fonts/manrope) y [JetBrains Mono](https://fontsource.org/fonts/jetbrains-mono)

El contenido de fuentes externas fue reformulado para cumplir restricciones de licencia.
