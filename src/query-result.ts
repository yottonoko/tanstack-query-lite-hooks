import {
  replaceEqualDeep,
  shouldThrowError,
} from '@tanstack/react-query'
import type {
  DefaultError,
  FetchNextPageOptions,
  FetchPreviousPageOptions,
  InfiniteData,
  InfiniteQueryObserverOptions,
  InfiniteQueryObserverResult,
  Query,
  QueryKey,
  QueryObserverOptions,
  QueryObserverResult,
  QueryState,
  RefetchOptions,
} from '@tanstack/react-query'

export type LiteQuery = Query<any, any, any, any>

export interface LiteSelectState {
  selectFn?: ((data: any) => any) | undefined
  selectResult?: any
  selectError: unknown | null
}

/** 結果の計算に必要な、フック側が保持する状態 */
export interface LiteResultContext<
  TQueryFnData = unknown,
  TError = DefaultError,
  TData = TQueryFnData,
  TQueryData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
> {
  query?: Query<TQueryFnData, TError, TQueryData, TQueryKey>
  state: QueryState<TQueryData, TError>
  queryInitialState: QueryState<TQueryData, TError>
  options: QueryObserverOptions<
    TQueryFnData,
    TError,
    TData,
    TQueryData,
    TQueryKey
  >
  previousResult?: QueryObserverResult<TData, TError>
  previousResultState?: QueryState<TQueryData, TError>
  previousResultOptions?: LiteResultContext['options']
  lastQueryWithDefinedData?: Query<
    TQueryFnData,
    TError,
    TQueryData,
    TQueryKey
  >
  selectState?: LiteSelectState
  refetch: (
    options?: RefetchOptions,
  ) => Promise<QueryObserverResult<TData, TError>>
  promise: Promise<TData>
}

export interface LiteInfiniteResultContext<
  TQueryFnData = unknown,
  TError = DefaultError,
  TData = InfiniteData<TQueryFnData>,
  TQueryKey extends QueryKey = QueryKey,
  TPageParam = unknown,
> extends LiteResultContext<
    TQueryFnData,
    TError,
    TData,
    InfiniteData<TQueryFnData, TPageParam>,
    TQueryKey
  > {
  options: InfiniteQueryObserverOptions<
    TQueryFnData,
    TError,
    TData,
    TQueryKey,
    TPageParam
  >
  fetchNextPage: (
    options?: FetchNextPageOptions,
  ) => Promise<InfiniteQueryObserverResult<TData, TError>>
  fetchPreviousPage: (
    options?: FetchPreviousPageOptions,
  ) => Promise<InfiniteQueryObserverResult<TData, TError>>
}

function resolveBoolean(
  value: unknown,
  query: LiteQuery | undefined,
): boolean | undefined {
  if (typeof value === 'function') {
    return query ? (value as (query: LiteQuery) => boolean)(query) : undefined
  }
  return value as boolean | undefined
}

export const resolveLiteBoolean = resolveBoolean

function resolveStaleTime(
  value: unknown,
  query: LiteQuery | undefined,
): number | 'static' | undefined {
  if (typeof value === 'function') {
    return query
      ? (value as (query: LiteQuery) => number | 'static' | undefined)(query)
      : undefined
  }
  return value as number | 'static' | undefined
}

export const resolveLiteStaleTime = resolveStaleTime

function stateIsFetched<TData = unknown, TError = DefaultError>(
  state: QueryState<TData, TError>,
): boolean {
  return state.dataUpdateCount + state.errorUpdateCount > 0
}

function staleByTime<TData = unknown, TError = DefaultError>(
  state: QueryState<TData, TError>,
  staleTime: number | 'static' | undefined,
): boolean {
  if (state.data === undefined) return true
  if (staleTime === 'static') return false
  if (state.isInvalidated) return true
  return state.dataUpdatedAt + (staleTime || 0) <= Date.now()
}

export const isLiteStaleByTime = staleByTime

function shareData<T>(
  previous: T | undefined,
  next: T,
  options: { structuralSharing?: unknown },
): T {
  if (typeof options.structuralSharing === 'function') {
    return (
      options.structuralSharing as (
        oldData: unknown,
        newData: unknown,
      ) => unknown
    )(previous, next) as T
  }
  if (options.structuralSharing === false) return next
  return replaceEqualDeep(previous, next) as T
}

