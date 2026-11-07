import { defineConfig } from 'vitest/config'

// Node 25 默认开启 Web Storage，会遮住 jsdom 的 localStorage；支持这个开关时关掉（照 dsh 官方 vitest.shared.ts）。
const execArgv = process.allowedNodeEnvironmentFlags.has('--no-webstorage') ? ['--no-webstorage'] : []

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.{ts,tsx}'],
    pool: 'forks',
    execArgv,
    testTimeout: 20_000,
  },
})
