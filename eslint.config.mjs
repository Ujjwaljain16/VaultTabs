// @ts-check
/**
 * ESLint flat config for the whole VaultTabs monorepo (run `npm run lint` from the root).
 *
 * Type-aware rules are intentionally not enabled: they would require every workspace to be built
 * (shared/dist, .wxt types, next-env.d.ts) before linting. `npm run typecheck` covers types.
 */
import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.output/**',
      '**/.wxt/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
      '**/next-env.d.ts',
      'pwa/public/**',
      'extension/public/**',
    ],
  },

  js.configs.recommended,
  tseslint.configs.recommended,

  // ── Defaults for every file ────────────────────────────────────────────────────────────────
  {
    linterOptions: { reportUnusedDisableDirectives: 'warn' },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      '@typescript-eslint/consistent-type-imports': ['warn', { fixStyle: 'inline-type-imports' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },

  // ── Node: backend, shared, root tooling ────────────────────────────────────────────────────
  {
    files: ['backend/**/*.{ts,js,mjs,cjs}', 'shared/**/*.{ts,js,mjs}', '*.{js,mjs,cjs,mts,ts}'],
    languageOptions: { globals: { ...globals.node } },
  },
  // shared/ also runs in browsers and service workers (WebCrypto, atob/btoa).
  {
    files: ['shared/**/*.ts'],
    languageOptions: { globals: { ...globals.browser } },
  },
  // Backend CLI scripts (migrations, cleanup, one-off tools) print to stdout on purpose.
  {
    files: ['backend/src/db/**/*.ts', 'backend/scripts/**/*.{ts,js,mjs}', 'backend/test/**/*.ts'],
    rules: { 'no-console': 'off' },
  },

  // ── Browser: extension and PWA ─────────────────────────────────────────────────────────────
  {
    files: ['extension/**/*.{ts,tsx,js,mjs}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.webextensions, ...globals.serviceworker },
    },
  },
  {
    files: ['pwa/**/*.{ts,tsx,js,jsx,mjs}'],
    plugins: { 'react-hooks': reactHooks, '@next/next': nextPlugin },
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { next: { rootDir: 'pwa/' } },
    rules: {
      // Only the classic hooks rules; the React Compiler rules in the plugin's preset are opt-in.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      // App Router only: there is no pages/ directory.
      '@next/next/no-html-link-for-pages': 'off',
    },
  },
  // Next.js config / custom server files run in Node.
  {
    files: ['pwa/*.{js,mjs,cjs,ts}', 'extension/*.{js,mjs,cjs,ts}'],
    languageOptions: { globals: { ...globals.node } },
  },
  // CommonJS files
  {
    files: ['**/*.cjs', 'pwa/next.config.js', 'pwa/server.js'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },

  // ── Tests ──────────────────────────────────────────────────────────────────────────────────
  {
    files: ['**/*.test.ts', '**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
