# @buoh/mobile — prototipo móvil

Prototipo navegable de la app de Android e iOS (`V1-MOBILE-001`), con **datos ficticios** de [`@buoh/prototype-data`](../../packages/prototype-data/README.md). Decisiones en [ADR-0009](../../docs/arquitectura/adr/0009-prototipo-movil.md); diseño en el [concepto de interfaz](../../docs/diseno/concepto-de-interfaz.md) §7.

Pestañas: Inicio, Señales, Alertas, Evidencia y Más. No envía órdenes, no se conecta a fuentes ni brókeres, no tiene campos de texto y no pide el modo real; el *kill switch* aparece con candado de Fase 4.

## Comandos

```text
pnpm --filter @buoh/mobile run build      # expo export: Android, iOS y web en out/
pnpm --filter @buoh/mobile run test       # cada pestaña renderizada con React Native for Web
pnpm --filter @buoh/mobile run typecheck
```

`build` desactiva la telemetría de Expo. `out/` contiene una versión web que se abre con cualquier servidor de archivos local; los paquetes de Android e iOS demuestran que la app compila, pero no son una app instalable.

## Estructura

| Ruta | Qué contiene |
|---|---|
| `src/App.tsx` | Tipografías, barra superior con modo y salud, contenido y barra inferior |
| `src/screens.tsx` | Las cinco pestañas |
| `src/model.ts` | Qué muestra cada pestaña, comprobable sin teléfono |
| `src/ui.tsx`, `src/theme.ts` | Insignias, tarjetas, iconos y logotipo con los tokens de `@buoh/design-system` |
| `test/` | Pruebas de las pestañas renderizadas |

## Configuración

- Expo SDK 58 con React 19.3.0, la versión que exige React Native 0.88.
- Metro resuelve los paquetes del monorepo desde su build (`experiments.tsconfigPaths: false`).
- `tsconfig.json` activa `skipLibCheck`, porque los tipos de React Native chocan con los de Node y del navegador.
