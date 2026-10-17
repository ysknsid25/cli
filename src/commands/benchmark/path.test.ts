import { describe, expect, it } from 'vitest'
import { CliError } from '../../utils/output.js'
import { resolveResultPath } from './path.js'

describe('resolveResultPath', () => {
  it('should resolve a relative path inside the root', () => {
    expect(resolveResultPath('/project', 'bench/users.json')).toBe('/project/bench/users.json')
  })

  it('should accept an absolute path inside the root', () => {
    expect(resolveResultPath('/project', '/project/users.json')).toBe('/project/users.json')
  })

  it.each(['../users.json', '/tmp/users.json', '/projectx/users.json', '.', '/project'])(
    'should reject %s',
    (file) => {
      expect(() => resolveResultPath('/project', file)).toThrow(CliError)
    }
  )
})
