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
interface LiteSelectMemory {
  selectFn: ((data: any) => any) | undefined
  selectResult: any
  selectError: unknown | null
}
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
  readonly selectState: LiteSelectMemory = {
    selectFn: undefined,
    selectResult: undefined,
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
  private querySemanticsKey = {}
  private isRestoring = false
  // 未 commit の concurrent render が live subscription の callback を置き換えないよう分離する。
  private committedOptions: AnyQueryOptions
  private committedIsRestoring = false
  private committedRawResult: AnyQueryResult | undefined
  private committedPreviousResultState: AnyQuery['state'] | undefined
  private committedPreviousResultOptions: AnyQueryOptions | undefined
  private committedLastQueryWithDefinedData: AnyQuery | undefined
  private readonly committedSelectState: LiteSelectMemory = {
    selectFn: undefined,
    selectResult: undefined,
    selectError: null,
  }
  private rebinding = false
  private invalidationFetchScheduled = false

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
    this.committedOptions = options
    this.query = query ?? hub.buildQuery(options)
    this.hash = this.query.queryHash
    this.queryInitialState = this.query.state
    this.previousResult = previous?.committedRawResult ?? previous?.rawResult
    this.previousResultState = previous?.query.state
    this.previousResultOptions = previous?.options
    this.lastQueryWithDefinedData = previous?.query.state.data === undefined ? undefined : previous.query
    this.committedRawResult = previous?.committedRawResult
    this.committedPreviousResultState = previous?.committedPreviousResultState
    this.committedPreviousResultOptions = previous?.committedPreviousResultOptions
    this.committedLastQueryWithDefinedData = previous?.committedLastQueryWithDefinedData
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
    if (this.lease) {
      try {
        this.hub.clearQuerySemantics(this.querySemanticsKey)
      } finally {
        this.hub.release(previousQuery)
      }
    }
    this.query = query
    this.queryInitialState = query.state
    this.currentPromise = undefined
    this.rawResult = undefined
    this.trackedResult = undefined
    this.committedRawResult = undefined
    this.committedPreviousResultState = previousQuery.state
    this.committedPreviousResultOptions = this.committedOptions
    this.committedLastQueryWithDefinedData =
      previousQuery.state.data === undefined ? undefined : previousQuery
    this.committedSelectState.selectFn = undefined
    this.committedSelectState.selectResult = undefined
    this.committedSelectState.selectError = null
    this.resultDirty = true
    this.autoFetchAttempted = false
    this.wasAutoFetchEligible = false
    if (this.hasCommit) this.applyOptions(this.committedOptions)
    if (this.lease) {
      try {
        this.updateQuerySemantics(query)
        this.hub.retain(query, this.committedOptions.gcTime)
      } catch (error) {
        this.lease = false
        this.hub.clearQuerySemantics(this.querySemanticsKey)
        throw error
      }
    }
  }

  private applyOptions(options: AnyQueryOptions): void {
    this.query.setOptions(options)
  }

  private updateQuerySemantics(query: AnyQuery = this.query): void {
    this.hub.setQuerySemantics(query, this.querySemanticsKey, {
      isActive: () =>
        this.query === query &&
        isEnabled(this.committedOptions, query) &&
        !isSkipped(this.committedOptions),
      isStatic: () =>
        this.query === query &&
        resolveStaleTime(this.committedOptions.staleTime, query) === 'static',
      mayBeStatic:
        typeof this.committedOptions.staleTime === 'function' ||
        this.committedOptions.staleTime === 'static',
    })
  }

  private resultContext(
    options: AnyQueryOptions = this.options,
    isRestoring = this.isRestoring,
  ): LiteResultContext<any, any, any, any, any> {
    const fallback = this.query.state.data
    const promise = asPromise(
      this.currentPromise ?? this.query.promise,
      fallback,
    )
    const useOptimisticFetchState =
      !this.hasCommit &&
      !isRestoring &&
      options.subscribed !== false &&
      this.query.state.status === 'pending' &&
      this.query.state.fetchStatus === 'idle' &&
      isEnabled(options, this.query) &&
      !isSkipped(options)
    return {
      query: this.query,
      state: useOptimisticFetchState
        ? { ...this.query.state, fetchStatus: 'fetching' }
        : this.query.state,
      queryInitialState: this.queryInitialState,
      options,
      previousResult: this.rawResult,
      previousResultState: this.previousResultState,
      previousResultOptions: this.previousResultOptions,
      lastQueryWithDefinedData: this.lastQueryWithDefinedData,
      selectState: this.selectState,
      refetch: this.refetch,
      promise,
    } as LiteResultContext<any, any, any, any, any>
  }

  private computeResult(
    options: AnyQueryOptions = this.options,
    isRestoring = this.isRestoring,
  ): AnyQueryResult {
    const next = createLiteQueryResult(this.resultContext(options, isRestoring))
    this.previousResultState = this.query.state
    this.previousResultOptions = options
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

  private computeCommittedResult(): AnyQueryResult {
    const fallback = this.query.state.data
    const next = createLiteQueryResult({
      query: this.query,
      state: this.query.state,
      queryInitialState: this.queryInitialState,
      options: this.committedOptions,
      previousResult: this.committedRawResult,
      previousResultState: this.committedPreviousResultState,
      previousResultOptions: this.committedPreviousResultOptions,
      lastQueryWithDefinedData: this.committedLastQueryWithDefinedData,
      selectState: this.committedSelectState,
      refetch: this.refetch,
      promise: asPromise(
        this.currentPromise ?? this.query.promise,
        fallback,
      ),
    } as LiteResultContext<any, any, any, any, any>)
    this.committedRawResult = next
    this.committedPreviousResultState = this.query.state
    this.committedPreviousResultOptions = this.committedOptions
    if (this.query.state.data !== undefined) {
      this.committedLastQueryWithDefinedData = this.query
    }
    return next
  }

  private syncRenderResultFromCommitted(next: AnyQueryResult): void {
    this.rawResult = next
    this.previousResultState = this.committedPreviousResultState
    this.previousResultOptions = this.committedPreviousResultOptions
    this.lastQueryWithDefinedData = this.committedLastQueryWithDefinedData
    this.selectState.selectFn = this.committedSelectState.selectFn
    this.selectState.selectResult = this.committedSelectState.selectResult
    this.selectState.selectError = this.committedSelectState.selectError
  }

  private commitRenderResult(): void {
    if (!this.rawResult) return
    this.committedRawResult = this.rawResult
    this.committedPreviousResultState = this.previousResultState
    this.committedPreviousResultOptions = this.previousResultOptions
    this.committedLastQueryWithDefinedData = this.lastQueryWithDefinedData
    this.committedSelectState.selectFn = this.selectState.selectFn
    this.committedSelectState.selectResult = this.selectState.selectResult
    this.committedSelectState.selectError = this.selectState.selectError
  }

  private emitChanged(): boolean {
    this.resultDirty = true
    const previous = this.committedRawResult
    const next = this.computeCommittedResult()
    this.syncRenderResultFromCommitted(next)
    this.resultDirty = false
    const changed = liteResultChanged(
      next as unknown as Record<string, unknown>,
      previous as unknown as Record<string, unknown> | undefined,
      this.committedOptions.notifyOnChangeProps,
      this.trackedProps,
      this.committedOptions.throwOnError,
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
    const options = this.committedOptions
    const cacheEvent = event as { type?: string; query?: AnyQuery; action?: { type?: string } }
    if (cacheEvent.query && cacheEvent.query !== this.query) {
      this.rebind(cacheEvent.query)
    } else if (cacheEvent.type === 'removed' && !this.rebinding) {
      this.rebinding = true
      try {
        this.rebind(this.hub.buildQuery(this.committedOptions))
      } finally {
        this.rebinding = false
      }
    }
    const action = cacheEvent.action
    if (
      action?.type === 'invalidate' &&
      this.hasCommit &&
      !this.committedIsRestoring &&
      options.subscribed !== false &&
      isEnabled(options, this.query) &&
      !isSkipped(options) &&
      resolveStaleTime(options.staleTime, this.query) !== 'static' &&
      !this.query.isActive()
    ) {
      const handled = this.hub.runActiveInvalidation(
        this.query,
        (fetchOptions) => {
          this.autoFetchAttempted = true
          return this.runFetch(fetchOptions)
        },
      )
      if (handled === undefined) this.scheduleInvalidationFetch()
    }
    return this.emitChanged()
  }

  private scheduleInvalidationFetch(): void {
    if (this.invalidationFetchScheduled) return
    const invalidatedQuery = this.query
    this.invalidationFetchScheduled = true
    // QueryClient 自身の active/all refetch を先に開始させ、同じ invalidate の二重 fetch を避ける。
    queueMicrotask(() => {
      this.invalidationFetchScheduled = false
      if (
        this.query !== invalidatedQuery ||
        !this.hasCommit ||
        this.committedIsRestoring ||
        this.committedOptions.subscribed === false ||
        !isEnabled(this.committedOptions, invalidatedQuery) ||
        isSkipped(this.committedOptions) ||
        resolveStaleTime(
          this.committedOptions.staleTime,
          invalidatedQuery,
        ) === 'static' ||
        invalidatedQuery.isActive() ||
        invalidatedQuery.state.fetchStatus !== 'idle' ||
        !invalidatedQuery.state.isInvalidated
      ) return
      this.autoFetchAttempted = true
      void this.runFetch({ cancelRefetch: false }).catch(() => undefined)
    })
  }

  addResultListener(listener: () => void): () => void {
    this.resultListeners.add(listener)
    return () => this.resultListeners.delete(listener)
  }

  isCommittedSubscribed(): boolean {
    return !this.committedIsRestoring && this.committedOptions.subscribed !== false
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
    const options = this.committedOptions
    if (!this.hasCommit || this.committedIsRestoring || options.subscribed === false) return false
    if (!isEnabled(options, this.query) || isSkipped(options)) return false
    if (this.query.state.status === 'error' && options.retryOnMount === false) return false
    if (this.query.state.data === undefined) return true
    const policy = resolveRefetchPolicy(options.refetchOnMount, this.query)
    if (policy === 'always') return true
    if (policy === false) return false
    return isStale(options, this.query)
  }

  private runFetch(
    fetchOptions?: LiteFetchOptions,
    options: AnyQueryOptions = this.committedOptions,
  ): Promise<unknown> {
    this.applyOptions(options)
    const pending = this.hub.fetch(this.query, options, fetchOptions)
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
    if (this.query.state.data !== undefined) return undefined
    if (this.query.promise) return this.query.promise
    return this.runFetch({ cancelRefetch: false }, this.options)
  }

  afterCommit(
    options: AnyQueryOptions = this.committedOptions,
    isRestoring = this.committedIsRestoring,
  ): void {
    if (this.committedOptions !== options || this.committedIsRestoring !== isRestoring) return
    this.applyOptions(options)
    this.hasCommit = true
    const eligible =
      !isRestoring &&
      options.subscribed !== false &&
      isEnabled(options, this.query) &&
      !isSkipped(options)
    if (eligible && !this.wasAutoFetchEligible) {
      this.autoFetchAttempted = false
    }
    this.wasAutoFetchEligible = eligible
    if (eligible && !this.autoFetchAttempted) {
      this.autoFetchAttempted = true
      if (this.shouldAutoFetch()) {
        void this.runFetch({ cancelRefetch: false }).catch(() => undefined)
      }
    }
    this.configureTimers()
  }

  updateCommittedOptions(
    options: AnyQueryOptions,
    isRestoring: boolean,
  ): void {
    try {
      this.committedOptions = options
      this.committedIsRestoring = isRestoring
      this.commitRenderResult()
      this.applyOptions(options)
      if (this.hasCommit) {
        this.syncLease()
        this.hub.noteGcTime(this.query, options.gcTime)
        this.configureTimers()
      }
    } catch (error) {
      this.release()
      throw error
    }
  }

  commit(
    options: AnyQueryOptions = this.options,
    isRestoring = this.isRestoring,
    manageEnvironment = true,
  ): void {
    try {
      this.updateCommittedOptions(options, isRestoring)
      this.hasCommit = true
      this.syncLease()
      this.hub.noteGcTime(this.query, options.gcTime)
      this.environmentRelease?.()
      this.environmentRelease = undefined
      if (!isRestoring && manageEnvironment && options.subscribed !== false) {
        const environment: LiteEnvironmentListener = {
          onFocus: () => this.triggerRefetch(this.committedOptions.refetchOnWindowFocus),
          onOnline: () => this.triggerRefetch(this.committedOptions.refetchOnReconnect),
        }
        this.environmentRelease = this.hub.registerEnvironment(environment)
      }
      this.configureTimers()
    } catch (error) {
      this.release()
      throw error
    }
  }

  private syncLease(): void {
    const shouldRetain =
      this.hasCommit &&
      !this.committedIsRestoring &&
      this.committedOptions.subscribed !== false
    if (shouldRetain && !this.lease) {
      try {
        this.updateQuerySemantics()
        this.hub.retain(this.query, this.committedOptions.gcTime)
        this.lease = true
      } catch (error) {
        this.hub.clearQuerySemantics(this.querySemanticsKey)
        throw error
      }
    } else if (shouldRetain) {
      this.updateQuerySemantics()
    } else if (!shouldRetain && this.lease) {
      this.lease = false
      try {
        this.hub.clearQuerySemantics(this.querySemanticsKey)
      } finally {
        this.hub.release(this.query)
      }
    }
  }

  release(): void {
    this.hasCommit = false
    this.environmentRelease?.()
    this.environmentRelease = undefined
    this.hub.cancelStale(this.staleTimerKey)
    this.hub.cancelInterval(this.intervalTimerKey)
    if (this.lease) {
      this.lease = false
      try {
        this.hub.clearQuerySemantics(this.querySemanticsKey)
      } finally {
        this.hub.release(this.query)
      }
    }
  }

  configureTimers(): void {
    const options = this.committedOptions
    if (!this.hasCommit || this.committedIsRestoring || options.subscribed === false) {
      this.hub.cancelStale(this.staleTimerKey)
      this.hub.cancelInterval(this.intervalTimerKey)
      return
    }
    const interval = resolveInterval(options.refetchInterval, this.query)
    if (isValidTimeout(interval) && interval > 0) {
      this.hub.scheduleInterval(this.intervalTimerKey, {
        interval,
        callback: () => {
          if (
            !this.hasCommit ||
            !isEnabled(this.committedOptions, this.query) ||
            isSkipped(this.committedOptions) ||
            (this.committedOptions.refetchIntervalInBackground !== true && !focusManager.isFocused())
          ) return
          void this.runFetch({ cancelRefetch: false }).catch(() => undefined)
        },
        inBackground: () => this.committedOptions.refetchIntervalInBackground === true || focusManager.isFocused(),
      })
    } else {
      this.hub.cancelInterval(this.intervalTimerKey)
    }

    const staleTime = resolveStaleTime(options.staleTime, this.query)
    const configuredNotify = typeof options.notifyOnChangeProps === 'function'
      ? options.notifyOnChangeProps()
      : options.notifyOnChangeProps
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
    const options = this.committedOptions
    if (
      !this.hasCommit ||
      this.committedIsRestoring ||
      options.subscribed === false ||
      !isEnabled(options, this.query) ||
      isSkipped(options)
    ) return
    const policy = resolveRefetchPolicy(setting, this.query)
    if (policy === false) return
    if (policy !== 'always' && !isStale(options, this.query)) return
    void this.runFetch({ cancelRefetch: false }).catch(() => undefined)
  }

  triggerEnvironment(setting: 'focus' | 'online'): void {
    this.triggerRefetch(
      setting === 'focus'
        ? this.committedOptions.refetchOnWindowFocus
        : this.committedOptions.refetchOnReconnect,
    )
  }

  refetch = async (refetchOptions?: RefetchOptions): Promise<AnyQueryResult> => {
    if (isSkipped(this.committedOptions)) {
      throw new Error(`Missing queryFn: '${this.hash}'`)
    }
    const fetchOptions: LiteFetchOptions = {
      cancelRefetch: refetchOptions?.cancelRefetch ?? true,
    }
    try {
      await this.runFetch(fetchOptions)
    } catch (error) {
      if (refetchOptions?.throwOnError || isSkipped(this.committedOptions)) throw error
    }
    const next = this.computeCommittedResult()
    this.syncRenderResultFromCommitted(next)
    return next
  }
}

function useEntry(
  options: AnyQueryOptions,
  client: QueryClient,
  isRestoring: boolean,
): readonly [LiteQueryEntry, () => void] {
  'use no memo'
  const hub = getLiteHub(client)
  const currentQuery = hub.buildQuery(options)
  const committed = useRef<LiteQueryEntry | undefined>(undefined)
  const entry = useMemo(
    () => new LiteQueryEntry(client, hub, options, committed.current, currentQuery),
    [client, currentQuery],
  )
  entry.update(options, isRestoring)
  const markCommitted = useCallback(() => {
    committed.current = entry
  }, [entry])
  return [entry, markCommitted]
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
  const [entry, markEntryCommitted] = useEntry(defaulted, client, isRestoring)
  const subscribed = defaulted.subscribed !== false && !isRestoring
  const subscribe = useCallback(
    (listener: () => void) => entry.subscribe(listener),
    [entry, subscribed],
  )
  const getSnapshot = useCallback(() => entry.snapshot(), [entry])
  const result = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  useLayoutEffect(() => {
    entry.updateCommittedOptions(defaulted, isRestoring)
  })
  useLayoutEffect(() => {
    entry.commit(defaulted, isRestoring)
    markEntryCommitted()
    return () => entry.release()
  }, [entry, subscribed, isRestoring, markEntryCommitted])
  useEffect(() => {
    if ((defaulted as { experimental_prefetchInRender?: boolean }).experimental_prefetchInRender) {
      warnUnsupportedOption('experimental_prefetchInRender')
    }
    entry.afterCommit(defaulted, isRestoring)
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
  committedEntries: LiteQueryEntry[]
  committedHashIndexes: Map<string, number[]>
  committedEntryIndexes: Map<LiteQueryEntry, number[]>
  committedSnapshot: unknown
  committedItems: AnyQueryResult[]
  committedDirtyIndexes: Set<number>
  committedCombine: ((results: readonly AnyQueryResult[]) => unknown) | undefined
  dirtyIndexes: Set<number>
  previousCombine: ((results: readonly AnyQueryResult[]) => unknown) | undefined
  releaseEntries: LiteQueryEntry[]
  resultReleases: (() => void)[]
  environmentRelease: (() => void) | undefined
  aggregateListener: ((hash: string, event: unknown) => void) | undefined
  notifyListener: (() => void) | undefined
  processingCacheEvent: boolean
  subscribed: boolean
  committedSubscribed: boolean
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
  syncCommitted(): void
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
    committedEntries: [],
    committedHashIndexes: new Map(),
    committedEntryIndexes: new Map(),
    committedSnapshot: undefined,
    committedItems: [],
    committedDirtyIndexes: new Set(),
    committedCombine: undefined,
    dirtyIndexes: new Set<number>(),
    previousCombine: undefined,
    releaseEntries: [],
    resultReleases: [],
    environmentRelease: undefined,
    aggregateListener: undefined,
    notifyListener: undefined,
    processingCacheEvent: false,
    subscribed: true,
    committedSubscribed: true,
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
      runtime.syncCommitted()
      const releaseAggregate = runtime.hub.subscribeAggregate(
        runtime.committedEntries.map((entry) => entry.hash),
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
      runtime.committedSubscribed = runtime.subscribed
      const previousReleaseEntries = runtime.releaseEntries
      const next = new Set(runtime.entries)
      for (const entry of runtime.releaseEntries) {
        if (!next.has(entry)) entry.release()
      }
      if (!runtime.committedSubscribed) {
        for (const entry of runtime.releaseEntries) entry.release()
        runtime.releaseEntries = []
        runtime.environmentRelease?.()
        runtime.environmentRelease = undefined
        runtime.syncCommitted()
        return
      }
      const nextReleaseEntries: LiteQueryEntry[] = []
      try {
        for (const entry of runtime.entries) {
          nextReleaseEntries.push(entry)
          entry.commit(entry.options, runtime.options.isRestoring === true, false)
        }
        runtime.syncCommitted()
        runtime.environmentRelease?.()
        runtime.environmentRelease = runtime.hub.registerEnvironment({
          onFocus: () => runtime.onEnvironment('focus'),
          onOnline: () => runtime.onEnvironment('online'),
        })
      } catch (error) {
        runtime.environmentRelease?.()
        runtime.environmentRelease = undefined
        for (let index = nextReleaseEntries.length - 1; index >= 0; index--) {
          nextReleaseEntries[index]!.release()
        }
        for (let index = previousReleaseEntries.length - 1; index >= 0; index--) {
          previousReleaseEntries[index]!.release()
        }
        runtime.releaseEntries = []
        runtime.committed = false
        runtime.committedSubscribed = false
        throw error
      }
      runtime.releaseEntries = nextReleaseEntries
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
      if (!runtime.committedSubscribed) return
      for (const entry of runtime.committedEntries) entry.triggerEnvironment(setting)
    },
    onCacheEvent(hash, event) {
      const indexes = runtime.committedHashIndexes.get(hash)
      if (!indexes || indexes.length === 0) return
      for (const index of indexes) {
        const entry = runtime.committedEntries[index]!
        if (!entry.isCommittedSubscribed()) continue
        if (entry.onCacheEvent(event)) {
          runtime.committedItems[index] = entry.snapshot()
          runtime.committedDirtyIndexes.add(index)
          runtime.dirtyIndexes.add(index)
        }
      }
    },
    notifyIfChanged() {
      if (runtime.committedDirtyIndexes.size === 0 || !runtime.notifyListener) return
      const previous = runtime.committedSnapshot
      const next = runtime.committedCombine
        ? runtime.committedCombine(runtime.committedItems)
        : runtime.committedItems.slice()
      runtime.committedSnapshot = next
      runtime.committedDirtyIndexes.clear()
      if (next !== previous) runtime.notifyListener()
    },
    attachResultListeners() {
      for (const release of runtime.resultReleases) release()
      runtime.resultReleases = runtime.committedSubscribed
        ? [...new Set(runtime.committedEntries)]
          .filter((entry) => entry.isCommittedSubscribed())
          .map((entry) =>
            entry.addResultListener(() => {
              for (const index of runtime.committedEntryIndexes.get(entry) ?? []) {
                runtime.committedItems[index] = entry.snapshot()
                runtime.committedDirtyIndexes.add(index)
                runtime.dirtyIndexes.add(index)
              }
              if (!runtime.processingCacheEvent) runtime.notifyIfChanged()
            }),
          )
        : []
    },
    syncCommitted() {
      runtime.committedSubscribed = runtime.subscribed
      runtime.committedEntries = runtime.entries
      runtime.committedHashIndexes = new Map()
      runtime.committedEntryIndexes = new Map()
      runtime.committedEntries.forEach((entry, index) => {
        const indexes = runtime.committedHashIndexes.get(entry.hash)
        if (indexes) indexes.push(index)
        else runtime.committedHashIndexes.set(entry.hash, [index])
        const entryIndexes = runtime.committedEntryIndexes.get(entry)
        if (entryIndexes) entryIndexes.push(index)
        else runtime.committedEntryIndexes.set(entry, [index])
      })
      runtime.committedItems = runtime.previousItems.slice()
      runtime.committedSnapshot = runtime.previousSnapshot
      runtime.committedCombine = runtime.options.combine
      runtime.committedDirtyIndexes.clear()
      if (runtime.aggregateListener) {
        runtime.hub.updateAggregate(
          runtime.committedEntries.map((entry) => entry.hash),
          runtime.aggregateListener,
        )
      }
      runtime.attachResultListeners()
    },
  }
  return runtime
}

// options 配列だけが作り直された render では lease と polling lifecycle を維持する。
function useEntryLifecycleIdentity(
  entries: LiteQueryEntry[],
): readonly [LiteQueryEntry[], () => void] {
  'use no memo'
  const committed = useRef(entries)
  const identity =
    committed.current.length === entries.length &&
    committed.current.every((entry, index) => entry === entries[index])
      ? committed.current
      : entries
  const markCommitted = useCallback(() => {
    committed.current = identity
  }, [identity])
  return [identity, markCommitted]
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
  const entries = useMemo(() => {
    const previousEntries = previousEntriesState.current?.client === client
      ? previousEntriesState.current.entries
      : []
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
  const [lifecycleEntries, markLifecycleCommitted] = useEntryLifecycleIdentity(entries)
  const runtime = useMemo(
    () => createAggregateRuntime(client, hub),
    [client, hub, lifecycleEntries],
  )
  runtime.update(entries, { ...options, isRestoring })
  const subscribe = useCallback(
    (listener: () => void) => runtime.subscribe(listener),
    [runtime, options.subscribed, isRestoring],
  )
  const getSnapshot = useCallback(() => runtime.snapshot(), [runtime])
  const result = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  useLayoutEffect(() => {
    entries.forEach((entry, index) => {
      entry.updateCommittedOptions(defaultedQueries[index]!, isRestoring)
    })
    runtime.syncCommitted()
  }, [
    runtime,
    entries,
    defaultedQueries,
    isRestoring,
    options.combine,
    options.subscribed,
  ])
  useLayoutEffect(() => {
    runtime.commit()
    markLifecycleCommitted()
    previousEntriesState.current = { client, entries: lifecycleEntries }
    return () => runtime.release()
  }, [runtime, lifecycleEntries, options.subscribed, isRestoring, client, markLifecycleCommitted])
  useEffect(() => {
    entries.forEach((entry, index) => {
      if ((entry.options as { experimental_prefetchInRender?: boolean }).experimental_prefetchInRender) {
        warnUnsupportedOption('experimental_prefetchInRender')
      }
      entry.afterCommit(defaultedQueries[index]!, isRestoring)
    })
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
  const [entry, markEntryCommitted] = useEntry(defaulted, client, isRestoring)
  const subscribed = defaulted.subscribed !== false && !isRestoring
  const subscribe = useCallback(
    (listener: () => void) => entry.subscribe(listener),
    [entry, subscribed],
  )
  const getSnapshot = useCallback(() => entry.snapshot(), [entry])
  const result = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const pending = entry.startFetchInRender()

  useLayoutEffect(() => {
    entry.updateCommittedOptions(defaulted, isRestoring)
  })
  useLayoutEffect(() => {
    entry.commit(defaulted, isRestoring)
    markEntryCommitted()
    return () => entry.release()
  }, [entry, subscribed, isRestoring, markEntryCommitted])
  useEffect(() => {
    if ((defaulted as { experimental_prefetchInRender?: boolean }).experimental_prefetchInRender) {
      warnUnsupportedOption('experimental_prefetchInRender')
    }
    entry.afterCommit(defaulted, isRestoring)
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
  const entries = useMemo(() => {
    const previousEntries = previousEntriesState.current?.client === client
      ? previousEntriesState.current.entries
      : []
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
  const [lifecycleEntries, markLifecycleCommitted] = useEntryLifecycleIdentity(entries)
  const runtime = useMemo(
    () => createAggregateRuntime(client, hub),
    [client, hub, lifecycleEntries],
  )
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
    entries.forEach((entry, index) => {
      entry.updateCommittedOptions(defaultedQueries[index]!, isRestoring)
    })
    runtime.syncCommitted()
  }, [
    runtime,
    entries,
    defaultedQueries,
    isRestoring,
    options.combine,
    options.subscribed,
  ])
  useLayoutEffect(() => {
    runtime.commit()
    markLifecycleCommitted()
    previousEntriesState.current = { client, entries: lifecycleEntries }
    return () => runtime.release()
  }, [runtime, lifecycleEntries, aggregateSubscribed, client, markLifecycleCommitted])
  useEffect(() => {
    entries.forEach((entry, index) => {
      if ((entry.options as { experimental_prefetchInRender?: boolean }).experimental_prefetchInRender) {
        warnUnsupportedOption('experimental_prefetchInRender')
      }
      entry.afterCommit(defaultedQueries[index]!, isRestoring)
    })
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
