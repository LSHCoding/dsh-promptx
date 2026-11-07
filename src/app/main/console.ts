// 小程序的 stdout 只能走协议帧（design-spec 5.3）。Electron 主进程里 console.log 默认写 stdout，
// 任何一行混进去，Host 都会把它当成坏帧丢掉，更糟的是可能和一帧的前半段粘在一起。
// 所以入口的第一件事就是把 console 的全部输出改到 stderr。

import { Console } from 'node:console'
import { Writable } from 'node:stream'

/** write 为写 stderr 的函数（管道断开后由它静默丢弃，见 stdio-guard.ts）。 */
export function redirectConsoleToStderr(write: (text: string) => void = (text) => {
  process.stderr.write(text)
}): void {
  const target = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      write(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
      callback()
    },
  })
  const sink = new Console({ stdout: target, stderr: target })
  console.log = sink.log.bind(sink)
  console.info = sink.info.bind(sink)
  console.debug = sink.debug.bind(sink)
  console.warn = sink.warn.bind(sink)
  console.error = sink.error.bind(sink)
  console.trace = sink.trace.bind(sink)
  console.dir = sink.dir.bind(sink)
  console.dirxml = sink.dirxml.bind(sink)
  console.table = sink.table.bind(sink)
  console.group = sink.group.bind(sink)
  console.groupCollapsed = sink.groupCollapsed.bind(sink)
  console.groupEnd = sink.groupEnd.bind(sink)
  console.count = sink.count.bind(sink)
  console.countReset = sink.countReset.bind(sink)
  console.time = sink.time.bind(sink)
  console.timeEnd = sink.timeEnd.bind(sink)
  console.timeLog = sink.timeLog.bind(sink)
  console.assert = sink.assert.bind(sink)
}
