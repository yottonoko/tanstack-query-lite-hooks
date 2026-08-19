import {
  focusManager,
  skipToken,
  useIsRestoring,
  useQueryClient,
} from '@tanstack/react-query'
import {
  getLiteHub,
  type AnyLiteQuery,
  type LiteEnvironmentListener,
  type LiteFetchOptions,
  type LiteHub,
} from './hub.js'
import {
  createLiteQueryResult,
  liteResultChanged,
  shouldLiteThrowError,
  trackLiteResult,
  type LiteResultContext,
} from './query-result.js'
import {
  warnUnsupportedOption,
  warnUnsupportedResultProperty,
} from './warnings.js'
import type {
  DefaultError,
  DefinedInitialDataOptions,
  DefinedUseQueryResult,
  QueryClient,
  QueryKey,
  QueryObserverOptions,
  QueryObserverResult,
  QueriesOptions,
  QueriesResults,
  RefetchOptions,
  SuspenseQueriesOptions,
  SuspenseQueriesResults,
  UndefinedInitialDataOptions,
  UseQueryOptions,
  UseQueryResult,
  UseSuspenseQueryOptions,
  UseSuspenseQueryResult,
} from '@tanstack/react-query'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react'

type AnyQueryOptions = QueryObserverOptions<any, any, any, any, any> & {
  subscribed?: boolean
}
type AnyQueryResult = QueryObserverResult<any, any>
type AnyQuery = AnyLiteQuery
const pausedSuspensePromise = new Promise<never>(() => undefined)

function resolveBoolean(value: unknown, query: AnyQuery): boolean | undefined {
  return typeof value === 'function'
    ? (value as (query: AnyQuery) => boolean)(query)
    : (value as boolean | undefined)
}

function resolveRefetchPolicy(value: unknown, query: AnyQuery): boolean | 'always' | undefined {
  return typeof value === 'function'
    ? (value as (query: AnyQuery) => boolean | 'always')(query)
    : (value as boolean | 'always' | undefined)
}

function resolveStaleTime(value: unknown, query: AnyQuery | undefined): number | 'static' | undefined {
  if (query === undefined) return typeof value === 'number' || value === 'static' ? value : undefined
  return typeof value === 'function'
    ? (value as (query: AnyQuery) => number | 'static' | undefined)(query)
    : (value as number | 'static' | undefined)
}

function resolveInterval(value: unknown, query: AnyQuery): number | false | undefined {
  return typeof value === 'function'
    ? (value as (query: AnyQuery) => number | false)(query)
    : (value as number | false | undefined)
}

function isEnabled(options: AnyQueryOptions, query: AnyQuery): boolean {
  return resolveBoolean(options.enabled, query) !== false
}

function isSkipped(options: AnyQueryOptions): boolean {
  return options.queryFn === skipToken
}

function isStale(options: AnyQueryOptions, query: AnyQuery): boolean {
  const staleTime = resolveStaleTime(options.staleTime, query)
  return query.isStaleByTime(staleTime)
}

function isValidTimeout(value: unknown): value is number {
  return typeof value === 'number' && value >= 0 && value !== Infinity
}

function defaultSuspenseOptions(
  options: AnyQueryOptions,
): AnyQueryOptions {
  const next = {
    ...options,
    enabled: true,
    placeholderData: undefined,
    suspense: true,
    throwOnError: (_error: unknown, query: AnyQuery) => query.state.data === undefined,
  } as AnyQueryOptions
  const staleTime = options.staleTime
  if (staleTime === undefined) next.staleTime = 1000
  else if (typeof staleTime === 'number') next.staleTime = Math.max(staleTime, 1000)
  if (options.gcTime !== undefined && options.gcTime !== Infinity) {
    next.gcTime = Math.max(options.gcTime, 1000)
  }
  return next
}

function asPromise<T>(value: PromiseLike<T> | undefined, fallback: T): Promise<T> {
  return value ? Promise.resolve(value) : Promise.resolve(fallback)
}

/** 一つの native Query に対する observer-free の購読状態です。 */
class LiteQueryEntry {
  readonly client: QueryClient
  readonly hub: LiteHub
  query: AnyQuery
  readonly hash: string
  queryInitialState: AnyQuery['state']
  readonly trackedProps = new Set<PropertyKey>()
  readonly selectState: { selectFn?: (data: any) => any; selectResult?: any; selectError: unknown | null } = {
    selectError: null,
  }