function sameValues<T extends Record<string, unknown>>(
  next: T,
  previous: T | undefined,
): boolean {
  if (!previous) return false
  const nextKeys = Object.keys(next)
  const previousKeys = Object.keys(previous)
  if (nextKeys.length !== previousKeys.length) return false
  for (const key of nextKeys) {
    if (next[key] !== previous[key]) return false
  }
  return true
}

/** QueryObserver の結果計算を、Observer を生成せずに再現する */
export function createLiteQueryResult<
  TQueryFnData = unknown,
  TError = DefaultError,
  TData = TQueryFnData,
  TQueryData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(
  context: LiteResultContext<
    TQueryFnData,
    TError,
    TData,
    TQueryData,
    TQueryKey
  >,
): QueryObserverResult<TData, TError> {
  const {
    query,
    state,
    queryInitialState,
    options,
    previousResult,
    previousResultState,
    previousResultOptions,
    lastQueryWithDefinedData,
    selectState,
  } = context

  let nextState = { ...state }
  let status = nextState.status
  let error = nextState.error
  let errorUpdatedAt = nextState.errorUpdatedAt
  let data = nextState.data as unknown as TData
  let isPlaceholderData = false
  let skipSelect = false

  if (
    options.placeholderData !== undefined &&
    data === undefined &&
    status === 'pending'
  ) {
    let placeholderData: unknown
    if (
      previousResult?.isPlaceholderData &&
      options.placeholderData === previousResultOptions?.placeholderData
    ) {
      placeholderData = previousResult.data
      skipSelect = true
    } else {
      placeholderData =
        typeof options.placeholderData === 'function'
          ? (
              options.placeholderData as (
                previousData: TQueryData | undefined,
                previousQuery: LiteQuery | undefined,
              ) => TQueryData | undefined
            )(
              lastQueryWithDefinedData?.state.data,
              lastQueryWithDefinedData,
            )
          : options.placeholderData
    }

    if (placeholderData !== undefined) {
      status = 'success'
      data = shareData(previousResult?.data, placeholderData as TData, options)
      isPlaceholderData = true
    }
  }

  if (options.select && data !== undefined && !skipSelect) {
    if (
      previousResult &&
      data === previousResultState?.data &&
      options.select === selectState?.selectFn
    ) {
      data = selectState?.selectResult as TData
    } else {
      try {
        if (selectState) {
          selectState.selectFn = options.select
        }
        const selected = options.select(data as unknown as TQueryData)
        data = shareData(previousResult?.data, selected, options)
        if (selectState) {
          selectState.selectResult = data
          selectState.selectError = null
        }
      } catch (selectError) {
        if (selectState) selectState.selectError = selectError
      }
    }
  }

  if (selectState?.selectError) {
    error = selectState.selectError as TError
    data = selectState.selectResult as TData
    errorUpdatedAt = Date.now()
    status = 'error'
  }

  const isFetching = nextState.fetchStatus === 'fetching'
  const isPending = status === 'pending'
  const isError = status === 'error'
  const hasData = data !== undefined
  const result = {
    status,
    fetchStatus: nextState.fetchStatus,
    isPending,
    isSuccess: status === 'success',
    isError,
    isInitialLoading: isPending && isFetching,
    isLoading: isPending && isFetching,
    data,
    dataUpdatedAt: nextState.dataUpdatedAt,
    error,
    errorUpdatedAt,
    failureCount: nextState.fetchFailureCount,
    failureReason: nextState.fetchFailureReason,
    errorUpdateCount: nextState.errorUpdateCount,
    isFetched: query ? query.isFetched() : stateIsFetched(nextState),
    isFetchedAfterMount:
      nextState.dataUpdateCount > queryInitialState.dataUpdateCount ||
      nextState.errorUpdateCount > queryInitialState.errorUpdateCount,
    isFetching,
    isRefetching: isFetching && !isPending,
    isLoadingError: isError && !hasData,
    isPaused: nextState.fetchStatus === 'paused',
    isPlaceholderData,
    isRefetchError: isError && hasData,
    isStale:
      resolveBoolean(options.enabled, query) !== false &&
      staleByTime(nextState, resolveStaleTime(options.staleTime, query)),
    refetch: context.refetch,
    promise: context.promise,
    isEnabled: resolveBoolean(options.enabled, query) !== false,
  } as QueryObserverResult<TData, TError>

  return sameValues(
    result as unknown as Record<string, unknown>,
    previousResult as unknown as Record<string, unknown> | undefined,
  )
    ? previousResult!
    : result
}

