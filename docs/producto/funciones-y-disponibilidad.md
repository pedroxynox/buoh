# Funciones de buoh y su disponibilidad

Catálogo de todo lo que buoh hará, en qué fase se habilita y en qué plataforma estará (`V1-FUNC-001`). Las fases son las del [roadmap](roadmap.md); el estado vigente está en [`PROJECT_STATUS.md`](../../PROJECT_STATUS.md). Una función solo existe cuando su fase se completa: este catálogo describe el destino, no lo que ya funciona.

## 1. Plataformas

| Plataforma | Papel | Fase |
|---|---|---|
| **Web** | Estación principal: investigación, señales, auditoría y configuración | Fase 2; prototipo visual en V1.2 |
| **Móvil** (Android e iOS) | Seguir el bot: estado, señales, alertas, evidencia y autorizaciones seguras | Fase 3; prototipo visual en V1.4 |
| **Escritorio** (Windows, Tauri 2) | La misma estación de la web, como aplicación instalada | Fase 7; prototipo visual en V1.5 |
| **Sitio oficial** | Explicar qué es buoh, cómo trabaja y en qué estado está | V1.3 |

Ninguna plataforma envía órdenes al bróker. Las órdenes solo salen de `execution-gateway` en el servidor, después de comprobar su política de riesgo ([ADR-0002](../arquitectura/adr/0002-senales-y-ejecucion-controlada.md)). Los clientes pueden **ver**, **pedir** y **detener**; nunca **operan** por su cuenta: no envían órdenes ni abren operaciones a mano. **Pedir** significa enviar al servidor una solicitud que este valida y registra, como aprobar una versión de estrategia, cambiar una política, autorizar un modo o volver a encender una estrategia detenida; nunca es una orden.

Desde el móvil se pueden encender y apagar las estrategias del bot, también con dinero real, como con un control remoto: pedir que una estrategia aprobada pase a `real`, detenerla y volver a encenderla (decisión del propietario, 2026-10-25). Es lo que el propietario llama «operar desde el celular». Quien opera es el bot, a través de `execution-gateway`; el móvil, igual que la web y el escritorio, no abre operaciones a mano.

Una función está disponible cuando se cumplen a la vez su fase y la de su plataforma: web desde Fase 2, móvil desde Fase 3 y escritorio desde Fase 7.

## 2. Funciones

Leyenda: ● disponible · ◐ solo lectura o resumen · — no disponible.

### Datos y mercados

| Función | Qué hace | Fase | Web | Móvil | Escritorio |
|---|---|---|:-:|:-:|:-:|
| Catálogo de instrumentos | Lista oficial de símbolos por fuente, con versión y fecha | 1 (datos), 2 (pantalla) | ● | ◐ | ● |
| Fuentes MT5 | Deriv MT5 y Vantage como fuentes separadas | 1B | ● | ◐ | ● |
| Calidad de datos | Huecos, retrasos, duplicados y datos fuera de orden, sin ocultarlos | 1 (datos), 2 (pantalla) | ● | ◐ | ● |
| Salud del servicio | Estado `starting`, `healthy`, `degraded`, `recovering`, `paused` o `failed` | 1 (CLI), 2 (pantalla) | ● | ● | ● |
| Datasets reproducibles | Lotes publicados con su identificador y verificación | 1 (CLI), 2 (pantalla) | ● | — | ● |
| Gráficos de precios | Ticks y velas, con huecos marcados | 2 | ● | ◐ | ● |

### Investigación (laboratorio)

| Función | Qué hace | Fase | Web | Móvil | Escritorio |
|---|---|---|:-:|:-:|:-:|
| Cuenta de buoh | Acceso y espacio personal | 2 | ● | ● | ● |
| Hipótesis y estrategias | Ideas y reglas versionadas; un cambio crea otra versión | 2 | ● | ◐ | ● |
| Backtest | Prueba sobre datos pasados con costes, latencia y supuestos declarados | 2 | ● | ◐ | ● |
| Validación fuera de muestra | Separación entrenamiento, validación y prueba | 2 | ● | ◐ | ● |
| Informe de evidencia | Muestra, costes, pérdidas, *drawdown*, versión y limitaciones | 2 | ● | ◐ | ● |

### Señales

| Función | Qué hace | Fase | Web | Móvil | Escritorio |
|---|---|---|:-:|:-:|:-:|
| Bot `shadow` | Señales y posiciones hipotéticas con datos vivos, sin órdenes | 2 | ● | ◐ | ● |
| Registro de señales | Cada señal con estrategia, versión, modo, vencimiento, calidad y evidencia | 2 | ● | ● | ● |
| Alertas | Avisos de señales y de salud, sin urgencia artificial | 3 | ● | ● | ● |
| Desempeño contextualizado | Resultados por estrategia y modo, con su contexto completo | 3 | ● | ◐ | ● |
| Suscriptores y señales pagas | Accesos, historial de entrega y restricciones por mercado | 3B | ● | ● | ● |

