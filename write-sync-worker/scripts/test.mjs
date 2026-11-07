import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
// Wrangler 3's old workerd runner cannot register two test-file workers together.
// Each file gets a fresh runtime; do not change the production toolchain to work around it.
for (const file of readdirSync('tests').filter(name=>name.endsWith('.test.ts')).sort()) {
  const result=spawnSync('../worker/node_modules/.bin/vitest',['run',`tests/${file}`],{stdio:'inherit'})
  if(result.error)throw result.error
  if(result.status!==0)process.exit(result.status??1)
}
