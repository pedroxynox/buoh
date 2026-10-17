# Operación y control de riesgo de buoh

## Alcance de este documento

Este documento define barreras técnicas y operativas para un bot de señales y ejecución. No prescribe una estrategia de inversión, límites financieros concretos ni asesoría legal. Los valores de riesgo se decidirán por entorno, instrumento, jurisdicción y usuario autorizado; no se codificarán como supuestos permanentes.

## 1. Objetivo operativo

Una estrategia puede generar una señal. Solo una intención validada por autorización y política puede intentar una operación. Todo intento debe terminar en un estado verificable: `rejected`, `submitted`, `acknowledged`, `reconciled`, `failed` o `manual-review`.

La prioridad de buoh es la siguiente:

```text
seguridad de usuarios y controles
  > integridad de órdenes y posiciones
  > continuidad y latencia
  > crecimiento de señales o volumen
```

## 2. Entornos incompatibles

| Entorno | Propósito | Puede hablar con Deriv autenticado | Puede afectar dinero real |
|---|---|---:|---:|
| `research` | análisis histórico | no | no |
| `shadow` | evaluación con datos vivos y posiciones hipotéticas | no | no |
| `demo` | prueba integral de ejecución | sí, cuenta demo | no |
| `real` | ejecución limitada aprobada | sí, cuenta real autorizada | sí |

Los datos, permisos, claves de configuración, bases y colas de cada entorno están separados. Una estrategia, señal, autorización y política declaran su entorno; una mezcla de entornos es un error bloqueante.

## 3. Objetos de dominio que no se confunden

- **Estrategia:** reglas versionadas que transforman datos en una decisión declarativa.
- **Señal:** evento explicable y vencible producido por una estrategia.
- **Política de riesgo:** versión de límites y condiciones permitidas.
- **Intención de ejecución:** solicitud interna correlacionada con señal, estrategia, política y autorización.
- **Orden/contrato externo:** resultado enviado o reconocido por Deriv.
- **Posición/resultado:** estado externo reconciliado, nunca inferido únicamente desde el intento local.

## 4. Política de riesgo mínima

Toda política configura, al menos:

- instrumentos y tipos de contrato permitidos;
- entorno permitido (`demo` o `real`);
- estrategia y versiones aptas;
- autorización requerida y vigencia;
- máximo por acción, exposición concurrente y frecuencia;
- límites por ventana de tiempo y condiciones de pausa;
- antigüedad máxima de señal y datos;
- horarios, calidad de datos y estado de conectividad requeridos;
- reglas de cierre/corte y propietario responsable;
- condiciones que activan revisión manual.

El motor de política es puro, determinista, versionado y produce una razón estructurada para aceptar o rechazar. No depende de la interfaz ni del adaptador de bróker.

## 5. Flujo de una operación

```text
Datos validados
  → estrategia apta
  → SignalEvent con evidencia
  → autorización + política de riesgo
  → ExecutionIntent idempotente persistido
  → validación de precondiciones
  → envío por execution-gateway
  → respuesta de Deriv
  → reconciliación de estado externo
  → auditoría, métrica y alerta
```

Antes de enviar, `execution-gateway` verifica que no haya corte global/por estrategia/por usuario, que la autorización esté vigente, que la señal no esté vencida, que los datos estén sanos y que la intención no sea duplicada.

Después de enviar, no se asume éxito por un error de red o un tiempo de espera. Se consulta el estado externo y se reconcilia antes de reintentar. Las transiciones de estado son anexas e inmutables.

## 6. Interruptores de emergencia y degradación segura

Debe existir un *kill switch* con tres ámbitos: global, por estrategia y por usuario. Su activación:

- detiene nuevas intenciones antes de llegar al adaptador;
- conserva el historial y expone el motivo;
- alerta a operaciones y a los usuarios afectados cuando corresponda;
- exige una acción autenticada y auditada para reactivarse;
- no intenta cerrar ni modificar posiciones automáticamente fuera de una política explícitamente aprobada.

El sistema se pausa por defecto ante datos degradados, reloj inconsistente, errores consecutivos de proveedor, pérdida de reconciliación, cambio no autorizado de versión, secretos revocados o discrepancia material de estado.

## 7. Seguridad de cuenta y autorizaciones

- OAuth con PKCE y permisos mínimos; no se reciben contraseñas.
- Intercambio de código exclusivamente desde el backend.
- Tokens cifrados en reposo, con acceso limitado al servicio que los necesita.
- Revocación de cuenta, cambio de política y activación real requieren reautenticación y auditoría.
- Las autorizaciones son explícitas, con alcance, entorno, vencimiento y estado revocable.
- Un cliente web o móvil nunca recibe un secreto con capacidad directa de ejecución.

## 8. Reconciliación, observabilidad e incidentes

Los paneles operativos deben mostrar, por entorno: frescura de datos, latencia, señales emitidas, intenciones rechazadas, estados sin reconciliar, fallos de proveedor, activaciones de *kill switch* y versión de estrategia/política activa.

Todo incidente genera un registro con línea de tiempo, alcance, estrategia, entorno, cuentas afectadas, decisión de pausa, evidencia y resolución. La reapertura exige confirmar datos y reconciliación.

Antes de dinero real se practicarán escenarios de: pérdida de WebSocket, respuesta ambigua, orden duplicada, datos fuera de orden, token revocado, despliegue fallido, regla de riesgo rota y activación del *kill switch*.

## 9. Puerta de promoción a dinero real

Un piloto real limitado requiere evidencia acumulada de:

1. resultados fuera de muestra y *shadow* interpretables según el protocolo estadístico;
2. ejecución demo reconciliada y resistente a fallos relevantes;
3. estrategia, política y autorización versionadas y aprobadas;
4. controles de límites e interrupción probados;
5. monitorización, alertas y responsable operativo definidos;
6. modelo comercial, jurisdicción y revisión de cumplimiento resueltos;
7. lista cerrada de instrumentos, tipos de contrato, cuentas y usuarios permitidos.

No se promueve por una cifra aislada de rendimiento ni por presión de calendario.
