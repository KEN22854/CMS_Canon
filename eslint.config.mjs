// One flat config for the whole monorepo: `pnpm lint` (CI runs it with zero warnings allowed).
import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/coverage/**', '**/.turbo/**', '**/next-env.d.ts', 'packages/db/prisma/migrations/**', '.trail/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports', fixStyle: 'inline-type-imports', disallowTypeAnnotations: false }],
      // Nest DI and Prisma JSON columns make a few `any`s/`!`s legitimate; review them, don't ban them.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
    },
  },
  {
    files: ['apps/admin/**/*.{ts,tsx}', 'apps/web/**/*.{ts,tsx}', 'packages/ui-blocks/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    files: ['apps/admin/**/*.{ts,tsx}', 'apps/web/**/*.{ts,tsx}'],
    plugins: { '@next/next': nextPlugin },
    rules: { ...nextPlugin.configs.recommended.rules, ...nextPlugin.configs['core-web-vitals'].rules },
    settings: { next: { rootDir: ['apps/admin', 'apps/web'] } },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // Nest controllers and providers are classes whose constructor parameters are injected by type.
    files: ['apps/api/src/**/*.ts'],
    rules: { '@typescript-eslint/consistent-type-imports': 'off' },
  },
  {
    files: ['**/test/**/*.ts', '**/*.test.ts', 'packages/*/scripts/**', 'packages/*/bench/**', '**/*.config.{ts,mts,mjs}', 'packages/db/prisma/seed*.ts', 'packages/db/prisma/seed/**/*.ts'],
    rules: { 'no-console': 'off', '@typescript-eslint/no-explicit-any': 'off' },
  },
);
