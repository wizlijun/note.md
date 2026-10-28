# Ebook Import

导入书籍、维护主题分类，并生成书库根目录的 `*.index.md`。新导入的正文保存为 `book.typeset.md`，可由排版阅读器使用 Typst 分页显示；旧 `book.md` 仍保持可读兼容。导入文件或书目标题在首个 `_` 或 `-` 后的后缀不进入书籍目录名，但完整原标题仍保留在正文、`config.txt` 和书目元数据中。

Calibre 转换使用 HTMLZ 的语义标签模式。HTML 转 Markdown 时保留 H1–H6、目录列表与链接、引用、粗斜体、上下标、高亮、删除线、定义列表及 figure/caption；脚本、样式、隐藏内容和语义页码被移除。图片继续输出为书籍目录内的 Markdown 相对路径，以便排版阅读器执行路径校验和缓存失效；任意 CSS、字体和原始 Typst 不进入导入结果。

## 开始使用

需要 note.md `6.915.3` 或更高版本（支持无窗口 CLI 与长任务进度）。当前原生发布包支持 macOS Apple Silicon
与 Intel，不提供 Windows 版本。在「插件 → 阅读 → 导入电子书…」中选择
文件，也可以从命令行导入：

```sh
# 先查询当前 Vault 的分类，使用返回的 id（不是显示名称）
notemd ebook --list-topics --json

# 将 software-engineering 替换为查询结果中的分类 id
notemd ebook "/absolute/path/to/book.epub" --topic software-engineering --json

# 只有需要扫描 PDF OCR 时才加 --ocr
notemd ebook "/absolute/path/to/scanned.pdf" --topic software-engineering --ocr --json
```

