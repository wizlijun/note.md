import { readFileSync } from 'node:fs'

// One source for the complete Pele MIT and bundled Lucide ISC notices.
export const peleNotice = readFileSync(new URL('../src/lib/diagrams/PELE-NOTICE.txt', import.meta.url), 'utf8').trim()
export function containsPele(modules) {
  return Object.keys(modules).some(id => /(?:^|\/)node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?pele\//.test(id))
}
export function assertPeleNotice(source) {
  if (!source.includes(peleNotice)) throw new Error('Missing complete Pele MIT / Lucide ISC notice')
}
export function peleNoticeBanner(chunk) {
  return containsPele(chunk.modules) ? `/*!\n${peleNotice}\n*/` : ''
}
export function peleNoticeGuard() {
  return { name: 'pele-notice-guard', generateBundle(_options, bundle) {
    for (const chunk of Object.values(bundle)) {
      if (chunk.type === 'chunk' && containsPele(chunk.modules)) assertPeleNotice(chunk.code)
    }
  } }
}
