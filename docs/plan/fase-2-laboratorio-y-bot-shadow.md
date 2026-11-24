---
plan_id: "F2-LAB"
schema_version: "1.0.0"
status: "active"
effective_when_merged: true
owner: "propietario de buoh"
last_reviewed_utc: "2026-11-17T20:00:00.000Z"
---

# Plan ejecutable: Fase 2 — Laboratorio y bot shadow para uso propio

## 1. Objetivo

Transformar una hipótesis en una estrategia viva, explicable y no ejecutora, para uso propio ([roadmap](../producto/roadmap.md), Fase 2). La fase termina cuando una estrategia en modo `shadow` reproduce cada decisión desde datos y versiones fijados y se detiene sola ante una degradación de los datos (§13).

Para llegar ahí, el sistema de datos de la Fase 1 pasa a un servidor y funciona todo el día ([ADR-0016](../arquitectura/adr/0016-alojamiento-del-sistema-de-datos.md)). Un motor de investigación estudia sin parar los datos de buoh y de mercados reales de Deriv, busca patrones y prueba millones de estrategias de reglas, siempre buscando rentabilidad después de los costos, con datos de entrenamiento y de validación. Propone las pocas que pasan una búsqueda honesta (`F2-SEARCH-001`). La prueba fuera de muestra no entra en la búsqueda: usa solo datos posteriores a la congelación de cada candidata (`F2-EVAL-001`). Si ninguna pasa, la puerta de salida usa una candidata de demostración, marcada así (`F2-SEARCH-001`). Que el motor busque las estrategias lo decidió el propietario el 2026-11-16 (§12); hasta entonces, este plan decía que él las creaba. El propietario revisa la evidencia y autoriza cada estrategia que pasa al bot, como describe la [visión de producto](../producto/vision-y-alcance.md) (§3, «Usuarios»). Esa aprobación es una propuesta de la dirección técnica, porque sus palabras de ese día no hablan de quién autoriza, y el propietario la aprueba al fusionar este plan. El bot las sigue en vivo con señales y posiciones hipotéticas, sin enviar órdenes.

La Fase 2 no intenta demostrar una estrategia rentable. Un resultado negativo es un resultado válido y se muestra entero.

## 2. Estado y aprobación

`active` desde su fusión. Autoriza los incrementos de §9, de F2.1 a F2.11, con F2.5b y F2.6b, cada uno con los directorios del corte (§6) y después de su ADR (§8). F2.5b y F2.6b llegaron con el cambio de alcance del 2026-11-16 (§12): llevan una letra para que los números de los demás, citados en otros documentos, no cambien. Un directorio o una dependencia no existe hasta que llega su incremento (AGENTS.md, «Desarrollo por fases»).

El propietario aprueba el plan al fusionarlo. Las decisiones suyas que la fase todavía necesita están en §12, con el incremento en que se piden.

## 3. Punto de partida

Hechos comprobados al cerrar la Fase 1 y al decidir el alojamiento ([`PROJECT_STATUS.md`](../../PROJECT_STATUS.md) de entonces, que guarda Git, con sus pendientes registrados de la Fase 1 hoy en P-F1-07 de la [especificación de pendientes](especificacion-de-pendientes.md), y ADR-0016):

- **Captura.** `ingest` captura R_100 sobre PostgreSQL y almacenamiento de objetos, pero no corre en ningún servidor: rechaza `staging` y `production` y para a las 23 horas para borrar la captura antes de las 24 ([ADR-0015](../arquitectura/adr/0015-reconexion-recuperacion-y-salud-f1-5.md) §7).
- **Memoria.** El arranque, la vigilancia de huecos y `data:health` leen y derivan el log durable entero. Con 17,8 horas de log, `ingest` llegó a 358 MB y `data:health` a 317 MB, y el worker Starter tiene 512 MB (ADR-0016, «Medición»). La reparación de cierres no registrados, que corre antes de cada reconexión, también lee el log entero (`RawFirstIngestor.repairUnrecordedClose`), aunque ADR-0016 no la nombra.
- **Un mes de datos.** Con la derivación de hoy, todo en memoria, un mes de R_100 ocuparía unos 10 GB (ADR-0016, «Consecuencias»). La publicación y `data:replay` también cargan el dataset entero, y `normalized_ticks` y `quality_incidents` son un solo objeto que crece con el dataset (pendiente 2 de F1.3). Con unos 500 bytes por tick y un tick cada 2 s, son unos 21 MB al día, así que ese objeto pasaría en unos 12 días los 256 MiB que acepta el replay (estimación, sin medir).
- **Costo de `data:health`.** Cada ejecución lee de R2 cada segmento cerrado y cada evento del segmento abierto. Con un día de log, ejecutarlo cada 5 minutos son unos 7,5 millones de lecturas al mes, que casi caben en lo gratuito; cada minuto serían unos 37 millones, unos 11 USD más al mes (ADR-0016, «Consecuencias»).
- **PostgreSQL.** El worker usa un único rol, dueño de las tablas (pendiente 4 de F1.3). En ejecución solo inserta y lee, y `db:migrate` usa las mismas credenciales.
- **Datasets vivos.** No se publican mientras no haya umbrales live de retraso y de hueco, que se fijan con mediciones reales ([decisiones vigentes](../gobierno/decisiones-vigentes.md)). El perfil de Deriv es de medición, y la publicación lo rechaza.
- **Gráficos.** P-V1-04 de la [especificación de pendientes](especificacion-de-pendientes.md) propone resolver su accesibilidad, sus pruebas y sus unidades antes de mostrar datos reales.
- **Lo que no existe.** API, cuentas, estrategias, backtests, señales, posiciones y `execution-gateway`. `HealthReport` solo admite `execution_mode = disabled`, y `StrategyDefinition` y `SignalEvent` solo están nombrados ([contratos de dominio](../arquitectura/contratos-de-dominio.md), «Contratos futuros»).
- **Alcance ya decidido al empezar la fase** (cambió el 2026-11-16, §12). La Fase 2 empieza solo con R_100, y el alojamiento cuesta unos 15 USD al mes, unos 22 con la API (ADR-0016 §2).
- **Medido el 2026-11-16, para el cambio de alcance** (§12), con consultas de solo lectura al canal público de Deriv, sin guardar precios:
  - el canal que ya usa buoh ofrece mercados reales: 4 metales, entre ellos el oro (`frxXAUUSD`), 25 pares de divisas, 12 índices de bolsa, Bitcoin y Ethereum;
  - `ticks_history` da velas de 1 minuto a 1 día y ticks de hasta un año atrás, pedidos por tramos con `start` y `end`: en el oro y en R_100, cada tramo de 10 minutos pedido de hace 3 a 360 días llegó entero, salvo con el mercado cerrado, y las velas más antiguas fueron del 2025-11-17. Una petición de ticks sin `start` devuelve los últimos, hasta 1000;
  - el oro manda un tick por segundo y R_100 uno cada 2 segundos;
  - lo que cobra Deriv: para no perder con un sube/baja hay que acertar alrededor del 57 % de las veces en el oro a 15 minutos y del 51 % en R_100 a 5 ticks. La comisión del multiplicador ×100 ronda el 0,02 % de la exposición en el oro y el 0,04 % en R_100;
  - la comisión del multiplicador frente a la desviación de los retornos de 1 hora: R_100, 0,03; el oro, 0,07; Bitcoin, 0,17; la plata y Ethereum, 0,20; el EUR/USD, 0,32; el GBP/USD, 0,35; el USD/JPY, 0,40. Los índices de bolsa no tienen multiplicadores;
  - fuera de Deriv, según Contabo: un VPS con 4 vCPU y 8 GB cuesta desde unos 5 EUR al mes, y uno de 12 vCPU y 48 GB, unos 20 EUR, y su CPU rinde menos con mucha carga;
  - según OVHcloud, su VPS-2, con 4 vCores, 8 GB y 75 GB, cuesta desde 8,50 USD al mes con compromiso, y su VPS-3, con 6 vCores y 12 GB, desde 12,32 ([ADR-0023](../arquitectura/adr/0023-motor-de-investigacion.md), «Contexto»).

## 4. Restricciones de la fase

Decisiones de la dirección técnica que cumplen todas las ADR y todos los incrementos de la fase:

1. **Un solo evaluador.** El backtest y el motor `shadow` usan la misma función pura para evaluar una estrategia, con la misma forma de entrada. Una estrategia no puede saber si corre en vivo o en una réplica. El motor de investigación evalúa en Python para buscar (`F2-RESEARCH-001`), pero su resultado no es evidencia: cada candidata se vuelve a evaluar con esta función, y los vectores compartidos fijan que las dos dan las mismas decisiones.
2. **Cada decisión en su instante.** Una decisión usa solo lo que era durable antes de ella, en el orden del log. Lo que se sabe después, como la marca de un hueco que se añade a un tick anterior, no cambia una decisión ya tomada, tampoco al reproducirla.
3. **Datos fijados.** Un backtest solo lee datasets publicados, por su `dataset_id`. El motor `shadow` lee la captura viva, y cada decisión guarda lo necesario para reproducirla después desde datasets publicados.
4. **Memoria acotada.** Todo proceso que lee datos los lee por partes, con un techo de memoria que no depende de cuántos datos haya.
5. **Planos separados.** Los datos (`ingest` y `buoh-operaciones`), la investigación (el motor de investigación y sus backtests, en un VPS que lee datos de producción sin poder escribirlos, escribe en su bucket y solo registra en la API lo que permite su credencial, `F2-SEARCH-001`) y las señales (el motor `shadow`) corren en procesos y servicios distintos, cada uno con sus credenciales mínimas. Solo la aprobación del propietario, en la API, pasa una estrategia de la investigación a las señales. No hay ejecución: el modo más alto es `shadow`, nada se autentica en Deriv y no existe `execution-gateway` ([ADR-0002](../arquitectura/adr/0002-senales-y-ejecucion-controlada.md)).
6. **Uso propio.** En producción solo existe la cuenta del propietario, y no hay registro público. Abrir cuentas a otras personas es de la beta externa ([modelo de lanzamiento](../producto/modelo-de-lanzamiento.md), etapa 3) y necesita antes revisar la redistribución de los datos de Deriv, que ADR-0004 §13 deshabilita.
7. **TypeScript para la evidencia, Python para buscar.** El evaluador oficial, el backtest oficial y la estadística de la evidencia son TypeScript, para que la réplica use el mismo código que el bot. El motor de investigación es Python, en `research/python`, como permiten ADR-0001 (decisión 3) y ADR-0003 y decidió el propietario el 2026-11-16 (§12), acelerado con bibliotecas compiladas, como propone la dirección técnica. Busca y propone, y nada de lo que calcula cuenta como evidencia hasta que lo repite `packages/strategy-sdk`, en la réplica de la API (`F2-API-001`).
8. **Presupuesto.** Todo cabe en el presupuesto aprobado (§11). Lo que lo suba necesita antes el visto bueno del propietario.
9. **Un solo entorno desplegado.** No hay `staging` en la Fase 2, porque no cabe en el presupuesto: todo corre en `production`, y el motor, con `execution_mode = shadow`. La preproducción de la arquitectura objetivo describe el destino.
10. **Evidencia de producción.** Hasta el despliegue, el agente no tiene acceso a Render ni a Cloudflare (ADR-0016 §3). Las cifras de producción que pide la evidencia las calcula buoh en producción, sin secretos ni precios, y llegan al repositorio por el canal que fije la ADR de despliegue, por ejemplo una página de evidencia de la web que abre el propietario o los paneles que copia con los pasos del runbook. El 2026-10-31 el propietario decidió darle acceso a producción, también total (§12): el agente usa el mínimo que cada tarea necesita, por defecto solo lectura, y la ADR de despliegue fija cómo le llega, sin pasar credenciales por el chat ni por Git. El VPS del motor de investigación es la excepción: el 2026-11-16 el propietario decidió que solo él tenga acceso (§12).

