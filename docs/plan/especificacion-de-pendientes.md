# Especificación de pendientes

Inventario de lo que falta, está incompleto o no está documentado, comparando el código del commit `869ba4e` con los planes, `PROJECT_STATUS.md`, las ADR y las guías. Revisado el 2026-10-25. Ese mismo día el propietario resolvió P-V1-01, P-V1-03 y P-GOV-01, y en P-V1-05 lo que él llama «operar desde el celular»; cada entrada registra su decisión.

No es un plan de fase: no tiene requisitos propios ni `status`, y `PROJECT_STATUS.md` no lo enlaza como `plan` ni como `parallel_plans`.

**Este documento no autoriza trabajo ni añade requisitos.** Cada comportamiento esperado cita la fuente que ya lo pide. Lo que autoriza trabajo sigue siendo:

- [`PROJECT_STATUS.md`](../../PROJECT_STATUS.md): siguiente tarea autorizada;
- el plan activo de la fase, [Fase 1](fase-1-fundacion-de-datos.md). La [línea visual V1](linea-visual-v1.md) terminó el 2026-10-25 (P-V1-01).

Si este documento y una de esas fuentes difieren, manda la fuente; hay que corregir este documento.

## Cómo leerlo

Cada pendiente tiene un identificador `P-…` y estas partes:

- **Objetivo** y **fuente** de la expectativa.
- **Estado (verificado):** lo que se comprobó en el código o en el repositorio.
- **Esperado:** lo que dice la fuente, sin añadir nada.
- **Componentes** afectados.
- **Aceptación:** los criterios de la fuente; «no indicados» si no los fija.
- **Abierto:** preguntas, dependencias y decisiones humanas.
- **Propuesta:** solo cuando hay una sugerencia, separada de los hechos.

Una entrada resuelta cambia el estado, lo esperado, los componentes, la aceptación y lo abierto por **Antes**, **Decisión del propietario** y **Resolución**, y a veces añade un **Límite** o una **Consecuencia que se mantiene**.

Tipos de pendiente:

- **sin empezar:** planificado y sin código;
- **parcial:** hay piezas, pero no el comportamiento completo;
- **sin documentar:** existe, pero ningún documento lo describe;
- **contradicho:** el documento dice algo que el código no hace;
- **menor registrado:** anotado en un PR, una ADR o `PROJECT_STATUS.md`;
- **resuelto:** decidido o terminado. La entrada se conserva con su decisión, y su identificador no se reutiliza.

## 1. Fase 1 — Fundación de datos

### P-F1-01. Catálogo público versionado (`F1-CATALOG-001`) — resuelto

- **Objetivo:** guardar versiones inmutables de la lista oficial de símbolos de Deriv.
- **Fuente:** plan de Fase 1 §6 (`F1-CATALOG-001`), ADR-0004 §6 y [ADR-0012](../arquitectura/adr/0012-catalogo-y-adaptador-publico-de-deriv.md) §1 y §7.
- **Antes:** no había consulta, almacén, migración ni tabla de catálogo en el worker.
- **Decisión del propietario:** el primer smoke usa un solo índice sintético, con el nombre exacto del catálogo oficial. ADR-0012 eligió `R_100`, «Volatility 100 Index».
- **Resolución (F1.4b):**
  - `packages/contracts` define `SourceCatalogSnapshot`, y `packages/domain` convierte la respuesta de `active_symbols` en snapshot (`deriveCatalogSnapshot`), con los seis motivos de un catálogo inválido;
  - el adaptador del worker pide `active_symbols`, crea el snapshot desde el frame durable y lo guarda con la regla de versiones. Un catálogo inválido deja su incidencia y no reemplaza la última versión válida;
  - `PostgresCatalogStore` guarda las versiones en `source_catalog_versions` y el JCS de cada snapshot en el almacenamiento de objetos (migración `0003`). Las pruebas de integración cubren las dos condiciones de aceptación;
  - `pnpm run data:smoke` lo consulta en vivo (`PROJECT_STATUS.md`, «Evidencia de F1.4b»).
