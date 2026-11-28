# Vectores de `StrategyDefinition` 1.0.0

Vectores compartidos de [ADR-0022](../../../docs/arquitectura/adr/0022-modelo-de-estrategia.md) §11 para validar una definición, en TypeScript (`packages/contracts`) y, con el motor de investigación, en Python. Su semántica está en los [contratos de dominio](../../../docs/arquitectura/contratos-de-dominio.md#strategydefinition). Los datos son sintéticos: las cuentas, los perfiles y los hashes no son de producción.

- `valid.json`: definiciones válidas, cada una con su `version_id`, `sha256:` más el SHA-256 de su JCS (RFC 8785).
- `invalid.json`: entradas inválidas, cada una con la lista exacta de sus errores (`code` y `path`), en el orden del contrato. Cada una tiene un solo fallo, salvo cuatro: dos referencias fuera de la lista, que dejan además un indicador sin usar y, frente a otro indicador, no dan el error de los lados; una salida en un sube/baja con los lados cambiados, que fija que una ruta va antes que las que la continúan; y dos horas fuera de rango, que fijan el orden por el número del índice. Los mensajes no son parte del vector.
- `manifest.json`: el tamaño y el SHA-256 de los bytes de cada archivo. Cambiar un vector cambia su hash, y la prueba falla hasta actualizar el manifiesto.

Los errores esperados salen de la ADR, no del código, y los identificadores se calcularon fuera de `packages/contracts`. Los comprueba `packages/contracts/test/strategy-definition.test.ts`, que también exige que cubran cada código de la lista cerrada.
