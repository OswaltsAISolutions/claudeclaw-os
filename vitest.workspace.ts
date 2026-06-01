import { defineWorkspace } from 'vitest/config';
import preact from '@preact/preset-vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

// Two isolated projects so the Preact UI can be tested in a DOM without
// disturbing the node-environment backend suite:
//   - backend: the existing vitest.config.ts (node env, src/**/*.test.ts)
//   - web:     jsdom env, web/src/**/*.test.{ts,tsx}, with the same @/ and
//              preact/compat aliases the app builds with.
export default defineWorkspace([
  './vitest.config.ts',
  {
    plugins: [preact()],
    resolve: {
      alias: {
        '@': resolve(root, 'web/src'),
        react: 'preact/compat',
        'react-dom': 'preact/compat',
      },
    },
    test: {
      name: 'web',
      environment: 'jsdom',
      include: ['web/src/**/*.test.{ts,tsx}'],
      setupFiles: ['web/src/test-setup.ts'],
    },
  },
]);
