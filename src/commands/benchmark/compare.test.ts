import { describe, expect, it } from 'vitest'
import { CliError } from '../../utils/output.js'
import { compareResult, parseCompareArgs } from './compare.js'
import type { RouteResult } from './engine.js'

describe('parseCompareArgs', () => {
  it('should use rps and delta 0 by default', () => {
    expect(parseCompareArgs(['bench/a.json'])).toEqual({
      file: 'bench/a.json',
      delta: 0,
      target: 'rps',
    })
  })

  it('should read delta only and target only', () => {
    expect(parseCompareArgs(['a.json', '0.1'])).toMatchObject({ delta: 0.1, target: 'rps' })
    expect(parseCompareArgs(['a.json', 'latency.p99'])).toMatchObject({
      delta: 0,
      target: 'latency.p99',
    })
  })

  it('should read delta and target in any order', () => {
    const expected = { file: 'a.json', delta: 0.1, target: 'latency.p99' }
    expect(parseCompareArgs(['a.json', '0.1', 'latency.p99'])).toEqual(expected)
    expect(parseCompareArgs(['a.json', 'latency.p99', '0.1'])).toEqual(expected)
  })

  it('should accept delta 0 and 1', () => {
    expect(parseCompareArgs(['a.json', '0']).delta).toBe(0)
    expect(parseCompareArgs(['a.json', '1']).delta).toBe(1)
  })

  it.each([
    [['a.json', '1.5']],
    [['a.json', '-0.1']],
    [['a.json', '']],
    [['a.json', 'app.ts']],
    [['a.json', 'latency']],
    [['a.json', '0.1', '0.2']],
    [['a.json', 'rps', 'requests']],
    [['a.json', '0.1', 'rps', 'app.ts']],
    [[]],
  ])('should reject %j', (args) => {
    expect(() => parseCompareArgs(args)).toThrow(CliError)
  })
})

describe('compareResult', () => {
  const result = (rps: number, p99: number): RouteResult => ({
    method: 'GET',
    path: '/',
    requests: rps / 2,
    rps,
    latency: { avg: p99, p50: p99, p75: p99, p99 },
  })

  it('should count fewer rps as a slowdown', () => {
    expect(compareResult(result(100, 1), result(90, 1), 'rps', 0)).toEqual({
      target: 'rps',
      delta: 0,
      baseline: 100,
      current: 90,
      slowdown: 0.1,
      pass: false,
    })
  })

  it('should count higher latency as a slowdown', () => {
    expect(compareResult(result(100, 0.02), result(100, 0.03), 'latency.p99', 0.6)).toMatchObject({
      baseline: 0.02,
      current: 0.03,
      slowdown: 0.5,
      pass: true,
    })
  })

  it('should give a negative slowdown when it gets faster', () => {
    expect(compareResult(result(100, 1), result(110, 1), 'rps', 0)).toMatchObject({
      slowdown: -0.1,
      pass: true,
    })
    expect(compareResult(result(100, 1), result(100, 0.5), 'latency.avg', 0)).toMatchObject({
      slowdown: -0.5,
      pass: true,
    })
  })

  it('should pass when slowdown equals delta', () => {
    expect(compareResult(result(100, 1), result(90, 1), 'rps', 0.1).pass).toBe(true)
    expect(compareResult(result(100, 1), result(89, 1), 'rps', 0.1).pass).toBe(false)
  })

  it('should compare requests', () => {
    expect(compareResult(result(100, 1), result(80, 1), 'requests', 0)).toMatchObject({
      baseline: 50,
      current: 40,
      slowdown: 0.2,
    })
  })

  it('should give a null slowdown when the baseline is 0', () => {
    expect(compareResult(result(100, 0), result(100, 0.1), 'latency.p99', 0)).toMatchObject({
      slowdown: null,
      pass: true,
    })
  })
})