## 5. Definition of Ready

Para empezar F2.1:

- este plan fusionado y enlazado como `plan` en `PROJECT_STATUS.md`;
- ADR-0016 fusionada;
- la Fase 1 en `done`, con su evidencia;
- el toolchain fijado: Node.js 24.22.0 y pnpm 12.14.0;
- ningún secreto, cuenta ni servicio de pago: F2.1 se prueba sin red.

Cada incremento siguiente empieza cuando:

- su ADR está fusionada (§8), si la tiene;
- lo que necesita de los incrementos anteriores está fusionado, o en marcha si §9 lo dice así;
- las decisiones del propietario que necesita están registradas, con su fecha y sus palabras (§12).

## 6. Corte de implementación

### Crear durante la Fase 2

Cada directorio aparece con su incremento, no antes:

```text
apps/api/                # F2.3: API Fastify, cuentas, sesiones y laboratorio; sirve la web
packages/strategy-sdk/   # F2.6: modelo de estrategia, indicadores y evaluador puros
research/python/         # F2.6b: motor de investigación, en Python acelerado; corre en el VPS
apps/backtest/           # F2.7: backtests de la búsqueda con strategy-sdk; corre en el VPS
apps/signal-engine/      # F2.9: motor de señales shadow
```

`packages/strategy-sdk` toma el nombre de la [arquitectura objetivo](../arquitectura/arquitectura-objetivo.md): la interfaz restringida de estrategia, sin red ni secretos. `research/python` es el de la arquitectura objetivo y ADR-0003. `apps/backtest` es nuevo: desde el 2026-11-16, los backtests de la búsqueda corren en el VPS, y en la API solo corre la réplica de cada versión antes de `shadow` (`F2-API-001`). La ADR del motor de investigación (§8, punto 10), [ADR-0023](../arquitectura/adr/0023-motor-de-investigacion.md), lo precisa en ADR-0019 §12.

### Ampliar

- `apps/market-data-worker`: el punto de control, el despliegue, la publicación de datasets vivos y, en F2.5b, la captura del oro, las velas y lo que cobra Deriv.
- `packages/domain`: la derivación desde un punto de control y la vista de los datos en el instante de cada decisión.
- `packages/contracts`: los contratos de la fase (punto de control, velas, lo que cobra Deriv, estrategia, búsqueda, backtest, evaluación, señal, posición hipotética y auditoría), con su JSON Schema generado.
- `apps/web`: pantallas con datos reales, que sustituyen sección a sección los datos ficticios.
- `render-datos.yaml`, un Blueprint de Render aparte de `render.yaml`, que sigue siendo solo el sitio, y su prueba: los servicios del sistema de datos, de la API y del motor ([ADR-0018](../arquitectura/adr/0018-sistema-de-datos-en-produccion.md) §2).
- `test-vectors/`: vectores sintéticos de estrategia, backtest, búsqueda y réplica, compartidos por TypeScript y Python.
- `infra/`: la preparación del VPS del motor de investigación, con su script y sus pasos en el runbook, que fija su ADR (§8, punto 10; [ADR-0023](../arquitectura/adr/0023-motor-de-investigacion.md) §8).

La API y el motor necesitan leer el log y los datasets con el código del worker. La ADR de la API y las cuentas (§8) decide si lo importan de `@buoh/market-data-worker` o si ese código pasa a un paquete propio. Si es un paquete, su PR lo añade a este corte. ([ADR-0019](../arquitectura/adr/0019-api-cuentas-y-auditoria.md) §8 decidió que lo importan del worker, por la ruta de exportación `@buoh/market-data-worker/lectura`, así que este corte no cambia.)

### Diferido explícitamente

- `execution-gateway`, `packages/risk-policy`, la autorización OAuth de Deriv, las cuentas de bróker y los modos `demo` y `real` (Fases 4 a 6).
- Alertas, notificaciones y la app móvil con datos reales (Fase 3). El prototipo móvil sigue con datos ficticios.
- La app de escritorio con datos reales. Su plan se escribe aparte cuando existan la API y las pantallas de F2.3 y F2.4, y entonces se revisa la decisión 6 de ADR-0001 (`PROJECT_STATUS.md`). Hasta entonces, el prototipo de escritorio sigue con datos ficticios, sin cambiar [ADR-0010](../arquitectura/adr/0010-prototipo-de-escritorio.md): como empaqueta la exportación de `apps/web` y su política de contenido no deja llamar a la API, F2.4 mantiene para él, en `apps/web/out`, una exportación con los datos ficticios (`F2-UI-001`).
- Más mercados que los de `F2-MARKET-001`: R_100 y el oro en vivo, y siete mercados reales en velas. Los índices de bolsa no tienen multiplicadores en Deriv.
- Suscriptores, pagos y registro público (Fase 3B).
- Python fuera de `research/python`, TimescaleDB, Redis y un writer Parquet, salvo que una ADR de la fase demuestre que hacen falta.
- Datos de MetaTrader 5 (Fase 1B). Las exportaciones de velas de MT5 del propietario, que todavía no existen, llegan con su propio plan.
- La inteligencia artificial (modelos de aprendizaje automático): después de las reglas, como decidió el propietario, y la dirección técnica la deja para después de la puerta de salida, con su incremento y su ADR (§12).
- Clientes: buoh opera primero solo para el propietario (§12).

No se crean directorios vacíos para estos componentes.

## 7. Requisitos y aceptación

### `F2-CHECKPOINT-001` — Punto de control de la derivación en vivo

El arranque de `ingest`, la reparación de cierres antes de cada reconexión, la vigilancia de huecos y `data:health` dejan de leer y derivar el log durable entero: parten del último punto de control y derivan solo lo posterior. Un punto de control resume los segmentos cerrados hasta un límite. Solo lo escribe quien tiene el bloqueo de la fuente, nunca se modifica y nunca entra en un dataset ni cambia un `dataset_id`.

**Aceptación:**

- en cada límite de segmento cerrado de los vectores v1 y de logs sintéticos con reconexiones, cierres reparados, duplicados, ticks fuera de orden e historias `complete`, `partial` y `unavailable`, los cuatro lectores obtienen desde el punto de control y el resto del log lo mismo que derivando el log entero, incluidos los fallos del arranque (ADR-0015 §5) y las reglas de `data:health` (ADR-0015 §8);
- si el punto de control falta, es de otra versión o no corresponde al log, el lector no lo usa: lo reconstruye por partes, dentro del mismo techo de memoria, o falla, como fije su ADR. Derivar desde el principio todo el log no es una salida, porque derivar 7 días de log necesita unos 2,5 GB de memoria con el código de hoy, aunque el log ocupe unos 330 MB (estimación con los 8 KB por evento de ADR-0016). Nunca lo usa en silencio ni lo migra, y la ADR da el camino de una versión nueva del punto de control;
- con un log sintético de al menos 7 días de R_100, el máximo de memoria (RSS) de `ingest`, al arrancar y durante una reconexión con hueco, y el de `data:health` no superan en más de un 10 % los de un log de un día, y quedan por debajo de 200 MB y de 160 MB, medidos como en ADR-0016 («Medición»);
- los vectores v1 se reproducen byte a byte, y `deriveMarketData` no cambia su resultado.

### `F2-DEPLOY-001` — Sistema de datos en producción

`ingest` captura R_100 todo el día en un background worker de Render, con Render Postgres y Cloudflare R2 (ADR-0016), con `BUOH_DEPLOYMENT_ENVIRONMENT=production`.

**Aceptación:**

- la ADR de despliegue sustituye en `production` las reglas de ADR-0015 §7 que rechazan `staging` y `production` y paran a las 23 horas, con su prueba, su comentario y el runbook, y dice qué queda de ellas en `development` y `test`;
- antes de crear el bucket de producción, las tres comprobaciones de ADR-0016 §4 (412 con `If-None-Match: *`, lectura justo después de escribir y sumas de comprobación en `WHEN_REQUIRED`) pasan contra un bucket de prueba de R2, y el PR registra el resultado;
- el Blueprint del sistema de datos (`render-datos.yaml`, ADR-0018 §2) describe los servicios, y su prueba los fija. La región elegida queda registrada, y las credenciales solo existen como variables `BUOH_*` de cada servicio;
- cada proceso tiene su token de R2, limitado al bucket de su entorno y a lo que hace: `ingest` y, si es otro, el proceso que publica datasets (`F2-DATASET-001`) leen y escriben, y `data:health`, la API y el motor solo leen. La ADR fija el cifrado de la conexión a PostgreSQL, y una prueba comprueba que el worker lo aplica; la API y el motor lo comprueban en su incremento;
- la ADR fija dónde y cada cuánto corre `data:health`, con su costo en R2 calculado, y si una parada programada, como un despliegue, recupera su historia, algo que ADR-0015 §10 dejó para el plan de alojamiento;
- evidencia de 7 días seguidos de captura en producción, por el canal de §4, punto 10. `data:health` da `healthy` salvo en episodios registrados con su causa. La memoria máxima medida en Render no pasa de 256 MB, la mitad del Starter. (Precisión del PR 9 de [ADR-0018](../arquitectura/adr/0018-sistema-de-datos-en-produccion.md) §16, decisión del propietario del 2026-11-17.) Render no muestra la memoria de `buoh-operaciones`, un cron job, así que para él vale que ninguna ejecución de la ventana se corte, que acota su instancia por debajo de los 512 MB del Starter, y la memoria de su hijo `data:health` medida por separado. Su proceso principal y sus otros hijos, como los `db:migrate`, no se han medido: su memoria máxima, medida en producción, llega después a sus informes con un PR de código, y la evidencia de F2.5 la compara con estos 256 MB, con el mayor de lo medido en producción y en el techo de ADR-0020 §7 para la publicación y la verificación. Si el proceso principal y uno de sus hijos juntos no caben, el agente lo presenta al propietario antes de seguir. (Precisión del PR 6 de ADR-0020 §13: no caben, y el propietario lo aceptó el 2026-11-23; [evidencia de los datasets vivos](../operacion/evidencia-datasets-f2-5.md), «La memoria de `buoh-operaciones`», y [decisiones vigentes](../gobierno/decisiones-vigentes.md), «Memoria medida de `buoh-operaciones`».) Las operaciones de R2 y el tráfico de salida medidos caben en el presupuesto de §11;
- el runbook tiene una sección de producción: preparar, desplegar, parar, recuperar, rotar credenciales y borrar.

