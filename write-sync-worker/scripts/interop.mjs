import fs from 'node:fs'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
const fixture = JSON.parse(
  fs.readFileSync(new URL('../../write-core/tests/fixtures/yrs-v1.json', import.meta.url), 'utf8'),
)
console.log('fixture keys:', Object.keys(fixture).join(','))
const decode = (s) => new Uint8Array(Buffer.from(s, 'base64'))
const full = new Y.Doc()
full.getText('body')
full.getMap('page')
full.getMap('timing')
Y.applyUpdate(full, decode(fixture.full))
assert.equal(full.getText('body').toString(), fixture.expected.body)
const replica = new Y.Doc()
replica.getText('body')
replica.getMap('page')
replica.getMap('timing')
Y.applyUpdate(replica, decode(fixture.base))
for (const update of [...fixture.updates].reverse().concat(fixture.updates))
  Y.applyUpdate(replica, decode(update))
assert.equal(replica.getText('body').toString(), fixture.expected.body)
const before = Y.encodeStateVector(full)
full.clientID = 900
full.getText('body').insert(full.getText('body').length, '！')
fs.writeFileSync(
  new URL('../tests/yjs-v1.json', import.meta.url),
  JSON.stringify(
    {
      yjs: '13.6.33',
      base: fixture.full,
      update: Buffer.from(Y.encodeStateAsUpdate(full, before)).toString('base64'),
      full: Buffer.from(Y.encodeStateAsUpdate(full)).toString('base64'),
      stateVector: Buffer.from(Y.encodeStateVector(full)).toString('base64'),
      expectedBody: full.getText('body').toString(),
    },
    null,
    2,
  ) + '\n',
)
console.log('Yrs fixture decoded and reverse duplicate updates merged; Yjs return fixture emitted')
