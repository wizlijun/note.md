# v6.1110.4 三插件受控发布准备

本目录仅准备脚本与离线测试；未读取 token/key、未运行 inspect/stage/publish-index，也未创建或改变签名身份。脚本复用 `docs/superpowers/reports/2026-11-10-sumi-omarchy-release/publish-plugin.py`，保持既有 Wrangler 3 Account API Token 流程。

固定宿主：`v6.1110.4` → `25157f1db07b5be9fb2962346894ab316bb27f22`，全部 `engines.notemd` / `min_host` 为 `>=6.1110.4`。

| --profile | 插件 | 版本 | 实际包/市场 arch | 类型 |
|---|---|---|---|---|
| sumi | notemd.sumi | 0.1.12 | x86_64-unknown-linux-gnu | 原生，仅该Linux目标 |
| next | notemd.next | 1.13.3 | universal | UI-only |
| idea | notemd.idea-spark | 1.3.8 | universal | UI-only |

`universal` 是原 `release-plugins.sh` / `gen-plugin-index.mjs` 的实际输出键；“any platform”仅含义，不新增 `any` 对象键。Wrangler入口为已有 `plugins-registry/node_modules/.bin/wrangler`，对应包版本必须精确为3.114.17；无名为wrangler3的可执行文件，也不安装或升级工具。

## 收据输入

root根据正式包真实字节为每个profile生成独立JSON，结构延续旧发布器：

- `sourceCommit`：上方冻结SHA。
- `package.id/version/arch`：对应固定profile。
- `package.sha256`、`signatureSha256`：包及相邻 `.minisig` 的真实SHA256。
- `package.bytes`：包实际字节数。
- `package.files`：ZIP全部非目录member名称→解压原始字节SHA256，不遗漏、不添加。
- `host.tag/sourceCommit`：固定tag和SHA。
- `host.assets[]`：每个真实已公开宿主资产的 `name/sha256/bytes`，至少包含 `note.md_6.1110.4_amd64.deb` 或该版本实际x86_64 Arch包。未公开资产不能提前填入；不包含虚构Mac资产。

每次check验证冻结tag源码manifest、宿主内嵌公钥、实际minisign签名、完整ZIP清单、生成器条目和工具版本。仅Sumi检查x86_64 ELF/executable及14项源码音效；UI-only拒绝binary声明、bin（含空目录）及任何manifest.json/ui/以外内容。所有profile拒绝symlink/special-file payload。

生成器使用正式build目录运行原 `scripts/gen-plugin-index.mjs`，不手工构造市场条目。Sumi源码可以保留Mac平台声明；实际生成条目仅含本次Linux下载，不改变历史Mac0.1.10。

## root审查后的命令计划（尚未执行）

将以下函数中的路径变量指向真实构建输出；收据命名统一为 `receipts/sumi.json`、`receipts/next.json`、`receipts/idea.json`。`release_packages` 是原发布脚本输出根目录，`release_index` 是原生成器的实际JSON，`release_repository` 是含冻结tag的源码仓库。每profile输出单独目录。此函数不读取凭据文件；在未来实际远程步骤由既有受控流程提供 `CLOUDFLARE_API_TOKEN` 进程环境，或明确传既有 `--token-env-file`。

```bash
release_source=25157f1db07b5be9fb2962346894ab316bb27f22
release_publisher=/home/bruce/git/note.md/tasks/omarchy-shortcuts-window/publication/publish-plugin.py
release_tools=/home/bruce/git/note.md
# 由root设定真实绝对路径：release_repository, release_packages,
# release_index, release_receipts, release_evidence。缺值拒绝。

publish_profile() {
  local profile=$1 mode=$2 plugin version arch
  case "$profile" in
    sumi) plugin=notemd.sumi; version=0.1.12; arch=x86_64-unknown-linux-gnu ;;
    next) plugin=notemd.next; version=1.13.3; arch=universal ;;
    idea) plugin=notemd.idea-spark; version=1.3.8; arch=universal ;;
    *) return 2 ;;
  esac
  python3 "$release_publisher" "$mode" --profile "$profile" \
    --source "$release_source" --repository "${release_repository:?}" \
    --tools-repository "$release_tools" \
    --receipt "${release_receipts:?}/$profile.json" \
    --package "${release_packages:?}/$plugin/$version/$arch.notemdpkg" \
    --generated-index "${release_index:?}" \
    --output "${release_evidence:?}/$profile"
}

# 首先所有profile本地验签/清单/生成器检查；不读token、不联网。
for profile in sumi next idea; do publish_profile "$profile" check || exit "$?"; done
# 正式发布经root审查后才执行下列两阶段，不并行运行多个publisher。
# for profile in sumi next idea; do publish_profile "$profile" stage || exit "$?"; done
# for profile in sumi next idea; do publish_profile "$profile" publish-index || exit "$?"; done
```

对象键严格为 `notemd-plugins/<id>/<version>/<实际包basename>[.minisig]`。先同时检查包/签名占用与索引不冲突，再上传R2；遇失败/超时先匿名回读，已是相同字节则不重复上传，不同字节立即拒绝。上传后普通URL与cache-bust URL均完整回读、对比字节并验签。

publish-index每个profile都重新验证公开稳定宿主的tag SHA及匿名资产完整hash，重新验公开插件签名，再读取最新KV，保留所有旧entries和未知根字段；写前二次重读发现并发变化即退出，重跑须重新基于最新KV合并。KV没有CAS事务，因此这是原有串行发布保护，不能声称消除了两个写者在最后重读之后同时写入的竞态；发布窗口保持单写者。写超时只回读不盲重写。最终KV、普通/新鲜公网索引一致才报告成功；缓存未收敛不重写KV。

## 离线验证

`python3 -m unittest discover -s tasks/omarchy-shortcuts-window/publication -p 'test_*.py' -v`

18项通过，见test-results.log。全部网络/外部写入为mock；覆盖三个profile、UI-only拒bin、生成器universal契约、固定源/宿主public tag和完整asset字节、不可变对象/条目、超时读回、同对象键重试、串行保留全部历史/未知字段、并发更新拒写。正式包收据与真实签名尚待root提供，测试fixture不是正式包证据。
