import {
  focusManager,
  matchQuery,
  onlineManager,
} from '@tanstack/react-query'
import type {
  DefaultError,
  InvalidateOptions,
  InvalidateQueryFilters,
  Query,
  QueryCache,
  QueryCacheNotifyEvent,
  QueryClient,
  QueryKey,
  QueryOptions,
} from '@tanstack/react-query'

export interface LiteFetchOptions<TData = unknown> {
  cancelRefetch?: boolean
  meta?: {
    fetchMore?: { direction: 'forward' | 'backward' }
  }
  initialPromise?: Promise<TData>
}

export type AnyLiteQuery = Query<any, any, any, any>

export type LiteHashListener = (
  event: QueryCacheNotifyEvent,
) => void

export type LiteAggregateListener = (
  hash: string,
  event: QueryCacheNotifyEvent,
) => void

export interface LiteEnvironmentListener {
  onFocus?: () => void
  onOnline?: () => void
}

export interface LiteIntervalEntry {
  interval: number
  callback: () => void
  inBackground?: () => boolean
}

interface RetainedQuery {
  leases: number
}

interface SharedRetainedQuery {
  leases: number
  gcTime: number
}

interface GcCandidate {
  query: AnyLiteQuery
  deadline: number
}

interface ScheduledTimer {
  deadline: number
  callback: () => void
}

const hubs = new WeakMap<QueryClient, LiteHub>()
type InvalidationRefetchType = 'active' | 'inactive' | 'all' | 'none'

interface InvalidationContext {
  readonly filters: InvalidateQueryFilters | undefined
  readonly refetchType: InvalidationRefetchType
  readonly cancelRefetch: boolean
  readonly throwOnError: boolean
  readonly rawRefetches: Map<AnyLiteQuery, Promise<unknown>>
  readonly refetches: Map<AnyLiteQuery, Promise<unknown>>
  synchronous: boolean
}

interface InvalidationPatch {
  wrapper: QueryClient['invalidateQueries']
}

const invalidationPatches = new WeakMap<QueryClient, InvalidationPatch>()
const invalidationContexts = new WeakMap<QueryCache, InvalidationContext[]>()
interface LiteQuerySemantics {
  readonly isActive: () => boolean
  readonly isStatic: () => boolean
  readonly mayBeStatic?: boolean
}

interface LiteQueryMethodPatch {
  readonly cache: QueryCache
  readonly activeDescriptor: PropertyDescriptor | undefined
  readonly disabledDescriptor: PropertyDescriptor | undefined
  readonly nativeIsActive: AnyLiteQuery['isActive']
  readonly nativeIsDisabled: AnyLiteQuery['isDisabled']
  staticDescriptor: PropertyDescriptor | undefined
  nativeIsStatic: AnyLiteQuery['isStatic'] | undefined
  staticInstalled: boolean
}

const liteQueryLeases = new WeakMap<
  QueryCache,
  Map<AnyLiteQuery, Map<object, LiteQuerySemantics>>
>()
const liteQueryLeaseOwners = new WeakMap<
  object,
  { cache: QueryCache; query: AnyLiteQuery }
>()
const liteQueryMethodPatches = new WeakMap<AnyLiteQuery, LiteQueryMethodPatch>()
// QueryClient が異なっても同じ QueryCache/Query を使う場合は lease を共有する。
const sharedRetainedQueries = new WeakMap<
  QueryCache,
  Map<AnyLiteQuery, SharedRetainedQuery>
>()
const MAX_TIMER_DELAY = 2_147_483_647

function queryLeases(
  cache: QueryCache,
  query: AnyLiteQuery,
): Map<object, LiteQuerySemantics> | undefined {
  return liteQueryLeases.get(cache)?.get(query)
}

function isLiteActive(cache: QueryCache, query: AnyLiteQuery): boolean {
  for (const semantics of queryLeases(cache, query)?.values() ?? []) {
    if (semantics.isActive()) return true
  }
  return false
}

function isLiteStatic(cache: QueryCache, query: AnyLiteQuery): boolean {
  for (const semantics of queryLeases(cache, query)?.values() ?? []) {
    if (semantics.isStatic()) return true
  }
  return false
}

