---
plan_id: "F1-DATA"
schema_version: "1.0.0"
status: "ready"
effective_when_merged: true
owner: "propietario de buoh"
last_reviewed_utc: "2026-10-24T03:10:00.000Z"
---

# Plan ejecutable: Fase 1 — Fundación de datos

## 1. Objetivo

Demostrar que buoh puede capturar datos públicos de Deriv, preservar frames crudos, normalizar ticks, detectar problemas de calidad y publicar un dataset inmutable que produce el mismo resultado al reproducirse.

Fase 1 no intenta demostrar una estrategia rentable. Su producto es **evidencia confiable** para que las estrategias futuras no se construyan sobre datos ambiguos.

## 2. Estado y aprobación

`ready`: este plan autoriza comenzar código cuando el PR que lo contiene sea fusionado. Cambiar alcance, almacenamiento, semántica de contratos o criterios de salida requiere actualizar este plan y, si la decisión es duradera, una ADR.

## 3. Definition of Ready

- Toolchain inicial fijado: Node.js 24.22.0 LTS y pnpm 12.14.0.
- Visión, arquitectura y gobierno fundacionales fusionados.
- [ADR-0004](../arquitectura/adr/0004-pipeline-y-reproduccion-de-datos-fase-1.md) aceptada.
- Contratos conceptuales de Fase 1 definidos sin alternativas abiertas.
- Vectores sintéticos versionados y revisables sin red.
- Ningún secreto, cuenta o dato real requerido para comenzar.

## 4. Corte de implementación

### Crear durante Fase 1

```text
package.json
pnpm-workspace.yaml
turbo.json
toolchain versionado
apps/market-data-worker/
packages/contracts/
packages/domain/                 # solo dominio de datos de mercado
infra/compose.yaml               # PostgreSQL estándar + S3-compatible local
test-vectors/market-data/v1/
```

### Contrato o interfaz mínima, sin producto futuro

- Adaptador de fuente pública desacoplado del normalizador. Desde F1.4b, el transporte, el normalizador, el vocabulario del perfil y el validador de esquemas propios de una fuente se eligen por fuente a partir del perfil y las versiones que el dataset publica, para que el replay reproduzca la elección y otras fuentes entren sin tocar el log ni la publicación ([ADR-0007](../arquitectura/adr/0007-varias-fuentes-y-metatrader-5.md)).
- Puerto de almacenamiento de objetos y repositorio de metadatos.
- Reporte de salud estructurado para CLI/observabilidad; no una interfaz gráfica.
- Punto de extensión para reglas de calidad versionadas.

### Diferido explícitamente

`apps/api`, `apps/web` (salvo el prototipo visual de la [línea visual V1](linea-visual-v1.md)), `apps/mobile`, `signal-engine`, `execution-gateway`, escritorio, Python, backtests, estrategias, señales, OAuth, cuentas, pagos, suscripciones, Redis, TimescaleDB, despliegue productivo de Render y fuentes MetaTrader 5 (Fase 1B, ADR-0007).

No se crean directorios vacíos para estos componentes.

## 5. Interfaz de comandos por incremento

Los nombres son contrato de Fase 1, pero cada comando aparece únicamente cuando tiene una implementación útil; no se crean stubs.

| Comando raíz | Se introduce | Comportamiento al introducirse |
|---|---|---|
| `pnpm run verify` | F1.1 | formato, lint, tipos y pruebas offline existentes |
| `pnpm run test:vectors` | F1.1 | primero valida integridad/esquemas del fixture; F1.2 añade comparación completa del pipeline |
| `pnpm run data:replay -- --dataset <id>` | F1.3 | reproduce un dataset sin contactar a Deriv |
| `pnpm run data:smoke` | F1.4 | ejecuta prueba viva opt-in contra Deriv |
| `pnpm run data:health -- --json` | F1.5 | emite el `HealthReport` machine-readable |

Antes de su incremento, un comando no existe. La documentación y `PROJECT_STATUS.md` indican cuál está disponible.

## 6. Requisitos y aceptación

### `F1-FOUND-001` — Scaffolding reproducible

