import type { Command } from 'commander'
import { inspectRoutes } from 'hono/dev'
import { relative } from 'pathe'
import { buildAndImportApp } from '../../utils/build.js'
import type { CommandHelp } from '../../utils/help.js'
import { renderCommandHelp } from '../../utils/help.js'
import { getBuildIterator, resolveData, resolveEntry } from '../../utils/load-app.js'
import { CliError, handleErrors, printResult } from '../../utils/output.js'
import type { CompareArgs, Comparison } from './compare.js'
import { compareResult, parseCompareArgs } from './compare.js'
import type { BenchTarget, RouteResult } from './engine.js'
import { runBench } from './engine.js'
import type { HonoSource } from './hono-source.js'
import { projectHonoSource, resolveHonoSource } from './hono-source.js'
import { readSavedResult } from './load.js'
import { resolveResultPath } from './path.js'
import { writeSavedResult } from './save.js'

const help: CommandHelp = {
  output:
    '{ "results": [{ "hono": "4.13.0", "routes": [{ "method": "GET", "path": "/users", "requests": 48210, "rps": 96420, "latency": { "avg": 0.01, "p50": 0.009, "p75": 0.011, "p99": 0.021 } }] }] }',
  examples: [
    'hono benchmark',
    'hono benchmark -P /users',
    `hono benchmark -P /users -X POST -d '{"name":"Alice"}'`,
    'hono benchmark --hono 4.12.3 --hono 4.13.0',
    'hono benchmark --hono ../hono',
    'hono benchmark -P /users --save bench/users.json',
    'hono benchmark --compare bench/users.json',
    'hono benchmark --compare bench/users.json 0.1 latency.p99',
  ],
  notes: [
    'This is a micro benchmark of routing and handlers. It calls app.request() directly — no HTTP stack, no network.',
    'Each run happens in a fresh process, so results are comparable.',
    '--hono benchmarks the same app with another Hono: an npm version, or a path to a local checkout. Use it to compare Hono versions without touching the project.',
    '-X, -d, and -H set the method, body, and headers for -P paths. The route sweep stays GET only.',
    'A few percent of difference is noise. To compare, run it more than once and check the difference repeats. Run one benchmark at a time — parallel runs share the CPU and skew the numbers.',
    'Latency is in milliseconds. --duration is in milliseconds too: a value under 100 adds a "warning" to the output.',
    '--save writes the result of one -P path to a JSON file in the project. It overwrites only a file saved by --save.',
    '--compare <file> [delta] [target] runs the benchmark again with the method, path, duration, and warmup of a file saved by --save. delta (0 to 1, default 0) is the allowed slowdown. target is rps (default), requests, latency.avg, latency.p50, latency.p75, or latency.p99. They can come in any order.',
    '"slowdown" is how much slower the run is than the file: 0.1 is 10% slower, -0.1 is 10% faster. "pass" is slowdown <= delta. The exit code is 1 when it does not pass.',
    'With one -P path, the output has a "hint" that points at --save and --compare.',
    'Results vary by a few percent between runs, so delta 0 fails often. A delta of 0.05 to 0.1 is practical.',
    'Put the app file before --compare: hono benchmark app.ts --compare bench/users.json. -d and -H work with --compare, since the file does not keep headers and body.',
  ],
}

// Agents run benchmark without reading --help, so the output points
// at --save and --compare when they would work
const SAVE_HINT =
  'Before changing the code, save this result with --save <file>. After the change, check it with --compare <file> [delta].'

// Agents pass --duration 2 meaning 2 seconds. That measures 2ms of noise.
const SHORT_DURATION = 100

const durationWarning = (duration: number): string | undefined =>
  duration < SHORT_DURATION
    ? `--duration is in milliseconds. ${duration} measures for ${duration}ms; for ${duration} seconds, pass ${duration * 1000}`
    : undefined

// Agents pass the route where the app file goes: hono benchmark /api/todos
const routeSuggestion = (route: string, file?: string): string =>
  `To benchmark a route, pass it with -P: hono benchmark ${file ? `${file} ` : ''}-P ${route}`

const collect = (value: string, previous: string[]): string[] =>
  previous ? [...previous, value] : [value]

interface BenchmarkOptions {
  path: string[]
  method: string
  data?: string
  header: string[]
  duration: string
  warmup: string
  hono: string[]
  plain: boolean
  save?: string
  compare?: string[]
  external?: string[]
}