function restoreQueryMethod(
  query: AnyLiteQuery,
  name: 'isActive' | 'isDisabled' | 'isStatic',
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) Object.defineProperty(query, name, descriptor)
  else Reflect.deleteProperty(query, name)
}

function restoreQueryMethods(query: AnyLiteQuery): void {
  const patch = liteQueryMethodPatches.get(query)
  if (!patch) return
  restoreQueryMethod(query, 'isActive', patch.activeDescriptor)
  restoreQueryMethod(query, 'isDisabled', patch.disabledDescriptor)
  if (patch.staticInstalled) {
    restoreQueryMethod(query, 'isStatic', patch.staticDescriptor)
  }
  liteQueryMethodPatches.delete(query)
}

function liteQueryIsActive(this: AnyLiteQuery): boolean {
  const patch = liteQueryMethodPatches.get(this)!
  return patch.nativeIsActive.call(this) || isLiteActive(patch.cache, this)
}

function liteQueryIsDisabled(this: AnyLiteQuery): boolean {
  const patch = liteQueryMethodPatches.get(this)!
  if ((queryLeases(patch.cache, this)?.size ?? 0) > 0) {
    return !liteQueryIsActive.call(this)
  }
  return patch.nativeIsDisabled.call(this)
}

function liteQueryIsStatic(this: AnyLiteQuery): boolean {
  const patch = liteQueryMethodPatches.get(this)!
  return patch.nativeIsStatic!.call(this) || isLiteStatic(patch.cache, this)
}

function installStaticQueryMethod(
  query: AnyLiteQuery,
  patch: LiteQueryMethodPatch,
): void {
  if (patch.staticInstalled) return
  const descriptor = Object.getOwnPropertyDescriptor(query, 'isStatic')
  if (!descriptor && !Object.isExtensible(query)) {
    throw new TypeError(
      '[tanstack-query-lite-hooks] Query semantic methods cannot be installed on a non-extensible Query.',
    )
  }
  if (descriptor && descriptor.configurable !== true) {
    throw new TypeError(
      '[tanstack-query-lite-hooks] Query semantic methods require configurable own method descriptors.',
    )
  }
  const nativeIsStatic = query.isStatic
  try {
    Object.defineProperty(query, 'isStatic', {
      configurable: true,
      writable: true,
      value: liteQueryIsStatic,
    })
  } catch (error) {
    restoreQueryMethod(query, 'isStatic', descriptor)
    throw error
  }
  patch.staticDescriptor = descriptor
  patch.nativeIsStatic = nativeIsStatic
  patch.staticInstalled = true
}

function ensureQueryMethods(
  cache: QueryCache,
  query: AnyLiteQuery,
  includeStatic: boolean,
): void {
  const current = liteQueryMethodPatches.get(query)
  if (current) {
    if (includeStatic) installStaticQueryMethod(query, current)
    return
  }
  const patch: LiteQueryMethodPatch = {
    cache,
    activeDescriptor: Object.getOwnPropertyDescriptor(query, 'isActive'),
    disabledDescriptor: Object.getOwnPropertyDescriptor(query, 'isDisabled'),
    nativeIsActive: query.isActive,
    nativeIsDisabled: query.isDisabled,
    staticDescriptor: undefined,
    nativeIsStatic: undefined,
    staticInstalled: false,
  }
  if (
    (!patch.activeDescriptor || !patch.disabledDescriptor) &&
    !Object.isExtensible(query)
  ) {
    throw new TypeError(
      '[tanstack-query-lite-hooks] Query semantic methods cannot be installed on a non-extensible Query.',
    )
  }
  if (
    (patch.activeDescriptor && patch.activeDescriptor.configurable !== true) ||
    (patch.disabledDescriptor && patch.disabledDescriptor.configurable !== true)
  ) {
    throw new TypeError(
      '[tanstack-query-lite-hooks] Query semantic methods require configurable own method descriptors.',
    )
  }
  try {
    Object.defineProperties(query, {
      isActive: {
        configurable: true,
        writable: true,
        value: liteQueryIsActive,
      },
      isDisabled: {
        configurable: true,
        writable: true,
        value: liteQueryIsDisabled,
      },
    })
  } catch (error) {
    restoreQueryMethod(query, 'isActive', patch.activeDescriptor)
    restoreQueryMethod(query, 'isDisabled', patch.disabledDescriptor)
    throw error
  }
  liteQueryMethodPatches.set(query, patch)
  if (includeStatic) {
    try {
      installStaticQueryMethod(query, patch)
    } catch (error) {
      restoreQueryMethod(query, 'isActive', patch.activeDescriptor)
      restoreQueryMethod(query, 'isDisabled', patch.disabledDescriptor)
      liteQueryMethodPatches.delete(query)
      throw error
    }
  }
}

