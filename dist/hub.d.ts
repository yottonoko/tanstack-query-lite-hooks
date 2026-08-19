import type { DefaultError, Query, QueryCache, QueryCacheNotifyEvent, QueryClient, QueryKey, QueryOptions } from '@tanstack/react-query';
export interface LiteFetchOptions<TData = unknown> {
    cancelRefetch?: boolean;
    meta?: {
        fetchMore?: {
            direction: 'forward' | 'backward';
        };
    };
    initialPromise?: Promise<TData>;
}
export type AnyLiteQuery = Query<any, any, any, any>;
export type LiteHashListener = (event: QueryCacheNotifyEvent) => void;
export type LiteAggregateListener = (hash: string, event: QueryCacheNotifyEvent) => void;
export interface LiteEnvironmentListener {
    onFocus?: () => void;
    onOnline?: () => void;
}
export interface LiteIntervalEntry {
    interval: number;
    callback: () => void;
    inBackground?: () => boolean;
}
interface LiteQuerySemantics {
    readonly isActive: () => boolean;
    readonly isStatic: () => boolean;
    readonly mayBeStatic?: boolean;
}
/**
 * QueryClient 単位のキャッシュ購読とタイマーをまとめる内部ハブ。
 * Lite 購読者は Query の observers 配列へ登録せず、このハブだけを購読する。
 */
export declare class LiteHub {
    readonly client: QueryClient;
    readonly cache: QueryCache;
    private cacheUnsubscribe;
    private readonly hashListeners;
    private readonly aggregateListeners;
    private readonly retained;
    private readonly gcCandidates;
    private readonly environmentListeners;
    private readonly staleTimers;
    private readonly intervalTimers;
    private focusUnsubscribe;
    private onlineUnsubscribe;
    private gcTimer;
    private gcTimerDeadline;
    private staleTimer;
    private staleTimerDeadline;
    private intervalTimer;
    private intervalTimerDeadline;
    constructor(client: QueryClient);
    /** QueryClient の active invalidate に Lite-only refetch を合流する。 */
    runActiveInvalidation(query: AnyLiteQuery, fetch: (options: LiteFetchOptions) => Promise<unknown>): boolean | undefined;
    /** キャッシュへの実購読は Hub ごとに最大一つだけ作る */
    private ensureExternalSubscriptions;
    private maybeReleaseExternalSubscriptions;
    subscribeHash(hash: string, listener: LiteHashListener): () => void;
    subscribeAggregate(hashes: Iterable<string>, listener: LiteAggregateListener): () => void;
    updateAggregate(hashes: Iterable<string>, listener: LiteAggregateListener): void;
    registerEnvironment(listener: LiteEnvironmentListener): () => void;
    private onCacheEvent;
    /** QueryCache.build の共有入口。Query はイベント購読中にだけ作成する */
    buildQuery<TQueryFnData = unknown, TError = DefaultError, TData = TQueryFnData, TQueryKey extends QueryKey = QueryKey>(options: QueryOptions<TQueryFnData, TError, TData, TQueryKey> & {
        queryKey: TQueryKey;
    }): Query<TQueryFnData, TError, TData, TQueryKey>;
    /** Direct Query.fetch を利用して共有 dedupe/retry/cancel を維持する */
    fetch<TData = unknown>(query: AnyLiteQuery, options?: QueryOptions<any, any, any, any>, fetchOptions?: LiteFetchOptions<TData>): Promise<TData>;
    retain(query: AnyLiteQuery, gcTime?: number): void;
    noteGcTime(query: AnyLiteQuery, gcTime: number | undefined): void;
    /** commit 済み Lite subscription の active/static 判定を共有する。 */
    setQuerySemantics(query: AnyLiteQuery, lease: object, semantics: LiteQuerySemantics): void;
    /** この subscription が保持していた active/static 判定を解除する。 */
    clearQuerySemantics(lease: object): void;
    release(query: AnyLiteQuery): void;
    private scheduleReleasedQuery;
    private flushGcCandidate;
    private scheduleGcTimer;
    scheduleStale(key: object, deadline: number, callback: () => void): void;
    cancelStale(key: object): void;
    private scheduleStaleTimer;
    scheduleInterval(key: object, entry: LiteIntervalEntry): void;
    cancelInterval(key: object): void;
    private scheduleIntervalTimer;
    destroy(): void;
}
export declare function getLiteHub(client: QueryClient): LiteHub;
export {};
