// @ts-check
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: [
      '**/coverage/**',
      '**/dist/**',
      '**/generated/**',
      '**/node_modules/**',
      '**/.next/**',
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
