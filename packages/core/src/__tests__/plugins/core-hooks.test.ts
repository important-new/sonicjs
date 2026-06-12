import { describe, it, expect } from 'vitest'
import { coreHooks, registerHook, runHook } from '../../plugins/core-hooks'

describe('core hook registry', () => {
  it('returns the input unchanged when no handler is registered', async () => {
    const data = { title: 'A', data: {} }
    expect(await runHook('test:noop', data)).toBe(data)
  })

  it('runs a registered handler and persists its mutation (content:save contract)', async () => {
    const handler = async (record: any) => ({
      ...record,
      data: { ...record.data, ogImage: `/cms-media/og/${record.slug}.png` },
    })
    registerHook('test:save', handler)
    try {
      const out = await runHook('test:save', { slug: 'hello', data: { title: 'Hello' } })
      expect(out.data.ogImage).toBe('/cms-media/og/hello.png')
      expect(out.data.title).toBe('Hello') // existing fields preserved
    } finally {
      coreHooks.unregister('test:save', handler)
    }
  })

  it('chains multiple handlers, threading each result into the next', async () => {
    const h1 = async (n: number) => n + 1
    const h2 = async (n: number) => n * 10
    registerHook('test:chain', h1)
    registerHook('test:chain', h2)
    try {
      // (1 + 1) * 10
      expect(await runHook('test:chain', 1)).toBe(20)
    } finally {
      coreHooks.unregister('test:chain', h1)
      coreHooks.unregister('test:chain', h2)
    }
  })

  it('isolates handlers by hook name', async () => {
    const handler = async (s: string) => s + '!'
    registerHook('test:only-this', handler)
    try {
      expect(await runHook('test:other', 'x')).toBe('x')
    } finally {
      coreHooks.unregister('test:only-this', handler)
    }
  })
})