普通导入使用本机 [Calibre](https://calibre-ebook.com/) 的 `ebook-convert`，
与窗口中的选文件导入共用转换、书目补全、分类与索引流水线。扫描 PDF 的 OCR
使用插件设置中的微信 OCR 服务或百度 OCR；`--ocr-provider wechat` / `baidu`
可覆盖本次提供方，但必须同时指定 `--ocr`。先在插件设置中配置服务地址或凭证。
OCR 会把 PDF 页面发送至所选服务，可能产生费用；CLI 中 `--ocr` 即本次显式启用，
不会再弹确认框。Agent 只在用户授权 OCR 时添加此参数，不因普通转换失败自动开启。

### Agent 调用约定

- 命令作用于当前 Vault；指定其他书库时使用 `notemd ebook --vault "/absolute/vault" ...`（必须为已存在目录的绝对路径，不改变当前 Vault 设置）。
- 先运行 `--list-topics --json`，从 `data.topics` 的 `id` / `label` 选择分类。尚未设置主题时，先在插件窗口管理主题，不手写分类或猜测 ID。
- 文件路径可为绝对路径或相对调用终端工作目录的路径；含空格时加引号。导入必须有文件和 `--topic`，列表模式不接受文件、`--topic` 或 OCR 参数。
- `--root "ssot/ebooks"` 可指定本次 Vault 内相对书库目录；查询与导入使用同一 root，不改保存的设置。
- 若导入提示分类事务需要恢复，先在插件窗口处理未完成的分类整理；指定另一书库的 `--root` 不会重放原书库事务。
- `--ocr` 仅接受 PDF；非 PDF、未知 OCR 提供方、无 `--ocr` 的 `--ocr-provider` 都会失败，不静默换提供方。
- 命令同步等待完成；进度写到 stderr，`--json` 的 stdout 保持单个 JSON。Agent 应给整本转换/OCR 留足执行时间，不在开始日志后就报告成功。
- 退出码为 `0` 且 JSON 的 `ok` 为 `true` 才成功。`data.dest` 为绝对书籍目录，`data.dest_rel` 为 Vault 内相对目录，正文在其中的 `book.typeset.md`；结果另含 `topic_id`、`ocr`、`provider`（未启用 OCR 时为 `null`）及 `log`。
- 查询返回 `data.ebooks_root` 与 `data.topics`；不会导入、补模板或重建索引。错误返回非零退出码，读取 `error.message` 修正参数或配置，不绕过接口直接写书籍元数据。

例如，把以下指令交给 Agent：

> 用 `notemd ebook --list-topics --json` 查询分类，再把指定电子书通过
> `notemd ebook "文件路径" --topic 分类id --json` 导入。只有我要求 OCR 时加
> `--ocr`；完成后根据 JSON 返回的 `dest_rel` 告诉我书籍位置。

安装 Typeset Reader `0.1.1` 且宿主达到 `6.921.2` 后，新导入的
`*.typeset.md` 会以分页排版视图打开；未安装或版本不足时仍可作为普通 Markdown
读取，不影响源文件。

## 书籍索引

索引遵循 [文件索引 V1](../../skills/file-index/references/format.md)，默认 `view: gallery`。每本书一行列表，标题表达分类；作者、入库日期、封面是行内属性。词汇解释保留为段落。

- 点击书名优先打开最新 `YYYY-MM-DD-summary.md`，其次 `summary.md`，再选择同目录其他 Markdown。说明中列出摘要和其他整理笔记入口。
- 不把原始书籍正文或其大纲作为主题索引的阅读入口；有对应普通 Markdown 时省略其 `.note.md` 伴随笔记。缺少可读文档的书以“待整理”段落保留。
- 自动引用同目录的 `cover.jpg`、`cover.png` 或 `cover.jpeg`。导入时从书目服务获取可确认的资料和封面；旧书可点击“补全书目与封面”，已有封面不覆盖。忽略符号链接和隐藏文件。
- 分类保存、单书改类、批量分类、导入和摘要完成后重建索引。分类事务失败恢复原分类，摘要已生成而索引失败则保留摘要并提示警告。
- 配套宿主中的已打开文件查看器会自动刷新无修改的内容，未保存编辑不被覆盖。

`topics.yml` 与书籍 `meta.yml` 决定分类。新索引的 YAML 带有 `notemd_generated: ebook-topic-index/v2`；旧 v1 自动索引在重建时升级。同名手写索引仍拒绝覆盖。直接修改受管理索引的内容会在下次重建时被替换；长期信息应维护在书籍笔记或主题配置中。

## 书目服务与全库补全

优先使用 [Open Library Books API](https://openlibrary.org/dev/docs/api/books)、[Search API](https://openlibrary.org/dev/docs/api/search) 和 [Covers API](https://openlibrary.org/dev/docs/api/covers)。优先查校验有效的 ISBN；ISBN 未收录时仅接受主标题和完整作者规范化后精确且唯一的匹配。无书目、无封面或服务失败时再查 [Apple Books Search API](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/Searching.html)，仍要求原题名和完整作者匹配，排除摘要、习题册等干扰，不翻译题名或模糊猜书。Apple 单独匹配只作为作品级资料，不推断本地 ISBN、出版社或出版日期；补已有 Open Library 记录的封面时保留该记录与 ISBN，仅保存 Apple 实际图片来源。

只发送 ISBN 或书名/作者，不发送书籍正文。所有请求共享限速和 30 秒总预算，Apple Search 调用至少间隔 3.2 秒。封面按实际解码格式保存 JPG/PNG，拒绝空白占位、超限图片和越界重定向。Open Library 封面可能经 Internet Archive 官方封面存档分发；Apple 使用 API 返回的 `artworkUrl100`，不猜测更大尺寸链接。

旧书的身份按 Frontmatter → `config.txt` 的 `# Book Metadata` 区块 → 下载缓存读取，最后才用目录名；只补缺失字段，不改原文。

元数据缓存在书籍 `meta.yml` 的 `book_metadata` 中，包括来源、匹配方式、ISBN、书名、作者、出版社、出版日期、获取时间及封面来源；只补缺失字段，保留已有值和用户自定义字段。索引读取本地缓存，不在改分类时联网。

维护工具可对显式指定的书库顺序补全，逐本报告成功、部分完成、未匹配或错误；一书失败不阻断其他书。完成后重建索引：

```sh
notemd-ebook-import --complete-library-assets /absolute/path/to/books --report /absolute/path/to/report.jsonl
```

手动补入已核实的书目或封面后，可单独重建索引，不再联网：

```sh
notemd-ebook-import --rebuild-library-indexes /absolute/path/to/books
```

## 验证

```sh
pnpm --filter ebook-import-plugin test
pnpm --filter ebook-import-plugin check
pnpm --filter ebook-import-plugin build
cargo test --manifest-path plugins-src/ebook-import/backend/Cargo.toml
node scripts/check-ebook-index-format.mjs
```

最后一项通过真实 Rust 生成器和 Index Viewer 解析器交叉验证格式与链接转义。所有自动测试使用临时目录，不修改用户书库。