  options: AnyQueryOptions
  previousResult: AnyQueryResult | undefined
  previousResultState: AnyQuery['state'] | undefined
  previousResultOptions: AnyQueryOptions | undefined
  lastQueryWithDefinedData: AnyQuery | undefined
  private rawResult: AnyQueryResult | undefined
  private trackedResult: AnyQueryResult | undefined
  private resultDirty = true
  private currentPromise: Promise<unknown> | undefined
  private cacheRelease: (() => void) | undefined
  private readonly resultListeners = new Set<() => void>()
  private lease = false
  private environmentRelease: (() => void) | undefined
  private hasCommit = false
  private staleTimerKey = {}
  private intervalTimerKey = {}
  private isRestoring = false
  private rebinding = false

  constructor(
    client: QueryClient,
    hub: LiteHub,
    options: AnyQueryOptions,
    previous?: LiteQueryEntry,
    query?: AnyQuery,
  ) {
    this.client = client
    this.hub = hub
    this.options = options
    this.query = query ?? hub.buildQuery(options)
    this.hash = this.query.queryHash
    this.queryInitialState = this.query.state
    this.previousResult = previous?.rawResult
    this.previousResultState = previous?.query.state
    this.previousResultOptions = previous?.options
    this.lastQueryWithDefinedData = previous?.query.state.data === undefined ? undefined : previous.query
  }

  update(options: AnyQueryOptions, isRestoring = false): void {
    if (this.options !== options || this.isRestoring !== isRestoring) {
      this.options = options
      this.isRestoring = isRestoring
      this.resultDirty = true
    }
  }

  private rebind(query: AnyQuery): void {
    if (query === this.query) return
    const previousQuery = this.query
    this.previousResultState = previousQuery.state
    if (previousQuery.state.data !== undefined) this.lastQueryWithDefinedData = previousQuery
    if (this.lease) this.hub.release(previousQuery)
    this.query = query
    this.queryInitialState = query.state
    this.currentPromise = undefined
    this.rawResult = undefined
    this.trackedResult = undefined
    this.resultDirty = true
    this.autoFetchAttempted = false
    this.wasAutoFetchEligible = false
    if (this.hasCommit) this.applyOptions()
    if (this.lease) this.hub.retain(query, this.options.gcTime)
  }

  private applyOptions(): void {
    this.query.setOptions(this.options)
  }

  private resultContext(): LiteResultContext<any, any, any, any, any> {
    const fallback = this.query.state.data
    const promise = asPromise(
      this.currentPromise ?? this.query.promise,
      fallback,
    )
    const useOptimisticFetchState =
      !this.hasCommit &&
      !this.isRestoring &&
      this.options.subscribed !== false &&
      this.query.state.status === 'pending' &&
      this.query.state.fetchStatus === 'idle' &&
      isEnabled(this.options, this.query) &&
      !isSkipped(this.options)
    return {
      query: this.query,
      state: useOptimisticFetchState
        ? { ...this.query.state, fetchStatus: 'fetching' }
        : this.query.state,
      queryInitialState: this.queryInitialState,
      options: this.options,
      previousResult: this.rawResult,
      previousResultState: this.previousResultState,
      previousResultOptions: this.previousResultOptions,
      lastQueryWithDefinedData: this.lastQueryWithDefinedData,
      selectState: this.selectState,
      refetch: this.refetch,
      promise,
    } as LiteResultContext<any, any, any, any, any>
  }

  private computeResult(): AnyQueryResult {
    const next = createLiteQueryResult(this.resultContext())
    this.previousResultState = this.query.state
    this.previousResultOptions = this.options
    if (this.query.state.data !== undefined) this.lastQueryWithDefinedData = this.query
    this.rawResult = next
    return next
  }

  snapshot(): AnyQueryResult {
    if (!this.resultDirty && this.trackedResult) return this.trackedResult
    const previous = this.rawResult
    const raw = this.computeResult()
    this.resultDirty = false
    if (this.trackedResult && raw === previous) return this.trackedResult
    this.trackedResult = trackLiteResult(raw, this.trackedProps, (key) => {
      if (key === 'promise') warnUnsupportedResultProperty('promise')
    })
    return this.trackedResult
  }

  rawSnapshot(): AnyQueryResult {
    this.snapshot()
    return this.rawResult!
  }