### `F2-ROLE-001` — Roles de PostgreSQL con el privilegio mínimo

Cada proceso de producción usa su propio rol. Las migraciones usan el rol dueño. `ingest` y el motor `shadow` usan roles que solo leen e insertan en sus tablas. `data:health` y las lecturas de datos de la API usan un rol que solo lee.

**Aceptación:**

- una prueba de integración demuestra que, con un rol de ejecución, `UPDATE`, `DELETE`, `TRUNCATE` y el DDL fallan por permisos (`42501`), y que `ingest` y `data:health` funcionan con sus roles;
- `db:migrate` corre con credenciales propias, separadas de las de ejecución, y sus errores salen saneados, como los de `ingest`.

### `F2-RETENTION-001` — Retención de producción

La ADR de despliegue fija cuánto tiempo se guardan en producción el log y los datasets, después de revisar qué permiten guardar los términos de Deriv.

**Aceptación:**

- lo que vence se borra sin modificar filas de las tablas append-only, por ejemplo borrando esquemas o buckets enteros, y el procedimiento se prueba en un entorno desechable. Como hoy el log de una fuente vive entero en un esquema y un bucket, borrar así obliga a partir la captura en logs sucesivos: la ADR de despliegue lo prevé, junto con la del punto de control;
- un dataset que cita un backtest, una evaluación o una decisión del motor se conserva al menos tanto como esa evidencia, también si la estrategia se rechazó (protocolo §4);
- mientras nada venza, el runbook fija el uso de disco y de almacenamiento que obliga a revisar la retención, y la evidencia de `F2-DEPLOY-001` lo mide;
- guardar más de lo que cabe en el presupuesto, como pasar el disco de PostgreSQL de 1 a 5 GB, necesita antes el visto bueno del propietario (§12). Para capturar el oro, lo dio el 2026-11-16 (`F2-MARKET-001`).

### `F2-THRESHOLD-001` — Umbrales live medidos

`maximum_delivery_delay_ms` y `maximum_event_gap_ms` de R_100 se fijan con mediciones de la captura de producción. No se inventan.

**Aceptación:**

- la ADR de datasets vivos los fija con al menos 7 días seguidos de captura en producción: la distribución del retraso de entrega (p50, p90, p99, p99,9 y máximo) y la separación tras cada reconexión, con la regla que convierte la medición en umbral;
- van en un perfil de publicación nuevo y versionado, y el perfil de medición no cambia;
- desde entonces, el estado vivo se deriva con el mismo perfil que los datasets, para que el motor `shadow` y la réplica vean las mismas marcas de calidad.

### `F2-DATASET-001` — Datasets vivos reproducibles

La captura de producción se publica como datasets inmutables.

**Aceptación:**

- la ADR fija la cadencia y el tamaño de cada dataset y en qué proceso del plano de datos corre la publicación: el worker de `ingest` u otro proceso de ese plano, nunca la API ni el motor (§4, punto 5). La publicación se hace sola, desde segmentos cerrados del log;
- publicar aplica los límites de lectura del replay y divide en partes los artefactos derivados (pendiente 2 de F1.3), con un techo de memoria que no depende del tamaño del dataset;
- cada dataset publicado se reproduce con `data:replay`, en los dos modos, con el mismo `dataset_id`;
- un fallo de publicación no deja nada visible y queda en el registro operativo (pendiente 3 de F1.3). Si la conexión cae durante el `COMMIT`, el intento siguiente comprueba si se confirmó antes de repetirlo (pendiente 1 de F1.3);
- la ADR decide si los ticks que trae la historia pasan a `MarketTick` (`origin: history_recovery`), lo que ADR-0015 §4 dejó para cuando se publicaran datasets vivos.

### `F2-MARKET-001` — Mercados reales y lo que cobra Deriv

La captura suma el oro (`frxXAUUSD`) en vivo, junto a R_100, y buoh guarda las velas de siete mercados reales y lo que cobra Deriv por sus contratos, como fuentes con procedencia, hora UTC y calidad (§12).

**Aceptación:**

- la ADR de mercados y fuentes (§8, punto 9) fija cómo se captura más de un símbolo y cómo distingue la captura un mercado cerrado de un fallo con los horarios de Deriv (`trading_times`): el oro cierra los fines de semana y un rato cada día. Es [ADR-0021](../arquitectura/adr/0021-mercados-reales-y-fuentes-de-investigacion.md): una secuencia de logs por símbolo (§1); con el mercado cerrado, la sesión del oro espera y reintenta sin fallar, y el horario de cada día lo guardan las secuencias por lotes y lo usan el motor `shadow` y la evidencia, sin cambiar la derivación de la captura (§2 y §3);
- el oro se captura primero con el perfil de medición, sin publicar datasets live, y sus umbrales se fijan después con al menos 7 días de esa captura, como los de R_100 (`F2-THRESHOLD-001`, ADR-0018 y ADR-0020). Cada log tiene hoy un solo perfil, de un solo símbolo (ADR-0020 §4), y el de R_100 ya es el de publicación: la ADR de mercados separa los logs por símbolo o sustituye ADR-0020 §4;
- antes de capturar el oro, el disco de PostgreSQL pasa de 1 a 5 GB, como aprobó el propietario el 2026-11-16 (§12): con R_100, el log de 38 días puede ocupar ya más de la mitad del disco de 1 GB (ADR-0018 §7), y el oro manda un 30 % más de eventos. La ADR de mercados lo mide y precisa ADR-0018 §2 (el plan de la base en `render-datos.yaml` y su prueba) y §7, y ADR-0020 §6 (los umbrales de revisión de la base y del disco, pensados para 1 GB);
- el año de velas de 1 minuto de Deriv del oro, la plata, el EUR/USD, el GBP/USD, el USD/JPY, Bitcoin y Ethereum se descarga por tramos, se actualiza cada día y se publica como datasets que `data:replay` reproduce. Las velas las calcula Deriv, no buoh, y su contrato lo dice. Del oro y de R_100 se descarga también el año de ticks, para que el backtest y el motor `shadow` usen los mismos datos, ticks y velas armadas por buoh (§4.1). La ADR mide el tamaño de todo eso, que entra en la revisión de la retención cuando R2 pasa de 8 GB (ADR-0020 §6);
- cada 30 minutos (ADR-0021 §3), buoh guarda los pagos de sube/baja y las comisiones de los multiplicadores de cada mercado (`proposal`, sin cuenta), para que el backtest sepa lo que Deriv habría cobrado en cada instante. Para el tiempo anterior a esa captura, el backtest declara un supuesto de costos, el medido al empezar, con su sensibilidad (protocolo §1);
- nada de esto se autentica en Deriv ni redistribuye sus datos (ADR-0004 §13). Se guarda todo el tiempo, para uso propio, como decidió el propietario (§12);
- las escrituras de R2 y su costo se miden en producción y caben en el presupuesto de §11.

### `F2-API-001` — API de buoh

`apps/api` (Fastify, ADR-0001) es la única entrada de la web a los datos y al laboratorio. Corre como servicio web de Render y sirve también la exportación de `apps/web`, desde el mismo origen.

**Aceptación:**

- toda entrada y toda salida se validan con contratos de `packages/contracts`, y su descripción OpenAPI se genera desde ellos;
- lee el sistema de datos con un rol de PostgreSQL y un token de R2 de solo lectura, y solo escribe en sus propias tablas;
- ninguna respuesta, registro o error contiene secretos, tokens ni credenciales, y las pruebas lo comprueban;
- todas las respuestas llevan cabeceras de seguridad y una política de contenido, sin recursos de terceros;
- un backtest corre aislado del proceso que atiende las peticiones, con límites de memoria y de tiempo, y su fallo no tumba la API. Corre como mucho uno a la vez, y la memoria máxima del servicio con un backtest en curso, medida en Render, no pasa de 435 MB, el 85 % del Starter. Desde el cambio de alcance del 2026-11-16 (§12), en la API solo corre la réplica de cada versión antes de `shadow` (`F2-EVAL-001`): así un VPS comprometido no puede fabricar la evidencia que ve el propietario. Los backtests de la búsqueda corren en el VPS (`F2-BACKTEST-001`), y la API lee sus resultados de `buoh-investigacion` con un token de solo lectura. La ADR del motor de investigación (§8, punto 10) lo precisa en ADR-0019 §12 (ADR-0023 §1);
- su conexión a PostgreSQL va cifrada como fije la ADR de despliegue, y una prueba lo comprueba;
- sus lecturas de R2 y su tráfico de salida se miden en producción y caben en el presupuesto de §11.

### `F2-AUTH-001` — Cuentas y espacios personales

Las cuentas son de buoh, nunca de Deriv. No hay registro público, y en producción solo existe la del propietario (§4, punto 6). Las cuentas de prueba solo existen en `development` y `test`.

**Aceptación:**

- el inicio de sesión usa el método que fije la ADR de la API y las cuentas, con el visto bueno del propietario (§12), y nunca pide una contraseña de Deriv ni de terceros;
- la sesión vive en el servidor, con una cookie `HttpOnly`, `Secure` y `SameSite=Strict`, vence y se puede revocar. El servidor guarda solo un hash del identificador de la sesión. Las peticiones que cambian algo están protegidas contra CSRF, y los intentos fallidos tienen un límite;
- cada estrategia, backtest, evaluación, señal y posición pertenece a una cuenta, y las pruebas demuestran, con cuentas de prueba, que otra cuenta no puede leerla ni cambiarla;
- el inicio de sesión, el cierre y los fallos quedan en la auditoría, sin secretos, y los registros no llevan datos personales de la cuenta más allá de su identificador.

