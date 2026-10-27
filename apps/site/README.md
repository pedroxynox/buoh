# @buoh/site — sitio oficial

Sitio público de buoh (`V1-SITE-001`): qué es, cómo funciona, sus principios, plataformas, hoja de ruta y aviso de riesgo. Diseño y reglas de contenido en [`docs/diseno/sitio-oficial.md`](../../docs/diseno/sitio-oficial.md).

No tiene formularios, cookies ni recursos de terceros. `render.yaml` lo publica en Render como sitio estático gratuito cuando el propietario conecta el repositorio, y lleva `noindex` hasta la revisión legal y el dominio propio ([ADR-0013](../../docs/arquitectura/adr/0013-publicacion-del-sitio-en-render.md); pasos en [despliegue en Render](../../docs/operacion/despliegue-en-render.md)).

## Comandos

```text
pnpm --filter @buoh/site run build      # Next.js 16 con exportación estática a out/
pnpm --filter @buoh/site run test       # contenido frente al roadmap y páginas exportadas (lee el último build)
pnpm --filter @buoh/site run typecheck
```

`pnpm run test` y `pnpm run verify` construyen antes de probar. El build desactiva la telemetría de Next.js y usa un identificador fijo.

## Estructura

| Ruta | Qué contiene |
|---|---|
| `app/` | Una carpeta por página, el marco (`layout.tsx`) y los estilos `s-*` (`site.css`) |
| `src/content.ts` | Todo el texto estructurado: páginas, planos, ciclo, modos, principios, plataformas, fases y preguntas |
| `src/Frame.tsx` | Cabecera, pie con aviso de riesgo y nota de marcas, e introducciones de página |
| `test/` | Contenido frente a las fuentes canónicas y comprobación de cada página de `out/` |

La configuración de TypeScript sigue la de `apps/web`: `tsconfig.json` para Next.js y `tsconfig.typecheck.json` para `tsc` y ESLint.