  private emitChanged(): boolean {
    this.resultDirty = true
    const previous = this.rawResult
    const next = this.computeResult()
    this.resultDirty = false
    const changed = liteResultChanged(
      next as unknown as Record<string, unknown>,
      previous as unknown as Record<string, unknown> | undefined,
      this.options.notifyOnChangeProps,
      this.trackedProps,
      this.options.throwOnError,
    )
    if (changed) {
      this.trackedResult = trackLiteResult(next, this.trackedProps, (key) => {
        if (key === 'promise') warnUnsupportedResultProperty('promise')
      })
      for (const listener of this.resultListeners) listener()
    }
    return changed
  }

  onCacheEvent(event: unknown): boolean {
    const cacheEvent = event as { type?: string; query?: AnyQuery; action?: { type?: string } }
    if (cacheEvent.query && cacheEvent.query !== this.query) {
      this.rebind(cacheEvent.query)
    } else if (cacheEvent.type === 'removed' && !this.rebinding) {
      this.rebinding = true
      try {
        this.rebind(this.hub.buildQuery(this.options))
      } finally {
        this.rebinding = false
      }
    }
    const action = cacheEvent.action
    if (
      action?.type === 'invalidate' &&
      this.hasCommit &&
      !this.isRestoring &&
      this.options.subscribed !== false &&
      isEnabled(this.options, this.query) &&
      !isSkipped(this.options)
    ) {
      this.autoFetchAttempted = true
      void this.runFetch({ cancelRefetch: false }).catch(() => undefined)
    }
    return this.emitChanged()
  }

  addResultListener(listener: () => void): () => void {
    this.resultListeners.add(listener)
    return () => this.resultListeners.delete(listener)
  }

  subscribe(listener: () => void): () => void {
    if (this.isRestoring || this.options.subscribed === false) return () => undefined
    this.resultListeners.add(listener)
    if (!this.cacheRelease) {
      this.cacheRelease = this.hub.subscribeHash(this.hash, (event) => {
        this.onCacheEvent(event)
      })
    }
    return () => {
      this.resultListeners.delete(listener)
      if (this.resultListeners.size === 0) {
        this.cacheRelease?.()
        this.cacheRelease = undefined
      }
    }
  }

  private autoFetchAttempted = false
  private wasAutoFetchEligible = false

  private shouldAutoFetch(): boolean {
    if (!this.hasCommit || this.isRestoring || this.options.subscribed === false) return false
    if (!isEnabled(this.options, this.query) || isSkipped(this.options)) return false
    if (this.query.state.status === 'error' && this.options.retryOnMount === false) return false
    if (this.query.state.data === undefined) return true
    const policy = resolveRefetchPolicy(this.options.refetchOnMount, this.query)
    if (policy === 'always') return true
    if (policy === false) return false
    return isStale(this.options, this.query)
  }

  private runFetch(fetchOptions?: LiteFetchOptions): Promise<unknown> {
    this.applyOptions()
    const pending = this.hub.fetch(this.query, this.options, fetchOptions)
    this.currentPromise = pending
    void pending.then(
      () => {
        if (this.currentPromise === pending) this.currentPromise = undefined
      },
      () => {
        if (this.currentPromise === pending) this.currentPromise = undefined
      },
    )
    return pending
  }

  startFetchInRender(): Promise<unknown> | undefined {
    if (
      this.isRestoring ||
      this.options.subscribed === false ||
      isSkipped(this.options) ||
      !isEnabled(this.options, this.query)
    ) return undefined
    if (this.query.state.status === 'error' && this.query.state.fetchStatus === 'idle') {
      return undefined
    }
    if (this.query.state.data !== undefined) {
      if (this.query.promise) return undefined
      if (!isStale(this.options, this.query)) return undefined
      void this.runFetch({ cancelRefetch: false }).catch(() => undefined)
      return undefined
    }
    if (this.query.promise) return this.query.promise
    return this.runFetch({ cancelRefetch: false })
  }

  afterCommit(): void {
    this.applyOptions()
    this.hasCommit = true
    const eligible = !this.isRestoring && isEnabled(this.options, this.query) && !isSkipped(this.options)
    if (eligible && !this.wasAutoFetchEligible) {
      this.autoFetchAttempted = false
    }
    this.wasAutoFetchEligible = eligible
    if (!this.autoFetchAttempted && this.shouldAutoFetch()) {
      this.autoFetchAttempted = true
      void this.runFetch({ cancelRefetch: false }).catch(() => undefined)
    }
    this.configureTimers()
  }

