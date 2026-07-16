# Mirror-hosted marks —— 把「同步镜像」提升为产品主张

日期:2026-07-16
状态:设计(已与用户对齐,待评审)

## 背景与痛点

阅读常常发生在 vault 之外——下载目录、外接盘、别的工具的文件夹。用户一旦想批注 / 做笔记,面临两难:

- 写进自己的笔记库 → 和原文脱钩,失去「这条批注是针对那份原文的」。
- 写在原文旁 → 换设备、原文被移动/删除、别的工具改了目录结构时,**路径丢失,笔记找不到原始宿主**。

现状:`sync-to-vault` 已经能把源文件复制进 `{vault}/{syncDir}/` 做镜像,并在 `sotvault-sync.json` 里记录 `vault_path ↔ source_path + hash`。但该记录存在**设备本地 app-support(`~/Library/Application Support/net.notemd.app/sotvault-sync.json`),不进 git**——所以换设备后镜像与源的映射就丢了,这正是痛点根因。

本设计把「镜像」从一个隐性插件功能,**提升为产品哲学主张**,并据此梳理整套逻辑、把映射元信息迁到 git 同步的 `{vault}/.notemd/` 下。

## ① 产品哲学主张(第 4 条信念)

现有三条:AI 文本无限/注意力有限、文件高于应用、Agent 是一等公民。新增:

> **你的批注属于 vault,不属于路径。**
> 阅读发生在任何地方。你一旦落笔批注,这些标记就是你最珍贵的信号,绝不能因为换了设备、移动了文件、路径变了而成为孤儿。所以 note.md 在你批注的那一刻,把源文件**镜像**进 vault:镜像是被 git 版本化的、稳定的宿主,承载你的批注;原文留在原地,note.md 负责让镜像与原文保持一致。你的笔记住在 vault(持久、可同步、可 grep),挂在一个「记得原文从哪来」的镜像上——哪怕原文移动了、你换了机器。

落地:README「The idea」增一条;新增 `docs/product-principle-mirror-hosted-marks.md` 外宣文。

## ② 实体与生命周期

**实体**

- **源文件(source)**:vault 外被阅读的 md,原始、权威内容。
- **镜像(mirror)**:源在 `{vault}/{syncDir}/` 的副本,git 版本化,是批注的稳定宿主。
- **伴生笔记(`.note.md`)**:批注本体,住在镜像旁(vault 内)。
- **镜像 meta**:git 同步的映射记录,`{vault}/.notemd/mirrors/` 下,每镜像一个文件。

**生命周期**

1. 读 vault 外 md → 无镜像,纯被动。
2. **首次批注/做笔记** → 建镜像(复制源 → `{vault}/{syncDir}/`)+ 建伴生笔记 + 写 meta。**每设备各自建**(见 ⑤)。
3. **会话内一致性** → 阅读批注期间,源变则更新镜像内容(笔记不动);冲突走现有 3-way 逻辑。
4. **在 vault 打开镜像** → 跳去编辑**源文件**(源在);源不在 → 直接编辑镜像 + 提示重新关联源(见 ④)。
5. **多设备** → 别的机器读自己本地副本、批注 → 建自己的镜像;同内容多镜像 → 提供**合并笔记**(见 ⑤)。

## ③ `.notemd/mirrors/` 镜像 meta schema(git 同步)

**每镜像一个 meta 文件**,文件名带短 deviceId 区分符,保证两台设备各自建同名镜像时互不覆盖、git 不冲突:

```
{vault}/.notemd/mirrors/{镜像stem}.{deviceId前8位}.json
```

内容:

```json
{
  "mirror": "sync/2026-07-16-foo.md",
  "deviceId": "550e8400-e29b-41d4-a716-446655440000",
  "deviceName": "Bruce-MacBook",
  "source": "/Users/bruce/Downloads/foo.md",
  "syncedAt": "2026-07-16T10:20:30Z",
  "checksum": "sha256:…"
}
```

