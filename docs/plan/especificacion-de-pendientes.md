---
spec_id: "PENDIENTES"
schema_version: "1.0.0"
status: "reference"
authorizes_work: false
owner: "propietario de buoh"
last_reviewed_utc: "2026-10-25T21:00:00.000Z"
---

# Especificación de pendientes

Inventario de lo que falta, está incompleto o no está documentado, comparando el código del commit `869ba4e` con los planes, `PROJECT_STATUS.md`, las ADR y las guías.

**Este documento no autoriza trabajo ni añade requisitos.** Cada comportamiento esperado cita la fuente que ya lo pide. Lo que autoriza trabajo sigue siendo:

- [`PROJECT_STATUS.md`](../../PROJECT_STATUS.md): siguiente tarea autorizada;
- el plan activo de la fase: [Fase 1](fase-1-fundacion-de-datos.md) y [línea visual V1](linea-visual-v1.md).

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

Tipos de pendiente:

- **sin empezar:** planificado y sin código;
- **parcial:** hay piezas, pero no el comportamiento completo;
- **sin documentar:** existe, pero ningún documento lo describe;
- **contradicho:** el documento dice algo que el código no hace;
- **menor registrado:** anotado en un PR, una ADR o `PROJECT_STATUS.md`.

## 1. Fase 1 — Fundación de datos

### P-F1-01. Catálogo público versionado (`F1-CATALOG-001`) — sin empezar

- **Objetivo:** guardar versiones inmutables de la lista oficial de símbolos de Deriv.
- **Fuente:** plan de Fase 1 §6 (`F1-CATALOG-001`), ADR-0004 §6 y `PROJECT_STATUS.md` (siguiente tarea `F1.4b`).
- **Estado (verificado):**
  - no hay módulo, comando, migración ni tabla de catálogo en `apps/market-data-worker`;
  - `packages/contracts` no tiene un esquema de snapshot de catálogo, y los contratos de dominio no lo describen;
  - `PROJECT_STATUS.md` confirma que no hay integración con Deriv.
- **Esperado:** el worker consulta `active_symbols` por el canal público. Guarda un snapshot con fecha de recepción UTC, versión del conector, versión del esquema de fuente, hash de contenido y la lista sin reinterpretar los nombres oficiales. Los snapshots son inmutables en almacenamiento de objetos, con índice en PostgreSQL.
- **Componentes:** `apps/market-data-worker` (adaptador, almacenamiento y migración). `packages/contracts` solo si hace falta un esquema nuevo.
- **Aceptación (plan §6):**
  - dos snapshots se guardan como versiones distintas si cambia el contenido;
  - un payload inválido no reemplaza el último snapshot válido y genera una incidencia.
- **Abierto:**
  - la forma del registro de snapshot no está definida; AGENTS.md pide actualizar los contratos o una ADR antes del código;
  - no se dice qué incidencia registra un catálogo inválido;
  - el catálogo no decide el universo comercial: es una decisión pendiente en `PROJECT_STATUS.md`;
  - el propietario fijó que el primer smoke use un solo índice sintético, con el nombre exacto del catálogo.

### P-F1-02. Adaptador público de Deriv (`F1-SOURCE-001`) — parcial

- **Objetivo:** recibir el flujo público de Deriv, sin credenciales, dentro de los límites de ADR-0004.
- **Fuente:** plan de Fase 1 §6, ADR-0004 §2 y §7, y `PROJECT_STATUS.md` («Puntos de partida ya comprobados para F1.4b»).
- **Estado (verificado):**
  - ya existen, desde F1.4a: las reglas de calidad 2.0.0, `non_tick_msg_types`, la atribución por `echo_req`, el límite de frame en `RawFirstIngestor.receiveFrame` y la evaluación de límites de cola en `packages/domain/src/health.ts`;
  - no hay transporte WebSocket, keepalive ni tiempos de espera;
  - no hay correlación de solicitudes y respuestas, ni descarga de `schemas.zip` con su SHA-256 y sus límites de ZIP;
  - no hay validador draft-04: el único es Ajv 2020, en `packages/domain/src/profile.ts`;
  - la elección de normalizador y validador no depende de la fuente;
  - no hay perfil «de medición» que nunca pueda publicar.
- **Esperado:**
  - endpoint público documentado, sin OAuth, PAT ni OTP;
  - respuestas validadas contra la release de esquemas fijada;
  - límites de bytes y tiempos de ADR-0004 §7, y keepalive dentro del intervalo recomendado;
  - solicitudes y respuestas correlacionadas;
  - frames entregados al `RawFirstIngestor` con el perfil de reglas 2.0.0, sin publicar datos vivos.