  commit(manageEnvironment = true): void {
    this.applyOptions()
    this.hasCommit = true
    if (!this.isRestoring && this.options.subscribed !== false && !this.lease) {
      this.lease = true
      this.hub.retain(this.query, this.options.gcTime)
    }
    this.hub.noteGcTime(this.query, this.options.gcTime)
    this.environmentRelease?.()
    this.environmentRelease = undefined
    if (!this.isRestoring && manageEnvironment && this.options.subscribed !== false) {
      const environment: LiteEnvironmentListener = {
        onFocus: () => this.triggerRefetch(this.options.refetchOnWindowFocus),
        onOnline: () => this.triggerRefetch(this.options.refetchOnReconnect),
      }
      this.environmentRelease = this.hub.registerEnvironment(environment)
    }
    this.configureTimers()
  }

  release(): void {
    this.hasCommit = false
    this.environmentRelease?.()
    this.environmentRelease = undefined
    this.hub.cancelStale(this.staleTimerKey)
    this.hub.cancelInterval(this.intervalTimerKey)
    if (this.lease) {
      this.lease = false
      this.hub.release(this.query)
    }
  }

  configureTimers(): void {
    if (!this.hasCommit || this.isRestoring || this.options.subscribed === false) {
      this.hub.cancelStale(this.staleTimerKey)
      this.hub.cancelInterval(this.intervalTimerKey)
      return
    }
    const interval = resolveInterval(this.options.refetchInterval, this.query)
    if (isValidTimeout(interval) && interval > 0) {
      this.hub.scheduleInterval(this.intervalTimerKey, {
        interval,
        callback: () => {
          if (
            !this.hasCommit ||
            !isEnabled(this.options, this.query) ||
            isSkipped(this.options) ||
            (this.options.refetchIntervalInBackground !== true && !focusManager.isFocused())
          ) return
          void this.runFetch({ cancelRefetch: false }).catch(() => undefined)
        },
        inBackground: () => this.options.refetchIntervalInBackground === true || focusManager.isFocused(),
      })
    } else {
      this.hub.cancelInterval(this.intervalTimerKey)
    }

    const staleTime = resolveStaleTime(this.options.staleTime, this.query)
    const configuredNotify = typeof this.options.notifyOnChangeProps === 'function'
      ? this.options.notifyOnChangeProps()
      : this.options.notifyOnChangeProps
    const tracksStale = configuredNotify === 'all' ||
      (Array.isArray(configuredNotify) && configuredNotify.includes('isStale')) ||
      this.trackedProps.has('isStale')
    if (
      tracksStale &&
      this.query.state.data !== undefined &&
      typeof staleTime === 'number' &&
      isValidTimeout(staleTime) &&
      !this.query.state.isInvalidated
    ) {
      this.hub.scheduleStale(
        this.staleTimerKey,
        this.query.state.dataUpdatedAt + staleTime + 1,
        () => this.emitChanged(),
      )
    } else {
      this.hub.cancelStale(this.staleTimerKey)
    }
  }

  triggerRefetch(setting: unknown): void {
    if (
      !this.hasCommit ||
      this.isRestoring ||
      this.options.subscribed === false ||
      !isEnabled(this.options, this.query) ||
      isSkipped(this.options)
    ) return
    const policy = resolveRefetchPolicy(setting, this.query)
    if (policy === false) return
    if (policy !== 'always' && !isStale(this.options, this.query)) return
    void this.runFetch({ cancelRefetch: false }).catch(() => undefined)
  }

  refetch = async (refetchOptions?: RefetchOptions): Promise<AnyQueryResult> => {
    if (isSkipped(this.options)) {
      throw new Error(`Missing queryFn: '${this.hash}'`)
    }
    const fetchOptions: LiteFetchOptions = {
      cancelRefetch: refetchOptions?.cancelRefetch ?? true,
    }
    try {
      await this.runFetch(fetchOptions)
    } catch (error) {
      if (refetchOptions?.throwOnError || isSkipped(this.options)) throw error
    }
    return this.snapshot()
  }
}

function useEntry(
  options: AnyQueryOptions,
  client: QueryClient,
  isRestoring: boolean,
): LiteQueryEntry {
  'use no memo'
  const hub = getLiteHub(client)
  const currentQuery = hub.buildQuery(options)
  const previous = useRef<LiteQueryEntry | undefined>(undefined)
  const entry = useMemo(
    () => new LiteQueryEntry(client, hub, options, previous.current, currentQuery),
    [client, currentQuery],
  )
  entry.update(options, isRestoring)
  previous.current = entry
  return entry
}

