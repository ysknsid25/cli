import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSavedResult } from './load.js'
import type { SavedResult } from './save.js'

describe('readSavedResult', () => {
  let dir: string
  const data: SavedResult = {
    hono: '4.99.0',
    duration: 500,
    warmup: 30,
    method: 'GET',
    path: '/users',
    requests: 100,
    rps: 1000,
    latency: { avg: 0.1, p50: 0.1, p75: 0.1, p99: 0.2 },
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hono-cli-load-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('should read a saved result', async () => {
    const path = join(dir, 'users.json')
    writeFileSync(path, JSON.stringify(data))
    expect(await readSavedResult(path)).toEqual(data)
  })

  it('should fail when the file does not exist', async () => {
    await expect(readSavedResult(join(dir, 'none.json'))).rejects.toMatchObject({
      code: 'RESULT_FILE_NOT_FOUND',
    })
  })

  it.each(['{"name":"x"}', 'not json'])('should fail for other files: %s', async (content) => {
    const path = join(dir, 'package.json')
    writeFileSync(path, content)
    await expect(readSavedResult(path)).rejects.toMatchObject({ code: 'INVALID_RESULT_FILE' })
  })
})
