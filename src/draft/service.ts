// 草稿存取（需求 E-02、F-01、6.5、N-02；design-spec 4.5、6.2、7.5、D7，审查意见 S01、TC-01、TC-05、COV-01）。
//
// 每个 profile 一个 layout: 'single' 的存储单元，名字带 profile 名的哈希，里面一张表、一条记录 `current`。
// 不用 per-record 布局：0.2.2-rc.1 的 per-record 把格式错误、读不出来、版本不认识的记录文件都当成「没有记录」，
// 小窗就会显示可编辑的空草稿，第一次自动保存把原记录覆盖掉。single 布局遇到这些情况在打开时直接失败
// （malformed-medium、version-mismatch、读取错误原样抛出，记录不合 schema 抛 invalid-record），正好是「打不开就拒绝，不覆盖」。
//
// 存储单元在第一次 load() 时打开，失败后下一次 load() 重试（小窗的「重试」）。在本进程里成功 load() 之前 save() 一律拒绝：
// 读不出原记录时任何保存都可能用空内容覆盖它。

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { draftRecordSchema, parseDraftRecord } from '../shared/draft-record.ts'
import { PromptxError } from '../shared/errors.ts'
import type { Binding, DraftRecord, TextSelection } from '../shared/types.ts'
import type { DraftApi } from '../services.ts'

/** 存储单元里唯一的一条记录。 */
const RECORD_KEY = 'current'

/**
 * domainTable 的参数类型是 zod 的 ZodType，存储服务在运行时只调用 schema.parse()（design-spec 4.5）。
 * 记录校验自己写在 shared/draft-record.ts，不为此引入 zod，这里按 zod 的类型交给它。
 */
type DraftSchema = Parameters<typeof domainTable<typeof RECORD_KEY, DraftRecord>>[0]

function draftSpec(profileHash: string, scope: 'main' | 'entry') {
  return defineDomain({
    name: `${scope === 'entry' ? 'promptx_entry_draft' : 'promptx_draft'}_${profileHash}`,
    version: 1,
    layout: 'single',
    tables: { draft: domainTable<typeof RECORD_KEY, DraftRecord>(draftRecordSchema as unknown as DraftSchema) },
  })
}

type DraftSpec = ReturnType<typeof draftSpec>

export interface DraftServiceOptions {
  /** dsh 的存储服务（ctx.storageDomain）。 */
  facility: Pick<DomainFacility, 'open'>
  /** profile 名和它的哈希（profile 名 UTF-8 的 SHA-256 前 16 位小写十六进制；没有 profile 时为 none）。 */
  profile: { name: string; hash: string }
  /** 独立条目编辑器使用另一个存储单元，格式沿用 DraftRecord v1。 */
  scope?: 'main' | 'entry'
  now?: () => Date
}

/**
 * 存储层错误的错误码，作为 promptx/draft/unreadable、write-failed 的说明：StorageError、DomainError 的 code
 * （malformed-medium、version-mismatch、invalid-record……），或文件系统错误码（EACCES……）。
 * 不带原始信息：里面有数据目录的路径。
 */
function storageErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') return error.code
  return 'unknown'
}

export function createDraftService(options: DraftServiceOptions): DraftApi {
  const now = options.now ?? (() => new Date())
  // defineDomain 在名字不合规时抛错。哈希由 Host 算出，正常不会出错；万一出错也只让草稿读不出来，不影响插件启动
  let spec: DraftSpec | null = null
  try {
    spec = draftSpec(options.profile.hash, options.scope ?? 'main')
  } catch {
    spec = null
  }
  let domain: Domain<DraftSpec> | null = null
  let opening: Promise<Domain<DraftSpec>> | null = null
  let loaded = false
  let closed = false

  async function open(): Promise<Domain<DraftSpec>> {
    if (spec === null) throw new PromptxError('promptx/draft/unreadable', 'invalid-domain-name')
    let opened: Domain<DraftSpec>
    try {
      opened = await options.facility.open(spec)
    } catch (error) {
      throw new PromptxError('promptx/draft/unreadable', storageErrorCode(error))
    }
    // 打开期间 close() 已经被调用：刚打开的单元也要关掉，不留给已经卸载的插件。关闭失败不改变结果，
    // 原样抛出的存储层错误信息里有数据目录的路径，不能带给小窗
    if (closed) {
      await opened.close().catch(() => undefined)
      throw new PromptxError('promptx/draft/unreadable', 'closed')
    }
    domain = opened
    return opened
  }

  /** 同一时间只有一次打开；失败后清掉，下一次 load() 重新打开。 */
  function ensureOpen(): Promise<Domain<DraftSpec>> {
    if (domain !== null) return Promise.resolve(domain)
    opening ??= open().finally(() => {
      opening = null
    })
    return opening
  }

  return {
    async load(): Promise<DraftRecord | null> {
      if (closed) throw new PromptxError('promptx/draft/unreadable', 'closed')
      const opened = await ensureOpen()
      let record: DraftRecord | undefined
      try {
        record = opened.table('draft').get(RECORD_KEY)
      } catch (error) {
        // 已经打开的单元读不出来：后端报了 unknown-state（写入时介质状态不明），单元被隔离，读写都拒绝，直到关闭。
        // 关掉它，下一次 load()（小窗的「重试」）重新从磁盘打开；读回之前保存一律拒绝，不拿内存里的状态去覆盖磁盘
        loaded = false
        if (domain === opened) domain = null
        try {
          await opened.close()
        } catch {
          // 关闭失败也不影响重试：下一次打开会因为名字还被占用而报 already-open，原因照样报给小窗
        }
        throw new PromptxError('promptx/draft/unreadable', storageErrorCode(error))
      }
      loaded = true
      return record ?? null
    },

    async save(input: { text: string; selection: TextSelection | null; binding: Binding | null }): Promise<{ updatedAt: string }> {
      if (closed) throw new PromptxError('promptx/draft/unreadable', 'closed')
      // 读回原记录之前不保存，否则读不出来的原记录会被这次保存覆盖（F-01、E-02、红线 1）
      const current = domain
      if (!loaded || current === null) throw new PromptxError('promptx/draft/unreadable', 'not-loaded')
      const updatedAt = now().toISOString()
      let record: DraftRecord
      try {
        // 写之前按同一份 schema 校验：小程序传来的值不合格时写进去，下次打开会因为 invalid-record 整份读不出来
        record = parseDraftRecord({ version: 1, text: input.text, selection: input.selection, binding: input.binding, updatedAt })
      } catch {
        throw new PromptxError('promptx/draft/write-failed', 'invalid-record')
      }
      try {
        await current.table('draft').put(RECORD_KEY, record)
      } catch (error) {
        throw new PromptxError('promptx/draft/write-failed', storageErrorCode(error))
      }
      return { updatedAt }
    },

    async close(): Promise<void> {
      closed = true
      const pending = opening
      if (pending !== null) {
        try {
          await pending
        } catch {
          // 打开失败就没有需要关的单元
        }
      }
      const current = domain
      domain = null
      // 存储单元关闭前会等在途的写入完成（dsh-storage-domain 的 close 语义）
      if (current !== null) await current.close()
    },
  }
}
