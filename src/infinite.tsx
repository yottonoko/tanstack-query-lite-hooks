import {
  focusManager,
  skipToken,
  useIsRestoring,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  DefaultError,
  DefinedInitialDataInfiniteOptions,
  DefinedUseInfiniteQueryResult,
  FetchNextPageOptions,
  FetchPreviousPageOptions,
  InfiniteData,
  InfiniteQueryObserverOptions,
  InfiniteQueryObserverResult,
  Query,
  QueryClient,
  QueryKey,
  QueryState,
  RefetchOptions,
  UndefinedInitialDataInfiniteOptions,
  UseInfiniteQueryOptions,
  UseInfiniteQueryResult,
  UseSuspenseInfiniteQueryOptions,
  UseSuspenseInfiniteQueryResult,
} from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { getLiteHub, type AnyLiteQuery, type LiteHub } from "./hub.js";
import {
  createLiteInfiniteQueryResult,
  liteResultChanged,
  shouldLiteThrowError,
  trackLiteResult,
  type LiteInfiniteResultContext,
  type LiteSelectState,
} from "./query-result.js";
import {
  warnUnsupportedOption,
  warnUnsupportedResultProperty,
} from "./warnings.js";

type AnyInfiniteOptions = InfiniteQueryObserverOptions<
  any,
  any,
  any,
  QueryKey,
  any
> & {
  queryHash: string;
  queryKey: QueryKey;
  _type: "infinite";
  subscribed?: boolean;
};

type AnyInfiniteResult = InfiniteQueryObserverResult<any, any>;
const pausedSuspensePromise = new Promise<never>(() => undefined);

interface InfiniteResultMemory {
  query?: AnyLiteQuery;
  queryInitialState?: QueryState<any, any> | undefined;
  previousResult?: AnyInfiniteResult | undefined;
  previousResultState?: QueryState<any, any> | undefined;
  previousResultOptions?: AnyInfiniteOptions | undefined;
  selectState: LiteSelectState;
  trackedProps: Set<PropertyKey>;
  promise?: Promise<any> | undefined;
  promiseData?: unknown;
}

interface InfiniteRuntime<TData extends AnyInfiniteResult = AnyInfiniteResult> {
  client: ReturnType<typeof useQueryClient>;
  hub: LiteHub;
  query: AnyLiteQuery;
  options: AnyInfiniteOptions;
  // Cache event と timer は最後に commit された options だけを参照する。
  committedOptions: AnyInfiniteOptions;
  memory: InfiniteResultMemory;
  committedMemory: InfiniteResultMemory;
  result: TData;
  refresh?: () => AnyInfiniteResult;
  listener: (() => void) | undefined;
  snapshot?: AnyInfiniteResult;
  autoFetchAttempted: boolean;
  wasAutoFetchEligible: boolean;
  isRestoring: boolean;
  committedIsRestoring: boolean;
  invalidationFetchScheduled: boolean;
  querySemanticsKey: object;
  retainedQuery: AnyLiteQuery | undefined;
}

function resolveEnabled(
  value: AnyInfiniteOptions["enabled"],
  query: AnyLiteQuery,
): boolean | undefined {
  if (typeof value === "function") {
    return (value as (query: AnyLiteQuery) => boolean)(query);
  }
  return value;
}

function resolveStaleTime(
  value: AnyInfiniteOptions["staleTime"],
  query: AnyLiteQuery,
): number | "static" | undefined {
  if (typeof value === "function") {
    return (value as (query: AnyLiteQuery) => number | "static" | undefined)(
      query,
    );
  }
  return value;
}

function resolveRefetchTrigger(
  value: AnyInfiniteOptions["refetchOnMount"],
  query: AnyLiteQuery,
): boolean | "always" | undefined {
  if (typeof value === "function") {
    return (value as (query: AnyLiteQuery) => boolean | "always")(query);
  }
  return value;
}

function isStale(query: AnyLiteQuery, options: AnyInfiniteOptions): boolean {
  const staleTime = resolveStaleTime(options.staleTime, query);
  return (
    resolveEnabled(options.enabled, query) !== false &&
    query.isStaleByTime(staleTime === undefined ? 0 : staleTime)
  );
}

