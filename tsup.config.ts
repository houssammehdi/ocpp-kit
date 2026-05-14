import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', 'cli/main': 'src/cli/main.ts' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  // Shared code between the library and the CLI lands in a common chunk.
  splitting: true,
  dts: { entry: { index: 'src/index.ts' } },
  sourcemap: true,
  clean: true,
});