function clearLiteQueryLease(lease: object): void {
  const owner = liteQueryLeaseOwners.get(lease)
  if (!owner) return
  const queries = liteQueryLeases.get(owner.cache)
  const leases = queries?.get(owner.query)
  leases?.delete(lease)
  if (leases?.size === 0) {
    queries?.delete(owner.query)
    restoreQueryMethods(owner.query)
  }
  if (queries?.size === 0) liteQueryLeases.delete(owner.cache)
  liteQueryLeaseOwners.delete(lease)
}

function setLiteQueryLease(
  cache: QueryCache,
  query: AnyLiteQuery,
  lease: object,
  semantics: LiteQuerySemantics,
): void {
  ensureQueryMethods(
    cache,
    query,
    semantics.mayBeStatic === true,
  )
  const owner = liteQueryLeaseOwners.get(lease)
  if (owner && (owner.cache !== cache || owner.query !== query)) {
    clearLiteQueryLease(lease)
  }
  let queries = liteQueryLeases.get(cache)
  if (!queries) {
    queries = new Map()
    liteQueryLeases.set(cache, queries)
  }
  let leases = queries.get(query)
  if (!leases) {
    leases = new Map()
    queries.set(query, leases)
  }
  leases.set(lease, semantics)
  liteQueryLeaseOwners.set(lease, { cache, query })
}

function installInvalidationTracking(
  client: QueryClient,
  cache: QueryCache,
): void {
  if (invalidationPatches.has(client)) return
  const initialImplementation = client.invalidateQueries
  const patch: InvalidationPatch = {
    wrapper: undefined as unknown as QueryClient['invalidateQueries'],
  }
  const createTrackedInvalidate = (
    implementation: QueryClient['invalidateQueries'],
  ): QueryClient['invalidateQueries'] => {
    const trackedInvalidate = (
      filters?: InvalidateQueryFilters,
      options?: InvalidateOptions,
    ): Promise<void> => {
      const context: InvalidationContext = {
        filters,
        refetchType: filters?.refetchType ?? filters?.type ?? 'active',
        cancelRefetch: options?.cancelRefetch ?? true,
        throwOnError: options?.throwOnError === true,
        rawRefetches: new Map(),
        refetches: new Map(),
        synchronous: true,
      }
      let stack = invalidationContexts.get(cache)
      if (!stack) {
        stack = []
        invalidationContexts.set(cache, stack)
      }
      stack.push(context)
      let nativePromise: Promise<void>
      try {
        nativePromise = implementation.call(client, filters, options)
      } catch (error) {
        const index = stack.lastIndexOf(context)
        if (index !== -1) stack.splice(index, 1)
        if (stack.length === 0) invalidationContexts.delete(cache)
        throw error
      } finally {
        context.synchronous = false
      }
      return nativePromise
        .then(() => Promise.all(context.refetches.values()))
        .then(() => undefined)
        .finally(() => {
          const index = stack.lastIndexOf(context)
          if (index !== -1) stack.splice(index, 1)
          if (stack.length === 0) invalidationContexts.delete(cache)
        })
    }
    return trackedInvalidate as QueryClient['invalidateQueries']
  }
  patch.wrapper = createTrackedInvalidate(initialImplementation)
  Object.defineProperty(client, 'invalidateQueries', {
    configurable: true,
    enumerable: false,
    get: () => patch.wrapper,
    set: (implementation: QueryClient['invalidateQueries']) => {
      if (implementation === patch.wrapper) return
      if (typeof implementation !== 'function') {
        throw new TypeError('QueryClient.invalidateQueries must be a function')
      }
      patch.wrapper = createTrackedInvalidate(implementation)
    },
  })
  invalidationPatches.set(client, patch)
}

