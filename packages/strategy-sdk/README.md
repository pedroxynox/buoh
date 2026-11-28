# @buoh/strategy-sdk

El modelo de estrategia puro de [ADR-0022](../../docs/arquitectura/adr/0022-modelo-de-estrategia.md) (F2.6): la biblioteca de indicadores, los importes, la posición hipotética y el evaluador que comparten el backtest y el motor `shadow`. La definición de una estrategia, `StrategyDefinition`, está en `@buoh/contracts`.

No lee reloj, red, azar ni archivos: lo que necesita le llega en cada llamada (ADR-0022 §8).

## Lo que hay

- **La biblioteca de indicadores 1.0.0** (ADR-0022 §3), con las reglas de números de §8 y la precisión del PR 3a en §13: `initialIndicatorState` y `stepIndicator`, que da el estado siguiente y el valor en binario64, o `null` mientras está indefinido, sin modificar el estado anterior. El estado es JSON con números finitos, sin `-0`, y lleva su indicador (`indicatorKey`, como `sma(20)`): el de otro se rechaza. `stepIndicator` rechaza un punto o un resultado no finito o `-0`, y un instante negativo o no entero. `decimalToBinary64` convierte un decimal canónico y rechaza `-0` y lo que no cabe en binario64, y `binary64Bits` da los 64 bits en hexadecimal, como los vectores.
- **Los importes de punto fijo** (§5 y la precisión del PR 3b en §13): un `bigint` con 18 decimales (`parseFixed` y `formatFixed`), con productos exactos (`fixedProduct`, que rechaza uno que necesitaría más decimales), cocientes con 18 decimales (`fixedQuotient`) y centavos (`fixedToCents`), redondeados al par.
- **La posición hipotética** (§5, con sus precisiones de ADR-0024 §6): `openTickPosition`, `stepTickPosition` y `requestTickSale`, con ticks, y `openCandlePosition`, `stepCandlePosition` y `sellCandlePositionAtClose`, con velas de 1 minuto de Deriv. Cada paso devuelve el estado siguiente, JSON, y el cierre, con su causa y su resultado en centavos. `positionMarkCents` da el resultado del multiplicador abierto, y `initialDrawdownState`, `stepDrawdown` y `drawdownReached`, la caída máxima. Rechazan lo que no puede pasar: un tick anterior al último, una entrada con un tick de la recuperación o antes de la compra, una vela que no es de 1 minuto o que se solapa, unos costos del otro tipo de contrato o un paso tras el cierre.

El evaluador llega con el PR 3c (ADR-0022 §13): decide cuándo abrir, cuándo vender por reglas y qué hacer con un hueco, el mercado cerrado o el fin de la ventana.

## Vectores

[`test-vectors/strategy-indicators/v1`](../../test-vectors/strategy-indicators/v1/) y [`test-vectors/strategy-positions/v1`](../../test-vectors/strategy-positions/v1/), compartidos con el motor de investigación en Python (ADR-0022 §11). Los comprueban `test/indicators.test.ts` y `test/positions.test.ts`, también con `pnpm run test:vectors`.