/** 通常の query を native QueryCache へ直接つなぐ hook です。 */
export function useQueryLite<
  TQueryFnData = unknown,
  TError = DefaultError,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(options: DefinedInitialDataOptions<TQueryFnData, TError, TData, TQueryKey>, queryClient?: QueryClient): DefinedUseQueryResult<NoInfer<TData>, TError>
export function useQueryLite<
  TQueryFnData = unknown,
  TError = DefaultError,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(options: UndefinedInitialDataOptions<TQueryFnData, TError, TData, TQueryKey>, queryClient?: QueryClient): UseQueryResult<NoInfer<TData>, TError>
export function useQueryLite<
  TQueryFnData = unknown,
  TError = DefaultError,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(options: UseQueryOptions<TQueryFnData, TError, TData, TQueryKey>, queryClient?: QueryClient): UseQueryResult<NoInfer<TData>, TError>
export function useQueryLite(options: any, explicitClient?: QueryClient): AnyQueryResult {
  'use no memo'
  const client = useQueryClient(explicitClient)
  const isRestoring = useIsRestoring()
  const defaulted = client.defaultQueryOptions(options) as AnyQueryOptions
  const entry = useEntry(defaulted, client, isRestoring)
  const subscribed = defaulted.subscribed !== false && !isRestoring
  const subscribe = useCallback(
    (listener: () => void) => entry.subscribe(listener),
    [entry, subscribed],
  )
  const getSnapshot = useCallback(() => entry.snapshot(), [entry])
  const result = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  useLayoutEffect(() => {
    entry.commit()
    return () => entry.release()
  }, [entry, subscribed])
  useEffect(() => {
    if ((defaulted as { experimental_prefetchInRender?: boolean }).experimental_prefetchInRender) {
      warnUnsupportedOption('experimental_prefetchInRender')
    }
    entry.afterCommit()
  })

  const rawResult = entry.rawSnapshot()
  if (shouldLiteThrowError(rawResult, defaulted, entry.query)) throw rawResult.error
  return result
}

interface LiteAggregateRuntime {
  readonly client: QueryClient
  readonly hub: LiteHub
  entries: LiteQueryEntry[]
  hashIndexes: Map<string, number[]>
  options: {
    combine?: ((results: readonly AnyQueryResult[]) => unknown) | undefined
    subscribed?: boolean | undefined
    isRestoring?: boolean | undefined
  }
  previousSnapshot: unknown
  previousItems: AnyQueryResult[]
  dirtyIndexes: Set<number>
  previousCombine: ((results: readonly AnyQueryResult[]) => unknown) | undefined
  releaseEntries: LiteQueryEntry[]
  resultReleases: (() => void)[]
  environmentRelease: (() => void) | undefined
  aggregateListener: ((hash: string, event: unknown) => void) | undefined
  notifyListener: (() => void) | undefined
  processingCacheEvent: boolean
  subscribed: boolean
  committed: boolean
  subscribe(listener: () => void): () => void
  update(entries: LiteQueryEntry[], options: LiteAggregateRuntime['options']): void
  snapshot(): unknown
  commit(): void
  release(): void
  onEnvironment(setting: 'focus' | 'online'): void
  onCacheEvent(hash: string, event: unknown): void
  notifyIfChanged(): void
  attachResultListeners(): void
}

