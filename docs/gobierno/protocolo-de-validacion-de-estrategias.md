# Protocolo de validación de estrategias

## Propósito

Definir el procedimiento mínimo para decidir si una estrategia puede pasar de idea a `shadow`, `demo` o `real`. El protocolo busca reducir sobreajuste y fallos de operación; no garantiza rentabilidad.

## 1. Registro previo

Antes de ejecutar la prueba final, registrar:

- hipótesis falsable y mecanismo esperado;
- estrategia, versión y propietario;
- universo, fuente, `dataset_id`, período y zona horaria;
- reglas completas de entrada, salida e invalidez;
- parámetros y rangos permitidos;
- costes, latencia, *slippage* u omisiones declaradas;
- métrica principal, métricas auxiliares y línea base;
- criterio de promoción, criterio de pausa y criterio de retiro.

Modificar cualquiera de estos elementos después de ver resultados crea una nueva versión de estrategia.

Para una candidata del motor de investigación, la API compone el registro previo al congelarla, con lo que ya tiene registrado de su búsqueda ([ADR-0025](../arquitectura/adr/0025-protocolo-estadistico.md) §5). Su hipótesis falsable es la predicción fuera de muestra registrada: que su resultado por operación es positivo, con la significación de ADR-0025 §7. Su mecanismo es el patrón del estudio que usa su regla, o «no identificado», y el informe lo muestra tal cual.

## 2. Separación temporal de datos

1. **Entrenamiento:** explora hipótesis y parámetros.
2. **Validación:** selecciona entre alternativas sin reutilizar la prueba final.
3. **Prueba fuera de muestra:** permanece bloqueada hasta congelar la versión.
4. **Shadow vivo:** registra decisiones y posiciones hipotéticas con datos en vivo.
5. **Demo:** prueba integración, políticas y reconciliación sin dinero real.
6. **Real controlado:** solo tras aprobación explícita de todas las puertas anteriores.

No se permite mezclar períodos ni recalibrar parámetros con datos de prueba fuera de muestra para conservar un resultado atractivo.

## 3. Métricas obligatorias

Todo informe debe incluir, como mínimo:

- número de observaciones y operaciones;
- rendimiento neto bajo costes/supuestos declarados;
- *drawdown* máximo y duración de recuperación cuando aplique;
- exposición, frecuencia y distribución de ganancias/pérdidas;
- tasa de acierto junto a tamaño medio de ganancia/pérdida;
- sensibilidad a parámetros y a ventanas temporales;
- comparación con línea base;
- incidencias de calidad de datos, retrasos y decisiones omitidas;
- diferencias entre expectativa histórica, `shadow`, `demo` y `real`.

Una estrategia con rendimiento positivo sin tamaño de muestra, control de costes, línea base o prueba fuera de muestra se clasifica como **no validada**.

Las reglas medibles, con sus umbrales (la métrica principal, la muestra mínima, las correcciones por búsqueda, la ventana fuera de muestra, el criterio de promoción y la prueba de deriva), están en [ADR-0025](../arquitectura/adr/0025-protocolo-estadistico.md).

## 4. Puertas de promoción

| De | A | Evidencia requerida |
|---|---|---|
| `draft` | `reviewed` | especificación completa, revisión técnica y datos reproducibles |
| `reviewed` | `shadow` | prueba temporal separada, métricas completas y estrategia congelada |
| `shadow` | `demo` | decisiones explicables, calidad de datos aceptable y política de riesgo definida |
| `demo` | `real` | reconciliación estable, idempotencia, *kill switch*, revisión operativa y alcance aprobado |
| `real` | ampliación | resultados contextualizados, control eficaz y aprobación renovada |

Una puerta puede rechazar una estrategia sin que ello sea un fallo del proyecto. El rechazo y su evidencia se conservan.

Para una candidata del motor de investigación, la revisión técnica de `draft` a `reviewed` la hace la API sola: comprueba la definición, el registro previo y que su réplica da lo mismo que la repetición del VPS ([ADR-0025](../arquitectura/adr/0025-protocolo-estadistico.md) §6). La puerta `reviewed` a `shadow` la decide siempre el propietario, con el informe de evidencia.

## 5. Revisión y retiro

La estrategia se pausa o retira si ocurre una condición de corte definida, degradación de datos, cambio de mercado/proveedor, fallo de reconciliación, modificación no versionada, límite de riesgo superado o deriva material contra su evidencia.

La reactivación exige análisis documentado, nueva evidencia y una decisión auditada. Nunca se reactiva automáticamente una estrategia pausada por incidente.

En `shadow`, una detención por datos degradados (la salud distinta de `healthy`, una condición `connection_lost` o `event_gap_unresolved` abierta, la continuidad pendiente, los datos más viejos que el máximo de la estrategia o el atraso del motor) se levanta sola cuando los datos vuelven a cumplir la política de datos de la estrategia, sea cual sea su duración, como decidió el propietario el 2026-11-16. Las demás pausas, también la de un incidente de integridad, la de un perfil o un esquema distinto del registrado, la caída máxima, la deriva y la del propietario, siguen la regla anterior: el propietario las reanuda desde Laboratorio con un motivo escrito y después de ver el informe de la detención, y nunca vuelven solas. En `demo` y `real` lo decide su política de riesgo ([ADR-0026](../arquitectura/adr/0026-motor-de-senales-shadow.md) §5).
