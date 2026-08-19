import { useQueryClient, useIsRestoring, skipToken, shouldThrowError, focusManager, onlineManager, replaceEqualDeep } from '@tanstack/react-query';
export { infiniteQueryOptions, infiniteQueryOptions as infiniteQueryOptionsLite, queryOptions, queryOptions as queryOptionsLite, skipToken, skipToken as skipTokenLite, useQueryClient, useQueryClient as useQueryClientLite } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore, useLayoutEffect, useEffect, useMemo, useRef } from 'react';

// src/index.ts
var hubs = /* @__PURE__ */ new WeakMap();
var MAX_TIMER_DELAY = 2147483647;
function delayUntil(deadline) {
  return Math.min(Math.max(deadline - Date.now(), 0), MAX_TIMER_DELAY);
}
function validTimeout(value) {
  return typeof value === "number" && value >= 0 && value !== Infinity;
}
function queryGcTime(query) {
  const value = query.gcTime;
  return typeof value === "number" && value >= 0 ? value : 5 * 60 * 1e3;
}
function clearQueryGcTimeout(query) {
  const candidate = query;
  if (typeof candidate.clearGcTimeout !== "function") {
    throw new Error(
      "[tanstack-query-lite-hooks] The installed TanStack Query runtime does not expose clearGcTimeout; lite query retention cannot be made safe."
    );
  }
  candidate.clearGcTimeout();
}
var LiteHub = class {
  client;
  cache;
  cacheUnsubscribe;
  hashListeners = /* @__PURE__ */ new Map();
  aggregateListeners = /* @__PURE__ */ new Map();
  retained = /* @__PURE__ */ new Map();
  gcCandidates = /* @__PURE__ */ new Map();
  environmentListeners = /* @__PURE__ */ new Set();
  staleTimers = /* @__PURE__ */ new Map();
  intervalTimers = /* @__PURE__ */ new Map();
  focusUnsubscribe;
  onlineUnsubscribe;
  gcTimer;
  gcTimerDeadline;
  staleTimer;
  staleTimerDeadline;
  intervalTimer;
  intervalTimerDeadline;
  constructor(client) {
    this.client = client;
    this.cache = client.getQueryCache();
  }
  /** キャッシュへの実購読は Hub ごとに最大一つだけ作る */
  ensureExternalSubscriptions() {
    if (!this.cacheUnsubscribe) {
      this.cacheUnsubscribe = this.cache.subscribe((event) => {
        this.onCacheEvent(event);
      });
    }
    if (!this.focusUnsubscribe) {
      this.focusUnsubscribe = focusManager.subscribe((focused) => {
        if (focused) {
          for (const listener of this.environmentListeners) {
            listener.onFocus?.();
          }
        }
      });
    }
    if (!this.onlineUnsubscribe) {
      this.onlineUnsubscribe = onlineManager.subscribe((online) => {
        if (online) {
          for (const listener of this.environmentListeners) {
            listener.onOnline?.();
          }
        }
      });
    }
  }
  maybeReleaseExternalSubscriptions() {
    if (this.hashListeners.size !== 0 || this.aggregateListeners.size !== 0 || this.environmentListeners.size !== 0 || this.retained.size !== 0 || this.gcCandidates.size !== 0 || this.intervalTimers.size !== 0 || this.staleTimers.size !== 0) {
      return;
    }
    this.cacheUnsubscribe?.();
    this.cacheUnsubscribe = void 0;
    this.focusUnsubscribe?.();
    this.focusUnsubscribe = void 0;
    this.onlineUnsubscribe?.();
    this.onlineUnsubscribe = void 0;
  }
  subscribeHash(hash, listener) {
    this.ensureExternalSubscriptions();
    let listeners = this.hashListeners.get(hash);
    if (!listeners) {
      listeners = /* @__PURE__ */ new Set();
      this.hashListeners.set(hash, listeners);
    }
    listeners.add(listener);
    return () => {
      const current = this.hashListeners.get(hash);
      current?.delete(listener);
      if (current && current.size === 0) this.hashListeners.delete(hash);
      this.maybeReleaseExternalSubscriptions();
    };
  }
  subscribeAggregate(hashes, listener) {
    this.ensureExternalSubscriptions();
    this.aggregateListeners.set(listener, new Set(hashes));
    return () => {
      this.aggregateListeners.delete(listener);
      this.maybeReleaseExternalSubscriptions();
    };
  }
  updateAggregate(hashes, listener) {
    const current = this.aggregateListeners.get(listener);
    if (current) {
      current.clear();
      for (const hash of hashes) current.add(hash);
    }
  }
  registerEnvironment(listener) {
    this.ensureExternalSubscriptions();
    this.environmentListeners.add(listener);
    return () => {
      this.environmentListeners.delete(listener);
      this.maybeReleaseExternalSubscriptions();
    };
  }
  onCacheEvent(event) {
    const query = event.query;
    const hash = query.queryHash;
    if (event.type === "removed") {
      this.gcCandidates.delete(query);
      this.retained.delete(query);
    }
    const listeners = this.hashListeners.get(hash);
    if (listeners) {
      for (const listener of listeners) listener(event);
    }
    for (const [listener, hashes] of this.aggregateListeners) {
      if (hashes.has(hash)) listener(hash, event);
    }
    if (event.type === "updated") {
      const candidate = this.gcCandidates.get(query);
      if (candidate && candidate.deadline <= Date.now()) {
        this.flushGcCandidate(candidate);
      }
    }
    this.scheduleGcTimer();
    this.maybeReleaseExternalSubscriptions();
  }
  /** QueryCache.build の共有入口。Query はイベント購読中にだけ作成する */
  buildQuery(options) {
    const defaulted = this.client.defaultQueryOptions(options);
    return this.cache.build(this.client, defaulted);
  }
  /** Direct Query.fetch を利用して共有 dedupe/retry/cancel を維持する */
  fetch(query, options, fetchOptions) {
    return query.fetch(options, fetchOptions);
  }
  retain(query, gcTime) {
    let retained = this.retained.get(query);
    if (!retained) {
      retained = {
        leases: 0,
        gcTime: queryGcTime(query)
      };
      this.retained.set(query, retained);
    }
    if (validTimeout(gcTime)) {
      retained.gcTime = Math.max(retained.gcTime, gcTime);
    } else if (gcTime === Infinity) {
      retained.gcTime = Infinity;
    }
    retained.leases++;
    this.gcCandidates.delete(query);
    if (this.gcCandidates.size === 0 && this.gcTimer !== void 0) {
      if (this.gcTimer !== void 0) clearTimeout(this.gcTimer);
      this.gcTimer = void 0;
      this.gcTimerDeadline = void 0;
    }
    clearQueryGcTimeout(query);
    query.gcTime = Infinity;
  }
  noteGcTime(query, gcTime) {
    const retained = this.retained.get(query);
    if (!retained || gcTime === void 0) return;
    retained.gcTime = gcTime === Infinity ? Infinity : Math.max(retained.gcTime, gcTime);
  }
  release(query) {
    const retained = this.retained.get(query);
    if (!retained) return;
    retained.leases--;
    if (retained.leases > 0) return;
    const optionGcTime = query.options.gcTime;
    if (typeof optionGcTime === "number") {
      retained.gcTime = optionGcTime === Infinity ? Infinity : Math.max(retained.gcTime, optionGcTime);
    }
    this.retained.delete(query);
    query.gcTime = retained.gcTime;
    if (query.getObserversCount() === 0) {
      this.scheduleReleasedQuery(query, retained.gcTime);
    }
    this.maybeReleaseExternalSubscriptions();
  }
  scheduleReleasedQuery(query, gcTime) {
    if (!validTimeout(gcTime)) {
      this.gcCandidates.delete(query);
      return;
    }
    const candidate = {
      query,
      deadline: Date.now() + gcTime
    };
    this.gcCandidates.set(query, candidate);
    this.scheduleGcTimer(candidate.deadline);
  }
  flushGcCandidate(candidate) {
    const { query } = candidate;
    if (this.retained.has(query)) {
      this.gcCandidates.delete(query);
      return;
    }
    if (query.getObserversCount() !== 0) {
      this.gcCandidates.delete(query);
      return;
    }
    if (query.state.fetchStatus !== "idle") {
      candidate.deadline = Date.now() + 1e3;
      return;
    }
    this.gcCandidates.delete(query);
    if (this.cache.get(query.queryHash) === query) {
      this.cache.remove(query);
    }
  }
  scheduleGcTimer(deadlineHint) {
    if (this.gcTimer !== void 0 && (deadlineHint === void 0 || this.gcTimerDeadline !== void 0 && this.gcTimerDeadline <= deadlineHint)) {
      return;
    }
    if (this.gcTimer !== void 0) clearTimeout(this.gcTimer);
    let next;
    for (const candidate of this.gcCandidates.values()) {
      if (!next || candidate.deadline < next.deadline) next = candidate;
    }
    if (!next) {
      this.gcTimer = void 0;
      this.gcTimerDeadline = void 0;
      return;
    }
    const delay = delayUntil(next.deadline);
    this.gcTimerDeadline = next.deadline;
    this.gcTimer = setTimeout(() => {
      this.gcTimer = void 0;
      this.gcTimerDeadline = void 0;
      const now = Date.now();
      for (const candidate of this.gcCandidates.values()) {
        if (candidate.deadline <= now) this.flushGcCandidate(candidate);
      }
      this.scheduleGcTimer();
      this.maybeReleaseExternalSubscriptions();
    }, delay);
  }
  scheduleStale(key, deadline, callback) {
    this.ensureExternalSubscriptions();
    this.staleTimers.set(key, { deadline, callback });
    this.scheduleStaleTimer(deadline);
  }
  cancelStale(key) {
    this.staleTimers.delete(key);
    if (this.staleTimers.size === 0 && this.staleTimer !== void 0) {
      if (this.staleTimer !== void 0) clearTimeout(this.staleTimer);
      this.staleTimer = void 0;
      this.staleTimerDeadline = void 0;
    }
    this.scheduleStaleTimer();
    this.maybeReleaseExternalSubscriptions();
  }
  scheduleStaleTimer(deadlineHint) {
    if (this.staleTimer !== void 0 && (deadlineHint === void 0 || this.staleTimerDeadline !== void 0 && this.staleTimerDeadline <= deadlineHint)) {
      return;
    }
    if (this.staleTimer !== void 0) clearTimeout(this.staleTimer);
    let next;
    for (const timer of this.staleTimers.values()) {
      if (!next || timer.deadline < next.deadline) next = timer;
    }
    if (!next) {
      this.staleTimer = void 0;
      this.staleTimerDeadline = void 0;
      return;
    }
    this.staleTimerDeadline = next.deadline;
    this.staleTimer = setTimeout(() => {
      this.staleTimer = void 0;
      this.staleTimerDeadline = void 0;
      const now = Date.now();
      for (const [key, timer] of this.staleTimers) {
        if (timer.deadline <= now) {
          this.staleTimers.delete(key);
          timer.callback();
        }
      }
      this.scheduleStaleTimer();
    }, delayUntil(next.deadline));
  }
  scheduleInterval(key, entry) {
    this.ensureExternalSubscriptions();
    if (!validTimeout(entry.interval) || entry.interval === 0) {
      this.cancelInterval(key);
      return;
    }
    const current = this.intervalTimers.get(key);
    this.intervalTimers.set(key, {
      ...entry,
      nextAt: current?.interval === entry.interval ? current.nextAt : Date.now() + entry.interval
    });
    this.scheduleIntervalTimer(this.intervalTimers.get(key)?.nextAt);
  }
  cancelInterval(key) {
    this.intervalTimers.delete(key);
    if (this.intervalTimers.size === 0 && this.intervalTimer !== void 0) {
      if (this.intervalTimer !== void 0) clearTimeout(this.intervalTimer);
      this.intervalTimer = void 0;
      this.intervalTimerDeadline = void 0;
    }
    this.scheduleIntervalTimer();
    this.maybeReleaseExternalSubscriptions();
  }
  scheduleIntervalTimer(deadlineHint) {
    if (this.intervalTimer !== void 0 && (deadlineHint === void 0 || this.intervalTimerDeadline !== void 0 && this.intervalTimerDeadline <= deadlineHint)) {
      return;
    }
    if (this.intervalTimer !== void 0) clearTimeout(this.intervalTimer);
    let nextAt;
    for (const timer of this.intervalTimers.values()) {
      if (nextAt === void 0 || timer.nextAt < nextAt) nextAt = timer.nextAt;
    }
    if (nextAt === void 0) {
      this.intervalTimer = void 0;
      this.intervalTimerDeadline = void 0;
      return;
    }
    this.intervalTimerDeadline = nextAt;
    this.intervalTimer = setTimeout(() => {
      this.intervalTimer = void 0;
      this.intervalTimerDeadline = void 0;
      const now = Date.now();
      for (const timer of this.intervalTimers.values()) {
        if (timer.nextAt <= now) {
          timer.nextAt = now + timer.interval;
          if (timer.inBackground?.() ?? true) timer.callback();
        }
      }
      this.scheduleIntervalTimer();
    }, delayUntil(nextAt));
  }
  destroy() {
    for (const [query, retained] of this.retained) {
      query.gcTime = retained.gcTime;
    }
    this.cacheUnsubscribe?.();
    this.cacheUnsubscribe = void 0;
    this.focusUnsubscribe?.();
    this.focusUnsubscribe = void 0;
    this.onlineUnsubscribe?.();
    this.onlineUnsubscribe = void 0;
    if (this.gcTimer !== void 0) clearTimeout(this.gcTimer);
    if (this.staleTimer !== void 0) clearTimeout(this.staleTimer);
    if (this.intervalTimer !== void 0) clearTimeout(this.intervalTimer);
    this.gcTimer = void 0;
    this.gcTimerDeadline = void 0;
    this.staleTimer = void 0;
    this.staleTimerDeadline = void 0;
    this.intervalTimer = void 0;
    this.intervalTimerDeadline = void 0;
    this.hashListeners.clear();
    this.aggregateListeners.clear();
    this.environmentListeners.clear();
    this.staleTimers.clear();
    this.intervalTimers.clear();
  }
};
function getLiteHub(client) {
  let hub = hubs.get(client);
  if (!hub) {
    hub = new LiteHub(client);
    hubs.set(client, hub);
  }
  return hub;
}
function resolveBoolean(value, query) {
  if (typeof value === "function") {
    return query ? value(query) : void 0;
  }
  return value;
}
function resolveStaleTime(value, query) {
  if (typeof value === "function") {
    return query ? value(query) : void 0;
  }
  return value;
}
function stateIsFetched(state) {
  return state.dataUpdateCount + state.errorUpdateCount > 0;
}
function staleByTime(state, staleTime) {
  if (state.data === void 0) return true;
  if (staleTime === "static") return false;
  if (state.isInvalidated) return true;
  return state.dataUpdatedAt + (staleTime || 0) <= Date.now();
}
function shareData(previous, next, options) {
  if (typeof options.structuralSharing === "function") {
    return options.structuralSharing(previous, next);
  }
  if (options.structuralSharing === false) return next;
  return replaceEqualDeep(previous, next);
}
function sameValues(next, previous) {
  if (!previous) return false;
  const nextKeys = Object.keys(next);
  const previousKeys = Object.keys(previous);
  if (nextKeys.length !== previousKeys.length) return false;
  for (const key of nextKeys) {
    if (next[key] !== previous[key]) return false;
  }
  return true;
}
function createLiteQueryResult(context) {
  const {
    query,
    state,
    queryInitialState,
    options,
    previousResult,
    previousResultState,
    previousResultOptions,
    lastQueryWithDefinedData,
    selectState
  } = context;
  let nextState = { ...state };
  let status = nextState.status;
  let error = nextState.error;
  let errorUpdatedAt = nextState.errorUpdatedAt;
  let data = nextState.data;
  let isPlaceholderData = false;
  let skipSelect = false;
  if (options.placeholderData !== void 0 && data === void 0 && status === "pending") {
    let placeholderData;
    if (previousResult?.isPlaceholderData && options.placeholderData === previousResultOptions?.placeholderData) {
      placeholderData = previousResult.data;
      skipSelect = true;
    } else {
      placeholderData = typeof options.placeholderData === "function" ? options.placeholderData(
        lastQueryWithDefinedData?.state.data,
        lastQueryWithDefinedData
      ) : options.placeholderData;
    }
    if (placeholderData !== void 0) {
      status = "success";
      data = shareData(previousResult?.data, placeholderData, options);
      isPlaceholderData = true;
    }
  }
  if (options.select && data !== void 0 && !skipSelect) {
    if (previousResult && data === previousResultState?.data && options.select === selectState?.selectFn) {
      data = selectState?.selectResult;
    } else {
      try {
        if (selectState) {
          selectState.selectFn = options.select;
        }
        const selected = options.select(data);
        data = shareData(previousResult?.data, selected, options);
        if (selectState) {
          selectState.selectResult = data;
          selectState.selectError = null;
        }
      } catch (selectError) {
        if (selectState) selectState.selectError = selectError;
      }
    }
  }
  if (selectState?.selectError) {
    error = selectState.selectError;
    data = selectState.selectResult;
    errorUpdatedAt = Date.now();
    status = "error";
  }
  const isFetching = nextState.fetchStatus === "fetching";
  const isPending = status === "pending";
  const isError = status === "error";
  const hasData = data !== void 0;
  const result = {
    status,
    fetchStatus: nextState.fetchStatus,
    isPending,
    isSuccess: status === "success",
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
    isFetchedAfterMount: nextState.dataUpdateCount > queryInitialState.dataUpdateCount || nextState.errorUpdateCount > queryInitialState.errorUpdateCount,
    isFetching,
    isRefetching: isFetching && !isPending,
    isLoadingError: isError && !hasData,
    isPaused: nextState.fetchStatus === "paused",
    isPlaceholderData,
    isRefetchError: isError && hasData,
    isStale: resolveBoolean(options.enabled, query) !== false && staleByTime(nextState, resolveStaleTime(options.staleTime, query)),
    refetch: context.refetch,
    promise: context.promise,
    isEnabled: resolveBoolean(options.enabled, query) !== false
  };
  return sameValues(
    result,
    previousResult
  ) ? previousResult : result;
}
function pageParam(options, data, previous) {
  if (!data || data.pages.length === 0) return void 0;
  if (previous) {
    return options.getPreviousPageParam?.(
      data.pages[0],
      data.pages,
      data.pageParams[0],
      data.pageParams
    );
  }
  const index = data.pages.length - 1;
  return options.getNextPageParam(
    data.pages[index],
    data.pages,
    data.pageParams[index],
    data.pageParams
  );
}
function createLiteInfiniteQueryResult(context) {
  const parent = createLiteQueryResult(context);
  const fetchDirection = context.state.fetchMeta?.fetchMore?.direction;
  const isFetchNextPageError = parent.isError && fetchDirection === "forward";
  const isFetchPreviousPageError = parent.isError && fetchDirection === "backward";
  const data = context.state.data;
  const result = {
    ...parent,
    fetchNextPage: context.fetchNextPage,
    fetchPreviousPage: context.fetchPreviousPage,
    hasNextPage: pageParam(context.options, data, false) != null,
    hasPreviousPage: context.options.getPreviousPageParam !== void 0 && pageParam(context.options, data, true) != null,
    isFetchNextPageError,
    isFetchingNextPage: parent.isFetching && fetchDirection === "forward",
    isFetchPreviousPageError,
    isFetchingPreviousPage: parent.isFetching && fetchDirection === "backward",
    isRefetchError: parent.isRefetchError && !isFetchNextPageError && !isFetchPreviousPageError,
    isRefetching: parent.isRefetching && !(parent.isFetching && fetchDirection === "forward") && !(parent.isFetching && fetchDirection === "backward")
  };
  return sameValues(
    result,
    context.previousResult
  ) ? context.previousResult : result;
}
function trackLiteResult(result, trackedProps, onPropTracked) {
  return new Proxy(result, {
    get(target, key, receiver) {
      trackedProps.add(key);
      onPropTracked?.(key);
      return Reflect.get(target, key, receiver);
    }
  });
}
function liteResultChanged(next, previous, notifyOnChangeProps, trackedProps, throwOnError) {
  if (!previous) return true;
  const configured = typeof notifyOnChangeProps === "function" ? notifyOnChangeProps() : notifyOnChangeProps;
  if (configured === "all" || !configured && trackedProps.size === 0) {
    return true;
  }
  const included = new Set(
    configured ?? trackedProps
  );
  if (throwOnError) included.add("error");
  for (const key of Object.keys(next)) {
    if (next[key] !== previous[key] && included.has(key)) return true;
  }
  return false;
}
function shouldLiteThrowError(result, options, query) {
  if (!result.isError || result.isFetching || !query) return false;
  if (options.suspense && result.data === void 0) return true;
  if (typeof options.throwOnError === "function") {
    return shouldThrowError(options.throwOnError, [result.error, query]);
  }
  return options.throwOnError === true;
}

