# pos-log 插件设计 — 位置记录（notemd.pos-log）

日期：2026-07-18 · 状态：设计已确认（用户拍板三决策：跨天写基线 / 任一段变化即追加 / 列表项行格式）
前置：插件体系 v2（spec `2026-07-16-plugin-system-v2-design.md`），实现于 worktree `core-ize-six-plugins` 分支。

## 1. 目标

后台记录用户所在位置到 vault。每 30 分钟取一次 macOS 定位（CoreLocation），反查地名，
地址变化时向 `pos/YYYY-MM-DD-pos.md` 追加一行 `- YYYY-MM-DD HH:mm 国家-省份-城市 POI`
（本地时间）。系统定位权限在插件启动激活时申请。

## 2. 形态

v2 **native 后台插件**，无 UI、无菜单、无 CLI（`contributes` 为空）。

- `activation.events: ["onStartupFinished"]` — app 启动完成即激活。
- **省略 `idle_shutdown_seconds`**（`Option::None` = 永不空闲关停，运行时既有语义）——常驻进程。
- 否决的备选：
  - core 功能：用户明确要插件；位置是敏感可选功能，插件的安装+能力同意模型正合适。
  - 外部 CoreLocationCLI / shortcuts：引入外部依赖，打包与授权链路更脆。

## 3. 权限（启动时申请）

- 插件进程由 note.md spawn，TCC 归因到**宿主 app**（responsible process）：系统弹窗显示
  "note.md 想使用你的位置"。
- **宿主改动（仅此一处）**：`src-tauri/Info.plist` 增加 `NSLocationUsageDescription`
  （文案说明用于 pos-log 插件的位置记录）。
- 激活时即创建 `CLLocationManager` 并调 `requestWhenInUseAuthorization()` → 首次触发弹窗。
- 授权被拒 / 受限：每轮静默跳过（`host.log.warn`），仅**首次**发一条 toast 提示去系统设置开启；
  不反复骚扰。
- ⚠️ 风险注：个别 macOS 版本可能把 TCC 归因到裸二进制（无 bundle 则弹窗不出现）。
  dev 构建实测验证；若归因失败，fallback = CoreLocation 挪进宿主、新增 `host.location.get`
  （capability `location`），插件退化为格式化+写盘。本 spec 按主路径设计，fallback 只记不设计。

## 4. 取位循环

激活立即执行一轮，此后每 30 分钟一轮（固定值，不做配置——YAGNI）：

1. 取位（**实现修订**）：`startUpdatingLocation` → 轮询 `.location`（新鲜度 5 分钟内）
   → `stopUpdatingLocation`，几秒内短启停。原设计的 `requestLocation` 必须实现
   delegate 类（objc2 `define_class!`）；短启停轮询行为等价、免掉整个 delegate。
2. `CLGeocoder.reverseGeocodeLocation`（系统 locale——中文系统得中文地名）。
3. 从 `CLPlacemark` 取：`country` / `administrativeArea`（省）/ `locality`（市）/
   POI = `areasOfInterest[0]` 否则 `name`。
4. 线程（**实现修订**）：CoreLocation 服务必须占用**主线程** run loop——
   `CLGeocoder` 完成块落主 dispatch 队列，只有主线程 run loop（NSRunLoop 泵）会
   排干它。于是 SDK serve 循环挪到副线程的 tokio runtime；两侧用
   std mpsc（FetchJob）+ tokio oneshot（应答）交接。

## 5. 文件格式与写盘协议

- 路径：vault 相对 `pos/YYYY-MM-DD-pos.md`（文件名取**本地日期**）。
- 行格式：`- YYYY-MM-DD HH:mm 国家-省份-城市 POI`
  - 本地时间（chrono `Local`），分钟精度。
  - 地名段用 `-` 连接；**空段省略**，连字符只连非空段（如无省份：`中国-武汉 POI`）。
  - POI 与前缀之间单空格；POI 为空则整行只有地名段。
- 变化判定：取当天文件**最后一行**，去掉 `- YYYY-MM-DD HH:mm ` 前缀后与新地址串比较；
  **任一字符不同即追加**（含 POI 抖动——30 分钟粒度可接受）。
- 跨天基线：当天文件不存在 → 无条件写第一行（即使与昨天最后一条相同）。
- 跨重启：状态不落额外文件，从当天文件最后一行恢复；无文件即视为需要基线。
- 写入通道：`host.vault.exists` → `host.vault.read` → 内存追加 → `host.vault.write`
  整写（read-modify-write；单写者，无并发竞争）。**实现修订**：不调
  `host.vault.mkdir`——`vault_write` 本就创建父目录。
- 文件是纯 `.md` 不是 `.note.md`——不进关系图（符合"关系只在人确认处生长"）。

