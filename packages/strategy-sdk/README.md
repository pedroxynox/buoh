# @buoh/strategy-sdk

El modelo de estrategia puro de [ADR-0022](../../docs/arquitectura/adr/0022-modelo-de-estrategia.md) (F2.6): la biblioteca de indicadores, los importes, la posición hipotética y el evaluador que comparten el backtest y el motor `shadow`. La definición de una estrategia, `StrategyDefinition`, está en `@buoh/contracts`.

No lee reloj, red, azar ni archivos: lo que necesita le llega en cada llamada (ADR-0022 §8).

## Lo que hay

- **La biblioteca de indicadores 1.0.0** (ADR-0022 §3), con las reglas de números de §8 y la precisión del PR 3a en §13: `initialIndicatorState` y `stepIndicator`, que da el estado siguiente y el valor en binario64, o `null` mientras está indefinido, sin modificar el estado anterior. El estado es JSON con números finitos, sin `-0`, y lleva su indicador (`indicatorKey`, como `sma(20)`): el de otro se rechaza. `decimalToBinary64` convierte un decimal canónico y rechaza `-0` y lo que no cabe en binario64, y `binary64Bits` da los 64 bits en hexadecimal, como los vectores.

Los importes de punto fijo, la posición y el evaluador llegan con los PR 3b y 3c (ADR-0022 §13).

## Vectores

[`test-vectors/strategy-indicators/v1`](../../test-vectors/strategy-indicators/v1/), compartidos con el motor de investigación en Python (ADR-0022 §11). Los comprueba `test/indicators.test.ts`, también con `pnpm run test:vectors`.