### `F2-AUDIT-001` — Auditoría

Un registro append-only guarda quién hizo qué y cuándo: inicios de sesión, versiones y cambios de ciclo de vida de las estrategias, registros previos, propuestas del motor de investigación con su aprobación o su rechazo, backtests, evaluaciones, y activaciones, detenciones y reanudaciones del motor.

**Aceptación:**

- la base de datos rechaza modificar o borrar sus filas, como en las tablas de la Fase 1;
- cada entrada tiene autor, hora UTC, acción, motivo y los objetos afectados, con sus identificadores o hashes;
- la sección Auditoría de la web la muestra, junto con los eventos de datos ya registrados (versiones del catálogo, publicaciones, incidencias y condiciones), sin controles para cambiarlos.

### `F2-UI-001` — Pantallas con datos reales

Observatorio, Mercados y Datos de `apps/web` ([concepto de interfaz](../diseno/concepto-de-interfaz.md) §3) muestran los datos de producción a través de la API.

**Aceptación:**

- Observatorio muestra la salud de los datos con su causa, el modo de ejecución aparte de la salud y el último dataset. En `recovering`, la causa se ve aunque `open_condition_types` esté vacío (pendiente 2 de F1.2);
- Mercados muestra el catálogo de Deriv con su versión y su fecha, y el gráfico de R_100 de las últimas horas, en ticks y en velas, con los huecos marcados y su motivo;
- Datos muestra los datasets publicados, con su identificador, período, conteos, incidencias y el resultado de su verificación. Sus pruebas usan datasets sintéticos, y en producción la sección muestra su estado vacío hasta que F2.5 publique los primeros;
- toda vista de datos dice símbolo, fuente, zona horaria UTC, intervalo, frescura y calidad. Una sección con datos reales nunca muestra datos ficticios, y las que siguen ficticias conservan la marca «Datos ficticios»;
- la preferencia de la Fase 2 del [catálogo de funciones](../producto/funciones-y-disponibilidad.md), el tema noche o día, se guarda por cuenta. El idioma no se guarda: el producto va solo en español (§12), así que no hay nada que elegir, y el selector de idioma llega con un segundo idioma. Las preferencias de notificaciones llegan con la Fase 3, que trae las alertas y sus permisos y preferencias ([roadmap](../producto/roadmap.md), Fase 3);
- cada pantalla tiene los estados del concepto de interfaz §5: cargando, vacío, error y degradado;
- la exportación con datos ficticios sigue en `apps/web/out`, la carpeta que empaqueta el escritorio (ADR-0010), y la API sirve otra exportación. Una prueba comprueba que la de `apps/web/out` solo tiene datos ficticios y no llama a la API.

### `F2-CHART-001` — Gráficos accesibles y probados

Resuelve P-V1-04 antes de que un gráfico muestre datos reales.

**Aceptación:**

- el concepto de interfaz fija la alternativa en texto o en tabla de cada gráfico, una sola unidad para la peor caída, la misma en el gráfico y en su contexto, y la regla de las velas: su intervalo y cómo marcan un hueco;
- una prueba mide el contraste de los tokens `chart` de la línea y del hueco contra su fondo: 3:1 o más, como pide WCAG 2.2 (criterio 1.4.11) para las partes de un gráfico necesarias para entenderlo. La rejilla queda como decorativa, porque los valores están en la alternativa en texto; con la paleta de hoy no llega a 3:1, y la prueba lo deja escrito;
- hay pruebas de la escala, de los cortes de la línea y del SVG exportado, también con una serie vacía, una serie sin ningún dato y un hueco en el primer punto;
- la descripción accesible se calcula de los datos, no se escribe a mano.

### `F2-STRATEGY-001` — Estrategias declarativas y versionadas

Una estrategia es un documento declarativo (`StrategyDefinition`), no código: reglas limitadas sobre indicadores de una biblioteca fija, como pide el roadmap.

**Aceptación:**

- la ADR del modelo de estrategia fija la gramática de reglas, la biblioteca de indicadores (cada uno con su definición matemática, sus unidades y sus vectores), los parámetros con sus rangos, el modelo de posición hipotética, los tipos de contrato (solo multiplicadores, `MULTUP` y `MULTDOWN`, y sube/baja, `CALL` y `PUT`; §12) con sus costos (`F2-MARKET-001`) y su duración, que decide cada estrategia, de segundos a horas, la caída máxima (el 50 % del capital de la estrategia; §12), los costes y supuestos, el vencimiento de cada señal, los límites de frecuencia y la política de datos que decide cuándo se detiene la estrategia (`F2-STOP-001`);
- la identidad de una versión es el hash de su contenido: cambiar cualquier cosa crea otra versión, y nada se modifica en su lugar. Cada versión lleva además su versión semántica y su propietario responsable ([seguridad y rigor](../gobierno/seguridad-y-rigor-cuantitativo.md) §2);
- una definición inválida se rechaza con errores estructurados;
- el evaluador es puro y determinista: los vectores fijan sus decisiones, y sus pruebas prohíben red, reloj real y azar, como `F1-VECTOR-001`. Sin azar no hace falta semilla; si una ADR introduce azar, lo inyecta con una semilla registrada;
- el ciclo de vida (`draft`, `reviewed`, `active`, `paused`, `retired`) avanza solo con las puertas del [protocolo de validación](../gobierno/protocolo-de-validacion-de-estrategias.md) §4, y cada cambio queda en la auditoría. La puerta `reviewed` → `shadow` del protocolo pone la estrategia en `active` con `execution_mode = shadow`, y la estrategia declara ese modo ([operación y control de riesgo](../gobierno/operacion-y-control-de-riesgo.md) §2). Como la promoción crea una versión nueva (seguridad y rigor §2), la ADR del modelo de estrategia fija cómo la versión en `shadow` queda ligada a la evidencia de la versión congelada;
- las estrategias las propone el motor de investigación (`F2-RESEARCH-001`). La sección Laboratorio de la web muestra cada versión con su informe, y el propietario la aprueba o la rechaza (§1); no la edita;
- las ADR del modelo de estrategia y de la semántica del backtest fijan qué datos consume una estrategia, para que sean los mismos en el backtest y en `shadow` (§4.1).

### `F2-RESEARCH-001` — Motor de investigación

`research/python` estudia sin parar los datasets publicados, busca patrones, prueba millones de estrategias de reglas y propone candidatas. Corre en un VPS propio (§11) y nunca opera.

**Aceptación:**

- la ADR del motor de investigación (§8, punto 10) fija la versión de Python, sus bibliotecas con su versión y su motivo, la gramática que recorre la búsqueda, los métodos de búsqueda, el registro de cada búsqueda y la seguridad del VPS. Es [ADR-0023](../arquitectura/adr/0023-motor-de-investigacion.md): Python 3.14 con NumPy, Numba y Optuna (§2), la gramática de ADR-0022 en tres etapas, con sus controles (§6), el registro en la API con la credencial del motor (§5 y §6) y el VPS-2 de OVHcloud con Ubuntu 26.04 LTS (§8);
- lee solo datasets publicados, por su `dataset_id`, por partes, con un techo de memoria y con credenciales de solo lectura. Los datasets viven en `buoh-captura`, junto a la captura, R2 limita los tokens por bucket y no por prefijo (ADR-0020 §5), y qué publicación está activa lo dice PostgreSQL (`buoh_datasets`; ADR-0004 §8). Su ADR elige cómo lee: por ejemplo, un token de solo lectura de `buoh-captura` y un rol de PostgreSQL que solo lee `buoh_datasets`, o una copia de los datasets publicados y de su índice en un bucket que escribe el plano de datos. Cada opción dice lo que filtraría un VPS comprometido. ADR-0023 §4 elige la lista de datasets de la API, con la credencial del motor, y un token de solo lectura de `buoh-captura`;
- escribe en su bucket, `buoh-investigacion`, y registra en la API lo que permite su credencial (`F2-SEARCH-001`). No tiene ninguna credencial que escriba en la captura, en los datasets ni en la base, ni ninguna de un bróker, y una prueba lo comprueba;
- cada candidata sale como un `StrategyDefinition` válido (`F2-STRATEGY-001`), y su evaluador acelerado da las mismas decisiones que el de `packages/strategy-sdk` en los vectores compartidos;
- evalúa cada candidata con los costos de su tipo de contrato (`F2-MARKET-001`), sin pasar de la caída máxima de §12;
- solo propone para `shadow` estrategias de mercados que buoh captura en vivo, R_100 y el oro. De los demás informa lo que encuentra; capturarlos en vivo es otra decisión del propietario;
- mide cuántas estrategias prueba por hora en el VPS, y esa medición decide si su plan alcanza;
- su código tiene versiones fijadas con archivo de bloqueo, pruebas sin red, reloj real ni azar no inyectado, y linter y tipos estrictos, todo en CI;
- cada semana deja en `buoh-investigacion` un informe de lo que probó, cuántas, lo que propone y lo que no encontró, y la sección Laboratorio lo muestra.

### `F2-SEARCH-001` — Búsqueda honesta

Con millones de pruebas, la mejor del pasado casi siempre es suerte. La búsqueda lo tiene en cuenta.

**Aceptación:**

