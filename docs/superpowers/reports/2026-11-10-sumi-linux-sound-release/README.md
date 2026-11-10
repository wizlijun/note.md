# Sumi Linux 音效修复：正式 6.1110.7

已公开[v6.1110.7](https://github.com/wizlijun/note.md/releases/tag/v6.1110.7)，冻结源码fbb9186259773a77f84a3ac69918e9f2f9df341f。Sumi0.1.12原签包和音频后台d044c31d…保持原字节，无需更新插件。此报告涵盖源码、正式包、隔离GUI、公开资产及本机安装后的实际音频验证。本机已安装7并通过正常退出流程重启，实际按键音频已恢复。

## 根因和最小修复

宿主PluginProcess::spawn清空环境并只传白名单，Linux遗漏XDG_RUNTIME_DIR。实际6宿主有该变量、Sumi后台没有；其pa_simple_new使用默认服务地址，无法定位PipeWire Pulse的用户socket，返回Connection refused(6)。安装中12音效资源hash正确，后台确含libpulse-simple。相同签名binary的隔离SDK A/B：旧白名单ready=false/无流；只加runtime约10ms ready=true且出现Sumi音频流。独立两preset实际输出非零，证明无需更换音频引擎。见diagnosis。

生产修复仅Linux白名单新增XDG_RUNTIME_DIR，Mac/Win分支不变。真实PluginProcess子进程回归先红exit101，再绿1passed，同时证明假secret和无关marker仍未传入；平台既有2测试及host check通过。源修复c8057be8在main等价c59752dd；版本eb7643d2与测试launcher统一入口fbb91862构成冻结7。main额外SmartLookup未发布功能不在tag7；版本日志保留其Unreleased。未扩整个环境、未增加其他音频环境变量、未改150ms恢复策略。

## 正式资产与发布

Deb SHA256：886379f3f52c768790ce4a9113f56b4c243033d6362a2afbfca36fbc6bdcbe23。
Arch SHA256：8c1755a55db1d66777df9a174c9a63c59ae5f82e6bface18bf0805dc1c5508bc。
两包/usr/bin/notemd SHA256：213c47b888592ed7546db1d2acb5ceb3386e9cc5e89c9a8304105b0d766ed467。

按原冻结git archive/Debian12构建。首次Arch runtime下载镜像超时，保留release-build.log；对同一Deb运行原release-linux-verify.sh完整重试一次exit0，ELF/依赖/ldd-r/CLI/GLIBC2.35通过，未重复Rust构建。复核远端tag及draft后按原release-linux.sh下半段算法生成checksum上传，原release-publish.sh公开Linux amd64-only且不改Mac latest。Omarchy prepare/makepkg/逐字节与权限验证通过。全部6公开资产匿名回读一致，source tag正确，Mac latest保持6.1110.1，见host-public-verification.json。

## 正式GUI声音链路

[完整验收](formal-gui/README.md)使用正式包内宿主、原签后台和真实GTK按键；只读观测，无运行时修复注入。

- 私有Wayland runtime中仅建pulse/native到真实同UID音频服务的桥，未向host/backend注入PULSE_SERVER。旧正式6同环境缺runtime、UI不可用、0流；新7后台正确继承私有runtime并建立流。桥是隔离验收环境，不是产品绕过方案。
- 仅parec --monitor-stream录自有测试sinkinput，不录麦克风/其他应用。typewriter真实按键峰0.00048934，thock峰0.000436867，静音基线/停笔尾段均0。不是仅打开静音流的ready测试。
- CtrlW关闭Sumi后后台可保留静音流；独立3秒录制peak0，不宣称关窗立即销毁流。退出整个fixture后自有流消失。
- F11往返、正常编辑保存、真实nihao候选鼠标提交严格得到目标中文，测试正文为固定私有内容。
- 每次临时10%自有stream测试结束均按原声道整数volume/mute还原并读回；早期诊断曾遗留WirePlumber应用音量10%，已用自有静音流/官方API恢复Sumi默认100%未静音，全局sink45%未变，未直接编辑state文件。

全部私有host/backend/recorder/fixture和任务Docker均已清理。原生修复无用户文档改动。本机管理员认证后，pacman/CLI/binary均核对为7；正常tray Quit保存退出旧6，再启动正式7和Sumi，未强制终止用户程序。

## 本机实际进程验证

[实际验收](local-install/verification.json)：安装notemd6.1110.7-1，/usr/bin与运行host142195均为正式213c47b8…；正常退出旧110504后，原签后台142526实际继承/run/user/1000，并建立Sumi/Typing feedback流822，应用音量100%未静音。仅在已聚焦Sumi时发送一次Shift_L（不注入正文），只录自有stream，58560帧peak0.29368472。录音器已退出，用户应用/Sumi保持运行，默认输出音量仍45%。用户现场PCM与日志只保留ignored任务目录，不作为公开附件。
