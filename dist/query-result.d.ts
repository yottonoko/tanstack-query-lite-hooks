import type { DefaultError, FetchNextPageOptions, FetchPreviousPageOptions, InfiniteData, InfiniteQueryObserverOptions, InfiniteQueryObserverResult, Query, QueryKey, QueryObserverOptions, QueryObserverResult, QueryState, RefetchOptions } from '@tanstack/react-query';
export type LiteQuery = Query<any, any, any, any>;
export interface LiteSelectState {
    selectFn?: ((data: any) => any) | undefined;
    selectResult?: any;
    selectError: unknown | null;
}
/** 結果の計算に必要な、フック側が保持する状態 */
export interface LiteResultContext<TQueryFnData = unknown, TError = DefaultError, TData = TQueryFnData, TQueryData = TQueryFnData, TQueryKey extends QueryKey = QueryKey> {
    query?: Query<TQueryFnData, TError, TQueryData, TQueryKey>;
    state: QueryState<TQueryData, TError>;
    queryInitialState: QueryState<TQueryData, TError>;
    options: QueryObserverOptions<TQueryFnData, TError, TData, TQueryData, TQueryKey>;
    previousResult?: QueryObserverResult<TData, TError>;
    previousResultState?: QueryState<TQueryData, TError>;
    previousResultOptions?: LiteResultContext['options'];
    lastQueryWithDefinedData?: Query<TQueryFnData, TError, TQueryData, TQueryKey>;
    selectState?: LiteSelectState;
    refetch: (options?: RefetchOptions) => Promise<QueryObserverResult<TData, TError>>;
    promise: Promise<TData>;
}
export interface LiteInfiniteResultContext<TQueryFnData = unknown, TError = DefaultError, TData = InfiniteData<TQueryFnData>, TQueryKey extends QueryKey = QueryKey, TPageParam = unknown> extends LiteResultContext<TQueryFnData, TError, TData, InfiniteData<TQueryFnData, TPageParam>, TQueryKey> {
    options: InfiniteQueryObserverOptions<TQueryFnData, TError, TData, TQueryKey, TPageParam>;
    fetchNextPage: (options?: FetchNextPageOptions) => Promise<InfiniteQueryObserverResult<TData, TError>>;
    fetchPreviousPage: (options?: FetchPreviousPageOptions) => Promise<InfiniteQueryObserverResult<TData, TError>>;
}
declare function resolveBoolean(value: unknown, query: LiteQuery | undefined): boolean | undefined;
export declare const resolveLiteBoolean: typeof resolveBoolean;
declare function resolveStaleTime(value: unknown, query: LiteQuery | undefined): number | 'static' | undefined;
export declare const resolveLiteStaleTime: typeof resolveStaleTime;
declare function staleByTime<TData = unknown, TError = DefaultError>(state: QueryState<TData, TError>, staleTime: number | 'static' | undefined): boolean;
export declare const isLiteStaleByTime: typeof staleByTime;
/** QueryObserver の結果計算を、Observer を生成せずに再現する */
export declare function createLiteQueryResult<TQueryFnData = unknown, TError = DefaultError, TData = TQueryFnData, TQueryData = TQueryFnData, TQueryKey extends QueryKey = QueryKey>(context: LiteResultContext<TQueryFnData, TError, TData, TQueryData, TQueryKey>): QueryObserverResult<TData, TError>;
/** InfiniteQueryObserver のページ状態を結果へ付加する */
export declare function createLiteInfiniteQueryResult<TQueryFnData = unknown, TError = DefaultError, TData = InfiniteData<TQueryFnData>, TQueryKey extends QueryKey = QueryKey, TPageParam = unknown>(context: LiteInfiniteResultContext<TQueryFnData, TError, TData, TQueryKey, TPageParam>): InfiniteQueryObserverResult<TData, TError>;
export declare function trackLiteResult<T extends object>(result: T, trackedProps: Set<PropertyKey>, onPropTracked?: (key: PropertyKey) => void): T;
export declare function liteResultChanged(next: Record<string, unknown>, previous: Record<string, unknown> | undefined, notifyOnChangeProps: unknown, trackedProps: Set<PropertyKey>, throwOnError: unknown): boolean;
export declare function shouldLiteThrowError(result: QueryObserverResult<any, any>, options: QueryObserverOptions, query: LiteQuery | undefined): boolean;
export {};