- antes de mirar resultados, cada búsqueda registra lo que puede probar: la gramática, los rangos de parámetros, los datasets, las ventanas y la métrica principal (protocolo §1). Cambiarlo crea otra búsqueda;
- el registro de cada búsqueda y la congelación de cada candidata pasan por la API antes de que el motor de investigación siga: la API los valida con sus contratos y los guarda append-only en PostgreSQL, con su hash y su hora, y en la auditoría, con el motor de investigación como autor propio. El VPS llega a la API con una credencial propia, que solo registra búsquedas, congelaciones y resultados, y lee los datasets que puede usar y sus propias búsquedas (ADR-0023 §5). Es una entrada nueva a la API desde internet, que ADR-0019 no tiene (§1, §2, §4 y §5, y su alternativa descartada de otra puerta en internet): la ADR del motor de investigación la justifica, la fija y añade ese autor a ADR-0019 §5;
- `buoh-investigacion` tiene una regla de bloqueo, como `buoh-captura`: lo escrito no se reescribe ni se borra mientras dura su bloqueo, que en las listas temporales y el estado vence (ADR-0023 §7). La API valida con sus contratos y sus hashes todo lo que lee de ahí;
- cada candidata probada queda en el registro de su búsqueda, también las descartadas, y el informe de una propuesta dice cuántas se probaron. Esa lista, de millones de filas, va a `buoh-investigacion`, y a PostgreSQL van la especificación de la búsqueda, cada congelación y el hash de esa lista. La lista de una búsqueda sin finalistas que se pueden congelar se guarda 30 días, y su resumen, con sus recuentos, para siempre (ADR-0023 §6);
- la ADR del protocolo estadístico (§8, punto 7) fija las correcciones por búsqueda, como el Sharpe deflactado, la probabilidad de sobreajuste del backtest o la comparación con la línea base de White o de Hansen, y una propuesta tiene que superarlas. Es [ADR-0025](../arquitectura/adr/0025-protocolo-estadistico.md) §4: el Sharpe deflactado de la validación, con las mediciones de su familia, de al menos 0,95; la muestra mínima; `cost_scale` de 1,5 y la latencia de 2000 ms; las vecinas y las subventanas; y la PBO de la búsqueda, que calcula el VPS y solo puede impedir una congelación. White y Hansen no se suman, porque también los calcularía el VPS y solo podrían impedir; lo que decide es la prueba fuera de muestra de su §7;
- la misma búsqueda corre sobre R_100 y sobre series al azar sintéticas. Si aprueba más candidatas de las que da el azar, no propone nada en mercados reales hasta corregirse. ADR-0023 §6 lo precisa: todas corren también sobre una serie barajada, las de ticks del oro también sobre R_100, y con un control que falla el motor no propone nada de ningún mercado, tampoco de R_100;
- un vector sintético sin patrón no produce ninguna propuesta, y uno con un patrón sembrado sí;
- si ninguna candidata supera estas pruebas, el motor puede presentar para la puerta de salida su mejor candidata de un mercado capturado en vivo, marcada «candidata de demostración, sin ventaja demostrada» en todo su informe. Pasa por la misma congelación, la misma prueba fuera de muestra y la misma réplica que las demás. Sirve solo para demostrar el motor `shadow` (§13), y el propietario lo sabe al aprobarla.

### `F2-BACKTEST-001` — Backtest reproducible por partes

Un backtest evalúa una versión de estrategia sobre datasets publicados, con el evaluador del motor `shadow` (§4). Los de la búsqueda corren en el VPS, en `apps/backtest`, y repiten con `packages/strategy-sdk` lo que calculó el motor de investigación. La réplica de cada versión antes de `shadow` corre en la API (`F2-API-001` y `F2-EVAL-001`).

**Aceptación:**

- la ADR de la semántica del backtest fija cómo se reconstruye cada instante de decisión desde los source events del dataset (§4, punto 2), qué entradas forman la identidad del backtest y cómo trata los datos degradados según la política de datos de la estrategia. Es [ADR-0024](../arquitectura/adr/0024-semantica-del-backtest.md): la vista de cada instante, que deriva cada log desde su segmento 0, en su orden, con las marcas de cada tick al llegar y la salud del log (§2); el anfitrión, con el instante de cada evento y el paso del tiempo en cada plazo (§3); el `BacktestSpec`, cuyo hash es la identidad (§1 y §7); y la política de datos sobre la salud del log y las incidencias de los lotes (§5);
- su identidad es el hash de sus entradas: versión de estrategia, parámetros, `dataset_id`, rango, versión del motor, costes y supuestos. El entorno de ejecución (versiones de Node y de los contratos) se guarda junto al resultado, fuera de la comparación: repetirlo con las mismas entradas da las mismas decisiones, posiciones y métricas, byte a byte;
- lee los datos por partes, cada una verificada por su hash antes de usarla, y un backtest de 30 días sintéticos de R_100 no pasa de 256 MB;
- declara costes, latencia y supuestos, y cuenta las decisiones que la política de datos dejó sin tomar;
- vectores sintéticos fijan las decisiones, las posiciones y las métricas esperadas, también con huecos, duplicados y ticks fuera de orden;
- una versión de datos o de perfil que no soporta se rechaza, sin adivinar;
- la sección Laboratorio de la web muestra su resultado, cada cifra con su modo (`backtest`) y su contexto completo (concepto de interfaz §4, «Métrica con contexto»).

### `F2-EVAL-001` — Entrenamiento, validación y prueba fuera de muestra

La evaluación sigue el protocolo de validación, con las reglas medibles que fije la ADR del protocolo estadístico. Es [ADR-0025](../arquitectura/adr/0025-protocolo-estadistico.md): lo que se fija antes de validar está en el registro de la búsqueda y en esa ADR, y el registro previo de cada candidata lo compone la API con su congelación, que es la petición de la evaluación del motor, antes de la prueba fuera de muestra (§5); la revisión técnica la hace la API con su réplica (§6); y la ventana fuera de muestra dura los días de 60 operaciones al ritmo de la validación, de 14 a 56, con una prueba por apuestas, que vale con pocas operaciones y con cualquier distribución de sus resultados, y que corrige por las versiones de su símbolo abiertas a la vez (§7).

**Aceptación:**

- antes de validar, la estrategia tiene un registro previo inmutable con lo que pide el protocolo §1: entre otras cosas, los `dataset_id`, las ventanas de entrenamiento, validación y prueba fuera de muestra en UTC, en orden y sin solaparse, la métrica principal, la línea base y los criterios de promoción, pausa y retiro;
- la prueba fuera de muestra se ejecuta una sola vez por versión congelada. Un segundo intento se rechaza y queda en la auditoría;
- el informe trae todas las métricas del protocolo §3, la comparación con la línea base, la sensibilidad a parámetros y a ventanas y cuántas variantes se probaron;
- una estrategia sin muestra, costes, línea base o prueba fuera de muestra sale como «no validada» (protocolo §3);
- antes de pasar a `shadow`, el backtest de la versión congelada se repite y da el mismo resultado: es la réplica del ciclo de seguridad y rigor §2;
- un vector sintético en el que la estrategia gana en entrenamiento y pierde fuera de muestra produce exactamente ese informe;
- la ventana fuera de muestra de una versión empieza después de su congelación, que registró la API (`F2-SEARCH-001`): son datos que no existían cuando el motor buscó, y la API comprueba que no se solapa con ninguna ventana del registro de su búsqueda. Su duración la fija la ADR del protocolo estadístico;
- la prueba fuera de muestra de cada versión congelada la corre la API, con la réplica (`F2-API-001`), cuando termina su ventana, y la corre para todas las congeladas, no solo para las que pide el motor. El informe dice cuántas se congelaron y cómo salió cada una, y el propietario lo ve después de la réplica;
- el motor de investigación registra el registro previo en la API y pide la evaluación y la prueba fuera de muestra. Desde la sección Laboratorio de la web, el propietario ve el informe de evidencia, cada cifra con su contexto, y aprueba o rechaza la puerta `reviewed` → `shadow`. Solo su aprobación pasa una estrategia al motor `shadow` (§1).

### `F2-SHADOW-001` — Motor de señales shadow

`apps/signal-engine` sigue en vivo las estrategias `active` en modo `shadow`, sobre la captura de producción, en un servicio propio (§11).

**Aceptación:**

- lee la captura con un rol de solo lectura, desde el punto de control (`F2-CHECKPOINT-001`), y solo escribe en sus tablas append-only (precisión de [ADR-0026](../arquitectura/adr/0026-motor-de-senales-shadow.md) §2: sigue desde su propio estado, que contiene el estado vivo del punto de control de `ingest` y lo compara con él en cada segmento cerrado);
- lee las estrategias aprobadas de PostgreSQL, de un registro append-only que escribe la API con la aprobación del propietario, y no depende del VPS: si el VPS se apaga, sigue;
- no abre ninguna conexión con Deriv ni con un bróker, y una prueba lo comprueba. Su `execution_mode` es `shadow`;
- tras un reinicio, sigue desde su último estado durable, y las decisiones que no tomó a tiempo quedan registradas como omitidas, con su causa;
- tiene pruebas sin red, con log, reloj y temporizador falsos, y corre desplegado en producción, con una memoria máxima medida en Render que no pasa de 256 MB, la mitad del Starter;
- su conexión a PostgreSQL va cifrada como fije la ADR de despliegue, y sus lecturas de R2 y su tráfico de salida se miden en producción y caben en el presupuesto de §11;
- la web muestra el estado del motor por estrategia: en marcha o detenida, y por qué.

### `F2-SIGNAL-001` — Registro de señales

Cada señal es un `SignalEvent` con estrategia y versión, símbolo, instante, vencimiento, condición, calidad de los datos, modo y enlace a su evidencia ([seguridad y rigor](../gobierno/seguridad-y-rigor-cuantitativo.md) §7).

**Aceptación:**

- el registro es append-only y guarda también, con su motivo, las señales que el motor no emitió por la política de datos o por los límites de frecuencia;
- una señal vencida nunca se muestra como vigente;
- los vectores en los que la condición no se cumple no producen señal: es la prueba de falsos positivos que pide seguridad y rigor §9;
- la sección Señales de la web las muestra con su modo, vencimiento, calidad y evidencia.

### `F2-POSITION-001` — Posiciones hipotéticas y comparación con lo esperado

El motor lleva un libro de posiciones hipotéticas por estrategia, con el modelo de posición y los costes de su definición, y compara lo que observa con lo que esperaba su evaluación.

**Aceptación:**

- cada posición enlaza su señal y su decisión, y nunca existe una orden;
- una posición sigue la semántica de su contrato de Deriv: un multiplicador, con su comisión, su stop loss, su take profit y su cierre al perder lo apostado; un sube/baja, con el pago que Deriv ofrecía en su instante (`F2-MARKET-001`);
- la comparación usa la prueba de deriva que fije la ADR del protocolo estadístico, con la cadencia que fije la ADR del motor `shadow`. Una deriva material es causa de pausa (protocolo §5). Es [ADR-0025](../arquitectura/adr/0025-protocolo-estadistico.md) §9: una prueba de Poisson de la frecuencia y un remuestreo del resultado, las dos al 1 %, una vez al día ([ADR-0026](../arquitectura/adr/0026-motor-de-senales-shadow.md) §7);
- el informe de la estrategia, en la sección Laboratorio de la web, muestra juntos el backtest, la validación, la prueba fuera de muestra y el `shadow`, cada cifra con su modo y su contexto.

### `F2-STOP-001` — Detención ante datos degradados

El motor deja de decidir por una estrategia en cuanto sus datos dejan de cumplir la política de datos de la estrategia, sin esperar a nadie. Detenerse es pausar: la estrategia pasa a `paused`, con su causa (protocolo §5).

**Aceptación:**

