import { randomBytes } from 'node:crypto';

import { accountCommand } from '../account-command.js';
import { createAccountService } from '../accounts/links.js';
import { loadCommonPasswords } from '../auth/common-passwords.js';
import { createPasswordHasher } from '../auth/password-hash.js';
import { createUuidV7Generator } from '../ids.js';
import { createPool, SERVICE_POOL_TIMEOUTS } from '../postgres/pool.js';
import { migrationState } from '../postgres/readiness.js';

/**
 * `node apps/api/dist/cli/cuenta.js alta <usuario>` o `… restablecer <usuario>`
 * (`pnpm --filter @buoh/api run cuenta -- …`): la orden `cuenta` de ADR-0019 §3, en la consola del
 * servicio `buoh-api`, con su entorno. Salida 0: el enlace en stdout; 1: no se creó; 2: un uso o una
 * configuración que no valen (`accountCommand`).
 */
const result = await accountCommand(process.argv.slice(2), process.env, {
  open: (config) => {
    const pool = createPool(config.postgres, SERVICE_POOL_TIMEOUTS);
    // El error de una conexión inactiva no tumba la orden: la consulta siguiente falla con él.
    pool.on('error', () => undefined);
    const clock = () => Date.now();
    return {
      migrationState: () => migrationState(pool),
      service: createAccountService({
        pool,
        environment: config.environment,
        origin: config.origin,
        keys: config.keys,
        hasher: createPasswordHasher({
          pepper: config.keys.passwordPepper,
          maxWaiting: 0,
          randomBytes,
        }),
        commonPasswords: loadCommonPasswords(),
        clock,
        randomBytes,
        newId: createUuidV7Generator({ now: clock, randomBytes }),
      }),
      close: () => pool.end(),
    };
  },
});
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
