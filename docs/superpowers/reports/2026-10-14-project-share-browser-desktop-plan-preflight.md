# 网页与桌面协作：实施前核对

2026-10-14，ROOT 对[实施计划](../plans/2026-10-14-project-share-browser-desktop-delivery.md)、[交付设计](../specs/2026-10-14-project-share-browser-desktop-delivery-design.md)、[Mermaid 接缝](../specs/2026-10-14-mermaid-loader-design.md)完成核对，按用户持续实施与发行授权开始，不新增审批或worktree。

前置 CORE6a6d0f940383c1e2cd19dc3c9c3df8f63e69baff / HOST产品8a0b555ca6a0e8df226700fc74f67ffa64f3925e，正式受理记录提交3e6c95f1。精确证据见[前置报告](2026-10-14-file-bindings-history-verification.md)。新的实际执行BASE在本计划文档提交后写入本期OWN，不覆盖前置BASE。

## 已核接口与首次消费者

| 接口 | 已有能力 | 本期责任 |
| --- | --- | --- |
| mountFileEditor / owner | raw、bindings、Rich/Source同一history、批注/装饰、原子slash | Task1真实分享外壳/菜单；不另造factory |
| FileAdapters | 显式mediaResolver为运行时必需；当前无mermaidLoader | Task1 M0新增纯loader并传递；桌面独立原renderer，E1源码 |
| createShareFileSession | durable detached回执、baselineIdentity、save/close | Task1复用；Task3宿主唯一FIFO/pending编排；Task4多文件rebase |
| DraftV2 | after唯一正文、editorFiles恢复缓存 | Task4首加previous可选元数据；不复制正文或升级wire |
| 分享内核 | extract/propose/anchor/compose/rebase | 纯builder两端共用；不重写算法 |
| source-only ZIP / Worker | 已确认源/附件包、原生分段上传、R2/KV | E4从已发布reader投影清单、V1→reader→ZIP→V2；不新manifest路由 |
| UI与依赖 | popup/slash的desktop i18n、Tauri附件依赖仍在 | Task1纯runtime/common拆分；Task2实际IIFE图证明，无alias/stub |

已纠正旧候选中“mount未实现”“Task5未提交”“file slash两次dispatch”等事实。未据此把E1 UI、M0、rebase或received误标完成。各Task输出只供后继消费，不在早期提供fake rebase或导入未来文件。

## 规格迁移与代价

- 主spec同步实际raw来源模型、精确保存回执、纯build与唯一提交编排；这些是已批准前置的真实消费合同，不以格式差异过滤替代I7。
- browser主人批注采用原Critic多重集floor；复制同文后删任意occurrence仍满足floor，不能称逐节点身份保护。桌面可编辑但提交前明确提醒。
- 保持source-only ZIP；E4多一次有界reader读取和严格无执行解析，避免增服务/接口或把管理文件重新塞入ZIP。
- M0去除默认Mermaid加载边，SDK用户须显式注入loader恢复自动预览；桌面注入原renderer，旧Kit的false成为实际源码模式。必须有迁移说明和正向回归。
- CORE默认gzip上限104448，share主IIFE900KiB独立；没有批准继续增加。M0/实际IIFE/独立Mermaid预算仍待实施验证。
- 免费Worker旧10ms样本仍不满足严格<10ms；Task8绑定真实部署复测，失败留证并重新规划最小修补，不改门槛或套餐。

`root-delivery-formal-contract-check`已逐字比较原主spec与修订：I1–I14、tokenizer、I7原验收语料/判据、平台能力矩阵、实现者禁令及900KiB上限保持。此为文档静态核对，不是产品测试。

## 执行与发布

单产品writer、每Task独立实现/规格质量审查，最终唯一whole-range审查。全部gate保留实际命令、原始退出与工具生命周期，构建用空env，发布前不读取凭据。仅安装已审计提交的CORE产物，并给出实际installed前驱。

用户明确暂无移动设备，真实iOS Safari/Android Chrome中文/日文IME保留待验，不重复询问，不停下独立实现；原生平台缺证也不改填通过。最新发布顺序为完成实现与必要验证后**先推送部署Worker并核对线上版本，再发布应用**。发布范围继续覆盖全部未发布宿主/插件更新，须盘点main/远端/分支/stash与最新正式tag，核正式产物和线上状态。
