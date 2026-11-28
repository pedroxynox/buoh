# Vectores de la biblioteca de indicadores 1.0.0

Vectores compartidos de [ADR-0022](../../../docs/arquitectura/adr/0022-modelo-de-estrategia.md) §11 para los indicadores de §3, con las reglas de números de §8, en TypeScript (`packages/strategy-sdk`) y, con el motor de investigación, en Python. Los datos son sintéticos: ningún precio es de Deriv.

- `series.json`: las series, cada punto con su cierre, su máximo y su mínimo en decimal canónico y su instante UTC. En las series de ticks, el máximo y el mínimo son el cierre.
- `indicators.json`: cada caso nombra una serie y un indicador, con la forma de `StrategyDefinition`, y da su valor después de cada punto: los 64 bits del binario64 en hexadecimal, en el orden de la red (`struct.pack('>d', v).hex()` en Python), o `null` mientras está indefinido.
- `manifest.json`: el tamaño y el SHA-256 de los bytes de cada archivo. Cambiar un vector cambia su hash, y la prueba falla hasta actualizar el manifiesto.

Las series fijan los casos límite de ADR-0022 §12: los valores indefinidos, el precio quieto en `zscore`, `bollinger_pct` y `rsi`, solo subidas en `rsi`, una ruptura de `highest` y `lowest`, ventanas de 500 y los cambios de hora y de día. Fijan también el orden de las sumas (§11): en `r100_ticks`, una suma acumulada o compensada da otros bits en `sma`, y en `magnitudes`, con precios de magnitudes muy distintas, sumar al revés o compensada la media con la que empiezan `rsi` y `atr` da otros bits con `n` de 5 y 14. Con `n` de 2 el orden no cambia nada.

Los valores los calculó una implementación de referencia en Python escrita desde la ADR, fuera de `packages/strategy-sdk`, sin `sum()`, `math.fsum` ni NumPy. Los comprueba `packages/strategy-sdk/test/indicators.test.ts`.