**Dado** un clon limpio con Node.js 24.22.0 y pnpm 12.14.0 fijados, **cuando** se instala con lockfile y se ejecuta `pnpm run verify`, **entonces** todas las verificaciones offline terminan correctamente sin secretos ni red de mercado.

**Evidencia:** archivos de versión, lockfile, salida de `pnpm run verify` y árbol limitado al corte autorizado.

### `F1-CONTRACT-001` — Contratos runtime

`packages/contracts` define y valida `SourceEvent` (incluido `RawSourceFrame`), `IngestionCursor`, `MarketTick`, `DataQualityIncident`, `OperationalConditionEvent`, `DatasetManifest`, `PublishedManifestRecord` y `HealthReport` con los tipos exactos de [contratos de dominio](../arquitectura/contratos-de-dominio.md). Entradas desconocidas o incompatibles fallan con errores estructurados; ningún valor monetario o cotización usa punto flotante de dominio.

**Evidencia:** pruebas positivas/negativas y JSON Schema generado desde una única fuente ejecutable.

### `F1-VECTOR-001` — Oráculo sintético

**Dado** `test-vectors/market-data/v1`, **cuando** F1.2 ejecuta `pnpm run test:vectors`, **entonces** segmentos de source events, ticks, incidencias, condiciones, publicaciones, salud y hashes coinciden con los archivos esperados. Debe incluir el subvector multi-segmento principal y `zero-valid-ticks`. La suite no usa reloj real, aleatoriedad no inyectada, red ni servicios externos.

**Evidencia:** salida de la suite y checksums verificados del manifiesto de vectores.

### `F1-CATALOG-001` — Catálogo público versionado

El worker consulta `active_symbols` mediante el canal público de Deriv y persiste un snapshot con fecha de recepción UTC, versión del conector, versión de esquema de fuente, hash de contenido y lista sin reinterpretar nombres oficiales.

**Aceptación:** dos snapshots se conservan como versiones diferentes si cambia el contenido; un payload inválido no reemplaza el último snapshot válido y genera incidencia.

### `F1-STREAM-001` — Captura raw-first

Cada frame WebSocket se asigna a un `RawSourceFrame` y se escribe en el buffer duradero del segmento antes de publicar un `MarketTick`. El texto UTF-8 de fuente se conserva exactamente; el normalizador nunca modifica el raw.

**Aceptación:** provocar un fallo de normalización conserva el frame y produce `invalid_source_frame`; provocar un fallo de almacenamiento impide emitir el tick.

### `F1-QUALITY-001` — Calidad explícita y reproducible

Con una versión de reglas fijada, el pipeline registra duplicado exacto, conflicto de tiempo de fuente, fuera de orden, entrega retrasada, payload inválido, pérdida de conexión, hueco no resuelto, indisponibilidad de persistencia y límite de fuente excedido. Cada incidencia referencia observaciones, regla y evidencia; las condiciones abren/resuelven mediante eventos separados y no reescriben registros previos.

**Aceptación:** el vector v1 genera exactamente source events, ticks, incidencias y condiciones esperados; salud contiene solo condiciones cuya última acción es `opened`.

### `F1-RECONNECT-001` — Reconexión sin ocultar huecos

Ante `ConnectionClosed` no solicitado, el worker conserva naturaleza y símbolos afectados, cambia a `recovering`, usa espera exponencial con jitter inyectable, consulta historia por símbolo y solo vuelve a `healthy` cuando continuidad y persistencia se verifican. Si la recuperación no es posible, registra `event_gap_unresolved` y permanece `degraded` o `paused` según la política.

**Evidencia:** prueba con reloj/transporte falsos y smoke vivo separado.

### `F1-DATASET-001` — Publicación inmutable y atómica

Un dataset publicado contiene artefactos lógicos multi-segmento unidos a objetos por `artifact_id`, perfiles/versiones completos, documento canónico con digest propio y `PublishedManifestRecord`. `dataset_id` se deriva exclusivamente de `DatasetManifestCore` según ADR-0004.

**Aceptación:** recomputación produce hashes lógicos y `dataset_id` idénticos; `--verify-only` se limita a integridad. Cada objeto y documento coincide con su hash. Cero ticks conserva objetos vacíos de cero bytes. Un fallo antes del commit no crea publicación visible.

### `F1-HEALTH-001` — Salud machine-readable