- `deviceId`:**与 recents / analytics 同一个**——`getDeviceId()`(`src/lib/settings.svelte.ts`,memoized `crypto.randomUUID()`)。
- `deviceName`:hostname(取不到则 `Device-<id8>`),仅显示,沿用 recents/analytics 约定。
- `checksum`:沿用现有 SHA256(比 CRC 强、已实现);「最后同步版本」靠镜像文件自身的 git 历史,meta 只记最后状态。
- 每设备只写自己 deviceId 的 meta 文件 → 跨设备天然无 git 冲突(同 recents `<deviceId>.json` / analytics `<day>.<deviceId>.json` 的每设备分区思路)。
- 镜像 md 文件本身也可带同样的 deviceId 区分符以避免跨设备同名(保持可读:`2026-07-16-foo.<id8>.md`);具体命名细节在实现期定。

**迁移**:现有设备本地 `sotvault-sync.json` 的记录 → 迁进 `.notemd/mirrors/`,盖当前 `getDeviceId()`/hostname;旧文件保留读取一段时间做回退,不删。

## ④ 打开 vault 镜像 → 编辑源

- 打开被追踪的镜像:查 meta,**本设备(deviceId 匹配)的 source 存在 → 直接跳去打开源文件编辑**,镜像退居后台宿主(继续承载笔记、保持一致性)。
- source 不存在(换设备 / 被移动删除)→ **直接编辑镜像本身**(git 同步),顶部提示「重新选择本地源文件」重建关联(更新本设备的 meta)。
- 现有 `SyncOriginBanner` 从「只露源目录」升级为「跳去编辑源 / 重新关联源」。

## ⑤ 多设备:合并笔记

- **每设备各自建镜像**(已确认):B 拉到 vault 见到 A 的镜像+meta,读自己本地副本、批注 → 建 B 自己的镜像(带 B 的 deviceId)。同一份文档因此可能有多个镜像。
- **检测**:多个镜像 `checksum` 相同 = 同一文档的多设备镜像 → 提示「这 N 个是同一份,合并笔记?」。
- **动作**:合并这些镜像的伴生笔记(3-way / 追加);镜像文件保留。**只合并笔记**。
- 两边同时打开同一笔记的**并发编辑 = 留后续**,本设计不含。

## ⑥ 实施分期(每期独立 plan → impl)

1. **哲学 + meta 迁到 `.notemd/mirrors/`**:数据模型基础——per-mirror meta(deviceId/deviceName/source/syncedAt/checksum)+ 从 app-support 迁移 + 外宣文/README。
2. **打开镜像 → 编辑源重定向**:含源不在时的「编辑镜像 + 重新关联」。
3. **会话内镜像↔源一致性**:把现有 open-time check / apply 正式化为「批注期间持续对齐」。
4. **多设备合并笔记**:同 checksum 镜像检测 + 合并 UI。
5. (后续)并发同笔记编辑。

## 不做(YAGNI / 留后续)

- 并发同笔记多端实时编辑。
- 基于内容的跨设备镜像去重/自动复用(已确认走「每设备各自建 + 合并」而非自动 adopt)。
- 用 CRC 取代 SHA256(沿用现有 SHA256)。

## 测试要点(分期各自细化)

- meta 读写/迁移:缺文件、损坏、跨设备多 meta 并存、app-support → `.notemd/` 迁移往返。
- 打开重定向:源在→跳源;源不在→编辑镜像+重关联;deviceId 不匹配的镜像(别的设备建的)在本机的行为。
- 合并检测:同 checksum 多镜像识别;合并笔记 3-way 正确性。
- 一致性:源变→镜像更新;冲突标记。

## 涉及的现有代码(实现期锚点)

- `src-tauri/src/sotvault/store.rs`(Record schema、store 位置)、`mod.rs`(sync/check/apply、`store_path` 在 app-support)、`logic.rs`(3-way note reconcile、dedup/dated 命名)。
- `src-tauri/src/sotvault/vault_settings.rs`(`.notemd/` 读写既有范式,可复用)。
- `src/lib/sotvault.svelte.ts` / `sotvault-logic.ts`、`src/components/SyncOriginBanner.svelte` / `SyncToVaultBanner.svelte`。
- `src/lib/settings.svelte.ts` `getDeviceId()`;recents(`recent-sync.svelte.ts`)、analytics(`insights/store.svelte.ts`)的每设备分区范式作参照。
