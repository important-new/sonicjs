import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,ts}'],
    // Run test files sequentially. Under the parallel worker pool, esbuild's
    // on-the-fly transform intermittently throws `SyntaxError: Unexpected token`
    // on random files (they pass in isolation), making `vitest --run` (and the
    // pre-commit hook) flaky. Sequential execution is reliable; the suite is
    // small enough that the wall-clock cost is acceptable.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        'src/__tests__/',
        '**/*.d.ts',
        '**/*.config.*',
        '**/mockData',
      ],
    },
  },
})
