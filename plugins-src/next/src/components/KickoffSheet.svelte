<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import type { KickoffAnswer } from '../lib/kickoff/document'
  import type { KickoffResult } from '../lib/kickoff/client'
  import { isWebSource, safeVaultSource } from '../lib/kickoff/source'
  import { formatElapsed } from '../lib/kickoff/status'
  import { t, type MessageKey } from '../lib/strings'

  let { title, result, stale = false, saving = false, error = '', onSave, onRegenerate, onOpen, onClose, returnFocus }: {
    title: string
    result: KickoffResult
    stale?: boolean
    saving?: boolean
    error?: string
    onSave(answers: KickoffAnswer[], place: boolean): Promise<void>
    onRegenerate(): void
    onOpen(path: string): void
    returnFocus?: HTMLElement | null
    onClose(): void
  } = $props()

  const payload = $derived(result.doc.kickoff.payload)
  const saved = untrack(() => result.doc.kickoff.answers)
  let selected = $state<Record<string, string>>(Object.fromEntries(saved.map((answer) => [answer.question_id, answer.option_id ?? 'other'])))
  let freeText = $state<Record<string, string>>(Object.fromEntries(saved.filter((answer) => answer.option_id === null).map((answer) => [answer.question_id, answer.answer])))
  let dialog: HTMLDivElement
  const answered = $derived(payload.questions.some((question) => selected[question.id] === 'other'
    ? Boolean(freeText[question.id]?.trim())
    : question.options.some((option) => option.id === selected[question.id])))
  const generated = $derived(String((result.doc.metadata.generated as { at?: string } | undefined)?.at ?? result.doc.metadata.created ?? ''))
  const generatedTime = $derived(generated && Number.isFinite(Date.parse(generated)) ? new Date(generated).toLocaleString() : '')

  function answers(): KickoffAnswer[] {
    return payload.questions.flatMap((question) => {
      const option = question.options.find((option) => option.id === selected[question.id])
      const answer = selected[question.id] === 'other' ? freeText[question.id]?.trim() : option?.label
      if (!answer) return []
      return [{ question_id: question.id, question: question.text, decides: question.decides,
        option_id: selected[question.id] === 'other' ? null : option!.id,
        answer, by: 'human:owner', at: new Date().toISOString() }]
    })
  }

  onMount(() => {
    const previous = returnFocus?.isConnected ? returnFocus
      : document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.focus()
    return () => previous?.focus()
  })

  function keydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && !saving) onClose()
    if (event.key !== 'Tab') return
    const fields = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)')]
    const first = fields[0]
    const last = fields.at(-1)
    if (!first || !last) return
    if (!fields.includes(document.activeElement as HTMLElement) || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
      event.preventDefault()
      ;(event.shiftKey ? last : first).focus()
    }
  }
</script>

