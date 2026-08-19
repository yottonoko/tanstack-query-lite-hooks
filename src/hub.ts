import {
  focusManager,
  onlineManager,
} from '@tanstack/react-query'
import type {
  DefaultError,
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
const MAX_TIMER_DELAY = 2_147_483_647

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

  /** キャッシュへの実購読は Hub ごとに最大一つだけ作る */
  private ensureExternalSubscriptions(): void {
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
    const defaulted = this.client.defaultQueryOptions(options)
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
    let retained = this.retained.get(query)
    if (!retained) {
      retained = {
        leases: 0,
        gcTime: queryGcTime(query),
      }
      this.retained.set(query, retained)
    }

    if (validTimeout(gcTime)) {
      retained.gcTime = Math.max(retained.gcTime, gcTime)
    } else if (gcTime === Infinity) {
      retained.gcTime = Infinity
    }
    retained.leases++
    this.gcCandidates.delete(query)
    if (this.gcCandidates.size === 0 && this.gcTimer !== undefined) {
      if (this.gcTimer !== undefined) clearTimeout(this.gcTimer)
      this.gcTimer = undefined
      this.gcTimerDeadline = undefined
    }
    clearQueryGcTimeout(query)
    query.gcTime = Infinity
  }

  noteGcTime(query: AnyLiteQuery, gcTime: number | undefined): void {
    const retained = this.retained.get(query)
    if (!retained || gcTime === undefined) return
    retained.gcTime = gcTime === Infinity
      ? Infinity
      : Math.max(retained.gcTime, gcTime)
  }

  release(query: AnyLiteQuery): void {
    const retained = this.retained.get(query)
    if (!retained) return
    retained.leases--
    if (retained.leases > 0) return

    const optionGcTime = query.options.gcTime
    if (typeof optionGcTime === 'number') {
      retained.gcTime = optionGcTime === Infinity
        ? Infinity
        : Math.max(retained.gcTime, optionGcTime)
    }
    this.retained.delete(query)
    query.gcTime = retained.gcTime
    if (query.getObserversCount() === 0) {
      this.scheduleReleasedQuery(query, retained.gcTime)
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
      query.gcTime = retained.gcTime
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