- se detiene, al menos, con la salud de los datos distinta de `healthy`, con una condición `connection_lost` o `event_gap_unresolved` abierta, con la continuidad pendiente, con datos más viejos que el máximo de la estrategia y con un perfil o un esquema distinto del registrado;
- fuera del horario de su mercado (`F2-MARKET-001`), una estrategia no decide y no se detiene: un cierre programado no es una degradación. Un mercado que deja de mandar datos dentro de su horario sí la detiene. La ADR del motor `shadow` lo fija: es [ADR-0026](../arquitectura/adr/0026-motor-de-senales-shadow.md) §4, con la regla de la reapertura;
- cada detención queda registrada con su causa y su instante, y se reproduce como cualquier otra decisión (`F2-REPLAY-001`);
- una detención por datos degradados se levanta sola cuando los datos vuelven a cumplir la política de datos de la estrategia. Que vuelva sola lo decidió el propietario el 2026-11-16 (§12). Qué cuenta como datos degradados es la lectura de la dirección técnica: la salud distinta de `healthy`, una condición `connection_lost` o `event_gap_unresolved` abierta, la continuidad pendiente y los datos más viejos que el máximo de la estrategia, sea cual sea la duración del corte. Es más amplia que la opción «sola tras las degradaciones breves que la historia cubre» que este plan tenía como pendiente, porque al propietario se le preguntó «a mano o sola». Solo vuelve sola si no queda abierta ninguna causa de la viñeta siguiente; una salud `failed` por un esquema incompatible o un log que no se deriva es de esa viñeta. El propietario también puede reanudarla a mano antes, por ejemplo tras un hueco que la historia no cubre, que sigue abierto hasta el corte del log. Las decisiones que el motor no tomó mientras tanto quedan registradas como omitidas, con su causa. La ADR del motor `shadow` fija la regla ([ADR-0026](../arquitectura/adr/0026-motor-de-senales-shadow.md) §4), y el mismo PR cambia el protocolo §5 y el párrafo del catálogo de funciones sobre «Volver a encender», que pedían análisis, evidencia y decisión para reactivar una estrategia pausada por cualquier causa del protocolo §5, también por datos;
- cualquier otra detención o pausa nunca se levanta sola: un perfil o un esquema distinto del registrado, un incidente de integridad, como un dato alterado ([seguridad y rigor](../gobierno/seguridad-y-rigor-cuantitativo.md) §7), una deriva, o una de las demás causas del protocolo §5 que existen en `shadow`, como su criterio de pausa registrado o la caída máxima. Se reanuda con análisis documentado, nueva evidencia y una decisión auditada del propietario, desde la sección Laboratorio de la web. Reanudar así adelanta, para el modo `shadow`, lo que el catálogo de funciones llama «Volver a encender» y ponía en la Fase 4;
- cada causa tiene su vector, también la reanudación sola tras datos degradados y su ausencia con una causa de la reanudación a mano abierta, y la puerta de salida demuestra la detención en producción.

### `F2-REPLAY-001` — Cada decisión se reproduce

Es la primera mitad del criterio de salida del roadmap: cada decisión del motor se puede reproducir desde datos y versiones fijados.

**Aceptación:**

- cada decisión del motor (una señal emitida u omitida, una posición, una detención o una reanudación) guarda la versión de la estrategia y sus parámetros, la versión del motor, el perfil y las versiones de los datos, y su posición en el log;
- una réplica desde los datasets publicados que cubren esa posición, con las mismas versiones, produce el mismo registro, con el mismo hash;
- ninguna decisión usa datos recibidos después de su instante: un vector que añade un dato tardío no cambia las decisiones anteriores;
- `pnpm run decisions:replay` (§9, «Comandos») recorre las decisiones de un período y cuenta las que coinciden y las que no.

### `F2-GOV-001` — Guardia documental de los componentes nuevos

**Aceptación:** cada directorio nuevo del corte (§6), y `packages/domain/**` (pendiente 3 de F1.2), entra en `docs/impact-map.json` con su fuente canónica en el mismo PR que lo crea o, para `packages/domain`, en el primero de la fase que lo cambia, y las pruebas del mapa lo cubren.

## 8. ADR antes del código

Cada ADR es un PR propio, con su revisión semántica, y se fusiona antes del primer PR de código que gobierna. Cada una fija la secuencia de PR de su incremento, como ADR-0015 §13. Este es su orden:

1. **Punto de control** (F2.1): qué resume, dónde se guarda, cómo se liga a los segmentos cerrados y a las versiones, cómo se demuestra la equivalencia con la derivación completa y cómo lo usan los cuatro lectores. Dice también cómo sigue valiendo si la retención parte la captura en logs sucesivos (`F2-RETENTION-001`). Diseña la derivación para que la vista de cada instante de decisión (§4, punto 2) pueda reutilizarla.
2. **Despliegue del sistema de datos** (F2.2): las condiciones de ADR-0016 §4 que quedan después del punto de control. Son los roles, la retención, las reglas de `ingest` en producción, las comprobaciones de R2, dónde y cada cuánto corre `data:health`, las credenciales y la región. Decide también el cifrado de la conexión a PostgreSQL, el Blueprint de Render (`render-datos.yaml`, [ADR-0018](../arquitectura/adr/0018-sistema-de-datos-en-produccion.md)), la historia tras una parada programada, qué pasa si dos instancias se solapan durante un despliegue, cómo se mide el tráfico de salida y cómo llega al repositorio la evidencia de producción (§4, punto 10).
3. **API y cuentas** (F2.3): el método de inicio de sesión, las sesiones, las cuentas sin registro público, los espacios personales, la auditoría, los contratos y su OpenAPI, cómo se sirve la web y sus roles y tokens de lectura. Decide también cómo se aíslan los backtests y cómo comparten la API y el motor el código de lectura de datos (§6).
4. **Datasets vivos** (F2.5): los umbrales, el perfil de publicación, la cadencia y el tamaño, las partes y los límites al publicar, los ticks de la historia y la lectura por partes. Se escribe con 7 días de captura en producción.
5. **Modelo de estrategia** (F2.6), [ADR-0022](../arquitectura/adr/0022-modelo-de-estrategia.md).
6. **Semántica del backtest** (F2.7), [ADR-0024](../arquitectura/adr/0024-semantica-del-backtest.md).
7. **Protocolo estadístico** (F2.8), con las correcciones por búsqueda (`F2-SEARCH-001`) y cómo cumplen las candidatas del motor de investigación el registro previo (la hipótesis y su mecanismo) y la revisión técnica del [protocolo de validación](../gobierno/protocolo-de-validacion-de-estrategias.md) §1 y §4, que cambia en el mismo PR. Es [ADR-0025](../arquitectura/adr/0025-protocolo-estadistico.md).
8. **Motor de señales shadow** (F2.9 y F2.10), con los ensayos de la puerta de salida y los cierres programados del mercado (`F2-STOP-001`). Es [ADR-0026](../arquitectura/adr/0026-motor-de-senales-shadow.md).
9. **Mercados y fuentes de investigación** (F2.5b), [ADR-0021](../arquitectura/adr/0021-mercados-reales-y-fuentes-de-investigacion.md): los símbolos, la captura de más de uno, los mercados cerrados, las velas y los ticks de la historia como datos de buoh, lo que cobra Deriv como datos propios de buoh, el disco y el costo (`F2-MARKET-001`).
10. **Motor de investigación y su VPS** (F2.6b), [ADR-0023](../arquitectura/adr/0023-motor-de-investigacion.md): sus credenciales, su seguridad y su administración, y la precisión de ADR-0019 §12 sobre dónde corren los backtests (`F2-RESEARCH-001` y `F2-SEARCH-001`).

Los puntos 9 y 10 llegaron con el cambio de alcance del 2026-11-16 (§12), al final de la lista para no cambiar los números que citan otros documentos. El orden es otro: la 9 va primero y sola, para que la captura del oro empiece pronto, y después van seguidas la 5, la 10, la 6, la 7 y la 8. Esas cinco comparten el evaluador, el instante de decisión y lo que guarda cada decisión, así que se fusionan todas antes del primer PR de código de F2.6. El 2026-11-16 el propietario decidió escribirlas ya, sin esperar el PR 6 de ADR-0020, salvo la del motor `shadow`, que va después del corte del 2026-11-23, cuando la captura entra en el log 5 ([decisiones vigentes](../gobierno/decisiones-vigentes.md), «Orden del trabajo»). El código de cada incremento sigue esperando lo que dice §9.

F2.4 no tiene ADR: cambia el concepto de interfaz, que es su fuente canónica (P-V1-04).

## 9. Secuencia de entrega

| Incremento | Requisitos | Depende de |
|---|---|---|
| **F2.1** Punto de control | `F2-CHECKPOINT-001` y `F2-GOV-001` (`packages/domain`) | este plan |
| **F2.2** Sistema de datos en producción | `F2-DEPLOY-001`, `F2-ROLE-001` y `F2-RETENTION-001` | F2.1 |
| **F2.3** API, cuentas y auditoría | `F2-API-001`, `F2-AUTH-001`, `F2-AUDIT-001` (sesiones) y `F2-GOV-001` (`apps/api`) | la captura de F2.2 corriendo en producción |
| **F2.4** Datos reales en pantalla | `F2-UI-001`, `F2-CHART-001` y `F2-AUDIT-001` (eventos de datos, ADR-0019 §5) | F2.3 |
| **F2.5** Datasets vivos | `F2-THRESHOLD-001` y `F2-DATASET-001` | F2.2 con sus 7 días de captura |
| **F2.5b** Mercados reales | `F2-MARKET-001` | su ADR (§8, punto 9) y el PR 6 de ADR-0020 |
| **F2.6** Estrategias | `F2-STRATEGY-001`, `F2-AUDIT-001` (estrategias) y `F2-GOV-001` (`packages/strategy-sdk`) | F2.3 y las cinco ADR del laboratorio (§8, puntos 5 a 8 y 10) |
| **F2.6b** Motor de investigación | `F2-RESEARCH-001`, `F2-SEARCH-001` (registro de las búsquedas y controles negativos), `F2-AUDIT-001` (búsquedas y la credencial del motor) y `F2-GOV-001` (`research/python`) | F2.5b y F2.6 |
| **F2.7** Backtest | `F2-BACKTEST-001`, `F2-AUDIT-001` (backtests) y `F2-GOV-001` (`apps/backtest`) | F2.5, F2.6 y F2.6b |
| **F2.8** Evaluación | `F2-EVAL-001`, `F2-SEARCH-001` (correcciones por búsqueda y congelaciones) y `F2-AUDIT-001` (propuestas, registros previos, evaluaciones y aprobaciones; la congelación de las propuestas llega aquí, ADR-0023 §6) | F2.7 |
| **F2.9** Motor shadow y registro de señales | `F2-SHADOW-001`, `F2-SIGNAL-001`, `F2-STOP-001`, `F2-AUDIT-001` (activaciones, detenciones y reanudaciones) y `F2-GOV-001` (`apps/signal-engine`) | F2.8 |
| **F2.10** Posiciones, comparación y réplica | `F2-POSITION-001` y `F2-REPLAY-001` | F2.9 |
| **F2.11** Puerta de salida | la evidencia de §13 | F2.10 |

