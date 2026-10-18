# ADR-0003: Lenguajes y límites de responsabilidad técnica

- **Estado:** Aceptada
- **Fecha:** 2026-10-17
- **Decisores:** Dirección técnica de buoh

## Contexto

buoh necesita web, Android, iOS, API, ingesta de mercado, motor de señales, una futura pasarela de ejecución, análisis cuantitativo y una ruta a Windows. Elegir un único lenguaje para todo sacrificaría productividad analítica o consistencia de producto; adoptar demasiados lenguajes aumentaría defectos, divergencia de contratos y coste de mantenimiento.

## Decisión

### TypeScript estricto — lenguaje principal

TypeScript será el lenguaje por defecto de producto: Next.js/React (web), Expo/React Native (Android/iOS), Fastify (API), trabajadores de datos, motor de señales, políticas de riesgo, contratos y futura pasarela de ejecución.

Se usará configuración estricta, sin `any` implícito, validación en tiempo de ejecución con esquemas versionados y pruebas para toda lógica de dominio/riesgo. TypeScript no sustituye validación de entrada: los límites de red, archivos, eventos y base de datos deben validarse en runtime.

**Por qué es la mejor elección principal para buoh:** comparte modelos y contratos entre cinco superficies, reduce traducciones de negocio, permite un equipo y monorepo coherentes, y es suficiente para un sistema principalmente orientado a WebSocket, I/O y reglas de negocio. La corrección de una orden y su auditoría importan más que una optimización prematura de CPU.

### Baseline de toolchain para Fase 1

El primer scaffolding fijará **Node.js 24.22.0 LTS** y **pnpm 12.14.0** mediante archivo de runtime, `packageManager` y lockfile. No se usará `latest` en CI o despliegue. Las dependencias de desarrollo se fijarán en el lockfile y solo se actualizarán mediante PR con `pnpm run verify`.

La selección se revisó el 2026-10-17 contra [releases oficiales de Node.js](https://nodejs.org/en/about/previous-releases) y [pnpm 12.14.0](https://pnpm.io/blog/releases/12.14.0). El contenido externo fue reformulado para cumplir restricciones de licencia.

### Herramientas ejecutables de F1.1

- TypeScript 6 estricto compila contratos; el lockfile fija la versión exacta compatible con `typescript-eslint`.
- Zod 4 es la única fuente de estructura runtime y usa su [conversión nativa a JSON Schema](https://zod.dev/json-schema).
- `canonicalize` implementa JSON Canonicalization Scheme para identidades independientes del lenguaje.
- Vitest ejecuta pruebas offline; ESLint usa configuración plana y reglas TypeScript con tipos; Prettier limita formato a código/configuración y no toca vectores firmados.
- Turborepo coordina `build`, `typecheck` y `test` sin introducir servicios.
- pnpm permite scripts de instalación únicamente para `esbuild`, dependencia transitiva necesaria para el toolchain; cualquier permiso adicional requiere revisión explícita.

`package.json`, `pnpm-lock.yaml` y `pnpm-workspace.yaml` son canónicos para versiones y permisos exactos. Este ADR registra motivos, no duplica el inventario mutable.

### Python — investigación cuantitativa aislada

Python se limita a `research/python`: exploración estadística, transformación tabular, validación de hipótesis, simulaciones y generación de artefactos reproducibles. Se preferirán entornos bloqueados y bibliotecas explícitas de cálculo/estadística; sus resultados atraviesan la frontera hacia TypeScript mediante contratos y datos versionados.

**Por qué es la mejor elección para investigación:** su ecosistema cuantitativo acelera la validación de hipótesis y la experimentación de series temporales. No será la ruta directa de órdenes: así se evita mezclar notebooks, dependencias dinámicas y experimentación con la infraestructura crítica de ejecución.

### SQL — lenguaje de datos y auditoría

SQL para PostgreSQL y, solo si una necesidad medida lo justifica, TimescaleDB, define migraciones, invariantes, consultas temporales y auditoría. Los registros transaccionales de autorización, intención, orden y reconciliación deben apoyarse en restricciones de base de datos además de validaciones de aplicación.

### Rust — limitado al contenedor Windows y extensiones justificadas

Rust entra solo con Tauri 2 para el futuro cliente Windows y, si perfiles reales lo justifican, una extensión de rendimiento estrictamente aislada. No se usa para la lógica de negocio inicial ni para reescribir el motor de señales sin una medición que lo justifique.

### Kotlin y Swift — módulos nativos mínimos

Kotlin (Android) y Swift (iOS) solo se usan si React Native necesita un puente nativo: notificaciones, biometría, widgets/Live Activities o la futura capa Android pasiva. No duplican las reglas de estrategia, riesgo o ejecución.

## Contrato entre lenguajes

- `packages/contracts` es la fuente de verdad de eventos y APIs en TypeScript.
- Los esquemas se publican como JSON Schema/OpenAPI versionados; Python los valida/consume, no inventa formatos paralelos.
- Las fórmulas de producción se prueban con vectores de referencia compartidos para evitar divergencia entre Python y TypeScript.
- Toda lógica que cambie una señal, política u orden tiene propietario, versión, pruebas deterministas y auditoría.

## Alternativas descartadas

| Alternativa | Motivo de descarte |
|---|---|
| Python para toda la plataforma | Excelente para investigación, pero fragmenta clientes y no ofrece la misma coherencia de contratos/UI/API. |
| Flutter/Dart para móvil y web | Añade una segunda pila de producto sin compensar la reutilización ya obtenida con TypeScript/React. |
| Rust/C++ como motor inicial | Eleva complejidad y velocidad de desarrollo antes de probar un cuello de botella real. |
| Kotlin/Swift nativos para toda la app móvil | Duplica esfuerzos entre Android/iOS y aleja las reglas compartidas del servidor. |
| JavaScript sin TypeScript estricto | Aumenta la probabilidad de errores de contrato en señales, riesgos y órdenes. |

## Consecuencia

No afirmamos que un lenguaje sea universalmente mejor: esta combinación es la mejor relación entre consistencia, velocidad de desarrollo, análisis cuantitativo y control de riesgo para buoh. Un cambio requiere medición, ADR y un plan de migración; no se adopta una tecnología por moda.