## 6. manifest（plugins-src/pos-log/manifest.v2.json）

```json
{
  "manifest_version": 2,
  "id": "notemd.pos-log",
  "name": "Position Log",
  "version": "1.0.0",
  "kind": "native",
  "engines": { "notemd": ">=6.716.7" },
  "description": "Log your location to the vault: appends country-province-city + POI to pos/YYYY-MM-DD-pos.md whenever the address changes (every 30 min)",
  "binary": {
    "aarch64-apple-darwin": "bin/notemd-pos-log",
    "x86_64-apple-darwin": "bin/notemd-pos-log"
  },
  "activation": { "events": ["onStartupFinished"] },
  "capabilities": ["vault.read", "vault.write", "toast"],
  "request_timeout_seconds": 30
}
```

注：`request_timeout_seconds` 只约束宿主→插件请求；后台任务不受它限制。

## 7. 代码布局

```
plugins-src/pos-log/
  manifest.v2.json
  backend/
    Cargo.toml            # bin notemd-pos-log；deps: notemd-plugin-sdk, tokio, chrono, objc2*
    src/
      main.rs             # SDK serve；activate 时 spawn 循环 task；deactivate 停止退出
      location.rs         # LocationProvider trait + CoreLocation 实现（专用线程+CFRunLoop）
      logbook.rs          # 纯函数：行格式化 / 变化判定 / 空段省略 / 文件名推导
```

- `LocationProvider` trait（`fn fetch() -> Result<Place, String>`）隔离 objc 层，测试注入假实现。
- `logbook.rs` 不含 IO，全部可单测。
- 循环 task 里的 vault IO 走 SDK `Host::request`（serve 循环路由应答给后台任务）。

## 7b. 运行时前置：host.vault.* 接入进程通道（实现时补齐）

spec 初稿误以为 vault 方法在进程 stdio 通道上已可用；实际此前只在 UI fetch-RPC
桥实现，进程 sink 一律回 -32601。随本插件落地的运行时扩展：

- `host_api::make_sink` 增加第 6 参 `services: Option<Arc<dyn HostServices>>`；
  `Some` 时 vault.info/read/write/exists/list/mkdir 直接复用 ui_rpc 的函数体，
  能力门（`vault.read`/`vault.write`）不变；`None`（测试默认）保持 -32601。
- `make_sink_for_app` 用 `TauriServices::new(app)` 注入生产实现。
- dialog / fs.read / clipboard 仍是 UI 桥专属——进程通道继续 -32601（进程插件
  不得在宿主线程弹对话框）。

## 8. 错误处理

| 情形 | 行为 |
| --- | --- |
| 权限未授予/被拒 | 本轮跳过；首次 toast，此后仅 log.warn |
| 定位失败（超时/无信号） | 本轮跳过，log.warn |
| 反查失败（无网络等） | 本轮跳过，log.warn；**不写坐标兜底行**（要的是地名） |
| vault 未配置（vault.info 报错） | 本轮跳过；首次 log.warn，vault 配好后自然恢复 |
| vault 写失败 | log.error，下轮重试（幂等：读-比-写） |

## 9. 发布线改动

- `scripts/dev-install-plugin.sh`：加 `pos-log` case（current-arch backend 构建 + bin/ + manifest）。
- `scripts/release-plugins.sh`：现有 `release_native_ui` 假定有 `ui/`；新增 **bin-only** 变体
  （`release_native_bin`，形状同 md2pdf：双架构 cargo + Developer ID codesign + per-arch zip，
  布局 `manifest.json + bin/notemd-pos-log`），挂 `pos-log` case。
- 市场发布：打包→minisign→R2 上传→index 重生成→KV 更新（既有流程）。
- 宿主：`src-tauri/Info.plist` 加 `NSLocationUsageDescription`（随 worktree 分支走）。

## 10. 测试

- `logbook` 单测：行格式化（含空段省略/POI 缺失）、变化判定（前缀剥离/任一段变化/相同跳过）、
  跨天文件名、基线判定。
- 循环集成测：假 `LocationProvider` + 内存 Host 管道，验证 首轮基线 / 变化追加 / 无变化跳过 /
  vault 错误跳过。
- 真机（dev GUI 验证，用户执行）：权限弹窗归因、真实定位反查、30 分钟不被空闲关停、
  文件落 vault。

## 11. 非目标（YAGNI）

- 不做设置界面 / 间隔配置 / 历史回填 / 轨迹可视化。
- 不写经纬度坐标（只写地名行）。
- 不做 iOS（vault.svelte.ts 侧无插件运行时）。
- 不做**常驻**定位订阅——每轮几秒内的短启停轮询不算；30 分钟一次足够且省电。
