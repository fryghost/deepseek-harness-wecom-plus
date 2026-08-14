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
    // The ModuleLoader factory scope has no `React` global, so the automatic
    // runtime is mandatory: it requires 'react/jsx-runtime', which the web
    // seed provides. The classic transform would emit `React.createElement`
    // and crash every JSX component at render time. (tsup Options has no `jsx`
    // field, so this must ride the esbuildOptions hook.)
    esbuildOptions: (options) => {
      options.jsx = 'automatic'
    },
    external: [/^react/u, /^@deepseek-ai\//u],
  },
])
