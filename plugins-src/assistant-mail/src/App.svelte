<script lang="ts">
  import '../../../src/styles/ui-foundation.css'
  import { onMount } from 'svelte'
  import {
    bridge,
    pluginRequest,
    type DeletePlan,
    type IntakePolicy,
    type MailListItem,
    type MailPreview,
    type SettingsState,
  } from './lib/bridge'

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
  let intakePolicy = $state<IntakePolicy | null>(null)
  let allowedSender = $state('')
  let senderFilterEnabled = $state(false)
  let messages = $state<MailListItem[]>([])
  let selectedSourceId = $state<string | null>(null)
  let preview = $state<MailPreview | null>(null)

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
    workerUrl = value.worker_url ?? 'https://mail.5000g.com'
  }

  async function loadPolicy() {
    intakePolicy = await pluginRequest<IntakePolicy>('intake.policy.get')
    allowedSender = intakePolicy.allowed_sender ?? ''
    senderFilterEnabled = intakePolicy.sender_filter_enabled
  }

  async function savePolicy() {
    await run(async () => {
      intakePolicy = await pluginRequest<IntakePolicy>('intake.policy.save', {
        sender_filter_enabled: senderFilterEnabled,
        allowed_sender: allowedSender,
      })
      allowedSender = intakePolicy.allowed_sender ?? ''
      senderFilterEnabled = intakePolicy.sender_filter_enabled
      notice = senderFilterEnabled
        ? `严格收件已启用：只接受 ${allowedSender}。`
        : `验证期开放收件已启用，将于 ${intakePolicy.setup_expires_at || '一小时后'} 自动恢复严格过滤。`
    })
  }

  async function refreshInbox() {
    const value = await pluginRequest<{ messages: MailListItem[] }>('messages.list')
    messages = value.messages
    if (selectedSourceId && !messages.some((mail) => mail.source_id === selectedSourceId)) {
      selectedSourceId = null
      preview = null
    }
  }

  async function selectMessage(sourceId: string) {
    await run(async () => {
      selectedSourceId = sourceId
      preview = null
      const next = await pluginRequest<MailPreview>('messages.preview', { source_id: sourceId })
      if (selectedSourceId === sourceId && next.source_id === sourceId) preview = next
    })
  }

  async function saveSettings() {
    await run(async () => {
      const value = await pluginRequest<SettingsState>('settings.save', {
        worker_url: workerUrl,
        // Empty means "keep the existing Vault key file". The backend never
        // echoes this value and this field is cleared as soon as the call ends.
        access_key: accessKey,
      })
      accessKey = ''
      settings = value
      notice = `设置已保存。访问 key 位于 Vault 的 ${value.credential_path}。`
      await loadPolicy()
    })
  }

  async function deleteKey() {
    await run(async () => {
      settings = await pluginRequest<SettingsState>('settings.delete_key')
      accessKey = ''
      notice = '访问 key 已从当前 Vault 删除。'
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
      await refreshInbox()
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
      if (settings?.key_configured && settings.worker_url) {
        await loadPolicy()
        await refreshInbox()
      }
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
        <small>保存在当前 Vault 的 <code>{settings?.credential_path || '.notemd/assistant-mail/.local/access-key'}</code>，不会进入普通 settings、CLI 参数或日志。</small>
      </label>
      {#if settings && !settings.vault_configured}
        <div class="banner warning" role="alert">尚未配置 Vault，无法保存或读取访问 key。</div>
      {:else}
        <p class="muted">该文件为明文；插件会设置 0600 权限，并用同目录 .gitignore 防止 Git 误提交，但同一系统用户下的 Agent 或进程仍可能读取。</p>
      {/if}
      {#if settings?.key_fingerprint}<p class="fingerprint">凭证指纹：<code>{settings.key_fingerprint}</code></p>{/if}
      <div class="actions">
        <button class="primary" onclick={saveSettings} disabled={busy || !settings?.vault_configured || !workerUrl || (!settings?.key_configured && !accessKey)}>保存设置</button>
        <button onclick={testConnection} disabled={busy || !settings?.key_configured || !settings?.worker_url}>测试连接</button>
        <button class="danger" onclick={deleteKey} disabled={busy || !settings?.key_configured}>删除当前 Vault 的 key</button>
      </div>
    </section>

    <section>
      <div class="section-heading">
        <div>
          <h2>收件规则</h2>
          <p class="muted">首次配置 Gmail 转发时先关闭严格过滤，以接收系统验证邮件；确认完成后再启用。</p>
        </div>
        <span class:open={intakePolicy !== null && !senderFilterEnabled} class="policy-badge">
          {intakePolicy === null ? '尚未连接' : senderFilterEnabled ? '严格过滤' : '验证期开放'}
        </span>
      </div>
      {#if intakePolicy !== null && !senderFilterEnabled}
        <div class="banner warning" role="status">
          当前会接收所有投递到专用地址的邮件。收件地址校验仍始终开启；此模式将在
          {intakePolicy?.setup_expires_at || '一小时后'} 自动恢复严格过滤。
        </div>
      {/if}
      <label>
        <span>允许的 SMTP envelope sender</span>
        <input bind:value={allowedSender} type="email" placeholder="name@gmail.com" disabled={busy} />
      </label>
      <label class="toggle-row">
        <input bind:checked={senderFilterEnabled} type="checkbox" disabled={busy} />
        <span>只接收上面这个邮箱转发来的邮件</span>
      </label>
      <div class="actions">
        <button class="primary" onclick={savePolicy}
          disabled={busy || !settings?.key_configured || !settings?.worker_url || (senderFilterEnabled && !allowedSender.trim())}>
          保存收件规则
        </button>
      </div>
      {#if intakePolicy?.updated_at}<p class="fingerprint">规则更新时间：{intakePolicy.updated_at}</p>{/if}
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

    <section>
      <div class="section-heading">
        <div>
          <h2>所有邮件</h2>
          <p class="muted">显示已同步到本机私有目录的邮件；内容按纯文本预览，不执行 HTML、图片或邮件内指令。</p>
        </div>
        <button onclick={() => run(refreshInbox)} disabled={busy}>刷新列表</button>
      </div>
      {#if messages.length === 0}
        <p class="empty">尚无本地邮件。验证邮件到达后点击“立即同步”。</p>
      {:else}
        <div class="mail-browser">
          <div class="mail-list" aria-label="邮件列表">
            {#each messages as mail (mail.source_id)}
              <button class="mail-row" class:selected={selectedSourceId === mail.source_id}
                onclick={() => selectMessage(mail.source_id)} disabled={busy}>
                <strong>{mail.subject || '（无主题）'}</strong>
                <span>SMTP 转发来源：{mail.envelope_from || '未知'}</span>
                <span>邮件声明 From：{mail.claimed_from || '未知'}</span>
                <small>{mail.received_at || '时间未知'} · {mail.raw_available ? '可预览' : '处理中'}</small>
              </button>
            {/each}
          </div>
          <article class="mail-preview" aria-live="polite">
            {#if preview}
              <h3>{preview.subject || '（无主题）'}</h3>
              <dl class="mail-meta">
                <div><dt>SMTP 转发来源</dt><dd>{preview.envelope_from || '未知'}</dd></div>
                <div><dt>邮件声明 From</dt><dd>{preview.claimed_from || '未知'}</dd></div>
                <div><dt>收件人</dt><dd>{preview.to || '未知'}</dd></div>
                <div><dt>日期</dt><dd>{preview.date || '未知'}</dd></div>
              </dl>
              <div class="banner warning">邮件内容不可信；以下仅为转义后的纯文本。</div>
              <pre class="body-preview">{preview.body_text}</pre>
              {#if preview.links.length > 0}
                <h3>邮件中的链接</h3>
                <ul class="links">
                  {#each preview.links as link}<li><code>{link}</code></li>{/each}
                </ul>
              {/if}
            {:else}
              <p class="empty">选择一封邮件查看纯文本内容。</p>
            {/if}
          </article>
        </div>
      {/if}
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
  .section-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 14px; margin-bottom: 14px; }
  .section-heading h2 { margin-bottom: 5px; }
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
  .banner.warning { background: color-mix(in srgb, #d38c00 14%, Canvas); color: color-mix(in srgb, #b06f00 88%, CanvasText); }
  dl { margin: 0; display: grid; gap: 8px; }
  dl div { display: grid; grid-template-columns: 130px minmax(0, 1fr); gap: 10px; }
  dt { color: color-mix(in srgb, CanvasText 58%, transparent); }
  dd { margin: 0; overflow-wrap: anywhere; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
  pre { max-height: 220px; overflow: auto; padding: 10px; border-radius: 7px; background: color-mix(in srgb, Canvas 82%, CanvasText 18%); font-size: 11px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .fingerprint { margin-top: 8px; color: color-mix(in srgb, CanvasText 66%, transparent); }
  .plan { margin-top: 15px; padding: 14px; border: 1px solid color-mix(in srgb, #d7372f 32%, transparent); border-radius: 9px; }
  .policy-badge { flex: none; padding: 5px 9px; border-radius: 999px; background: color-mix(in srgb, #1f9d55 16%, Canvas); color: #168147; }
  .policy-badge.open { background: color-mix(in srgb, #d38c00 18%, Canvas); color: #a76600; }
  .toggle-row { display: flex; align-items: center; gap: 9px; }
  .toggle-row input { width: auto; }
  .mail-browser { display: grid; grid-template-columns: minmax(230px, .8fr) minmax(0, 1.6fr); min-height: 320px; border: 1px solid color-mix(in srgb, CanvasText 14%, transparent); border-radius: 9px; overflow: hidden; }
  .mail-list { max-height: 520px; overflow: auto; border-right: 1px solid color-mix(in srgb, CanvasText 14%, transparent); }
  button.mail-row { display: grid; width: 100%; gap: 4px; padding: 11px 12px; border: 0; border-bottom: 1px solid color-mix(in srgb, CanvasText 10%, transparent); border-radius: 0; background: transparent; text-align: left; }
  button.mail-row:hover, button.mail-row.selected { background: color-mix(in srgb, #1671d9 13%, Canvas); }
  .mail-row strong, .mail-row span, .mail-row small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mail-row small, .empty { color: color-mix(in srgb, CanvasText 58%, transparent); }
  .mail-preview { min-width: 0; padding: 16px; }
  .mail-meta { margin-bottom: 14px; }
  .body-preview { max-height: 360px; background: Canvas; font-size: 12px; }
  .links { margin: 8px 0 0; padding-left: 20px; }
  .links li { margin: 5px 0; overflow-wrap: anywhere; }
  @media (max-width: 720px) {
    main { padding: 14px; }
    .mail-browser { grid-template-columns: 1fr; }
    .mail-list { max-height: 260px; border-right: 0; border-bottom: 1px solid color-mix(in srgb, CanvasText 14%, transparent); }
  }
</style>
