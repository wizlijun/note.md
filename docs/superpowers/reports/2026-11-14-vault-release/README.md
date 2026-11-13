# Vault 6.1114.1 发布准备：Apple 协议阻塞

日期：2026-11-14。状态：**未发布，无 release tag、无 GitHub 草稿；Apple 公证失败。**

本轮用户要求发布已实现的 Vault 功能。按既有流程从干净独立 clone 执行 `scripts/release.sh 6.1114.1 --arm64-only`，使用已批准 Fcitx5 for Sumi 0.5.0.15。发布范围审计见 [scope-audit.md](scope-audit.md)。市场插件未重发。

## 已完成

- 设计及实现提交已推 main，构建基线 `d56a538f97afe2870085581a5d75eac2624d37f7`。
- 发布脚本全量前端 436 文件 / 5923 tests 通过；Svelte 0 errors / 31 既有 warnings；protocol 一致。生产依赖审计 1 low / 4 moderate，无 high/critical，达到既有门槛。
- Rust canvas 相关 27 项与 mobile_project_config 3 项通过。
- `6.1114.1` Apple Silicon release profile 构建完成，Developer ID Application 签名完成；保留候选的 codesign deep/strict 验证通过。
- 批准配套包按冻结 SHA256 `f75d72fa51efa50d09412b956453a0f36f59ced8a47f501bab148867f10c4299` 核对。

## 阻塞及未完成

Apple 公证返回：

> HTTP status code: 403. A required agreement is missing or has expired.

服务进一步指出团队须具备已签署且有效的必要协议。需要 Apple Developer 账号持有人在其账号中处理协议；自动重试构建不能解决此问题，未尝试代签协议或绕过公证。

既有脚本退出码 1。没有创建 `v6.1114.1` tag 或 GitHub Release，未修改公共更新清单。此候选未公证，不能视为可分发版本；最终 DMG、更新签名、六附件、包内功能验证和匿名公网回读均尚未完成。先前版本保持公开。

## 保留与恢复

- 已签名但未公证的候选留在 `tasks/vault-release-20261114/candidate/note.md.app`；[blocked-candidate.json](blocked-candidate.json) 记录源码基线、版本差异和二进制哈希，不表示发布验收成功。
- 原发布日志：`tasks/vault-release-20261114/release.log`。自动版本/日志轮转差异保留为 `unpublished-version-bump.patch`。
- 原脚本失败后六个版本/CHANGELOG 文件仍为 dirty；核对仅为该脚本生成差异后，在独立 clone 精确恢复至基线，避免重跑时丢失 Unreleased 条目。主工作区从未应用这六项临时修改。
- 主工作区原两处 EOF 改动及 stash 哈希逐项核对不变；未安装候选、未操作正式 Vault。
- `verify-host.py` 与 `verify-public-host-full.py` 保留在任务目录待后续正式产物产生后使用；没有生成虚假的产物验签成功证据。

协议处理完成后，重新确认版本未被占用、同步最新 main，在干净源码上重跑原 release.sh 门禁与公证；候选就绪后按既有平台范围确认门禁公开，再做完整匿名回读。不能仅上传本次未公证 App。
