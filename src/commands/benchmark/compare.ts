import { CliError } from '../../utils/output.js'
import type { RouteResult } from './engine.js'

export const COMPARE_TARGETS = [
  'rps',
  'requests',
  'latency.avg',
  'latency.p50',
  'latency.p75',
  'latency.p99',
] as const

export type CompareTarget = (typeof COMPARE_TARGETS)[number]

export interface CompareArgs {
  file: string
  delta: number
  target: CompareTarget
}

export interface Comparison {
  target: CompareTarget
  delta: number
  baseline: number
  current: number
  slowdown: number | null
  pass: boolean
}

const isCompareTarget = (value: string): value is CompareTarget =>
  (COMPARE_TARGETS as readonly string[]).includes(value)

const invalidArgs = (message: string): CliError =>
  new CliError('INVALID_OPTION', message, {
    suggestions: [
      `Use --compare <file> [delta] [target]. delta is 0 to 1. target is one of ${COMPARE_TARGETS.join(', ')}`,
      'Put the app file before --compare: hono benchmark app.ts --compare bench/users.json',
    ],
  })

/**
 * Read `<file> [delta] [target]`. delta and target can come in any
 * order: a target name is a target, a number from 0 to 1 is a delta.
 */
export const parseCompareArgs = (args: string[]): CompareArgs => {
  const [file, ...rest] = args
  if (!file || rest.length > 2) {
    throw invalidArgs('--compare takes a file and up to two of delta and target')
  }
  let delta: number | undefined
  let target: CompareTarget | undefined
  for (const arg of rest) {
    if (target === undefined && isCompareTarget(arg)) {
      target = arg
      continue
    }
    const value = Number(arg)
    if (delta === undefined && arg.trim() !== '' && value >= 0 && value <= 1) {
      delta = value
      continue
    }
    throw invalidArgs(`Invalid --compare argument "${arg}"`)
  }
  return { file, delta: delta ?? 0, target: target ?? 'rps' }
}

const valueOf = (result: RouteResult, target: CompareTarget): number => {
  if (target === 'rps' || target === 'requests') {
    return result[target]
  }
  const key = target.slice('latency.'.length) as keyof RouteResult['latency']
  return result.latency[key]
}

/**
 * slowdown is how much slower the current run is: positive is worse,
 * negative is better, for every target. It passes when slowdown <= delta.
 */
export const compareResult = (
  baseline: RouteResult,
  current: RouteResult,
  target: CompareTarget,
  delta: number
): Comparison => {
  const before = valueOf(baseline, target)
  const after = valueOf(current, target)
  const higherIsBetter = target === 'rps' || target === 'requests'
  const slowdown =
    before === 0
      ? null
      : Math.round((higherIsBetter ? 1 - after / before : after / before - 1) * 10000) / 10000
  return {
    target,
    delta,
    baseline: before,
    current: after,
    slowdown,
    pass: slowdown === null || slowdown <= delta,
  }
}
