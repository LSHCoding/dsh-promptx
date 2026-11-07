// 构建前删除 lib/。tsdown 的五个条目都不自己清理，避免并行构建时互相删掉产物。
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

rmSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib'), { recursive: true, force: true })
