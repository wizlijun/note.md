// src/lib/outline/companion-write.ts
export type CompanionWriteDecision = 'write' | 'noop' | 'conflict'

/**
 * panel 模式 .note.md 写盘前的冲突判定（写盘前 hash 校验，不引入文件监听）。
 * - fileExists=false                          → 'write'（磁盘无文件，创建）
 * - diskHash === ourHash                       → 'noop'（磁盘已等于我们要写的内容）
 * - lastHash != null && diskHash === lastHash  → 'write'（自加载/上次写入以来磁盘没变）
 * - 否则                                       → 'conflict'（远端在我们不知情时改/建了文件）
 */
export function decideCompanionWrite(args: {
  fileExists: boolean
  diskHash: string | null
  lastHash: string | null
  ourHash: string
}): CompanionWriteDecision {
  if (!args.fileExists) return 'write'
  if (args.diskHash === args.ourHash) return 'noop'
  if (args.lastHash != null && args.diskHash === args.lastHash) return 'write'
  return 'conflict'
}
