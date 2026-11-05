# @buoh/web — prototipo visual

Prototipo navegable de la interfaz de buoh (`V1-UI-001`), con **datos ficticios**. Implementa el [concepto de interfaz](../../docs/diseno/concepto-de-interfaz.md) con el [sistema de diseño](../../packages/design-system/README.md), bajo las reglas de [ADR-0008](../../docs/arquitectura/adr/0008-linea-visual-marca-y-clientes-web.md).

Desde F2.3 se exporta en dos variantes del mismo código ([ADR-0019](../../docs/arquitectura/adr/0019-api-cuentas-y-auditoria.md) §9), que elige la variable de compilación `NEXT_PUBLIC_BUOH_WEB_TARGET`:

- `out`: el prototipo del escritorio, con datos ficticios, sin formularios y sin llamar a la API (`F2-UI-001`). No tiene cuentas, credenciales, conexión a fuentes ni brókeres, y ninguna pantalla envía órdenes. Es el que empaqueta el escritorio ([ADR-0010](../../docs/arquitectura/adr/0010-prototipo-de-escritorio.md)).
- `out-api`: la que sirve la API (PR 6). Añade las pantallas de inicio de sesión (`/acceso`) y de enlace de alta (`/enlace`), el menú de la sesión y la sección Auditoría con los eventos reales de la cuenta, que llaman a la API del mismo origen. El QR del enlace lo dibuja `uqr`, dentro de buoh y como SVG en línea. Desde F2.4, el Observatorio y las insignias de modo y salud de la barra superior muestran la salud real de los datos, y la marca «Datos ficticios» va solo en las secciones que siguen con ellos ([concepto de interfaz](../../docs/diseno/concepto-de-interfaz.md) §10).

## Comandos

```text
pnpm --filter @buoh/web run build      # las dos exportaciones: out (escritorio) y out-api (API)
pnpm --filter @buoh/web run test       # cada página de out y de out-api (lee el último build)
pnpm --filter @buoh/web run typecheck
```

`pnpm run test` y `pnpm run verify` construyen antes de probar. `scripts/build-exports.mjs` compila las dos variantes con un identificador de build fijo —así dos exportaciones del mismo commit tienen las mismas rutas— y quita de `out` las rutas de acceso y de enlace. Las tipografías se sirven desde el propio sitio (Fontsource) y no hay recursos de terceros.

## Estructura

| Ruta | Qué contiene |
|---|---|
| `app/` | Una carpeta por sección, las rutas `acceso/` y `enlace/` de `out-api`, el marco (`layout.tsx`) y los estilos `w-*` (`globals.css`) |
| `src/components/` | Marco con barra superior y navegación, gráficos SVG, tarjeta de señal y metadatos de datos; el menú de la sesión (`SessionMenu.tsx`), las pantallas servidas por la API (`auth/`) y la salud de los datos de `out-api` (`salud/`, `ObservatorioReal.tsx`) |
| `scripts/` | `build-exports.mjs`: compila las dos variantes `out` y `out-api` |
| `test/` | Comprobación de cada página de `out/` y de `out-api/`, de que `out` no llama a la API, y de la salud de los datos y el Observatorio de `out-api` |

`test/salud.test.ts` compara la causa que lee la web con la derivación real de la salud, que carga del dominio compilado (`packages/domain/dist`) por ruta relativa: `pnpm run verify` lo compila antes de probar. `@buoh/domain` no es una dependencia de la web, así que no entra en el JavaScript de ninguna exportación.

Los datos ficticios y sus pruebas de coherencia viven en [`@buoh/prototype-data`](../../packages/prototype-data/README.md), compartidos con el prototipo móvil.

## Configuración de TypeScript

- `tsconfig.json` lo usa Next.js: resuelve `@buoh/*` desde su build (`dist`).
- `tsconfig.typecheck.json` lo usan `tsc` y ESLint: añade alias a `src`, como el resto del monorepo, para no depender del build.
