# v6正式包重验

- [ ] root冻结新tag后核对commit/正式DebSHA，复用原三签包，独立freshfixture。
- [ ] 只加载只读window/frame/input observers；禁止diagnostic-input-pass/probe.so和ENABLE_DIAGNOSTIC_MUTATION。
- [ ] 正式进程来源核对后优先真正bodyclick/dragselection/wheel及候选鼠标提交；只读观测真实事件到TextView/ScrolledWindow。
- [ ] 240行长文midscroll、scale2/3、奇偶viewport/caret与22/适配字号稳定，真实F11往返；记录有限过渡边界。
- [ ] IME、非聚焦候选原位、滚轮阅读/输入恢复、原生scrollbar/shadow+边缘像素。
- [ ] 核心通过先通知root公开；发布后旧正式4独立freshcache发现6，非用户应用。
- [ ] 报告原v5正式失败和诊断A/B关系，不将诊断模块成功充当新正式包证据；结束仅清理私有进程。