- La captura empieza en F2.2, lo antes posible, para que los datos se acumulen mientras avanza lo demás. Por lo mismo, F2.5b va antes que los demás incrementos nuevos: el motor `shadow` solo puede seguir el oro desde que buoh lo captura, y sus umbrales necesitan 7 días de esa captura.
- F2.2 se cierra con su evidencia de 7 días. F2.3 no la espera: empieza en cuanto la captura corre en producción. F2.5 sí espera esos 7 días.
- F2.4 no espera el último PR de F2.3, el 7c, que solo reúne la memoria y el tráfico de salida de `buoh-api` de varios días (ADR-0019 §14). Para no mezclar su tráfico con esa medición, ninguna lectura de R2 de F2.4 llega a producción antes del 2026-11-08. Lo decidió el propietario el 2026-11-04. Los días que copia el 7c terminan antes del primer despliegue de F2.4 que lee R2.
- La sección Datos de F2.4 (el 6b del [historial de entregas](historial-de-entregas.md)) va después de la ADR de datasets vivos de F2.5, que decide dónde viven los datasets de producción y cómo se guarda su verificación (ADR-0018 §7). Hasta entonces, su lector solo podría leer las tablas de publicación de cada log, donde producción no publica. Así, F2.4 termina después de esa ADR. Esa ADR es [ADR-0020](../arquitectura/adr/0020-datasets-vivos.md), y la sección Datos llega después de su PR 4, cuando el esquema de los datasets existe en producción (§13).
- Cada incremento se entrega en PR pequeños, con una revisión semántica cada uno, y desde F2.3 el propietario lo usa en la web.
- Los PR 2 a 4 de F2.7 (la vista de cada instante, los contratos del backtest y `apps/backtest`) van antes del PR 4 de ADR-0023, que lee de la vista las series del motor de investigación. Necesitan F2.5, el PR 4 de ADR-0021 y los PR de ADR-0022 que citan, no F2.6b; el resto de F2.7 sigue esperando F2.6b ([ADR-0024](../arquitectura/adr/0024-semantica-del-backtest.md) §12).
- Ningún incremento deja componentes futuros vacíos.

### Comandos

Los comandos raíz de la Fase 1 conservan su contrato (plan de Fase 1, §5). La fase añade uno:

| Comando raíz | Se introduce | Comportamiento |
|---|---|---|
| `pnpm run decisions:replay -- --from <UTC> --to <UTC> --json` | F2.10 | reproduce desde datasets publicados las decisiones del motor del período y emite cuántas coinciden y cuáles no (`F2-REPLAY-001`), sin contactar a Deriv |

Los demás comandos de la fase, como la publicación de datasets vivos o las mediciones de la evidencia, son scripts de su paquete, fuera de este contrato, como `ingest` en la Fase 1 (ADR-0015 §7), y su ADR fija su nombre y su salida.

## 10. Matriz de pruebas y evidencia

| Categoría | Bloquea la fusión | Fuente | Evidencia |
|---|---:|---|---|
| Unitarias y de propiedades | sí | contratos, dominio y `strategy-sdk` | salida reproducible |
| Vectores sintéticos | sí | `test-vectors/` | decisiones, posiciones, métricas y hashes esperados |
| Equivalencia del punto de control | sí | dominio y worker | el mismo resultado en cada límite de segmento |
| Integración local | sí | PostgreSQL y S3 locales | punto de control, roles, API con su base de datos y publicación |
| Seguridad de la API | sí | `apps/api` | sesiones, CSRF, autorización por cuenta, cabeceras y ningún secreto |
| Accesibilidad | sí | sistema de diseño y web | contraste de los gráficos y su alternativa en texto |
| Memoria | sí, en los requisitos con techo | medición reproducible | máximo de RSS |
| Ensayos en producción | no por sí solos | Render y R2 | días de captura, salud, memoria y costo |
| Réplica de decisiones | sí, en la puerta de salida | datasets publicados | decisiones que coinciden y que no |
| Paridad entre Python y TypeScript | sí | vectores compartidos de `test-vectors/` | las mismas decisiones en los dos evaluadores |
| Controles negativos de la búsqueda | sí | R_100 y series al azar sintéticas | no más candidatas aprobadas de las que da el azar |

Un ensayo en vivo o en producción nunca sustituye una prueba sin red, porque la red y el mercado no son deterministas.

## 11. Presupuesto

| Servicio | Llega en | Costo aproximado al mes |
|---|---|---|
| Render Postgres Basic-256mb, con 1 GB de disco | F2.2 | 6,30 USD |
| Background worker Starter para `ingest` | F2.2 | 7 USD |
| Cron job de Render para las operaciones del sistema de datos (ADR-0018 §11) | F2.2 | 1 USD, el mínimo |
| Cloudflare R2 | F2.2 | 4,50 USD; unos 13,50 con el oro en vivo (F2.5b, estimación) |
| Servicio web Starter para la API y la web | F2.3 | 7 USD |
| VPS-2 de OVHcloud para el motor de investigación y los backtests de su búsqueda (ADR-0023 §12) | F2.6b | unos 10 USD |
| Background worker Starter para el motor `shadow` | F2.9 | 7 USD |
| Lecturas de R2 y tráfico de salida del motor `shadow` ([ADR-0026](../arquitectura/adr/0026-motor-de-senales-shadow.md) §10) | F2.9 | unos 2 USD (estimación) |

En total, unos 50 USD al mes, que aprobó el propietario el 2026-11-16 («2 si», a la pregunta de si aprobaba subir el gasto de unos 26 a unos 50 USD al mes), unos 51 con el disco de 5 GB, que aprobó el mismo día, y unos 54 con lo que suman el oro y los lotes en R2 y en el tráfico de salida de Render ([ADR-0021](../arquitectura/adr/0021-mercados-reales-y-fuentes-de-investigacion.md) §6), que aprobó también ese día («ya hice merge apruebo 54 usd al mes»), y unos 56,50 con el VPS-2 de OVHcloud en lugar del de Contabo, de unos 8 USD, que el propietario eligió ese día conociendo su precio («Elijo el de ovh»), y con lo que lee y guarda el motor en R2, hasta unos 0,50 USD, que aprueba al fusionar ADR-0023, que lo cuenta en su §12, y unos 58,50 con las lecturas de R2 del motor `shadow` y su tráfico de salida, que aprobó el 2026-11-24 («Ok opcion A, creo que es mas efectiva»; [ADR-0026](../arquitectura/adr/0026-motor-de-senales-shadow.md) §10); antes del cambio de alcance eran unos 33 (§12). La base, el worker de `ingest`, R2 y la API son los unos 22 USD que aprobó el propietario (ADR-0016 §2), más los unos 3 USD de R2 que aprobó el 2026-10-31 al conocer el redondeo de Cloudflare («ok aprueba apcion a, sigue trabajando», y «A» al confirmarlo; ADR-0018 §14). El cron job lo aprobó el 2026-10-31 («la respuesta nro 2, apruebo 1 usd mas»), y el servidor del motor el 2026-10-29 («1. Si, un servidor pequeño para el bot»), que se compra con F2.9. Desde el cambio de alcance, los backtests de la búsqueda corren en el VPS, y la réplica y la prueba fuera de muestra, en la API, sin costo aparte. ADR-0023 §12 cuenta las lecturas, las escrituras y el espacio del motor en R2, como mucho unos 0,50 USD al mes; ADR-0021 §6 cuenta los de la historia descargada, las lecturas de clase B y el tráfico de salida que suman el oro y los lotes, unos 3 USD más al mes (estimación). Los precios son los que comprobó ADR-0016, y los del VPS y del oro, los del 2026-11-16 (§3); se confirman al comprar.

La línea de R2 es la de ADR-0018 §14 para la captura y `data:health`: R2 redondea el uso al millón siguiente, así que, con unos 1,35 millones de operaciones de clase A al mes, lo que pasa del millón gratuito se cobra como un millón entero. Con el oro en vivo, que manda un tick por segundo mientras cotiza, y las cotizaciones de Deriv, son unos 3,45 millones al mes y se cobran 3: unos 13,50 USD (estimación, ADR-0021 §6). No incluye las lecturas de la API ni del motor de investigación; las del motor `shadow` tienen su fila. El tráfico de salida de Render tampoco está medido: ADR-0018 §13 lo estima en unos 0,30 USD al mes por encima de lo incluido, y F2.2, F2.3 y F2.9 lo miden. Si lo medido no cabe en este presupuesto, se presenta al propietario antes de seguir (§4, punto 8).

Pueden sumarse, si sus ADR los eligen y el propietario los aprueba:

- el disco de PostgreSQL de 5 GB, 1,50 USD en lugar de 0,30, ya aprobado el 2026-11-16 para capturar el oro y sumado arriba (`F2-MARKET-001` y §12);
- el worker Standard, unos 18 USD más, si el punto de control no basta (ADR-0016, «Consecuencias»).

## 12. Decisiones del propietario durante la fase