function shouldFetchOnMount(
  query: AnyLiteQuery,
  options: AnyInfiniteOptions,
): boolean {
  if (resolveEnabled(options.enabled, query) === false) return false;

  if (query.state.data === undefined) {
    return !(
      query.state.status === "error" &&
      resolveEnabled(options.retryOnMount, query) === false
    );
  }

  if (resolveStaleTime(options.staleTime, query) === "static") return false;
  const trigger = resolveRefetchTrigger(options.refetchOnMount, query);
  return trigger === "always" || (trigger !== false && isStale(query, options));
}

function shouldFetchOnEnvironment(
  query: AnyLiteQuery,
  options: AnyInfiniteOptions,
  field: AnyInfiniteOptions["refetchOnWindowFocus"],
): boolean {
  if (resolveEnabled(options.enabled, query) === false) return false;
  if (resolveStaleTime(options.staleTime, query) === "static") return false;
  const trigger = resolveRefetchTrigger(field, query);
  return trigger === "always" || (trigger !== false && isStale(query, options));
}

function suspenseOptions<
  T extends UseSuspenseInfiniteQueryOptions<any, any, any, QueryKey, any>,
>(
  options: T,
): T & UseInfiniteQueryOptions {
  const staleTime = options.staleTime;
  const suspenseStaleTime =
    staleTime === "static"
      ? staleTime
      : typeof staleTime === "function"
        ? (...args: Parameters<typeof staleTime>) =>
            (() => {
              const resolved = staleTime(...args);
              return resolved === "static"
                ? resolved
                : Math.max(resolved ?? 1000, 1000);
            })()
        : Math.max(staleTime ?? 1000, 1000);
  const next = {
    ...options,
    enabled: true,
    placeholderData: undefined,
    suspense: true,
    throwOnError: (
      _error: unknown,
      query: AnyLiteQuery,
    ) => query.state.data === undefined,
    staleTime: suspenseStaleTime,
  } as unknown as T & UseInfiniteQueryOptions;
  if (typeof options.gcTime === "number") {
    next.gcTime = Math.max(options.gcTime, 1000);
  }
  return next;
}

function getPromise(
  query: AnyLiteQuery,
  memory: InfiniteResultMemory,
): Promise<any> {
  if (query.promise) {
    memory.promise = query.promise;
    memory.promiseData = query.state.data;
    return query.promise;
  }
  if (memory.promise && memory.promiseData === query.state.data) {
    return memory.promise;
  }
  memory.promiseData = query.state.data;
  memory.promise = Promise.resolve(query.state.data);
  return memory.promise;
}

function resetMemoryForQuery(
  memory: InfiniteResultMemory,
  query: AnyLiteQuery,
): void {
  if (memory.query === query) return;
  memory.query = query;
  memory.queryInitialState = query.state;
  memory.previousResult = undefined;
  memory.previousResultState = undefined;
  memory.previousResultOptions = undefined;
  memory.selectState = {
    selectFn: undefined,
    selectResult: undefined,
    selectError: null,
  };
  memory.promise = undefined;
  memory.promiseData = undefined;
}

function cloneInfiniteMemory(
  memory: InfiniteResultMemory,
): InfiniteResultMemory {
  const clone: InfiniteResultMemory = {
    selectState: { ...memory.selectState },
    // property access は commit 後にも起こるため、追加方向だけの tracking set は共有する。
    // select と result の比較基準だけを分離し、破棄 render による通知抑制を防ぐ。
    trackedProps: memory.trackedProps,
  };
  if (memory.query !== undefined) clone.query = memory.query;
  if (memory.queryInitialState !== undefined) {
    clone.queryInitialState = memory.queryInitialState;
  }
  if (memory.previousResult !== undefined) {
    clone.previousResult = memory.previousResult;
  }
  if (memory.previousResultState !== undefined) {
    clone.previousResultState = memory.previousResultState;
  }
  if (memory.previousResultOptions !== undefined) {
    clone.previousResultOptions = memory.previousResultOptions;
  }
  if (memory.promise !== undefined) clone.promise = memory.promise;
  if (memory.promiseData !== undefined) clone.promiseData = memory.promiseData;
  return clone;
}

