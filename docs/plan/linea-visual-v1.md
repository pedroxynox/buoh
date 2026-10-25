---
plan_id: "V1-VISUAL"
schema_version: "1.0.0"
status: "ready"
effective_when_merged: true
owner: "propietario de buoh"
last_reviewed_utc: "2026-10-25T05:00:00.000Z"
---

# Plan ejecutable: línea visual V1

## 1. Objetivo

Dar a buoh una identidad visual propia y una interfaz que el propietario pueda ver y validar antes de que existan datos reales: marca, sistema de diseño, catálogo de funciones, prototipos navegables del producto (web y móvil) y sitio oficial.

La línea visual corre en paralelo a [Fase 1](fase-1-fundacion-de-datos.md) y no cambia su alcance ([ADR-0008](../arquitectura/adr/0008-linea-visual-marca-y-clientes-web.md)).

## 2. Estado y aprobación

`ready`: este plan autoriza los incrementos V1.1 a V1.4 cuando se fusione el PR que los contiene. V1.4, el prototipo móvil, se añadió el 2026-10-25 ([ADR-0009](../arquitectura/adr/0009-prototipo-movil.md)). El escritorio necesita un incremento propio en este plan antes de crear código.

## 3. Corte de implementación

### Crear durante V1

```text
packages/design-system/   # tokens, CSS base y componentes React web
apps/web/                 # prototipo navegable con datos ficticios
apps/site/                # sitio oficial estático
apps/mobile/              # prototipo móvil (Expo) con datos ficticios
packages/prototype-data/  # datos ficticios compartidos por los prototipos
docs/diseno/              # marca y concepto de interfaz
```

### Diferido explícitamente

API, autenticación, cuentas, conexión a fuentes o brókeres, datos reales, formularios, analítica de visitantes, publicación del sitio o de la app, compilaciones nativas firmadas y `apps/desktop`.

## 4. Requisitos

### `V1-BRAND-001` — Marca documentada

La [guía de marca](../diseno/marca-buoh.md) define nombre, idea, voz, logotipo, paleta, tipografía, iconos, movimiento y usos prohibidos.

**Aceptación:** cada color de la paleta tiene un token; la guía prohíbe promesas de ganancia y animaciones que generen urgencia.

### `V1-DS-001` — Sistema de diseño ejecutable

`packages/design-system` exporta los tokens como datos TypeScript sin dependencias de React ni del navegador, genera las variables CSS y ofrece componentes React para web.

**Aceptación:**

- toda pareja de texto y fondo del tema cumple WCAG 2.2 AA (4,5:1 para texto normal y 3:1 para componentes y texto grande), comprobado por pruebas;
- cada valor de `execution_mode`, `service_health` y `severity` de `@buoh/contracts` tiene etiqueta, icono y tono, comprobado por pruebas;
- el CSS generado coincide con los tokens.

### `V1-FUNC-001` — Catálogo de funciones y disponibilidad

El [catálogo](../producto/funciones-y-disponibilidad.md) lista cada función de buoh con su plano, la fase en que se habilita y las plataformas donde estará.

**Aceptación:** cada función tiene fase y plataformas; ninguna función de ejecución aparece en un cliente con permiso de operar.

### `V1-UI-001` — Prototipo navegable del producto

`apps/web` implementa el [concepto de interfaz](../diseno/concepto-de-interfaz.md) con datos ficticios.

**Aceptación:**

- toda pantalla muestra el modo de ejecución y la salud del servicio por separado, y la marca «Datos ficticios»;
- toda métrica de desempeño muestra modo, período, muestra, costes, pérdidas, *drawdown*, versión y limitaciones;
- toda señal muestra estrategia, versión, modo, vencimiento, calidad y evidencia;
- las funciones de las fases 1, 1B, 2 y 3 se dibujan con datos ficticios; las de la Fase 3B en adelante aparecen como «Disponible en Fase N», sin controles activos;
- la exportación estática se construye sin red, sin reloj real y sin aleatoriedad.

### `V1-SITE-001` — Sitio oficial

`apps/site` publica qué es buoh, sus principios, sus planos, su estado y su hoja de ruta.

**Aceptación:** sin formularios, registro, pagos, métricas de desempeño ni recursos de terceros; con advertencia de riesgo y nota de marcas de terceros en todas las páginas.

### `V1-MOBILE-001` — Prototipo móvil

`apps/mobile` implementa el móvil del [concepto de interfaz](../diseno/concepto-de-interfaz.md) §7 con los datos ficticios de `packages/prototype-data` ([ADR-0009](../arquitectura/adr/0009-prototipo-movil.md)).

**Aceptación:**

- cinco pestañas: Inicio, Señales, Alertas, Evidencia y Más;
- modo de ejecución y salud del servicio siempre visibles y separados, y la marca «Datos ficticios»;
- toda cifra de desempeño con su contexto completo; toda señal con estrategia, versión, modo, vencimiento, calidad y un enlace a su evidencia, como pide el catálogo;
- sin campos de texto ni contraseñas; sin edición de estrategias o políticas ni petición del modo real; el *kill switch* aparece con candado de Fase 4;
- `expo export` compila Android, iOS y web, y las pruebas comprueban cada pestaña renderizada.

## 5. Secuencia de entrega

1. **V1.1:** guía de marca, catálogo de funciones, concepto de interfaz y `packages/design-system` (`V1-BRAND-001`, `V1-DS-001`, `V1-FUNC-001`).
2. **V1.2:** prototipo navegable en `apps/web` (`V1-UI-001`).
3. **V1.3:** sitio oficial en `apps/site` (`V1-SITE-001`).
4. **V1.4:** prototipo móvil en `apps/mobile` y datos compartidos en `packages/prototype-data` (`V1-MOBILE-001`).

Cada incremento es un PR propio, con una revisión semántica.

## 6. Comandos

| Comando | Se introduce | Comportamiento |
|---|---|---|
| `pnpm run verify` | ya existe | incluye tipos, lint, pruebas y build de las piezas nuevas |
| `pnpm --filter @buoh/web run build` | V1.2 | exporta el prototipo a `apps/web/out` |
| `pnpm --filter @buoh/site run build` | V1.3 | exporta el sitio a `apps/site/out` |
| `pnpm --filter @buoh/mobile run build` | V1.4 | compila Android, iOS y web en `apps/mobile/out` |

## 7. Definition of Done

La línea visual V1 está `done` cuando sus requisitos tienen evidencia fusionada y el propietario revisó capturas de los prototipos y del sitio.
