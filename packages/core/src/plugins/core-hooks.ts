/**
 * Core Hook Registry
 *
 * A package-level HookSystem instance that core routes execute (e.g. the
 * content lifecycle: HOOKS.CONTENT_SAVE / CONTENT_CREATE / CONTENT_UPDATE /
 * CONTENT_DELETE). Historically these hook NAMES were defined in `HOOKS` but
 * never fired by any handler — this module connects them.
 *
 * App code (and plugins) register handlers here via {@link registerHook}; the
 * content routes run them via {@link runHook}. This enables content lifecycle
 * extensions such as deriving a field before a record is written (the
 * `content:save` hook runs before create/update and its return value is
 * persisted).
 */
import { HookSystemImpl } from './hook-system'
import type { HookHandler } from '../types'

/** Shared core hook system. */
export const coreHooks = new HookSystemImpl()

/**
 * Register a core hook handler. Use the `HOOKS.*` constants for the name.
 * Lower `priority` runs earlier (default 10).
 */
export function registerHook(hookName: string, handler: HookHandler, priority?: number): void {
  coreHooks.register(hookName, handler, priority)
}

/**
 * Execute a core hook, returning the (possibly mutated) data. Returns the input
 * unchanged when no handler is registered. Individual handler errors are logged
 * and swallowed by the HookSystem (a content operation is not blocked by a
 * misbehaving hook unless it throws a `CRITICAL` error).
 */
export async function runHook<T>(hookName: string, data: T, context?: unknown): Promise<T> {
  return (await coreHooks.execute(hookName, data, context)) as T
}
