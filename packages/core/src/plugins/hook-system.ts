/**
 * Hook System Implementation
 * 
 * Provides event-driven extensibility for plugins
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { HookSystem, HookHandler, PluginHook, HookContext } from '../types'

// Recursion guard scoped to the current async execution chain. Using
// AsyncLocalStorage (instead of a shared instance Set) means concurrent requests
// don't collide on the same flag, and an abandoned or slow handler can't wedge a
// hook for the isolate's lifetime — both real hazards now that hooks fire
// per-request in a Cloudflare Worker. Detects true re-entrancy (a hook handler
// re-triggering the same hook within its own call chain) only.
const hookExecutionStack = new AsyncLocalStorage<Set<string>>()

export class HookSystemImpl implements HookSystem {
  private hooks: Map<string, PluginHook[]> = new Map()

  /**
   * Register a hook handler
   */
  register(hookName: string, handler: HookHandler, priority: number = 10): void {
    if (!this.hooks.has(hookName)) {
      this.hooks.set(hookName, [])
    }

    const hooks = this.hooks.get(hookName)!
    const hook: PluginHook = {
      name: hookName,
      handler,
      priority,
    }

    // Insert hook in priority order (lower priority = earlier execution)
    const insertIndex = hooks.findIndex(h => h.priority! > priority)
    if (insertIndex === -1) {
      hooks.push(hook)
    } else {
      hooks.splice(insertIndex, 0, hook)
    }

    console.debug(`Hook registered: ${hookName} (priority: ${priority})`)
  }

  /**
   * Execute all handlers for a hook
   */
  async execute(hookName: string, data: any, context?: any): Promise<any> {
    const hooks = this.hooks.get(hookName)
    if (!hooks || hooks.length === 0) {
      return data
    }

    // Prevent infinite recursion — only within the SAME async execution chain.
    const stack = hookExecutionStack.getStore()
    if (stack?.has(hookName)) {
      console.warn(`Hook recursion detected for: ${hookName}`)
      return data
    }

    const nextStack = new Set(stack)
    nextStack.add(hookName)

    return hookExecutionStack.run(nextStack, async () => {
      let result = data
      let cancelled = false

      const hookContext: HookContext = {
        plugin: '', // Will be set by the plugin manager
        context: context || {},
        cancel: () => { cancelled = true }
      }

      for (const hook of hooks) {
        if (cancelled) {
          console.debug(`Hook execution cancelled: ${hookName}`)
          break
        }

        try {
          console.debug(`Executing hook: ${hookName} (priority: ${hook.priority})`)
          result = await hook.handler(result, hookContext)
        } catch (error) {
          console.error(`Hook execution failed: ${hookName}`, error)
          // Continue executing other hooks unless it's a critical error
          if (error instanceof Error && error.message.includes('CRITICAL')) {
            throw error
          }
        }
      }

      return result
    })
  }

  /**
   * Remove a hook handler
   */
  unregister(hookName: string, handler: HookHandler): void {
    const hooks = this.hooks.get(hookName)
    if (!hooks) return

    const index = hooks.findIndex(h => h.handler === handler)
    if (index !== -1) {
      hooks.splice(index, 1)
      console.debug(`Hook unregistered: ${hookName}`)
    }

    // Clean up empty hook arrays
    if (hooks.length === 0) {
      this.hooks.delete(hookName)
    }
  }

  /**
   * Get all registered hooks for a name
   */
  getHooks(hookName: string): PluginHook[] {
    return this.hooks.get(hookName) || []
  }

  /**
   * Get all registered hook names
   */
  getHookNames(): string[] {
    return Array.from(this.hooks.keys())
  }

  /**
   * Get hook statistics
   */
  getStats(): { hookName: string; handlerCount: number }[] {
    return Array.from(this.hooks.entries()).map(([hookName, handlers]) => ({
      hookName,
      handlerCount: handlers.length
    }))
  }

  /**
   * Clear all hooks (useful for testing)
   */
  clear(): void {
    this.hooks.clear()
    // No persistent execution state to clear — recursion is tracked per async
    // execution chain via AsyncLocalStorage.
  }

  /**
   * Create a scoped hook system for a plugin
   */
  createScope(_pluginName: string): ScopedHookSystem {
    return new ScopedHookSystem(this)
  }
}

/**
 * Scoped hook system for individual plugins
 */
export class ScopedHookSystem {
  private registeredHooks: { hookName: string; handler: HookHandler }[] = []

  constructor(
    private parent: HookSystemImpl
  ) {}

  /**
   * Register a hook (scoped to this plugin)
   */
  register(hookName: string, handler: HookHandler, priority?: number): void {
    this.parent.register(hookName, handler, priority)
    this.registeredHooks.push({ hookName, handler })
  }

  /**
   * Execute a hook
   */
  async execute(hookName: string, data: any, context?: any): Promise<any> {
    return this.parent.execute(hookName, data, context)
  }

  /**
   * Unregister a specific hook
   */
  unregister(hookName: string, handler: HookHandler): void {
    this.parent.unregister(hookName, handler)
    const index = this.registeredHooks.findIndex(
      h => h.hookName === hookName && h.handler === handler
    )
    if (index !== -1) {
      this.registeredHooks.splice(index, 1)
    }
  }

  /**
   * Unregister all hooks for this plugin
   */
  unregisterAll(): void {
    for (const { hookName, handler } of this.registeredHooks) {
      this.parent.unregister(hookName, handler)
    }
    this.registeredHooks.length = 0
  }

  /**
   * Get hooks registered by this plugin
   */
  getRegisteredHooks(): { hookName: string; handler: HookHandler }[] {
    return [...this.registeredHooks]
  }
}

/**
 * Hook utilities
 */
export class HookUtils {
  /**
   * Create a hook name with namespace
   */
  static createHookName(namespace: string, event: string): string {
    return `${namespace}:${event}`
  }

  /**
   * Parse a hook name to extract namespace and event
   */
  static parseHookName(hookName: string): { namespace: string; event: string } {
    const parts = hookName.split(':')
    return {
      namespace: parts[0] || '',
      event: parts.slice(1).join(':') || ''
    }
  }

  /**
   * Create a middleware that executes hooks
   */
  static createHookMiddleware(
    hookSystem: HookSystem,
    beforeHook?: string,
    afterHook?: string
  ) {
    return async (c: any, next: any) => {
      if (beforeHook) {
        const beforeData = { request: c.req, context: c }
        await hookSystem.execute(beforeHook, beforeData)
      }

      await next()

      if (afterHook) {
        const afterData = { request: c.req, response: c.res, context: c }
        await hookSystem.execute(afterHook, afterData)
      }
    }
  }

  /**
   * Create a debounced hook handler
   */
  static debounce(handler: HookHandler, delay: number): HookHandler {
    let timeoutId: any
    
    return async (data: any, context: HookContext) => {
      if (timeoutId) {
        clearTimeout(timeoutId)
      }

      return new Promise((resolve, reject) => {
        timeoutId = setTimeout(async () => {
          try {
            const result = await handler(data, context)
            resolve(result)
          } catch (error) {
            reject(error)
          }
        }, delay)
      })
    }
  }

  /**
   * Create a throttled hook handler
   */
  static throttle(handler: HookHandler, limit: number): HookHandler {
    let lastExecution = 0

    return async (data: any, context: HookContext) => {
      const now = Date.now()
      if (now - lastExecution >= limit) {
        lastExecution = now
        return handler(data, context)
      }
      return data
    }
  }
}