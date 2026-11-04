import test from 'node:test'
import assert from 'node:assert/strict'
import { migrationView } from '../lib/index.js'

test('product panel idle view exposes the large-backup entry and stays within the data budget', () => {
  const view = migrationView(null, { locale: 'zh' })
  const text = JSON.stringify(view)
  assert.match(text, /scanLarge/)
  assert.match(text, /Download\/DSHA/)
  assert.match(text, /选择备份/)
  assert.ok(!text.includes('8 MiB') && !text.includes('≤8'), 'the old picker-size copy must not be shown')
  assert.ok(Buffer.byteLength(text, 'utf8') <= 32 * 1024, `panel view is ${Buffer.byteLength(text, 'utf8')} bytes`)
})

test('product panel idle view is bilingual and does not expose a raw /sdcard path as a migration source', () => {
  const view = migrationView(null, { locale: 'en' })
  const text = JSON.stringify(view)
  assert.match(text, /Choose from DSHA/)
  assert.ok(!text.includes('preparePath'), 'internal controller method must not leak into the view')
})
