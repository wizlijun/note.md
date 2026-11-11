# Faitc5 for Sumi 0.5.0.14

冻结输入法源码53758c46aed45f3de997bf956becdd819d0f8be1，快捷键28966ee，App公证Accepted c96d2006-ff9d-4ba3-b015-abfb69ed416a。macOS新装与拼音/双拼设置恢复默认均为Command+分号，已有配置不覆盖；裸分号继续标点。

安装后继续已验证的自动修复链路：preinstall用户持久请求，postinstall在控制台用户GUI启动新App，App等新receipt后执行原生输入源修复；辅助功能权限授予后自动继续，成功后点开始使用。没有在root安装器中同步执行AX修复，没有第二套daemon。

最终pkg展开后636文件/链接一致、13个原生binary票据CDHash核验；codesign/stapler/spctl通过；完整构建、7项ctest、空格39+16、安装链路45+生产Model、真实拼音Cmd快捷词组与裸分号、隔离配置安装保留回归通过。本轮未在系统安装或做新机器实机验收。App公证不等于pkg签名：pkg仍未签名。

独立输入法发布，保持已公开note.md v6.1111.2的0.5.0.13附件不动；未来CD批准清单更新到0.5.0.14。GitHub输入法发布tag在note.md仓库指向批准清单与证据；实际输入法源码位于独立fcitx5-macos-sumi仓库冻结53758c46，不将宿主tag误称输入法源码。

CD验收：release-companion与release-publish共187测试通过；真实.14包通过现有release-companion.mjs stage批准hash/size核验，日志在Faitc5-Releases/0.5.0.14/cd-stage.log。

已公开 https://github.com/wizlijun/note.md/releases/tag/faitc5-v0.5.0.14 ，发布tag指向批准记录3c055387。三附件先draft全量回读，再公开从官方URL完整匿名下载，SHA/大小与发布资产digest一致；latest宿主仍v6.1111.2。新包本地副本在Downloads。脚本为本次执行归档，真实执行目录在Faitc5-Releases/0.5.0.14。
