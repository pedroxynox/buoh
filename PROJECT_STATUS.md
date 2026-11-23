---
schema_version: "1.0.0"
status_version: 95
updated_at_utc: "2026-11-23T01:00:00.000Z"
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
- El sistema de datos corre en producción desde el 2026-11-01, en la región `virginia` de Render y con los objetos en Cloudflare R2: la captura (`buoh-ingesta`), el cron job `buoh-operaciones`, cada 5 minutos, y la base `buoh-postgres` ([ADR-0018](docs/arquitectura/adr/0018-sistema-de-datos-en-produccion.md)). Desde el 2026-11-03 corre también `buoh-api`, que sirve la API y la web en `https://buoh-api.onrender.com` ([ADR-0019](docs/arquitectura/adr/0019-api-cuentas-y-auditoria.md)). Producción cuesta unos 26 USD al mes (ADR-0018 §14 y ADR-0019 §10). El total aprobado para la Fase 2, con el servidor del motor *shadow*, el motor de investigación, su VPS y los mercados reales, es de unos 56,50 USD al mes (decisiones vigentes, «Servidor del motor de señales *shadow*»).
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
| F2.5b Mercados reales | ADR-0021 fusionada; su código puede empezar («Siguiente tarea autorizada») | — |
| F2.6, F2.6b y F2.7 a F2.10 | ADR-0022 a ADR-0025 fusionadas; falta la del motor *shadow* | — |
| F2.11 Puerta de salida | Sin empezar | — |

Quedan abiertos de las entregas hechas:

- mostrar una por una las incidencias de cada dataset: Datos las cuenta por tipo y gravedad, y ninguna pantalla las lista todavía, tampoco la Auditoría ([concepto de interfaz](docs/diseno/concepto-de-interfaz.md) §14);
- la primera rotación de la credencial dueña de PostgreSQL, que el propietario aplazó el 2026-11-17 y es una precondición de la Fase 3B del roadmap (decisiones vigentes, «Rotación de la credencial dueña de PostgreSQL»);
- el último dataset del informe de la salud: en producción, `last_published_dataset_id` sigue en `null` con 88 datasets publicados, porque `data:health` lo busca en las tablas de publicación del log observado y los datasets viven en `buoh_datasets` (runbook de ingesta, «Salud de datos (`data:health`)»; [evidencia de los datasets vivos](docs/operacion/evidencia-datasets-f2-5.md), «Límites»). Así, la tarjeta «Último dataset» del Observatorio dice que no hay ninguno ([concepto de interfaz](docs/diseno/concepto-de-interfaz.md) §10). Va en un PR de código posterior;
- el menor 8 de la revisión del PR #121: si lanzar un proceso falla con `EMFILE`, `runNodeScript` puede terminar `buoh-operaciones` sin el paso `memory`; ya pasaba antes de ese PR y va en uno posterior (PR #121, «Relevo»);
- los pendientes técnicos registrados de la Fase 1, en la [especificación de pendientes](docs/plan/especificacion-de-pendientes.md) (P-F1-07).

## Trabajo en paralelo autorizado

Ningún plan en paralelo (`parallel_plans`). F2.2 está hecho desde el PR 9, F2.3 desde el PR 7c, F2.4 desde el 7b y F2.5 desde el PR 6 de ADR-0020. La ADR del motor *shadow* no espera a F2.5b: solo esperaba el corte del 2026-11-23 (plan de Fase 2, §8; «Siguiente tarea autorizada»). La línea visual V1 terminó el 2026-10-25 (plan V1, §7): sus requisitos tienen evidencia fusionada, y el propietario decidió que sus aprobaciones ya registradas (ADR-0010 §4 y ADR-0011, «Contexto») cuentan como la revisión de capturas de los prototipos y del sitio. Sus piezas siguen en el repositorio; los directorios y dependencias nuevos necesitan un plan activo (AGENTS.md, «Desarrollo por fases»).

Cerrar V1 no autoriza la app real de Windows: la decisión 6 de ADR-0001 la deja para cuando esté validado el núcleo web y móvil, y el roadmap la sitúa en la Fase 7. El prototipo de escritorio no la adelanta. La prioridad del propietario del 2026-10-26 por una app de escritorio con datos reales ([decisiones vigentes](docs/gobierno/decisiones-vigentes.md), «Prioridad del propietario») tampoco lo autoriza todavía: antes hace falta su plan, y entonces se revisará esa decisión de ADR-0001. El costo del alojamiento ya está decidido ([ADR-0016](docs/arquitectura/adr/0016-alojamiento-del-sistema-de-datos.md)).

## Siguiente tarea autorizada

**Próximos pasos, en orden** (el 2026-11-16, cuando el propietario pasa a otra cuenta de Kiro: `.kiro/steering/sandbox-ocasional.md`, «Cambio de sesión»). El detalle de cada incremento está en su ADR y en el [historial de entregas](docs/plan/historial-de-entregas.md).

1. **2026-12-02 a las 00:00:03 UTC:** vence el log 1, y el agente comprueba su borrado (runbook de ingesta, «Operaciones (`buoh-operaciones`)», «El primer borrado»). Vuelve a contar los objetos de `logs/000002/`, que tienen que ser los 317 068 de la [evidencia de producción de F2.2](docs/operacion/evidencia-produccion-f2-2.md). Los paneles de R2 y de Render que copia ese día el propietario confirman también lo que cuestan los datasets vivos, y el agente le pide además el uso de `buoh-operaciones` en la facturación de Render, para saber si el cron job pasa del mínimo de 1 USD al mes ([evidencia de los datasets vivos](docs/operacion/evidencia-datasets-f2-5.md), «El costo»).
2. **La ADR del motor *shadow*** (plan de Fase 2, §8, punto 8), la última del laboratorio. Iba después del corte del 2026-11-23, que ya pasó, con la salud `healthy` en los primeros informes del log 5 ([decisiones vigentes](docs/gobierno/decisiones-vigentes.md), «Orden del trabajo»; evidencia de los datasets vivos, «El cambio de perfil en el corte»). Las otras cuatro están fusionadas: la del modelo de estrategia, [ADR-0022](docs/arquitectura/adr/0022-modelo-de-estrategia.md); la del motor de investigación y su VPS, [ADR-0023](docs/arquitectura/adr/0023-motor-de-investigacion.md); la de la semántica del backtest, [ADR-0024](docs/arquitectura/adr/0024-semantica-del-backtest.md); y la del protocolo estadístico, [ADR-0025](docs/arquitectura/adr/0025-protocolo-estadistico.md). Un hallazgo de F2.2 para esa ADR: el 2026-11-12, Deriv no mandó ticks de R_100 durante 6 min 26 s con la conexión abierta, y la salud siguió `healthy` ([evidencia de producción de F2.2](docs/operacion/evidencia-produccion-f2-2.md)). La mayoría de las decisiones del propietario que necesita se tomaron el 2026-11-16 (decisiones vigentes, «Motor de investigación»). El mismo día decidió también el disco de 5 GB, quién administra el VPS y cómo se reanuda una estrategia detenida (decisiones vigentes, «Disco, VPS y reanudación»), y el VPS, que lo demás siga en Render y el sistema del VPS (decisiones vigentes, «VPS del motor de investigación»).
3. **El código de F2.5b**, los mercados reales, con los PR 2 a 8 de [ADR-0021](docs/arquitectura/adr/0021-mercados-reales-y-fuentes-de-investigacion.md) §9. Esperaba el PR 6 de ADR-0020, y va antes que los demás incrementos nuevos, para que la captura del oro empiece pronto (plan de Fase 2, §9).

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