function delayUntil(deadline: number): number {
  return Math.min(Math.max(deadline - Date.now(), 0), MAX_TIMER_DELAY)
}

function validTimeout(value: unknown): value is number {
  return typeof value === 'number' && value >= 0 && value !== Infinity
}

function queryGcTime(query: AnyLiteQuery): number {
  const value = query.gcTime
  return typeof value === 'number' && value >= 0 ? value : 5 * 60 * 1000
}

function clearQueryGcTimeout(query: AnyLiteQuery): void {
  const candidate = query as unknown as {
    clearGcTimeout?: () => void
  }
  if (typeof candidate.clearGcTimeout !== 'function') {
    throw new Error(
      '[tanstack-query-lite-hooks] The installed TanStack Query runtime does not expose clearGcTimeout; lite query retention cannot be made safe.',
    )
  }
  candidate.clearGcTimeout()
}

function sharedRetentionMap(
  cache: QueryCache,
): Map<AnyLiteQuery, SharedRetainedQuery> {
  let retained = sharedRetainedQueries.get(cache)
  if (!retained) {
    retained = new Map()
    sharedRetainedQueries.set(cache, retained)
  }
  return retained
}

function extendGcTime(
  retained: SharedRetainedQuery,
  gcTime: number | undefined,
): void {
  if (gcTime === Infinity) {
    retained.gcTime = Infinity
  } else if (validTimeout(gcTime)) {
    retained.gcTime = Math.max(retained.gcTime, gcTime)
  }
}

function retainSharedQuery(
  cache: QueryCache,
  query: AnyLiteQuery,
  gcTime: number | undefined,
): void {
  const initialGcTime = queryGcTime(query)
  const previousGcTime = query.gcTime
  query.gcTime = Infinity
  try {
    clearQueryGcTimeout(query)
  } catch (error) {
    query.gcTime = previousGcTime
    throw error
  }
  const retainedQueries = sharedRetentionMap(cache)
  let retained = retainedQueries.get(query)
  if (!retained) {
    retained = { leases: 0, gcTime: initialGcTime }
    retainedQueries.set(query, retained)
  }
  extendGcTime(retained, gcTime)
  retained.leases += 1
}

function noteSharedGcTime(
  cache: QueryCache,
  query: AnyLiteQuery,
  gcTime: number | undefined,
): void {
  const retained = sharedRetainedQueries.get(cache)?.get(query)
  if (retained) extendGcTime(retained, gcTime)
}

function releaseSharedQuery(
  cache: QueryCache,
  query: AnyLiteQuery,
  gcTime: number | undefined,
): { remaining: boolean; gcTime: number } | undefined {
  const retainedQueries = sharedRetainedQueries.get(cache)
  const retained = retainedQueries?.get(query)
  if (!retained) return undefined
  extendGcTime(retained, gcTime)
  retained.leases -= 1
  if (retained.leases > 0) {
    query.gcTime = Infinity
    return { remaining: true, gcTime: retained.gcTime }
  }
  retainedQueries!.delete(query)
  query.gcTime = retained.gcTime
  return { remaining: false, gcTime: retained.gcTime }
}

function isSharedQueryRetained(
  cache: QueryCache,
  query: AnyLiteQuery,
): boolean {
  return (sharedRetainedQueries.get(cache)?.get(query)?.leases ?? 0) > 0
}

function forgetSharedQuery(cache: QueryCache, query: AnyLiteQuery): void {
  sharedRetainedQueries.get(cache)?.delete(query)
}

/**
 * QueryClient 単位のキャッシュ購読とタイマーをまとめる内部ハブ。
 * Lite 購読者は Query の observers 配列へ登録せず、このハブだけを購読する。
 */
export class LiteHub {
  readonly client: QueryClient
  readonly cache: QueryCache

