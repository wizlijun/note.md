# Sumi 0.1.11 Linux 插件发布准备

范围：仅新增 `notemd.sumi@0.1.11` 的 `x86_64-unknown-linux-gnu` 下载，最低宿主 `>=6.1110.2`。既有 Mac 0.1.10 与其他市场条目逐字段保留。本文及测试通过不代表已上传或发布。

源码 manifest 应保留 Apple Silicon 与 Linux 两项 `binary`。`release_sumi` 只构建选定 target；`gen-plugin-index.mjs` 的 `archs`、`download`、`sha256` 来源是实际 `.notemdpkg` 文件，不是 manifest 的全部平台。因此本次 0.1.11 产物目录只放 Linux 包即可。市场按平台和最低宿主过滤，Mac 继续选择原 0.1.10。

## 冻结后构建

以下命令在已冻结正式 tag 的源码工作树执行。使用现有插件 minisign 私钥，不生成替代身份。`release-plugins.sh` 本身不上传。

```sh
SUMI_RELEASE_TARGET=x86_64-unknown-linux-gnu bash scripts/release-plugins.sh --release sumi
node scripts/gen-plugin-index.mjs
```

生成器可能刷新无关插件的源码描述，因此不能把其整个结果直接覆盖线上 KV。本发布器核对生成器给出的本次条目，发布时从最新 KV **只追加这一条**。同版本不同内容、历史重复身份，以及提交前重读发现的并发 KV 变动均拒绝继续；KV 没有提供跨写者原子 compare-and-swap，本工具不声称消除了检查之后的全部竞争窗口。

## 冻结 receipt

构建负责人提供真实 `frozen-plugin.json`，没有可执行的虚构默认值：

```json
{
  "sourceCommit": "最终 tag 的完整 40 位 SHA",
  "package": {
    "id": "notemd.sumi",
    "version": "0.1.11",
    "arch": "x86_64-unknown-linux-gnu",
    "sha256": "实际包 SHA256",
    "signatureSha256": "实际 minisig SHA256",
    "bytes": 123,
    "files": {"包内每个非目录相对路径": "该文件 SHA256"}
  },
  "host": {
    "tag": "v6.1110.2",
    "sourceCommit": "同一最终 tag 的完整 SHA",
    "assets": [
      {"name": "note.md_6.1110.2_amd64.deb", "bytes": 123, "sha256": "实际已冻结 Linux 宿主包 SHA256"}
    ]
  }
}
```

`host.assets` 可以包含实际正式 Arch 宿主包及附属校验资产；必须至少包含一个严格命名的 amd64 Deb 或 x86_64 Arch 宿主包。发布者不得把预览包的哈希填作正式包。宿主发布策略未决定、正式 tag/资产没有冻结时，缺少这些输入会直接拒绝。

## 分阶段执行

`publish-plugin.py` 沿用旧 Sumi 发布器的 Wrangler 3 + Account API Token、R2 不可变对象、公网回读验签和 KV 并发检查流程。仅使用现有项目锁定的 Wrangler **3.114.17**；不升级、不调用 OAuth、不部署 Worker。凭据通过进程环境提供，脚本不输出 token；也可用 `--token-env-file` 读取既有 env 文件中的 `CLOUDFLARE_API_TOKEN` 单一字段。

```sh
python3 publish-plugin.py check \
  --receipt /absolute/path/frozen-plugin.json \
  --source FINAL_SHA \
  --repository /absolute/path/frozen-source \
  --tools-repository /absolute/path/repository-with-existing-wrangler \
  --package /absolute/path/x86_64-unknown-linux-gnu.notemdpkg \
  --generated-index /absolute/path/dist-plugins/index.json \
  --output /absolute/path/release-evidence
```

沿用相同参数，依次运行 `inspect`、`stage`、`publish-index`：

1. `check`（默认）：完全离线；核对本地冻结 tag、manifest、原公钥签名、ELF 架构/执行权限、包内完整文件表与声音来源、生成器条目、Wrangler 版本。
2. `inspect`：只读检查公网/KV 同版本占用与包/签名对象。没有占用不等于预留成功。
3. `stage`：再次检查两个对象后，使用既有 `wrangler r2 object put` 上传缺失对象。失败或超时先读回，只有确认不存在才以同键/同字节有界重试。普通和无缓存公共 URL 均须逐字节一致并验签通过；此阶段不修改索引。
4. `publish-index`：先检查 GitHub 正式宿主 release 非 draft/prerelease、公开 tag 指向冻结 SHA、实际 Linux 资产名称/长度/哈希及匿名下载完整字节。再验插件公共包签名，读取最新 KV，精确追加新条目，提交前重读阻止并发覆盖，写后核对 KV 与两种公网索引读数一致。

宿主门禁仅接受实际 Linux 资产，不依赖 Mac DMG/`latest.json`，也没有“宿主尚未发布”的绕过参数。普通匿名 GitHub 下载失败时停止；不会把已认证 API 可读当作公开资产可下载。

Fcitx addon 不在插件 ZIP 内；候选功能的最终发布证据还必须覆盖宿主及单独配套 addon 资产。

## 离线测试

```sh
python3 -m unittest discover -s docs/superpowers/reports/2026-11-10-sumi-omarchy-release -p test_publish_plugin.py -v
```

测试覆盖缺失/错误冻结输入、公开宿主门禁、双平台 manifest 生成单 Linux 下载、历史条目原样保留、同版本冲突、签名/宿主失败无写入、KV 并发覆盖防护、超时后先回读与幂等处理。所有外部读取和写入均模拟；测试不会使用 token 或访问公网。
