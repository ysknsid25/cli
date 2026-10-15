import { isAbsolute, resolve } from 'pathe'
import { CliError } from '../../utils/output.js'

/**
 * Resolve the path of a result file against the project root. Reject
 * paths outside the root, so an agent cannot touch files anywhere else.
 * Based on Vitest's `BenchmarkManager.resolve`.
 */
export const resolveResultPath = (root: string, file: string): string => {
  const normalizedRoot = resolve(root)
  const absolute = isAbsolute(file) ? resolve(file) : resolve(normalizedRoot, file)
  const rootWithSep = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`
  if (!absolute.startsWith(rootWithSep)) {
    throw new CliError('PATH_OUTSIDE_PROJECT', `"${file}" is outside the project`, {
      suggestions: ['Pass a file path inside the project, like bench/users.json'],
    })
  }
  return absolute
}
