import { readFile } from 'node:fs/promises'
import { executeTaskRequest } from './task-api'

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    process.stdout.write('Node >= 20. Build provenance: adjacent build-manifest.json.\nUsage: node next-task-cli.mjs --vault /absolute/vault [--request request.json]\nJSON stdin if --request is omitted. Actions: list, read, create, update, transition, reminder.\n')
    return
  }
  if (args.length % 2 || args.some((arg, index) => index % 2 === 0 && !['--vault', '--request'].includes(arg))) throw new Error('Use --vault PATH [--request FILE]')
  const options = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, index) => [args[index * 2], args[index * 2 + 1]]))
  if (!options['--vault']) throw new Error('--vault is required')
  let raw = ''
  if (options['--request']) raw = await readFile(options['--request'], 'utf8')
  else { for await (const chunk of process.stdin) raw += chunk.toString() }
  process.stdout.write(`${JSON.stringify(await executeTaskRequest(options['--vault'], JSON.parse(raw)), null, 2)}\n`)
}
main().catch(error => { process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`); process.exitCode = 1 })
