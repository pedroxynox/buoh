# @buoh/contracts

Fuente ejecutable de estructura y validación para los contratos de buoh.

## Responsabilidades

- Validar entradas runtime con objetos estrictos.
- Mantener tipos TypeScript inferidos desde Zod.
- Generar JSON Schema para consumidores futuros.
- Verificar RFC 8785, SHA-256, IDs derivados y relaciones entre campos.
- Validar la integridad de los vectores sintéticos de Fase 1.

No contiene lógica de estrategia, conexión a Deriv, almacenamiento ni ejecución.

## Comandos

Desde la raíz:

```text
pnpm run typecheck
pnpm run test
pnpm run test:vectors
pnpm run schemas:generate
pnpm run schemas:check
```

`generated/json-schema` es salida derivada y no se edita manualmente. Se publica mediante subpaths como `@buoh/contracts/json-schema/market-tick`. JSON Schema representa estructura interoperable; las invariantes relacionales y criptográficas requieren validadores runtime.

Los esquemas internos `*StructuralSchema` no forman parte del barrel público. Exponerlos permitiría aceptar IDs o relaciones sin autenticar.

## Uso

```ts
import { marketTickSchema } from '@buoh/contracts';

const tick = marketTickSchema.parse(input);
```

`parse` devuelve una copia validada o lanza un error estructurado. Los límites externos nunca deben confiar en una aserción de tipo sin validación runtime.

Las condiciones requieren además `validateConditionCausality`, que autentica claves contra source events e incidencias causales y devuelve `ContractContextError` con código/path/contexto al fallar. `validateMarketDataVectors` aplica esa validación, comprueba expectativas/perfiles y limita lecturas a la raíz sin symlinks, con 8 MiB por archivo y 64 MiB declarados por manifiesto.
