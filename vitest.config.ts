import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'json-summary', 'html'],
      exclude: ['src/commands/serve/builtin-map.ts', `**.config.*`, `dist/**`],
    },
  },
})