function updateResult(
  runtime: InfiniteRuntime,
  refetch: (options?: RefetchOptions) => Promise<AnyInfiniteResult>,
  fetchNextPage: (
    options?: FetchNextPageOptions,
  ) => Promise<AnyInfiniteResult>,
  fetchPreviousPage: (
    options?: FetchPreviousPageOptions,
  ) => Promise<AnyInfiniteResult>,
  options: AnyInfiniteOptions = runtime.options,
  isRestoring = runtime.isRestoring,
  memory: InfiniteResultMemory = runtime.memory,
): AnyInfiniteResult {
  const { query } = runtime;
  resetMemoryForQuery(memory, query);

  if (memory.selectState.selectFn !== options.select) {
    memory.selectState = {
      selectFn: undefined,
      selectResult: undefined,
      selectError: null,
    };
  }

  const useOptimisticFetchState =
    !runtime.autoFetchAttempted &&
    !isRestoring &&
    options.subscribed !== false &&
    query.state.status === "pending" &&
    query.state.fetchStatus === "idle" &&
    resolveEnabled(options.enabled, query) !== false &&
    options.queryFn !== skipToken;

  const context = {
    query: query as Query<any, any, any, any>,
    state: useOptimisticFetchState
      ? { ...query.state, fetchStatus: "fetching" as const }
      : query.state,
    queryInitialState: memory.queryInitialState ?? query.state,
    options,
    previousResult: memory.previousResult,
    previousResultState: memory.previousResultState,
    previousResultOptions: memory.previousResultOptions as any,
    selectState: memory.selectState,
    refetch,
    fetchNextPage,
    fetchPreviousPage,
    promise: getPromise(query, memory),
  } as unknown as LiteInfiniteResultContext<any, any, any, QueryKey, any>;
  const result = createLiteInfiniteQueryResult(context);
  memory.previousResult = result;
  memory.previousResultState = query.state;
  memory.previousResultOptions = options;
  return trackLiteResult(result, memory.trackedProps, (key) => {
    if (key === "promise") warnUnsupportedResultProperty("promise");
  });
}

function runFetch(
  runtime: InfiniteRuntime,
  fetchOptions: RefetchOptions | FetchNextPageOptions | FetchPreviousPageOptions,
  direction?: "forward" | "backward",
): Promise<AnyInfiniteResult> {
  const { hub, query } = runtime;
  const options = runtime.committedOptions;
  const queryFetchOptions = direction
    ? {
        ...fetchOptions,
        cancelRefetch: fetchOptions.cancelRefetch ?? true,
        meta: { fetchMore: { direction } },
      }
    : {
        ...fetchOptions,
        cancelRefetch: fetchOptions.cancelRefetch ?? true,
      };
  let promise = hub.fetch(query, options, queryFetchOptions);
  if (!fetchOptions.throwOnError) {
    promise = promise.catch(() => undefined);
  }

  return promise.then(() => runtime.refresh?.() ?? runtime.result);
}

