---
schema_version: "1.0.0"
status_version: 106
updated_at_utc: "2026-11-25T14:00:00.000Z"
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
- El [plan de Fase 2](docs/plan/fase-2-laboratorio-y-bot-shadow.md) fija sus requisitos `F2-*`, el corte de implementación, las ADR que van antes del código y su orden, y el presupuesto. El 2026-11-16 el propietario cambió su alcance: las estrategias las busca un motor de investigación, en Python y en un VPS propio, que prueba millones de estrategias de reglas sobre R_100 y mercados reales de Deriv, y el propietario autoriza las que pasan al bot, como propone la dirección técnica. Entran el oro en vivo y siete mercados reales en velas (F2.5b) y el motor (F2.6b) (plan §1 y §12; decisiones vigentes, «Motor de investigación»).
- El sistema de datos corre en producción desde el 2026-11-01, en la región `virginia` de Render y con los objetos en Cloudflare R2: la captura (`buoh-ingesta`), de R_100 y, desde el PR 3 de [ADR-0021](docs/arquitectura/adr/0021-mercados-reales-y-fuentes-de-investigacion.md), del oro, el cron job `buoh-operaciones`, cada 5 minutos, y la base `buoh-postgres`, con 5 GB de disco desde ese PR ([ADR-0018](docs/arquitectura/adr/0018-sistema-de-datos-en-produccion.md)). Desde el 2026-11-03 corre también `buoh-api`, que sirve la API y la web en `https://buoh-api.onrender.com` ([ADR-0019](docs/arquitectura/adr/0019-api-cuentas-y-auditoria.md)). Producción cuesta unos 26 USD al mes (ADR-0018 §14 y ADR-0019 §10), más lo que suma el oro desde el PR 3: el disco de 5 GB y lo que escribe y lee en R2 y envía fuera de Render (ADR-0021 §6). El total aprobado para la Fase 2, con el servidor del motor *shadow* y sus lecturas de R2, el motor de investigación, su VPS y los mercados reales, es de unos 58,50 USD al mes (decisiones vigentes, «Servidor del motor de señales *shadow*» y «Lecturas de R2 del motor *shadow*»).
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
| F2.5b Mercados reales | En curso: el PR 2 de ADR-0021 está hecho, en cuatro partes: el 2a trajo las secuencias de logs y `buoh_datasets` por secuencia, el 2b, `buoh-operaciones` y `data:health` por secuencia, el 2c, `ingest` con varios símbolos y el mercado cerrado, y el 2d, la memoria y la prueba de dos sesiones y la comprobación con el oro cerrado; el PR 3 trajo el oro a producción, con el disco de 5 GB, y su arranque necesitó el catálogo 2.0.0 de la precisión del 2026-11-25 de [ADR-0012](docs/arquitectura/adr/0012-catalogo-y-adaptador-publico-de-deriv.md) §7; el PR 4 llega en tres partes, y el 4a, el PR #136, fijó los esquemas de `contracts_for`, `proposal` y `trading_times` para los lotes; siguen el 4b y el 4c, y los PR 5 a 8 (ADR-0021 §9; «Siguiente tarea autorizada») | [Evidencia del PR 2d](docs/operacion/evidencia-memoria-f2-5b.md) |
| F2.6, F2.6b y F2.7 a F2.10 | Sin empezar: las cinco ADR del laboratorio, de ADR-0022 a ADR-0026, están fusionadas | — |
| F2.11 Puerta de salida | Sin empezar | — |

Quedan abiertos de las entregas hechas:

- mostrar una por una las incidencias de cada dataset: Datos las cuenta por tipo y gravedad, y ninguna pantalla las lista todavía, tampoco la Auditoría ([concepto de interfaz](docs/diseno/concepto-de-interfaz.md) §14);
- la primera rotación de la credencial dueña de PostgreSQL, que el propietario aplazó el 2026-11-17 y es una precondición de la Fase 3B del roadmap (decisiones vigentes, «Rotación de la credencial dueña de PostgreSQL»);
- los pendientes técnicos registrados de la Fase 1, en la [especificación de pendientes](docs/plan/especificacion-de-pendientes.md) (P-F1-07).

## Trabajo en paralelo autorizado