// src/warnings.ts
var warnedFields = /* @__PURE__ */ new Set();
var isDevelopment = typeof process !== "undefined" && process.env.NODE_ENV !== "production";
function warnOnce(field, message) {
  if (!isDevelopment || warnedFields.has(field)) {
    return;
  }
  warnedFields.add(field);
  console.warn(message);
}
function warnUnsupportedOption(field, detail) {
  warnOnce(
    `option:${field}`,
    `[tanstack-query-lite-hooks] The query option "${field}" is not supported by the lite runtime and will be ignored.`
  );
}
function warnUnsupportedResultProperty(field) {
  warnOnce(
    `result:${field}`,
    `[tanstack-query-lite-hooks] The result property "${field}" is not supported by the lite runtime.`
  );
}
var pausedSuspensePromise = new Promise(() => void 0);
function resolveBoolean2(value, query) {
  return typeof value === "function" ? value(query) : value;
}
function resolveRefetchPolicy(value, query) {
  return typeof value === "function" ? value(query) : value;
}
function resolveStaleTime2(value, query) {
  if (query === void 0) return typeof value === "number" || value === "static" ? value : void 0;
  return typeof value === "function" ? value(query) : value;
}
function resolveInterval(value, query) {
  return typeof value === "function" ? value(query) : value;
}
function isEnabled(options, query) {
  return resolveBoolean2(options.enabled, query) !== false;
}
function isSkipped(options) {
  return options.queryFn === skipToken;
}
function isStale(options, query) {
  const staleTime = resolveStaleTime2(options.staleTime, query);
  return query.isStaleByTime(staleTime);
}
function isValidTimeout(value) {
  return typeof value === "number" && value >= 0 && value !== Infinity;
}
function defaultSuspenseOptions(options) {
  const next = {
    ...options,
    enabled: true,
    placeholderData: void 0,
    suspense: true,
    throwOnError: (_error, query) => query.state.data === void 0
  };
  const staleTime = options.staleTime;
  if (staleTime === void 0) next.staleTime = 1e3;
  else if (typeof staleTime === "number") next.staleTime = Math.max(staleTime, 1e3);
  if (options.gcTime !== void 0 && options.gcTime !== Infinity) {
    next.gcTime = Math.max(options.gcTime, 1e3);
  }
  return next;
}
function asPromise(value, fallback) {
  return value ? Promise.resolve(value) : Promise.resolve(fallback);
}
var LiteQueryEntry = class {
  client;
  hub;
  query;
  hash;
  queryInitialState;
  trackedProps = /* @__PURE__ */ new Set();
  selectState = {
    selectError: null
  };
  options;
  previousResult;
  previousResultState;
  previousResultOptions;
  lastQueryWithDefinedData;
  rawResult;
  trackedResult;
  resultDirty = true;
  currentPromise;
  cacheRelease;
  resultListeners = /* @__PURE__ */ new Set();
  lease = false;
  environmentRelease;
  hasCommit = false;
  staleTimerKey = {};
  intervalTimerKey = {};
  isRestoring = false;
  rebinding = false;
  constructor(client, hub, options, previous, query) {
    this.client = client;
    this.hub = hub;
    this.options = options;
    this.query = query ?? hub.buildQuery(options);
    this.hash = this.query.queryHash;
    this.queryInitialState = this.query.state;
    this.previousResult = previous?.rawResult;
    this.previousResultState = previous?.query.state;
    this.previousResultOptions = previous?.options;
    this.lastQueryWithDefinedData = previous?.query.state.data === void 0 ? void 0 : previous.query;
  }
  update(options, isRestoring = false) {
    if (this.options !== options || this.isRestoring !== isRestoring) {
      this.options = options;
      this.isRestoring = isRestoring;
      this.resultDirty = true;
    }
  }
  rebind(query) {
    if (query === this.query) return;
    const previousQuery = this.query;
    this.previousResultState = previousQuery.state;
    if (previousQuery.state.data !== void 0) this.lastQueryWithDefinedData = previousQuery;
    if (this.lease) this.hub.release(previousQuery);
    this.query = query;
    this.queryInitialState = query.state;
    this.currentPromise = void 0;
    this.rawResult = void 0;
    this.trackedResult = void 0;
    this.resultDirty = true;
    this.autoFetchAttempted = false;
    this.wasAutoFetchEligible = false;
    if (this.hasCommit) this.applyOptions();
    if (this.lease) this.hub.retain(query, this.options.gcTime);
  }
  applyOptions() {
    this.query.setOptions(this.options);
  }
  resultContext() {
    const fallback = this.query.state.data;
    const promise = asPromise(
      this.currentPromise ?? this.query.promise,
      fallback
    );
    const useOptimisticFetchState = !this.hasCommit && !this.isRestoring && this.options.subscribed !== false && this.query.state.status === "pending" && this.query.state.fetchStatus === "idle" && isEnabled(this.options, this.query) && !isSkipped(this.options);
    return {
      query: this.query,
      state: useOptimisticFetchState ? { ...this.query.state, fetchStatus: "fetching" } : this.query.state,
      queryInitialState: this.queryInitialState,
      options: this.options,
      previousResult: this.rawResult,
      previousResultState: this.previousResultState,
      previousResultOptions: this.previousResultOptions,
      lastQueryWithDefinedData: this.lastQueryWithDefinedData,
      selectState: this.selectState,
      refetch: this.refetch,
      promise
    };
  }
  computeResult() {
    const next = createLiteQueryResult(this.resultContext());
    this.previousResultState = this.query.state;
    this.previousResultOptions = this.options;
    if (this.query.state.data !== void 0) this.lastQueryWithDefinedData = this.query;
    this.rawResult = next;
    return next;
  }
  snapshot() {
    if (!this.resultDirty && this.trackedResult) return this.trackedResult;
    const previous = this.rawResult;
    const raw = this.computeResult();
    this.resultDirty = false;
    if (this.trackedResult && raw === previous) return this.trackedResult;
    this.trackedResult = trackLiteResult(raw, this.trackedProps, (key) => {
      if (key === "promise") warnUnsupportedResultProperty("promise");
    });
    return this.trackedResult;
  }
  rawSnapshot() {
    this.snapshot();
    return this.rawResult;
  }
  emitChanged() {
    this.resultDirty = true;
    const previous = this.rawResult;
    const next = this.computeResult();
    this.resultDirty = false;
    const changed = liteResultChanged(
      next,
      previous,
      this.options.notifyOnChangeProps,
      this.trackedProps,
      this.options.throwOnError
    );
    if (changed) {
      this.trackedResult = trackLiteResult(next, this.trackedProps, (key) => {
        if (key === "promise") warnUnsupportedResultProperty("promise");
      });
      for (const listener of this.resultListeners) listener();
    }
    return changed;
  }
  onCacheEvent(event) {
    const cacheEvent = event;
    if (cacheEvent.query && cacheEvent.query !== this.query) {
      this.rebind(cacheEvent.query);
    } else if (cacheEvent.type === "removed" && !this.rebinding) {
      this.rebinding = true;
      try {
        this.rebind(this.hub.buildQuery(this.options));
      } finally {
        this.rebinding = false;
      }
    }
    const action = cacheEvent.action;
    if (action?.type === "invalidate" && this.hasCommit && !this.isRestoring && this.options.subscribed !== false && isEnabled(this.options, this.query) && !isSkipped(this.options)) {
      this.autoFetchAttempted = true;
      void this.runFetch({ cancelRefetch: false }).catch(() => void 0);
    }
    return this.emitChanged();
  }
  addResultListener(listener) {
    this.resultListeners.add(listener);
    return () => this.resultListeners.delete(listener);
  }
  subscribe(listener) {
    if (this.isRestoring || this.options.subscribed === false) return () => void 0;
    this.resultListeners.add(listener);
    if (!this.cacheRelease) {
      this.cacheRelease = this.hub.subscribeHash(this.hash, (event) => {
        this.onCacheEvent(event);
      });
    }
    return () => {
      this.resultListeners.delete(listener);
      if (this.resultListeners.size === 0) {
        this.cacheRelease?.();
        this.cacheRelease = void 0;
      }
    };
  }
  autoFetchAttempted = false;
  wasAutoFetchEligible = false;
  shouldAutoFetch() {
    if (!this.hasCommit || this.isRestoring || this.options.subscribed === false) return false;
    if (!isEnabled(this.options, this.query) || isSkipped(this.options)) return false;
    if (this.query.state.status === "error" && this.options.retryOnMount === false) return false;
    if (this.query.state.data === void 0) return true;
    const policy = resolveRefetchPolicy(this.options.refetchOnMount, this.query);
    if (policy === "always") return true;
    if (policy === false) return false;
    return isStale(this.options, this.query);
  }
  runFetch(fetchOptions) {
    this.applyOptions();
    const pending = this.hub.fetch(this.query, this.options, fetchOptions);
    this.currentPromise = pending;
    void pending.then(
      () => {
        if (this.currentPromise === pending) this.currentPromise = void 0;
      },
      () => {
        if (this.currentPromise === pending) this.currentPromise = void 0;
      }
    );
    return pending;
  }
  startFetchInRender() {
    if (this.isRestoring || this.options.subscribed === false || isSkipped(this.options) || !isEnabled(this.options, this.query)) return void 0;
    if (this.query.state.status === "error" && this.query.state.fetchStatus === "idle") {
      return void 0;
    }
    if (this.query.state.data !== void 0) {
      if (this.query.promise) return void 0;
      if (!isStale(this.options, this.query)) return void 0;
      void this.runFetch({ cancelRefetch: false }).catch(() => void 0);
      return void 0;
    }
    if (this.query.promise) return this.query.promise;
    return this.runFetch({ cancelRefetch: false });
  }
  afterCommit() {
    this.applyOptions();
    this.hasCommit = true;
    const eligible = !this.isRestoring && isEnabled(this.options, this.query) && !isSkipped(this.options);
    if (eligible && !this.wasAutoFetchEligible) {
      this.autoFetchAttempted = false;
    }
    this.wasAutoFetchEligible = eligible;
    if (!this.autoFetchAttempted && this.shouldAutoFetch()) {
      this.autoFetchAttempted = true;
      void this.runFetch({ cancelRefetch: false }).catch(() => void 0);
    }
    this.configureTimers();
  }
  commit(manageEnvironment = true) {
    this.applyOptions();
    this.hasCommit = true;
    if (!this.isRestoring && this.options.subscribed !== false && !this.lease) {
      this.lease = true;
      this.hub.retain(this.query, this.options.gcTime);
    }
    this.hub.noteGcTime(this.query, this.options.gcTime);
    this.environmentRelease?.();
    this.environmentRelease = void 0;
    if (!this.isRestoring && manageEnvironment && this.options.subscribed !== false) {
      const environment = {
        onFocus: () => this.triggerRefetch(this.options.refetchOnWindowFocus),
        onOnline: () => this.triggerRefetch(this.options.refetchOnReconnect)
      };
      this.environmentRelease = this.hub.registerEnvironment(environment);
    }
    this.configureTimers();
  }
  release() {
    this.hasCommit = false;
    this.environmentRelease?.();
    this.environmentRelease = void 0;
    this.hub.cancelStale(this.staleTimerKey);
    this.hub.cancelInterval(this.intervalTimerKey);
    if (this.lease) {
      this.lease = false;
      this.hub.release(this.query);
    }
  }
  configureTimers() {
    if (!this.hasCommit || this.isRestoring || this.options.subscribed === false) {
      this.hub.cancelStale(this.staleTimerKey);
      this.hub.cancelInterval(this.intervalTimerKey);
      return;
    }
    const interval = resolveInterval(this.options.refetchInterval, this.query);
    if (isValidTimeout(interval) && interval > 0) {
      this.hub.scheduleInterval(this.intervalTimerKey, {
        interval,
        callback: () => {
          if (!this.hasCommit || !isEnabled(this.options, this.query) || isSkipped(this.options) || this.options.refetchIntervalInBackground !== true && !focusManager.isFocused()) return;
          void this.runFetch({ cancelRefetch: false }).catch(() => void 0);
        },
        inBackground: () => this.options.refetchIntervalInBackground === true || focusManager.isFocused()
      });
    } else {
      this.hub.cancelInterval(this.intervalTimerKey);
    }
    const staleTime = resolveStaleTime2(this.options.staleTime, this.query);
    const configuredNotify = typeof this.options.notifyOnChangeProps === "function" ? this.options.notifyOnChangeProps() : this.options.notifyOnChangeProps;
    const tracksStale = configuredNotify === "all" || Array.isArray(configuredNotify) && configuredNotify.includes("isStale") || this.trackedProps.has("isStale");
    if (tracksStale && this.query.state.data !== void 0 && typeof staleTime === "number" && isValidTimeout(staleTime) && !this.query.state.isInvalidated) {
      this.hub.scheduleStale(
        this.staleTimerKey,
        this.query.state.dataUpdatedAt + staleTime + 1,
        () => this.emitChanged()
      );
    } else {
      this.hub.cancelStale(this.staleTimerKey);
    }
  }
  triggerRefetch(setting) {
    if (!this.hasCommit || this.isRestoring || this.options.subscribed === false || !isEnabled(this.options, this.query) || isSkipped(this.options)) return;
    const policy = resolveRefetchPolicy(setting, this.query);
    if (policy === false) return;
    if (policy !== "always" && !isStale(this.options, this.query)) return;
    void this.runFetch({ cancelRefetch: false }).catch(() => void 0);
  }
  refetch = async (refetchOptions) => {
    if (isSkipped(this.options)) {
      throw new Error(`Missing queryFn: '${this.hash}'`);
    }
    const fetchOptions = {
      cancelRefetch: refetchOptions?.cancelRefetch ?? true
    };
    try {
      await this.runFetch(fetchOptions);
    } catch (error) {
      if (refetchOptions?.throwOnError || isSkipped(this.options)) throw error;
    }
    return this.snapshot();
  };
};
function useEntry(options, client, isRestoring) {
  "use no memo";
  const hub = getLiteHub(client);
  const currentQuery = hub.buildQuery(options);
  const previous = useRef(void 0);
  const entry = useMemo(
    () => new LiteQueryEntry(client, hub, options, previous.current, currentQuery),
    [client, currentQuery]
  );
  entry.update(options, isRestoring);
  previous.current = entry;
  return entry;
}
function useQueryLite(options, explicitClient) {
  "use no memo";
  const client = useQueryClient(explicitClient);
  const isRestoring = useIsRestoring();
  const defaulted = client.defaultQueryOptions(options);
  const entry = useEntry(defaulted, client, isRestoring);
  const subscribed = defaulted.subscribed !== false && !isRestoring;
  const subscribe = useCallback(
    (listener) => entry.subscribe(listener),
    [entry, subscribed]
  );
  const getSnapshot = useCallback(() => entry.snapshot(), [entry]);
  const result = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useLayoutEffect(() => {
    entry.commit();
    return () => entry.release();
  }, [entry, subscribed]);
  useEffect(() => {
    if (defaulted.experimental_prefetchInRender) {
      warnUnsupportedOption("experimental_prefetchInRender");
    }
    entry.afterCommit();
  });
  const rawResult = entry.rawSnapshot();
  if (shouldLiteThrowError(rawResult, defaulted, entry.query)) throw rawResult.error;
  return result;
}
function createAggregateRuntime(client, hub) {
  const runtime = {
    client,
    hub,
    entries: [],
    hashIndexes: /* @__PURE__ */ new Map(),
    options: {},
    previousSnapshot: void 0,
    previousItems: [],
    dirtyIndexes: /* @__PURE__ */ new Set(),
    previousCombine: void 0,
    releaseEntries: [],
    resultReleases: [],
    environmentRelease: void 0,
    aggregateListener: void 0,
    notifyListener: void 0,
    processingCacheEvent: false,
    subscribed: true,
    committed: false,
    subscribe(listener) {
      if (!runtime.subscribed) return () => void 0;
      runtime.notifyListener = listener;
      runtime.aggregateListener = (hash, event) => {
        runtime.processingCacheEvent = true;
        try {
          runtime.onCacheEvent(hash, event);
        } finally {
          runtime.processingCacheEvent = false;
        }
        runtime.notifyIfChanged();
      };
      runtime.attachResultListeners();
      const releaseAggregate = runtime.hub.subscribeAggregate(
        runtime.entries.map((entry) => entry.hash),
        runtime.aggregateListener
      );
      return () => {
        releaseAggregate();
        for (const release of runtime.resultReleases) release();
        runtime.resultReleases = [];
        if (runtime.notifyListener === listener) runtime.notifyListener = void 0;
      };
    },
    update(entries, options) {
      const nextSubscribed = options.subscribed !== false && options.isRestoring !== true;
      if (runtime.entries === entries && runtime.options.combine === options.combine && runtime.subscribed === nextSubscribed) return;
      const previousEntries = runtime.entries;
      const entriesChanged = previousEntries !== entries;
      runtime.entries = entries;
      runtime.hashIndexes = /* @__PURE__ */ new Map();
      entries.forEach((entry, index) => {
        const indexes = runtime.hashIndexes.get(entry.hash);
        if (indexes) indexes.push(index);
        else runtime.hashIndexes.set(entry.hash, [index]);
      });
      runtime.options = options;
      runtime.subscribed = nextSubscribed;
      runtime.dirtyIndexes.clear();
      for (let index = 0; index < entries.length; index++) {
        if (entriesChanged || entries[index]?.options.subscribed === false) runtime.dirtyIndexes.add(index);
      }
      if (runtime.previousCombine !== options.combine) {
        runtime.previousCombine = options.combine;
        for (let index = 0; index < entries.length; index++) runtime.dirtyIndexes.add(index);
      }
      if (runtime.committed) {
        if (runtime.aggregateListener) {
          runtime.hub.updateAggregate(entries.map((entry) => entry.hash), runtime.aggregateListener);
        }
        runtime.attachResultListeners();
      }
    },
    snapshot() {
      if (runtime.previousSnapshot !== void 0 && runtime.dirtyIndexes.size === 0) {
        return runtime.previousSnapshot;
      }
      const items = runtime.previousItems.length === runtime.entries.length ? runtime.previousItems : Array.from({ length: runtime.entries.length });
      for (const index of runtime.dirtyIndexes) items[index] = runtime.entries[index].snapshot();
      for (let index = 0; index < runtime.entries.length; index++) {
        if (items[index] === void 0) items[index] = runtime.entries[index].snapshot();
      }
      runtime.dirtyIndexes.clear();
      runtime.previousItems = items;
      runtime.previousSnapshot = runtime.options.combine ? runtime.options.combine(items) : items.slice();
      return runtime.previousSnapshot;
    },
    commit() {
      runtime.committed = true;
      const next = new Set(runtime.entries);
      for (const entry of runtime.releaseEntries) {
        if (!next.has(entry)) entry.release();
      }
      if (!runtime.subscribed) {
        for (const entry of runtime.releaseEntries) entry.release();
        runtime.releaseEntries = [];
        runtime.environmentRelease?.();
        runtime.environmentRelease = void 0;
        runtime.attachResultListeners();
        return;
      }
      runtime.releaseEntries = [...runtime.entries];
      for (const entry of runtime.entries) entry.commit(false);
      runtime.attachResultListeners();
      runtime.environmentRelease?.();
      runtime.environmentRelease = runtime.hub.registerEnvironment({
        onFocus: () => runtime.onEnvironment("focus"),
        onOnline: () => runtime.onEnvironment("online")
      });
    },
    release() {
      runtime.committed = false;
      runtime.environmentRelease?.();
      runtime.environmentRelease = void 0;
      for (const release of runtime.resultReleases) release();
      runtime.resultReleases = [];
      for (const entry of runtime.releaseEntries) entry.release();
      runtime.releaseEntries = [];
    },
    onEnvironment(setting) {
      if (!runtime.subscribed) return;
      for (const entry of runtime.entries) {
        entry.triggerRefetch(setting === "focus" ? entry.options.refetchOnWindowFocus : entry.options.refetchOnReconnect);
      }
    },
    onCacheEvent(hash, event) {
      const indexes = runtime.hashIndexes.get(hash);
      if (!indexes || indexes.length === 0) return;
      for (const index of indexes) {
        const entry = runtime.entries[index];
        if (entry.options.subscribed === false) continue;
        if (entry.onCacheEvent(event)) runtime.dirtyIndexes.add(index);
      }
    },
    notifyIfChanged() {
      if (runtime.dirtyIndexes.size === 0 || !runtime.notifyListener) return;
      const previous = runtime.previousSnapshot;
      const next = runtime.snapshot();
      if (next !== previous) runtime.notifyListener();
    },
    attachResultListeners() {
      for (const release of runtime.resultReleases) release();
      runtime.resultReleases = runtime.subscribed ? [...new Set(runtime.entries)].filter((entry) => entry.options.subscribed !== false).map(
        (entry) => entry.addResultListener(() => {
          for (const index of runtime.hashIndexes.get(entry.hash) ?? []) {
            runtime.dirtyIndexes.add(index);
          }
          if (!runtime.processingCacheEvent) runtime.notifyIfChanged();
        })
      ) : [];
    }
  };
  return runtime;
}
function useQueriesLite(options, explicitClient) {
  "use no memo";
  const client = useQueryClient(explicitClient);
  const isRestoring = useIsRestoring();
  const defaultedQueries = useMemo(
    () => options.queries.map(
      (query) => client.defaultQueryOptions(query)
    ),
    [client, options.queries]
  );
  const hub = getLiteHub(client);
  const previousEntriesState = useRef(void 0);
  if (!previousEntriesState.current || previousEntriesState.current.client !== client) {
    previousEntriesState.current = { client, entries: [] };
  }
  const entries = useMemo(() => {
    const previousEntries = previousEntriesState.current.entries;
    const previousByHash = /* @__PURE__ */ new Map();
    for (let index = previousEntries.length - 1; index >= 0; index -= 1) {
      const entry = previousEntries[index];
      const bucket = previousByHash.get(entry.hash);
      if (bucket) bucket.push(entry);
      else previousByHash.set(entry.hash, [entry]);
    }
    return defaultedQueries.map((query) => {
      const hash = query.queryHash;
      const currentQuery = hub.buildQuery(query);
      const previous = previousByHash.get(hash)?.pop();
      const entry = previous?.query === currentQuery ? previous : new LiteQueryEntry(client, hub, query, previous, currentQuery);
      entry.update(query, isRestoring);
      return entry;
    });
  }, [client, defaultedQueries, hub, isRestoring]);
  previousEntriesState.current.entries = entries;
  const runtime = useMemo(() => createAggregateRuntime(client, hub), [client, hub]);
  runtime.update(entries, { ...options, isRestoring });
  const subscribe = useCallback(
    (listener) => runtime.subscribe(listener),
    [runtime, options.subscribed, isRestoring]
  );
  const getSnapshot = useCallback(() => runtime.snapshot(), [runtime]);
  const result = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useLayoutEffect(() => {
    runtime.commit();
    return () => runtime.release();
  }, [runtime, entries, options.subscribed, isRestoring]);
  useEffect(() => {
    for (const entry of entries) {
      if (entry.options.experimental_prefetchInRender) {
        warnUnsupportedOption("experimental_prefetchInRender");
      }
      entry.afterCommit();
    }
  });
  return result;
}
function useSuspenseQueryLite(options, queryClient) {
  "use no memo";
  const client = useQueryClient(queryClient);
  const isRestoring = useIsRestoring();
  const defaulted = defaultSuspenseOptions(
    client.defaultQueryOptions(options)
  );
  const entry = useEntry(defaulted, client, isRestoring);
  const subscribed = defaulted.subscribed !== false && !isRestoring;
  const subscribe = useCallback(
    (listener) => entry.subscribe(listener),
    [entry, subscribed]
  );
  const getSnapshot = useCallback(() => entry.snapshot(), [entry]);
  const result = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const pending = entry.startFetchInRender();
  useLayoutEffect(() => {
    entry.commit();
    return () => entry.release();
  }, [entry, subscribed]);
  useEffect(() => {
    if (defaulted.experimental_prefetchInRender) {
      warnUnsupportedOption("experimental_prefetchInRender");
    }
    entry.afterCommit();
  });
  if ((isRestoring || defaulted.subscribed === false) && entry.query.state.data === void 0) throw pausedSuspensePromise;
  if (pending) throw pending;
  const rawResult = entry.rawSnapshot();
  if (shouldLiteThrowError(rawResult, defaulted, entry.query)) throw rawResult.error;
  return result;
}
function useSuspenseQueriesLite(options, explicitClient) {
  "use no memo";
  const client = useQueryClient(explicitClient);
  const isRestoring = useIsRestoring();
  const defaultedQueries = useMemo(
    () => options.queries.map(
      (query) => defaultSuspenseOptions(client.defaultQueryOptions(query))
    ),
    [client, options.queries]
  );
  const hub = getLiteHub(client);
  const previousEntriesState = useRef(void 0);
  if (!previousEntriesState.current || previousEntriesState.current.client !== client) {
    previousEntriesState.current = { client, entries: [] };
  }
  const entries = useMemo(() => {
    const previousEntries = previousEntriesState.current.entries;
    const previousByHash = /* @__PURE__ */ new Map();
    for (let index = previousEntries.length - 1; index >= 0; index -= 1) {
      const entry = previousEntries[index];
      const bucket = previousByHash.get(entry.hash);
      if (bucket) bucket.push(entry);
      else previousByHash.set(entry.hash, [entry]);
    }
    return defaultedQueries.map((query) => {
      const hash = query.queryHash;
      const currentQuery = hub.buildQuery(query);
      const previous = previousByHash.get(hash)?.pop();
      const entry = previous?.query === currentQuery ? previous : new LiteQueryEntry(client, hub, query, previous, currentQuery);
      entry.update(query, isRestoring);
      return entry;
    });
  }, [client, defaultedQueries, hub, isRestoring]);
  previousEntriesState.current.entries = entries;
  const runtime = useMemo(() => createAggregateRuntime(client, hub), [client, hub]);
  runtime.update(entries, { ...options, isRestoring });
  const aggregateSubscribed = options.subscribed !== false && !isRestoring;
  const subscribe = useCallback(
    (listener) => runtime.subscribe(listener),
    [runtime, aggregateSubscribed]
  );
  const getSnapshot = useCallback(() => runtime.snapshot(), [runtime]);
  const result = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const pending = entries.map((entry) => entry.startFetchInRender()).filter((promise) => promise !== void 0);
  useLayoutEffect(() => {
    runtime.commit();
    return () => runtime.release();
  }, [runtime, entries, aggregateSubscribed]);
  useEffect(() => {
    for (const entry of entries) {
      if (entry.options.experimental_prefetchInRender) {
        warnUnsupportedOption("experimental_prefetchInRender");
      }
      entry.afterCommit();
    }
  });
  if ((isRestoring || entries.some((entry) => entry.options.subscribed === false)) && entries.some((entry) => entry.query.state.data === void 0)) throw pausedSuspensePromise;
  if (pending.length > 0) throw Promise.all(pending);
  for (const entry of entries) {
    const current = entry.rawSnapshot();
    if (shouldLiteThrowError(current, entry.options, entry.query)) throw current.error;
  }
  return result;
}
var pausedSuspensePromise2 = new Promise(() => void 0);
function resolveEnabled(value, query) {
  if (typeof value === "function") {
    return value(query);
  }
  return value;
}
function resolveStaleTime3(value, query) {
  if (typeof value === "function") {
    return value(
      query
    );
  }
  return value;
}
function resolveRefetchTrigger(value, query) {
  if (typeof value === "function") {
    return value(query);
  }
  return value;
}
function isStale2(query, options) {
  const staleTime = resolveStaleTime3(options.staleTime, query);
  return resolveEnabled(options.enabled, query) !== false && query.isStaleByTime(staleTime === void 0 ? 0 : staleTime);
}
function shouldFetchOnMount(query, options) {
  if (resolveEnabled(options.enabled, query) === false) return false;
  if (query.state.data === void 0) {
    return !(query.state.status === "error" && resolveEnabled(options.retryOnMount, query) === false);
  }
  if (resolveStaleTime3(options.staleTime, query) === "static") return false;
  const trigger = resolveRefetchTrigger(options.refetchOnMount, query);
  return trigger === "always" || trigger !== false && isStale2(query, options);
}
function shouldFetchOnEnvironment(query, options, field) {
  if (resolveEnabled(options.enabled, query) === false) return false;
  if (resolveStaleTime3(options.staleTime, query) === "static") return false;
  const trigger = resolveRefetchTrigger(field, query);
  return trigger === "always" || trigger !== false && isStale2(query, options);
}
function suspenseOptions(options) {
  const staleTime = options.staleTime;
  const suspenseStaleTime = staleTime === "static" ? staleTime : typeof staleTime === "function" ? (...args) => (() => {
    const resolved = staleTime(...args);
    return resolved === "static" ? resolved : Math.max(resolved ?? 1e3, 1e3);
  })() : Math.max(staleTime ?? 1e3, 1e3);
  const next = {
    ...options,
    enabled: true,
    placeholderData: void 0,
    suspense: true,
    throwOnError: (_error, query) => query.state.data === void 0,
    staleTime: suspenseStaleTime
  };
  if (typeof options.gcTime === "number") {
    next.gcTime = Math.max(options.gcTime, 1e3);
  }
  return next;
}
function getPromise(query, memory) {
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
function resetMemoryForQuery(memory, query) {
  if (memory.query === query) return;
  memory.query = query;
  memory.queryInitialState = query.state;
  memory.previousResult = void 0;
  memory.previousResultState = void 0;
  memory.previousResultOptions = void 0;
  memory.selectState = {
    selectFn: void 0,
    selectResult: void 0,
    selectError: null
  };
  memory.promise = void 0;
  memory.promiseData = void 0;
}
function updateResult(runtime, refetch, fetchNextPage, fetchPreviousPage) {
  const { query, options, memory } = runtime;
  resetMemoryForQuery(memory, query);
  if (memory.selectState.selectFn !== options.select) {
    memory.selectState = {
      selectFn: void 0,
      selectResult: void 0,
      selectError: null
    };
  }
  const useOptimisticFetchState = !runtime.autoFetchAttempted && !runtime.isRestoring && options.subscribed !== false && query.state.status === "pending" && query.state.fetchStatus === "idle" && resolveEnabled(options.enabled, query) !== false && options.queryFn !== skipToken;
  const context = {
    query,
    state: useOptimisticFetchState ? { ...query.state, fetchStatus: "fetching" } : query.state,
    queryInitialState: memory.queryInitialState ?? query.state,
    options,
    previousResult: memory.previousResult,
    previousResultState: memory.previousResultState,
    previousResultOptions: memory.previousResultOptions,
    selectState: memory.selectState,
    refetch,
    fetchNextPage,
    fetchPreviousPage,
    promise: getPromise(query, memory)
  };
  const result = createLiteInfiniteQueryResult(context);
  memory.previousResult = result;
  memory.previousResultState = query.state;
  memory.previousResultOptions = options;
  return trackLiteResult(result, memory.trackedProps, (key) => {
    if (key === "promise") warnUnsupportedResultProperty("promise");
  });
}
function runFetch(runtime, fetchOptions, direction) {
  const { hub, query, options } = runtime;
  const queryFetchOptions = direction ? {
    ...fetchOptions,
    cancelRefetch: fetchOptions.cancelRefetch ?? true,
    meta: { fetchMore: { direction } }
  } : {
    ...fetchOptions,
    cancelRefetch: fetchOptions.cancelRefetch ?? true
  };
  let promise = hub.fetch(query, options, queryFetchOptions);
  if (!fetchOptions.throwOnError) {
    promise = promise.catch(() => void 0);
  }
  return promise.then(() => runtime.refresh?.() ?? runtime.result);
}
function useInfiniteRuntime(options, explicitClient) {
  "use no memo";
  const client = useQueryClient(explicitClient);
  const isRestoring = useIsRestoring();
  const hub = useMemo(() => getLiteHub(client), [client]);
  const defaultedOptions = client.defaultQueryOptions({
    ...options,
    _type: "infinite"
  });
  const query = hub.buildQuery(defaultedOptions);
  const memory = useMemo(
    () => ({
      query,
      queryInitialState: query.state,
      selectState: { selectError: null },
      trackedProps: /* @__PURE__ */ new Set()
    }),
    [query]
  );
  const staleTimerKey = useRef(void 0);
  const intervalTimerKey = useRef(void 0);
  if (!staleTimerKey.current) staleTimerKey.current = {};
  if (!intervalTimerKey.current) intervalTimerKey.current = {};
  const runtime = useMemo(
    () => ({
      client,
      hub,
      query,
      options: defaultedOptions,
      memory,
      result: void 0,
      listener: void 0,
      autoFetchAttempted: false,
      wasAutoFetchEligible: false,
      isRestoring
    }),
    [client, hub, memory, query]
  );
  runtime.options = defaultedOptions;
  runtime.isRestoring = isRestoring;
  const actions = useMemo(
    () => ({
      refetch: (fetchOptions) => runFetch(runtime, fetchOptions ?? {}, void 0),
      fetchNextPage: (fetchOptions) => runFetch(runtime, fetchOptions ?? {}, "forward"),
      fetchPreviousPage: (fetchOptions) => runFetch(runtime, fetchOptions ?? {}, "backward")
    }),
    [runtime]
  );
  const makeResult = useCallback(() => {
    const next = updateResult(
      runtime,
      actions.refetch,
      actions.fetchNextPage,
      actions.fetchPreviousPage
    );
    runtime.result = next;
    runtime.snapshot = next;
    return next;
  }, [actions, runtime]);
  runtime.refresh = makeResult;
  makeResult();
  const subscribe = useCallback(
    (onStoreChange) => {
      if (isRestoring || defaultedOptions.subscribed === false) {
        return () => void 0;
      }
      runtime.listener = onStoreChange;
      let subscribedQuery = query;
      let rebinding = false;
      hub.retain(subscribedQuery, defaultedOptions.gcTime);
      const switchQuery = (nextQuery) => {
        if (nextQuery === subscribedQuery) return;
        hub.release(subscribedQuery);
        subscribedQuery = nextQuery;
        hub.retain(subscribedQuery, defaultedOptions.gcTime);
        runtime.query = subscribedQuery;
        runtime.autoFetchAttempted = false;
        runtime.wasAutoFetchEligible = false;
        resetMemoryForQuery(runtime.memory, subscribedQuery);
      };
      const unsubscribeHash = hub.subscribeHash(query.queryHash, (event) => {
        if (rebinding) return;
        if (event.type === "removed" && event.query === subscribedQuery) {
          rebinding = true;
          try {
            switchQuery(hub.buildQuery(runtime.options));
          } finally {
            rebinding = false;
          }
        } else if (event.query !== subscribedQuery) {
          switchQuery(event.query);
        }
        if (runtime.query !== subscribedQuery) return;
        const previous = runtime.memory.previousResult;
        makeResult();
        const next = runtime.memory.previousResult;
        if (liteResultChanged(
          next,
          previous,
          runtime.options.notifyOnChangeProps,
          runtime.memory.trackedProps,
          runtime.options.throwOnError
        )) {
          runtime.listener?.();
        }
        if (event.type === "updated" && event.action.type === "invalidate" && resolveEnabled(runtime.options.enabled, subscribedQuery) !== false && runtime.options.queryFn !== skipToken) {
          void subscribedQuery.fetch(runtime.options, { cancelRefetch: false }).catch(() => void 0);
        }
      });
      const unregisterEnvironment = hub.registerEnvironment({
        onFocus: () => {
          if (shouldFetchOnEnvironment(
            subscribedQuery,
            runtime.options,
            runtime.options.refetchOnWindowFocus
          )) {
            void subscribedQuery.fetch(runtime.options, { cancelRefetch: false }).catch(() => void 0);
          }
        },
        onOnline: () => {
          if (shouldFetchOnEnvironment(
            subscribedQuery,
            runtime.options,
            runtime.options.refetchOnReconnect
          )) {
            void subscribedQuery.fetch(runtime.options, { cancelRefetch: false }).catch(() => void 0);
          }
        }
      });
      return () => {
        unsubscribeHash();
        unregisterEnvironment();
        hub.release(subscribedQuery);
        if (runtime.listener === onStoreChange) {
          runtime.listener = void 0;
        }
      };
    },
    [
      defaultedOptions.gcTime,
      defaultedOptions.subscribed,
      hub,
      isRestoring,
      makeResult,
      query
    ]
  );
  const getSnapshot = useCallback(
    () => runtime.snapshot ?? makeResult(),
    [makeResult, runtime]
  );
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    if (defaultedOptions.experimental_prefetchInRender) {
      warnUnsupportedOption("experimental_prefetchInRender");
    }
    const eligible = defaultedOptions.subscribed !== false && !isRestoring && resolveEnabled(defaultedOptions.enabled, query) !== false && defaultedOptions.queryFn !== skipToken;
    if (eligible && !runtime.wasAutoFetchEligible) {
      runtime.autoFetchAttempted = false;
    }
    runtime.wasAutoFetchEligible = eligible;
    if (!eligible) {
      return;
    }
    if (!runtime.autoFetchAttempted && shouldFetchOnMount(query, defaultedOptions)) {
      runtime.autoFetchAttempted = true;
      void query.fetch(defaultedOptions).catch(() => void 0);
    }
  }, [
    defaultedOptions.enabled,
    defaultedOptions.subscribed,
    isRestoring,
    query,
    runtime
  ]);
  useEffect(() => {
    if (isRestoring || defaultedOptions.subscribed === false) return;
    const staleTime = resolveStaleTime3(defaultedOptions.staleTime, query);
    if (staleTime === "static" || staleTime === void 0 || staleTime === Infinity || query.state.data === void 0) {
      hub.cancelStale(staleTimerKey.current);
    } else {
      hub.scheduleStale(
        staleTimerKey.current,
        query.state.dataUpdatedAt + staleTime + 1,
        () => {
          if (runtime.query !== query) return;
          const previous = runtime.memory.previousResult;
          makeResult();
          const next = runtime.memory.previousResult;
          if (liteResultChanged(
            next,
            previous,
            runtime.options.notifyOnChangeProps,
            runtime.memory.trackedProps,
            runtime.options.throwOnError
          )) {
            runtime.listener?.();
          }
        }
      );
    }
    return () => hub.cancelStale(staleTimerKey.current);
  }, [
    defaultedOptions.staleTime,
    defaultedOptions.subscribed,
    hub,
    isRestoring,
    makeResult,
    query,
    runtime.memory.previousResult?.dataUpdatedAt
  ]);
  useEffect(() => {
    if (isRestoring || defaultedOptions.subscribed === false) return;
    const interval = typeof defaultedOptions.refetchInterval === "function" ? defaultedOptions.refetchInterval(query) : defaultedOptions.refetchInterval;
    if (typeof interval !== "number" || interval <= 0 || interval === Infinity) {
      hub.cancelInterval(intervalTimerKey.current);
      return () => hub.cancelInterval(intervalTimerKey.current);
    }
    hub.scheduleInterval(intervalTimerKey.current, {
      interval,
      inBackground: () => defaultedOptions.refetchIntervalInBackground === true || focusManager.isFocused(),
      callback: () => {
        if (runtime.isRestoring) return;
        const currentQuery = runtime.query;
        if (resolveEnabled(runtime.options.enabled, currentQuery) === false) return;
        void currentQuery.fetch(runtime.options).catch(() => void 0);
      }
    });
    return () => hub.cancelInterval(intervalTimerKey.current);
  }, [
    defaultedOptions.enabled,
    defaultedOptions.refetchInterval,
    defaultedOptions.refetchIntervalInBackground,
    defaultedOptions.subscribed,
    hub,
    isRestoring,
    query
  ]);
  return runtime;
}
function useInfiniteQueryLite(options, queryClient) {
  "use no memo";
  const runtime = useInfiniteRuntime(options, queryClient);
  const result = runtime.result;
  const rawResult = runtime.memory.previousResult ?? result;
  if (shouldLiteThrowError(rawResult, runtime.options, runtime.query)) {
    throw rawResult.error;
  }
  return result;
}
function useSuspenseInfiniteQueryLite(options, queryClient) {
  "use no memo";
  if (options.queryFn === skipToken) {
    throw new Error("skipToken is not allowed for useSuspenseInfiniteQuery");
  }
  const runtime = useInfiniteRuntime(
    suspenseOptions(options),
    queryClient
  );
  const result = runtime.result;
  const rawResult = runtime.memory.previousResult ?? result;
  if ((runtime.isRestoring || runtime.options.subscribed === false) && rawResult.data === void 0) {
    throw pausedSuspensePromise2;
  }
  if (rawResult.status === "pending") {
    const promise = runtime.query.promise ?? runtime.query.fetch(runtime.options);
    throw promise;
  }
  if (rawResult.status === "error" && rawResult.data === void 0) {
    throw rawResult.error;
  }
  return result;
}

// src/index.ts
var useQueryLite2 = useQueryLite;
var useQueriesLite2 = useQueriesLite;
var useSuspenseQueryLite2 = useSuspenseQueryLite;
var useSuspenseQueriesLite2 = useSuspenseQueriesLite;
var useInfiniteQueryLite2 = useInfiniteQueryLite;
var useSuspenseInfiniteQueryLite2 = useSuspenseInfiniteQueryLite;

export { useInfiniteQueryLite2 as useInfiniteQuery, useInfiniteQueryLite2 as useInfiniteQueryLite, useQueriesLite2 as useQueries, useQueriesLite2 as useQueriesLite, useQueryLite2 as useQuery, useQueryLite2 as useQueryLite, useSuspenseInfiniteQueryLite2 as useSuspenseInfiniteQuery, useSuspenseInfiniteQueryLite2 as useSuspenseInfiniteQueryLite, useSuspenseQueriesLite2 as useSuspenseQueries, useSuspenseQueriesLite2 as useSuspenseQueriesLite, useSuspenseQueryLite2 as useSuspenseQuery, useSuspenseQueryLite2 as useSuspenseQueryLite };
//# sourceMappingURL=index.mjs.map
//# sourceMappingURL=index.mjs.map