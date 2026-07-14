---
title: note-recall-layer-discussion
created: 2026-07-13T00:28:36.890Z
updated: 2026-07-13T00:28:36.890Z
---
- 0. 一页速览（TL;DR）
  type:: toc
  line:: 11
  - - **通用笔记原子**：`时间戳 + [[wikilink]] + 内容`。
    type:: wikilink
    line:: 15
    created:: 2026-07-13T00:28:29.397Z
  - - **归属靠层次继承**：父节点的 `[[项目X]]` 沿缩进传播给整个子树 —— 归属写在文件里(缩进)，比目录魔法干净，比逐条 link 省事，且守 file-over-app。
    type:: wikilink
    line:: 16
    created:: 2026-07-13T00:28:29.397Z
- 2. 核心诊断
  type:: toc
  line:: 54
  - 2.3 file-over-app 的价值观检验
    type:: toc
    line:: 80
    - - **真正的解**：在 file-over-app 约束下恢复 append 时间线与跨位置召回 —— 不靠应用魔法，靠文件本身的结构(缩进层次 + `[[wikilink]]` + 日期节点)表达。
      type:: wikilink
      line:: 85
      created:: 2026-07-13T00:28:29.397Z
  - 2.4 问题的本质：捕获与召回必须解耦
    type:: toc
    line:: 87
    - 你在哪写不重要，只要那段话里带了 `[[项目X]]`，它就归属项目 X。
      type:: wikilink
      line:: 91
      created:: 2026-07-13T00:28:29.397Z
- 3. 关键洞察：note.md 层次大纲 = file-over-app 版的 Roam outliner
  type:: toc
  line:: 97
  - 3.1 归属靠"层次继承"，不用目录魔法，也不用逐条 link
    type:: toc
    line:: 106
    - 父节点的 `[[项目X]]` **沿缩进向下传播给整个子树**。
      type:: wikilink
      line:: 117
      created:: 2026-07-13T00:28:29.397Z
- 5. 召回层设计
  type:: toc
  line:: 154
  - 5.1 三种召回，三个视图，全是只读派生
    type:: toc
    line:: 156
    - | **主题**(项目/兴趣列全) | wikipage 反链区 | 所有 mention `[[项目X]]` 的节点，按时间排 |
      type:: wikilink
      line:: 161
      created:: 2026-07-13T00:28:29.397Z
    - | **查询**(定向捞) | 搜索 | link + 时间范围 + 全文的组合(如"近一个月所有 `[[项目X]]`") |
      type:: wikilink
      line:: 162
      created:: 2026-07-13T00:28:29.397Z
  - 5.3 跨文件子树的呈现
    type:: toc
    line:: 190
    - 同一个 `[[项目X]]` 的召回，来自 N 个文件的 N 个子树。
      type:: wikilink
      line:: 192
      created:: 2026-07-13T00:28:29.397Z
- 7. 专题：要不要给节点分配持久 id？
  type:: toc
  line:: 226
  - 7.2 分析结论：当前不需要，且提议的规则/时机需调整
    type:: toc
    line:: 232
    - ** 反链召回是只读派生：扫文件 → 找含 `[[X]]` 的行 → 记 (文件, 行, 内容)。
      type:: wikilink
      line:: 234
      created:: 2026-07-13T00:28:29.397Z
    - 反链只需解析"这条指向了 `[[项目X]]`"，**源不需要 id**。
      type:: wikilink
      line:: 241
      created:: 2026-07-13T00:28:29.397Z
  - 7.3 参照：Obsidian `^blockid` 的成熟做法
    type:: toc
    line:: 259
    - 引用侧写 `[[file#^id]]`(跳转) 或 `!
      type:: wikilink
      line:: 272
      created:: 2026-07-13T00:28:29.397Z
    - [[file#^id]]`(嵌入)。
      type:: wikilink
      line:: 272
      created:: 2026-07-13T00:28:29.397Z
- 
