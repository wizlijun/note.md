# Agency 日期范围与 CLI

日期范围按现有会话区间匹配规则，包含开始和结束日期。严格 YYYY-MM-DD，真实日历日期，开始不晚于结束，最多31天。UI 默认截至昨天的最近7天，报告浏览日期与生成范围独立。

同一Vault仅允许一个本机队列，持有整段运行锁；每一天串行调用既有观测逻辑，独立校验并原子发布。空来源 skipped，相同来源/规则/provider reused，普通错误 failed 后继续；模型状态失联/超时取消剩余，避免不确定的并行。所有日期状态持久保存于 job.json，退出后可以重跑范围并自动复用已完成日期。无跨设备锁或跨日去重效果声称。

Job增加start_date/end_date/items/stop_requested并兼容旧文件。条目状态 pending/running/done/reused/skipped/failed/cancelled；总状态 running/done/partial/failed/cancelled。停止请求仅在当前日期结束后生效，不中断正在运行的Agent。UI展示每一天状态，可点日期查看报告，队列中仍允许浏览。

CLI新增 run --date 或 run --from --to，--agent codex|claude|deepseek；status查询最近队列；stop请求完成当前后停止。启动必须确认后台已获得锁并持久化任务才返回。后台运行使用插件自身原生可执行文件，独立会话存活，复用同一队列与选中provider的input-only任务协议；不依赖CLI临时宿主持续存活，不引入普通有工具执行回退。运行状态和结果仍在Vault目录，不自动调整cron。

验证：日期/月年/闰日/上限、混合结果、旧回执、重复启动、停止边界；前端输入/进度/恢复；实际CLI入口返回后后台仍在运行，终态可查，缓存/空来源不产生模型调用；完整Rust/frontend/check/build及本机UI验证。
