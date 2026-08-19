import React, {
  type ComponentType,
  type PropsWithChildren,
  useEffect,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  QueryClient,
  QueryClientProvider,
  useQueries as useNativeQueries,
} from "@tanstack/react-query";
import { useQueriesLite } from "../src/index";

export type MemoryBenchmarkLibrary = "lite" | "native";
export type MemoryBenchmarkQueryCount = 10_000 | 20_000;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

interface MemoryRuntime {
  Provider: ComponentType<PropsWithChildren>;
  useResults(): readonly { data: unknown }[];
  clear(): void;
}

interface ActiveBenchmark {
  root: Root;
  runtime: MemoryRuntime;
  host: HTMLElement;
}

let activeBenchmark: ActiveBenchmark | undefined;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function queryKey(index: number): readonly [string, number] {
  return ["retained-memory", index] as const;
}

function createRuntime(
  library: MemoryBenchmarkLibrary,
  queryCount: MemoryBenchmarkQueryCount,
): MemoryRuntime {
  const queries = Array.from({ length: queryCount }, (_, index) => ({
    queryKey: queryKey(index),
    queryFn: async () => index,
    retry: false as const,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false as const,
    refetchOnReconnect: false as const,
  }));
  const client = new QueryClient({
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
  for (let index = 0; index < queryCount; index += 1) {
    client.setQueryData(queryKey(index), index);
  }
  const Provider: MemoryRuntime["Provider"] = ({ children }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return {
    Provider,
    useResults: () =>
      library === "lite"
        ? useQueriesLite({ queries })
        : useNativeQueries({ queries }),
    clear: () => client.clear(),
  };
}

function MemoryBenchmarkConsumer({
  runtime,
  ready,
}: {
  runtime: MemoryRuntime;
  ready: Deferred<void>;
}) {
  const results = runtime.useResults();
  useEffect(() => {
    ready.resolve();
  }, [ready]);
  return <span data-first-value={String(results[0]?.data)} />;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export async function mountMemoryBenchmark(
  library: MemoryBenchmarkLibrary,
  queryCount: MemoryBenchmarkQueryCount,
): Promise<void> {
  if (activeBenchmark) {
    throw new Error("A retained-memory benchmark is already mounted");
  }
  if (library !== "lite" && library !== "native") {
    throw new Error(`Unsupported benchmark library: ${String(library)}`);
  }
  if (queryCount !== 10_000 && queryCount !== 20_000) {
    throw new Error(`Unsupported query count: ${String(queryCount)}`);
  }

  const runtime = createRuntime(library, queryCount);
  const host = document.createElement("main");
  host.id = "memory-benchmark-root";
  document.body.append(host);
  const root = createRoot(host);
  const ready = deferred<void>();
  activeBenchmark = { root, runtime, host };
  const { Provider } = runtime;
  root.render(
    <Provider>
      <MemoryBenchmarkConsumer runtime={runtime} ready={ready} />
    </Provider>,
  );
  await ready.promise;
  await nextFrame();
  await nextFrame();
}

export async function teardownMemoryBenchmark(): Promise<void> {
  const current = activeBenchmark;
  if (!current) return;
  activeBenchmark = undefined;
  current.root.unmount();
  current.runtime.clear();
  current.host.remove();
  await nextFrame();
  await nextFrame();
}

declare global {
  interface Window {
    mountMemoryBenchmark: typeof mountMemoryBenchmark;
    teardownMemoryBenchmark: typeof teardownMemoryBenchmark;
  }
}

window.mountMemoryBenchmark = mountMemoryBenchmark;
window.teardownMemoryBenchmark = teardownMemoryBenchmark;