function useInfiniteRuntime(
  options: UseInfiniteQueryOptions<any, any, any, QueryKey, any>,
  explicitClient?: QueryClient,
): InfiniteRuntime {
  "use no memo";
  const client = useQueryClient(explicitClient);
  const isRestoring = useIsRestoring();
  const hub = useMemo(() => getLiteHub(client), [client]);
  const defaultedOptions = client.defaultQueryOptions({
    ...options,
    _type: "infinite",
  }) as AnyInfiniteOptions;
  const query = hub.buildQuery(defaultedOptions) as AnyLiteQuery;

  const memory = useMemo<InfiniteResultMemory>(
    () => ({
      query,
      queryInitialState: query.state,
      selectState: { selectError: null },
      trackedProps: new Set<PropertyKey>(),
    }),
    [query],
  );
  const staleTimerKey = useRef<object | undefined>(undefined);
  const intervalTimerKey = useRef<object | undefined>(undefined);

  if (!staleTimerKey.current) staleTimerKey.current = {};
  if (!intervalTimerKey.current) intervalTimerKey.current = {};
  const runtime = useMemo<InfiniteRuntime>(
    () => ({
      client,
      hub,
      query,
      options: defaultedOptions,
      committedOptions: defaultedOptions,
      memory,
      committedMemory: cloneInfiniteMemory(memory),
      result: undefined as never,
      listener: undefined,
      autoFetchAttempted: false,
      wasAutoFetchEligible: false,
      isRestoring,
      committedIsRestoring: isRestoring,
      invalidationFetchScheduled: false,
      querySemanticsKey: {},
      retainedQuery: undefined,
    }),
    [client, hub, memory, query],
  );
  runtime.options = defaultedOptions;
  runtime.isRestoring = isRestoring;
  const actions = useMemo(
    () => ({
      refetch: (fetchOptions?: RefetchOptions) =>
        runFetch(runtime, fetchOptions ?? {}, undefined),
      fetchNextPage: (fetchOptions?: FetchNextPageOptions) =>
        runFetch(runtime, fetchOptions ?? {}, "forward"),
      fetchPreviousPage: (fetchOptions?: FetchPreviousPageOptions) =>
        runFetch(runtime, fetchOptions ?? {}, "backward"),
    }),
    [runtime],
  );
  const makeResult = useCallback((
    resultOptions: AnyInfiniteOptions = runtime.options,
    resultIsRestoring = runtime.isRestoring,
    resultMemory: InfiniteResultMemory = runtime.memory,
  ) => {
    const next = updateResult(
      runtime,
      actions.refetch,
      actions.fetchNextPage,
      actions.fetchPreviousPage,
      resultOptions,
      resultIsRestoring,
      resultMemory,
    );
    runtime.result = next;
    runtime.snapshot = next;
    return next;
  }, [actions, runtime]);
  runtime.refresh = () => makeResult(
    runtime.committedOptions,
    runtime.committedIsRestoring,
    runtime.committedMemory,
  );

  makeResult();

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (isRestoring || defaultedOptions.subscribed === false) {
        return () => undefined;
      }
      runtime.listener = onStoreChange;
      let subscribedQuery = query;
      let rebinding = false;
      let retained = false;
      const retainQuery = (target: AnyLiteQuery) => {
        runtime.retainedQuery = target;
        try {
          hub.setQuerySemantics(target, runtime.querySemanticsKey, {
            isActive: () =>
              runtime.retainedQuery === target &&
              resolveEnabled(runtime.committedOptions.enabled, target) !== false &&
              runtime.committedOptions.queryFn !== skipToken,
            isStatic: () =>
              runtime.retainedQuery === target &&
              resolveStaleTime(runtime.committedOptions.staleTime, target) === "static",
            mayBeStatic:
              typeof runtime.committedOptions.staleTime === "function" ||
              runtime.committedOptions.staleTime === "static",
          });
          hub.retain(target, defaultedOptions.gcTime);
        } catch (error) {
          hub.clearQuerySemantics(runtime.querySemanticsKey);
          if (runtime.retainedQuery === target) runtime.retainedQuery = undefined;
          throw error;
        }
      };
      const releaseRetention = () => {
        try {
          hub.clearQuerySemantics(runtime.querySemanticsKey);
        } finally {
          if (retained) hub.release(subscribedQuery);
          retained = false;
          if (runtime.retainedQuery === subscribedQuery) {
            runtime.retainedQuery = undefined;
          }
        }
      };
      try {
        retainQuery(subscribedQuery);
        retained = true;
      } catch (error) {
        if (runtime.listener === onStoreChange) runtime.listener = undefined;
        throw error;
      }
      const switchQuery = (nextQuery: AnyLiteQuery) => {
        if (nextQuery === subscribedQuery) return;
        try {
          hub.clearQuerySemantics(runtime.querySemanticsKey);
        } finally {
          if (retained) hub.release(subscribedQuery);
        }
        retained = false;
        subscribedQuery = nextQuery;
        retainQuery(subscribedQuery);
        retained = true;
        runtime.query = subscribedQuery;
        runtime.autoFetchAttempted = false;
        runtime.wasAutoFetchEligible = false;
        resetMemoryForQuery(runtime.memory, subscribedQuery);
        resetMemoryForQuery(runtime.committedMemory, subscribedQuery);
      };
      let unsubscribeHash: () => void;
      try {
        unsubscribeHash = hub.subscribeHash(query.queryHash, (event) => {
          if (rebinding) return;
          if (event.type === "removed" && event.query === subscribedQuery) {
            rebinding = true;
            try {
              switchQuery(hub.buildQuery(runtime.committedOptions));
            } finally {
              rebinding = false;
            }
          } else if (event.query !== subscribedQuery) {
            switchQuery(event.query);
          }
          if (runtime.query !== subscribedQuery) return;
          const previous = runtime.committedMemory.previousResult;
          makeResult(
            runtime.committedOptions,
            runtime.committedIsRestoring,
            runtime.committedMemory,
          );
          const next = runtime.committedMemory.previousResult;
          if (
            liteResultChanged(
              next as unknown as Record<string, unknown>,
              previous as unknown as Record<string, unknown> | undefined,
              runtime.committedOptions.notifyOnChangeProps,
              runtime.memory.trackedProps,
              runtime.committedOptions.throwOnError,
            )
          ) {
            runtime.listener?.();
          }
          if (
            event.type === "updated" &&
            event.action.type === "invalidate" &&
            resolveEnabled(runtime.committedOptions.enabled, subscribedQuery) !== false &&
            runtime.committedOptions.queryFn !== skipToken &&
            resolveStaleTime(runtime.committedOptions.staleTime, subscribedQuery) !== "static" &&
            !subscribedQuery.isActive()
          ) {
            const handled = hub.runActiveInvalidation(
              subscribedQuery,
              (fetchOptions) => subscribedQuery.fetch(
                runtime.committedOptions,
                fetchOptions,
              ),
            );
            if (handled === undefined && !runtime.invalidationFetchScheduled) {
              const invalidatedQuery = subscribedQuery;
              runtime.invalidationFetchScheduled = true;
              queueMicrotask(() => {
                runtime.invalidationFetchScheduled = false;
                if (
                  runtime.listener === undefined ||
                  runtime.committedIsRestoring ||
                  runtime.committedOptions.subscribed === false ||
                  runtime.query !== invalidatedQuery ||
                  resolveEnabled(runtime.committedOptions.enabled, invalidatedQuery) === false ||
                  runtime.committedOptions.queryFn === skipToken ||
                  resolveStaleTime(
                    runtime.committedOptions.staleTime,
                    invalidatedQuery,
                  ) === "static" ||
                  invalidatedQuery.isActive() ||
                  invalidatedQuery.state.fetchStatus !== "idle" ||
                  !invalidatedQuery.state.isInvalidated
                ) return;
                void invalidatedQuery
                  .fetch(runtime.committedOptions, { cancelRefetch: false })
                  .catch(() => undefined);
              });
            }
          }
        });
      } catch (error) {
        releaseRetention();
        if (runtime.listener === onStoreChange) runtime.listener = undefined;
        throw error;
      }
      let unregisterEnvironment: () => void;
      try {
        unregisterEnvironment = hub.registerEnvironment({
        onFocus: () => {
          if (
            shouldFetchOnEnvironment(
              subscribedQuery,
              runtime.committedOptions,
              runtime.committedOptions.refetchOnWindowFocus,
            )
          ) {
            void subscribedQuery
              .fetch(runtime.committedOptions, { cancelRefetch: false })
              .catch(() => undefined);
          }
        },
        onOnline: () => {
          if (
            shouldFetchOnEnvironment(
              subscribedQuery,
              runtime.committedOptions,
              runtime.committedOptions.refetchOnReconnect,
            )
          ) {
            void subscribedQuery
              .fetch(runtime.committedOptions, { cancelRefetch: false })
              .catch(() => undefined);
          }
        },
        });
      } catch (error) {
        unsubscribeHash();
        releaseRetention();
        if (runtime.listener === onStoreChange) runtime.listener = undefined;
        throw error;
      }
      return () => {
        unsubscribeHash();
        unregisterEnvironment();
        releaseRetention();
        if (runtime.listener === onStoreChange) {
          runtime.listener = undefined;
        }
      };
    },
    [
      defaultedOptions.gcTime,
      defaultedOptions.subscribed,
      hub,
      isRestoring,
      makeResult,
      query,
    ],
  );

  const getSnapshot = useCallback(
    () => runtime.snapshot ?? makeResult(),
    [makeResult, runtime],
  );
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useLayoutEffect(() => {
    runtime.committedOptions = defaultedOptions;
    runtime.committedIsRestoring = isRestoring;
    runtime.committedMemory = cloneInfiniteMemory(runtime.memory);
    query.setOptions(defaultedOptions);
    if (runtime.retainedQuery) {
      hub.setQuerySemantics(
        runtime.retainedQuery,
        runtime.querySemanticsKey,
        {
          isActive: () =>
            runtime.retainedQuery !== undefined &&
            resolveEnabled(runtime.committedOptions.enabled, runtime.retainedQuery) !== false &&
            runtime.committedOptions.queryFn !== skipToken,
          isStatic: () =>
            runtime.retainedQuery !== undefined &&
            resolveStaleTime(runtime.committedOptions.staleTime, runtime.retainedQuery) === "static",
          mayBeStatic:
            typeof runtime.committedOptions.staleTime === "function" ||
            runtime.committedOptions.staleTime === "static",
        },
      );
    }
  });

  useEffect(() => {
    if ((defaultedOptions as { experimental_prefetchInRender?: boolean }).experimental_prefetchInRender) {
      warnUnsupportedOption("experimental_prefetchInRender");
    }
    const eligible =
      defaultedOptions.subscribed !== false &&
      !isRestoring &&
      resolveEnabled(defaultedOptions.enabled, query) !== false &&
      defaultedOptions.queryFn !== skipToken;
    if (eligible && !runtime.wasAutoFetchEligible) {
      runtime.autoFetchAttempted = false;
    }
    runtime.wasAutoFetchEligible = eligible;
    if (!eligible) {
      return;
    }
    if (!runtime.autoFetchAttempted) {
      runtime.autoFetchAttempted = true;
      if (shouldFetchOnMount(query, defaultedOptions)) {
        void query.fetch(defaultedOptions).catch(() => undefined);
      }
    }
  }, [
    defaultedOptions.enabled,
    defaultedOptions.subscribed,
    isRestoring,
    query,
    runtime,
  ]);

  useEffect(() => {
    if (isRestoring || defaultedOptions.subscribed === false) return;
    const staleTime = resolveStaleTime(defaultedOptions.staleTime, query);
    if (
      staleTime === "static" ||
      staleTime === undefined ||
      staleTime === Infinity ||
      query.state.data === undefined
    ) {
      hub.cancelStale(staleTimerKey.current!);
    } else {
      hub.scheduleStale(
        staleTimerKey.current!,
        query.state.dataUpdatedAt + staleTime + 1,
        () => {
          if (runtime.query !== query) return;
          const previous = runtime.committedMemory.previousResult;
          makeResult(
            runtime.committedOptions,
            runtime.committedIsRestoring,
            runtime.committedMemory,
          );
          const next = runtime.committedMemory.previousResult;
          if (
            liteResultChanged(
              next as unknown as Record<string, unknown>,
              previous as unknown as Record<string, unknown> | undefined,
              runtime.committedOptions.notifyOnChangeProps,
              runtime.memory.trackedProps,
              runtime.committedOptions.throwOnError,
            )
          ) {
            runtime.listener?.();
          }
        },
      );
    }
    return () => hub.cancelStale(staleTimerKey.current!);
  }, [
    defaultedOptions.staleTime,
    defaultedOptions.subscribed,
    hub,
    isRestoring,
    makeResult,
    query,
    runtime.memory.previousResult?.dataUpdatedAt,
  ]);

  const resolvedRefetchInterval =
    typeof defaultedOptions.refetchInterval === "function"
      ? defaultedOptions.refetchInterval(query)
      : defaultedOptions.refetchInterval;

  useEffect(() => {
    if (isRestoring || defaultedOptions.subscribed === false) return;
    const interval = resolvedRefetchInterval;
    if (typeof interval !== "number" || interval <= 0 || interval === Infinity) {
      hub.cancelInterval(intervalTimerKey.current!);
      return () => hub.cancelInterval(intervalTimerKey.current!);
    }
    hub.scheduleInterval(intervalTimerKey.current!, {
      interval,
      inBackground: () =>
        runtime.committedOptions.refetchIntervalInBackground === true ||
        focusManager.isFocused(),
      callback: () => {
        if (runtime.committedIsRestoring) return;
        const currentQuery = runtime.query;
        if (resolveEnabled(runtime.committedOptions.enabled, currentQuery) === false) return;
        void currentQuery.fetch(runtime.committedOptions).catch(() => undefined);
      },
    });
    return () => hub.cancelInterval(intervalTimerKey.current!);
  }, [
    defaultedOptions.subscribed,
    hub,
    isRestoring,
    query,
    resolvedRefetchInterval,
  ]);

  return runtime;
}

