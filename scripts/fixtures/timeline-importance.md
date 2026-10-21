---
type: Timeline
title: 2026-10-21 Timeline
description: 合成验收日程，重要程度与活动分类相互独立。
sources:
- id: s01
  resource: /notes/example.md
  title: 合成证据
event_metadata:
  meeting:
    importance: high
    reason: 决定调整交付日期。
    evidence:
    - source: s01
      locator: L12-L18
    signals:
      source_chars: 90
      duration_minutes: 45
      owner_relation: direct
  routine:
    importance: normal
    reason: 逐项完成例行检查，无新决定。
    evidence:
    - source: s01
      locator: L12-L18
    signals:
      source_chars: 600
      duration_minutes: 10
      owner_relation: direct
    anomaly:
      status: none
      reason: 已核对原文，未发现反常。
      evidence: []
  pending:
    importance: unknown
    reason: 尚未核对本人是否参与。
    evidence: []
    signals:
      source_chars: null
      duration_minutes: null
      owner_relation: unknown
    anomaly:
      status: unknown
      reason: 缺少个人常态基线，不能判断偏离。
      evidence: []
  fault:
    importance: normal
    reason: 短暂故障恢复，未改变后续安排。
    evidence:
    - source: s01
      locator: L12-L18
    signals:
      source_chars: 40
      duration_minutes: null
      owner_relation: direct
    anomaly:
      status: flagged
      reason: 原文明确记载了故障或计划中断。
      evidence:
      - source: s01
        locator: L16-L18
  visit:
    importance: high
    reason: 一次值得记住的探访。
    evidence:
    - source: s01
      locator: L12-L18
    signals:
      source_chars: 30
      duration_minutes: 30
      owner_relation: direct
    anomaly:
      status: none
      reason: 已核对原文，未发现反常。
      evidence: []
  instant:
    importance: high
    reason: 收到影响安排的紧急通知。
    evidence:
    - source: s01
      locator: L12-L18
    signals:
      source_chars: 18
      duration_minutes: null
      owner_relation: direct
    anomaly:
      status: flagged
      reason: 原文明确记载了故障或计划中断。
      evidence:
      - source: s01
        locator: L16-L18
---
# 2026-10-21 Timeline

所有事件与证据均为合成测试数据。首末证据跨度不代表持续投入。

- 09:00–10:00 — 会议：确认交付安排。 [合成证据](../notes/example.md#L12) <!-- event:meeting -->
  - 09:10–09:20 — 核查：重复核查清单。 <!-- event:routine -->
  - 09:25–09:30 — 沟通：本人参与情况仍需核对。 <!-- event:pending -->
- 09:05–09:05 — 开发：短暂测试故障已恢复。 <!-- event:fault -->
- 09:40–10:10 — 家庭：探访家人。 <!-- event:visit -->
- 10:15–10:15 — 沟通：收到临时变更通知。 <!-- event:instant -->