- **Componentes:** `apps/market-data-worker`, `packages/domain` (elegir perfil, normalizador y validador según la fuente) y nuevas dependencias.
- **Aceptación (plan §6):** pruebas del adaptador con fixtures y transporte y reloj falsos, más `pnpm run data:smoke` opt-in (P-F1-03).
- **Abierto:**
  - el validador draft-04 es una dependencia nueva que el PR debe justificar;
  - hay que elegir entre la biblioteca `ws` y el `WebSocket` global de Node 24;
  - hay que decidir cómo se registran los errores dentro de respuestas pedidas (pendiente 3 de F1.4a);
  - hace falta una sola instancia por fuente o un bloqueo por fuente (pendiente 6 de F1.3);
  - hay que dar un camino para registrar los frames que el cliente WebSocket corta antes del ingestor.

### P-F1-03. `pnpm run data:smoke` — sin empezar

- **Objetivo:** una prueba viva opt-in contra Deriv que mida retrasos reales.
- **Fuente:** plan de Fase 1 §5 y §7, `PROJECT_STATUS.md` (`F1.4b`) y ADR-0004 §13.
- **Estado (verificado):** el comando no existe en `package.json`.
- **Esperado:**
  - opt-in, nunca el único criterio de fusión;
  - su evidencia es la fecha, la release de esquemas y un resultado sanitizado;
  - los datos vivos se borran en 24 horas y no se publican como dataset;
  - los umbrales de retraso y hueco se fijan después, con lo que mida.
- **Componentes:** `package.json` raíz y `apps/market-data-worker`.
- **Aceptación:** la del plan §7.
- **Abierto:**
  - ningún documento dice cómo ni dónde se cumple el borrado en 24 horas;
  - el plan §5 lo sitúa en «F1.4» y `PROJECT_STATUS.md` en `F1.4b` (ver §4 de este documento).

### P-F1-04. Reconexión y recuperación de historia (`F1-RECONNECT-001`) — parcial

- **Objetivo:** que una desconexión no oculte pérdida de datos.
- **Fuente:** plan de Fase 1 §6, runbook («Inicio», «Desconexión de WebSocket», «Almacenamiento no disponible») y ADR-0005.
- **Estado (verificado):**
  - los contratos (`HistoryRecoveryResult`, `IngestionCursor`) y la derivación de continuidad en `packages/domain/src/quality.ts` existen;
  - en el worker no hay reconexión, espera exponencial ni consulta de historia;
  - `IngestionCursor` tiene esquema, pero no tabla ni almacén.
- **Esperado:** ante un `ConnectionClosed` no pedido, el worker:
  - pasa a `recovering`;
  - espera con retroceso exponencial y jitter inyectable;
  - consulta la historia por símbolo;
  - solo vuelve a `healthy` cuando continuidad y persistencia están verificadas; si no, registra `event_gap_unresolved`.

  El cursor se actualiza en una transacción, después de confirmar durabilidad.
- **Componentes:** `apps/market-data-worker`, una migración nueva y `packages/domain`.
- **Aceptación (plan §6):** prueba con reloj y transporte falsos, y smoke vivo aparte.
- **Abierto:** pendientes registrados 6 de F1.2 y 7 de F1.3, en `PROJECT_STATUS.md`.

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
  - **propuesta:** usar un envoltorio en `scripts/` que deje stdout limpio, como `data-replay.mjs`, porque el emulador de shell de pnpm no respeta `1>&2` (ADR-0003).

### P-F1-06. Puerta de salida de Fase 1 (`F1.5`) — sin empezar

- **Fuente:** plan de Fase 1 §9, runbook («Verificación periódica» y «Puerta de salida de Fase 1») y `PROJECT_STATUS.md` («Evidencia requerida para cambiar de fase»).
- **Estado (verificado):** no hay evidencia de captura pública sin credenciales ni ensayos de reinicio y de fallo de almacenamiento.
- **Esperado:**
  - capturar el flujo público sin credenciales;
  - que reinicio, desconexión y fallo de persistencia no oculten pérdida;
  - reproducir un dataset con el mismo identificador;
  - que los documentos reflejen el sistema real.
- **Abierto:** decisión humana al cerrar la fase sobre el orden entre la Fase 1B (datos MT5) y la Fase 2 (bot shadow).

### P-F1-07. Pendientes menores ya registrados — menor registrado

