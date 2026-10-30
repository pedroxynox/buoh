---
plan_id: "F2-LAB"
schema_version: "1.0.0"
status: "active"
effective_when_merged: true
owner: "propietario de buoh"
last_reviewed_utc: "2026-10-30T00:39:13.000Z"
---

# Plan ejecutable: Fase 2 — Laboratorio y bot shadow para uso propio

## 1. Objetivo

Transformar una hipótesis en una estrategia viva, explicable y no ejecutora, para uso propio ([roadmap](../producto/roadmap.md), Fase 2). La fase termina cuando una estrategia en modo `shadow` reproduce cada decisión desde datos y versiones fijados y se detiene sola ante una degradación de los datos (§13).

Para llegar ahí, el sistema de datos de la Fase 1 pasa a un servidor y funciona todo el día ([ADR-0016](../arquitectura/adr/0016-alojamiento-del-sistema-de-datos.md)). El propietario entra en buoh con su cuenta, crea y versiona estrategias y las prueba sobre datos pasados, con entrenamiento, validación y prueba fuera de muestra. Después, el bot las sigue en vivo con señales y posiciones hipotéticas, sin enviar órdenes.

La Fase 2 no intenta demostrar una estrategia rentable. Un resultado negativo es un resultado válido y se muestra entero.

## 2. Estado y aprobación

`active` desde su fusión. Autoriza los incrementos F2.1 a F2.11 de §9, cada uno con los directorios del corte (§6) y después de su ADR (§8). Un directorio o una dependencia no existe hasta que llega su incremento (AGENTS.md, «Desarrollo por fases»).

El propietario aprueba el plan al fusionarlo. Las decisiones suyas que la fase todavía necesita están en §12, con el incremento en que se piden.

## 3. Punto de partida

Hechos comprobados al cerrar la Fase 1 y al decidir el alojamiento ([`PROJECT_STATUS.md`](../../PROJECT_STATUS.md) y ADR-0016):

- **Captura.** `ingest` captura R_100 sobre PostgreSQL y almacenamiento de objetos, pero no corre en ningún servidor: rechaza `staging` y `production` y para a las 23 horas para borrar la captura antes de las 24 ([ADR-0015](../arquitectura/adr/0015-reconexion-recuperacion-y-salud-f1-5.md) §7).
- **Memoria.** El arranque, la vigilancia de huecos y `data:health` leen y derivan el log durable entero. Con 17,8 horas de log, `ingest` llegó a 358 MB y `data:health` a 317 MB, y el worker Starter tiene 512 MB (ADR-0016, «Medición»). La reparación de cierres no registrados, que corre antes de cada reconexión, también lee el log entero (`RawFirstIngestor.repairUnrecordedClose`), aunque ADR-0016 no la nombra.
- **Un mes de datos.** Con la derivación de hoy, todo en memoria, un mes de R_100 ocuparía unos 10 GB (ADR-0016, «Consecuencias»). La publicación y `data:replay` también cargan el dataset entero, y `normalized_ticks` y `quality_incidents` son un solo objeto que crece con el dataset (pendiente 2 de F1.3). Con unos 500 bytes por tick y un tick cada 2 s, son unos 21 MB al día, así que ese objeto pasaría en unos 12 días los 256 MiB que acepta el replay (estimación, sin medir).
- **Costo de `data:health`.** Cada ejecución lee de R2 cada segmento cerrado y cada evento del segmento abierto. Con un día de log, ejecutarlo cada 5 minutos son unos 7,5 millones de lecturas al mes, que casi caben en lo gratuito; cada minuto serían unos 37 millones, unos 11 USD más al mes (ADR-0016, «Consecuencias»).
- **PostgreSQL.** El worker usa un único rol, dueño de las tablas (pendiente 4 de F1.3). En ejecución solo inserta y lee, y `db:migrate` usa las mismas credenciales.
- **Datasets vivos.** No se publican mientras no haya umbrales live de retraso y de hueco, que se fijan con mediciones reales («Decisiones vigentes relevantes»). El perfil de Deriv es de medición, y la publicación lo rechaza.
- **Gráficos.** P-V1-04 de la [especificación de pendientes](especificacion-de-pendientes.md) propone resolver su accesibilidad, sus pruebas y sus unidades antes de mostrar datos reales.
- **Lo que no existe.** API, cuentas, estrategias, backtests, señales, posiciones y `execution-gateway`. `HealthReport` solo admite `execution_mode = disabled`, y `StrategyDefinition` y `SignalEvent` solo están nombrados ([contratos de dominio](../arquitectura/contratos-de-dominio.md), «Contratos futuros»).
- **Alcance ya decidido.** La Fase 2 empieza solo con R_100, y el alojamiento cuesta unos 15 USD al mes, unos 22 con la API (ADR-0016 §2).

