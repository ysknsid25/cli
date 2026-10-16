import { dirname } from 'pathe'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { CliError } from '../../utils/output.js'
import type { RouteResult } from './engine.js'

/**
 * One endpoint per file, so every saved file has the same shape.
 */
export interface SavedResult extends RouteResult {
  hono: string
  duration: number
  warmup: number
}

export const isSavedResult = (value: unknown): value is SavedResult => {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const record = value as Record<string, unknown>
  return (
    typeof record.method === 'string' &&
    typeof record.path === 'string' &&
    typeof record.duration === 'number' &&
    typeof record.warmup === 'number' &&
    typeof record.requests === 'number' &&
    typeof record.rps === 'number' &&
    typeof record.latency === 'object' &&
    record.latency !== null
  )
}

/**
 * Write the result. Overwrite only a file that is a saved result, so
 * files like package.json are never replaced.
 */
export const writeSavedResult = async (path: string, data: SavedResult): Promise<void> => {
  if (existsSync(path)) {
    let existing: unknown
    try {
      existing = JSON.parse(await readFile(path, 'utf-8'))
    } catch {
      existing = undefined
    }
    if (!isSavedResult(existing)) {
      throw new CliError('SAVE_FILE_EXISTS', `${path} exists and is not a benchmark result`, {
        suggestions: ['Pass a new file path, or a file saved by --save'],
      })
    }
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf-8')
}
