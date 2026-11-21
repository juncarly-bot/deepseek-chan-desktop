'use strict'

const fs = require('fs')
const path = require('path')

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
const MAX_LINE_BYTES = 16 * 1024

function appendBoundedLog(filePath, line, options = {}) {
  if (!filePath) return false
  const fsImpl = options.fsImpl || fs
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0
    ? Math.floor(options.maxBytes) : DEFAULT_MAX_BYTES
  const backupPath = `${filePath}.1`
  const text = String(line ?? '')
  let content = Buffer.from(`${text}\n`, 'utf8')
  if (content.length > Math.min(maxBytes, MAX_LINE_BYTES)) {
    const limit = Math.min(maxBytes, MAX_LINE_BYTES)
    const suffix = Buffer.from('\n[log line truncated]\n', 'utf8')
    const prefix = Buffer.from(text, 'utf8').subarray(0, Math.max(0, limit - suffix.length))
    content = Buffer.concat([prefix, suffix])
  }

  try {
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true })
    let currentBytes = 0
    try { currentBytes = fsImpl.statSync(filePath).size } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (currentBytes + content.length > maxBytes) {
      try { fsImpl.unlinkSync(backupPath) } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (currentBytes > 0) {
        fsImpl.writeFileSync(backupPath, readTail(fsImpl, filePath, maxBytes))
        fsImpl.writeFileSync(filePath, content)
        return true
      }
    }
    fsImpl.appendFileSync(filePath, content)
    return true
  } catch {
    return false
  }
}

function readTail(fsImpl, filePath, maxBytes) {
  const fd = fsImpl.openSync(filePath, 'r')
  try {
    const size = fsImpl.fstatSync(fd).size
    const start = Math.max(0, size - maxBytes)
    const buffer = Buffer.alloc(size - start)
    fsImpl.readSync(fd, buffer, 0, buffer.length, start)
    if (start === 0) return buffer
    const newline = buffer.indexOf(0x0a)
    return newline < 0 ? buffer : buffer.subarray(newline + 1)
  } finally {
    fsImpl.closeSync(fd)
  }
}

module.exports = { appendBoundedLog, DEFAULT_MAX_BYTES, MAX_LINE_BYTES }