`pnpm run data:health -- --json` valida y emite `HealthReport` con salud, conexión, backlog por conteo/bytes, últimos datos/dataset y condiciones abiertas derivadas. Los estados permitidos son `starting`, `healthy`, `degraded`, `recovering`, `paused` y `failed`.

**Aceptación:** almacenamiento no disponible produce `paused`; contrato/configuración incompatible produce `failed`; no se reporta `healthy` sin haber persistido datos.

### `F1-SOURCE-001` — Adaptador Deriv público y fijado

El adaptador usa el endpoint público documentado, sin OAuth, PAT ni OTP, y valida respuestas contra la release de esquemas fijada en ADR-0004. Aplica los límites de bytes/timeouts de esa ADR, envía keepalive dentro del intervalo recomendado y correlaciona solicitudes/respuestas cuando la fuente lo permite.

**Evidencia:** pruebas de adaptador con fixtures y `pnpm run data:smoke` opt-in.

### `F1-GOV-001` — Guardia documental inicial

El scaffolding añade un mapa de impacto y un chequeo local que indique qué fuentes documentales revisar según las rutas cambiadas. El chequeo no modifica automáticamente ADR, seguridad o riesgo; exige actualización o justificación explícita en el PR.

**Evidencia:** pruebas del mapa para cambios en contratos, worker, infraestructura y documentación.

## 7. Matriz de pruebas y evidencia

| Categoría | Bloquea merge | Fuente | Evidencia |
|---|---:|---|---|
| Unitarias y propiedades | sí | contratos/dominio | salida reproducible |
| Vectores sintéticos | sí | `test-vectors/` | NDJSON lógico/JCS, conteos y hashes declarados |
| Integración local | sí cuando exista persistencia | PostgreSQL + S3 local | dataset publicado/reproducido |
| Fallos y reinicio | sí para requisito afectado | transporte/reloj/storage falsos | estado e incidencias esperados |
| Smoke vivo Deriv | no por sí solo | endpoint público | fecha, schema release y resultado sanitizado |
| Rendimiento | informativo en Fase 1 | fixture versionado | tasa, memoria y backlog sin objetivo prematuro |

Una prueba viva nunca sustituye una prueba offline, porque la red y el mercado no son deterministas.

## 8. Secuencia de entrega

1. **F1.1:** Node/pnpm fijados, contratos runtime, validador de integridad del fixture, `verify`, `test:vectors` y guardia documental (`F1-FOUND-001`, `F1-CONTRACT-001`, `F1-GOV-001`).
2. **F1.2:** normalización y reglas de calidad puras; completar oráculo del pipeline (`F1-VECTOR-001`, `F1-QUALITY-001`).
3. **F1.3:** PostgreSQL, object storage, source event log, publicación y replay (`F1-STREAM-001`, `F1-DATASET-001`).
4. **F1.4:** catálogo y streaming público de Deriv (`F1-CATALOG-001`, `F1-SOURCE-001`).
5. **F1.5:** reconexión, recuperación, salud y demostración de puerta (`F1-RECONNECT-001`, `F1-HEALTH-001`).

Cada incremento debe ser utilizable, revisable y sin componentes futuros vacíos.

## 9. Definition of Done

Fase 1 está `done` únicamente cuando:

- todos los requisitos `F1-*` tienen evidencia fusionada;
- un clon limpio ejecuta verificaciones offline con toolchain fijado;
- los vectores se reproducen exactamente;
- un flujo público de Deriv puede capturarse sin credenciales;
- raw, normalizados e incidencias tienen procedencia y versiones;
- un dataset publicado conserva el mismo ID en replay;
- reinicio, desconexión y fallo de persistencia no ocultan pérdida ni emiten datos no durables;
- `PROJECT_STATUS.md`, contratos, ADR y runbook reflejan el sistema real.

## 10. Restricciones y preguntas no bloqueantes

- El universo comercial definitivo no se decide con el catálogo de Fase 1.
- Los umbrales live se configuran por fuente/símbolo y se registran por versión; solo el perfil sintético tiene valores fijos.
- La región y proveedor productivo se decidirán antes de desplegar; el diseño debe permanecer portable a Render y S3-compatible.
