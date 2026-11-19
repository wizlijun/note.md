# 首页快捷方式宿主发布范围

用户明确要求“发布宿主版本”，并选择“macOS Apple Silicon（沿用最近两版）”。本次目标为6.1119.1，仅darwin-aarch64。本文是构建前范围审计，不是已发布证据。

## 纳入

首页功能分支全部已验证提交，包括顶部三个图标、八格常用/固定应用、目录与位置编辑、折叠Vault、浅深三色、保留文档的首页导航、共享运行时和严格安装清单/窗口错误传播。最终功能源码df353a18，验收归档31678c70；6006前端、27原生、19浏览器交互、类型检查与生产构建通过，独立评审Important已全部关闭。双语Unreleased已有对应用户行为条目。

根main 969f8e73与上一正式tag v6.1117.1的净差异仅16个历史发布证据文件，产品源码、版本与锁文件无差异；history列出的旧release提交来自合并历史，不能当作未发布新功能。当前唯一未合入本地分支是本次feat/home-app-shortcuts；完整提交列表及git cherry结果见[机读审计](pre-release-audit.json)。

## 工作区和保留项

| 位置/内容 | 处置 |
| --- | --- |
| 根worktree的searchidx/src/store.rs、src-tauri/src/smart_lookup.rs | 既有EOF变化，记录SHA并原样保留，不提交、不进入构建。 |
| output/design/三张首页概念图 | 已逐一枚举和记录SHA，保留为用户文件，不纳入发布。实际验收截图已独立提交。 |
| .worktrees/home-apps | 本次已验证源码与验收文档分支，完成后精确合入main。本文与机读审计是新建的发布准备证据。 |
| tasks/vault-release-20261114/source | clean、无stash，原main d6d63363；拟快进到本次origin/main用于构建。package.json和pnpm-lock与本次功能源码逐字相同，复用依赖，无需重装。 |
| ../mdeditor-sumi-ime-host | clean、无stash，旧main7437e6fe；不作为本次发布目录。依赖字段/锁一致，仅旧版本信息不同。 |

## 唯一stash的逐项核对

stash@{0}=03d8a9ff3cc5c25552040fda41a2531ee3c1ac5c保留不应用、不删除；index父树无改动。17个跟踪文件的当前main与v6.1117.1版本逐字相同，均不属于本次待发功能。核心整合710c148c已在正式tag祖先中，且实际实现已继续演进；不单凭祖先关系判断。

| 文件/主题 | 实际功能核对 |
| --- | --- |
| CHANGELOG.md、CHANGELOG.zh-CN.md | 聚焦与安静提示已入v6.1109.2历史；不恢复旧Unreleased。 |
| immersive-write-design.md | 旧57%/五行已标历史，现行为50%居中渐隐；不回退规格。 |
| write/src/contract.ts | 聚焦契约仍在，后续增加startFullscreen；不重放旧blob。 |
| write/src/main.test.ts、main.ts、style.css | 聚焦开关、提示区域、持久化/错误/重试仍在，后续补critical常显与Linux布局；不覆盖现行实现。 |
| scripts/sumi/build.mjs、native/build.rs、run-native.mjs | 三份完整blob与stash相同，focus.h构建输入已存在。 |
| scripts/sumi/verify-release.py | focus.h及focus-probe已在正式inventory，后续扩展交互验证；不回退。 |
| searchidx/src/store.rs、src-tauri/src/smart_lookup.rs | stash仅EOF变化，排除；实际业务已有后续版本。 |
| src-tauri/src/sumi/mod.rs | 聚焦默认/迁移/appearance传递/重启持久化及隔离文档音效测试均存在。 |
| tauri-plugin-native-editor/build.rs、native/editor.m、src/lib.rs | 聚焦生命周期、IME/caret、输入哈希与相关测试已实现并继续修正，旧五行算法被替代。 |
| 第三父树native/focus.h、focus-probe.m | 早期未跟踪草稿已被正式实现覆盖；不应用，不删除stash。 |

## 发布输入与门禁

沿用scripts/release.sh和release-publish.sh，不改发布通道。复用批准的Fcitx5 for Sumi 0.5.0.15配套包，SHA f75d72fa51efa50d09412b956453a0f36f59ced8a47f501bab148867f10c4299，61,312,645字节。只读确认GH认证、Apple签名/公证配置及updater私钥存在；不在报告记录秘密值。

先完成签名、公证草稿与冻结tag/实际包验证，再走发布器的人工平台省略确认，最后匿名完整回读六附件和真实更新入口。此前工作区测试不替代安装包证据。发布构建不使用两处EOF脏文件，也不应用stash。