- **Límite:** el smoke guarda el catálogo en memoria (ADR-0012 §10), así que ningún comando guarda todavía el catálogo vivo en PostgreSQL; llegará con el primer proceso que ingiera de forma continua (P-F1-04 y P-F1-06). El catálogo tampoco decide el universo comercial, que sigue pendiente en `PROJECT_STATUS.md`.

### P-F1-02. Adaptador público de Deriv (`F1-SOURCE-001`) — resuelto

- **Objetivo:** recibir el flujo público de Deriv, sin credenciales, dentro de los límites de ADR-0004.
- **Fuente:** plan de Fase 1 §6, ADR-0004 §2 y §7, y ADR-0012 §2 a §6 y §9.
- **Antes:** desde F1.4a existían las reglas de calidad 2.0.0, `non_tick_msg_types`, la atribución por `echo_req`, el límite de frame del ingestor y la evaluación de los límites de cola. No había transporte, keepalive, tiempos de espera, correlación ni descarga de `schemas.zip`.
- **Resolución (F1.4b):**
  - `packages/domain` elige el validador por el dialecto del esquema (Ajv 2020 o `ajv-draft-04`) y tiene un perfil de medición que nunca deriva ni publica;
  - el worker descarga `schemas.zip` con su SHA-256, sus límites y las huellas de sus 14 entradas (`fflate`);
  - el adaptador (`apps/market-data-worker/src/deriv/`) usa `ws` con el tamaño declarado de un frame cortado, una cola en memoria con sus límites, correlación por `req_id` y `msg_type` después de que el frame sea durable, keepalive, tiempos de espera y pausa del ingestor desde el transporte. Las respuestas pedidas inválidas van a `requested_response_incidents`;
  - quien escribe el log de una fuente en PostgreSQL toma antes su bloqueo (`SourceLock`);
  - la aceptación del plan se cumple con las pruebas del adaptador, con socket, reloj y temporizador falsos, y con `pnpm run data:smoke` (`PROJECT_STATUS.md`, «Evidencia de F1.4b»).
- **Límite:** el adaptador no reconecta (P-F1-04), y el primer escritor continuo debe cerrar el pendiente 6 de F1.3 (`PROJECT_STATUS.md`).

### P-F1-03. `pnpm run data:smoke` — resuelto

- **Objetivo:** una prueba viva opt-in contra Deriv que mida retrasos reales.
- **Fuente:** plan de Fase 1 §5 y §7, ADR-0004 §13 y ADR-0012 §10.
- **Antes:** el comando no existía en `package.json`.
- **Decisión del propietario:** los umbrales live de retraso y hueco se fijan con lo que mida el smoke, y mientras tanto los datos live no se publican como dataset.
- **Resolución (F1.4b):** `pnpm run data:smoke -- --live` corre `scripts/data-smoke.mjs`, que deja en stdout una sola línea JSON saneada. Sin `--live` responde con un error de uso y no abre conexiones. Guarda todo en memoria y lo borra al terminar, así que el borrado en 24 horas se cumple sin tablas ni objetos que limpiar. Su uso y su resultado están en el runbook («Smoke público de Deriv»), y el primer smoke vivo, en `PROJECT_STATUS.md` («Evidencia de F1.4b»).
- **Límite:** nunca es el único criterio de fusión, y los umbrales live siguen sin fijar (`PROJECT_STATUS.md`).

### P-F1-04. Reconexión y recuperación de historia (`F1-RECONNECT-001`) — parcial

- **Objetivo:** que una desconexión no oculte pérdida de datos.
- **Fuente:** plan de Fase 1 §6, runbook («Inicio», «Desconexión de WebSocket», «Almacenamiento no disponible») y ADR-0005.
- **Estado (verificado):**
  - los contratos (`HistoryRecoveryResult`, `IngestionCursor`) y la derivación de continuidad en `packages/domain/src/quality.ts` existen;
  - en el worker no hay reconexión, espera exponencial ni consulta de historia. Desde F1.4b, el adaptador de Deriv termina en cada pérdida de conexión con su `ConnectionClosed`, y la tabla de cierres del runbook dice cuáles pierden datos. Los esquemas de `ticks_history` y `forget` ya se cargan con la release fijada, pero el adaptador no los pide;
  - `IngestionCursor` tiene esquema, pero no tabla ni almacén.
