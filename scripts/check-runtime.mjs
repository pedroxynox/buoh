const expectedNode = 'v24.22.0';
const expectedPnpm = 'pnpm/12.14.0';
const userAgent = process.env['npm_config_user_agent'] ?? '';

if (process.version !== expectedNode) {
  throw new Error(`Node incorrecto: esperado ${expectedNode}, recibido ${process.version}.`);
}

if (!userAgent.startsWith(expectedPnpm)) {
  throw new Error(
    `pnpm incorrecto: esperado ${expectedPnpm}, recibido ${userAgent || 'desconocido'}.`,
  );
}

console.log(`runtime: ${expectedNode}, ${expectedPnpm}`);
