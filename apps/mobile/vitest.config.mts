import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const require = createRequire(import.meta.url);
/** Entrada ESM de react-native-svg; su `main` es CommonJS y cargaría el React Native real. */
const svgModule = join(
  dirname(require.resolve('react-native-svg/package.json')),
  'lib/module/index.js',
);

/**
 * Las pantallas se renderizan con React Native for Web: así las pruebas comprueban el contenido real
 * de cada pestaña sin un teléfono. Las extensiones `.web.*` eligen las versiones web de las bibliotecas.
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: /^react-native$/, replacement: 'react-native-web' },
      { find: /^react-native-svg$/, replacement: svgModule },
      {
        find: /^@react-native\/assets-registry\/registry$/,
        replacement: join(
          dirname(fileURLToPath(import.meta.url)),
          'test',
          'stubs',
          'assets-registry.ts',
        ),
      },
    ],
    extensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.mjs', '.js', '.json'],
  },
  define: { __DEV__: 'false' },
  test: {
    environment: 'node',
    server: { deps: { inline: ['react-native-svg', 'react-native-web'] } },
  },
});