### Ejecución

| Función | Qué hace | Fase | Web | Móvil | Escritorio |
|---|---|---|:-:|:-:|:-:|
| Conexión de cuenta Deriv | Autorización OAuth en modo `demo` | 4 | ● | ● | ● |
| Puente MT5 | Datos desde la terminal MT5 (1B); operaciones `demo` aprobadas (4) | 1B / 4 | ◐ | ◐ | ◐ |
| Políticas de riesgo | Límites por estrategia, instrumento, cuenta y entorno | 4 | ● | ◐ | ● |
| Intenciones y órdenes `demo` | Ver lo que la pasarela pidió, lo que respondió el bróker y la reconciliación | 4 | ◐ | ◐ | ◐ |
| *Kill switch* | Detener todo, una estrategia o un usuario | 4 | ● | ● | ● |
| Volver a encender | Reactivar una estrategia que se detuvo; el servidor lo valida | 4 | ● | ● | ● |
| Ejecución `real` | Ver órdenes y posiciones del universo, cuentas y estrategias aprobados en la Fase 5 | 6 | ◐ | ◐ | ◐ |
| Pedir el modo `real` | Solicitar que una estrategia aprobada pase a `real`; el servidor lo valida | 6 | ● | ● | ● |

Detener (*kill switch*) está disponible en todas las plataformas porque reduce el riesgo. Pedir el modo `real` o cambiar una política de riesgo exige reautenticación y queda en auditoría. Volver a encender una estrategia es una petición autenticada y auditada, y en `real` también exige reautenticación ([operación y control de riesgo](../gobierno/operacion-y-control-de-riesgo.md) §6 y §7). Si la estrategia se pausó por una de las causas del [protocolo de validación](../gobierno/protocolo-de-validacion-de-estrategias.md) §5, el servidor además exige el análisis documentado, la nueva evidencia y la decisión auditada; si fue por un incidente, también que se hayan confirmado los datos y la reconciliación (operación y control de riesgo §8). Si falta algo, rechaza la petición. Pedir el modo `real` y volver a encender una estrategia se pueden desde las tres plataformas, por decisión del propietario (2026-10-25); en todas, el servidor solo acepta que una estrategia funcione en `real` si la estrategia, la cuenta y los instrumentos están entre los aprobados en la Fase 5. Cambiar una política se hace desde web o escritorio.

Qué cuenta como reautenticación en un teléfono todavía no está definido: lo decide la revisión de amenazas de la Fase 5 ([roadmap](roadmap.md)).

### Operación y cuenta

| Función | Qué hace | Fase | Web | Móvil | Escritorio |
|---|---|---|:-:|:-:|:-:|
| Auditoría | Registro inmutable de datos, estrategias, señales y órdenes | 2 (datos y estrategias), 4 (órdenes) | ● | ◐ | ● |
| Conexiones | Estado de fuentes, del puente MT5 y de las autorizaciones | 1B / 4 | ● | ◐ | ● |
| Preferencias | Tema noche o día, idioma, notificaciones | 2; notificaciones, 3 | ● | ● | ● |
| Capa Android pasiva (opcional) | Consulta flotante sin controles | 7 | — | ◐ | — |

## 3. Disponibilidad por modo de ejecución

| Modo | Qué permite | Dinero | Se habilita |
|---|---|---|---|
| `disabled` | Ver datos y estrategias; ninguna señal se convierte en intención | ninguno | siempre |
| `shadow` | Señales y posiciones hipotéticas; nada sale al bróker | ninguno | Fase 2 |
| `demo` | Órdenes en cuenta de práctica, con reconciliación | de práctica | Fase 4 |
| `real` | Órdenes en cuentas aprobadas, bajo límites | real | Fase 6 |

El modo y la salud del servicio se muestran siempre, por separado y con texto ([guía de marca](../diseno/marca-buoh.md) §5).

## 4. Lo que buoh no tendrá

- Promesas de ganancia, rankings de «mejores señales» o contadores de urgencia.
- Depósitos, retiros o custodia de dinero.
- Contraseñas de terceros. Las cuentas MT5 propias siguen la excepción de [ADR-0007](../arquitectura/adr/0007-varias-fuentes-y-metatrader-5.md).
- Órdenes enviadas u operaciones abiertas a mano desde una pantalla, un móvil o una capa flotante.
- Lectura de pantalla, OCR o automatización de otras aplicaciones.
