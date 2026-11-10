# 正式 6.1110.7 Sumi 音效验收计划

当前仅准备，正式 tag 已冻结为 fbb9186259773a77f84a3ac69918e9f2f9df341f；Deb SHA 未到，不启动用户应用，不修改生产源码或插件。

- [x] root 提供冻结 v6.1110.7 commit 与正式 Deb SHA 后，使用既有 stage.py 校验 tag/ELF/原三签包及 d2 addon；新建独立 fixture。
- [x] 记录私有 runtime/pulse/native -> /run/user/当前UID/pulse/native 桥。仅该 fixture 路径新增 symlink，不设置 PULSE_SERVER 给 host/child；这样实际检验 child 是否继承 XDG_RUNTIME_DIR。
- [x] 相同桥接环境启动旧正式 6.1110.6 作为负对照；仅只读检查其自有 child 环境及 Sound UI，预计缺 runtime / 无输出流。停止旧 fixture 后启动正式 7。
- [x] 正式 7 核对 /proc/exe SHA、backend parent chain/签包 SHA、child runtime 与私有 runtime 一致；仅读自有 backend 环境指定字段，不碰 stdio。
- [x] 通过真实 Sumi Sound UI 启用/授权音效，typewriter/thock 各真实输入数键。pactl 仅识别自有 backend PID 的 sink-input，将该 stream 音量设为 10%；不得改 sink/global/user stream 音量。
- [x] parec 仅 --monitor-stream=自有ID，使用该 stream 对应 sink 的 monitor_source_name；从不录默认/整个 sink monitor。记录非零峰值、RMS/时间窗，停笔尾段回到静音，关窗后自有 stream 消失或停止；保留实际语义，不把持续的静音 stream 判为失败。
- [x] 新正式包短测编辑/保存、F11 往返与中文候选鼠标提交；无需重复 6 已过的所有窗口/滚动矩阵。
- [x] 报告严格区分私有 Pulse 桥（验收环境连接真实同 UID 服务）与生产修复（仅继承 runtime）；真实录制只来自测试 stream。停止所有自有 recorder/backend/host/fixture，保留来源/音频指标/截图/哈希。

不安装、不公开发布、不修改用户配置/文档。发布与最终归档提交由主代理负责。

- [x] 每次降音量前保存该stream所有声道整数音量与mute；finally在关闭前用pactl逐声道恢复并读回核验。已知诊断遗留10%由rootless清理恢复100%，不得再次遗留。停止按键后再恢复，不读录其他流。

验收完成：verification.json全部门禁通过，旧6失败/新7真实按键非零峰值、停笔/关窗静音及原音量恢复均有证据。正式host/backend/fixture已停止，自有stream消失；WirePlumber Sumi条目100%/unmuted。没有安装或发布，证据待主代理精确提交。
