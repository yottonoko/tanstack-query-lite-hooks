/** native QueryClient と cache を共有する observer-free React hooks です。 */
import { infiniteQueryOptions as nativeInfiniteQueryOptions, queryOptions as nativeQueryOptions, skipToken as nativeSkipToken, useQueryClient as nativeUseQueryClient } from '@tanstack/react-query';
type NativeUseQuery = typeof import('@tanstack/react-query').useQuery;
type NativeUseQueries = typeof import('@tanstack/react-query').useQueries;
type NativeUseSuspenseQuery = typeof import('@tanstack/react-query').useSuspenseQuery;
type NativeUseSuspenseQueries = typeof import('@tanstack/react-query').useSuspenseQueries;
type NativeUseInfiniteQuery = typeof import('@tanstack/react-query').useInfiniteQuery;
type NativeUseSuspenseInfiniteQuery = typeof import('@tanstack/react-query').useSuspenseInfiniteQuery;
declare const useQueryLite: NativeUseQuery;
declare const useQueriesLite: NativeUseQueries;
declare const useSuspenseQueryLite: NativeUseSuspenseQuery;
declare const useSuspenseQueriesLite: NativeUseSuspenseQueries;
declare const useInfiniteQueryLite: NativeUseInfiniteQuery;
declare const useSuspenseInfiniteQueryLite: NativeUseSuspenseInfiniteQuery;
export { useQueryLite, useQueryLite as useQuery, useQueriesLite, useQueriesLite as useQueries, useSuspenseQueryLite, useSuspenseQueryLite as useSuspenseQuery, useSuspenseQueriesLite, useSuspenseQueriesLite as useSuspenseQueries, useInfiniteQueryLite, useInfiniteQueryLite as useInfiniteQuery, useSuspenseInfiniteQueryLite, useSuspenseInfiniteQueryLite as useSuspenseInfiniteQuery, };
export { nativeQueryOptions as queryOptionsLite, nativeQueryOptions as queryOptions, nativeInfiniteQueryOptions as infiniteQueryOptionsLite, nativeInfiniteQueryOptions as infiniteQueryOptions, nativeSkipToken as skipTokenLite, nativeSkipToken as skipToken, nativeUseQueryClient as useQueryClientLite, nativeUseQueryClient as useQueryClient, };
export type { DefinedInitialDataOptions, DefinedInitialDataOptions as DefinedInitialDataOptionsLite, UndefinedInitialDataOptions, UndefinedInitialDataOptions as UndefinedInitialDataOptionsLite, UseQueryOptions, UseQueryOptions as UseQueryOptionsLite, UseQueryResult, UseQueryResult as UseQueryResultLite, DefinedUseQueryResult, DefinedUseQueryResult as DefinedUseQueryResultLite, QueriesOptions, QueriesOptions as QueriesOptionsLite, QueriesResults, QueriesResults as QueriesResultsLite, UseSuspenseQueryOptions, UseSuspenseQueryOptions as UseSuspenseQueryOptionsLite, UseSuspenseQueryResult, UseSuspenseQueryResult as UseSuspenseQueryResultLite, SuspenseQueriesOptions, SuspenseQueriesOptions as SuspenseQueriesOptionsLite, SuspenseQueriesResults, SuspenseQueriesResults as SuspenseQueriesResultsLite, DefinedInitialDataInfiniteOptions, DefinedInitialDataInfiniteOptions as DefinedInitialDataInfiniteOptionsLite, UndefinedInitialDataInfiniteOptions, UndefinedInitialDataInfiniteOptions as UndefinedInitialDataInfiniteOptionsLite, UseInfiniteQueryOptions, UseInfiniteQueryOptions as UseInfiniteQueryOptionsLite, UseInfiniteQueryResult, UseInfiniteQueryResult as UseInfiniteQueryResultLite, UseSuspenseInfiniteQueryOptions, UseSuspenseInfiniteQueryOptions as UseSuspenseInfiniteQueryOptionsLite, UseSuspenseInfiniteQueryResult, UseSuspenseInfiniteQueryResult as UseSuspenseInfiniteQueryResultLite, } from '@tanstack/react-query';
