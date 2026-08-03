import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/security/**/*.test.ts'],
    // store.test.ts 与 security.test.ts 都通过 TMON_DATA_DIR 操作数据目录，必须串行避免 env 互踩
    fileParallelism: false,
  },
});
