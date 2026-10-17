import { Command } from 'commander'
import { Hono } from 'hono'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock dependencies
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  realpathSync: vi.fn(),
  readFileSync: vi.fn(),
}))

vi.mock('node:path', () => ({
  resolve: vi.fn(),
  join: vi.fn((...parts: string[]) => parts.join('/')),
}))

vi.mock('../../utils/build.js', () => ({
  buildAndImportApp: vi.fn(),
}))

vi.mock('./engine.js', async (importOriginal) => {
  const original = await importOriginal<typeof EngineModule>()
  return { ...original, runBench: vi.fn() }
})

vi.mock('./save.js', async (importOriginal) => {
  const original = await importOriginal<typeof SaveModule>()
  return { ...original, writeSavedResult: vi.fn() }
})

vi.mock('./load.js', () => ({ readSavedResult: vi.fn() }))

vi.mock('./hono-source.js', async (importOriginal) => {
  const original = await importOriginal<typeof HonoSourceModule>()
  return { ...original, resolveHonoSource: vi.fn(async (spec: string) => ({ label: spec })) }
})

import type * as EngineModule from './engine.js'
import type * as HonoSourceModule from './hono-source.js'
import type * as SaveModule from './save.js'
import { benchmarkCommand } from './index.js'

describe('benchmarkCommand', () => {
  let program: Command
  const spyOnLog = () => vi.spyOn(console, 'log').mockImplementation(() => {})
  let consoleLogSpy: ReturnType<typeof spyOnLog>
  let consoleErrorSpy: ReturnType<typeof spyOnLog>

  const getMockModules = async () => ({
    existsSync: vi.mocked((await import('node:fs')).existsSync),
    realpathSync: vi.mocked((await import('node:fs')).realpathSync),
    readFileSync: vi.mocked((await import('node:fs')).readFileSync),
    resolve: vi.mocked((await import('node:path')).resolve),
  })
  const getMockBuildAndImportApp = async () =>
    vi.mocked((await import('../../utils/build.js')).buildAndImportApp)
  const getMockRunBench = async () => vi.mocked((await import('./engine.js')).runBench)
  const getMockWriteSavedResult = async () =>
    vi.mocked((await import('./save.js')).writeSavedResult)

  let mockModules: Awaited<ReturnType<typeof getMockModules>>
  let mockBuildAndImportApp: Awaited<ReturnType<typeof getMockBuildAndImportApp>>
  let mockRunBench: Awaited<ReturnType<typeof getMockRunBench>>
  let mockWriteSavedResult: Awaited<ReturnType<typeof getMockWriteSavedResult>>
  const getMockReadSavedResult = async () => vi.mocked((await import('./load.js')).readSavedResult)
  let mockReadSavedResult: Awaited<ReturnType<typeof getMockReadSavedResult>>

  async function* createBuildIterator(app: Hono): AsyncGenerator<Hono> {
    yield app
  }

  const routeResult = {
    method: 'GET',
    path: '/',
    requests: 100,
    rps: 1000,
    latency: { avg: 0.1, p50: 0.1, p75: 0.1, p99: 0.2 },
  }

  const setupBasicMocks = (app: Hono) => {
    mockModules.existsSync.mockReturnValue(true)
    mockModules.realpathSync.mockReturnValue('test-app.js')
    mockModules.readFileSync.mockReturnValue('{"version":"4.99.0"}')
    mockModules.resolve.mockImplementation((cwd: string, path: string) => `${cwd}/${path}`)
    mockBuildAndImportApp.mockReturnValue(createBuildIterator(app))
    mockRunBench.mockResolvedValue([routeResult])
  }

  beforeEach(async () => {
    program = new Command()
    benchmarkCommand(program)
    consoleLogSpy = spyOnLog()
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    mockModules = await getMockModules()
    mockBuildAndImportApp = await getMockBuildAndImportApp()
    mockRunBench = await getMockRunBench()
    mockWriteSavedResult = await getMockWriteSavedResult()
    mockReadSavedResult = await getMockReadSavedResult()

    vi.clearAllMocks()
  })

  afterEach(() => {
    consoleLogSpy.mockRestore()
    consoleErrorSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('should benchmark the GET routes of the app', async () => {
    const app = new Hono()
    app.use(async (_c, next) => {
      await next()
    })
    app.get('/', (c) => c.text('Hi'))
    app.get('/users/:id', (c) => c.json({}))
    app.post('/users', (c) => c.json({}))
    setupBasicMocks(app)

    await program.parseAsync(['node', 'test', 'benchmark', 'test-app.js'])

    const [, , , targets] = mockRunBench.mock.calls[0]
    expect(targets).toEqual([
      { method: 'GET', path: '/' },
      { method: 'GET', path: '/users/1' },
    ])
    const parsed = JSON.parse(consoleLogSpy.mock.calls[0][0])
    expect(parsed.ok).toBe(true)
    expect(parsed.data.results).toEqual([{ hono: '4.99.0', routes: [routeResult] }])
  })

  it('should benchmark only the paths from -P', async () => {
    setupBasicMocks(new Hono())

    await program.parseAsync(['node', 'test', 'benchmark', '-P', '/a', '-P', '/b', 'test-app.js'])

    const [, , , targets] = mockRunBench.mock.calls[0]
    expect(targets).toEqual([
      { method: 'GET', path: '/a' },
      { method: 'GET', path: '/b' },
    ])
  })

  it('should benchmark a POST path with a body and headers', async () => {
    setupBasicMocks(new Hono())

    await program.parseAsync([
      'node',
      'test',
      'benchmark',
      '-P',
      '/users',
      '-X',
      'POST',
      '-d',
      '{"name":"Alice"}',
      '-H',
      'Content-Type: application/json',
      'test-app.js',
    ])

    const [, , , targets] = mockRunBench.mock.calls[0]
    expect(targets).toEqual([
      {
        method: 'POST',
        path: '/users',
        headers: { 'Content-Type': 'application/json' },
        body: '{"name":"Alice"}',
      },
    ])
  })

  it('should reject -X without -P', async () => {
    setupBasicMocks(new Hono())

    await program.parseAsync(['node', 'test', 'benchmark', '-X', 'POST', 'test-app.js'])

    const parsed = JSON.parse(consoleLogSpy.mock.calls[0][0])
    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe('INVALID_OPTION')
    process.exitCode = undefined
  })

  it('should fail with NO_ROUTES when the app has no GET routes', async () => {
    const app = new Hono()
    app.post('/users', (c) => c.json({}))
    setupBasicMocks(app)

    await program.parseAsync(['node', 'test', 'benchmark', 'test-app.js'])

    const parsed = JSON.parse(consoleLogSpy.mock.calls[0][0])
    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe('NO_ROUTES')
    expect(process.exitCode).toBe(1)
    process.exitCode = undefined
  })

  it('should reject an invalid duration', async () => {
    setupBasicMocks(new Hono())

    await program.parseAsync(['node', 'test', 'benchmark', '--duration', 'zero', 'test-app.js'])

    const parsed = JSON.parse(consoleLogSpy.mock.calls[0][0])
    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe('INVALID_OPTION')
    process.exitCode = undefined
  })

  it('should save the result of one path with --save', async () => {
    setupBasicMocks(new Hono())

    await program.parseAsync([
      'node',
      'test',
      'benchmark',
      '-P',
      '/',
      '--save',
      'bench/root.json',
      'test-app.js',
    ])

    expect(mockWriteSavedResult).toHaveBeenCalledWith(`${process.cwd()}/bench/root.json`, {
      hono: '4.99.0',
      duration: 500,
      warmup: 30,
      ...routeResult,
    })
    const parsed = JSON.parse(consoleLogSpy.mock.calls[0][0])
    expect(parsed.ok).toBe(true)
    expect(parsed.data.saved).toBe('bench/root.json')
  })

  it.each([
    ['no -P', []],
    ['two -P', ['-P', '/a', '-P', '/b']],
    ['two --hono', ['-P', '/a', '--hono', '4.12.0', '--hono', '4.13.0']],
  ])('should reject --save with %s', async (_name, args) => {
    setupBasicMocks(new Hono())

    await program.parseAsync([
      'node',
      'test',
      'benchmark',
      ...args,
      '--save',
      'bench/a.json',
      'test-app.js',
    ])

    const parsed = JSON.parse(consoleLogSpy.mock.calls[0][0])
    expect(parsed.error.code).toBe('INVALID_OPTION')
    expect(mockRunBench).not.toHaveBeenCalled()
    expect(mockWriteSavedResult).not.toHaveBeenCalled()
    process.exitCode = undefined
  })

  it('should reject a --save path outside the project before benchmarking', async () => {
    setupBasicMocks(new Hono())

    await program.parseAsync([
      'node',
      'test',
      'benchmark',
      '-P',
      '/',
      '--save',
      '../a.json',
      'test-app.js',
    ])

    const parsed = JSON.parse(consoleLogSpy.mock.calls[0][0])
    expect(parsed.error.code).toBe('PATH_OUTSIDE_PROJECT')
    expect(mockRunBench).not.toHaveBeenCalled()
    process.exitCode = undefined
  })

  describe('--compare', () => {
    const savedResult = {
      hono: '4.98.0',
      duration: 200,
      warmup: 10,
      method: 'POST',
      path: '/users',
      requests: 100,
      rps: 1000,
      latency: { avg: 0.1, p50: 0.1, p75: 0.1, p99: 0.2 },
    }

    const runCompare = async (...args: string[]) => {
      setupBasicMocks(new Hono())
      mockReadSavedResult.mockResolvedValue(savedResult)
      await program.parseAsync(['node', 'test', 'benchmark', 'test-app.js', ...args])
      return JSON.parse(consoleLogSpy.mock.calls[0][0])
    }

    afterEach(() => {
      process.exitCode = undefined
    })

    it('should run with the method, path, duration, and warmup of the file', async () => {
      await runCompare('--compare', 'bench/users.json')

      expect(mockReadSavedResult).toHaveBeenCalledWith(`${process.cwd()}/bench/users.json`)
      const [, , , targets, options] = mockRunBench.mock.calls[0]
      expect(targets).toEqual([{ method: 'POST', path: '/users' }])
      expect(options).toEqual({ duration: 200, warmup: 10 })
    })

    it('should pass when it is not slower', async () => {
      mockRunBench.mockResolvedValue([routeResult])
      const parsed = await runCompare('--compare', 'bench/users.json')

      expect(parsed.ok).toBe(true)
      expect(parsed.data.compare).toEqual({
        file: 'bench/users.json',
        target: 'rps',
        delta: 0,
        baseline: 1000,
        current: 1000,
        slowdown: 0,
        pass: true,
      })
      expect(process.exitCode).toBeUndefined()
    })

    it('should fail with exit code 1 when it is slower than delta', async () => {
      setupBasicMocks(new Hono())
      mockReadSavedResult.mockResolvedValue(savedResult)
      mockRunBench.mockResolvedValue([{ ...routeResult, rps: 800 }])

      await program.parseAsync([
        'node',
        'test',
        'benchmark',
        'test-app.js',
        '--compare',
        'bench/users.json',
        '0.1',
      ])

      const parsed = JSON.parse(consoleLogSpy.mock.calls[0][0])
      expect(parsed.ok).toBe(true)
      expect(parsed.data.compare).toMatchObject({ slowdown: 0.2, pass: false })
      expect(process.exitCode).toBe(1)
    })

    it('should compare the target', async () => {
      const parsed = await runCompare('--compare', 'bench/users.json', 'latency.p99', '0.5')

      expect(parsed.data.compare).toMatchObject({
        target: 'latency.p99',
        delta: 0.5,
        baseline: 0.2,
        current: 0.2,
      })
    })

    it('should send -d and -H with the request', async () => {
      await runCompare(
        '--compare',
        'bench/users.json',
        '-d',
        '{"name":"Alice"}',
        '-H',
        'Content-Type: application/json'
      )

      const [, , , targets] = mockRunBench.mock.calls[0]
      expect(targets).toEqual([
        {
          method: 'POST',
          path: '/users',
          headers: { 'Content-Type': 'application/json' },
          body: '{"name":"Alice"}',
        },
      ])
    })

    it.each([
      ['-P', ['-P', '/a']],
      ['-X', ['-X', 'GET']],
      ['--duration', ['--duration', '500']],
      ['--warmup', ['--warmup', '30']],
      ['--save', ['--save', 'bench/a.json']],
      ['two --hono', ['--hono', '4.12.0', '--hono', '4.13.0']],
    ])('should reject %s', async (_name, args) => {
      const parsed = await runCompare(...args, '--compare', 'bench/users.json')

      expect(parsed.error.code).toBe('INVALID_OPTION')
      expect(mockReadSavedResult).not.toHaveBeenCalled()
      expect(mockRunBench).not.toHaveBeenCalled()
    })

    it('should reject a file outside the project', async () => {
      const parsed = await runCompare('--compare', '../a.json')

      expect(parsed.error.code).toBe('PATH_OUTSIDE_PROJECT')
      expect(mockRunBench).not.toHaveBeenCalled()
    })
  })

  describe('hint', () => {
    const run = async (...args: string[]) => {
      const app = new Hono()
      app.get('/', (c) => c.text('Hi'))
      setupBasicMocks(app)
      mockReadSavedResult.mockResolvedValue({
        ...routeResult,
        hono: '4.99.0',
        duration: 500,
        warmup: 30,
      })
      await program.parseAsync(['node', 'test', 'benchmark', 'test-app.js', ...args])
      process.exitCode = undefined
      return JSON.parse(consoleLogSpy.mock.calls[0][0])
    }

    it('should point at --save and --compare with one -P path', async () => {
      const parsed = await run('-P', '/')

      expect(parsed.data.hint).toBe(
        'Before changing the code, save this result with --save <file>. After the change, check it with --compare <file> [delta].'
      )
    })

    it.each([
      ['no -P', []],
      ['two -P', ['-P', '/a', '-P', '/b']],
      ['two --hono', ['-P', '/', '--hono', '../a', '--hono', '../b']],
      ['--save', ['-P', '/', '--save', 'bench/a.json']],
      ['--compare', ['--compare', 'bench/a.json']],
    ])('should not show it with %s', async (_name, args) => {
      const parsed = await run(...args)

      expect(parsed.ok).toBe(true)
      expect(parsed.data.hint).toBeUndefined()
    })
  })

  describe('duration warning', () => {
    it('should warn that --duration is in milliseconds when it is under 100', async () => {
      setupBasicMocks(new Hono())

      await program.parseAsync([
        'node',
        'test',
        'benchmark',
        '-P',
        '/',
        '--duration',
        '2',
        'test-app.js',
      ])

      const parsed = JSON.parse(consoleLogSpy.mock.calls[0][0])
      expect(parsed.ok).toBe(true)
      expect(parsed.data.warning).toBe(
        '--duration is in milliseconds. 2 measures for 2ms; for 2 seconds, pass 2000'
      )
    })

    it('should not warn at 100', async () => {
      setupBasicMocks(new Hono())

      await program.parseAsync([
        'node',
        'test',
        'benchmark',
        '-P',
        '/',
        '--duration',
        '100',
        'test-app.js',
      ])

      const parsed = JSON.parse(consoleLogSpy.mock.calls[0][0])
      expect(parsed.data.warning).toBeUndefined()
    })
  })

  describe('a route passed as the app file', () => {
    it('should point at -P when the file starts with / and does not exist', async () => {
      setupBasicMocks(new Hono())
      mockModules.existsSync.mockReturnValue(false)

      await program.parseAsync(['node', 'test', 'benchmark', '/api/todos'])

      const parsed = JSON.parse(consoleLogSpy.mock.calls[0][0])
      expect(parsed.error.code).toBe('ENTRY_NOT_FOUND')
      expect(parsed.error.suggestions[0]).toBe(
        'To benchmark a route, pass it with -P: hono benchmark -P /api/todos'
      )
      process.exitCode = undefined
    })

    it('should not point at -P for a missing file that does not start with /', async () => {
      setupBasicMocks(new Hono())
      mockModules.existsSync.mockReturnValue(false)

      await program.parseAsync(['node', 'test', 'benchmark', 'src/none.ts'])

      const parsed = JSON.parse(consoleLogSpy.mock.calls[0][0])
      expect(parsed.error.code).toBe('ENTRY_NOT_FOUND')
      expect(parsed.error.suggestions.join('\n')).not.toContain('-P')
      process.exitCode = undefined
    })

    it('should point at -P when the route comes after the app file', async () => {
      setupBasicMocks(new Hono())

      await program.parseAsync(['node', 'test', 'benchmark', 'src/index.ts', '/api/todos'])

      const parsed = JSON.parse(consoleLogSpy.mock.calls[0][0])
      expect(parsed.error.code).toBe('INVALID_ARGUMENTS')
      expect(parsed.error.suggestions).toEqual([
        'To benchmark a route, pass it with -P: hono benchmark src/index.ts -P /api/todos',
      ])
      expect(mockRunBench).not.toHaveBeenCalled()
      process.exitCode = undefined
    })

    it('should reject other extra arguments', async () => {
      setupBasicMocks(new Hono())

      await program.parseAsync(['node', 'test', 'benchmark', 'src/index.ts', 'extra'])

      const parsed = JSON.parse(consoleLogSpy.mock.calls[0][0])
      expect(parsed.error.code).toBe('INVALID_ARGUMENTS')
      expect(parsed.error.suggestions).toEqual(['Check the usage: hono benchmark --help'])
      process.exitCode = undefined
    })
  })
})