function createAggregateRuntime(client: QueryClient, hub: LiteHub): LiteAggregateRuntime {
  const runtime: LiteAggregateRuntime = {
    client,
    hub,
    entries: [],
    hashIndexes: new Map(),
    options: {},
    previousSnapshot: undefined,
    previousItems: [],
    dirtyIndexes: new Set<number>(),
    previousCombine: undefined,
    releaseEntries: [],
    resultReleases: [],
    environmentRelease: undefined,
    aggregateListener: undefined,
    notifyListener: undefined,
    processingCacheEvent: false,
    subscribed: true,
    committed: false,
    subscribe(listener) {
      if (!runtime.subscribed) return () => undefined
      runtime.notifyListener = listener
      runtime.aggregateListener = (hash, event) => {
        runtime.processingCacheEvent = true
        try {
          runtime.onCacheEvent(hash, event)
        } finally {
          runtime.processingCacheEvent = false
        }
        runtime.notifyIfChanged()
      }
      runtime.attachResultListeners()
      const releaseAggregate = runtime.hub.subscribeAggregate(
        runtime.entries.map((entry) => entry.hash),
        runtime.aggregateListener,
      )
      return () => {
        releaseAggregate()
        for (const release of runtime.resultReleases) release()
        runtime.resultReleases = []
        if (runtime.notifyListener === listener) runtime.notifyListener = undefined
      }
    },
    update(entries, options) {
      const nextSubscribed = options.subscribed !== false && options.isRestoring !== true
      if (
        runtime.entries === entries &&
        runtime.options.combine === options.combine &&
        runtime.subscribed === nextSubscribed
      ) return
      const previousEntries = runtime.entries
      const entriesChanged = previousEntries !== entries
      runtime.entries = entries
      runtime.hashIndexes = new Map()
      entries.forEach((entry, index) => {
        const indexes = runtime.hashIndexes.get(entry.hash)
        if (indexes) indexes.push(index)
        else runtime.hashIndexes.set(entry.hash, [index])
      })
      runtime.options = options
      runtime.subscribed = nextSubscribed
      runtime.dirtyIndexes.clear()
      for (let index = 0; index < entries.length; index++) {
        if (
          entriesChanged ||
          entries[index]?.options.subscribed === false
        ) runtime.dirtyIndexes.add(index)
      }
      if (runtime.previousCombine !== options.combine) {
        runtime.previousCombine = options.combine
        for (let index = 0; index < entries.length; index++) runtime.dirtyIndexes.add(index)
      }
      if (runtime.committed) {
        if (runtime.aggregateListener) {
          runtime.hub.updateAggregate(entries.map((entry) => entry.hash), runtime.aggregateListener)
        }
        runtime.attachResultListeners()
      }
    },
    snapshot() {
      if (runtime.previousSnapshot !== undefined && runtime.dirtyIndexes.size === 0) {
        return runtime.previousSnapshot
      }
      const items = runtime.previousItems.length === runtime.entries.length
        ? runtime.previousItems
        : Array.from<AnyQueryResult>({ length: runtime.entries.length })
      for (const index of runtime.dirtyIndexes) items[index] = runtime.entries[index]!.snapshot()
      for (let index = 0; index < runtime.entries.length; index++) {
        if (items[index] === undefined) items[index] = runtime.entries[index]!.snapshot()
      }
      runtime.dirtyIndexes.clear()
      runtime.previousItems = items
      runtime.previousSnapshot = runtime.options.combine
        ? runtime.options.combine(items)
        : items.slice()
      return runtime.previousSnapshot
    },
    commit() {
      runtime.committed = true
      const next = new Set(runtime.entries)
      for (const entry of runtime.releaseEntries) {
        if (!next.has(entry)) entry.release()
      }
      if (!runtime.subscribed) {
        for (const entry of runtime.releaseEntries) entry.release()
        runtime.releaseEntries = []
        runtime.environmentRelease?.()
        runtime.environmentRelease = undefined
        runtime.attachResultListeners()
        return
      }
      runtime.releaseEntries = [...runtime.entries]
      for (const entry of runtime.entries) entry.commit(false)
      runtime.attachResultListeners()
      runtime.environmentRelease?.()
      runtime.environmentRelease = runtime.hub.registerEnvironment({
        onFocus: () => runtime.onEnvironment('focus'),
        onOnline: () => runtime.onEnvironment('online'),
      })
    },
    release() {
      runtime.committed = false
      runtime.environmentRelease?.()
      runtime.environmentRelease = undefined
      for (const release of runtime.resultReleases) release()
      runtime.resultReleases = []
      for (const entry of runtime.releaseEntries) entry.release()
      runtime.releaseEntries = []
    },
    onEnvironment(setting) {
      if (!runtime.subscribed) return
      for (const entry of runtime.entries) {
        entry.triggerRefetch(setting === 'focus' ? entry.options.refetchOnWindowFocus : entry.options.refetchOnReconnect)
      }
    },
    onCacheEvent(hash, event) {
      const indexes = runtime.hashIndexes.get(hash)
      if (!indexes || indexes.length === 0) return
      for (const index of indexes) {
        const entry = runtime.entries[index]!
        if (entry.options.subscribed === false) continue
        if (entry.onCacheEvent(event)) runtime.dirtyIndexes.add(index)
      }
    },
    notifyIfChanged() {
      if (runtime.dirtyIndexes.size === 0 || !runtime.notifyListener) return
      const previous = runtime.previousSnapshot
      const next = runtime.snapshot()
      if (next !== previous) runtime.notifyListener()
    },
    attachResultListeners() {
      for (const release of runtime.resultReleases) release()
      runtime.resultReleases = runtime.subscribed
        ? [...new Set(runtime.entries)]
          .filter((entry) => entry.options.subscribed !== false)
          .map((entry) =>
            entry.addResultListener(() => {
              for (const index of runtime.hashIndexes.get(entry.hash) ?? []) {
                runtime.dirtyIndexes.add(index)
              }
              if (!runtime.processingCacheEvent) runtime.notifyIfChanged()
            }),
          )
        : []
    },
  }
  return runtime
}

