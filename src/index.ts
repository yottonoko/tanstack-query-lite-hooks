/** native QueryClient と cache を共有する observer-free React hooks です。 */

import {
  infiniteQueryOptions as nativeInfiniteQueryOptions,
  queryOptions as nativeQueryOptions,
  skipToken as nativeSkipToken,
  useQueryClient as nativeUseQueryClient,
} from '@tanstack/react-query'
import {
  useQueriesLite as implementationUseQueriesLite,
  useQueryLite as implementationUseQueryLite,
  useSuspenseQueriesLite as implementationUseSuspenseQueriesLite,
  useSuspenseQueryLite as implementationUseSuspenseQueryLite,
} from './hooks.js'
import {
  useInfiniteQueryLite as implementationUseInfiniteQueryLite,
  useSuspenseInfiniteQueryLite as implementationUseSuspenseInfiniteQueryLite,
} from './infinite.js'

type NativeUseQuery = typeof import('@tanstack/react-query').useQuery
type NativeUseQueries = typeof import('@tanstack/react-query').useQueries
type NativeUseSuspenseQuery = typeof import('@tanstack/react-query').useSuspenseQuery
type NativeUseSuspenseQueries = typeof import('@tanstack/react-query').useSuspenseQueries
type NativeUseInfiniteQuery = typeof import('@tanstack/react-query').useInfiniteQuery
type NativeUseSuspenseInfiniteQuery = typeof import('@tanstack/react-query').useSuspenseInfiniteQuery

const useQueryLite = implementationUseQueryLite as NativeUseQuery
const useQueriesLite = implementationUseQueriesLite as NativeUseQueries
const useSuspenseQueryLite = implementationUseSuspenseQueryLite as NativeUseSuspenseQuery
const useSuspenseQueriesLite = implementationUseSuspenseQueriesLite as NativeUseSuspenseQueries
const useInfiniteQueryLite = implementationUseInfiniteQueryLite as NativeUseInfiniteQuery
const useSuspenseInfiniteQueryLite = implementationUseSuspenseInfiniteQueryLite as NativeUseSuspenseInfiniteQuery

export {
  useQueryLite,
  useQueryLite as useQuery,
  useQueriesLite,
  useQueriesLite as useQueries,
  useSuspenseQueryLite,
  useSuspenseQueryLite as useSuspenseQuery,
  useSuspenseQueriesLite,
  useSuspenseQueriesLite as useSuspenseQueries,
  useInfiniteQueryLite,
  useInfiniteQueryLite as useInfiniteQuery,
  useSuspenseInfiniteQueryLite,
  useSuspenseInfiniteQueryLite as useSuspenseInfiniteQuery,
}

export {
  nativeQueryOptions as queryOptionsLite,
  nativeQueryOptions as queryOptions,
  nativeInfiniteQueryOptions as infiniteQueryOptionsLite,
  nativeInfiniteQueryOptions as infiniteQueryOptions,
  nativeSkipToken as skipTokenLite,
  nativeSkipToken as skipToken,
  nativeUseQueryClient as useQueryClientLite,
  nativeUseQueryClient as useQueryClient,
}

export type {
  DefinedInitialDataOptions,
  DefinedInitialDataOptions as DefinedInitialDataOptionsLite,
  UndefinedInitialDataOptions,
  UndefinedInitialDataOptions as UndefinedInitialDataOptionsLite,
  UseQueryOptions,
  UseQueryOptions as UseQueryOptionsLite,
  UseQueryResult,
  UseQueryResult as UseQueryResultLite,
  DefinedUseQueryResult,
  DefinedUseQueryResult as DefinedUseQueryResultLite,
  QueriesOptions,
  QueriesOptions as QueriesOptionsLite,
  QueriesResults,
  QueriesResults as QueriesResultsLite,
  UseSuspenseQueryOptions,
  UseSuspenseQueryOptions as UseSuspenseQueryOptionsLite,
  UseSuspenseQueryResult,
  UseSuspenseQueryResult as UseSuspenseQueryResultLite,
  SuspenseQueriesOptions,
  SuspenseQueriesOptions as SuspenseQueriesOptionsLite,
  SuspenseQueriesResults,
  SuspenseQueriesResults as SuspenseQueriesResultsLite,
  DefinedInitialDataInfiniteOptions,
  DefinedInitialDataInfiniteOptions as DefinedInitialDataInfiniteOptionsLite,
  UndefinedInitialDataInfiniteOptions,
  UndefinedInitialDataInfiniteOptions as UndefinedInitialDataInfiniteOptionsLite,
  UseInfiniteQueryOptions,
  UseInfiniteQueryOptions as UseInfiniteQueryOptionsLite,
  UseInfiniteQueryResult,
  UseInfiniteQueryResult as UseInfiniteQueryResultLite,
  UseSuspenseInfiniteQueryOptions,
  UseSuspenseInfiniteQueryOptions as UseSuspenseInfiniteQueryOptionsLite,
  UseSuspenseInfiniteQueryResult,
  UseSuspenseInfiniteQueryResult as UseSuspenseInfiniteQueryResultLite,
} from '@tanstack/react-query'