  private cacheUnsubscribe: (() => void) | undefined
  private readonly hashListeners = new Map<
    string,
    Set<LiteHashListener>
  >()
  private readonly aggregateListeners = new Map<
    LiteAggregateListener,
    Set<string>
  >()
  private readonly retained = new Map<AnyLiteQuery, RetainedQuery>()
  private readonly gcCandidates = new Map<AnyLiteQuery, GcCandidate>()
  private readonly environmentListeners = new Set<LiteEnvironmentListener>()
  private readonly staleTimers = new Map<object, ScheduledTimer>()
  private readonly intervalTimers = new Map<
    object,
    LiteIntervalEntry & { nextAt: number }
  >()

  private focusUnsubscribe: (() => void) | undefined
  private onlineUnsubscribe: (() => void) | undefined
  private gcTimer: ReturnType<typeof setTimeout> | undefined
  private gcTimerDeadline: number | undefined
  private staleTimer: ReturnType<typeof setTimeout> | undefined
  private staleTimerDeadline: number | undefined
  private intervalTimer: ReturnType<typeof setTimeout> | undefined
  private intervalTimerDeadline: number | undefined

  constructor(client: QueryClient) {
    this.client = client
    this.cache = client.getQueryCache()
  }

  /** QueryClient の active invalidate に Lite-only refetch を合流する。 */
  runActiveInvalidation(
    query: AnyLiteQuery,
    fetch: (options: LiteFetchOptions) => Promise<unknown>,
  ): boolean | undefined {
    const contexts = invalidationContexts.get(this.cache)
    if (!contexts) return undefined
    let synchronous: InvalidationContext | undefined
    for (let index = contexts.length - 1; index >= 0; index -= 1) {
      if (contexts[index]!.synchronous) {
        synchronous = contexts[index]
        break
      }
    }
    const matching = synchronous
      ? [synchronous]
      : contexts.filter((context) => matchQuery(context.filters ?? {}, query))
    if (matching.length === 0) return undefined
    const active = matching.filter((context) => context.refetchType === 'active')
    if (active.length === 0) return false
    let request = active
      .map((context) => context.rawRefetches.get(query))
      .find((candidate) => candidate !== undefined)
    if (!request) {
      request = fetch({ cancelRefetch: active.at(-1)!.cancelRefetch })
    }
    for (const context of active) {
      if (context.refetches.has(query)) continue
      context.rawRefetches.set(query, request)
      const tracked = context.throwOnError
        ? request
        : request.catch(() => undefined)
      if (query.state.fetchStatus === 'paused') {
        void tracked.catch(() => undefined)
        context.refetches.set(query, Promise.resolve())
      } else {
        context.refetches.set(query, tracked)
      }
    }
    return true
  }

  /** キャッシュへの実購読は Hub ごとに最大一つだけ作る */
  private ensureExternalSubscriptions(): void {
    installInvalidationTracking(this.client, this.cache)
    if (!this.cacheUnsubscribe) {
      this.cacheUnsubscribe = this.cache.subscribe((event) => {
        this.onCacheEvent(event)
      })
    }

    if (!this.focusUnsubscribe) {
      this.focusUnsubscribe = focusManager.subscribe((focused) => {
        if (focused) {
          for (const listener of this.environmentListeners) {
            listener.onFocus?.()
          }
        }
      })
    }

    if (!this.onlineUnsubscribe) {
      this.onlineUnsubscribe = onlineManager.subscribe((online) => {
        if (online) {
          for (const listener of this.environmentListeners) {
            listener.onOnline?.()
          }
        }
      })
    }
  }

  private maybeReleaseExternalSubscriptions(): void {
    if (
      this.hashListeners.size !== 0 ||
      this.aggregateListeners.size !== 0 ||
      this.environmentListeners.size !== 0 ||
      this.retained.size !== 0 ||
      this.gcCandidates.size !== 0 ||
      this.intervalTimers.size !== 0 ||
      this.staleTimers.size !== 0
    ) {
      return
    }

    this.cacheUnsubscribe?.()
    this.cacheUnsubscribe = undefined
    this.focusUnsubscribe?.()
    this.focusUnsubscribe = undefined
    this.onlineUnsubscribe?.()
    this.onlineUnsubscribe = undefined
  }

