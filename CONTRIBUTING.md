# Contribuir a buoh

## Propósito

buoh es un sistema de investigación, señales y futura ejecución controlada. Cada cambio debe mejorar trazabilidad, seguridad o evidencia; no se aceptan atajos que mezclen experimentación con ejecución.

## Antes de modificar

1. Lee [`README.md`](README.md), las reglas en [`.kiro/steering/fundamentos-buoh.md`](.kiro/steering/fundamentos-buoh.md) y los documentos de dominio afectados.
2. Comprueba que el cambio pertenece a la fase actual del roadmap.
3. Si altera datos, estrategias, riesgo, ejecución, seguridad o plataforma, añade o actualiza una decisión/documentación antes del código.
4. No agregues cuentas reales, secretos, pagos ni ejecución de dinero real sin una puerta de calidad aprobada.

## Organización del trabajo

- `apps/`: clientes y servicios desplegables; se crea durante el scaffolding de Fase 1.
- `packages/`: contratos, dominio, estrategia, riesgo y diseño compartidos.
- `research/python/`: investigación reproducible; nunca ejecuta órdenes directamente.
- `docs/`: fuente de verdad de producto, arquitectura, gobierno y operación.

No crees código fuera de esta estructura sin una decisión documentada.

## Reglas de implementación

- TypeScript estricto es el lenguaje principal; Python queda aislado para investigación cuantitativa.
- Valida entradas externas en tiempo de ejecución; los tipos estáticos no bastan.
- Usa UTC, identificadores correlacionables y versiones de esquema para datos/eventos.
- No uses números de punto flotante binario para importes, precios o límites monetarios; conserva una representación decimal explícita.
- Las funciones de dominio y riesgo deben ser puras, deterministas y tener pruebas.
- `shadow`, `demo` y `real` son entornos incompatibles. Un cambio no puede promover una estrategia por defecto.
- Los clientes no contienen secretos de servidor ni credenciales con capacidad directa de ejecución.

## Calidad y revisión

Cuando exista el scaffolding, cada cambio debe ejecutar los comandos documentados de formato, tipos, pruebas y compilación. No inventes comandos o resultados antes de que existan los archivos de configuración.

Una propuesta de cambio debe indicar:

- propósito y fase del roadmap;
- archivos o contratos afectados;
- evidencia de prueba o motivo por el que aún no aplica;
- impacto en datos, riesgo, seguridad, operación o compatibilidad;
- documentación/ADR actualizada, si corresponde.

## Git y commits

Cuando el repositorio se inicialice, usar ramas cortas con prefijo `feat/`, `fix/`, `docs/`, `chore/` o `refactor/`. Los commits usan el formato:

```text
type(scope): resumen imperativo
```

Ejemplo: `docs(contracts): define event metadata`.

No incluyas secretos, datos de clientes, tokens de Deriv, archivos Parquet reales ni resultados no anonimizados en Git.