- **Esperado:** ante un `ConnectionClosed` no pedido, el worker:
  - pasa a `recovering`;
  - espera con retroceso exponencial y jitter inyectable;
  - consulta la historia por símbolo;
  - solo vuelve a `healthy` cuando continuidad y persistencia están verificadas; si no, registra `event_gap_unresolved`.

  El cursor se actualiza en una transacción, después de confirmar durabilidad.
- **Componentes:** `apps/market-data-worker`, una migración nueva y `packages/domain`.
- **Aceptación (plan §6):** prueba con reloj y transporte falsos, y smoke vivo aparte.
- **Abierto:** pendientes registrados 6 de F1.2 y 7 de F1.3, en `PROJECT_STATUS.md`. El diseño está en [ADR-0015](../arquitectura/adr/0015-reconexion-recuperacion-y-salud-f1-5.md) §2 a §6, que también cierra esos dos pendientes.

### P-F1-05. Reporte de salud y `pnpm run data:health -- --json` (`F1-HEALTH-001`) — parcial

- **Objetivo:** emitir el `HealthReport` en formato máquina.
- **Fuente:** plan de Fase 1 §5 y §6, y runbook («Reporte y evidencia»).
- **Estado (verificado):** existen el contrato (`packages/contracts/src/health.ts`) y la derivación pura (`deriveHealthReport` en `packages/domain/src/health.ts`). No hay comando ni conexión con el estado real de conexión y backlog.
- **Esperado:** valida y emite `HealthReport` con:
  - salud y estado de conexión;
  - backlog por conteo y bytes;
  - últimos datos y dataset;
  - condiciones abiertas.
- **Componentes:** `apps/market-data-worker` y `package.json` raíz.
- **Aceptación (plan §6):**
  - almacenamiento no disponible da `paused`;
  - contrato o configuración incompatibles dan `failed`;
  - nunca `healthy` sin datos persistidos.
- **Abierto:**
  - en `recovering` por continuidad pendiente, `open_condition_types` queda vacío (pendiente 2 de F1.2);
  - **decidido en [ADR-0015](../arquitectura/adr/0015-reconexion-recuperacion-y-salud-f1-5.md) §8:** un envoltorio en `scripts/` deja stdout limpio, como `data-replay.mjs`, porque el emulador de shell de pnpm no respeta `1>&2` (ADR-0003). El backlog sale del latido que persiste la ingesta, y la conexión también si el latido es posterior al último evento de conexión del log; sin escritor vivo, la conexión es `disconnected` y el backlog, 0.

### P-F1-06. Puerta de salida de Fase 1 (`F1.5`) — sin empezar

- **Objetivo:** reunir la evidencia que permite marcar la Fase 1 como `done`.
- **Fuente:** plan de Fase 1 §9, runbook («Verificación periódica» y «Puerta de salida de Fase 1») y `PROJECT_STATUS.md` («Evidencia requerida para cambiar de fase»).
- **Estado (verificado):** desde F1.4b, `pnpm run data:smoke` recibe el flujo público sin credenciales, en memoria (evidencia en `PROJECT_STATUS.md`). No hay todavía captura persistida de datos vivos ni ensayos de reinicio y de fallo de almacenamiento.
- **Esperado:**
  - capturar el flujo público sin credenciales;
  - que reinicio, desconexión y fallo de persistencia no oculten pérdida;
  - reproducir un dataset con el mismo identificador;
  - que los documentos reflejen el sistema real.
