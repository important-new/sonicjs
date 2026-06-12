import { describe, it, expect } from 'vitest'
import { HookSystemImpl } from '../../plugins/hook-system'

describe('HookSystem recursion guard (async-execution-scoped)', () => {
  it('runs the hook on separate sequential executions', async () => {
    const hs = new HookSystemImpl()
    let calls = 0
    hs.register('content:save', async (d) => { calls++; return d })
    await hs.execute('content:save', {})
    await hs.execute('content:save', {})
    expect(calls).toBe(2)
  })

  it('runs the hook for CONCURRENT executions (the old shared-Set guard blocked these)', async () => {
    const hs = new HookSystemImpl()
    let calls = 0
    hs.register('content:save', async (d) => {
      await new Promise((r) => setTimeout(r, 5))
      calls++
      return d
    })
    await Promise.all([
      hs.execute('content:save', {}),
      hs.execute('content:save', {}),
      hs.execute('content:save', {}),
    ])
    expect(calls).toBe(3)
  })

  it('persists each execution\'s mutation independently under concurrency', async () => {
    const hs = new HookSystemImpl()
    hs.register('content:save', async (d: { n: number }) => {
      await new Promise((r) => setTimeout(r, 1))
      return { n: d.n + 1 }
    })
    const out = await Promise.all([
      hs.execute('content:save', { n: 1 }),
      hs.execute('content:save', { n: 10 }),
    ])
    expect(out.map((o) => o.n).sort((a, b) => a - b)).toEqual([2, 11])
  })

  it('still detects TRUE re-entrancy (a handler re-triggering its own hook)', async () => {
    const hs = new HookSystemImpl()
    let depth = 0
    hs.register('content:save', async (d) => {
      depth++
      if (depth < 5) await hs.execute('content:save', d) // would infinite-loop if unguarded
      return d
    })
    await hs.execute('content:save', {})
    expect(depth).toBe(1) // the nested same-hook call short-circuited
  })
})
