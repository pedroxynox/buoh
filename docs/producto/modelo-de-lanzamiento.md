# Modelo de lanzamiento y comercialización

- **Estado:** Decisión de producto aceptada
- **Fecha:** 2026-10-17

## Decisión

buoh se desarrollará y validará primero para **uso propio**. Después evolucionará a un producto para **suscriptores externos**, incluyendo señales pagas y, si cada puerta de producto se supera, ejecución con dinero real autorizada.

Las señales pagas y el dinero real **no están prohibidos ni bloqueados por la arquitectura**. Las puertas de datos, seguridad, operación y cumplimiento determinan cuándo y en qué alcance pueden activarse; no eliminan esa línea de negocio.

## Secuencia comercial

| Etapa | Público | Producto | Estado operativo |
|---|---|---|---|
| 1. Uso propio | fundador/operador | laboratorio y bot `shadow` | sin órdenes reales |
| 2. Validación personal | fundador/operador | bot `demo`, y posteriormente piloto real limitado | evidencia y controles internos |
| 3. Beta externa | grupo pequeño autorizado | señales con modo y desempeño claramente identificados | acceso controlado |
| 4. Suscripción comercial | suscriptores externos elegibles | señales pagas, con historial y limitaciones visibles | `shadow`, `demo` o `real` explícito |
| 5. Ejecución autorizada | usuarios/cuentas aprobados | automatización bajo política de riesgo | solo alcance permitido |

Las etapas pueden solaparse parcialmente, pero ninguna cambia el modo de una estrategia ni de una señal sin versionado, evidencia y permisos.

## Señales pagas

Las suscripciones de pago son un producto explícito a diseñar, no una excepción. Tendrán:

- derechos de acceso y niveles de producto auditables;
- modo visible de cada señal (`shadow`, `demo` o `real`);
- desempeño contextualizado por estrategia, período, costes, pérdidas y limitaciones;
- historial de entrega, vencimiento y versión;
- limitación por jurisdicción, público e instrumento cuando corresponda;
- separación entre señal informativa y autorización de ejecución.

La monetización, el proveedor de pagos y los precios se decidirán cuando se conozcan jurisdicción, entidad legal, público objetivo y requisitos de distribución. Ningún proveedor de pagos se integra antes de esa decisión.

## Ejecución con dinero real

El objetivo es permitir dinero real de manera limitada, autorizada y trazable. La arquitectura no restringe ese destino: `execution-gateway`, el libro de auditoría, OAuth, políticas de riesgo y reconciliación existen precisamente para habilitarlo de forma segura.

La habilitación real será específica por estrategia, instrumento, cuenta, tipo de contrato, jurisdicción y versión de política. La aprobación de una estrategia no aprueba automáticamente todas las demás.

## Límites que permanecen

- No se garantizan beneficios ni se presenta la rentabilidad como certeza.
- No se gestionan fondos, depósitos, retiros ni custodia de suscriptores.
- No se reciben contraseñas de Deriv ni se entregan secretos de ejecución a un cliente.
- No se ofrecen señales o ejecución fuera de los territorios, usuarios y condiciones aprobadas.

Estos límites protegen el producto y no contradicen su camino comercial.
