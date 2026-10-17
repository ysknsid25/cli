import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { CliError } from '../../utils/output.js'
import type { SavedResult } from './save.js'
import { isSavedResult } from './save.js'

/**
 * Read a file saved by --save.
 */
export const readSavedResult = async (path: string): Promise<SavedResult> => {
  if (!existsSync(path)) {
    throw new CliError('RESULT_FILE_NOT_FOUND', `${path} does not exist`, {
      suggestions: ['Save a result first: hono benchmark -P /users --save bench/users.json'],
    })
  }
  let value: unknown
  try {
    value = JSON.parse(await readFile(path, 'utf-8'))
  } catch {
    value = undefined
  }
  if (!isSavedResult(value)) {
    throw new CliError('INVALID_RESULT_FILE', `${path} is not a benchmark result`, {
      suggestions: ['Pass a file saved by --save'],
    })
  }
  return value
}