`PROJECT_STATUS.md` los mantiene en «Pendientes registrados de F1.2», «de F1.3» y «de F1.4a», y este documento no los repite. Entre ellos, dos tienen fecha límite explícita:

- antes de publicar datasets vivos largos: límites de lectura y artefactos que crecen sin segmentar (F1.3, pendiente 2);
- antes de desplegar: un rol de PostgreSQL de solo inserción y lectura (F1.3, pendiente 4; ADR-0006).

Comprobado en el repositorio:

- la guardia documental no tiene regla para `packages/domain/**` (F1.2, pendiente 3);
- `qualityProfileSchema` está repetido (F1.2, pendiente 4; aquí D-14).

## 2. Línea visual V1

### P-V1-01. Cierre de la línea visual — parcial, con decisión humana

- **Fuente:** plan V1 §7 y roadmap («Criterio de salida»).
- **Estado (verificado):**
  - los requisitos `V1-*` tienen implementación fusionada;
  - `PROJECT_STATUS.md` todavía dice que, para cerrarla, falta que el propietario revise las capturas;
  - ADR-0010 registra que el propietario aprobó el instalador de escritorio;
  - no hay registro de su revisión de la identidad V1.6 ni de las capturas del sitio y el móvil posteriores.
- **Esperado:** la línea queda `done` cuando sus requisitos tienen evidencia fusionada y el propietario revisó las capturas de los prototipos y del sitio.
- **Abierto (decisión humana):** el propietario escribió en la conversación «está perfecto» (escritorio) y «ok está bien» (identidad). Falta que confirme si eso cuenta como la revisión del §7 para todo. Si es así, el cierre se registra en `PROJECT_STATUS.md`, que pide actualizarse cuando cambia el estado de una fase.

### P-V1-02. Pendientes de la identidad (`V1-BRAND-002`, PR #19) — menor registrado

- **Estado (verificado):**
  - la prueba de trazados solo rechaza tiradores exactamente nulos;
  - ADR-0011 no define cómo se calcula el 95,7 % de parecido de la palabra (es una superposición «suave»);
  - solo el tono de `healthy` tiene prueba de distancia frente al verde azulado de marca. El cian de `demo` queda a unos 15°, lo que la guía §5 acepta.
- **Esperado:** el plan V1 pide que la marca no se use en estados y que «saludable» quede a 25° o más. Las tres mejoras son menores de la revisión, no requisitos.
- **Componentes:** `packages/design-system/test`, ADR-0011.

### P-V1-03. Contexto dentro de la curva de resultados — contradicho

- **Fuente:** guía de marca §8: «Toda curva de resultados indica modo, período, muestra y costes en el propio gráfico».
- **Estado (verificado):** `EquityChart` no recibe contexto. El período solo se ve en las fechas del eje; la muestra y los costes están en la tarjeta «Evidencia» de al lado ([flujo de gráficos](../diseno/flujo-de-graficas.md) §9).
- **Abierto (decisión humana):** cambiar el gráfico para cumplir la guía, o aceptar en la guía que el contexto vaya al lado. Lo primero cambia código; lo segundo, la guía.

### P-V1-04. Gráficos: accesibilidad, pruebas y unidades — sin documentar hasta ahora

- **Fuente:**
  - guía §10 («Contraste… comprobado por pruebas» y «Ninguna información depende solo del color»);
  - AGENTS.md (pruebas derivadas de los criterios).
- **Estado (verificado):**
  - el contraste de la línea y la rejilla de los gráficos no se mide;
  - no hay pruebas de `scaleFor`, `segments` ni del SVG exportado;
  - la descripción accesible de cada gráfico se escribe a mano, y no hay tabla alternativa;
  - la peor caída se muestra como «3,6 pts» y el contexto dice «−3,6 %».
- **Esperado:** no hay un criterio de aceptación concreto para gráficos más allá de la guía §10.
- **Propuesta:** antes de los gráficos con datos reales de la Fase 2, definir en el concepto de interfaz:
  - la alternativa textual o tabular;
  - la unidad de la peor caída;
  - una prueba de contraste de los tokens `chart`.

### P-V1-05. Móvil: teléfono real, reautenticación e interpretación del modo real — menor registrado y decisiones humanas

