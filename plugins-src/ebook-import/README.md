# Ebook Import

导入书籍、维护主题分类，并生成书库根目录的 `*.index.md`。

## 书籍索引

索引遵循 [文件索引 V1](../../skills/file-index/references/format.md)，默认 `view: gallery`。每本书一行列表，标题表达分类；作者、入库日期、封面是行内属性。词汇解释保留为段落。

- 点击书名优先打开最新 `YYYY-MM-DD-summary.md`，其次 `summary.md`，再选择同目录其他 Markdown。说明中列出摘要和其他整理笔记入口。
- 不把 `book.md` 或其大纲作为阅读入口；有对应普通 Markdown 时省略其 `.note.md` 伴随笔记。缺少可读文档的书以“待整理”段落保留。
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