  subscribeHash(hash: string, listener: LiteHashListener): () => void {
    this.ensureExternalSubscriptions()
    let listeners = this.hashListeners.get(hash)
    if (!listeners) {
      listeners = new Set()
      this.hashListeners.set(hash, listeners)
    }
    listeners.add(listener)

    return () => {
      const current = this.hashListeners.get(hash)
      current?.delete(listener)
      if (current && current.size === 0) this.hashListeners.delete(hash)
      this.maybeReleaseExternalSubscriptions()
    }
  }

  subscribeAggregate(
    hashes: Iterable<string>,
    listener: LiteAggregateListener,
  ): () => void {
    this.ensureExternalSubscriptions()
    this.aggregateListeners.set(listener, new Set(hashes))

    return () => {
      this.aggregateListeners.delete(listener)
      this.maybeReleaseExternalSubscriptions()
    }
  }

  updateAggregate(
    hashes: Iterable<string>,
    listener: LiteAggregateListener,
  ): void {
    const current = this.aggregateListeners.get(listener)
    if (current) {
      current.clear()
      for (const hash of hashes) current.add(hash)
    }
  }

  registerEnvironment(listener: LiteEnvironmentListener): () => void {
    this.ensureExternalSubscriptions()
    this.environmentListeners.add(listener)
    return () => {
      this.environmentListeners.delete(listener)
      this.maybeReleaseExternalSubscriptions()
    }
  }

  private onCacheEvent(event: QueryCacheNotifyEvent): void {
    const query = event.query
    const hash = query.queryHash

    if (event.type === 'removed') {
      this.gcCandidates.delete(query)
      this.retained.delete(query)
      forgetSharedQuery(this.cache, query)
    }

    const listeners = this.hashListeners.get(hash)
    if (listeners) {
      for (const listener of listeners) listener(event)
    }

    for (const [listener, hashes] of this.aggregateListeners) {
      if (hashes.has(hash)) listener(hash, event)
    }

    if (event.type === 'updated') {
      const candidate = this.gcCandidates.get(query)
      if (candidate && candidate.deadline <= Date.now()) {
        this.flushGcCandidate(candidate)
      }
    }
    this.scheduleGcTimer()
    this.maybeReleaseExternalSubscriptions()
  }

  /** QueryCache.build の共有入口。Query はイベント購読中にだけ作成する */
  buildQuery<
    TQueryFnData = unknown,
    TError = DefaultError,
    TData = TQueryFnData,
    TQueryKey extends QueryKey = QueryKey,
  >(
    options: QueryOptions<
      TQueryFnData,
      TError,
      TData,
      TQueryKey
    > & { queryKey: TQueryKey },
  ): Query<TQueryFnData, TError, TData, TQueryKey> {
    const defaulted = (options as { _defaulted?: boolean })._defaulted === true
      ? options
      : this.client.defaultQueryOptions(options)
    return this.cache.build(this.client, defaulted)
  }

  /** Direct Query.fetch を利用して共有 dedupe/retry/cancel を維持する */
  fetch<TData = unknown>(
    query: AnyLiteQuery,
    options?: QueryOptions<any, any, any, any>,
    fetchOptions?: LiteFetchOptions<TData>,
  ): Promise<TData> {
    return query.fetch(options, fetchOptions) as Promise<TData>
  }

  retain(query: AnyLiteQuery, gcTime?: number): void {
    installInvalidationTracking(this.client, this.cache)
    retainSharedQuery(this.cache, query, gcTime)
    let retained = this.retained.get(query)
    if (!retained) {
      retained = { leases: 0 }
      this.retained.set(query, retained)
    }
    retained.leases++
    this.gcCandidates.delete(query)
    if (this.gcCandidates.size === 0 && this.gcTimer !== undefined) {
      if (this.gcTimer !== undefined) clearTimeout(this.gcTimer)
      this.gcTimer = undefined
      this.gcTimerDeadline = undefined
    }
  }

  noteGcTime(query: AnyLiteQuery, gcTime: number | undefined): void {
    const retained = this.retained.get(query)
    if (!retained || gcTime === undefined) return
    noteSharedGcTime(this.cache, query, gcTime)
  }

  /** commit 済み Lite subscription の active/static 判定を共有する。 */
  setQuerySemantics(
    query: AnyLiteQuery,
    lease: object,
    semantics: LiteQuerySemantics,
  ): void {
    setLiteQueryLease(this.cache, query, lease, semantics)
  }