- **Componentes:** todos los de P-F1-01 a P-F1-05, más `PROJECT_STATUS.md`, que cambia de fase en el PR de cierre.
- **Aceptación (`PROJECT_STATUS.md`):** todos los requisitos de la fase tienen pruebas y evidencia, un dataset se reproduce con el mismo identificador y las incidencias de calidad siguen visibles tras reinicios.
- **Abierto:** decisión humana al cerrar la fase sobre el orden entre la Fase 1B (datos MT5) y la Fase 2 (bot shadow). La evidencia se reúne como dice [ADR-0015](../arquitectura/adr/0015-reconexion-recuperacion-y-salud-f1-5.md) §12.

### P-F1-07. Pendientes menores ya registrados — menor registrado

`PROJECT_STATUS.md` los mantiene en «Pendientes registrados de F1.2», «de F1.3» y «de F1.4a», y este documento no los repite. Entre ellos, dos tienen fecha límite explícita:

- antes de publicar datasets vivos largos: límites de lectura y artefactos que crecen sin segmentar (F1.3, pendiente 2);
- antes de desplegar: un rol de PostgreSQL de solo inserción y lectura (F1.3, pendiente 4; ADR-0006).

Comprobado en el repositorio:

- la guardia documental no tiene regla para `packages/domain/**` (F1.2, pendiente 3);
- `qualityProfileSchema` está repetido (F1.2, pendiente 4; aquí D-14).

## 2. Línea visual V1

La línea terminó el 2026-10-25 (P-V1-01). Los demás pendientes de esta sección no forman parte de su criterio de cierre (plan V1 §7).

### P-V1-01. Cierre de la línea visual — resuelto

- **Objetivo:** marcar la línea visual V1 como `done` con la evidencia que pide su plan.
- **Fuente:** plan V1 §7 y roadmap («Criterio de salida»).
- **Antes:** los requisitos `V1-*` tenían implementación fusionada, pero no había registro de que el propietario revisara las capturas con la identidad V1.6. ADR-0011 registra que aprobó los prototipos antes de enviar su logo, y ADR-0010 §4, que instaló y aprobó el prototipo de escritorio.
- **Decisión del propietario (2026-10-25):** esas aprobaciones ya registradas cuentan como la revisión de capturas del plan V1 §7.
- **Resolución:** la línea queda `done` en `PROJECT_STATUS.md` (sale de `parallel_plans`), en el plan V1 (§2 y §7), en el roadmap y en el sitio oficial (`apps/site/src/content.ts`, comprobado por `apps/site/test/content.test.ts`).
- **Límite:** cerrar V1 no autoriza la app real de Windows, que sigue la decisión 6 de ADR-0001.

### P-V1-02. Pendientes de la identidad (`V1-BRAND-002`, PR #19) — menor registrado

- **Objetivo:** dejar más precisas las pruebas y la medida de la identidad V1.6.
- **Fuente:** revisión semántica del PR #19 y plan V1 (`V1-BRAND-002`).
- **Estado (verificado):**
  - la prueba de trazados solo rechaza tiradores exactamente nulos;
  - ADR-0011 no define cómo se calcula el 95,7 % de parecido de la palabra (es una superposición «suave»);
  - solo el tono de `healthy` tiene prueba de distancia frente al verde azulado de marca. El cian de `demo` queda a unos 15°, lo que la guía §5 acepta.
- **Esperado:** el plan V1 pide que la marca no se use en estados y que «saludable» quede a 25° o más. Las tres mejoras son menores de la revisión, no requisitos.
- **Componentes:** `packages/design-system/test`, ADR-0011.
- **Aceptación:** no indicados. Los criterios de `V1-BRAND-002` ya se cumplen.
- **Abierto:** ninguna fuente fija cuándo atenderlos. Pueden ir en un PR propio del sistema de diseño.

### P-V1-03. Contexto de la curva de resultados — resuelto

