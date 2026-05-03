import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    dts: true,
    sourcemap: true,
    clean: true,
  },
  {
    entry: { 'cli/main': 'src/cli/main.ts' },
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    dts: false,
    sourcemap: true,
    banner: { js: '#!/usr/bin/env node' },
  },
]);