## 4. Restricciones de la fase

Decisiones de la dirección técnica que cumplen todas las ADR y todos los incrementos de la fase:

1. **Un solo evaluador.** El backtest y el motor `shadow` usan la misma función pura para evaluar una estrategia, con la misma forma de entrada. Una estrategia no puede saber si corre en vivo o en una réplica.
2. **Cada decisión en su instante.** Una decisión usa solo lo que era durable antes de ella, en el orden del log. Lo que se sabe después, como la marca de un hueco que se añade a un tick anterior, no cambia una decisión ya tomada, tampoco al reproducirla.
3. **Datos fijados.** Un backtest solo lee datasets publicados, por su `dataset_id`. El motor `shadow` lee la captura viva, y cada decisión guarda lo necesario para reproducirla después desde datasets publicados.
4. **Memoria acotada.** Todo proceso que lee datos los lee por partes, con un techo de memoria que no depende de cuántos datos haya.
5. **Planos separados.** Los datos (`ingest`), la investigación (la API y sus backtests) y las señales (el motor `shadow`) corren en procesos y servicios distintos, cada uno con sus credenciales mínimas. No hay ejecución: el modo más alto es `shadow`, nada se autentica en Deriv y no existe `execution-gateway` ([ADR-0002](../arquitectura/adr/0002-senales-y-ejecucion-controlada.md)).
6. **Uso propio.** En producción solo existe la cuenta del propietario, y no hay registro público. Abrir cuentas a otras personas es de la beta externa ([modelo de lanzamiento](../producto/modelo-de-lanzamiento.md), etapa 3) y necesita antes revisar la redistribución de los datos de Deriv, que ADR-0004 §13 deshabilita.
7. **TypeScript.** El evaluador, el backtest y la estadística de la fase son TypeScript, para que la réplica use el mismo código que el bot. ADR-0001 (decisión 3) y ADR-0003 limitan Python a la investigación por lotes, pero no la exigen: Python entra cuando una ADR demuestre una necesidad que TypeScript no cubra.
8. **Presupuesto.** Todo cabe en el presupuesto aprobado (§11). Lo que lo suba necesita antes el visto bueno del propietario.
9. **Un solo entorno desplegado.** No hay `staging` en la Fase 2, porque no cabe en el presupuesto: todo corre en `production`, y el motor, con `execution_mode = shadow`. La preproducción de la arquitectura objetivo describe el destino.
10. **Evidencia de producción.** El agente no tiene acceso a Render ni a Cloudflare (ADR-0016 §3). Las cifras de producción que pide la evidencia las calcula buoh en producción, sin secretos ni precios, y llegan al repositorio por el canal que fije la ADR de despliegue, por ejemplo una página de evidencia de la web que abre el propietario o los paneles que copia con los pasos del runbook. Dar al agente un acceso de solo lectura a producción es una decisión de seguridad del propietario (§12).

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
apps/api/                # F2.3: API Fastify, cuentas, sesiones, laboratorio y backtests; sirve la web
packages/strategy-sdk/   # F2.6: modelo de estrategia, indicadores y evaluador puros
apps/signal-engine/      # F2.9: motor de señales shadow
```

`packages/strategy-sdk` toma el nombre de la [arquitectura objetivo](../arquitectura/arquitectura-objetivo.md): la interfaz restringida de estrategia, sin red ni secretos.

### Ampliar

- `apps/market-data-worker`: el punto de control, el despliegue y la publicación de datasets vivos.
- `packages/domain`: la derivación desde un punto de control y la vista de los datos en el instante de cada decisión.
- `packages/contracts`: los contratos de la fase (punto de control, estrategia, backtest, evaluación, señal, posición hipotética y auditoría), con su JSON Schema generado.
- `apps/web`: pantallas con datos reales, que sustituyen sección a sección los datos ficticios.
- `render.yaml` y su prueba: los servicios del sistema de datos, de la API y del motor.
- `test-vectors/`: vectores sintéticos de estrategia, backtest y réplica.

La API y el motor necesitan leer el log y los datasets con el código del worker. La ADR de la API y las cuentas (§8) decide si lo importan de `@buoh/market-data-worker` o si ese código pasa a un paquete propio. Si es un paquete, su PR lo añade a este corte.

### Diferido explícitamente

- `execution-gateway`, `packages/risk-policy`, la autorización OAuth de Deriv, las cuentas de bróker y los modos `demo` y `real` (Fases 4 a 6).
- Alertas, notificaciones y la app móvil con datos reales (Fase 3). El prototipo móvil sigue con datos ficticios.
- La app de escritorio con datos reales. Su plan se escribe aparte cuando existan la API y las pantallas de F2.3 y F2.4, y entonces se revisa la decisión 6 de ADR-0001 (`PROJECT_STATUS.md`). Hasta entonces, el prototipo de escritorio sigue con datos ficticios, sin cambiar [ADR-0010](../arquitectura/adr/0010-prototipo-de-escritorio.md): como empaqueta la exportación de `apps/web` y su política de contenido no deja llamar a la API, F2.4 mantiene para él, en `apps/web/out`, una exportación con los datos ficticios (`F2-UI-001`).
- Más símbolos que R_100: el universo sigue pendiente.
- Suscriptores, pagos y registro público (Fase 3B).
- Python, TimescaleDB, Redis y un writer Parquet, salvo que una ADR de la fase demuestre que hacen falta.
- Datos de MetaTrader 5 (Fase 1B).

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
- `render.yaml` describe los servicios, y su prueba los fija. La región elegida queda registrada, y las credenciales solo existen como variables `BUOH_*` de cada servicio;
- cada proceso tiene su token de R2, limitado al bucket de su entorno y a lo que hace: `ingest` y, si es otro, el proceso que publica datasets (`F2-DATASET-001`) leen y escriben, y `data:health`, la API y el motor solo leen. La ADR fija el cifrado de la conexión a PostgreSQL, y una prueba comprueba que el worker lo aplica; la API y el motor lo comprueban en su incremento;
- la ADR fija dónde y cada cuánto corre `data:health`, con su costo en R2 calculado, y si una parada programada, como un despliegue, recupera su historia, algo que ADR-0015 §10 dejó para el plan de alojamiento;
- evidencia de 7 días seguidos de captura en producción, por el canal de §4, punto 10. `data:health` da `healthy` salvo en episodios registrados con su causa. La memoria máxima medida en Render no pasa de 256 MB, la mitad del Starter. Las operaciones de R2 y el tráfico de salida medidos caben en el presupuesto de §11;
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
- guardar más de lo que cabe en el presupuesto, como pasar el disco de PostgreSQL de 1 a 5 GB, necesita antes el visto bueno del propietario (§12).

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

### `F2-API-001` — API de buoh

`apps/api` (Fastify, ADR-0001) es la única entrada de la web a los datos y al laboratorio. Corre como servicio web de Render y sirve también la exportación de `apps/web`, desde el mismo origen.

**Aceptación:**

- toda entrada y toda salida se validan con contratos de `packages/contracts`, y su descripción OpenAPI se genera desde ellos;
- lee el sistema de datos con un rol de PostgreSQL y un token de R2 de solo lectura, y solo escribe en sus propias tablas;
- ninguna respuesta, registro o error contiene secretos, tokens ni credenciales, y las pruebas lo comprueban;
- todas las respuestas llevan cabeceras de seguridad y una política de contenido, sin recursos de terceros;
- un backtest corre aislado del proceso que atiende las peticiones, con límites de memoria y de tiempo, y su fallo no tumba la API. Corre como mucho uno a la vez, y la memoria máxima del servicio con un backtest en curso, medida en Render, no pasa de 435 MB, el 85 % del Starter;
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

Un registro append-only guarda quién hizo qué y cuándo: inicios de sesión, versiones y cambios de ciclo de vida de las estrategias, registros previos, backtests, evaluaciones, y activaciones, detenciones y reanudaciones del motor.

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
- las preferencias de la Fase 2 del [catálogo de funciones](../producto/funciones-y-disponibilidad.md) se guardan por cuenta: el tema noche o día y el idioma, con los idiomas que decida el propietario (§12). Las preferencias de notificaciones llegan con la Fase 3, que trae las alertas y sus permisos y preferencias ([roadmap](../producto/roadmap.md), Fase 3);
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

- la ADR del modelo de estrategia fija la gramática de reglas, la biblioteca de indicadores (cada uno con su definición matemática, sus unidades y sus vectores), los parámetros con sus rangos, el modelo de posición hipotética, los costes y supuestos, el vencimiento de cada señal, los límites de frecuencia y la política de datos que decide cuándo se detiene la estrategia (`F2-STOP-001`);
- la identidad de una versión es el hash de su contenido: cambiar cualquier cosa crea otra versión, y nada se modifica en su lugar. Cada versión lleva además su versión semántica y su propietario responsable ([seguridad y rigor](../gobierno/seguridad-y-rigor-cuantitativo.md) §2);
- una definición inválida se rechaza con errores estructurados;
- el evaluador es puro y determinista: los vectores fijan sus decisiones, y sus pruebas prohíben red, reloj real y azar, como `F1-VECTOR-001`. Sin azar no hace falta semilla; si una ADR introduce azar, lo inyecta con una semilla registrada;
- el ciclo de vida (`draft`, `reviewed`, `active`, `paused`, `retired`) avanza solo con las puertas del [protocolo de validación](../gobierno/protocolo-de-validacion-de-estrategias.md) §4, y cada cambio queda en la auditoría. La puerta `reviewed` → `shadow` del protocolo pone la estrategia en `active` con `execution_mode = shadow`, y la estrategia declara ese modo ([operación y control de riesgo](../gobierno/operacion-y-control-de-riesgo.md) §2). Como la promoción crea una versión nueva (seguridad y rigor §2), la ADR del modelo de estrategia fija cómo la versión en `shadow` queda ligada a la evidencia de la versión congelada;
- la sección Laboratorio de la web crea, versiona y revisa estrategias. Nunca edita una versión existente: guardar un cambio crea otra.

### `F2-BACKTEST-001` — Backtest reproducible por partes

Un backtest evalúa una versión de estrategia sobre datasets publicados, con el evaluador del motor `shadow` (§4).

**Aceptación:**

- la ADR de la semántica del backtest fija cómo se reconstruye cada instante de decisión desde los source events del dataset (§4, punto 2), qué entradas forman la identidad del backtest y cómo trata los datos degradados según la política de datos de la estrategia;
- su identidad es el hash de sus entradas: versión de estrategia, parámetros, `dataset_id`, rango, versión del motor, costes y supuestos. El entorno de ejecución (versiones de Node y de los contratos) se guarda junto al resultado, fuera de la comparación: repetirlo con las mismas entradas da las mismas decisiones, posiciones y métricas, byte a byte;
- lee los datos por partes, cada una verificada por su hash antes de usarla, y un backtest de 30 días sintéticos de R_100 no pasa de 256 MB;
- declara costes, latencia y supuestos, y cuenta las decisiones que la política de datos dejó sin tomar;
- vectores sintéticos fijan las decisiones, las posiciones y las métricas esperadas, también con huecos, duplicados y ticks fuera de orden;
- una versión de datos o de perfil que no soporta se rechaza, sin adivinar;
- la sección Laboratorio de la web pide un backtest y muestra su resultado, cada cifra con su modo (`backtest`) y su contexto completo (concepto de interfaz §4, «Métrica con contexto»).

### `F2-EVAL-001` — Entrenamiento, validación y prueba fuera de muestra

La evaluación sigue el protocolo de validación, con las reglas medibles que fije la ADR del protocolo estadístico.

**Aceptación:**

- antes de validar, la estrategia tiene un registro previo inmutable con lo que pide el protocolo §1: entre otras cosas, los `dataset_id`, las ventanas de entrenamiento, validación y prueba fuera de muestra en UTC, en orden y sin solaparse, la métrica principal, la línea base y los criterios de promoción, pausa y retiro;
- la prueba fuera de muestra se ejecuta una sola vez por versión congelada. Un segundo intento se rechaza y queda en la auditoría;
- el informe trae todas las métricas del protocolo §3, la comparación con la línea base, la sensibilidad a parámetros y a ventanas y cuántas variantes se probaron;
- una estrategia sin muestra, costes, línea base o prueba fuera de muestra sale como «no validada» (protocolo §3);
- antes de pasar a `shadow`, el backtest de la versión congelada se repite y da el mismo resultado: es la réplica del ciclo de seguridad y rigor §2;
- un vector sintético en el que la estrategia gana en entrenamiento y pierde fuera de muestra produce exactamente ese informe;
- desde la sección Laboratorio de la web, el propietario guarda el registro previo, pide la evaluación, la prueba fuera de muestra y la puerta `reviewed` → `shadow`, y ve el informe de evidencia, cada cifra con su contexto.

### `F2-SHADOW-001` — Motor de señales shadow

`apps/signal-engine` sigue en vivo las estrategias `active` en modo `shadow`, sobre la captura de producción, en un servicio propio (§11).

**Aceptación:**

- lee la captura con un rol de solo lectura, desde el punto de control (`F2-CHECKPOINT-001`), y solo escribe en sus tablas append-only;
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
- la comparación usa la prueba de deriva que fije la ADR del protocolo estadístico, con la cadencia que fije la ADR del motor. Una deriva material es causa de pausa (protocolo §5);
- el informe de la estrategia, en la sección Laboratorio de la web, muestra juntos el backtest, la validación, la prueba fuera de muestra y el `shadow`, cada cifra con su modo y su contexto.

### `F2-STOP-001` — Detención ante datos degradados

El motor deja de decidir por una estrategia en cuanto sus datos dejan de cumplir la política de datos de la estrategia, sin esperar a nadie. Detenerse es pausar: la estrategia pasa a `paused`, con su causa (protocolo §5).

**Aceptación:**

- se detiene, al menos, con la salud de los datos distinta de `healthy`, con una condición `connection_lost` o `event_gap_unresolved` abierta, con la continuidad pendiente, con datos más viejos que el máximo de la estrategia y con un perfil o un esquema distinto del registrado;
- cada detención queda registrada con su causa y su instante, y se reproduce como cualquier otra decisión (`F2-REPLAY-001`);
- la reanudación sigue el protocolo §5 tal como está: análisis documentado, nueva evidencia y una decisión auditada del propietario, desde la sección Laboratorio de la web. Reanudar en la Fase 2 adelanta, para el modo `shadow`, lo que el catálogo de funciones llama «Volver a encender» y pone en la Fase 4, y el propietario decide cómo (§12);
- si la ADR del motor propone que alguna detención se levante sola cuando los datos se recuperan, eso cambia el protocolo §5: necesita antes la decisión del propietario (§12), y el mismo PR cambia el protocolo. Una estrategia pausada por un incidente nunca se reactiva sola;
- cada causa tiene su vector, y la puerta de salida demuestra la detención en producción.

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
2. **Despliegue del sistema de datos** (F2.2): las condiciones de ADR-0016 §4 que quedan después del punto de control. Son los roles, la retención, las reglas de `ingest` en producción, las comprobaciones de R2, dónde y cada cuánto corre `data:health`, las credenciales y la región. Decide también el cifrado de la conexión a PostgreSQL, `render.yaml`, la historia tras una parada programada, qué pasa si dos instancias se solapan durante un despliegue, cómo se mide el tráfico de salida y cómo llega al repositorio la evidencia de producción (§4, punto 10).
3. **API y cuentas** (F2.3): el método de inicio de sesión, las sesiones, las cuentas sin registro público, los espacios personales, la auditoría, los contratos y su OpenAPI, cómo se sirve la web y sus roles y tokens de lectura. Decide también cómo se aíslan los backtests y cómo comparten la API y el motor el código de lectura de datos (§6).
4. **Datasets vivos** (F2.5): los umbrales, el perfil de publicación, la cadencia y el tamaño, las partes y los límites al publicar, los ticks de la historia y la lectura por partes. Se escribe con 7 días de captura en producción.
5. **Modelo de estrategia** (F2.6).
6. **Semántica del backtest** (F2.7).
7. **Protocolo estadístico** (F2.8).
8. **Motor de señales shadow** (F2.9 y F2.10), con los ensayos de la puerta de salida.

Las cuatro últimas comparten el evaluador, el instante de decisión y lo que guarda cada decisión. Por eso se escriben seguidas, y las cuatro se fusionan antes del primer PR de código de F2.6. Pueden escribirse mientras avanzan F2.3 a F2.5.

F2.4 no tiene ADR: cambia el concepto de interfaz, que es su fuente canónica (P-V1-04).

## 9. Secuencia de entrega

| Incremento | Requisitos | Depende de |
|---|---|---|
| **F2.1** Punto de control | `F2-CHECKPOINT-001` y `F2-GOV-001` (`packages/domain`) | este plan |
| **F2.2** Sistema de datos en producción | `F2-DEPLOY-001`, `F2-ROLE-001` y `F2-RETENTION-001` | F2.1 |
| **F2.3** API, cuentas y auditoría | `F2-API-001`, `F2-AUTH-001`, `F2-AUDIT-001` (sesiones) y `F2-GOV-001` (`apps/api`) | la captura de F2.2 corriendo en producción |
| **F2.4** Datos reales en pantalla | `F2-UI-001` y `F2-CHART-001` | F2.3 |
| **F2.5** Datasets vivos | `F2-THRESHOLD-001` y `F2-DATASET-001` | F2.2 con sus 7 días de captura |
| **F2.6** Estrategias | `F2-STRATEGY-001`, `F2-AUDIT-001` (estrategias) y `F2-GOV-001` (`packages/strategy-sdk`) | F2.3 y las cuatro ADR del laboratorio |
| **F2.7** Backtest | `F2-BACKTEST-001` y `F2-AUDIT-001` (backtests) | F2.5 y F2.6 |
| **F2.8** Evaluación | `F2-EVAL-001` y `F2-AUDIT-001` (registros previos y evaluaciones) | F2.7 |
| **F2.9** Motor shadow y registro de señales | `F2-SHADOW-001`, `F2-SIGNAL-001`, `F2-STOP-001`, `F2-AUDIT-001` (activaciones, detenciones y reanudaciones) y `F2-GOV-001` (`apps/signal-engine`) | F2.8 |
| **F2.10** Posiciones, comparación y réplica | `F2-POSITION-001` y `F2-REPLAY-001` | F2.9 |
| **F2.11** Puerta de salida | la evidencia de §13 | F2.10 |

- La captura empieza en F2.2, lo antes posible, para que los datos se acumulen mientras avanza lo demás.
- F2.2 se cierra con su evidencia de 7 días. F2.3 no la espera: empieza en cuanto la captura corre en producción. F2.5 sí espera esos 7 días.
- Cada incremento se entrega en PR pequeños, con una revisión semántica cada uno, y desde F2.3 el propietario lo usa en la web.
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

Un ensayo en vivo o en producción nunca sustituye una prueba sin red, porque la red y el mercado no son deterministas.

## 11. Presupuesto

| Servicio | Llega en | Costo aproximado al mes |
|---|---|---|
| Render Postgres Basic-256mb, con 1 GB de disco | F2.2 | 6,30 USD |
| Background worker Starter para `ingest` | F2.2 | 7 USD |
| Cloudflare R2 | F2.2 | de 1 a 2 USD |
| Servicio web Starter para la API y la web | F2.3 | 7 USD |
| Background worker Starter para el motor `shadow` | F2.9 | 7 USD |

En total, unos 29 USD al mes. Las cuatro primeras filas son los unos 22 USD que aprobó el propietario (ADR-0016 §2). El servidor del motor lo aprobó el 2026-10-29 («1. Si, un servidor pequeño para el bot»), y se compra con F2.9. Los backtests corren dentro del servicio de la API, sin costo aparte. Los precios son los que comprobó ADR-0016 y se confirman al comprar.

La línea de R2 es la estimación de ADR-0016 para la captura y `data:health`. No incluye las lecturas de la API y del motor ni el tráfico de salida de Render, que no se han medido: F2.2, F2.3 y F2.9 los miden. Si lo medido no cabe en este presupuesto, se presenta al propietario antes de seguir (§4, punto 8).

Pueden sumarse, si sus ADR los eligen y el propietario los aprueba:

- el disco de PostgreSQL de 5 GB, 1,50 USD en lugar de 0,30, cuando la retención lo pida;
- un cron job para `data:health`, desde 1 USD;
- el worker Standard, unos 18 USD más, si el punto de control no basta (ADR-0016, «Consecuencias»).

## 12. Decisiones del propietario durante la fase

| Decisión | Materia | Se pide en |
|---|---|---|
| Servidor propio para el motor `shadow`, unos 7 USD más al mes | dinero | decidida el 2026-10-29: sí (§11) |
| Región de Render y de R2, que luego no se puede cambiar | producto y dinero | F2.2 |
| Retención y tamaño del disco, si suben el presupuesto | dinero | F2.2 |
| Si el agente recibe un acceso de solo lectura a producción, o si la evidencia llega solo por el propietario (§4, punto 10) | seguridad | F2.2 |
| Cómo inicia sesión el propietario | seguridad | F2.3 |
| Qué idiomas tiene el producto, para la preferencia de idioma del catálogo | producto | F2.4 |
| Qué tipo de operación representan las posiciones hipotéticas, dentro de lo que ofrece Deriv para R_100 | producto | antes de abrir la ADR del modelo de estrategia (§8, punto 5) |
| Cómo se reanuda una estrategia `shadow` detenida: a mano, como pide hoy el protocolo §5, o sola tras las degradaciones breves que la historia cubre, lo que cambia el protocolo. Las dos adelantan para `shadow` el «Volver a encender» del catálogo (`F2-STOP-001`) | riesgo y producto | antes de abrir la ADR del motor (§8, punto 8) |
| El worker Standard, si el punto de control no cumple `F2-CHECKPOINT-001` | dinero | solo si pasa |

Cada decisión se pide con sus opciones y una recomendación, y el PR que la usa registra cuándo y con qué palabras la dio (AGENTS.md, «Fusión»).

## 13. Definition of Done

La Fase 2 está `done` únicamente cuando:

- todos los requisitos `F2-*` tienen evidencia fusionada;
- el sistema de datos cumple `F2-DEPLOY-001` durante toda la ventana de la puerta de salida;
- una estrategia en `shadow` sumó en producción al menos 7 días en `active`, sin contar sus pausas, y cada una de sus decisiones de esa ventana se reprodujo con el mismo registro desde datasets publicados y versiones fijados (`F2-REPLAY-001`);
- en esa ventana el motor se detuvo sin intervención ante cada degradación de los datos, natural o provocada en un ensayo de la puerta, y cada reanudación siguió su regla (`F2-STOP-001`);
- esa estrategia tiene su informe completo de backtest, validación, prueba fuera de muestra y `shadow`, también si es negativo. La puerta no exige ganancias. Exige que la estrategia haya pasado la puerta `reviewed` → `shadow` del protocolo §4, con su criterio de promoción registrado antes de ver resultados (protocolo §1), sea cual sea ese criterio;
- el costo mensual medido está dentro del presupuesto aprobado;
- `PROJECT_STATUS.md`, los contratos, las ADR, los runbooks y el catálogo de funciones describen el sistema real.

## 14. Riesgos y preguntas no bloqueantes

- **Memoria.** Si el punto de control no baja la memoria lo bastante, el worker Standard cabe sin cambiar el código, pero sube el total en unos 18 USD al mes (§12).
- **Datos suficientes.** Si al llegar F2.8 no hay datos bastantes para entrenar, validar y probar fuera de muestra, F2.8 espera a que la captura los acumule, o una ADR propone importar historia con `ticks_history`.
- **La API está en internet.** Su seguridad se revisa en cada PR, y la seguridad conserva la revisión humana del propietario (CONTRIBUTING.md).
- **Render Postgres Basic-256mb** (0,1 CPU y 256 MB) atiende la captura, la API y el motor a la vez. Si no alcanza, subir de plan necesita al propietario.
- **Región.** La de Render no se puede cambiar después de crear un servicio (ADR-0016 §4).
- **Deriv puede cambiar su API.** La release de esquemas sigue fijada ([ADR-0004](../arquitectura/adr/0004-pipeline-y-reproduccion-de-datos-fase-1.md) §2), y el smoke detecta la deriva.
- **Universo.** El universo definitivo de índices y tipos de contrato sigue pendiente. La fase no lo necesita: trabaja solo con R_100 y con el tipo de operación que el propietario elija para las posiciones hipotéticas (§12).
