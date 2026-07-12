# note.md 常见问题 / 排查 FAQ

> 收录一些非显而易见、排查过一次值得记下来的问题。

---

## 历史视图 / diff 对某个 vault 文件"取不出任何历史"（明明有提交）

**症状**
- 在「历史视图」里打开某个 vault 内的 `.md` / `.note.md`，提交列表为空（或 diff 拿不到内容），
  但你确定这个文件在 vault 仓库里是有提交历史的。

**根因：vault 文件夹被改成了不同大小写，git 与磁盘路径产生了大小写偏差**
- macOS 默认文件系统（APFS）**大小写不敏感**：`Sync/` 和 `sync/` 指向同一个文件夹，
  所以你在 Finder / 应用里怎么写都能打开文件。
- 但 **git 的 pathspec 是大小写敏感的**。sotvault 同步写入的子目录常量是大写的
  **`Sync/`**，git 里记录的路径就是 `Sync/xxx.md`。
- 如果你把本地文件夹"改名"成小写 `sync/`，由于文件系统大小写不敏感，这个改名
  **并没有真正改到 git 的记录**（git 仍认为路径是 `Sync/…`）。
- 于是应用用磁盘上的小写路径 `sync/xxx.md` 去执行
  `git log -- sync/xxx.md` —— 大小写对不上 git 里的 `Sync/xxx.md` → **返回 0 条历史**。
  同理 `git show <rev>:sync/…`、`git diff` 也都拿不到。

**一分钟自查**
```bash
cd <vault-root>
# git 里实际跟踪的真实大小写路径（icase 忽略大小写匹配）
git ls-files --full-name -- ':(icase)sync/你的文件.note.md'
#   → 若打印出来的是 "Sync/你的文件.note.md"（大写 S），就证实了大小写偏差

# 用真实大小写路径能查到历史，用磁盘上的小写路径查不到 → 实锤
git log --oneline -- 'Sync/你的文件.note.md'   # 有历史
git log --oneline -- 'sync/你的文件.note.md'   # 0 条
```

**修复（改数据，推荐）**
- 让本地文件夹大小写与 git 记录一致。二选一：
  1. 把文件夹名改回 git 记录的大小写（如 `sync` → `Sync`）；或
  2. 用 git 显式改名以更新跟踪路径（会是一次大改动，谨慎）：
     ```bash
     # 在大小写不敏感的 FS 上做 case-only 改名需要中转
     git mv Sync sync-tmp && git mv sync-tmp sync
     git commit -m "chore: normalize vault dir case Sync→sync"
     ```
  之后历史/‌diff 即恢复正常。

**备注 / 排查坑**
- `:(icase)` 这个 pathspec magic **不能和 `git log --follow` 一起用**
  （`fatal: pathspec magic not supported by --follow: 'icase'`），
  所以"忽略大小写地 log"不能一步到位，需要先用 `git ls-files ':(icase)…'`
  把路径规范化成真实大小写，再喂给 `git log --follow` / `git show`。
- 这是**数据/路径大小写**问题，不是 Unicode(NFC/NFD) 问题——CJK 文件名不会被
  分解，磁盘与 git 的字节一致。判断依据：`git ls-files ':(icase)…'` 能匹配到就
  说明只是大小写不同。
- 同类：任何"只改了大小写"的文件/文件夹改名，在 macOS 上都会和 git 记录悄悄分叉。
  涉及 git 的功能（历史、diff、blame）都会因大小写不匹配而失灵。