  /** この subscription が保持していた active/static 判定を解除する。 */
  clearQuerySemantics(lease: object): void {
    const owner = liteQueryLeaseOwners.get(lease)
    if (owner?.cache !== this.cache) return
    clearLiteQueryLease(lease)
  }

  release(query: AnyLiteQuery): void {
    const retained = this.retained.get(query)
    if (!retained) return
    retained.leases--
    const optionGcTime = query.options.gcTime
    const shared = releaseSharedQuery(this.cache, query, optionGcTime)
    if (retained.leases > 0) return

    this.retained.delete(query)
    if (shared && !shared.remaining && query.getObserversCount() === 0) {
      this.scheduleReleasedQuery(query, shared.gcTime)
    }
    this.maybeReleaseExternalSubscriptions()
  }

  private scheduleReleasedQuery(query: AnyLiteQuery, gcTime: number): void {
    if (!validTimeout(gcTime)) {
      this.gcCandidates.delete(query)
      return
    }
    const candidate = {
      query,
      deadline: Date.now() + gcTime,
    }
    this.gcCandidates.set(query, candidate)
    this.scheduleGcTimer(candidate.deadline)
  }

  private flushGcCandidate(candidate: GcCandidate): void {
    const { query } = candidate
    if (isSharedQueryRetained(this.cache, query)) {
      this.gcCandidates.delete(query)
      return
    }
    if (this.retained.has(query)) {
      this.gcCandidates.delete(query)
      return
    }
    if (query.getObserversCount() !== 0) {
      this.gcCandidates.delete(query)
      return
    }
    if (query.state.fetchStatus !== 'idle') {
      candidate.deadline = Date.now() + 1000
      return
    }
    this.gcCandidates.delete(query)
    if (this.cache.get(query.queryHash) === query) {
      this.cache.remove(query)
    }
  }

  private scheduleGcTimer(deadlineHint?: number): void {
    if (
      this.gcTimer !== undefined &&
      (deadlineHint === undefined ||
        (this.gcTimerDeadline !== undefined &&
          this.gcTimerDeadline <= deadlineHint))
    ) {
      return
    }
    if (this.gcTimer !== undefined) clearTimeout(this.gcTimer)
    let next: GcCandidate | undefined
    for (const candidate of this.gcCandidates.values()) {
      if (!next || candidate.deadline < next.deadline) next = candidate
    }
    if (!next) {
      this.gcTimer = undefined
      this.gcTimerDeadline = undefined
      return
    }
    const delay = delayUntil(next.deadline)
    this.gcTimerDeadline = next.deadline
    this.gcTimer = setTimeout(() => {
      this.gcTimer = undefined
      this.gcTimerDeadline = undefined
      const now = Date.now()
      for (const candidate of this.gcCandidates.values()) {
        if (candidate.deadline <= now) this.flushGcCandidate(candidate)
      }
      this.scheduleGcTimer()
      this.maybeReleaseExternalSubscriptions()
    }, delay)
  }

  scheduleStale(key: object, deadline: number, callback: () => void): void {
    this.ensureExternalSubscriptions()
    this.staleTimers.set(key, { deadline, callback })
    this.scheduleStaleTimer(deadline)
  }

  cancelStale(key: object): void {
    this.staleTimers.delete(key)
    if (this.staleTimers.size === 0 && this.staleTimer !== undefined) {
      if (this.staleTimer !== undefined) clearTimeout(this.staleTimer)
      this.staleTimer = undefined
      this.staleTimerDeadline = undefined
    }
    this.scheduleStaleTimer()
    this.maybeReleaseExternalSubscriptions()
  }

