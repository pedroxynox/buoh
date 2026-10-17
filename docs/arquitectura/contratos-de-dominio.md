# Contratos de dominio y eventos

## Estado y objetivo

Este documento es la referencia previa al código para los contratos que cruzan clientes, API, trabajadores, investigación y futura ejecución. Su objetivo es evitar que web, móvil, Python y servicios interpreten de forma distinta un tick, una señal o una orden.

Durante Fase 1 solo se implementarán `MarketTick`, `Dataset` y sus incidencias de calidad. Los contratos de señal y ejecución se diseñan ahora, pero permanecen deshabilitados hasta sus fases correspondientes.

## Reglas transversales

- Todo contrato tiene `schema_version` y se valida en runtime.
- Todos los instantes se representan en UTC con formato RFC 3339/ISO 8601 y precisión explícita.
- Importe, precio, stake, saldo y límite monetario se representan como decimal canónico en texto o como entero escalado con unidad declarada; nunca como `float` binario.
- Los identificadores son opacos, inmutables y correlacionables. La implementación preferida es UUIDv7 o equivalente ordenable.
- Los eventos no se mutan: una corrección o estado nuevo se agrega como evento posterior.
- Los consumidores ignoran campos nuevos desconocidos, pero rechazan versiones de esquema incompatibles.

## Envoltorio común de evento

Todo evento publicado internamente usa el siguiente sobre conceptual:

```text
EventEnvelope<T>
├── event_id
├── event_type
├── schema_version
├── occurred_at_utc
├── producer
├── environment            # research | shadow | demo | real
├── correlation_id
├── causation_id?          # evento que originó este evento
├── payload: T
└── integrity_hash?        # huella del lote o contenido cuando aplique
```

`environment` es obligatorio en señales, intenciones y eventos de ejecución. No se permite transformar un evento de un entorno en otro.

## Contratos principales

### `MarketTick`

```text
MarketTick
├── source
├── symbol
├── quote_decimal
├── event_time_utc
├── received_at_utc
├── source_sequence?
├── source_epoch?
├── raw_payload_hash
└── quality_flags[]
```

Reglas: `symbol`, fuente y marca de tiempo son obligatorios; `received_at_utc` nunca sustituye al tiempo de fuente. Un tick duplicado, tardío o fuera de orden se conserva con su bandera, no se borra silenciosamente.

### `Dataset`

```text
Dataset
├── dataset_id
├── source
├── symbols[]
├── time_range_utc
├── raw_object_uris[]
├── schema_version
├── quality_summary
├── created_at_utc
└── content_hash
```

Un experimento apunta a un `dataset_id` inmutable. Los archivos crudos se guardan en Parquet/object storage; la base relacional mantiene metadatos y procedencia.

### `StrategyDefinition`

```text
StrategyDefinition
├── strategy_id
├── version
├── status                 # draft | reviewed | shadow | demo | real | retired
├── input_contract_version
├── universe
├── parameters
├── entry_rules
├── exit_rules
├── risk_policy_id
├── author
├── created_at_utc
└── evidence_refs[]
```

Una estrategia activa es inmutable. Cambiar reglas, parámetros, universo o política crea una versión nueva y reinicia su validación.

### `SignalEvent`

```text
SignalEvent
├── signal_id
├── strategy_id
├── strategy_version
├── symbol
├── emitted_at_utc
├── expires_at_utc
├── condition
├── direction_or_contract_intent
├── evidence_ref
├── data_window_ref
├── data_quality_status
└── mode                   # shadow | demo | real
```

Una señal es evidencia de una condición; no es una orden. Debe expirar y puede ser descartada por el motor de riesgo aunque sea válida en su origen.

### `RiskPolicy`

```text
RiskPolicy
├── policy_id
├── version
├── environment
├── permitted_instruments[]
├── permitted_contract_types[]
├── maximum_action_amount
├── maximum_concurrent_exposure
├── frequency_limits
├── data_freshness_limit
├── allowed_schedule
├── pause_conditions[]
├── approval_metadata
└── effective_from_utc
```

El evaluador de política recibe solo datos explícitos y devuelve `accepted` o `rejected` con motivos estructurados. Nunca decide por valores implícitos de UI o estado global.

### `ExecutionIntent`

```text
ExecutionIntent
├── intent_id
├── idempotency_key
├── signal_id
├── strategy_id
├── strategy_version
├── risk_policy_id
├── authorization_id
├── environment
├── requested_at_utc
├── requested_action
└── precondition_snapshot
```

Solo `execution-gateway` puede consumir una intención aceptada. Si el resultado externo es ambiguo, el servicio reconcilia antes de crear otra intención.

### `ExecutionEvent`

```text
ExecutionEvent
├── execution_event_id
├── intent_id
├── broker
├── external_order_or_contract_id?
├── status
├── occurred_at_utc
├── broker_payload_hash?
└── reconciliation_status
```

Los eventos de ejecución son anexos: `submitted`, `acknowledged`, `rejected`, `reconciled`, `failed` o `manual-review`. Nunca se reemplaza el historial de una orden.

## Versionado y compatibilidad

- Cambios aditivos compatibles incrementan versión menor de esquema.
- Eliminar, renombrar o cambiar semántica incrementa versión mayor y requiere adaptador de migración.
- Todo cambio de contrato debe incluir vectores de prueba compartidos para TypeScript y Python.
- Los esquemas ejecutables vivirán en `packages/contracts` al iniciar el monorepo; este documento se actualizará junto a ellos.
