---
schema_version: "1.0.0"
status_version: 120
updated_at_utc: "2026-11-27T03:30:00.000Z"
current_phase: "Fase 2 — Laboratorio y bot shadow para uso propio"
phase_status: "active"
active_work: null
next_delivery: "F2.5b"
next_requirements: ["F2-MARKET-001"]
plan: "docs/plan/fase-2-laboratorio-y-bot-shadow.md"
parallel_plans: []
---

# Estado actual de buoh

Este archivo describe únicamente el estado vigente. No es un diario: Git y los pull requests conservan el historial. Su contenido entra en vigor al fusionarse el cambio que lo modifica. Las decisiones que siguen en vigor, técnicas y del propietario, están en las [decisiones vigentes](docs/gobierno/decisiones-vigentes.md), y lo que este archivo contaba de cada entrega hasta el 2026-11-17, en el [historial de entregas](docs/plan/historial-de-entregas.md).

## Objetivo actual

Transformar una hipótesis en una estrategia viva, explicable y no ejecutora, para uso propio ([roadmap](docs/producto/roadmap.md), Fase 2). La fase termina cuando una estrategia *shadow* puede reproducir cada decisión desde datos y versiones fijados y detenerse sola ante una degradación de los datos. Su alcance, su aceptación y su secuencia, de F2.1 a F2.11, con F2.5b y F2.6b, están en el [plan de Fase 2](docs/plan/fase-2-laboratorio-y-bot-shadow.md).

## Situación

- La Fase 1 terminó el 2026-10-29 y cumplió su puerta de salida ([evidencia de la puerta de salida](docs/operacion/evidencia-puerta-fase-1.md)). Ese día el propietario decidió hacer antes la Fase 2 que la Fase 1B, la de los datos de MetaTrader 5 ([decisiones vigentes](docs/gobierno/decisiones-vigentes.md), «Orden de fases»).
- El [plan de Fase 2](docs/plan/fase-2-laboratorio-y-bot-shadow.md) fija sus requisitos `F2-*`, el corte de implementación, las ADR, la secuencia y el presupuesto. El 2026-11-16 el propietario cambió su alcance: las estrategias las busca un motor de investigación en Python y en un VPS propio, y él autoriza las que pasan al bot; entran el oro en vivo y siete mercados reales en velas (F2.5b) y el motor (F2.6b) (plan §1 y §12; decisiones vigentes, «Motor de investigación»).
- Producción corre desde el 2026-11-01 en la región `virginia` de Render, con los objetos en Cloudflare R2 ([ADR-0018](docs/arquitectura/adr/0018-sistema-de-datos-en-produccion.md)): `buoh-ingesta` captura R_100 y, desde el PR 3 de [ADR-0021](docs/arquitectura/adr/0021-mercados-reales-y-fuentes-de-investigacion.md), el oro; `buoh-operaciones` corre cada 5 minutos; y `buoh-postgres` tiene 5 GB de disco. Desde el 2026-11-03, `buoh-api` sirve la API y la web en `https://buoh-api.onrender.com` ([ADR-0019](docs/arquitectura/adr/0019-api-cuentas-y-auditoria.md)). Cuesta unos 26 USD al mes más lo que suma el oro (ADR-0018 §14, ADR-0019 §10 y ADR-0021 §6), y el total aprobado para la Fase 2 es de unos 58,50 USD al mes (decisiones vigentes, «Servidor del motor de señales *shadow*» y «Lecturas de R2 del motor *shadow*»).
- El sitio oficial está en internet desde el 2026-10-27, como sitio estático gratuito de Render, en `https://buoh-sitio.onrender.com` y sin indexar ni anunciar ([ADR-0013](docs/arquitectura/adr/0013-publicacion-del-sitio-en-render.md)).
- No existe estrategia, señal, conexión de cuenta ni ejecución `demo` o `real`. MetaTrader 5 (Deriv MT5 y Vantage) queda decidido como segunda integración ([ADR-0007](docs/arquitectura/adr/0007-varias-fuentes-y-metatrader-5.md)), sin código.
- La línea visual V1 terminó el 2026-10-25: la guía de marca, `packages/design-system`, los prototipos web, móvil y de escritorio y el sitio oficial ([ADR-0008](docs/arquitectura/adr/0008-linea-visual-marca-y-clientes-web.md) a [ADR-0011](docs/arquitectura/adr/0011-identidad-desde-el-logo-del-propietario.md)).
- La fundación de producto, arquitectura, seguridad y operación está aprobada.

