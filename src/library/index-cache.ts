// 库索引的缓存与提交（需求 L-01、L-04、N-01，design-spec 7.2）。
//
// 扫描不进库的修改队列：展开侧栏不必等前面的保存写完。代价是扫描期间发生的保存、删除、恢复要补到扫描结果上，
// 否则较早开始的扫描提交时会把刚保存的条目冲掉，或者让刚删除的条目又出现。修改发生时把结果记进每个进行中的扫描，
// 扫描结束后同步补上再提交，补和提交之间没有 await，不会漏掉中途的新修改。
// 补上去的是插件自己写出的内容；同一时刻外部程序又改了这个文件时，文件状态变化会让下一次刷新重读。

import { collectTags } from '../shared/search.ts'
import type { SearchDoc } from '../shared/search.ts'
import { addAncestorFolders, compareFolderPaths, scanLibrary } from './scan.ts'
import type { IndexedFile } from './scan.ts'

export interface LibraryIndex {
  rootReal: string
  files: Map<string, IndexedFile>
  /** 所有子文件夹（含空文件夹）的相对路径。 */
  folders: Set<string>
  /** 由 files、folders 算出的列表，修改后置空，用到时再算。 */
  derived: DerivedIndex | null
}

export interface DerivedIndex {
  docs: SearchDoc[]
  /** 父文件夹在前，同一层按名称排（数字感知）。 */
  folders: string[]
  /** 库里出现过的所有标签，不受筛选影响（L-04）。 */
  tags: string[]
}

export interface RefreshOptions {
  skipRealpaths: readonly string[]
  platform: NodeJS.Platform
}

interface Mutation {
  relPath: string
  /** null：文件已经不在原处（删除）。 */
  indexed: IndexedFile | null
}

interface PendingScan {
  rootReal: string
  mutations: Mutation[]
}

function applyMutation(files: Map<string, IndexedFile>, folders: Set<string>, { relPath, indexed }: Mutation): void {
  if (indexed === null) {
    files.delete(relPath)
    return
  }
  files.set(relPath, indexed)
  // 新建、恢复的文件可能带出新文件夹；删除不收起文件夹，空文件夹照样显示（L-03）
  addAncestorFolders(folders, relPath)
}

export class IndexCache {
  #index: LibraryIndex | null = null
  /** reset() 时加一：之前开始的扫描结果不再提交。 */
  #generation = 0
  #scanSeq = 0
  #committedScan = 0
  readonly #pending = new Set<PendingScan>()

  /** 这个库根目录的已提交索引；还没有或属于别的库根目录时为 null。 */
  current(rootReal: string): LibraryIndex | null {
    const index = this.#index
    return index !== null && index.rootReal === rootReal ? index : null
  }

  /**
   * 重新扫描并提交。文件状态未变时复用上一次的解析结果。
   * 比已提交的扫描更早开始的扫描不再提交，返回已提交的那份（它更新）；reset() 之前开始的扫描也不提交。
   */
  async refresh(rootReal: string, options: RefreshOptions): Promise<LibraryIndex> {
    const generation = this.#generation
    const scanId = ++this.#scanSeq
    const pending: PendingScan = { rootReal, mutations: [] }
    this.#pending.add(pending)
    try {
      const result = await scanLibrary({
        rootReal,
        previous: this.current(rootReal)?.files,
        skipRealpaths: options.skipRealpaths,
        platform: options.platform,
      })
      for (const mutation of pending.mutations) applyMutation(result.files, result.folders, mutation)
      const index: LibraryIndex = { rootReal, files: result.files, folders: result.folders, derived: null }
      if (generation !== this.#generation) return index
      if (scanId > this.#committedScan) {
        this.#index = index
        this.#committedScan = scanId
        return index
      }
      return this.current(rootReal) ?? index
    } finally {
      this.#pending.delete(pending)
    }
  }

  /** 修改操作完成后更新索引：只查询不刷新的 list 马上能看到（L-08「列表里出现新条目」），进行中的扫描也会补上。 */
  record(rootReal: string, relPath: string, indexed: IndexedFile | null): void {
    const mutation: Mutation = { relPath, indexed }
    for (const scan of this.#pending) {
      if (scan.rootReal === rootReal) scan.mutations.push(mutation)
    }
    const index = this.current(rootReal)
    if (index === null) return
    applyMutation(index.files, index.folders, mutation)
    index.derived = null
  }

  /** 库目录变了：丢掉索引。 */
  reset(): void {
    this.#generation++
    this.#index = null
  }
}

export function deriveIndex(index: LibraryIndex): DerivedIndex {
  index.derived ??= {
    docs: Array.from(index.files.values(), file => file.doc),
    folders: [...index.folders].sort(compareFolderPaths),
    tags: collectTags(Array.from(index.files.values(), file => file.doc.meta)),
  }
  return index.derived
}
