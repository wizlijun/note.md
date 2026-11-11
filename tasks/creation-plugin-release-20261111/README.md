# 创作分类发布器：离线准备与执行契约

本轮仅两个新包：Sumi `0.1.15/aarch64-apple-darwin`、IdeaSpark `1.3.9/universal`。公开最新版本由独立构建审计确认分别为0.1.14/1.3.8。历史条目仅两款插件的 `category` 迁移为 `create`；包字节、签名、全部历史字段以及其他插件不变。

## 清单 schema

`frozen-plugin-packages.json` 由构建验收方生成，不是 publisher 自动推断；不包含私钥或凭据。

```json
{
  "sourceCommit": "完整40位Git SHA",
  "sourceRepository": "/绝对/冻结worktree路径",
  "packages": [
    {
      "id": "notemd.sumi",
      "version": "0.1.15",
      "arch": "aarch64-apple-darwin",
      "sourceCommit": "与顶层一致",
      "packagePath": "/绝对路径/aarch64-apple-darwin.notemdpkg",
      "sha256": "完整包SHA256",
      "bytes": 123,
      "signatureSha256": "旁边.minisig文件SHA256",
      "files": {"manifest.json": "SHA256", "其他所有ZIP文件路径": "SHA256"},
      "verification": {"soundFiles": {"manifest.json": "SHA256", "其余声音资源相对路径": "SHA256"}}
    },
    {
      "id": "notemd.idea-spark",
      "version": "1.3.9",
      "arch": "universal",
      "sourceCommit": "与顶层一致",
      "packagePath": "/绝对路径/universal.notemdpkg",
      "sha256": "完整包SHA256",
      "bytes": 123,
      "signatureSha256": "旁边.minisig文件SHA256",
      "files": {"所有ZIP文件路径": "SHA256"}
    }
  ]
}
```

必须按Sumi、IdeaSpark排序，恰两个包。`files` 不含目录，禁止重复ZIP文件名。Sumi `soundFiles` 恰14项，路径相对 `resources/sounds/`，逐项与冻结Git源字节比对。`packagePath` 必须指向正确架构basename。两个包的manifest与 `git show <source>:plugins-src/{write,idea-spark}/manifest.v2.json` 整体相等；生成的 `dist-plugins/index.json` 新条目也必须逐字段精确匹配manifest、包大小、SHA和官方下载URL。市场公钥来自冻结源 `src-tauri/src/plugin_runtime/market.rs`，不会信任清单提供的替代公钥。

Sumi最低宿主固定 `>=6.1111.1`，IdeaSpark固定原manifest `>=6.1110.4`。索引发布强制验证公开稳定宿主 `v6.1111.1` 和对应arm64下载资产/manifest；不提供pending-host绕过。

## 操作

```sh
python3 tasks/creation-plugin-release-20261111/test_publish_plugin.py
python3 tasks/creation-plugin-release-20261111/publish-plugin.py check --source <冻结SHA>
python3 tasks/creation-plugin-release-20261111/publish-plugin.py inspect --source <冻结SHA>
python3 tasks/creation-plugin-release-20261111/publish-plugin.py stage --source <冻结SHA>
python3 tasks/creation-plugin-release-20261111/publish-plugin.py publish-index --source <冻结SHA>
```

`check` 不联网、不读取Cloudflare token；`inspect`匿名回读对象/公网索引并使用现有Account API Token只读KV。后两项才外部写，由主代理执行；本脚本准备者不会执行。每次都重验包、签名、源manifest、索引以及仓库现有Wrangler **3.114.17**。凭据仅从主仓库 `.env` 中的 `CLOUDFLARE_API_TOKEN` 读取或沿用环境，不打印。

`stage`：所有四个对象先查占用，任何对象冲突则整个阶段不写；每次put前再次匿名回读。网络不确定停止；超时后先回读，已落盘则不重复put。然后normal/fresh两个匿名路由完整回读包/签名并验签。

`publish-index`：公开host门禁→重新公网包验签→读取实时KV→仅迁移两款历史category并追加两个新entry→重读KV阻止并发覆盖→一次KV写→KV回读→normal/fresh公网索引完全一致。已存在的新版本需整条相等（即使只category冲突也拒绝）；已完成流程再次执行不产生索引写。失败后保存证据再执行相同模式，禁止换键/版本覆盖。KV并发检查是现有流程的乐观保护，不等于远端CAS；执行期间仅允许本次单一发布者。

## 证据和局限

- `tests-red.log`：基于旧单包publisher的红测证据。
- `tests-green.log`：16项离线回归，含精确manifest与索引字段、历史保留、同版本冲突、占用不确定禁止写、R2失败先回读、host/验签失败禁止写、KV并发阻断与timeout落盘恢复。
- `plugins-r2-preflight.json`、`plugins-public-packages.json`、`plugins-index-before/candidate/kv-final/public-{normal,fresh}.json`、`plugins-index-verification.json`：由实际执行阶段生成。
- `categoryChanges`明确记录所有历史分类迁移，不声称历史条目完全未改。
- 已发布旧宿主的菜单硬编码兼容行为属于宿主版本；本轮包和网站更新不能声称替换旧宿主代码。
