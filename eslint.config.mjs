// Flat config for ESLint 9 + eslint-config-next 15.
//
// eslint-config-next 15 still ships legacy (eslintrc) shareable configs, so it
// is loaded through FlatCompat rather than imported directly. Next 16's package
// exports flat arrays and would not need this shim — see the Task 6 report for
// why the project is pinned to Next 15 / TypeScript 5.
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({
  baseDirectory: dirname(fileURLToPath(import.meta.url)),
});

const eslintConfig = [
  {
    ignores: [
      '.next/**',
      'out/**',
      'build/**',
      'node_modules/**',
      'next-env.d.ts',
      'shopify-app/**',
      'Pulse CRM Interface Design/**',
    ],
  },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
];

export default eslintConfig;