| Decisión | Materia | Se pide en |
|---|---|---|
| Servidor propio para el motor `shadow`, unos 7 USD más al mes | dinero | decidida el 2026-10-29: sí (§11) |
| Región de Render y de R2, que luego no se puede cambiar | producto y dinero | decidida el 2026-10-31: Virginia (EE. UU. este), con la indicación de ubicación `enam` para R2 (ADR-0018 §1) |
| Retención y tamaño del disco, si suben el presupuesto | dinero | delegada el 2026-10-31 en la dirección técnica, sin subir el presupuesto. Como los términos de Deriv solo permiten tener sus datos en caché 24 horas, el propietario decidió ese día: 30 días igualmente (ADR-0018 §7) |
| Si el agente recibe un acceso de solo lectura a producción, o si la evidencia llega solo por el propietario (§4, punto 10) | seguridad | decidida el 2026-10-31: acceso, también total; el agente usa el mínimo que necesite cada tarea (§4, punto 10), y la base de datos queda abierta a internet (ADR-0018 §9 y §12) |
| Un cron job de Render para las operaciones del sistema de datos, unos 1 USD más al mes | dinero | decidida el 2026-10-31: sí (§11 y ADR-0018 §11) |
| El costo de R2 con el redondeo de Cloudflare, unos 3 USD más al mes | dinero | decidida el 2026-10-31: sí, unos 19 USD al mes para el sistema de datos (§11 y ADR-0018 §14) |
| Cómo inicia sesión el propietario | seguridad | decidida el 2026-11-02: con una contraseña de buoh y un código de 6 cifras de una app de autenticación ([ADR-0019](../arquitectura/adr/0019-api-cuentas-y-auditoria.md) §1) |
| Qué idiomas tiene el producto, para la preferencia de idioma del catálogo | producto | decidida el 2026-11-04: en español («sera en espanhol»), que el agente toma como la opción que recomendó, solo español. F2.4 guarda por cuenta solo el tema, y el selector de idioma llega con un segundo idioma (`F2-UI-001`) |
| Cuánto se guardan los datasets vivos, que no cita ninguna evidencia | riesgo y producto | decidida el 2026-11-13: «B», todos, sin vencer, y se revisa cuando R2 pasa de 8 GB; la dirección técnica añade la misma revisión cuando la base pasa de 600 MB ([ADR-0020](../arquitectura/adr/0020-datasets-vivos.md) §6) |
| Qué tipo de operación representan las posiciones hipotéticas, dentro de lo que ofrece Deriv | producto | decidida el 2026-11-16: multiplicadores y sube/baja, sin dígitos («prefiero multiplicadores y sube y baja, dejar fuera los digitos»); los demás tipos quedan fuera hasta otra decisión |
| Quién busca las estrategias | producto | decidida el 2026-11-16: un motor de investigación que prueba millones de estrategias y busca patrones, siempre buscando rentabilidad, en Python y en un VPS de Contabo de unos 7 EUR al mes (§1, §4.7 y §11; sus palabras, en las [decisiones vigentes](../gobierno/decisiones-vigentes.md)). El mismo día eligió el VPS-2 de OVHcloud (fila «Qué VPS»). Que él autorice cada estrategia que pasa al bot es una propuesta de la dirección técnica, que aprueba al fusionar este plan (§1) |
| Dónde se opera primero y cuánto dura cada operación | producto y riesgo | decidida el 2026-11-16: en Deriv, y MT5 después; la duración la decide cada estrategia, de segundos a horas |
| La caída máxima de una estrategia | riesgo | decidida el 2026-11-16: el 50 % de su capital, en el backtest, en `shadow` y en demo, y demo antes que dinero real. El agente recomendaba el 20 % y le explicó el riesgo. El límite para dinero real se decide antes de la Fase 5 |
| Qué mercados y cuánto se guardan | producto, riesgo y dinero | decidida el 2026-11-16: R_100 y el oro en vivo, y siete mercados en velas (`F2-MARKET-001`), guardados todo el tiempo para uso propio, aunque los términos de Deriv solo permiten 24 horas |
| Inteligencia artificial y clientes | producto | decidida el 2026-11-16: primero reglas y la inteligencia artificial después, que la dirección técnica sitúa después de la puerta de salida; sin clientes por ahora |
| El disco de PostgreSQL de 5 GB, unos 1,20 USD más al mes | dinero | decidida el 2026-11-16: sí, antes de capturar el oro (`F2-MARKET-001`; sus palabras: «apruebo los 1.20 usd mas, el vps lo adminsitro yo con tu ayuda y yo solo tengo acceso a él,  una estrategia que se paro por datos manos vuelve a arrancar sola») |
| Quién administra el VPS y quién tiene su acceso | seguridad | decidida el 2026-11-16: lo administra el propietario, con la ayuda del agente, y solo él tiene acceso; el agente no lo recibe |
| Qué VPS, con qué sistema y si lo demás sigue en Render | dinero y seguridad | decidida el 2026-11-16: el VPS-2 de OVHcloud, unos 10 USD al mes, en lugar del de Contabo («Elijo el de ovh»), seguir en Render («Ok seguimos en render») y Linux, con Ubuntu 26.04 LTS, que le recomendó el agente («Ok escribe la adr del motor perfecto»; sus palabras, en las [decisiones vigentes](../gobierno/decisiones-vigentes.md), «VPS del motor de investigación»). La región es una propuesta de ADR-0023 (§8), y la medición de `F2-RESEARCH-001` dice si hace falta el VPS-3 (ADR-0023 §11) |
| El presupuesto con el motor | dinero | decidida el 2026-11-16: unos 50 USD al mes, unos 51 con el disco de 5 GB y unos 54 con lo que suma ADR-0021 (§11); unos 56,50 con ADR-0023: el VPS de OVHcloud, que eligió con su precio, y R2, que aprueba al fusionarla (§11); unos 58,50 con las lecturas de R2 del motor `shadow`, decidido el 2026-11-24 (fila siguiente) |
| Las lecturas de R2 del motor `shadow`, que lee cada evento de la captura al llegar, unos 2 USD más al mes | dinero | decidida el 2026-11-24: sí, la opción A, con la medición de su PR 6 («Ok opcion A, creo que es mas efectiva»; [decisiones vigentes](../gobierno/decisiones-vigentes.md), «Lecturas de R2 del motor *shadow*»; [ADR-0026](../arquitectura/adr/0026-motor-de-senales-shadow.md) §10) |
| Cómo se reanuda una estrategia `shadow` detenida: a mano, como pide hoy el protocolo §5, o sola tras las degradaciones breves que la historia cubre, lo que cambia el protocolo. Las dos adelantan para `shadow` el «Volver a encender» del catálogo (`F2-STOP-001`) | riesgo y producto | decidida el 2026-11-16: sola, cuando los datos vuelven a estar bien, a la pregunta «a mano o sola». La dirección técnica la aplica a toda detención por datos degradados del motor `shadow`, sin límite de duración; las demás siguen siendo a mano (`F2-STOP-001`). En demo y con dinero real se decide con su política de riesgo (`PROJECT_STATUS.md`, «Decisiones pendientes») |
| El worker Standard, si el punto de control no cumple `F2-CHECKPOINT-001` | dinero | solo si pasa |

Cada decisión se pide con sus opciones y una recomendación, y el PR que la usa registra cuándo y con qué palabras la dio (AGENTS.md, «Fusión»).

## 13. Definition of Done

La Fase 2 está `done` únicamente cuando:

- todos los requisitos `F2-*` tienen evidencia fusionada;
- el sistema de datos cumple `F2-DEPLOY-001` durante toda la ventana de la puerta de salida;
- una estrategia propuesta por el motor de investigación, o su candidata de demostración si ninguna pasa la búsqueda honesta (`F2-SEARCH-001`), aprobada por el propietario, sumó en `shadow`, en producción, al menos 7 días en `active`, sin contar sus pausas, y cada una de sus decisiones de esa ventana se reprodujo con el mismo registro desde datasets publicados y versiones fijados (`F2-REPLAY-001`);
- en esa ventana el motor se detuvo sin intervención ante cada degradación de los datos, natural o provocada en un ensayo de la puerta, y cada reanudación siguió su regla (`F2-STOP-001`);
- esa estrategia tiene su informe completo de backtest, validación, prueba fuera de muestra y `shadow`, también si es negativo. La puerta no exige ganancias. Exige que la estrategia haya pasado la puerta `reviewed` → `shadow` del protocolo §4, con su criterio de promoción registrado antes de ver resultados (protocolo §1), sea cual sea ese criterio;
- el costo mensual medido está dentro del presupuesto aprobado;
- `PROJECT_STATUS.md`, los contratos, las ADR, los runbooks y el catálogo de funciones describen el sistema real.

## 14. Riesgos y preguntas no bloqueantes

- **Memoria.** Si el punto de control no baja la memoria lo bastante, el worker Standard cabe sin cambiar el código, pero sube el total en unos 18 USD al mes (§12).
- **Datos suficientes.** Deriv da un año de velas y de ticks (§3), y la prueba fuera de muestra usa datos posteriores a cada congelación (`F2-EVAL-001`). Si al llegar F2.8 no bastan, la evaluación espera a que se acumulen.
- **El motor puede no encontrar nada.** R_100 es azar por diseño, y en los mercados reales nadie sabe antes si hay algo viable después de los costos. La puerta de salida no exige ganancias (§13), y un informe negativo es un resultado válido.
- **La CPU del VPS.** El VPS-2 de OVHcloud tiene 4 vCores. Si el motor no cumple el criterio de ADR-0023 §11, el agente le propone al propietario el VPS-3. Con el plan B, Contabo avisa de que su CPU rinde menos con mucha carga: el motor probaría menos por día, sin cambiar sus resultados.
- **Un servidor propio.** ADR-0016 descartó uno para el sistema de datos, porque el propietario, que no es programador, tendría que mantenerlo. El VPS vuelve solo para la investigación, sin poder escribir en la captura, en los datasets ni en la base, ni tocar un bróker; solo registra en la API lo que permite su credencial. Lo administra el propietario, con la ayuda del agente, y solo él tiene acceso (§12). La dirección técnica propone que el agente le prepare los scripts y los pasos y que las actualizaciones de seguridad sean automáticas. Cada versión nueva del motor se instala sola desde `main`, con CI en verde y fusionada por el propietario (ADR-0023 §9), en lugar de que él la instale con un comando, como proponía antes este plan. La evidencia del VPS llega por `buoh-investigacion` y por la API, y el agente la lee con un token de solo lectura de ese bucket (ADR-0023 §10). Un VPS comprometido podría leer lo que leen sus credenciales y dejar propuestas falsas, que la réplica en la API descubre antes de `shadow` (`F2-API-001`).
- **La API está en internet.** Su seguridad se revisa en cada PR, y la seguridad conserva la revisión humana del propietario (CONTRIBUTING.md).
- **Render Postgres Basic-256mb** (0,1 CPU y 256 MB) atiende la captura, la API y el motor a la vez. Si no alcanza, subir de plan necesita al propietario.
- **Región.** La de Render no se puede cambiar después de crear un servicio (ADR-0016 §4).
- **Deriv puede cambiar su API.** La release de esquemas sigue fijada ([ADR-0004](../arquitectura/adr/0004-pipeline-y-reproduccion-de-datos-fase-1.md) §2), y el smoke detecta la deriva.
- **Universo.** El universo definitivo de índices y tipos de contrato sigue pendiente. La fase trabaja con R_100 y el oro en vivo, siete mercados en velas, y multiplicadores y sube/baja (§12).
