# Runbook: ingesta y calidad de datos de mercado

## Alcance

Este runbook cubre el futuro `market-data-worker` de buoh durante Fase 1 y Fase 2. El servicio recibe datos públicos de Deriv, los valida, conserva el evento crudo y publica derivados solo después de registrar su calidad.

No cubre ejecución de órdenes ni credenciales de trading.

## Estados de salud

| Estado | Significado | Acción automática |
|---|---|---|
| `healthy` | flujo continuo dentro de tolerancia | continuar |
| `degraded` | hueco, retraso, duplicado anómalo o reconexiones repetidas | marcar datos y detener señales dependientes si aplica |
| `paused` | pérdida de integridad, almacenamiento no disponible o configuración inválida | no publicar derivados ni señales |
| `recovering` | reconexión y verificación en curso | registrar, recuperar y reconciliar antes de volver a `healthy` |

Los umbrales concretos se configurarán por fuente e instrumento; no se codifican como valores universales.

## Principios operativos

- Conservar primero el evento crudo y sus metadatos; no corregir ni descartar silenciosamente.
- Mantener marca de tiempo de fuente y de recepción separadas.
- Usar reconexión con espera progresiva y aleatorización para evitar reintentos simultáneos.
- Verificar continuidad tras cada reconexión mediante rango, secuencia o consulta histórica disponible.
- Publicar banderas de calidad junto a los datos derivados.
- Tratar una desconexión o despliegue como situación normal recuperable, nunca como ausencia de datos.

## Procedimientos de incidente

### Desconexión de WebSocket o proveedor

1. Registrar causa, instancia, símbolo y último evento confirmado.
2. Cambiar a `recovering`; impedir que datos incompletos alimenten señales elegibles.
3. Reconectar con espera progresiva.
4. Recuperar el intervalo faltante si la fuente lo permite.
5. Persistir huecos o imposibilidad de recuperación como incidencia.
6. Reanudar `healthy` solo tras validar continuidad y frescura.

### Datos duplicados, fuera de orden o con formato inválido

1. Conservar el evento crudo con bandera de calidad.
2. No usarlo para construir derivados hasta aplicar la regla de normalización versionada.
3. Incrementar métrica de incidencia y evaluar transición a `degraded`.
4. Abrir investigación si supera el umbral configurado o cambia el formato de fuente.

### Almacenamiento no disponible

1. Cambiar inmediatamente a `paused` antes de perder trazabilidad.
2. No emitir señales ni posiciones hipotéticas basadas en eventos no persistidos.
3. Alertar al operador y comprobar base de datos, object storage y cola.
4. Recuperar desde el último punto confirmado; documentar cualquier hueco.

### Despliegue o reinicio programado

1. Marcar la instancia como no apta para aceptar nueva partición de símbolos.
2. Drenar/confirmar eventos en curso y persistir el cursor operativo.
3. Reiniciar y comprobar versión de esquema/configuración.
4. Verificar continuidad y estado de salud antes de reactivar derivados.

## Evidencia mínima de cada incidente

Guardar identificación, periodo UTC, símbolos, versión del worker, causa observada, último evento confirmado, datos afectados, transición de estado, acción de recuperación, resultado y responsable de cierre.

## Puerta de salida de Fase 1

La ingesta se considera apta cuando puede reiniciarse y reconectarse sin ocultar huecos, cada lote es reconstruible desde sus metadatos y el panel expone salud/frescura/incidencias de forma comprensible.
