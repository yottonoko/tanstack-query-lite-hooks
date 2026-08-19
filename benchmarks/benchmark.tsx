import React, {
  type ComponentType,
  type PropsWithChildren,
  useEffect,
  useLayoutEffect,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  QueryClient,
  QueryClientProvider,
  useQueries as useNativeQueries,
  useQuery as useNativeQuery,
} from "@tanstack/react-query";
import {
  useQueriesLite,
  useQueryLite,
} from "../src/index";
import useSWR, {
  SWRConfig,
  useSWRConfig,
  type Cache,
} from "swr";

const HOOK_COUNT = 1_000;
const WARMUP_RUNS = 10;
const MEASURED_RUNS = 30;
const LARGE_QUERY_COUNTS = [10_000, 20_000] as const;
const LARGE_WARMUP_RUNS = 2;
const LARGE_MEASURED_RUNS = 5;
const CORE_PHASES = ["mount", "resolve", "singleUpdate", "allUpdate"] as const;
const ABSOLUTE_NOISE_TOLERANCE_MS = 0.25;
const MAX_SWR_RATIO = 1.1;
const MAX_DISTINCT_RESOLVE_TANSTACK_RATIO = 0.8;

type LibraryName = "lite" | "native" | "swr";
type KeyMode = "shared" | "distinct";
type CorePhase = (typeof CORE_PHASES)[number];
type TimedPhase =
  | CorePhase
  | "parentRerender"
  | "unmount";
type Provider = ComponentType<PropsWithChildren>;

const LIBRARIES: readonly LibraryName[] = ["lite", "native", "swr"];
const LARGE_LIBRARIES = ["lite", "native"] as const;
const KEY_MODES: readonly KeyMode[] = ["shared", "distinct"];

interface TrialTimings {
  mount: number;
  resolve: number;
  singleUpdate: number;
  allUpdate: number;
  parentRerender: number;
  unmount: number;
  fetches: number;
  expectedFetches: number;
  dedupePassed: boolean;
}

interface ResultRow extends TrialTimings {
  library: LibraryName;
  mode: KeyMode;
}

interface Comparison {
  mode: KeyMode;
  phase: CorePhase;
  liteMs: number;
  nativeMs: number;
  swrMs: number;
  swrLimitMs: number;
  nativeLimitMs: number | null;
  passed: boolean;
}

interface LargeUseQueriesTimings {
  mount: number;
  singleUpdate: number;
  unmount: number;
}

interface LargeUseQueriesResult extends LargeUseQueriesTimings {
  library: (typeof LARGE_LIBRARIES)[number];
  queryCount: (typeof LARGE_QUERY_COUNTS)[number];
}

interface LargeUseQueriesComparison {
  phase: "mount" | "singleUpdate";
  lite20kMs: number;
  native20kMs: number;
  lite10kMs: number;
  liteScaling: number;
  beatsNative: boolean;
  scalesWithin3x: boolean;
  passed: boolean;
}

interface LargeUseQueriesReport {
  config: {
    queryCounts: readonly number[];
    warmupRuns: number;
    measuredRuns: number;
    preseeded: true;
  };
  results: LargeUseQueriesResult[];
  comparisons: LargeUseQueriesComparison[];
  passed: boolean;
}

export interface BenchmarkReport {
  environment: {
    userAgent: string;
    crossOriginIsolated: boolean;
  };
  config: {
    hookCount: number;
    warmupRuns: number;
    measuredRuns: number;
    order: string;
    acceptance: {
      absoluteNoiseToleranceMs: number;
      maxSwrRatio: number;
      maxDistinctResolveTanStackRatio: number;
      fetchDedupe: true;
    };
  };
  results: ResultRow[];
  comparisons: Comparison[];
  fetchDedupePassed: boolean;
  largeUseQueries: LargeUseQueriesReport;
  passed: boolean;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class ControlledFetcher {
  readonly #requests: Deferred<number>[];
  #invocations = 0;
  readonly #invocationsByIndex = new Map<number, number>();

  constructor(mode: KeyMode) {
    const count = mode === "shared" ? 1 : HOOK_COUNT;
    this.#requests = Array.from({ length: count }, () => deferred<number>());
  }

  fetch(index: number, signal?: AbortSignal): Promise<number> {
    const request = this.#requests[index];
    if (!request) {
      throw new Error(`Missing controlled request for index ${index}`);
    }
    this.#invocations += 1;
    this.#invocationsByIndex.set(
      index,
      (this.#invocationsByIndex.get(index) ?? 0) + 1,
    );
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }
    if (!signal) {
      return request.promise;
    }

    return new Promise<number>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      const resolveRequest = (value: number) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      };
      const rejectRequest = (reason: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      request.promise.then(resolveRequest, rejectRequest);
    });
  }

  resolveAll(): void {
    for (const request of this.#requests) {
      request.resolve(1);
    }
  }

  get invocations(): number {
    return this.#invocations;
  }

  hasOneInvocationPerKey(expected: number): boolean {
    return (
      this.#invocations === expected &&
      this.#invocationsByIndex.size === expected &&
      [...this.#invocationsByIndex.values()].every((count) => count === 1)
    );
  }
}

