# Linux 宿主更新检查修复

用户报告宿主自动检查更新无效。本机安装的 6.1109.4 属于本地包，Linux 渠道在启动/手动检查之前直接返回；更新弹窗把 idle 误报为“已是最新”，设置中的 `omarchy update` 提示也无实际软件仓库条目支持。

修复提交 `580de68d` 恢复按原生 triple 查询实际 Linux 安装包、启动/手动检查、通知及下载页；与原有 direct 签名更新逻辑分开。成功检查才满足缓存 TTL，失败可重试，无更新会清除旧目标。尚未检查不再报告最新。Linux 仍由系统包管理器安装，不在后台自替换或重启。

## 验证

- 更新状态机、metadata 与组件共114项通过；先前并行启动整个类型扫描与发布器测试时，首次动态编译超出5秒测试时限，连带污染下一项计数；分开运行后114项全部通过，没有放宽断言或测试超时。发布构建/发布器190项在该轮通过。
- 完整 src 类型检查0错误、31条既有警告。为避开 ignored tasks 中 Docker 缓存配置扫描，将源码和测试引用的固定文件复制到临时目录检查；缺少的外部fixture已补全后重跑，未修改生产配置。
- 生产 Linux resolver 仅替换 HTTP transport，以真实匿名公网数据验证 x86_64 → 6.1110.2（高于已安装6.1109.4）、aarch64 → 6.1027.1。该项不冒充原生 IPC 或正式包 GUI 验收。
- 独立真实 WebKitGTK 2.54.1 渲染生产组件/状态机通过：未检查、新版下载页、自动检查开关、手动检查和503错误文案有截图；记录确认为仅 opener，不触发自替换/重启。该轮原生IPC/HTTP模拟边界见 `webkit/verification-summary.json`；自有进程均已停止。
- 所有工作树、未合入分支、补丁等价与 stash 已审计；仅本次更新修复进入发布范围，Sumi插件与addon保持既有发布字节。

## 正式包验收

正式 Debian 包 `e9945737d9dae0155fb46fe1a30f93450652f212f1877f600abcf8fef8a8fd29` 运行进程 SHA 与包内 binary 一致。首次无观察模块启动，真实 native HTTP 自动检查并新建独立成功缓存；最近失败的999缓存也会重试并清理。原生菜单检查刷新时间，设置关闭自动检查后重开保留偏好且不自动请求，手动按钮仍刷新真实结果。后续只读观察模块记录原生身份/DOM，不替换HTTP或更新状态。全部检查、截图和边界见 [正式GUI证据](formal-gui/verification.json)。临时环境已停止，用户程序未重启。

## 交付状态

已公开 [v6.1110.3](https://github.com/wizlijun/note.md/releases/tag/v6.1110.3)，冻结源码 `a64353c72ffe930de5ff90923b457e1d15360bef`。由原有 Debian 12 构建链生成 amd64 包；配套 Omarchy x86_64 包保留全部9个Debian文件及权限，最大GLIBC2.35，动态依赖/CLI检查通过。实际包内二进制 SHA256 为 `194c15a9b78f0524a2bebc341be97a83455028d3d14b64740a22931c421022c6`。

| 安装包 | SHA256 |
| --- | --- |
| [Omarchy x86_64](https://github.com/wizlijun/note.md/releases/download/v6.1110.3/notemd-6.1110.3-1-x86_64.pkg.tar.zst) | `a35f34144d6ca483839d6ae23d2a63a65d376ff630ff1e0d3ea1a50dadb4fa4f` |
| [Debian amd64](https://github.com/wizlijun/note.md/releases/download/v6.1110.3/note.md_6.1110.3_amd64.deb) | `e9945737d9dae0155fb46fe1a30f93450652f212f1877f600abcf8fef8a8fd29` |

发布器按 `--linux-amd64-only` 验证实际包与checksum后公开；所有6个资产已匿名下载并逐字节匹配。发布后生产resolver通过公网识别x86_64 6.1110.3、ARM 6.1027.1；GitHub latest仍是Mac 6.1110.1，Sumi0.1.11及addon没有重发。构建daemon与隔离GUI均已停止。

官网Deb快捷链接已指向6.1110.3；检查时官网Arch快捷链接仍缓存6.1110.2（网站发布列表/解析结果有缓存），因此这里和用户交付均使用精确的6.1110.3资产链接。宿主新检测器直接查询GitHub，不依赖该网站缓存；没有额外部署或更改网站。

旧客户端中的跳过逻辑无法通过服务器更改，首次必须手动安装修复版，之后启动检查和手动检查才会生效。当前用户系统未安装或重启。