### Entregas de la Fase 2

| Entrega | Estado | Evidencia |
|---|---|---|
| F2.1 Punto de control | Hecha | «Evidencia de F2.1» del [historial de entregas](docs/plan/historial-de-entregas.md) y [evidencia de memoria de F2.1](docs/operacion/evidencia-memoria-f2-1.md) |
| F2.2 Sistema de datos en producción | Hecha, con el PR 9 de ADR-0018 | [Evidencia de producción de F2.2](docs/operacion/evidencia-produccion-f2-2.md) |
| F2.3 API, cuentas y auditoría | Hecha, con el PR 7c de ADR-0019 | [Evidencia de F2.3](docs/operacion/evidencia-api-f2-3.md) |
| F2.4 Datos reales en pantalla | Hecha, con el 7b | [Evidencia de F2.4](docs/operacion/evidencia-datos-f2-4.md) |
| F2.5 Datasets vivos | Hecha, con el PR 6 de ADR-0020 | [Evidencia de los datasets vivos](docs/operacion/evidencia-datasets-f2-5.md) |
| F2.5b Mercados reales | En curso: hechos los PR 2 a 5 de [ADR-0021](docs/arquitectura/adr/0021-mercados-reales-y-fuentes-de-investigacion.md), el 5 en seis partes, del 5a al 5f. Siguen las comprobaciones del 5f en producción y los PR 6 a 8 (ADR-0021 §9; «Siguiente tarea autorizada») | [Evidencia del PR 2d](docs/operacion/evidencia-memoria-f2-5b.md) |
| F2.6, F2.6b y F2.7 a F2.10 | Sin empezar: las cinco ADR del laboratorio, de ADR-0022 a ADR-0026, están fusionadas | — |
| F2.11 Puerta de salida | Sin empezar | — |

Quedan abiertos de las entregas hechas:

- mostrar una por una las incidencias de cada dataset: Datos las cuenta por tipo y gravedad, y ninguna pantalla las lista todavía, tampoco la Auditoría ([concepto de interfaz](docs/diseno/concepto-de-interfaz.md) §14);
- la primera rotación de la credencial dueña de PostgreSQL, que el propietario aplazó el 2026-11-17 y es una precondición de la Fase 3B del roadmap (decisiones vigentes, «Rotación de la credencial dueña de PostgreSQL»);
- los pendientes técnicos registrados de la Fase 1, en la [especificación de pendientes](docs/plan/especificacion-de-pendientes.md) (P-F1-07).

## Trabajo en paralelo autorizado

Ningún plan en paralelo (`parallel_plans`). La línea visual V1 terminó el 2026-10-25 (plan V1, §7). Sus piezas siguen en el repositorio; los directorios y dependencias nuevos necesitan un plan activo (AGENTS.md, «Desarrollo por fases»).

Cerrar V1, con su prototipo de escritorio, no autoriza la app real de Windows: la decisión 6 de ADR-0001 la deja para cuando esté validado el núcleo web y móvil, y el roadmap la sitúa en la Fase 7. La prioridad del propietario del 2026-10-26 por una app de escritorio con datos reales ([decisiones vigentes](docs/gobierno/decisiones-vigentes.md), «Prioridad del propietario») necesita antes su plan, y entonces se revisará esa decisión de ADR-0001.

## Siguiente tarea autorizada

**Próximos pasos, en orden** (desde el 2026-11-26: plan de Fase 2, §9; [decisiones vigentes](docs/gobierno/decisiones-vigentes.md), «Orden del código desde el 2026-11-26»). El detalle de cada incremento está en su ADR.