Ningún plan en paralelo (`parallel_plans`). F2.2 está hecho desde el PR 9, F2.3 desde el PR 7c, F2.4 desde el 7b y F2.5 desde el PR 6 de ADR-0020. La ADR del motor *shadow*, [ADR-0026](docs/arquitectura/adr/0026-motor-de-senales-shadow.md), no esperó a F2.5b, solo al corte del 2026-11-23 (plan de Fase 2, §8). La línea visual V1 terminó el 2026-10-25 (plan V1, §7): sus requisitos tienen evidencia fusionada, y el propietario decidió que sus aprobaciones ya registradas (ADR-0010 §4 y ADR-0011, «Contexto») cuentan como la revisión de capturas de los prototipos y del sitio. Sus piezas siguen en el repositorio; los directorios y dependencias nuevos necesitan un plan activo (AGENTS.md, «Desarrollo por fases»).

Cerrar V1 no autoriza la app real de Windows: la decisión 6 de ADR-0001 la deja para cuando esté validado el núcleo web y móvil, y el roadmap la sitúa en la Fase 7. El prototipo de escritorio no la adelanta. La prioridad del propietario del 2026-10-26 por una app de escritorio con datos reales ([decisiones vigentes](docs/gobierno/decisiones-vigentes.md), «Prioridad del propietario») tampoco lo autoriza todavía: antes hace falta su plan, y entonces se revisará esa decisión de ADR-0001. El costo del alojamiento ya está decidido ([ADR-0016](docs/arquitectura/adr/0016-alojamiento-del-sistema-de-datos.md)).

## Siguiente tarea autorizada

**Próximos pasos, en orden** (el 2026-11-23, con el orden que dio el propietario al empezar la sesión en otra cuenta de Kiro: `.kiro/steering/sandbox-ocasional.md`, «Cambio de sesión»; el paso 2 lo pone el plan de Fase 2, §9, y el plazo del paso 3, ADR-0021 §2). El detalle de cada incremento está en su ADR y en el [historial de entregas](docs/plan/historial-de-entregas.md).

1. **2026-12-02 a las 00:00:03 UTC:** vence el log 1, y el agente comprueba su borrado (runbook de ingesta, «Operaciones (`buoh-operaciones`)», «El primer borrado»). Vuelve a contar los objetos de `logs/000002/`, que tienen que ser los 317 068 de la [evidencia de producción de F2.2](docs/operacion/evidencia-produccion-f2-2.md). Ese día, el agente le pide además al propietario el uso de `buoh-operaciones` en la facturación de Render, para saber si el cron job pasa del mínimo de 1 USD al mes con lo que suman los datasets vivos ([evidencia de los datasets vivos](docs/operacion/evidencia-datasets-f2-5.md), «El costo»).
2. **El código de F2.5b**, los mercados reales, con los PR 4 a 8 de [ADR-0021](docs/arquitectura/adr/0021-mercados-reales-y-fuentes-de-investigacion.md) §9. Esperaba el PR 6 de ADR-0020, y va antes que los demás incrementos nuevos (plan de Fase 2, §9). Antes, el agente comprueba el arranque del oro y su primer día con los pasos del runbook de ingesta («Producción (F2.2)», «El oro (PR 3 de ADR-0021)»), con su acceso o con los **Logs** y las **Metrics** de Render que le copia el propietario. La comprobación del 2026-11-25 encontró que el oro no capturaba ningún tick, porque Deriv dejó de mandar `underlying_symbol_type` en su catálogo, y que R_100 iba a dejar de capturar en su corte del 2026-11-30 por lo mismo (runbook, «El arranque, el 2026-11-25»). Lo arregla la precisión del 2026-11-25 de [ADR-0012](docs/arquitectura/adr/0012-catalogo-y-adaptador-publico-de-deriv.md) §2 y §7, que llegó a producción ese día, y con ella pasaron las comprobaciones del arranque (runbook, «Con el arreglo, el 2026-11-25»). Las del primer día las adelantó el propietario al mismo 2026-11-25, y pasaron (runbook, «El primer día, adelantado, el 2026-11-25»; [decisiones vigentes](docs/gobierno/decisiones-vigentes.md), «La comprobación del primer día del oro, adelantada»). El 2026-11-26 el agente comprueba lo que todavía no había pasado: el primer cierre diario del oro, de 22:00 a 23:00 UTC, y su reapertura, y la memoria de `buoh-ingesta` que cubra ese día, con una captura de **Metrics** del propietario. Sigue el 4b; si esa comprobación encuentra un problema, el agente para el PR 4 y arregla antes el oro.
3. **El PR 7 de ADR-0021 §9**, los umbrales y la publicación del oro, no espera a los PR 4 a 6 (ADR-0021 §2 y §9, punto 7). Necesita al menos 7 días de la captura del oro y tiene que estar en producción 7 días antes de que venza el primer log del oro, a los 30 días de su última escritura (ADR-0021 §2). Ese log se corta el primer lunes a las 00:00 UTC después de su primera escritura. La primera escritura del oro fue su primer latido, el 2026-11-25 a las 00:36:06.227 UTC, así que el corte es el lunes 2026-11-30, el log vence hacia el 2026-12-30 y el PR 7 tiene que estar en producción antes del 2026-12-23. Los 7 días de captura cuentan desde el primer tick del oro, el 2026-11-25 a las 05:09:43.577 UTC (runbook, «Con el arreglo, el 2026-11-25»), así que el PR 7 puede fijar sus umbrales desde el 2026-12-02 a esa hora.