{#snippet sourceBadges(ids: string[])}
  {#each ids as id}
    {@const source = payload.sources.find((source) => source.id === id)}
    {#if source}
      {@const web = isWebSource(source.resource)}
      <button type="button" class="source" data-source={id} title={`${source.title} · ${source.resource} · ${source.locator}`}
        disabled={!web && !safeVaultSource(source.resource)}
        aria-label={t('kickoff.source', { title: `${source.title} · ${source.resource}` })} onclick={() => onOpen(source.resource)}>[{id}]{#if web} {new URL(source.resource).host}{/if}</button>
    {/if}
  {/each}
{/snippet}

<svelte:window onkeydown={keydown} />
<div class="scrim" role="presentation" onclick={(event) => event.target === event.currentTarget && !saving && onClose()}>
  <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="kickoff-result-title" tabindex="-1" bind:this={dialog}>
    <header>
      <h2 id="kickoff-result-title">{title}</h2>
      <p>✦ {result.doc.kickoff.harness}{result.doc.kickoff.model ? ` · ${result.doc.kickoff.model}` : ''} · {t('kickoff.duration', { time: formatElapsed(result.doc.kickoff.duration_seconds * 1000) })}{generatedTime ? ` · ${t('kickoff.generated', { time: generatedTime })}` : ''}</p>
    </header>
    {#if stale}<div class="banner">{t('kickoff.staleBanner')} <button disabled={saving} onclick={onRegenerate}>{t('kickoff.regenerate')}</button></div>{/if}
    <section><h3>✦ {t('kickoff.summary')}</h3><p>✦ {payload.summary}</p></section>
    <section>
      <h3>✦ {t('kickoff.questions')}</h3>
      {#each payload.questions as question}
        {@const selectedOption = question.options.find((option) => option.id === selected[question.id])}
        {@const answerText = selected[question.id] === 'other' ? freeText[question.id]?.trim() : selectedOption?.label}
        <fieldset disabled={saving}>
          <legend>✦ {question.text}</legend>
          <p class="muted">{t('kickoff.decides', { field: t(`kickoff.field.${question.decides}` as MessageKey) })}</p>
          {#each question.options as option}
            <div class="option">
              <label><input type="radio" name={`kickoff-${question.id}`} value={option.id} bind:group={selected[question.id]} />
                <span>✦ {option.label} {#if option.recommended}<small class="badge">{t('kickoff.recommended')}</small>{/if}</span>
              </label>
              {#if option.why}<p class="why">✦ {option.why}</p>{/if}
              {@render sourceBadges(option.source_ids)}
            </div>
          {/each}
          {#if question.allow_free_text}
            <label><input type="radio" name={`kickoff-${question.id}`} value="other" bind:group={selected[question.id]} /><span>● {t('kickoff.other')}</span></label>
            <input class="free-text" data-free-text={question.id} aria-label={`${t('kickoff.other')}：${question.text}`}
              value={freeText[question.id] ?? ''} oninput={(event) => { freeText[question.id] = event.currentTarget.value; selected[question.id] = 'other' }} />
          {/if}
          {#if answerText}<p class="human">● {answerText}</p>{/if}
        </fieldset>
      {/each}
    </section>
    <section><h3>✦ {t('kickoff.context')}</h3>
      {#each payload.context as context}
        <p>✦ {context.claim} {#if context.kind === 'inference'}<small class="badge">{t('kickoff.inference')}</small>{/if} {#if context.unverified}<small class="badge">{t('kickoff.unverified')}</small>{/if} {@render sourceBadges(context.source_ids)}</p>
      {/each}
    </section>
    <section><h3>✦ {t('kickoff.suggestions')}</h3>
      <dl>
        <dt>{t('kickoff.field.next_action')}</dt><dd>✦ {payload.suggestions.next_action}</dd>
        <dt>{t('kickoff.field.close_condition')}</dt><dd>✦ {payload.suggestions.close_condition}</dd>
        {#if payload.suggestions.commitment}<dt>{t('kickoff.field.commitment')}</dt><dd>✦ {payload.suggestions.commitment}</dd>{/if}
        {#if payload.suggestions.blockers.length}<dt>{t('kickoff.blockers')}</dt><dd>{#each payload.suggestions.blockers as blocker}<p>✦ {blocker}</p>{/each}</dd>{/if}
        {#if payload.suggestions.waiting_for.length}<dt>{t('kickoff.waiting')}</dt><dd>{#each payload.suggestions.waiting_for as person}<p>✦ {person}</p>{/each}</dd>{/if}
      </dl>
    </section>
    <section><h3>✦ {t('kickoff.gaps')}</h3>{#each payload.gaps as gap}<p>✦ {gap}</p>{/each}</section>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <footer>
      <button type="button" class="primary" data-kickoff-place disabled={saving || !answered} onclick={() => void onSave(answers(), true)}>{t('kickoff.place')}</button>
      <button type="button" disabled={saving || !answered} onclick={() => void onSave(answers(), false)}>{t('kickoff.save')}</button>
      <button type="button" disabled={saving} onclick={onRegenerate}>{t('kickoff.regenerate')}</button>
      <button type="button" disabled={saving} onclick={() => onOpen(result.path)}>{t('common.open')}</button>
      <button type="button" disabled={saving} onclick={onClose}>{t('common.close')}</button>
    </footer>
  </div>
</div>

<style>
  .scrim { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; padding: 20px; background: #0005; }
  .sheet { width: min(720px, 100%); max-height: calc(100vh - 40px); overflow-y: auto; padding: 24px; box-sizing: border-box; border: 1px solid var(--line); border-radius: 18px; background: var(--sheet); color: var(--fg); box-shadow: 0 24px 80px #0004; }
  h2 { margin: 0; font-size: 19px; }
  h3 { margin: 0 0 12px; font-size: 14px; }
  header p, .muted, .why { color: var(--muted); font-size: 12px; }
  p { margin: 8px 0; line-height: 1.6; font-size: 13px; overflow-wrap: anywhere; }
  section { padding-top: 20px; margin-top: 16px; border-top: 1px solid var(--line); }
  fieldset { position: relative; border: 1px solid var(--line); border-radius: 10px; padding: 12px; margin: 16px 0 0; }
  legend { padding: 0 4px; font-size: 13px; font-weight: 650; }
  label { display: flex; gap: 8px; align-items: start; font-size: 13px; line-height: 1.5; cursor: pointer; }
  input[type=radio] { accent-color: var(--accent); margin-top: 3px; }
  .option { margin-bottom: 12px; }
  .why { margin: 4px 0 0 25px; }
  .free-text { width: 100%; box-sizing: border-box; margin-top: 8px; padding: 9px; border-radius: 8px; border: 1px solid var(--line-strong); background: var(--input); color: var(--fg); font: inherit; }
  .badge { display: inline-block; padding: 1px 5px; border-radius: 4px; background: var(--chip); color: var(--muted-strong); font-size: 11px; }
  .human { margin-top: 12px; color: var(--ui-accent-text); font-size: 13px; }
  .source { padding: 1px 4px; border: 0; color: var(--ui-accent-text); font-size: 11px; }
  .banner { padding: 12px; border-radius: 8px; background: var(--accent-soft); font-size: 13px; }
  dl { margin: 0; font-size: 13px; }
  dt { color: var(--muted); margin-top: 12px; }
  dd { margin: 5px 0 0; line-height: 1.6; overflow-wrap: anywhere; }
  footer { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 24px; }
  button { padding: 8px 12px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: var(--fg); font: inherit; font-size: 12px; cursor: pointer; }
  .primary { background: var(--accent); border-color: var(--accent); color: white; }
  button:disabled { opacity: 0.5; cursor: default; }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .error { color: var(--danger); }
</style>