/** Infinite Query を observer なしで購読します。 */
export function useInfiniteQueryLite<
  TQueryFnData,
  TError = DefaultError,
  TData = InfiniteData<TQueryFnData>,
  TQueryKey extends QueryKey = QueryKey,
  TPageParam = unknown,
>(
  options: DefinedInitialDataInfiniteOptions<
    TQueryFnData,
    TError,
    TData,
    TQueryKey,
    TPageParam
  >,
  queryClient?: QueryClient,
): DefinedUseInfiniteQueryResult<TData, TError>;

/** Infinite Query を observer なしで購読します。 */
export function useInfiniteQueryLite<
  TQueryFnData,
  TError = DefaultError,
  TData = InfiniteData<TQueryFnData>,
  TQueryKey extends QueryKey = QueryKey,
  TPageParam = unknown,
>(
  options: UndefinedInitialDataInfiniteOptions<
    TQueryFnData,
    TError,
    TData,
    TQueryKey,
    TPageParam
  >,
  queryClient?: QueryClient,
): UseInfiniteQueryResult<TData, TError>;

/** Infinite Query を observer なしで購読します。 */
export function useInfiniteQueryLite<
  TQueryFnData,
  TError = DefaultError,
  TData = InfiniteData<TQueryFnData>,
  TQueryKey extends QueryKey = QueryKey,
  TPageParam = unknown,
