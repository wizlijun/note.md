<script lang="ts">
  import '../../../src/styles/ui-foundation.css'
  import { onMount } from 'svelte'
  import { bridge, pluginRequest, type DeletePlan, type SettingsState } from './lib/bridge'

  let ready = $state(false)
  let busy = $state(false)
  let error = $state<string | null>(null)
  let notice = $state<string | null>(null)
  let settings = $state<SettingsState | null>(null)
  let workerUrl = $state('')
  let accessKey = $state('')
  let remoteStatus = $state<unknown>(null)
  let sourceIds = $state('')
  let planId = $state('')
  let plan = $state<DeletePlan | null>(null)
  let confirmation = $state('')
  let deletionResult = $state<unknown>(null)

  function message(value: unknown): string {
    return value instanceof Error ? value.message : String(value)
  }

  async function run<T>(work: () => Promise<T>): Promise<T | undefined> {
    if (busy) return
    busy = true
    error = null
    notice = null
    try { return await work() }
    catch (cause) { error = message(cause) }
    finally { busy = false }
  }

  async function loadSettings() {
    const value = await pluginRequest<SettingsState>('settings.get')
    settings = value
    workerUrl = value.worker_url ?? ''
  }

  async function saveSettings() {
    await run(async () => {
      const value = await pluginRequest<SettingsState>('settings.save', {
        worker_url: workerUrl,
        // Empty means "keep the existing Keychain item". The backend never
        // echoes this value and this field is cleared as soon as the call ends.
        access_key: accessKey,
      })
      accessKey = ''
      settings = value
      notice = '设置已安全保存。访问 key 仅存于系统钥匙串。'
    })
  }

  async function deleteKey() {
    await run(async () => {
      settings = await pluginRequest<SettingsState>('settings.delete_key')
      accessKey = ''
      notice = '访问 key 已从系统钥匙串删除。'
    })
  }

  async function testConnection() {
    await run(async () => {
      const value = await pluginRequest<{ ok: boolean; whoami: unknown }>('connection.test')
      remoteStatus = value.whoami
      notice = 'Worker 身份与连接验证成功。'
    })
  }

  async function syncNow() {
    await run(async () => {
      remoteStatus = await pluginRequest('sync')
      await loadSettings()
      notice = '增量同步完成。'
    })
  }

  async function createPlan() {
    const ids = sourceIds.split(/[\n,]/).map((v) => v.trim()).filter(Boolean)
    await run(async () => {
      plan = await pluginRequest<DeletePlan>('delete.plan.create', { source_ids: ids })
      confirmation = ''
      deletionResult = null
      notice = '删除计划已生成。请核对精确对象与 plan hash。'
    })
  }

  async function loadPlan() {
    const id = planId.trim()
    if (!id) return
    await run(async () => {
      plan = await pluginRequest<DeletePlan>('delete.plan.get', { plan_id: id })
      planId = ''
      confirmation = ''
      deletionResult = null
      notice = '已从 Worker 重新读取该删除计划。请核对精确对象与 plan hash。'
    })
  }

  async function executePlan() {
    if (!plan || confirmation !== 'DELETE') return
    await run(async () => {
      deletionResult = await pluginRequest('delete.plan.execute', {
        plan_id: plan!.id,
        plan_hash: plan!.plan_hash,
        confirmation,
      })
      confirmation = ''
      plan = null
      notice = '删除任务已提交；请根据返回的 job id 查询最终状态。'
    })
  }

  onMount(async () => {
    try {
      void bridge().locale
      await loadSettings()
    } catch (cause) {
      error = message(cause)
    } finally {
      ready = true
    }
  })
</script>

<svelte:head><title>助理邮箱</title></svelte:head>

