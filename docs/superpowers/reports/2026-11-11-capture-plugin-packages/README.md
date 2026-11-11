# 捕捉分类插件包验收

用户要求发布本轮调整过的插件。新版本 Apple Notes 1.0.5、Roam Research 1.2.8、Health Sync 0.2.3，均保留 Apple Silicon 和 Intel Mac 两架构及原最低宿主要求。

冻结源码 `93a8253490c7e649cceb4108c11c22d747192e32`，标签 `plugins-capture-20261111`，独立 sparse worktree `/Users/bruce/git/mdeditor-capture-release-20261111`。此次是已验证旧包的元数据重包装，不是重新编译：

- 从匿名公网下载六个旧包及签名，完整 SHA-256 与实时索引一致，minisign 验证通过。
- 新包只修改 manifest 的 version 和菜单 submenu=record；完整 ZIP 条目及所有非 manifest 字节保持相同（bin/UI/资源/许可证均逐文件校验）。
- 使用既有 `~/.tauri/notemd-plugins.key` 新签包，六包 minisign 验证通过。
- 六个原生二进制均严格 codesign 验证、Team T5G56DH47L、架构检查通过。未重签原生二进制、未重新申请公证；没有 Apple Accepted 证据，不能称本轮已公证。
- 三个 ARM 包实际二进制在独立临时 data_dir 中仅执行 `$initialize`、`$deactivate`，成功回复并正常退出。没有激活后台轮询、访问真实账号、同步或请求 Apple Notes 权限。Intel 未执行。
- Apple Notes 业务源对 ed785413、Roam 对 0841b18f、Health 对已发布 tag caa7089a逐文件一致，见 business-source-audit。共享依赖未重编，实际运行payload以已公开签名包字节为准。
- Health 旧包日德说明与 main 新说明有差异，按本轮范围只保留旧包说明；main 文案未回退。本次版本提交只升六处版本字段。

冻结包与哈希见 frozen-plugin-packages.json；逐文件复用/签名/协议结果见 package-reuse-proof.json。repackage.py 是实际执行脚本审计副本（真实路径在 tasks 下），第一次验收脚本误读 min_host 字段，修正为索引 min_host 后删除仅本轮未发布失败首包重新完成验证；无远端写入。

此报告证明六个包已准备并验收，R2/KV 发布由主代理另行完成并记录，不能以此报告当作已上架证据。
