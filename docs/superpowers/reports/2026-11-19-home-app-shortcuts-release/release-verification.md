# 首页快捷方式宿主 6.1119.1 发布记录

状态：6.1119.1 macOS Apple Silicon 已公开；安装包验收与完整匿名公网回读均通过。

范围为用户确认的 macOS Apple Silicon，冻结 tag `v6.1119.1` 指向 `c391032e80d294c8e941b041e0987e8b9555923f`。首页产品提交 `df353a18`、实现验收 `31678c70`、发布范围审计 `9b4b4272` 已合入 main；此次发布提交只旋转中英文更新日志并更新四个版本文件。

首页按创建入口、Apps、设置排列；最多8个应用快捷位，支持常用推荐与固定位置。Vault关键统计保留，其他信息默认折叠；图标统一并使用克制的三色及暗色样式。软件验收覆盖布局、交互和主题，未进行彩色墨水屏或OLED实机测量。

发布前枚举了worktree、未合入分支与stash，逐项核实历史补丁和功能。两处原有EOF修改、三张设计图、原stash均保留且排除；干净发布clone使用既有依赖、脚本和批准的Fcitx5配套包，未操作正式Vault。

验证：发布门禁6006前端测试、Svelte零错误（30个既有警告）、协议产物一致、依赖审计无high/critical、27个canvas专项Rust测试及3个移动配置测试通过。实现阶段另有19个浏览器fixture验收。构建捕获5446个受控文件，均与冻结源一致；唯一未捕获的普通旧文档已另核对pre-bump/tag/clone一致。207个dist产物集合及哈希完整一致。

来源证明依赖受观察的干净构建流程、精确tag、输入/产物哈希和签名资源核验，未声称独立可复现构建。Apple预装订归档哈希与最终下载包哈希分列记录。

实际安装包验收通过：40个首页源码与已验收版本逐字一致，207个完整嵌入资源、8组首页JS/CSS见证和真实编译八格常量绑定通过。DMG与更新tar内的App各7个文件/链接一致；17条命令核验架构、权限、代码签名、Gatekeeper、stapler和更新Minisign签名通过。App与DMG的CDHash分别绑定本轮Apple Accepted票据；配套包完整回读SHA符合批准记录。独立有限复核确认报告相互一致。

验包器曾因codesign输出级别不足而改用-dvvv；另一次临时目录Errno28失败后检查无残留，空间恢复，在本任务TMPDIR重跑通过。两次失败与最终成功日志均保留，未修改产品或降低断言。22个验包器fixture通过。

用户回复精确确认 `v6.1119.1 mac-arm64-only` 后，既有发布器重新核对草稿身份并公开，退出码0，输出 `Published v6.1119.1`。GitHub确认2026-11-19T06:24:23Z公开，非草稿/非预发布，六附件齐全。

发布页：https://github.com/wizlijun/note.md/releases/tag/v6.1119.1

公开后对规范GitHub下载地址匿名完整读取六附件；所有HTTP范围、长度和完整SHA-256匹配冻结资产及GitHub digest。完整更新tar再次通过Minisign，Fcitx5包符合批准值；无重试或备用通道。实际宿主updater入口 `https://github.com/wizlijun/note.md/releases/latest/download/latest.json` 返回HTTP200、740字节，逐字匹配本版清单，平台仅darwin-aarch64。回读前后tag、release和六附件身份保持一致。

主DMG SHA-256：`63fc8b30113f0537c8cbd601d1c458b9e985a587aa9824de7d8d9cff22422fa0`。
更新tar SHA-256：`687a7d7fd2be1809f5f08c00163e949d9e4aeaae658373bcab5ed8fcf1706209`。

回顾：本次按用户选定的平台完成发布；验收证据提交47e0832d，最终公网证据随本记录精确提交。原两处EOF修改、三张设计图和stash保持原哈希；没有代入其他任务改动。原始机器日志保持字节一致，包含工具输出的尾空格；非日志差异检查通过。