- **Objetivo:** que la curva de resultados y la guía de marca digan lo mismo.
- **Fuente:** guía de marca §8.
- **Antes:** la guía pedía modo, período, muestra y costes «en el propio gráfico». `EquityChart` no recibe contexto: el período solo se ve en las fechas del eje, y el contexto completo está en la tarjeta «Evidencia» de al lado.
- **Decisión del propietario (2026-10-25):** el contexto se queda fuera del gráfico, en la tarjeta de al lado.
- **Resolución:** la guía §8 acepta el contexto en la tarjeta de al lado, y el [flujo de gráficos](../diseno/flujo-de-graficas.md) §9 da la regla por cumplida. El código no cambia.

### P-V1-04. Gráficos: accesibilidad, pruebas y unidades — sin documentar hasta ahora

- **Objetivo:** que los gráficos cumplan la guía §10 y tengan pruebas propias antes de mostrar datos reales.
- **Fuente:**
  - guía §10 («Contraste… comprobado por pruebas» y «Ninguna información depende solo del color»);
  - AGENTS.md (pruebas derivadas de los criterios).
- **Estado (verificado):**
  - el contraste de la línea y la rejilla de los gráficos no se mide;
  - no hay pruebas de `scaleFor`, `segments` ni del SVG exportado;
  - la descripción accesible de cada gráfico se escribe a mano, y no hay tabla alternativa;
  - la peor caída se muestra como «3,6 pts» y el contexto dice «−3,6 %».
- **Esperado:** no hay un criterio de aceptación concreto para gráficos más allá de la guía §10.
- **Componentes:** `apps/web/src/components/Charts.tsx`, `packages/design-system/test` y el concepto de interfaz §6.
- **Aceptación:** no indicados.
- **Propuesta:** antes de los gráficos con datos reales de la Fase 2, definir en el concepto de interfaz:
  - la alternativa textual o tabular;
  - la unidad de la peor caída;
  - una prueba de contraste de los tokens `chart`.
- **Abierto:** ninguna fuente dice si esto se hace antes de la Fase 2 o dentro de ella.

### P-V1-05. Móvil: teléfono real y reautenticación — menor registrado y decisiones humanas

- **Objetivo:** confirmar que el prototipo móvil funciona en un teléfono y cerrar las dudas del PR #16 sobre el modo real.
- **Fuente:** ADR-0009 («Pendientes»), `PROJECT_STATUS.md` («Decisiones pendientes») y el catálogo de funciones (pedir el modo `real` y volver a encender).
- **Estado (verificado):**
  - no se probó en un teléfono real; Expo Go para el SDK 58 no estaba en las tiendas al aceptar ADR-0009;
  - las pruebas usan React Native for Web, y no ven diferencias de Android o iOS;
  - qué cuenta como reautenticación en un teléfono sigue abierto, como riesgo para la revisión de amenazas de la Fase 5.
- **Antes:** el PR #16 dejó abiertos ese punto y la confirmación del propietario de que «pedir» el modo real desde el móvil nunca es operar desde él.
- **Decisión del propietario (2026-10-25):** lo que él llama «operar desde el celular» es encender o apagar estrategias del bot, también con dinero real, como con un control remoto, y nunca abrir operaciones a mano. Todo sigue pasando por el servidor, `execution-gateway` y su política de riesgo.
- **Resolución:** el catálogo de funciones lo registra en §1 y en la fila «Volver a encender», que reactiva una estrategia detenida con las condiciones de operación y control de riesgo §6 a §8 y del protocolo de validación §5. No hace falta ADR, porque no cambia la ejecución ni el riesgo: ADR-0002, decisión 8, ya define los móviles como clientes de observación, control y autorización segura.
- **Esperado:**
  - ADR-0009 y `PROJECT_STATUS.md` piden probar la app en un teléfono real y decidir cómo compilarla y distribuirla;
  - el catálogo de funciones permite desde el móvil pedir el modo `real` (Fase 6) y volver a encender una estrategia detenida (Fase 4), con autenticación y auditoría, con reautenticación en `real` y, si se pausó por una de las causas del protocolo de validación §5, con sus condiciones, más datos y reconciliación confirmados si fue por un incidente (operación y control de riesgo §8). Ninguna fuente define qué cuenta como reautenticación en un teléfono; lo decide la revisión de amenazas de la Fase 5 (roadmap).
