# 6.1107.1 应用内检查更新入口修正

用户反馈版本已发布，但“检查更新”显示没有更新。根因是此前把 6.1107.1 标为 prerelease，而应用固定读取 `https://github.com/wizlijun/note.md/releases/latest/download/latest.json`；该入口仍返回 6.1104.2，低于本机 6.1106.1。

已将既有 release 436786471 设为正式版、latest，并同步中英文发布说明。复用原有四个资产，不重建安装包、不移动冻结 tag。原发布报告保留历史状态，并链接本次修正。

## 验证

- 修改前入口返回 6.1104.2；修改后 GitHub latest API 返回 v6.1107.1，prerelease=false、draft=false。
- 四资产的 ID、大小、updated_at、上传状态及服务端 SHA256 均与此前八次匿名验收的资产一致；本地字节哈希再次匹配。
- 项目 Cargo.lock 锁定 tauri-plugin-updater 2.10.1。其实际请求使用 `Accept: application/json`、`User-Agent: tauri-plugin-updater/2.10.1`；按这些请求头、不带额外查询参数读取同一入口，得到 6.1107.1，响应字节与已验收 manifest 一致。绕缓存读取得到相同内容。
- 初始普通 curl 使用不同默认请求头时曾命中旧重定向缓存，此结果保留在传播探针中，没有将它计为新版本生效证据。
- 更新 manifest 仅包含 darwin-aarch64，URL 和签名与原更新包匹配；minisign 再次验签通过。
- 远端 tag 解引用仍为 e1e64f9f157b025a0eb1bc698e9702beba4b4980，资产未改变。
- 本机安装版本只读核实为 6.1106.1，新版本 6.1107.1 更高。手动 runCheck 直接调用 updater.check，不受启动时 20 小时缓存限制，无需清用户缓存。

本次仅纠正发布频道及说明，没有修改 updater 产品代码、安装应用或操作用户的更新按钮。原版本已知软换行及嵌套引用定义边界继续保留在发布说明中。

本机证据位于 `tasks/update-channel-20261107/`：release-before/after.json、preflight.json、endpoint-before.json、app-request.json、propagation-probes.json、verification.json、minisign.log、remote-tag.txt。验证时间为 2026-11-07T00:43:28Z（本地 08:43）。
