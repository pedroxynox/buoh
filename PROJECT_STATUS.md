---
schema_version: "1.0.0"
status_version: 1
updated_at_utc: "2026-10-17T22:32:08.000Z"
current_phase: "Fase 1 — Fundación de datos"
phase_status: "ready"
active_work: null
next_delivery: "F1.1"
next_requirements:
  - "F1-FOUND-001"
  - "F1-CONTRACT-001"
  - "F1-GOV-001"
plan: "docs/plan/fase-1-fundacion-de-datos.md"
---

# Estado actual de buoh

Este archivo describe únicamente el estado vigente. No es un diario: Git y los pull requests conservan el historial. Su contenido entra en vigor al fusionarse el cambio que lo modifica.

## Objetivo actual

Construir una base de datos de mercado reproducible: recibir datos públicos de Deriv, preservar cada frame crudo, normalizar ticks con contratos ejecutables, registrar incidencias de calidad y publicar datasets inmutables que puedan reproducirse de forma idéntica.

## Situación

- La fundación de producto, arquitectura, seguridad y operación está aprobada.
- El contrato de implementación de Fase 1 está listo para iniciar código.
- No existe todavía monorepo ejecutable, worker, integración de datos, base de datos ni despliegue.
- No existe estrategia, señal, conexión de cuenta ni ejecución `demo` o `real`.

## Siguiente tarea autorizada

**`F1.1` — Toolchain, contratos y guardia documental.**

Crear Node/pnpm fijados, configuración raíz, `packages/contracts`, el validador de integridad de vectores y el mapa/chequeo de impacto documental. Debe atender `F1-FOUND-001`, `F1-CONTRACT-001` y `F1-GOV-001`. No crea todavía infraestructura, conexión Deriv, web, móvil, señales ni ejecución.

## Decisiones vigentes relevantes

- TypeScript estricto es el lenguaje principal; Python queda fuera de la ruta de ingesta inicial.
- Fase 1 usa PostgreSQL estándar y almacenamiento S3-compatible; TimescaleDB y Redis están diferidos hasta demostrar su necesidad.
- El adaptador inicial usa únicamente el WebSocket público de Deriv, sin autenticación.
- Datos crudos y normalizados son artefactos distintos; una incidencia nunca reescribe el dato crudo.
- El primer incremento implementa `pnpm run verify` y validación de integridad/esquemas de los vectores; la comparación completa del pipeline llega en F1.2.
- Las pruebas offline sintéticas son bloqueantes. El smoke público de Deriv aparece en F1.4, es explícito y nunca constituye el único criterio de merge.

## Bloqueos

Ninguno para iniciar `F1.1`.

## Decisiones pendientes que no bloquean Fase 1

- Jurisdicción inicial del producto comercial.
- Universo definitivo de índices y tipos de contrato.
- Proveedor de almacenamiento de objetos en producción.
- Límites monetarios y política de riesgo para fases `demo` y `real`.
- Proveedor de pagos y modelo de suscripción.

## Evidencia requerida para cambiar de fase

La Fase 1 solo puede marcarse `done` cuando todos sus requisitos tienen pruebas y evidencia, un dataset se reproduce con el mismo identificador y las incidencias de calidad permanecen visibles tras reinicios.

## Mantenimiento obligatorio

Actualizar este archivo en el mismo PR cuando cambie cualquiera de estos elementos:

- fase o estado de fase;
- objetivo o tarea siguiente;
- bloqueo o decisión pendiente;
- componente autorizado para implementarse;
- evidencia de una puerta de salida.

No actualizarlo por cambios internos que no alteren el estado del proyecto. No registrar porcentajes subjetivos de avance ni afirmar verificaciones no ejecutadas.
