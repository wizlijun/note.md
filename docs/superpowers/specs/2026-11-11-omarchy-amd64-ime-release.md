# Omarchy amd64 宿主与特殊输入法联合发布

用户要求发布新的 Omarchy amd64 版本并附特殊输入法。本次为 note.md v6.1111.4 Linux x86_64，与 fcitx5-sumi-candidates 5.1.23.r3.gb75c450f-1 联合交付。

## 范围

- 主分支已含候选编号去点、窄空格与随字号缩放的组间距（b9f1f0b0、304e7555）。以新冻结 tag 源码构建宿主，不能复用本机6.1110.7-3。
- 输入法固定 b75c450fe8ee0249d20d8727abe59c2b818e0c16，提供 Sumi 候选桥接及全局预编辑去高亮底色。公开完整 addon 源码、LGPL 许可证、配方和真实拼音验证脚本；不依赖尚未推送的源码分支。
- 用户主题、DPI 同步和个人输入偏好不是 addon 载荷。交付文档明确 fcitx5 版本约束以及拼音、GTK 模块前置条件。Sumi 沿用已签名的正式 Linux 插件，不发布新的插件版本。
- 只发布 Linux amd64。保持 GitHub latest=false、既有 macOS latest.json 原字节，不附 macOS Faitc5，不自动安装本机。

## 流程与验收

1. 审计所有 worktree、分支非祖先提交、stash，核对旧提交补丁等价与实际候选源码。
2. 前端测试、类型检查、协议生成校验、安全审计、相关 Rust 单测通过；版本与双语日志精确提交并冻结 tag。
3. 沿 release-linux.sh --amd64-only 从 tag 和固定 moraya-core 提交构建，执行 Debian/Arch 包验证。实际包配合正式签名 Sumi 及实际 r3 addon 进行隔离 GUI 测试，验证鼠标/键盘中文提交及候选展示。
4. 准备输入法公开附件及重建证据。沿 release-publish.sh --linux-amd64-only 发布宿主；按既有流程从公开 Deb 生成 Omarchy PKGBUILD、核验 Arch 载荷并追加附件。同次 release 附输入法安装包、固定源码构建包、联合安装说明、校验清单。
5. 匿名公网回读全部附件，核对实际字节、版本和来源；记录最终 tag、各包及二进制哈希、测试结果和发布证据提交。

源码、测试与发行包须逐项对应；任务记录或工作区测试不能替代实际发行包验收。
