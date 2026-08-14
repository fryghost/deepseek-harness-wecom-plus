import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    outDir: 'dist',
    platform: 'node',
    target: 'es2024',
    external: [/^@deepseek-ai\//u],
  },
  {
    entry: { client: 'src/client/index.tsx' },
    format: ['cjs'],
    sourcemap: true,
    clean: false,
    outDir: '.client-build',
    platform: 'browser',
    target: 'es2022',
    external: [/^react/u, /^@deepseek-ai\//u],
  },
])