- **Componentes:** `apps/mobile`, ADR-0009 y el catálogo de funciones.
- **Aceptación:** no indicados.
- **Abierto:** probar en un teléfono real y cómo distribuir la app son decisiones o pruebas humanas; la reautenticación en un teléfono queda para la revisión de amenazas de la Fase 5.

### P-V1-06. Escritorio: firma y ventanas — menor registrado

- **Objetivo:** poder distribuir el instalador de escritorio y dejar claras sus limitaciones.
- **Fuente:** ADR-0010 («Pendientes»), `PROJECT_STATUS.md` y los PR #17 y #18.
- **Estado (verificado):**
  - el instalador no está firmado;
  - `window.open` queda bloqueado solo porque la app no define quién recibe la ventana nueva;
  - `scripts/data-replay.mjs` y `scripts/data-smoke.mjs` no se ejecutan en Windows en CI.
- **Esperado:** firmar el instalador antes de distribuirlo. La app real tendrá ventanas separables y un manejador explícito de `window.open`.
- **Componentes:** `apps/desktop` y el flujo de CI de Windows en `.github/workflows/verify.yml`.
- **Aceptación:** no indicados.
- **Abierto:** firmar exige un certificado, y cómo distribuir la app es una decisión del propietario (`PROJECT_STATUS.md`).

### P-V1-07. Sitio: publicación — parcial

- **Objetivo:** publicar el sitio oficial.
- **Fuente:** ADR-0008 («Pendientes»), ADR-0013 y sitio oficial §4.
- **Estado (verificado):** desde ADR-0013 (decisión del propietario del 2026-10-26), `render.yaml` define el sitio para Render como sitio estático gratuito, en una dirección `onrender.com` y sin indexar. Queda en internet cuando el propietario conecta el repositorio en Render ([despliegue en Render](../operacion/despliegue-en-render.md)). Dos sitios estáticos de ejemplo de Render no ponen cookies; falta comprobarlo en el propio tras el primer despliegue. Render no entrega sus registros de acceso, y el aviso de riesgo dice que Render y Cloudflare reciben la dirección IP de cada visita.
- **Esperado:** dominio propio, revisión legal del aviso de riesgo, de la nota de marcas y de la frase de privacidad del pie, y quitar el `noindex` de la página y de `render.yaml` en el mismo PR, borrando después la regla también en el panel de Render.
- **Componentes:** `apps/site` y `render.yaml`.
- **Aceptación (sitio oficial §4):** la de arriba, y comprobar tras el primer despliegue que la dirección del sitio no pone cookies.
- **Abierto:** el dominio propio y la revisión legal son decisiones del propietario.

## 3. Proceso del repositorio

### P-GOV-01. Justificar una excepción de la guardia documental en CI — resuelto

- **Objetivo:** que el plan, CONTRIBUTING.md y la guardia digan lo mismo sobre cómo se justifica una excepción.
- **Fuente:** plan de Fase 1 (`F1-GOV-001`).
- **Antes:**
  - `F1-GOV-001` decía que el chequeo «exige actualización o justificación explícita en el PR», y el mensaje de error de la guardia pedía justificar «la excepción en un PR»;
  - la justificación solo se acepta en la línea de comandos (`--acknowledge` en `scripts/check-doc-impact.mjs`), y `verify:pr` y CI no la pasan, así que escribir la razón en el PR no hace pasar CI;
  - consecuencia en este análisis: el worker quedó sin comentarios nuevos, porque su regla pedía cambiar el runbook o ADR-0004 sin motivo.
- **Decisión del propietario (2026-10-25):** la guardia se queda como está, y CI sigue sin aceptar justificaciones.
- **Resolución:** el texto de `F1-GOV-001` y el mensaje de error describen lo que hace la guardia, y CONTRIBUTING.md registra la decisión. El comportamiento no cambia: las mismas reglas, comprobaciones y códigos de salida.
- **Consecuencia que se mantiene:** tocar código de un área, aunque solo sea con comentarios, exige cambiar una de sus fuentes en el mismo PR.

