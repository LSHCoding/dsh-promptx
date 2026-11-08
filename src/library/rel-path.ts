// 库内相对路径的校验（design-spec 6.1、7.3，审查意见 S02）。来自小程序的路径和回收站记录里读出的路径都经过这里：
// 先按 normalizeRelPath 规范化（不能是绝对路径，不能含 `..`、以 `.` 开头的段和空段），再按用途加上限制。
// 反斜杠只在 Windows 上当分隔符，其他平台上含反斜杠的路径直接拒绝（审查 H6）。

import { isMarkdownFileName, normalizeRelPath, splitRelPath } from '../shared/library-rules.ts'
import { isWindowsDeviceName, nameKey } from './fs-safe.ts'

/** 回收站目录，只认库根目录下的这一个（需求 6.3）。 */
export const TRASH_DIR = '_trash'

/**
 * 是不是库根目录下的回收站目录名。macOS、Windows 默认不区分大小写，`_Trash` 和 `_trash` 是同一个目录，
 * 所以在这两个平台上不区分大小写；Linux 上 `_Trash` 是另一个普通文件夹。
 */
export function isTrashName(name: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' || platform === 'win32' ? nameKey(name) === TRASH_DIR : name === TRASH_DIR
}

// Windows 文件名里不能出现这些字符。冒号尤其危险：`a:b.md` 在 NTFS 上会被当成文件 a 的备用数据流。
const WINDOWS_FORBIDDEN = /[<>:"|?*\x00-\x1f]/

/** Windows 上每一段都要是合法的文件名：没有禁用字符，不以空格或点结尾（会被系统悄悄去掉），不是设备名。 */
function segmentsSafe(relPath: string, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') return true
  return relPath.split('/').every(segment => !WINDOWS_FORBIDDEN.test(segment) && !/[ .]$/.test(segment) && !isWindowsDeviceName(segment))
}

/**
 * 反斜杠只在 Windows 上是路径分隔符。macOS、Linux 上 `x\y.md` 是库根目录下一个名字里带反斜杠的文件，
 * 如果照 normalizeRelPath 换成 `x/y.md`，对它的收藏、删除就会落到另一个文件 `x/y.md` 上（审查 H6，红线 2）。
 * 所以这两个平台上含反斜杠的路径一律拒绝，扫描也不列出这类名字（scan.ts）。
 */
function hasForeignSeparator(input: string, platform: NodeJS.Platform): boolean {
  return platform !== 'win32' && input.includes('\\')
}

/**
 * 库里一个 Prompt 文件的相对路径：规范化后以 `.md` 结尾（不区分大小写），不在回收站里。不合格返回 null。
 * 参数是 unknown：协议传来的值在运行时不一定是字符串。
 */
export function promptRelPath(input: unknown, platform: NodeJS.Platform = process.platform): string | null {
  if (typeof input !== 'string' || hasForeignSeparator(input, platform)) return null
  const relPath = normalizeRelPath(input)
  if (relPath === null || !segmentsSafe(relPath, platform)) return null
  if (!isMarkdownFileName(splitRelPath(relPath).name)) return null
  if (isTrashName(relPath.split('/', 1)[0] ?? '', platform)) return null
  return relPath
}

/** 库里一个文件夹的相对路径；null 和空串表示库根目录（返回空串）。不合格返回 null。 */
export function folderRelPath(input: unknown, platform: NodeJS.Platform = process.platform): string | null {
  if (input === null || input === '') return ''
  if (typeof input !== 'string' || hasForeignSeparator(input, platform)) return null
  const folder = normalizeRelPath(input)
  if (folder === null || !segmentsSafe(folder, platform)) return null
  if (isTrashName(folder.split('/', 1)[0] ?? '', platform)) return null
  return folder
}

/** 回收站里的文件名：单独一段、不以 `.` 开头、以 `.md` 结尾。记录文件、锁文件、临时文件都以 `.` 开头，不会混进来。 */
export function isTrashFileName(name: unknown, platform: NodeJS.Platform = process.platform): name is string {
  if (typeof name !== 'string') return false
  if (name.includes('/') || name.includes('\\') || name.includes('\0') || name.startsWith('.')) return false
  if (!segmentsSafe(name, platform)) return false
  return isMarkdownFileName(name)
}