export function benchmarkCommand(program: Command) {
  program
    .command('benchmark')
    .addHelpText('after', renderCommandHelp(help))
    .description('Measure the performance of your Hono app')
    .argument('[file]', 'Path to the Hono app file')
    // Checked in the action, to point a route at -P
    .allowExcessArguments()
    .option(
      '-P, --path <path>',
      'benchmark only this path (can be used multiple times)',
      collect,
      []
    )
    .option('-X, --method <method>', 'HTTP method for -P paths', 'GET')
    .option('-d, --data <data>', 'request body for -P paths (@file reads a file, @- reads stdin)')
    .option(
      '-H, --header <header>',
      'custom headers for -P paths (can be used multiple times)',
      collect,
      [] as string[]
    )
    .option('--duration <ms>', 'how long to measure each route', '500')
    .option('--warmup <count>', 'requests before measuring', '30')
    .option(
      '--hono <version-or-path>',
      'benchmark with this Hono instead (can be used multiple times)',
      collect,
      [] as string[]
    )
    .option('--save <file>', 'save the result to a JSON file in the project (needs one -P path)')
    .option('--compare <args...>', 'compare with a file saved by --save: <file> [delta] [target]')
    .option('--plain', 'human-readable output instead of JSON', false)
    .option(
      '-e, --external <package>',
      'Mark package as external (can be used multiple times)',
      collect,
      [] as string[]
    )
    .action(
      handleErrors(async (file: string | undefined, args: BenchmarkOptions, command: Command) => {
        if (command.args.length > 1) {
          const route = command.args.slice(1).find((arg) => arg.startsWith('/'))
          throw new CliError(
            'INVALID_ARGUMENTS',
            `too many arguments for 'benchmark'. Expected 1 argument but got ${command.args.length}.`,
            {
              suggestions: [
                route ? routeSuggestion(route, file) : 'Check the usage: hono benchmark --help',
              ],
            }
          )
        }
        let options = args
        let compare: { args: CompareArgs; path: string; baseline: RouteResult } | undefined
        if (options.compare) {
          const fromCli = (name: string) => command.getOptionValueSource(name) === 'cli'
          if (
            options.path.length > 0 ||
            fromCli('method') ||
            fromCli('duration') ||
            fromCli('warmup') ||
            options.save !== undefined ||
            options.hono.length > 1
          ) {
            throw new CliError(
              'INVALID_OPTION',
              '--compare does not work with -P, -X, --duration, --warmup, --save, or two --hono',
              {
                suggestions: [
                  'The file sets the method, path, duration, and warmup: hono benchmark --compare bench/users.json',
                ],
              }
            )
          }
          const compareArgs = parseCompareArgs(options.compare)
          const comparePath = resolveResultPath(process.cwd(), compareArgs.file)
          const saved = await readSavedResult(comparePath)
          // Run under the same conditions as the saved result
          options = {
            ...options,
            path: [saved.path],
            method: saved.method,
            duration: String(saved.duration),
            warmup: String(saved.warmup),
          }
          compare = { args: compareArgs, path: comparePath, baseline: saved }
        }

        const duration = Number(options.duration)
        const warmup = Number(options.warmup)
        if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(warmup) || warmup < 0) {
          throw new CliError('INVALID_OPTION', 'Invalid --duration or --warmup', {
            suggestions: ['Pass positive numbers: --duration 500 --warmup 30'],
          })
        }

        const method = (options.method || 'GET').toUpperCase()
        if (
          options.path.length === 0 &&
          (method !== 'GET' || options.data || options.header.length > 0)
        ) {
          throw new CliError('INVALID_OPTION', '-X, -d, and -H work only with -P paths', {
            suggestions: [
              'Pass the path too: hono benchmark -P /users -X POST -d \'{"name":"Alice"}\'',
            ],
          })
        }

        if (options.save !== undefined && (options.path.length !== 1 || options.hono.length > 1)) {
          throw new CliError('INVALID_OPTION', '--save needs exactly one -P path and one Hono', {
            suggestions: ['Pass one path: hono benchmark -P /users --save bench/users.json'],
          })
        }
        const savePath =
          options.save === undefined ? undefined : resolveResultPath(process.cwd(), options.save)

        const external = options.external || []
        const entry = await resolveEntry(file).catch((e: unknown) => {
          if (e instanceof CliError && e.code === 'ENTRY_NOT_FOUND' && file?.startsWith('/')) {
            e.suggestions = [routeSuggestion(file), ...(e.suggestions ?? [])]
          }
          throw e
        })
        const targets = await collectTargets(file, entry, options, method, external)

        const sources: HonoSource[] = []
        try {
          if (options.hono.length === 0) {
            sources.push(projectHonoSource())
          } else {
            for (const spec of options.hono) {
              sources.push(await resolveHonoSource(spec))
            }
          }

          const results: { hono: string; routes: RouteResult[] }[] = []
          for (const source of sources) {
            console.error(`Benchmarking with hono ${source.label} ...`)
            const routes = await runBench(entry, external, source, targets, { duration, warmup })
            results.push({ hono: source.label, routes })
          }

          let saved: string | undefined
          if (savePath) {
            const [result] = results
            await writeSavedResult(savePath, {
              hono: result.hono,
              duration,
              warmup,
              ...result.routes[0],
            })
            saved = relative(process.cwd(), savePath)
          }

          let comparison: ({ file: string } & Comparison) | undefined
          if (compare) {
            const { target, delta } = compare.args
            comparison = {
              file: relative(process.cwd(), compare.path),
              ...compareResult(compare.baseline, results[0].routes[0], target, delta),
            }
            if (!comparison.pass) {
              process.exitCode = 1
            }
          }

          const hint =
            !saved && !comparison && options.path.length === 1 && options.hono.length <= 1
              ? SAVE_HINT
              : undefined

          const warning = durationWarning(duration)

          if (options.plain) {
            printPlainResults(results)
            if (warning) {
              console.log(`Warning: ${warning}`)
            }
            if (hint) {
              console.log(`Hint: ${hint}`)
            }
            if (saved) {
              console.log(`Saved to ${saved}`)
            }
            if (comparison) {
              const slowdown =
                comparison.slowdown === null
                  ? 'n/a'
                  : `${Math.round(comparison.slowdown * 10000) / 100}%`
              console.log(
                `${comparison.target}: ${comparison.baseline} -> ${comparison.current} (slowdown ${slowdown}) ${comparison.pass ? 'PASS' : 'FAIL'} (delta ${comparison.delta})`
              )
            }
            return
          }
          printResult({
            results,
            ...(saved ? { saved } : {}),
            ...(comparison ? { compare: comparison } : {}),
            ...(hint ? { hint } : {}),
            ...(warning ? { warning } : {}),
          })
        } finally {
          for (const source of sources) {
            source.cleanup?.()
          }
        }
      })
    )
}