  private scheduleStaleTimer(deadlineHint?: number): void {
    if (
      this.staleTimer !== undefined &&
      (deadlineHint === undefined ||
        (this.staleTimerDeadline !== undefined &&
          this.staleTimerDeadline <= deadlineHint))
    ) {
      return
    }
    if (this.staleTimer !== undefined) clearTimeout(this.staleTimer)
    let next: ScheduledTimer | undefined
    for (const timer of this.staleTimers.values()) {
      if (!next || timer.deadline < next.deadline) next = timer
    }
    if (!next) {
      this.staleTimer = undefined
      this.staleTimerDeadline = undefined
      return
    }
    this.staleTimerDeadline = next.deadline
    this.staleTimer = setTimeout(() => {
      this.staleTimer = undefined
      this.staleTimerDeadline = undefined
      const now = Date.now()
      for (const [key, timer] of this.staleTimers) {
        if (timer.deadline <= now) {
          this.staleTimers.delete(key)
          timer.callback()
        }
      }
      this.scheduleStaleTimer()
    }, delayUntil(next.deadline))
  }

  scheduleInterval(key: object, entry: LiteIntervalEntry): void {
    this.ensureExternalSubscriptions()
    if (!validTimeout(entry.interval) || entry.interval === 0) {
      this.cancelInterval(key)
      return
    }
    const current = this.intervalTimers.get(key)
    this.intervalTimers.set(key, {
      ...entry,
      nextAt:
        current?.interval === entry.interval
          ? current.nextAt
          : Date.now() + entry.interval,
    })
    this.scheduleIntervalTimer(this.intervalTimers.get(key)?.nextAt)
  }

  cancelInterval(key: object): void {
    this.intervalTimers.delete(key)
    if (this.intervalTimers.size === 0 && this.intervalTimer !== undefined) {
      if (this.intervalTimer !== undefined) clearTimeout(this.intervalTimer)
      this.intervalTimer = undefined
      this.intervalTimerDeadline = undefined
    }
    this.scheduleIntervalTimer()
    this.maybeReleaseExternalSubscriptions()
  }

  private scheduleIntervalTimer(deadlineHint?: number): void {
    if (
      this.intervalTimer !== undefined &&
      (deadlineHint === undefined ||
        (this.intervalTimerDeadline !== undefined &&
          this.intervalTimerDeadline <= deadlineHint))
    ) {
      return
    }
    if (this.intervalTimer !== undefined) clearTimeout(this.intervalTimer)
    let nextAt: number | undefined
    for (const timer of this.intervalTimers.values()) {
      if (nextAt === undefined || timer.nextAt < nextAt) nextAt = timer.nextAt
    }
    if (nextAt === undefined) {
      this.intervalTimer = undefined
      this.intervalTimerDeadline = undefined
      return
    }
    this.intervalTimerDeadline = nextAt
    this.intervalTimer = setTimeout(() => {
      this.intervalTimer = undefined
      this.intervalTimerDeadline = undefined
      const now = Date.now()
      for (const timer of this.intervalTimers.values()) {
        if (timer.nextAt <= now) {
          timer.nextAt = now + timer.interval
          if (timer.inBackground?.() ?? true) timer.callback()
        }
      }
      this.scheduleIntervalTimer()
    }, delayUntil(nextAt))
  }

  destroy(): void {
    for (const [query, retained] of this.retained) {
      for (let lease = 0; lease < retained.leases; lease += 1) {
        releaseSharedQuery(this.cache, query, query.options.gcTime)
      }
    }
    this.cacheUnsubscribe?.()
    this.cacheUnsubscribe = undefined
    this.focusUnsubscribe?.()
    this.focusUnsubscribe = undefined
    this.onlineUnsubscribe?.()
    this.onlineUnsubscribe = undefined
    if (this.gcTimer !== undefined) clearTimeout(this.gcTimer)
    if (this.staleTimer !== undefined) clearTimeout(this.staleTimer)
    if (this.intervalTimer !== undefined) clearTimeout(this.intervalTimer)
    this.gcTimer = undefined
    this.gcTimerDeadline = undefined
    this.staleTimer = undefined
    this.staleTimerDeadline = undefined
    this.intervalTimer = undefined
    this.intervalTimerDeadline = undefined
    this.hashListeners.clear()
    this.aggregateListeners.clear()
    this.environmentListeners.clear()
    this.staleTimers.clear()
    this.intervalTimers.clear()
  }
}

export function getLiteHub(client: QueryClient): LiteHub {
  let hub = hubs.get(client)
  if (!hub) {
    hub = new LiteHub(client)
    hubs.set(client, hub)
  }
  return hub
}