<main>
  <header>
    <div>
      <h1>助理邮箱</h1>
      <p>连接独立的收信 Worker，并把邮件同步到 note.md 的私有插件数据目录。</p>
    </div>
    <span class:connected={settings?.key_configured} class="badge">
      {settings?.key_configured ? '凭证已配置' : '尚未配置'}
    </span>
  </header>

  {#if error}<div class="banner error" role="alert">{error}</div>{/if}
  {#if notice}<div class="banner success" role="status">{notice}</div>{/if}

  {#if !ready}
    <p class="muted">正在载入…</p>
  {:else}
    <section>
      <h2>Worker 连接</h2>
      <label>
        <span>Worker URL</span>
        <input bind:value={workerUrl} type="url" placeholder="https://assistant-mail.example.workers.dev" disabled={busy} />
      </label>
      <label>
        <span>唯一访问 key</span>
        <input bind:value={accessKey} type="password" autocomplete="new-password"
          placeholder={settings?.key_configured ? '留空以保留现有 key' : '粘贴至少 32 字节的访问 key'} disabled={busy} />
        <small>不会写入普通 settings、Vault、CLI 参数或日志；后端保存到 macOS 钥匙串。</small>
      </label>
      {#if settings?.key_fingerprint}<p class="fingerprint">凭证指纹：<code>{settings.key_fingerprint}</code></p>{/if}
      <div class="actions">
        <button class="primary" onclick={saveSettings} disabled={busy || !workerUrl || (!settings?.key_configured && !accessKey)}>保存设置</button>
        <button onclick={testConnection} disabled={busy || !settings?.key_configured || !settings?.worker_url}>测试连接</button>
        <button class="danger" onclick={deleteKey} disabled={busy || !settings?.key_configured}>撤销本机 key</button>
      </div>
    </section>

    <section>
      <h2>同步状态</h2>
      <dl>
        <div><dt>本地 cursor</dt><dd>{settings?.local_cursor ?? '尚未同步'}</dd></div>
        <div><dt>结构化来源</dt><dd>{settings?.archived_sources ?? 0}</dd></div>
        <div><dt>私有 MIME 原件</dt><dd>{settings?.archived_raw ?? 0}</dd></div>
      </dl>
      <div class="actions">
        <button class="primary" onclick={syncNow} disabled={busy || !settings?.key_configured}>立即同步</button>
      </div>
      {#if remoteStatus}<pre>{JSON.stringify(remoteStatus, null, 2)}</pre>{/if}
    </section>

    <section class="deletion">
      <h2>受控清理与删除</h2>
      <p class="muted">可以加载 Agent 通过 CLI 创建的精确计划，也可以在此按 source id 新建计划；永久删除没有 CLI 快捷路径。</p>
      <label>
        <span>Agent 提供的 Plan ID</span>
        <input bind:value={planId} autocomplete="off" placeholder="粘贴 mail-delete-plan 返回的 plan id" disabled={busy} />
      </label>
      <button onclick={loadPlan} disabled={busy || !planId.trim() || !settings?.key_configured}>回源加载这个计划</button>
      <label>
        <span>Source IDs（每行或逗号分隔）</span>
        <textarea bind:value={sourceIds} rows="3" disabled={busy}></textarea>
      </label>
      <button onclick={createPlan} disabled={busy || !sourceIds.trim() || !settings?.key_configured}>生成删除计划</button>

      {#if plan}
        <div class="plan">
          <h3>请核对精确计划</h3>
          <p>Plan ID：<code>{plan.id}</code></p>
          <p>Plan hash：<code>{plan.plan_hash}</code></p>
          <pre>{JSON.stringify(plan, null, 2)}</pre>
          <label>
            <span>确认无误后输入 <code>DELETE</code></span>
            <input bind:value={confirmation} autocomplete="off" disabled={busy} />
          </label>
          <button class="danger strong" onclick={executePlan} disabled={busy || confirmation !== 'DELETE'}>执行这个精确计划</button>
        </div>
      {/if}
      {#if deletionResult}<pre>{JSON.stringify(deletionResult, null, 2)}</pre>{/if}
    </section>
  {/if}
</main>

<style>
  :global(html) { color-scheme: light dark; background: Canvas; color: CanvasText; }
  :global(body) { margin: 0; font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { box-sizing: border-box; width: 100%; min-height: 100vh; padding: 24px; }
  header { display: flex; justify-content: space-between; align-items: flex-start; gap: 18px; margin-bottom: 18px; }
  h1 { margin: 0 0 5px; font-size: 22px; }
  h2 { margin: 0 0 15px; font-size: 15px; }
  h3 { margin: 0 0 10px; font-size: 14px; }
  p { margin: 0; }
  header p, .muted, small { color: color-mix(in srgb, CanvasText 58%, transparent); }
  section { margin: 0 0 14px; padding: 18px; border: 1px solid color-mix(in srgb, CanvasText 15%, transparent); border-radius: 12px; background: color-mix(in srgb, Canvas 96%, CanvasText 4%); }
  label { display: grid; gap: 7px; margin: 12px 0; }
  label > span { font-weight: 600; }
  input, textarea { box-sizing: border-box; width: 100%; padding: 9px 10px; border: 1px solid color-mix(in srgb, CanvasText 22%, transparent); border-radius: 7px; background: Canvas; color: CanvasText; font: inherit; }
  textarea { resize: vertical; }
  button { padding: 8px 12px; border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); border-radius: 7px; background: color-mix(in srgb, Canvas 92%, CanvasText 8%); color: CanvasText; font: inherit; cursor: pointer; }
  button:disabled { opacity: .45; cursor: default; }
  button.primary { color: white; border-color: #1671d9; background: #1671d9; }
  button.danger { color: #c23b35; }
  button.danger.strong { color: white; border-color: #bd342e; background: #bd342e; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
  .badge { flex: none; padding: 5px 9px; border-radius: 999px; background: color-mix(in srgb, #d38c00 16%, Canvas); color: #a76600; }
  .badge.connected { background: color-mix(in srgb, #1f9d55 16%, Canvas); color: #168147; }
  .banner { margin-bottom: 14px; padding: 10px 12px; border-radius: 8px; }
  .banner.error { background: color-mix(in srgb, #d7372f 15%, Canvas); color: #bc2f28; }
  .banner.success { background: color-mix(in srgb, #168147 14%, Canvas); color: #168147; }
  dl { margin: 0; display: grid; gap: 8px; }
  dl div { display: grid; grid-template-columns: 130px minmax(0, 1fr); gap: 10px; }
  dt { color: color-mix(in srgb, CanvasText 58%, transparent); }
  dd { margin: 0; overflow-wrap: anywhere; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
  pre { max-height: 220px; overflow: auto; padding: 10px; border-radius: 7px; background: color-mix(in srgb, Canvas 82%, CanvasText 18%); font-size: 11px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .fingerprint { margin-top: 8px; color: color-mix(in srgb, CanvasText 66%, transparent); }
  .plan { margin-top: 15px; padding: 14px; border: 1px solid color-mix(in srgb, #d7372f 32%, transparent); border-radius: 9px; }
</style>
