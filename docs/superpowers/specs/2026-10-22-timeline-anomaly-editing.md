# Timeline 反常标签编辑

日期：2026-10-22。补充[交互编辑规格](2026-10-21-timeline-interactive-editing.md)；下文关于手动反常的规则替代原规格中“反常证据规则保持严格”的只读边界。

## 问题与范围
现有活动详情和各级子议题共用 EventEditor，已支持时间、名称、描述、重要程度，但没有反常状态字段。卡片已经根据 anomaly.status 显示独立反常标签。本次补全编辑→来源持久化→标签刷新闭环，不修改分类、评分、宿主协议或线上市场。

## 确认后的设计
- 在重要程度下面提供原生“反常标签”下拉：反常 flagged、未发现反常 none、待判断 unknown；缺失反常状态初始显示待判断，未变化保持原文件字节。
- EventEdit 增加可选 anomaly 状态；旧调用省略时完全保留反常数据。父活动与各层子议题共用表单。
- 明确改变状态时写入 event_metadata[id].anomaly.status、origin: manual、明确的用户手动设置理由；保留已有 evidence 及所有未知字段。不把用户判断伪装成原文证据，不重算重要程度/signals，也不改变来源内容。
- anomaly.origin 是可选契约扩展，仅 manual 有效；只有 manual flagged 可以无原文证据，生成端 flagged 继续必须有有效证据。所有已有证据仍严格校验。详情把手动反常称“手动标记为反常”，手动 none 称“手动标记未发现反常”，并注明证据为保留记录。
- 旧文档首次改变反常时，沿用重要程度升级机制为所有真实事件分配稳定 ID 和 unknown 元数据，只给目标写反常判断。标题/时间/重要程度单独变化不重写反常。
- 保留 BOM、CRLF、事件 ID、注释、来源链接、兄弟元数据与未知字段。完整重解析后才发送保存。
- 现有只读/旧宿主不可编辑能力门槛、CAS防覆盖、失败保留完整草稿、重试、取消和重复提交保护保持有效。

## 验证
1. 先添加回归测试并记录 RED：父/子反常选择，旧文档首次标记/撤销/待判断，manual parser 严格性，证据/未知字段/换行保留。
2. 实现最小字段和元数据增量，全部插件测试、svelte-check、生产构建。
3. 用真实生产 bundle 和隔离 file_view 消息宿主完成 Chromium 的父/子保存、失败重试、取消、重新打开、旧宿主只读、明暗/390px表单截图；不读取真实 Vault，不宣称 native 安装。
4. 精确提交本次独立改动；本任务不发布新插件版本。

## 格式示例与兼容

```yaml
event_metadata:
  e01:
    importance: unknown
    reason: 此活动尚未评定重要程度。
    evidence: []
    signals: {source_chars: null, duration_minutes: null, owner_relation: unknown}
    anomaly:
      status: flagged
      origin: manual
      reason: 用户手动设置反常标签。
      evidence: []
```

`origin` 缺失时沿用原生成端规则；存在时只接受 `manual`。手动状态也必须有非空理由、数组 evidence，已有证据的 source/locator 严格校验。外部生成/筛选工具或旧版 Timeline 未支持此扩展时，可能拒绝手动反常无证据的文档；本次不宣称外部工具已更新。宿主保存协议传递完整文档，不验证此元数据结构，无需增加 capability 或更改最低宿主版本。原有 `importance_origin: manual` 独立存在，两者互不推导。