Con la del motor *shadow*, [ADR-0026](docs/arquitectura/adr/0026-motor-de-senales-shadow.md), las cinco ADR del laboratorio están fusionadas (plan de Fase 2, §8): el código de F2.6 a F2.10 ya no espera ninguna ADR y sigue las dependencias del plan (§9), detrás de F2.5b.

Cada vez que lee producción, el agente mira también la memoria de `buoh-operaciones` que guarda el paso `memory`, y cuándo tiene que volver a presentársela al propietario lo dicen las decisiones vigentes («Memoria medida de `buoh-operaciones`»).

## Bloqueos

Ninguno.

## Decisiones pendientes

- Rotar también la contraseña de `buoh_agente`. Quedó en un registro de Kiro el 2026-11-01. El propietario decidió no rotarla ese día («prefiero dejarla como estan») y otra vez el 2026-11-02, después de que el agente le explicara el riesgo («ok, opcion b, quiero dejarla como esta»; runbook de ingesta, «Acceso del agente»). Con ella se leen los logs de la captura, y el 2026-11-04 se supo que también se ve en las estadísticas de PostgreSQL cuándo entra y cuándo usa la web el propietario, nunca las filas de `buoh_api` (ADR-0019 §7). Ese día el agente le recomendó rotarla junto con la credencial dueña, antes del PR 9, con los pasos de «Rotar credenciales» del runbook de ingesta. Las dos rotaciones van una detrás de otra, nunca la de esta contraseña entre los pasos 1 y 6 de la dueña. Antes del paso 3, la **Manual Sync** de esta contraseña haría de la sincronización de ese paso, que le da a `buoh-operaciones` el usuario nuevo. Además, el agente, que comprueba los pasos 2, 4 y 6 con esta contraseña, se quedaría sin acceso hasta que el propietario copie la nueva a Kiro y se abra una sesión nueva. Por eso, al proponérselas, el agente le explica ese orden: la de `buoh_agente`, con su sesión nueva, antes del paso 1 de la dueña o después de su paso 6. Falta su respuesta. El 2026-11-12 el agente se lo volvió a preguntar, para hacerla después del paso 6 de la credencial dueña; el propietario dejó para después la credencial dueña y no respondió sobre esta. El 2026-11-17 aplazó la credencial dueña hasta la beta externa ([decisiones vigentes](docs/gobierno/decisiones-vigentes.md), «Rotación de la credencial dueña de PostgreSQL») y tampoco decidió sobre esta. Sin la dueña, esta se puede rotar sola, el día que él quiera, con una sesión nueva de Kiro para la contraseña nueva; el agente lo sigue recomendando.
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

- una entrega terminada queda en una línea de «Entregas de la Fase 2», con el enlace a su evidencia; su detalle queda en su ADR, en su evidencia y en sus PR;
- cada decisión del propietario, con sus palabras y su fecha, va a las [decisiones vigentes](docs/gobierno/decisiones-vigentes.md), y aquí solo su efecto en el trabajo siguiente;
- el [historial de entregas](docs/plan/historial-de-entregas.md) está congelado: no se le añade nada.

Al cambiar `plan` o `parallel_plans`, el mismo PR actualiza las partes de los planes que se leen al arrancar (`.kiro/steering/entorno-sandbox-kiro.md`, «Arranque de sesión», paso 3).
