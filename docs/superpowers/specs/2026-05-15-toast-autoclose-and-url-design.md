# Toast 自动关闭偏好持久化 & 消息内 URL 可点击

## 背景

`src/components/Toast.svelte` 当前有两个用户报告的体验问题：

1. **"自动关闭" 勾选状态不被记住。** 复选框状态保存在组件本地的
   `autoClose = $state<Record<number, boolean>>({})` 字典里（按 toast id 索引），
   新弹出的 toast 拿不到先前的偏好，每次都回到"未勾选 / 手动关闭"。
2. **toast 消息内的 URL 是纯文本。** 例如分享成功 toast 形如
   `已分享：https://...`（`mdshare/src/publish.rs:156`），用户希望点击链接
   能在浏览器中打开。剪贴板已由插件通过 `Action::ClipboardWrite` 自动写入，
   无需再做复制。

## 目标

- 把"自动关闭"做成持久化的全局偏好，跨 App 重启生效。
- 新 toast 弹出时按这个偏好决定是否在 4 秒后自动关闭。
- 在 toast 主消息区识别 URL 并渲染为可点击元素；点击在系统浏览器打开。

## 非目标

- 不改动 `detail`（`<pre>`）展开区的渲染——继续保留纯文本，避免影响代码/堆栈展示。
- 不引入"通知中心 / 历史"等新功能。
- 不增加新的设置面板入口；复选框继续放在每条 toast 上。

## 设计

### 1. 自动关闭偏好持久化

**Settings 层**（`src/lib/settings.svelte.ts`）

- 在 `settings` 响应式对象上新增字段 `toastAutoClose: boolean`，默认 `false`
  （与现状一致）。
- `loadSettings()` 中读取：`(await s.get<boolean>('toastAutoClose')) ?? false`。
- `saveSettings()` 中写入：`await s.set('toastAutoClose', settings.toastAutoClose)`。

**Toast store 层**（`src/lib/toast.svelte.ts`）

- `pushToast(opts)` 内部计算定时时长改为：

  ```
  const ms = opts.autoDismissMs ?? (settings.toastAutoClose ? 4000 : 0)
  ```

  即：调用方显式传入的 `autoDismissMs` 仍最优先；否则按全局偏好决定。
- 引入常量 `TOAST_AUTO_DISMISS_MS = 4000`（之前散在 `Toast.svelte` 顶部，
  挪到 store 模块统一管理）。

**UI 层**（`src/components/Toast.svelte`）

- 删除组件本地的 `autoClose = $state<Record<number, boolean>>({})`。
- 复选框的 `checked` 直接绑定到 `settings.toastAutoClose`。
- 切换处理函数 `toggleAutoClose()`：
  1. 翻转 `settings.toastAutoClose`
  2. 调用 `saveSettings()` 立即持久化（fire-and-forget，错误吞掉即可——
     设置存储失败不应阻塞 UI）
  3. 遍历当前所有可见 toasts，调用 `scheduleAutoDismiss(id, on ? 4000 : 0)`
     立即生效：
     - 勾上：所有当前 toast 在 4s 后自动关闭
     - 取消：取消所有未触发的关闭定时

  注：因为复选框现在反映全局值，每条 toast 上的复选框显示的是同一个状态，
  这是预期行为。

### 2. Toast 消息中的 URL 可点击

**渲染**（`src/components/Toast.svelte`）

- 引入纯函数 `splitUrls(text: string): Array<{ kind: 'text' | 'url'; value: string }>`：
  - 用正则 `/(https?:\/\/[^\s]+)/g` 切分输入字符串。
  - 末尾尾随的中文/英文标点（`，。；：）] 》)` 等）从 URL 段裁回到文本段，
    避免把标点也包进链接。具体实现：URL 段尾部用
    `/[)\]，。；：！？)>'"」』]+$/` 剥离。
- 在模板里，原先的 `<span class="msg">{t.message}</span>` 替换为：

  ```
  <span class="msg">
    {#each splitUrls(t.message) as seg}
      {#if seg.kind === 'url'}
        <button type="button" class="link" onclick={() => openLink(seg.value)}>{seg.value}</button>
      {:else}
        {seg.value}
      {/if}
    {/each}
  </span>
  ```

- `openLink(url)` 异步打开浏览器：

  ```
  async function openLink(url: string) {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(url)
  }
  ```

  与 `App.svelte:337` 的现有用法一致。

**样式**

- `.link` 按链接外观：继承字体大小、颜色用 `LinkText` / `#3584e4`、下划线、
  无背景、无 border、鼠标 `cursor: pointer`、悬浮加深；保证不破坏行内布局。

## 验证

手动验证清单：

1. 启动 App，触发任意 toast（例如插件触发一个 info toast），勾上"自动关闭"。
   重启 App，再触发 toast — 期望默认就勾上且 4 秒后自动关闭。
2. 在"自动关闭"未勾的状态下连开几条 toast，勾一次复选框 → 所有可见 toast
   都在 4s 内消失。
3. 已勾选的状态下取消勾选 → 所有可见 toast 不再自动关闭。
4. 触发一次分享：toast 文案中的 URL 显示为链接样式，点击后系统浏览器打开
   对应页面；旁边的中文冒号/句号没有被吸到链接里。
5. 普通无 URL 的 toast（例如 "已复制" / 错误提示）渲染保持原样。

自动化测试：

- `src/lib/toast.test.ts` 增加用例：当 `settings.toastAutoClose = true` 且
  `pushToast` 不传 `autoDismissMs` 时，定时器在 4000ms 后触发
  `dismissToast`。（用 `vi.useFakeTimers` 推进时间。）
- 新增 `splitUrls` 的纯函数单测（覆盖：纯文本 / 单 URL / 多 URL / URL 后跟
  中英文标点 / URL 在开头或结尾）。

## 风险与权衡

- **全局复选框 vs per-toast 复选框：** 当前 UI 把复选框放在每条 toast 上，
  改成全局值后，多条 toast 的复选框联动显示同一个状态。这是该方案的固有
  行为，不影响功能正确性。
- **URL 正则的边界情况：** `https?://[^\s]+` 简单可靠；尾随标点用单独的
  剥离正则解决。不支持 `www.xxx` 这类无 scheme 的 URL（toast 实际产文文案
  里目前都是 `https://`，无需要 over-engineer）。
- **`saveSettings()` 异步失败：** 与项目内其他 toggle 一致，不做特殊处理；
  设置存储底层失败的概率极低。
