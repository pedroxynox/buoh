# Roadmap de buoh por puertas de calidad

Este roadmap ordena el trabajo por evidencia y reducción de riesgo, no por fechas cosméticas. buoh sí llegará a señales pagas y ejecución con dinero real, pero ninguna fase de mayor riesgo comienza por presión comercial o por un resultado histórico aislado.

## Fase 0 — Fundación v2 (completada)

**Estado:** `done`.

**Objetivo:** fijar el producto como bot de investigación, señales y ejecución controlada.

**Entregables:** visión revisada, arquitectura de tres planos, ADR de ejecución, gobierno de riesgo y reglas persistentes.

**Salida:** las interfaces no pueden eludir la pasarela de riesgo, y cada persona sabe diferenciar `shadow`, `demo` y `real`.

## Línea visual V1 (completada)

**Estado:** `done` desde el 2026-10-25. Corrió en paralelo a Fase 1.

**Objetivo:** dar a buoh su marca y una interfaz que se pueda ver y validar antes de tener datos reales ([ADR-0008](../arquitectura/adr/0008-linea-visual-marca-y-clientes-web.md), [plan](../plan/linea-visual-v1.md)).

**Incrementos:**

1. guía de marca, catálogo de funciones, concepto de interfaz y sistema de diseño;
2. prototipo navegable del producto con datos ficticios;
3. sitio oficial estático;
4. prototipo móvil con datos ficticios;
5. prototipo de escritorio para Windows con datos ficticios;
6. identidad visual a partir del logo del propietario.

**Criterio de salida:** el propietario revisó capturas de los prototipos y del sitio, y las pruebas de contraste y de estados pasan. Se cumplió el 2026-10-25: el propietario decidió que sus aprobaciones ya registradas cuentan como esa revisión ([plan V1](../plan/linea-visual-v1.md) §7). La app real de Windows sigue en la Fase 7.

## Fase 1 — Fundación de datos (completada)

**Estado:** `done` desde el 2026-10-29. El alcance y la aceptación están en el [plan ejecutable de Fase 1](../plan/fase-1-fundacion-de-datos.md).

**Objetivo:** demostrar que un flujo de datos de Deriv puede capturarse, validarse, almacenarse y reproducirse.

**Incrementos:**

1. toolchain, contratos runtime, vectores y guardia documental;
2. normalización y reglas de calidad puras;
3. almacenamiento crudo/versionado, publicación y replay;
4. catálogo y conector público de Deriv;
5. reconexión, recuperación y reporte de salud estructurado.

**Criterio de salida:** un lote se reconstruye desde `dataset_id`, y el sistema expone continuidad, retraso, duplicados y datos fuera de orden sin ocultarlos. Se cumplió el 2026-10-29 ([evidencia de la puerta de salida](../operacion/evidencia-puerta-fase-1.md)).

## Fase 1B — Datos de MetaTrader 5

**Objetivo:** capturar precios de Deriv MT5 y Vantage con las mismas garantías que Deriv, sin operar ([ADR-0007](../arquitectura/adr/0007-varias-fuentes-y-metatrader-5.md)). El propietario decidió el 2026-10-29 hacer antes la Fase 2, y la Fase 1B no tiene fecha.

**Incrementos:**

1. equipo de la terminal MT5 y su protección decididos, y revisión de términos de Deriv MT5, Vantage y MetaQuotes, antes de escribir el puente;
2. contrato de los mensajes del puente, cotización con compra y venta, y catálogo por servidor;
3. puente MQL5 de solo datos con contraseña de inversor;
4. adaptador y normalizador MT5, con conversión a UTC comprobada, recuperación de historia de ticks, pruebas offline con fixtures y smoke opt-in.

**Criterio de salida:** un dataset de cada servidor MT5 se reproduce desde su `dataset_id`, sus incidencias siguen visibles tras reiniciar y ninguna contraseña MT5 sale de la terminal.

## Fase 2 — Laboratorio y bot shadow para uso propio

Es la fase actual desde el 2026-10-29. El estado vigente se consulta únicamente en [`PROJECT_STATUS.md`](../../PROJECT_STATUS.md). El alcance y la aceptación están en el [plan ejecutable de Fase 2](../plan/fase-2-laboratorio-y-bot-shadow.md). Antes de estos incrementos, el plan lleva el sistema de datos a un servidor; antes del backtest, publica datasets de la captura viva.

**Objetivo:** transformar una hipótesis en una estrategia viva, explicable y no ejecutora.

**Incrementos:**

1. autenticación de usuarios de buoh y espacios personales;
2. creación, versión y revisión de hipótesis/estrategias;
3. gráficos de datos y exploración de calidad;
4. motor de *backtest* con reglas declarativas limitadas;
5. evaluación entrenamiento/validación/fuera de muestra;
6. motor de señales `shadow`, libro de posiciones hipotéticas y comparación contra expectativa;
7. registro de señal con vencimiento, evidencia y estado de calidad.

**Criterio de salida:** una estrategia *shadow* puede reproducir cada decisión desde datos/versiones fijados y detenerse automáticamente ante degradación de datos.

