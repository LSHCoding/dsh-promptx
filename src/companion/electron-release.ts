// 由 scripts/update-electron-checksums.mjs 生成，不要手改。
// 校验值同时核对了 electron@44.10.2 npm 包的 checksums.json 和 GitHub Releases 的 SHASUMS256.txt。

/** 小程序使用的 Electron 版本。 */
export const ELECTRON_VERSION = '44.10.2'

/** 支持的平台-架构，与 Node 的 process.platform、process.arch 写法一致。 */
export type RuntimeTarget = 'darwin-arm64' | 'darwin-x64' | 'win32-x64' | 'win32-arm64' | 'linux-x64' | 'linux-arm64'

/** 各平台压缩包的文件名、SHA-256（小写十六进制）和字节数。 */
export const ELECTRON_ASSETS: Readonly<Record<RuntimeTarget, { readonly file: string; readonly sha256: string; readonly size: number }>> = {
  'darwin-arm64': { file: 'electron-v44.10.2-darwin-arm64.zip', sha256: '1ef6142549160fe8572ca989212cb5fc3efd5fade445b5ac25639bfa9408a80d', size: 130593137 },
  'darwin-x64': { file: 'electron-v44.10.2-darwin-x64.zip', sha256: '846033297c88ec2f9f90cd88cf2d6fc12c52ba4a1797d230c20806dff21a21bb', size: 134484800 },
  'win32-x64': { file: 'electron-v44.10.2-win32-x64.zip', sha256: '7af18e85a1537b832924ae3b0e5146602f2f4f4b0c77c74e4ae0dc251ca338f9', size: 158203656 },
  'win32-arm64': { file: 'electron-v44.10.2-win32-arm64.zip', sha256: '1fb2e41638a82e88c6368a863aabb74c64e25214ec97aaba51db2a91eff3880c', size: 156502112 },
  'linux-x64': { file: 'electron-v44.10.2-linux-x64.zip', sha256: 'd2f9319dc81d6786c684a80f63d728421761f55a27a3ae3bd373250f0f40fdca', size: 123133586 },
  'linux-arm64': { file: 'electron-v44.10.2-linux-arm64.zip', sha256: '17c7e2740c397957255d2eda16f8f9042230f84ffb458400a9cc14f9e0dd6879', size: 124173031 },
}