function pageParam(
  options: InfiniteQueryObserverOptions<any, any, any, any, any>,
  data: InfiniteData<unknown> | undefined,
  previous: boolean,
): unknown {
  if (!data || data.pages.length === 0) return undefined
  if (previous) {
    return options.getPreviousPageParam?.(
      data.pages[0],
      data.pages,
      data.pageParams[0],
      data.pageParams,
    )
  }
  const index = data.pages.length - 1
  return options.getNextPageParam(
    data.pages[index],
    data.pages,
    data.pageParams[index],
    data.pageParams,
  )
}

/** InfiniteQueryObserver のページ状態を結果へ付加する */
export function createLiteInfiniteQueryResult<
  TQueryFnData = unknown,
  TError = DefaultError,
  TData = InfiniteData<TQueryFnData>,
  TQueryKey extends QueryKey = QueryKey,
  TPageParam = unknown,
>(
  context: LiteInfiniteResultContext<
    TQueryFnData,
    TError,
    TData,
    TQueryKey,
    TPageParam
  >,
): InfiniteQueryObserverResult<TData, TError> {
  const parent = createLiteQueryResult(context)
  const fetchDirection = context.state.fetchMeta?.fetchMore?.direction
  const isFetchNextPageError =
    parent.isError && fetchDirection === 'forward'
  const isFetchPreviousPageError =
    parent.isError && fetchDirection === 'backward'
  const data = context.state.data as InfiniteData<unknown> | undefined

  const result = {
    ...parent,
    fetchNextPage: context.fetchNextPage,
    fetchPreviousPage: context.fetchPreviousPage,
    hasNextPage: pageParam(context.options, data, false) != null,
    hasPreviousPage:
      context.options.getPreviousPageParam !== undefined &&
      pageParam(context.options, data, true) != null,
    isFetchNextPageError,
    isFetchingNextPage:
      parent.isFetching && fetchDirection === 'forward',
    isFetchPreviousPageError,
    isFetchingPreviousPage:
      parent.isFetching && fetchDirection === 'backward',
    isRefetchError:
      parent.isRefetchError &&
      !isFetchNextPageError &&
      !isFetchPreviousPageError,
    isRefetching:
      parent.isRefetching &&
      !(parent.isFetching && fetchDirection === 'forward') &&
      !(parent.isFetching && fetchDirection === 'backward'),
  } as InfiniteQueryObserverResult<TData, TError>

  return sameValues(
    result as unknown as Record<string, unknown>,
    context.previousResult as unknown as Record<string, unknown> | undefined,
  )
    ? (context.previousResult as InfiniteQueryObserverResult<TData, TError>)
    : result
}

export function trackLiteResult<T extends object>(
  result: T,
  trackedProps: Set<PropertyKey>,
  onPropTracked?: (key: PropertyKey) => void,
): T {
  return new Proxy(result, {
    get(target, key, receiver) {
      trackedProps.add(key)
      onPropTracked?.(key)
      return Reflect.get(target, key, receiver)
    },
  })
}

export function liteResultChanged(
  next: Record<string, unknown>,
  previous: Record<string, unknown> | undefined,
  notifyOnChangeProps: unknown,
  trackedProps: Set<PropertyKey>,
  throwOnError: unknown,
): boolean {
  if (!previous) return true
  const configured =
    typeof notifyOnChangeProps === 'function'
      ? (notifyOnChangeProps as () => unknown)()
      : notifyOnChangeProps
  if (configured === 'all' || (!configured && trackedProps.size === 0)) {
    return true
  }
  const included = new Set<PropertyKey>(
    (configured as Array<PropertyKey> | undefined) ?? trackedProps,
  )
  if (throwOnError) included.add('error')
  for (const key of Object.keys(next)) {
    if (next[key] !== previous[key] && included.has(key)) return true
  }
  return false
}

export function shouldLiteThrowError(
  result: QueryObserverResult<any, any>,
  options: QueryObserverOptions,
  query: LiteQuery | undefined,
): boolean {
  if (!result.isError || result.isFetching || !query) return false
  if (options.suspense && result.data === undefined) return true
  if (typeof options.throwOnError === 'function') {
    return shouldThrowError(options.throwOnError, [result.error, query])
  }
  return options.throwOnError === true
}