- **Fuente:** ADR-0009 («Pendientes»), `PROJECT_STATUS.md` («Decisiones pendientes») y el catálogo de funciones (pedir el modo `real`).
- **Estado (verificado):**
  - no se probó en un teléfono real; Expo Go para el SDK 58 no estaba en las tiendas al aceptar ADR-0009;
  - las pruebas usan React Native for Web, y no ven diferencias de Android o iOS;
  - el PR #16 dejó dos puntos abiertos: qué cuenta como reautenticación en un teléfono, como riesgo para la revisión de amenazas de la Fase 5, y la confirmación del propietario de que «pedir» el modo real desde el móvil nunca es operar desde él.
- **Abierto:** las tres son decisiones o pruebas humanas.

### P-V1-06. Escritorio: firma y ventanas — menor registrado

- **Fuente:** ADR-0010 («Pendientes»), `PROJECT_STATUS.md` y los PR #17 y #18.
- **Estado (verificado):**
  - el instalador no está firmado;
  - `window.open` queda bloqueado solo porque la app no define quién recibe la ventana nueva;
  - `scripts/data-replay.mjs` no se ejecuta en Windows en CI.
- **Esperado:** firmar el instalador antes de distribuirlo. La app real tendrá ventanas separables y un manejador explícito de `window.open`.

### P-V1-07. Sitio: publicación — decisión humana

- **Fuente:** ADR-0008 («Pendientes») y sitio oficial §4.
- **Estado (verificado):** el sitio lleva `noindex` y no tiene dominio ni alojamiento.
- **Esperado:** dominio, alojamiento, revisión legal del aviso de riesgo y de la nota de marcas, y quitar `noindex` en el mismo PR que lo publique.

## 3. Fases posteriores

Solo se listan; sus planes no existen todavía y el roadmap describe el destino.

- **Fase 1B (datos MT5).** Roadmap y ADR-0007 («Pendientes»). Antes del puente hay que decidir:
  - el equipo de la terminal y su protección;
  - la revisión de términos de Deriv MT5, Vantage y MetaQuotes.

  No existe código MT5, como manda el plan.
- **Fases 2 a 7.** Roadmap. No están autorizadas.
- **Despliegue.** ADR-0006 y arquitectura objetivo. Siguen pendientes:
  - el alojamiento del worker;
  - el proveedor S3 productivo; el único marcador en código es un comentario en `apps/market-data-worker/src/s3/object-store.ts`;
  - la distribución de la app móvil.

## 4. Documentos desactualizados

### Corregidos junto con este documento

- `README.md`, «Desarrollo actual»: no mencionaba F1.4a ni la línea visual.
- Roadmap, línea visual V1: faltaba el incremento 6 (identidad, V1.6).
- ADR-0008 y ADR-0009, «Pendientes»: listaban como pendientes el móvil y el escritorio, que ya se entregaron.
- Plan de Fase 1 §4: el escritorio quedaba fuera de la excepción de los prototipos visuales.
- Plan de Fase 1 §8: no decía que F1.4 se entrega en dos partes.
- Plan V1 §1: el objetivo no nombraba el escritorio.
- README de `packages/design-system`: faltaba `logo:write`.
- CONTRIBUTING.md: no decía que en CI no se pueden justificar excepciones de la guardia.

### Sin corregir

- **ADR-0006** («no autoriza a crear `apps/web` ni `apps/mobile` en Fase 1»). Sigue siendo cierto para producción; los prototipos llegaron por ADR-0008 a ADR-0010. Se deja como está porque es el texto de una decisión aceptada.

## 5. Decisiones humanas abiertas

| Decisión | Pendiente | Dónde se registra hoy |
|---|---|---|
| ¿Las respuestas del propietario cierran la revisión de capturas de la línea V1? | P-V1-01 | Este documento |
| ¿La curva de resultados lleva el contexto dentro, o se cambia la guía? | P-V1-03 | Este documento |
| ¿«Pedir» el modo real desde el móvil, nunca operar? | P-V1-05 | PR #16 |
| Probar en un teléfono real y cómo distribuir la app | P-V1-05 | `PROJECT_STATUS.md` |
| Firmar el instalador de escritorio | P-V1-06 | `PROJECT_STATUS.md` |
| Dominio, alojamiento y revisión legal del sitio | P-V1-07 | `PROJECT_STATUS.md` |
| Universo de índices y tipos de contrato | P-F1-01 | `PROJECT_STATUS.md` |
| Orden entre la Fase 1B y la Fase 2 | P-F1-06 | `PROJECT_STATUS.md` |
| Equipo de la terminal MT5 y revisión de términos | §3 | `PROJECT_STATUS.md` |
| Proveedor S3 productivo y alojamiento del worker | §3 | `PROJECT_STATUS.md` |
