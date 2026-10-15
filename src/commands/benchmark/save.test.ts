import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CliError } from '../../utils/output.js'
import type { SavedResult } from './save.js'
import { writeSavedResult } from './save.js'

describe('writeSavedResult', () => {
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
    dir = mkdtempSync(join(tmpdir(), 'hono-cli-save-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('should create the directory and write the result', async () => {
    const path = join(dir, 'bench', 'users.json')
    await writeSavedResult(path, data)
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual(data)
  })

  it('should overwrite a saved result', async () => {
    const path = join(dir, 'users.json')
    await writeSavedResult(path, data)
    await writeSavedResult(path, { ...data, rps: 2000 })
    expect(JSON.parse(readFileSync(path, 'utf-8')).rps).toBe(2000)
  })

  it.each(['{"name":"x"}', 'not json'])('should not overwrite other files: %s', async (content) => {
    const path = join(dir, 'package.json')
    writeFileSync(path, content)
    await expect(writeSavedResult(path, data)).rejects.toThrow(CliError)
    expect(readFileSync(path, 'utf-8')).toBe(content)
  })
})