/** 複数 query を一つの aggregate subscription で購読する hook です。 */
export function useQueriesLite<
  T extends Array<any>,
  TCombinedResult = QueriesResults<T>,
>(options: {
  queries: readonly [...QueriesOptions<T>]
  combine?: (result: QueriesResults<T>) => TCombinedResult
  subscribed?: boolean
}, queryClient?: QueryClient): TCombinedResult
export function useQueriesLite(
  options: any,
  explicitClient?: QueryClient,
): unknown {
  'use no memo'
  const client = useQueryClient(explicitClient)
  const isRestoring = useIsRestoring()
  const defaultedQueries: AnyQueryOptions[] = useMemo(
    () => options.queries.map((query: AnyQueryOptions) =>
      client.defaultQueryOptions(query) as AnyQueryOptions,
    ),
    [client, options.queries],
  )
  const hub = getLiteHub(client)
  const previousEntriesState = useRef<{
    client: QueryClient
    entries: LiteQueryEntry[]
  } | undefined>(undefined)
  if (!previousEntriesState.current || previousEntriesState.current.client !== client) {
    previousEntriesState.current = { client, entries: [] }
  }
  const entries = useMemo(() => {
    const previousEntries = previousEntriesState.current!.entries
    const previousByHash = new Map<string, LiteQueryEntry[]>()
    for (let index = previousEntries.length - 1; index >= 0; index -= 1) {
      const entry = previousEntries[index]!
      const bucket = previousByHash.get(entry.hash)
      if (bucket) bucket.push(entry)
      else previousByHash.set(entry.hash, [entry])
    }
    return defaultedQueries.map((query) => {
      const hash = query.queryHash!
      const currentQuery = hub.buildQuery(query)
      const previous = previousByHash.get(hash)?.pop()
      const entry = previous?.query === currentQuery
        ? previous
        : new LiteQueryEntry(client, hub, query, previous, currentQuery)
      entry.update(query, isRestoring)
      return entry
    })
  }, [client, defaultedQueries, hub, isRestoring])
  previousEntriesState.current.entries = entries
  const runtime = useMemo(() => createAggregateRuntime(client, hub), [client, hub])
  runtime.update(entries, { ...options, isRestoring })
  const subscribe = useCallback(
    (listener: () => void) => runtime.subscribe(listener),
    [runtime, options.subscribed, isRestoring],
  )
  const getSnapshot = useCallback(() => runtime.snapshot(), [runtime])
  const result = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  useLayoutEffect(() => {
    runtime.commit()
    return () => runtime.release()
  }, [runtime, entries, options.subscribed, isRestoring])
  useEffect(() => {
    for (const entry of entries) {
      if ((entry.options as { experimental_prefetchInRender?: boolean }).experimental_prefetchInRender) {
        warnUnsupportedOption('experimental_prefetchInRender')
      }
      entry.afterCommit()
    }
  })

  return result
}

/** Suspense query の result を返す hook です。 */
export function useSuspenseQueryLite<
  TQueryFnData = unknown,
  TError = DefaultError,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(options: UseSuspenseQueryOptions<TQueryFnData, TError, TData, TQueryKey>, queryClient?: QueryClient): UseSuspenseQueryResult<TData, TError> {
  'use no memo'
  const client = useQueryClient(queryClient)
  const isRestoring = useIsRestoring()
  const defaulted = defaultSuspenseOptions(
    client.defaultQueryOptions(options as AnyQueryOptions) as AnyQueryOptions,
  )
  const entry = useEntry(defaulted, client, isRestoring)
  const subscribed = defaulted.subscribed !== false && !isRestoring
  const subscribe = useCallback(
    (listener: () => void) => entry.subscribe(listener),
    [entry, subscribed],
  )
  const getSnapshot = useCallback(() => entry.snapshot(), [entry])
  const result = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const pending = entry.startFetchInRender()

  useLayoutEffect(() => {
    entry.commit()
    return () => entry.release()
  }, [entry, subscribed])
  useEffect(() => {
    if ((defaulted as { experimental_prefetchInRender?: boolean }).experimental_prefetchInRender) {
      warnUnsupportedOption('experimental_prefetchInRender')
    }
    entry.afterCommit()
  })

  if (
    (isRestoring || defaulted.subscribed === false) &&
    entry.query.state.data === undefined
  ) throw pausedSuspensePromise
  if (pending) throw pending
  const rawResult = entry.rawSnapshot()
  if (shouldLiteThrowError(rawResult, defaulted, entry.query)) throw rawResult.error
  return result as UseSuspenseQueryResult<TData, TError>
}