1. **2026-12-02 a las 00:00:03 UTC:** vence el log 1, y el agente comprueba su borrado (runbook de ingesta, «Operaciones (`buoh-operaciones`)», «El primer borrado»). Vuelve a contar los objetos de `logs/000002/`, que tienen que ser los 317 068 de la [evidencia de producción de F2.2](docs/operacion/evidencia-produccion-f2-2.md). Ese día, el agente le pide además al propietario el uso de `buoh-operaciones` en la facturación de Render, para saber si el cron job pasa del mínimo de 1 USD al mes con lo que suman los datasets vivos ([evidencia de los datasets vivos](docs/operacion/evidencia-datasets-f2-5.md), «El costo»).
2. **Los lotes en producción** (PR 5f de [ADR-0021](docs/arquitectura/adr/0021-mercados-reales-y-fuentes-de-investigacion.md) §9): tras su despliegue, el agente hace las comprobaciones del runbook de ingesta («Los lotes (PR 5f de ADR-0021)»), empezando por que la primera ejecución de `buoh-operaciones` no da `ConfigError`. Mira además, en los informes del paso 6, cuánto tarda la publicación de un dataset de los lotes (`duration_ms`), que el 5d2 estimó con la de un dataset vivo; si el paso `batch` sigue empezando antes de los 150 s (ADR-0021 §9, precisión del PR 5d2); y el tamaño de las respuestas de `GET /api/v2/datos/datasets` y `GET /api/v2/datos/eventos` con los datasets de los lotes (ADR-0019 §8). Lo registra en el PR siguiente.
3. **El PR 6 de ADR-0021**, la descarga de la historia.
4. **Mientras la historia se descarga y se publica:** los PR 2 y 3 de [ADR-0022](docs/arquitectura/adr/0022-modelo-de-estrategia.md), los PR 2 a 4 de [ADR-0024](docs/arquitectura/adr/0024-semantica-del-backtest.md) y los PR 2 a 4 de [ADR-0023](docs/arquitectura/adr/0023-motor-de-investigacion.md). Dónde van los PR 4 y 5 de ADR-0022 lo dice el plan (§9).
5. **El PR 7 de ADR-0021**, los umbrales y la publicación del oro, en su fecha, sin esperar a los pasos 2 a 4 (ADR-0021 §2): fija los umbrales desde el 2026-12-02 a las 05:09:43.577 UTC, a los 7 días del primer tick del oro, y tiene que estar en producción antes del 2026-12-23, 7 días antes de que venza, hacia el 2026-12-30, el primer log del oro, que se corta el lunes 2026-11-30 (runbook de ingesta, «El oro (PR 3 de ADR-0021)»).
6. **El PR 8 de ADR-0021**, cuando la historia esté publicada, y después el VPS, el PR 5 de ADR-0023.

Cada vez que lee producción, el agente mira también la memoria de `buoh-operaciones` que guarda el paso `memory`, y se la presenta al propietario cuando lo dicen las decisiones vigentes («Memoria medida de `buoh-operaciones`»).

## Bloqueos

Ninguno.

## Decisiones pendientes

