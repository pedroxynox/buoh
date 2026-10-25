# @buoh/design-system

Sistema de diseño de buoh (`V1-DS-001`, [ADR-0008](../../docs/arquitectura/adr/0008-linea-visual-marca-y-clientes-web.md)). La guía que explica cada decisión es la [guía de marca](../../docs/diseno/marca-buoh.md).

## Contenido

| Entrada | Qué trae | Para |
|---|---|---|
| `@buoh/design-system` | Tokens (paleta, temas noche y día, tipografía, espacios, radios, movimiento), presentación de estados, iconos como datos, contraste WCAG y generador de CSS | Web, móvil y escritorio: no depende de React ni del navegador |
| `@buoh/design-system/react` | Logotipo, iconos, insignias de modo, salud y severidad, tarjeta, métrica con contexto, candado de fase y aviso de datos ficticios | Apps web con React |
| `@buoh/design-system/buoh.css` | Variables de ambos temas, estilos base y clases `b-*` de los componentes | Apps web |
| `@buoh/design-system/assets/*` | Símbolo en SVG: noche, día y monocromo | Documentos y piezas fuera del código |

El tema noche es el predeterminado. Para el tema día, se añade `data-theme="dia"` a cualquier contenedor.

## Reglas que comprueban las pruebas

- Todo texto cumple 4,5:1 de contraste y todo borde de control o foco 3:1, en ambos temas.
- Cada valor de `execution_mode`, `service_health` y `severity` de `@buoh/contracts` tiene etiqueta, descripción, icono y tono.
- Modo y salud no comparten tonos, salvo el neutro de pausa y desactivado; el ámbar de marca no es un estado.
- El CSS contiene exactamente los valores de los tokens.
- `MetricWithContext` exige origen (`backtest`, `shadow`, `demo` o `real`), período, muestra, costes, pérdidas, *drawdown*, versión y limitaciones, y las pruebas comprueban que muestra cada valor.

## Comandos

```text
pnpm --filter @buoh/design-system run build
pnpm --filter @buoh/design-system run test
```

Las tipografías (Manrope y JetBrains Mono) las carga cada app desde Fontsource; este paquete solo nombra sus familias.
