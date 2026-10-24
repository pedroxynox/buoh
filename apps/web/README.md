# @buoh/web — prototipo visual

Prototipo navegable de la interfaz de buoh (`V1-UI-001`), con **datos ficticios**. Implementa el [concepto de interfaz](../../docs/diseno/concepto-de-interfaz.md) con el [sistema de diseño](../../packages/design-system/README.md), bajo las reglas de [ADR-0008](../../docs/arquitectura/adr/0008-linea-visual-marca-y-clientes-web.md).

No tiene API, cuentas, credenciales, conexión a fuentes ni brókeres. Ninguna pantalla envía órdenes.

## Comandos

```text
pnpm --filter @buoh/web run build      # Next.js 16 con exportación estática a out/
pnpm --filter @buoh/web run test       # fixtures y páginas exportadas (lee el último build)
pnpm --filter @buoh/web run typecheck
```

`pnpm run test` y `pnpm run verify` construyen antes de probar. `build` desactiva la telemetría de Next.js y usa un identificador de build fijo, así que dos exportaciones del mismo commit tienen las mismas rutas. Las tipografías se sirven desde el propio sitio (Fontsource) y no hay recursos de terceros.

## Estructura

| Ruta | Qué contiene |
|---|---|
| `app/` | Una carpeta por sección, el marco (`layout.tsx`) y los estilos `w-*` (`globals.css`) |
| `src/components/` | Marco con barra superior y navegación, gráficos SVG, tarjeta de señal y metadatos de datos |
| `src/fixtures.ts` | Todos los datos ficticios, fijados en el código |
| `test/` | Invariantes de los datos y comprobación de cada página de `out/` |

## Configuración de TypeScript

- `tsconfig.json` lo usa Next.js: resuelve `@buoh/*` desde su build (`dist`).
- `tsconfig.typecheck.json` lo usan `tsc` y ESLint: añade alias a `src`, como el resto del monorepo, para no depender del build.