- Rotar también la contraseña de `buoh_agente`, que quedó en un registro de Kiro el 2026-11-01. Con ella se leen los logs de la captura y, en las estadísticas de PostgreSQL, cuándo entra y cuándo usa la web el propietario, nunca las filas de `buoh_api` (ADR-0019 §7). El propietario decidió no rotarla el 2026-11-01 y el 2026-11-02 (runbook de ingesta, «Acceso del agente»). El 2026-11-04 el agente le recomendó rotarla junto con la credencial dueña, y el 2026-11-12 se lo volvió a preguntar. Falta su respuesta: tampoco decidió sobre ella el 2026-11-17, cuando aplazó la dueña hasta la beta externa ([decisiones vigentes](docs/gobierno/decisiones-vigentes.md), «Rotación de la credencial dueña de PostgreSQL»). Sin la dueña, se puede rotar sola, el día que él quiera, con una sesión nueva de Kiro para la contraseña nueva, y el agente lo sigue recomendando. Si va con la dueña, el agente le explica antes su orden (runbook de ingesta, «Rotar credenciales»).
- Jurisdicción inicial del producto comercial.
- Universo definitivo de índices y tipos de contrato. Para la Fase 2 está decidido desde el 2026-11-16: R_100 y el oro en vivo, siete mercados en velas, y multiplicadores y sube/baja ([decisiones vigentes](docs/gobierno/decisiones-vigentes.md), «Motor de investigación»). Las exportaciones de velas de MT5 del propietario, que todavía no existen, llegan más adelante con su propio plan.
- Equipo de la terminal MT5 (PC dedicado del propietario o servidor Windows o Linux con Wine) y su protección. Se decide en el primer incremento de Fase 1B (ADR-0007).
- Revisión de términos de Deriv MT5, Vantage y MetaQuotes, y entidad de Vantage aplicable. Se completa en el primer incremento de Fase 1B.
- Dominio propio del sitio oficial y revisión legal de su texto, antes de comprar el dominio, quitar el `noindex` o anunciarlo (ADR-0013).
- Firmar el instalador de escritorio antes de distribuirlo (ADR-0010). El propietario ya lo instaló y probó en su PC el 2026-10-25.
- Probar la app móvil en un teléfono real (Expo Go para el SDK 58 aún no está en las tiendas, o una compilación nativa), y cómo compilarla y distribuirla (ADR-0009).
- Qué cuenta como reautenticación en un teléfono para pedir el modo `real` o volver a encender una estrategia en `real` desde el móvil. Se define en la revisión de amenazas de la Fase 5 (P-V1-05 de la [especificación de pendientes](docs/plan/especificacion-de-pendientes.md)).
- Límites monetarios y política de riesgo para fases `demo` y `real`. La caída máxima del 50 % del capital de cada estrategia vale para el backtest, `shadow` y demo ([decisiones vigentes](docs/gobierno/decisiones-vigentes.md), «Motor de investigación»); el límite para dinero real se decide antes de la Fase 5. También cómo se reanuda en demo y con dinero real una estrategia detenida por datos degradados ([decisiones vigentes](docs/gobierno/decisiones-vigentes.md), «Disco, VPS y reanudación»).
- Proveedor de pagos y modelo de suscripción.

## Evidencia requerida para cambiar de fase

La Fase 2 solo puede marcarse `done` cuando cumple la Definition of Done de su [plan](docs/plan/fase-2-laboratorio-y-bot-shadow.md) (§13), que concreta el criterio de salida del roadmap («Objetivo actual»). La Fase 1 cumplió el suyo el 2026-10-29 («Evidencia de F1.5» del [historial de entregas](docs/plan/historial-de-entregas.md)).

## Mantenimiento obligatorio

Actualizar este archivo en el mismo PR cuando cambie cualquiera de estos elementos:

- fase o estado de fase;
- objetivo o tarea siguiente;
- bloqueo o decisión pendiente;
- componente autorizado para implementarse;
- evidencia de una puerta de salida.

No actualizarlo por cambios internos que no alteren el estado del proyecto. No registrar porcentajes subjetivos de avance ni afirmar verificaciones no ejecutadas.

Este archivo solo describe lo vigente:

- cada entrega, terminada o en curso, ocupa una o dos líneas de «Entregas de la Fase 2», con lo hecho y el enlace a su ADR o a su evidencia; su detalle queda en su ADR, en su evidencia y en sus PR (`CONTRIBUTING.md`, «Documentación y estado»);
- cada paso de «Siguiente tarea autorizada» dice qué falta, sin la historia de cómo se llegó;
- cada decisión del propietario, con sus palabras y su fecha, va a las [decisiones vigentes](docs/gobierno/decisiones-vigentes.md), y aquí solo su efecto en el trabajo siguiente;
- el [historial de entregas](docs/plan/historial-de-entregas.md) está congelado: no se le añade nada.

Al cambiar `plan` o `parallel_plans`, el mismo PR actualiza las partes de los planes que se leen al arrancar (`.kiro/steering/entorno-sandbox-kiro.md`, «Arranque de sesión», paso 3).
