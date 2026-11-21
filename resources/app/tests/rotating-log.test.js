'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { appendBoundedLog } = require('../src/core/rotating-log')

test('ログは上限で一世代を退避し、現行ファイルを上限内に保つ', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-log-'))
  const file = path.join(dir, 'launch.log')
  assert.equal(appendBoundedLog(file, 'first', { maxBytes: 10 }), true)
  assert.equal(appendBoundedLog(file, 'second', { maxBytes: 10 }), true)
  assert.equal(fs.readFileSync(`${file}.1`, 'utf8'), 'first\n')
  assert.equal(fs.readFileSync(file, 'utf8'), 'second\n')
  assert.ok(fs.statSync(file).size <= 10)
})

test('過大な単一行は切り詰め、ログ書き込み失敗はアプリへ伝播しない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-log-long-'))
  const file = path.join(dir, 'launch.log')
  assert.equal(appendBoundedLog(file, 'あ'.repeat(50000), { maxBytes: 1024 }), true)
  assert.ok(fs.statSync(file).size <= 1024)
  assert.match(fs.readFileSync(file, 'utf8'), /log line truncated/)
  assert.equal(appendBoundedLog(path.join(dir, 'missing', 'x.log'), 'line', {
    fsImpl: { mkdirSync() { throw new Error('disk unavailable') } },
  }), false)
})

test('過去の大きなログを退避するときも末尾だけを上限内に残す', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-log-rotate-large-'))
  const file = path.join(dir, 'launch.log')
  fs.writeFileSync(file, `${'old\n'.repeat(100)}last-known-line\n`)
  assert.equal(appendBoundedLog(file, 'new-line', { maxBytes: 32 }), true)
  assert.ok(fs.statSync(`${file}.1`).size <= 32)
  assert.equal(fs.readFileSync(file, 'utf8'), 'new-line\n')
  assert.match(fs.readFileSync(`${file}.1`, 'utf8'), /last-known-line/)
})
