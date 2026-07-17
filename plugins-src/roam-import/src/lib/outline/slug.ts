// src/lib/outline/slug.ts — copied verbatim from host src/lib/outline/slug.ts.
/** 文件系统非法字符(macOS/Windows 并集,file-over-app 取严) */
const ILLEGAL_RE = /[/\\:*?"<>|]/g

/**
 * 链接文本/文件名统一约束(spec §5 写入端):中文等非 ASCII 保留原文,
 * 非法字符替换为 `-`,去首尾空白与前导点;空结果回退 'untitled'。
 * wikilink 写入与建页共用,保证 [[链接文本]] === 文件名 1:1。
 */
export function sanitizeFileName(raw: string): string {
  const s = raw.replace(ILLEGAL_RE, '-').trim().replace(/^\.+/, '').replace(/^-+|-+$/g, '').trim()
  return s === '' ? 'untitled' : s
}