## Fase 3 — Producto de señales web y móvil

**Objetivo:** distribuir y operar señales auditables para uso propio, preparando el mismo contrato para suscriptores futuros.

**Incrementos:**

1. panel web de desempeño, estrategias, evidencia y estado de bot;
2. app React Native Android/iOS para alertas, favoritos, estado y lectura de evidencia;
3. permisos y preferencias de notificación;
4. modo de ejecución inconfundible: `shadow`, `demo` o `real`, y estado operativo separado (`healthy`, `degraded`, `paused`);
5. límites de frecuencia, historial, vencimiento y trazabilidad de cada señal;
6. contenido de riesgo y métricas contextualizadas.

**Criterio de salida:** un usuario puede identificar el origen, modo, limitaciones y vencimiento de toda señal; ninguna vista sugiere una ganancia garantizada.

## Fase 3B — Beta de suscriptores externos y señales pagas

**Objetivo:** convertir las señales en un producto comercial controlado sin alterar el motor de evidencia ni la frontera de ejecución.

**Incrementos:**

1. cuentas, derechos de acceso y niveles de suscripción auditables;
2. historial de entrega y modo de cada señal visible para el suscriptor;
3. desempeño contextualizado por estrategia y estado operativo;
4. restricciones por mercado, instrumento y perfil permitido;
5. flujos de soporte, términos y revisión de cumplimiento aplicables;
6. integración de cobro solo después de definir entidad, jurisdicción y proveedor adecuado.

**Criterio de salida:** buoh puede ofrecer señales pagas dentro del alcance aprobado. Las señales en modo `real` son un objetivo explícito cuando la estrategia correspondiente alcance elegibilidad; no quedan bloqueadas por la arquitectura.

## Fase 4 — Integración de ejecución demo

**Objetivo:** demostrar que el sistema puede enviar y reconciliar operaciones en entorno demo sin depender de una interfaz cliente.

**Incrementos:**

1. OAuth con PKCE y almacenamiento cifrado de autorizaciones demo;
2. adaptador Deriv y pasarela de ejecución aislada;
3. `ExecutionIntent`, idempotencia, auditoría y correlación con señales;
4. políticas de riesgo por estrategia, usuario, instrumento y entorno;
5. reconciliación de órdenes/posiciones y pruebas de desconexión, retraso y respuestas ambiguas;
6. *kill switch* global, por estrategia y por usuario, probado de forma periódica;
7. ejecución demo en MT5 por el puente, con su propia ADR y una política de riesgo para CFD.

**Criterio de salida:** toda orden demo puede explicarse, encontrarse en la auditoría y reconciliarse; un fallo de red no genera una duplicación silenciosa.

## Fase 5 — Evaluación para ejecución real

**Objetivo:** decidir, con evidencia, si una estrategia y el servicio están aptos para un piloto real limitado.

**Precondiciones:** estabilidad *shadow* y demo, protocolo estadístico superado, observabilidad operativa, revisión de amenazas (que define, entre otras cosas, qué cuenta como reautenticación en un teléfono), modelo de soporte, jurisdicción y modelo comercial definidos, y análisis de cumplimiento aplicable concluido.

**Criterio de salida:** aprobación explícita o rechazo documentado para un universo acotado. El rechazo es un resultado correcto si la evidencia, regulación o fiabilidad no bastan; no elimina la meta comercial de dinero real.

## Fase 6 — Ejecución real controlada

**Objetivo:** operar únicamente el universo, las cuentas y las estrategias aprobadas, bajo límites conservadores configurados y reversibles.

**Incrementos:** despliegue separado, permisos mínimos, autorizaciones revocables, límites de riesgo, monitoreo 24/7 proporcional, alertas de reconciliación, respuesta a incidentes, informes de desempeño real y revisión periódica de elegibilidad.

**Criterio de salida para ampliar alcance:** evidencia real suficiente, resultados netos contextualizados, cero defectos críticos no resueltos, controles de riesgo eficaces y aprobación renovada de cumplimiento/operación.

## Fase 7 — Clientes complementarios

**iOS:** se desarrolla en paralelo a la fase 3 como aplicación React Native normal; usa notificaciones, widgets o Live Activities cuando sean apropiados. No depende de un overlay global.

**Android overlay (opcional):** una capa de consulta pasiva puede evaluarse después de la fase 3; jamás dispara ni confirma operaciones.

**Windows:** cliente Tauri 2 posterior cuando el núcleo web/móvil y contratos compartidos estén maduros.

## Fuera de alcance permanente salvo nueva decisión formal

- Garantías de rentabilidad, manipulación de usuarios o marketing engañoso.
- Custodia, depósitos, retiros o administración de fondos de clientes.
- Contraseñas de Deriv o de terceros, secretos en clientes u órdenes directas desde UI. Las cuentas MT5 propias siguen la excepción acotada de ADR-0007.
- Lectura/captura de pantalla, OCR, automatización de otras aplicaciones o uso abusivo de accesibilidad.
- Ejecución en países, instrumentos, cuentas o tipos de contrato no aprobados.