/** 複数 Suspense query を同じ render で開始する hook です。 */
export function useSuspenseQueriesLite<
  T extends Array<any>,
  TCombinedResult = SuspenseQueriesResults<T>,
>(options: {
  queries: readonly [...SuspenseQueriesOptions<T>]
  combine?: (result: SuspenseQueriesResults<T>) => TCombinedResult
}, queryClient?: QueryClient): TCombinedResult
export function useSuspenseQueriesLite(
  options: any,
  explicitClient?: QueryClient,
): unknown {
  'use no memo'
  const client = useQueryClient(explicitClient)
  const isRestoring = useIsRestoring()
  const defaultedQueries: AnyQueryOptions[] = useMemo(
    () => options.queries.map((query: AnyQueryOptions) =>
      defaultSuspenseOptions(client.defaultQueryOptions(query) as AnyQueryOptions),
    ),
    [client, options.queries],
  )
  const hub = getLiteHub(client)
  const previousEntriesState = useRef<{
    client: QueryClient
    entries: LiteQueryEntry[]
  } | undefined>(undefined)
  if (!previousEntriesState.current || previousEntriesState.current.client !== client) {
    previousEntriesState.current = { client, entries: [] }
  }
  const entries = useMemo(() => {
    const previousEntries = previousEntriesState.current!.entries
    const previousByHash = new Map<string, LiteQueryEntry[]>()
    for (let index = previousEntries.length - 1; index >= 0; index -= 1) {
      const entry = previousEntries[index]!
      const bucket = previousByHash.get(entry.hash)
      if (bucket) bucket.push(entry)
      else previousByHash.set(entry.hash, [entry])
    }
    return defaultedQueries.map((query) => {
      const hash = query.queryHash!
      const currentQuery = hub.buildQuery(query)
      const previous = previousByHash.get(hash)?.pop()
      const entry = previous?.query === currentQuery
        ? previous
        : new LiteQueryEntry(client, hub, query, previous, currentQuery)
      entry.update(query, isRestoring)
      return entry
    })
  }, [client, defaultedQueries, hub, isRestoring])
  previousEntriesState.current.entries = entries
  const runtime = useMemo(() => createAggregateRuntime(client, hub), [client, hub])
  runtime.update(entries, { ...options, isRestoring })
  const aggregateSubscribed = options.subscribed !== false && !isRestoring
  const subscribe = useCallback(
    (listener: () => void) => runtime.subscribe(listener),
    [runtime, aggregateSubscribed],
  )
  const getSnapshot = useCallback(() => runtime.snapshot(), [runtime])
  const result = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const pending = entries
    .map((entry) => entry.startFetchInRender())
    .filter((promise): promise is Promise<unknown> => promise !== undefined)

  useLayoutEffect(() => {
    runtime.commit()
    return () => runtime.release()
  }, [runtime, entries, aggregateSubscribed])
  useEffect(() => {
    for (const entry of entries) {
      if ((entry.options as { experimental_prefetchInRender?: boolean }).experimental_prefetchInRender) {
        warnUnsupportedOption('experimental_prefetchInRender')
      }
      entry.afterCommit()
    }
  })

  if (
    (isRestoring || entries.some((entry) => entry.options.subscribed === false)) &&
    entries.some((entry) => entry.query.state.data === undefined)
  ) throw pausedSuspensePromise
  if (pending.length > 0) throw Promise.all(pending)
  for (const entry of entries) {
    const current = entry.rawSnapshot()
    if (shouldLiteThrowError(current, entry.options, entry.query)) throw current.error
  }
  return result
}

export { useQueryClient }