const collectTargets = async (
  file: string | undefined,
  entry: Awaited<ReturnType<typeof resolveEntry>>,
  options: BenchmarkOptions,
  method: string,
  external: string[]
): Promise<BenchTarget[]> => {
  if (options.path.length > 0) {
    const headers: Record<string, string> = {}
    for (const header of options.header) {
      const [key, value] = header.split(':', 2)
      if (key && value) {
        headers[key.trim()] = value.trim()
      }
    }
    const body = await resolveData(options.data)
    return options.path.map((path) => ({
      method,
      path,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(body === undefined ? {} : { body }),
    }))
  }

  // Enumerate the GET routes of the app, like `hono routes`
  const buildIterator =
    typeof entry === 'string'
      ? getBuildIterator(file, false, external)
      : buildAndImportApp(entry, { external: ['@hono/node-server', ...external] })
  const app = (await buildIterator.next()).value
  if (!app || !Array.isArray(app.routes)) {
    throw new CliError('INVALID_APP', 'The app does not expose routes', {
      suggestions: ['Export the Hono instance as the default export'],
      docs: 'https://hono.dev/docs/api/hono',
    })
  }

  const seen = new Set<string>()
  const targets: BenchTarget[] = []
  for (const route of inspectRoutes(app)) {
    if (route.isMiddleware || route.method !== 'GET' || route.path.includes('*')) {
      continue
    }
    const path = route.path.replace(/:[^/]+/g, '1')
    if (seen.has(path)) {
      continue
    }
    seen.add(path)
    targets.push({ method: 'GET', path })
  }
  if (targets.length === 0) {
    throw new CliError('NO_ROUTES', 'No GET routes to benchmark', {
      suggestions: ['Pass a path: hono benchmark -P /'],
    })
  }
  return targets
}

const printPlainResults = (results: { hono: string; routes: RouteResult[] }[]): void => {
  for (const result of results) {
    console.log(`[hono ${result.hono}]`)
    const maxPathLength = Math.max(...result.routes.map(({ path }) => path.length), 0)
    for (const route of result.routes) {
      console.log(
        `  ${route.method} ${route.path.padEnd(maxPathLength)}  ${String(route.rps).padStart(8)} rps  p50 ${route.latency.p50}ms  p99 ${route.latency.p99}ms`
      )
    }
  }
}
