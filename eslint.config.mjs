// @ts-check
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const MOBILE_NO_WEB_COMPONENTS = {
  group: ['@buoh/design-system/react', '@buoh/design-system/react/*'],
  message:
    'Los componentes web del design system traen React 19.3.1; el móvil usa solo la entrada raíz (ADR-0009).',
};

export default defineConfig(
  {
    ignores: [
      '**/coverage/**',
      '**/dist/**',
      '**/generated/**',
      '**/node_modules/**',
      '**/.next/**',
      '**/.expo/**',
      '**/out/**',
      '**/next-env.d.ts',
      'test-vectors/**',
    ],
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommendedTypeChecked,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          fixStyle: 'inline-type-imports',
          prefer: 'type-imports',
        },
      ],
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
    },
  },
  // Interfaces web (ADR-0008): React en navegador.
  {
    files: ['**/*.tsx', 'apps/web/**/*.ts', 'apps/site/**/*.ts'],
    extends: [reactHooks.configs.flat['recommended-latest']],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  // Las apps Next.js leen `tsconfig.json` sin alias (Next resuelve los paquetes desde `dist`);
  // ESLint usa `tsconfig.typecheck.json`, con alias a `src`, para no depender del build.
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ['./apps/web/tsconfig.typecheck.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  // Móvil (ADR-0009): React Native exige React 19.3.0 exacto. Los componentes web del design system
  // traen React 19.3.1 y no deben entrar en el paquete móvil; la app tampoco usa react-dom.
  {
    files: ['apps/mobile/**/*.{ts,tsx,mts}'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ['./apps/mobile/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-restricted-imports': ['error', { patterns: [MOBILE_NO_WEB_COMPONENTS] }],
    },
  },
  {
    files: ['apps/mobile/index.ts', 'apps/mobile/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            MOBILE_NO_WEB_COMPONENTS,
            {
              group: ['react-dom', 'react-dom/*'],
              message:
                'La app móvil dibuja con React Native; react-dom solo se usa en las pruebas.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/site/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ['./apps/site/tsconfig.typecheck.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
);
