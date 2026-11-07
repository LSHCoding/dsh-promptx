import { defineConfig } from 'vitest/config'

// 冒烟测试：下载真实 Electron、启动构建好的小程序。单独的配置，pnpm test 不跑它。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/smoke/**/*.smoke.ts'],
    pool: 'forks',
    testTimeout: 15 * 60_000,
    hookTimeout: 15 * 60_000,
    fileParallelism: false,
  },
})