>(
  options: UseInfiniteQueryOptions<
    TQueryFnData,
    TError,
    TData,
    TQueryKey,
    TPageParam
  >,
  queryClient?: QueryClient,
): UseInfiniteQueryResult<TData, TError>;

export function useInfiniteQueryLite(
  options: any,
  queryClient?: QueryClient,
): any {
  "use no memo";
  const runtime = useInfiniteRuntime(options, queryClient);
  const result = runtime.result;
  const rawResult = runtime.memory.previousResult ?? result;
  if (shouldLiteThrowError(rawResult, runtime.options as any, runtime.query)) {
    throw rawResult.error;
  }
  return result;
}

/** Infinite Query を Suspense で取得し、定義済み data を返します。 */
export function useSuspenseInfiniteQueryLite<
  TQueryFnData,
  TError = DefaultError,
  TData = InfiniteData<TQueryFnData>,
  TQueryKey extends QueryKey = QueryKey,
  TPageParam = unknown,
>(
  options: UseSuspenseInfiniteQueryOptions<
    TQueryFnData,
    TError,
    TData,
    TQueryKey,
    TPageParam
  >,
  queryClient?: QueryClient,
): UseSuspenseInfiniteQueryResult<TData, TError> {
  "use no memo";
  if ((options.queryFn as unknown) === skipToken) {
    throw new Error("skipToken is not allowed for useSuspenseInfiniteQuery");
  }
  const runtime = useInfiniteRuntime(
    suspenseOptions(options as any) as UseInfiniteQueryOptions<
      any,
      any,
      any,
      QueryKey,
      any
    >,
    queryClient,
  );
  const result = runtime.result;
  const rawResult = runtime.memory.previousResult ?? result;
  if (
    (runtime.isRestoring || runtime.options.subscribed === false) &&
    rawResult.data === undefined
  ) {
    throw pausedSuspensePromise;
  }
  if (rawResult.status === "pending") {
    const promise = runtime.query.promise ?? runtime.query.fetch(runtime.options);
    throw promise;
  }
  if (rawResult.status === "error" && rawResult.data === undefined) {
    throw rawResult.error;
  }
  return result as UseSuspenseInfiniteQueryResult<TData, TError>;
}