## 4. Fases posteriores

Solo se listan; sus planes no existen todavía y el roadmap describe el destino.

- **Fase 1B (datos MT5).** Roadmap y ADR-0007 («Pendientes»). Antes del puente hay que decidir:
  - el equipo de la terminal y su protección;
  - la revisión de términos de Deriv MT5, Vantage y MetaQuotes.

  No existe código MT5, como manda el plan.
- **Fases 2 a 7.** Roadmap. No están autorizadas.
- **Despliegue.** ADR-0006, ADR-0013 y arquitectura objetivo. Solo el sitio oficial tiene `render.yaml` (ADR-0013). Siguen pendientes:
  - el costo del alojamiento del sistema de datos (PostgreSQL y API en Render, ADR-0006), dónde se aloja el worker y el proveedor S3 productivo, que Render no ofrece; el único marcador en código es un comentario en `apps/market-data-worker/src/s3/object-store.ts`;
  - la distribución de la app móvil.

## 5. Documentos desactualizados

### Corregidos junto con este documento

- `README.md`, «Desarrollo actual»: no mencionaba F1.4a ni la línea visual.
- Roadmap, línea visual V1: faltaba el incremento 6 (identidad, V1.6).
- ADR-0008 y ADR-0009, «Pendientes»: listaban como pendientes el móvil y el escritorio, que ya se entregaron.
- Plan de Fase 1 §4: el escritorio quedaba fuera de la excepción de los prototipos visuales.
- Plan de Fase 1 §8: no decía que F1.4 se entrega en dos partes.
- Plan V1 §1: el objetivo no nombraba el escritorio.
- README de `packages/design-system`: faltaba `logo:write`.
- CONTRIBUTING.md: no decía que en CI no se pueden justificar excepciones de la guardia.

### Corregidos con ADR-0013 (2026-10-26)

- Plan de Fase 1 §4 y arquitectura objetivo («Despliegue y fiabilidad»): diferían todo despliegue de Render, sin la excepción del sitio oficial, que ADR-0013 publica como sitio estático gratuito.

### Sin corregir

- **ADR-0006**: «no autoriza a desplegar ni a crear `apps/api`, `apps/web`, `apps/mobile` o `render.yaml` en Fase 1». `apps/web` y `apps/mobile` ya existen como prototipos, que llegaron por ADR-0008 y ADR-0009. ADR-0013 la aclaró para `render.yaml`, que ahora solo publica el sitio oficial. Para la API, el worker, PostgreSQL y la producción sigue siendo cierta.

## 6. Decisiones humanas abiertas

P-V1-01, P-V1-03 y P-GOV-01 ya no figuran aquí, ni lo que el propietario llama «operar desde el celular» (P-V1-05): las resolvió el 2026-10-25, y cada entrada registra su decisión.

| Decisión | Pendiente | Dónde se registra hoy |
|---|---|---|
| Qué cuenta como reautenticación en un teléfono (se define en la revisión de amenazas de la Fase 5) | P-V1-05 | `PROJECT_STATUS.md` y roadmap (Fase 5) |
| Probar en un teléfono real y cómo distribuir la app | P-V1-05 | `PROJECT_STATUS.md` |
| Firmar el instalador de escritorio | P-V1-06 | `PROJECT_STATUS.md` |
| Dominio propio y revisión legal del sitio | P-V1-07 | `PROJECT_STATUS.md` |
| Universo de índices y tipos de contrato | P-F1-01 | `PROJECT_STATUS.md` |
| Orden entre la Fase 1B y la Fase 2 | P-F1-06 | `PROJECT_STATUS.md` |
| Equipo de la terminal MT5 y revisión de términos | §4 | `PROJECT_STATUS.md` |
| Costo del alojamiento del sistema de datos, alojamiento del worker y proveedor S3 productivo | §4 | `PROJECT_STATUS.md` |
