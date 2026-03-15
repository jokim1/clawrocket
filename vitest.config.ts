import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The backend test suite shares a global SQLite fixture and uses native modules.
    // Running files serially in forked workers is slower, but much more stable.
    include: ['src/**/*.test.ts', 'setup/**/*.test.ts', 'skills-engine/**/*.test.ts'],
    pool: 'forks',
    fileParallelism: false,
    maxWorkers: 1,
  },
});
