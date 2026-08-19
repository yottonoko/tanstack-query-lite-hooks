import { useQueryClient } from '@tanstack/react-query';
import type { DefaultError, DefinedInitialDataOptions, DefinedUseQueryResult, QueryClient, QueryKey, QueriesOptions, QueriesResults, SuspenseQueriesOptions, SuspenseQueriesResults, UndefinedInitialDataOptions, UseQueryOptions, UseQueryResult, UseSuspenseQueryOptions, UseSuspenseQueryResult } from '@tanstack/react-query';
/** 通常の query を native QueryCache へ直接つなぐ hook です。 */
export declare function useQueryLite<TQueryFnData = unknown, TError = DefaultError, TData = TQueryFnData, TQueryKey extends QueryKey = QueryKey>(options: DefinedInitialDataOptions<TQueryFnData, TError, TData, TQueryKey>, queryClient?: QueryClient): DefinedUseQueryResult<NoInfer<TData>, TError>;
export declare function useQueryLite<TQueryFnData = unknown, TError = DefaultError, TData = TQueryFnData, TQueryKey extends QueryKey = QueryKey>(options: UndefinedInitialDataOptions<TQueryFnData, TError, TData, TQueryKey>, queryClient?: QueryClient): UseQueryResult<NoInfer<TData>, TError>;
export declare function useQueryLite<TQueryFnData = unknown, TError = DefaultError, TData = TQueryFnData, TQueryKey extends QueryKey = QueryKey>(options: UseQueryOptions<TQueryFnData, TError, TData, TQueryKey>, queryClient?: QueryClient): UseQueryResult<NoInfer<TData>, TError>;
/** 複数 query を一つの aggregate subscription で購読する hook です。 */
export declare function useQueriesLite<T extends Array<any>, TCombinedResult = QueriesResults<T>>(options: {
    queries: readonly [...QueriesOptions<T>];
    combine?: (result: QueriesResults<T>) => TCombinedResult;
    subscribed?: boolean;
}, queryClient?: QueryClient): TCombinedResult;
/** Suspense query の result を返す hook です。 */
export declare function useSuspenseQueryLite<TQueryFnData = unknown, TError = DefaultError, TData = TQueryFnData, TQueryKey extends QueryKey = QueryKey>(options: UseSuspenseQueryOptions<TQueryFnData, TError, TData, TQueryKey>, queryClient?: QueryClient): UseSuspenseQueryResult<TData, TError>;
/** 複数 Suspense query を同じ render で開始する hook です。 */
export declare function useSuspenseQueriesLite<T extends Array<any>, TCombinedResult = SuspenseQueriesResults<T>>(options: {
    queries: readonly [...SuspenseQueriesOptions<T>];
    combine?: (result: SuspenseQueriesResults<T>) => TCombinedResult;
}, queryClient?: QueryClient): TCombinedResult;
export { useQueryClient };