interface ValueBarrier {
  report(index: number, value: number | undefined): void;
  promise: Promise<void>;
}

interface ValueBarrierRegistry {
  current: ValueBarrier | undefined;
}

function valueBarrier(expectedValue: number, expectedCount: number): ValueBarrier {
  const done = deferred<void>();
  const seen = new Set<number>();
  let settled = false;
  return {
    promise: done.promise,
    report(index, value) {
      if (settled || value !== expectedValue || seen.has(index)) return;
      seen.add(index);
      if (seen.size === expectedCount) {
        settled = true;
        done.resolve();
      }
    },
  };
}

interface Runtime {
  Provider: Provider;
  Controller?: ComponentType;
  useValue(index: number): number | undefined;
  updateSingle(): void | Promise<void>;
  updateAll(): void | Promise<void>;
  dispose(): void;
}

function createNativeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Number.POSITIVE_INFINITY,
        gcTime: Number.POSITIVE_INFINITY,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
    },
  });
}

function keyIndex(mode: KeyMode, index: number): number {
  return mode === "shared" ? 0 : index;
}

function queryKey(runId: string, index: number): readonly [string, string, number] {
  return ["benchmark", runId, index] as const;
}

function createLiteRuntime(
  mode: KeyMode,
  runId: string,
  source: ControlledFetcher,
): Runtime {
  const client = createNativeClient();
  const Provider: Provider = ({ children }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return {
    Provider,
    useValue(index) {
      const currentIndex = keyIndex(mode, index);
      return useQueryLite({
        queryKey: queryKey(runId, currentIndex),
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          source.fetch(currentIndex, signal),
      }).data as number | undefined;
    },
    updateSingle: () => {
      client.setQueryData(queryKey(runId, 0), 2);
    },
    updateAll: () => {
      const count = mode === "shared" ? 1 : HOOK_COUNT;
      for (let index = 0; index < count; index += 1) {
        client.setQueryData(queryKey(runId, index), 3);
      }
    },
    dispose: () => client.clear(),
  };
}

function createNativeRuntime(
  mode: KeyMode,
  runId: string,
  source: ControlledFetcher,
): Runtime {
  const client = createNativeClient();
  const Provider: Provider = ({ children }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return {
    Provider,
    useValue(index) {
      const currentIndex = keyIndex(mode, index);
      return useNativeQuery({
        queryKey: queryKey(runId, currentIndex),
        queryFn: ({ signal }) => source.fetch(currentIndex, signal),
      }).data as number | undefined;
    },
    updateSingle: () => {
      client.setQueryData(queryKey(runId, 0), 2);
    },
    updateAll: () => {
      client.setQueriesData(
        { queryKey: ["benchmark", runId], exact: false },
        3,
      );
    },
    dispose: () => client.clear(),
  };
}

function createSWRRuntime(
  mode: KeyMode,
  runId: string,
  source: ControlledFetcher,
): Runtime {
  const cacheStore = new Map();
  const cache = cacheStore as Cache;
  let boundMutate:
    | ((
        matcher: string | ((key?: unknown) => boolean),
        data: number,
        options: { revalidate: boolean },
      ) => Promise<unknown>)
    | undefined;
  const Provider: Provider = ({ children }) => (
    <SWRConfig
      value={{
        provider: () => cache,
        dedupingInterval: 0,
        revalidateOnFocus: false,
        revalidateOnReconnect: false,
        shouldRetryOnError: false,
      }}
    >
      {children}
    </SWRConfig>
  );
  const Controller = () => {
    const { mutate } = useSWRConfig();
    useLayoutEffect(() => {
      boundMutate = mutate as typeof boundMutate;
    }, [mutate]);
    return null;
  };
  const swrKey = (index: number) => `benchmark:${runId}:${index}`;
  const requireMutate = () => {
    if (!boundMutate) throw new Error("SWR controller was not mounted");
    return boundMutate;
  };
  return {
    Provider,
    Controller,
    useValue(index) {
      const currentIndex = keyIndex(mode, index);
      return useSWR(
        swrKey(currentIndex),
        () => source.fetch(currentIndex),
        {
          dedupingInterval: 0,
          revalidateOnFocus: false,
          revalidateOnReconnect: false,
          shouldRetryOnError: false,
        },
      ).data as number | undefined;
    },
    async updateSingle() {
      await requireMutate()(swrKey(0), 2, { revalidate: false });
    },
    async updateAll() {
      await requireMutate()(
        (key) =>
          typeof key === "string" && key.startsWith(`benchmark:${runId}:`),
        3,
        { revalidate: false },
      );
    },
    dispose: () => cacheStore.clear(),
  };
}

function createRuntime(
  library: LibraryName,
  mode: KeyMode,
  runId: string,
  source: ControlledFetcher,
): Runtime {
  switch (library) {
    case "lite":
      return createLiteRuntime(mode, runId, source);
    case "native":
      return createNativeRuntime(mode, runId, source);
    case "swr":
      return createSWRRuntime(mode, runId, source);
  }
}

interface LeafProps {
  index: number;
  runtime: Runtime;
  barriers: ValueBarrierRegistry;
}

function Leaf({ index, runtime, barriers }: LeafProps) {
  const value = runtime.useValue(index);
  useLayoutEffect(() => {
    barriers.current?.report(index, value);
  }, [barriers, index, value]);
  return <span data-value={value}>{value}</span>;
}

function BenchmarkTree({
  runtime,
  barriers,
  commit,
  parentRevision,
}: {
  runtime: Runtime;
  barriers: ValueBarrierRegistry;
  commit: Deferred<void>;
  parentRevision: number;
}) {
  const { Provider, Controller } = runtime;
  useLayoutEffect(() => {
    commit.resolve();
  }, [commit, parentRevision]);
  return (
    <Provider>
      {Controller ? <Controller /> : null}
      {Array.from({ length: HOOK_COUNT }, (_, index) => (
        <Leaf key={index} index={index} runtime={runtime} barriers={barriers} />
      ))}
    </Provider>
  );
}

async function renderTree(
  root: Root,
  runtime: Runtime,
  barriers: ValueBarrierRegistry,
  revision: number,
): Promise<void> {
  const commit = deferred<void>();
  root.render(
    <BenchmarkTree
      runtime={runtime}
      barriers={barriers}
      commit={commit}
      parentRevision={revision}
    />,
  );
  await commit.promise;
}

async function measure(action: () => void | Promise<void>): Promise<number> {
  const startedAt = performance.now();
  await action();
  return performance.now() - startedAt;
}

async function runTrial(
  library: LibraryName,
  mode: KeyMode,
  runNumber: number,
): Promise<TrialTimings> {
  const runId = `${library}-${mode}-${runNumber}`;
  const source = new ControlledFetcher(mode);
  const runtime = createRuntime(library, mode, runId, source);
  const barriers: ValueBarrierRegistry = { current: undefined };
  const host = document.createElement("div");
  host.style.cssText =
    "position:fixed;left:-100000px;top:0;width:1000px;contain:strict";
  document.body.append(host);
  const root = createRoot(host);
  let didUnmount = false;
  try {
    const mount = await measure(() => renderTree(root, runtime, barriers, 0));
    const resolved = valueBarrier(1, HOOK_COUNT);
    barriers.current = resolved;
    const resolve = await measure(async () => {
      source.resolveAll();
      await resolved.promise;
    });

    const singleCount = mode === "shared" ? HOOK_COUNT : 1;
    const single = valueBarrier(2, singleCount);
    barriers.current = single;
    const singleUpdate = await measure(async () => {
      await runtime.updateSingle();
      await single.promise;
    });

    const all = valueBarrier(3, HOOK_COUNT);
    barriers.current = all;
    const allUpdate = await measure(async () => {
      await runtime.updateAll();
      await all.promise;
    });

    barriers.current = undefined;
    const parentRerender = await measure(() =>
      renderTree(root, runtime, barriers, 1),
    );
    const unmount = await measure(() => root.unmount());
    didUnmount = true;
    const expectedFetches = mode === "shared" ? 1 : HOOK_COUNT;
    return {
      mount,
      resolve,
      singleUpdate,
      allUpdate,
      parentRerender,
      unmount,
      fetches: source.invocations,
      expectedFetches,
      dedupePassed: source.hasOneInvocationPerKey(expectedFetches),
    };
  } finally {
    if (!didUnmount) root.unmount();
    runtime.dispose();
    host.remove();
  }
}

interface LargeUseQueriesRuntime {
  Provider: Provider;
  useResults(): readonly { data: unknown }[];
  updateSingle(): void;
  dispose(): void;
}

function createLargeUseQueriesRuntime(
  library: (typeof LARGE_LIBRARIES)[number],
  queryCount: (typeof LARGE_QUERY_COUNTS)[number],
  runId: string,
): LargeUseQueriesRuntime {
  const queries = Array.from({ length: queryCount }, (_, index) => ({
    queryKey: queryKey(runId, index),
    queryFn: async () => index,
    retry: false as const,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false as const,
    refetchOnReconnect: false as const,
  }));
  const client = createNativeClient();
  for (let index = 0; index < queryCount; index += 1) {
    client.setQueryData(queryKey(runId, index), index);
  }
  const Provider: Provider = ({ children }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  if (library === "lite") {
    return {
      Provider,
      useResults: () => useQueriesLite({ queries }),
      updateSingle: () => client.setQueryData(queryKey(runId, 0), -1),
      dispose: () => client.clear(),
    };
  }
  return {
    Provider,
    useResults: () => useNativeQueries({ queries }),
    updateSingle: () => client.setQueryData(queryKey(runId, 0), -1),
    dispose: () => client.clear(),
  };
}

function LargeUseQueriesConsumer({
  runtime,
  updateBarrier,
  commit,
  ready,
}: {
  runtime: LargeUseQueriesRuntime;
  updateBarrier: ValueBarrierRegistry;
  commit: Deferred<void>;
  ready: Deferred<void>;
}) {
  const results = runtime.useResults();
  const firstValue = results[0]?.data;
  useLayoutEffect(() => {
    commit.resolve();
  }, [commit]);
  useEffect(() => {
    ready.resolve();
  }, [ready]);
  useLayoutEffect(() => {
    updateBarrier.current?.report(0, firstValue as number | undefined);
  }, [firstValue, updateBarrier]);
  return <span data-value={String(firstValue)}>{String(firstValue)}</span>;
}

async function renderLargeUseQueriesTree(
  root: Root,
  runtime: LargeUseQueriesRuntime,
  updateBarrier: ValueBarrierRegistry,
): Promise<void> {
  const commit = deferred<void>();
  const ready = deferred<void>();
  root.render(
    <runtime.Provider>
      <LargeUseQueriesConsumer
        runtime={runtime}
        updateBarrier={updateBarrier}
        commit={commit}
        ready={ready}
      />
    </runtime.Provider>,
  );
  await Promise.all([commit.promise, ready.promise]);
}

async function runLargeUseQueriesTrial(
  library: (typeof LARGE_LIBRARIES)[number],
  queryCount: (typeof LARGE_QUERY_COUNTS)[number],
  runNumber: number,
): Promise<LargeUseQueriesTimings> {
  const runtime = createLargeUseQueriesRuntime(
    library,
    queryCount,
    `large-use-queries-${library}-${queryCount}-${runNumber}`,
  );
  const updateBarrier: ValueBarrierRegistry = { current: undefined };
  const host = document.createElement("div");
  host.style.cssText =
    "position:fixed;left:-100000px;top:0;width:1000px;contain:strict";
  document.body.append(host);
  const root = createRoot(host);
  let didUnmount = false;
  try {
    const mount = await measure(() =>
      renderLargeUseQueriesTree(root, runtime, updateBarrier),
    );
    const updated = valueBarrier(-1, 1);
    updateBarrier.current = updated;
    const singleUpdate = await measure(async () => {
      runtime.updateSingle();
      await updated.promise;
    });
    const unmount = await measure(() => root.unmount());
    didUnmount = true;
    return { mount, singleUpdate, unmount };
  } finally {
    if (!didUnmount) root.unmount();
    runtime.dispose();
    host.remove();
  }
}

function median(samples: readonly number[]): number {
  if (samples.length === 0) throw new Error("Cannot calculate an empty median");
  const ordered = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1]! + ordered[middle]!) / 2
    : ordered[middle]!;
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function summarize(samples: Map<string, TrialTimings[]>): ResultRow[] {
  const rows: ResultRow[] = [];
  for (const mode of KEY_MODES) {
    for (const library of LIBRARIES) {
      const timings = samples.get(`${mode}:${library}`);
      if (!timings || timings.length !== MEASURED_RUNS) {
        throw new Error(`Incomplete samples for ${mode}:${library}`);
      }
      const medianFor = (phase: TimedPhase) =>
        round(median(timings.map((timing) => timing[phase])));
      const expectedFetches = mode === "shared" ? 1 : HOOK_COUNT;
      rows.push({
        library,
        mode,
        mount: medianFor("mount"),
        resolve: medianFor("resolve"),
        singleUpdate: medianFor("singleUpdate"),
        allUpdate: medianFor("allUpdate"),
        parentRerender: medianFor("parentRerender"),
        unmount: medianFor("unmount"),
        fetches: round(median(timings.map((timing) => timing.fetches))),
        expectedFetches,
        dedupePassed: timings.every((timing) => timing.dedupePassed),
      });
    }
  }
  return rows;
}

function compare(rows: readonly ResultRow[]): Comparison[] {
  const comparisons: Comparison[] = [];
  for (const mode of KEY_MODES) {
    const lite = rows.find((row) => row.mode === mode && row.library === "lite");
    const native = rows.find(
      (row) => row.mode === mode && row.library === "native",
    );
    const swr = rows.find((row) => row.mode === mode && row.library === "swr");
    if (!lite || !native || !swr) throw new Error(`Missing comparison rows for ${mode}`);
    for (const phase of CORE_PHASES) {
      const nativeLimitMs =
        mode === "distinct" && phase === "resolve"
          ? native[phase] * MAX_DISTINCT_RESOLVE_TANSTACK_RATIO
          : null;
      const swrLimitMs = Math.max(
        swr[phase] + ABSOLUTE_NOISE_TOLERANCE_MS,
        swr[phase] * MAX_SWR_RATIO,
      );
      comparisons.push({
        mode,
        phase,
        liteMs: lite[phase],
        nativeMs: native[phase],
        swrMs: swr[phase],
        swrLimitMs: round(swrLimitMs),
        nativeLimitMs: nativeLimitMs === null ? null : round(nativeLimitMs),
        passed:
          lite[phase] <= swrLimitMs &&
          (nativeLimitMs === null || lite[phase] <= nativeLimitMs),
      });
    }
  }
  return comparisons;
}

async function runLargeUseQueriesBenchmarks(
  onProgress: (message: string) => void,
): Promise<LargeUseQueriesReport> {
  const samples = new Map<string, LargeUseQueriesTimings[]>();
  const totalRuns = LARGE_WARMUP_RUNS + LARGE_MEASURED_RUNS;
  for (const queryCount of LARGE_QUERY_COUNTS) {
    for (let runIndex = 0; runIndex < totalRuns; runIndex += 1) {
      const order: readonly (typeof LARGE_LIBRARIES)[number][] =
        runIndex % 2 === 0 ? LARGE_LIBRARIES : [...LARGE_LIBRARIES].reverse();
      const stage = runIndex < LARGE_WARMUP_RUNS ? "warmup" : "measure";
      onProgress(
        `large useQueries ${queryCount} ${stage} ${runIndex + 1}/${totalRuns}`,
      );
      for (const library of order) {
        const timing = await runLargeUseQueriesTrial(library, queryCount, runIndex);
        if (runIndex >= LARGE_WARMUP_RUNS) {
          const key = `${queryCount}:${library}`;
          const current = samples.get(key) ?? [];
          current.push(timing);
          samples.set(key, current);
        }
      }
    }
  }

  const results: LargeUseQueriesResult[] = [];
  for (const queryCount of LARGE_QUERY_COUNTS) {
    for (const library of LARGE_LIBRARIES) {
      const timings = samples.get(`${queryCount}:${library}`);
      if (!timings || timings.length !== LARGE_MEASURED_RUNS) {
        throw new Error(`Incomplete large samples for ${queryCount}:${library}`);
      }
      results.push({
        library,
        queryCount,
        mount: round(median(timings.map((timing) => timing.mount))),
        singleUpdate: round(
          median(timings.map((timing) => timing.singleUpdate)),
        ),
        unmount: round(median(timings.map((timing) => timing.unmount))),
      });
    }
  }

  const comparisons = (["mount", "singleUpdate"] as const).map(
    (phase): LargeUseQueriesComparison => {
      const lite10k = results.find(
        (result) => result.library === "lite" && result.queryCount === 10_000,
      );
      const lite20k = results.find(
        (result) => result.library === "lite" && result.queryCount === 20_000,
      );
      const native20k = results.find(
        (result) => result.library === "native" && result.queryCount === 20_000,
      );
      if (!lite10k || !lite20k || !native20k) {
        throw new Error(`Missing large comparison rows for ${phase}`);
      }
      const beatsNative = lite20k[phase] < native20k[phase];
      const liteScaling = round(lite20k[phase] / lite10k[phase]);
      const scalesWithin3x = liteScaling <= 3;
      return {
        phase,
        lite20kMs: lite20k[phase],
        native20kMs: native20k[phase],
        lite10kMs: lite10k[phase],
        liteScaling,
        beatsNative,
        scalesWithin3x,
        passed: beatsNative && scalesWithin3x,
      };
    },
  );
  return {
    config: {
      queryCounts: LARGE_QUERY_COUNTS,
      warmupRuns: LARGE_WARMUP_RUNS,
      measuredRuns: LARGE_MEASURED_RUNS,
      preseeded: true,
    },
    results,
    comparisons,
    passed: comparisons.every((comparison) => comparison.passed),
  };
}

export async function runBenchmarks(
  onProgress: (message: string) => void = () => undefined,
): Promise<BenchmarkReport> {
  const samples = new Map<string, TrialTimings[]>();
  const totalRounds = WARMUP_RUNS + MEASURED_RUNS;
  for (const mode of KEY_MODES) {
    for (let roundIndex = 0; roundIndex < totalRounds; roundIndex += 1) {
      const offset = roundIndex % LIBRARIES.length;
      const order = [
        ...LIBRARIES.slice(offset),
        ...LIBRARIES.slice(0, offset),
      ];
      const stage = roundIndex < WARMUP_RUNS ? "warmup" : "measure";
      onProgress(`${mode} ${stage} ${roundIndex + 1}/${totalRounds}`);
      for (const library of order) {
        const timing = await runTrial(library, mode, roundIndex);
        if (roundIndex >= WARMUP_RUNS) {
          const key = `${mode}:${library}`;
          const current = samples.get(key) ?? [];
          current.push(timing);
          samples.set(key, current);
        }
      }
    }
  }
  const results = summarize(samples);
  const comparisons = compare(results);
  const largeUseQueries = await runLargeUseQueriesBenchmarks(onProgress);
  const fetchDedupePassed = results.every((row) => row.dedupePassed);
  return {
    environment: {
      userAgent: navigator.userAgent,
      crossOriginIsolated: globalThis.crossOriginIsolated,
    },
    config: {
      hookCount: HOOK_COUNT,
      warmupRuns: WARMUP_RUNS,
      measuredRuns: MEASURED_RUNS,
      order: "rotating lite/native/swr per round; reverse lite/native for large runs",
      acceptance: {
        absoluteNoiseToleranceMs: ABSOLUTE_NOISE_TOLERANCE_MS,
        maxSwrRatio: MAX_SWR_RATIO,
        maxDistinctResolveTanStackRatio:
          MAX_DISTINCT_RESOLVE_TANSTACK_RATIO,
        fetchDedupe: true,
      },
    },
    results,
    comparisons,
    fetchDedupePassed,
    largeUseQueries,
    passed:
      fetchDedupePassed &&
      comparisons.every((comparison) => comparison.passed) &&
      largeUseQueries.passed,
  };
}

declare global {
  interface Window {
    runQueryLibraryBenchmarks: typeof runBenchmarks;
  }
}

window.runQueryLibraryBenchmarks = runBenchmarks;

const button = document.querySelector<HTMLButtonElement>("#run");
const output = document.querySelector<HTMLElement>("#output");
if (button && output) {
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const report = await runBenchmarks((message) => {
        output.textContent = message;
      });
      output.textContent = JSON.stringify(report, null, 2);
    } catch (error) {
      output.textContent =
        error instanceof Error ? error.stack ?? error.message : String(error);
    } finally {
      button.disabled = false;
    }
  });
}
