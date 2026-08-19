import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  focusManager,
  onlineManager,
  QueryCache,
  QueryClient,
  QueryClientProvider,
  skipToken,
  type UseQueryOptions,
  useQuery as useNativeQuery,
} from "@tanstack/react-query";
import {
  StrictMode,
  Suspense,
  startTransition,
  type PropsWithChildren,
  useState,
} from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useInfiniteQueryLite,
  useQueriesLite,
  useQueryLite,
  useSuspenseQueriesLite,
  useSuspenseQueryLite,
} from "../src/index.js";
import { getLiteHub } from "../src/hub.js";

const clients = new Set<QueryClient>();

function createClient() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  clients.add(client);
  return client;
}

function provider(client: QueryClient) {
  return function Provider({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function lifecycleErrors(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls
    .flat()
    .map(String)
    .filter((message: string) =>
      /Maximum update depth|cached snapshot|infinite loop/i.test(message),
    );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  cleanup();
  for (const client of clients) {
    client.clear();
    client.unmount();
  }
  clients.clear();
  focusManager.setFocused(true);
  onlineManager.setOnline(true);
  vi.useRealTimers();
});

describe("render stability under unstable option identities", () => {
  it("does not refetch an ordinary query when inline queryFn changes on rapid parent renders", async () => {
    const client = createClient();
    const execute = vi.fn((value: number) => value);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const hook = renderHook(
      ({ value }) =>
        useQueryLite({
          queryKey: ["rapid-inline-query-fn"],
          queryFn: () => execute(value),
        }),
      { wrapper: provider(client), initialProps: { value: 0 } },
    );

    await waitFor(() => expect(hook.result.current.data).toBe(0));
    for (let value = 1; value <= 250; value += 1) {
      hook.rerender({ value });
    }

    expect(execute).toHaveBeenCalledTimes(1);
    expect(hook.result.current.data).toBe(0);
    expect(lifecycleErrors(consoleError)).toEqual([]);

    await act(async () => {
      await client.invalidateQueries({ queryKey: ["rapid-inline-query-fn"] });
    });
    await waitFor(() => expect(hook.result.current.data).toBe(250));
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("settles a render-dependent synchronous queryFn instead of feeding cache renders back into fetch", async () => {
    const client = createClient();
    const execute = vi.fn((value: number) => value);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let renders = 0;

    function View() {
      renders += 1;
      const result = useQueryLite({
        queryKey: ["render-dependent-query-fn"],
        queryFn: () => execute(renders),
      });
      return <span data-testid="render-dependent-value">{result.data}</span>;
    }

    render(
      <QueryClientProvider client={client}>
        <StrictMode>
          <View />
        </StrictMode>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("render-dependent-value").textContent).not.toBe("");
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(renders).toBeLessThan(12);
    expect(lifecycleErrors(consoleError)).toEqual([]);
  });

  it("matches native fetch stability for inline queryFn across repeated rerenders", async () => {
    const liteClient = createClient();
    const nativeClient = createClient();
    const liteExecute = vi.fn((value: number) => value);
    const nativeExecute = vi.fn((value: number) => value);
    const lite = renderHook(
      ({ value }) =>
        useQueryLite({
          queryKey: ["inline-parity"],
          queryFn: () => liteExecute(value),
        }),
      { wrapper: provider(liteClient), initialProps: { value: 0 } },
    );
    const native = renderHook(
      ({ value }) =>
        useNativeQuery({
          queryKey: ["inline-parity"],
          queryFn: () => nativeExecute(value),
        }),
      { wrapper: provider(nativeClient), initialProps: { value: 0 } },
    );

    await waitFor(() => {
      expect(lite.result.current.data).toBe(0);
      expect(native.result.current.data).toBe(0);
    });
    for (let value = 1; value <= 100; value += 1) {
      lite.rerender({ value });
      native.rerender({ value });
    }
    expect(liteExecute).toHaveBeenCalledTimes(nativeExecute.mock.calls.length);
    expect(liteExecute).toHaveBeenCalledTimes(1);
  });

  it("does not retry an inline throwing queryFn on unrelated parent renders", async () => {
    const client = createClient();
    const execute = vi.fn((value: number) => {
      throw new Error(`failure-${value}`);
    });
    const hook = renderHook(
      ({ value }) =>
        useQueryLite({
          queryKey: ["inline-error-stability"],
          queryFn: () => execute(value),
        }),
      { wrapper: provider(client), initialProps: { value: 0 } },
    );

    await waitFor(() => expect(hook.result.current.isError).toBe(true));
    for (let value = 1; value <= 100; value += 1) {
      hook.rerender({ value });
    }
    expect(execute).toHaveBeenCalledTimes(1);
    expect(hook.result.current.error?.message).toBe("failure-0");
  });

  it("keeps inline useQueries inputs fetch-stable and uses the newest callbacks after invalidation", async () => {
    const client = createClient();
    const first = vi.fn((value: number) => value);
    const second = vi.fn((value: number) => `v${value}`);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const hook = renderHook(
      ({ value }) =>
        useQueriesLite({
          queries: [
            {
              queryKey: ["rapid-list", 0],
              queryFn: () => first(value),
            },
            {
              queryKey: ["rapid-list", 1],
              queryFn: () => second(value),
            },
          ],
        }),
      { wrapper: provider(client), initialProps: { value: 0 } },
    );

    await waitFor(() => {
      expect(hook.result.current[0].data).toBe(0);
      expect(hook.result.current[1].data).toBe("v0");
    });
    for (let value = 1; value <= 150; value += 1) {
      hook.rerender({ value });
    }
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(lifecycleErrors(consoleError)).toEqual([]);

    await act(async () => {
      await client.invalidateQueries({ queryKey: ["rapid-list"] });
    });
    await waitFor(() => {
      expect(hook.result.current[0].data).toBe(150);
      expect(hook.result.current[1].data).toBe("v150");
    });
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("keeps inline Infinite Query callbacks fetch-stable across rapid rerenders", async () => {
    const client = createClient();
    const execute = vi.fn((value: number, page: number) => value + page);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const hook = renderHook(
      ({ value }) =>
        useInfiniteQueryLite({
          queryKey: ["rapid-infinite"],
          queryFn: ({ pageParam }) => execute(value, pageParam),
          initialPageParam: 0,
          getNextPageParam: () => undefined,
        }),
      { wrapper: provider(client), initialProps: { value: 0 } },
    );

    await waitFor(() => expect(hook.result.current.data?.pages).toEqual([0]));
    for (let value = 1; value <= 150; value += 1) {
      hook.rerender({ value });
    }
    expect(execute).toHaveBeenCalledTimes(1);
    expect(lifecycleErrors(consoleError)).toEqual([]);

    await act(async () => {
      await client.invalidateQueries({ queryKey: ["rapid-infinite"] });
    });
    await waitFor(() => expect(hook.result.current.data?.pages).toEqual([150]));
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("does not refetch a resolved Suspense query for inline queryFn changes", async () => {
    const client = createClient();
    const execute = vi.fn((value: number) => value);

    function View({ value }: { value: number }) {
      const result = useSuspenseQueryLite({
        queryKey: ["rapid-suspense"],
        queryFn: () => execute(value),
        staleTime: Infinity,
      });
      return <span data-testid="rapid-suspense">{result.data}</span>;
    }

    const view = render(
      <QueryClientProvider client={client}>
        <Suspense fallback={<span>loading</span>}>
          <View value={0} />
        </Suspense>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("rapid-suspense").textContent).toBe("0"));
    for (let value = 1; value <= 100; value += 1) {
      view.rerender(
        <QueryClientProvider client={client}>
          <Suspense fallback={<span>loading</span>}>
            <View value={value} />
          </Suspense>
        </QueryClientProvider>,
      );
    }
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("keeps inline Suspense query lists stable and commits their latest callbacks", async () => {
    const client = createClient();
    const queryKey = ["rapid-suspense-list"] as const;
    client.setQueryData(queryKey, 0);
    const execute = vi.fn((value: number) => value);
    const hook = renderHook(
      ({ value }) =>
        useSuspenseQueriesLite({
          queries: [
            {
              queryKey,
              queryFn: () => execute(value),
              staleTime: Infinity,
            },
          ],
        }),
      { wrapper: provider(client), initialProps: { value: 0 } },
    );
    expect(hook.result.current[0].data).toBe(0);
    for (let value = 1; value <= 100; value += 1) {
      hook.rerender({ value });
    }
    expect(execute).not.toHaveBeenCalled();

    await act(async () => {
      await client.invalidateQueries({ queryKey });
    });
    await waitFor(() => expect(hook.result.current[0].data).toBe(100));
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not postpone Infinite Query polling when inline interval callbacks change", async () => {
    vi.useFakeTimers();
    const client = createClient();
    const execute = vi.fn((page: number) => page);
    const intervalFor = vi.fn((_revision: number) => 20);
    const hook = renderHook(
      ({ revision }) =>
        useInfiniteQueryLite({
          queryKey: ["infinite-inline-polling"],
          queryFn: ({ pageParam }) => execute(pageParam),
          initialPageParam: 0,
          getNextPageParam: () => undefined,
          refetchInterval: () => intervalFor(revision),
        }),
      { wrapper: provider(client), initialProps: { revision: 0 } },
    );

    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(execute).toHaveBeenCalledTimes(1);
    for (let revision = 1; revision <= 8; revision += 1) {
      hook.rerender({ revision });
      await act(async () => vi.advanceTimersByTimeAsync(5));
    }
    expect(execute.mock.calls.length).toBeGreaterThan(1);
  });

  it("does not postpone useQueries polling when an inline queries array is recreated", async () => {
    vi.useFakeTimers();
    const client = createClient();
    const execute = vi.fn(() => execute.mock.calls.length);
    const intervalFor = vi.fn((_revision: number) => 20);
    const hook = renderHook(
      ({ revision }) =>
        useQueriesLite({
          queries: [
            {
              queryKey: ["queries-inline-polling"],
              queryFn: () => execute(),
              refetchInterval: intervalFor(revision),
            },
          ],
        }),
      { wrapper: provider(client), initialProps: { revision: 0 } },
    );

    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(execute).toHaveBeenCalledTimes(1);
    for (let revision = 1; revision <= 8; revision += 1) {
      hook.rerender({ revision });
      await act(async () => vi.advanceTimersByTimeAsync(5));
    }
    expect(execute.mock.calls.length).toBeGreaterThan(1);
  });

  it("does not reinterpret an unrelated rerender as refetchOnMount after data becomes stale", async () => {
    vi.useFakeTimers();
    const client = createClient();
    const queryKey = ["stale-parent-rerender"] as const;
    client.setQueryData(queryKey, "seed");
    const execute = vi.fn((value: number) => `network-${value}`);
    const hook = renderHook(
      ({ value }) =>
        useQueryLite({
          queryKey,
          queryFn: () => execute(value),
          staleTime: 20,
        }),
      { wrapper: provider(client), initialProps: { value: 0 } },
    );
    expect(hook.result.current.data).toBe("seed");
    expect(execute).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTimeAsync(25));
    hook.rerender({ value: 1 });
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(execute).not.toHaveBeenCalled();
    expect(hook.result.current.data).toBe("seed");
  });

  it("does not let inline enabled callbacks turn Infinite parent renders into remount fetches", async () => {
    vi.useFakeTimers();
    const client = createClient();
    const queryKey = ["infinite-stale-parent-rerender"] as const;
    client.setQueryData(queryKey, { pages: ["seed"], pageParams: [0] });
    const execute = vi.fn((value: number) => `network-${value}`);
    const hook = renderHook(
      ({ value }) =>
        useInfiniteQueryLite({
          queryKey,
          queryFn: () => execute(value),
          initialPageParam: 0,
          getNextPageParam: () => undefined,
          staleTime: 20,
          enabled: () => true,
        }),
      { wrapper: provider(client), initialProps: { value: 0 } },
    );
    expect(hook.result.current.data?.pages).toEqual(["seed"]);
    expect(execute).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTimeAsync(25));
    hook.rerender({ value: 1 });
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not start a new Suspense fetch merely because fresh data became stale before a rerender", async () => {
    vi.useFakeTimers();
    const client = createClient();
    const queryKey = ["suspense-stale-parent-rerender"] as const;
    client.setQueryData(queryKey, "seed");
    const execute = vi.fn((value: number) => `network-${value}`);

    function View({ value }: { value: number }) {
      const result = useSuspenseQueryLite({
        queryKey,
        queryFn: () => execute(value),
        staleTime: 20,
      });
      return <span data-testid="suspense-stale-parent">{result.data}</span>;
    }

    const view = render(
      <QueryClientProvider client={client}>
        <Suspense fallback={<span>loading</span>}>
          <View value={0} />
        </Suspense>
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("suspense-stale-parent").textContent).toBe("seed");
    expect(execute).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTimeAsync(1_001));
    view.rerender(
      <QueryClientProvider client={client}>
        <Suspense fallback={<span>loading</span>}>
          <View value={1} />
        </Suspense>
      </QueryClientProvider>,
    );
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(execute).not.toHaveBeenCalled();
    expect(screen.getByTestId("suspense-stale-parent").textContent).toBe("seed");
  });

  it("deduplicates invalidation refetches when native and Lite hooks share one query", async () => {
    const client = createClient();
    const queryKey = ["native-lite-invalidation"] as const;
    const execute = vi.fn(async () => execute.mock.calls.length);
    const native = renderHook(
      () => useNativeQuery({ queryKey, queryFn: execute }),
      { wrapper: provider(client) },
    );
    const lite = renderHook(
      () => useQueryLite({ queryKey, queryFn: execute }),
      { wrapper: provider(client) },
    );
    await waitFor(() => {
      expect(native.result.current.data).toBe(1);
      expect(lite.result.current.data).toBe(1);
    });

    await act(async () => {
      await client.invalidateQueries({ queryKey });
    });
    await waitFor(() => expect(execute.mock.calls.length).toBeGreaterThan(1));
    expect(lite.result.current.data).toBe(2);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("deduplicates refetchType all against the native QueryClient refetch pass", async () => {
    const client = createClient();
    const queryKey = ["lite-invalidation-all"] as const;
    const execute = vi.fn(async () => execute.mock.calls.length);
    const hook = renderHook(
      () => useQueryLite({ queryKey, queryFn: execute }),
      { wrapper: provider(client) },
    );
    await waitFor(() => expect(hook.result.current.data).toBe(1));

    await act(async () => {
      await client.invalidateQueries({ queryKey, refetchType: "all" });
    });
    await waitFor(() => expect(hook.result.current.data).toBe(2));
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("deduplicates Infinite refetchType all against the native QueryClient refetch pass", async () => {
    const client = createClient();
    const queryKey = ["infinite-invalidation-all"] as const;
    const execute = vi.fn(() => execute.mock.calls.length);
    const hook = renderHook(
      () =>
        useInfiniteQueryLite({
          queryKey,
          queryFn: () => execute(),
          initialPageParam: 0,
          getNextPageParam: () => undefined,
        }),
      { wrapper: provider(client) },
    );
    await waitFor(() => expect(hook.result.current.data?.pages).toEqual([1]));

    await act(async () => {
      await client.invalidateQueries({ queryKey, refetchType: "all" });
    });
    await waitFor(() => expect(hook.result.current.data?.pages).toEqual([2]));
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("does not refetch ordinary or Infinite Lite queries for refetchType none", async () => {
    const client = createClient();
    const ordinaryKey = ["lite-invalidation-none"] as const;
    const infiniteKey = ["infinite-invalidation-none"] as const;
    const ordinaryExecute = vi.fn(async () => ordinaryExecute.mock.calls.length);
    const infiniteExecute = vi.fn(() => infiniteExecute.mock.calls.length);
    const ordinary = renderHook(
      () => useQueryLite({ queryKey: ordinaryKey, queryFn: ordinaryExecute }),
      { wrapper: provider(client) },
    );
    const infinite = renderHook(
      () =>
        useInfiniteQueryLite({
          queryKey: infiniteKey,
          queryFn: () => infiniteExecute(),
          initialPageParam: 0,
          getNextPageParam: () => undefined,
        }),
      { wrapper: provider(client) },
    );
    await waitFor(() => {
      expect(ordinary.result.current.data).toBe(1);
      expect(infinite.result.current.data?.pages).toEqual([1]);
    });

    await act(async () => {
      await client.invalidateQueries({ queryKey: ordinaryKey, refetchType: "none" });
      await client.invalidateQueries({ queryKey: infiniteKey, refetchType: "none" });
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ordinaryExecute).toHaveBeenCalledTimes(1);
    expect(infiniteExecute).toHaveBeenCalledTimes(1);
    expect(ordinary.result.current.isStale).toBe(true);
    expect(infinite.result.current.isStale).toBe(true);
  });

  it("keeps staleTime static ordinary and Infinite queries invalidated without refetching", async () => {
    const client = createClient();
    const ordinaryKey = ["static-ordinary-invalidation"] as const;
    const infiniteKey = ["static-infinite-invalidation"] as const;
    const ordinaryExecute = vi.fn(async () => ordinaryExecute.mock.calls.length);
    const infiniteExecute = vi.fn(() => infiniteExecute.mock.calls.length);
    const ordinary = renderHook(
      () =>
        useQueryLite({
          queryKey: ordinaryKey,
          queryFn: ordinaryExecute,
          staleTime: () => "static" as const,
        }),
      { wrapper: provider(client) },
    );
    const infinite = renderHook(
      () =>
        useInfiniteQueryLite({
          queryKey: infiniteKey,
          queryFn: () => infiniteExecute(),
          initialPageParam: 0,
          getNextPageParam: () => undefined,
          staleTime: "static",
        }),
      { wrapper: provider(client) },
    );
    await waitFor(() => {
      expect(ordinary.result.current.data).toBe(1);
      expect(infinite.result.current.data?.pages).toEqual([1]);
    });

    await act(async () => {
      for (const refetchType of [undefined, "all", "inactive"] as const) {
        await client.invalidateQueries(
          refetchType === undefined
            ? { queryKey: ordinaryKey }
            : { queryKey: ordinaryKey, refetchType },
        );
        await client.invalidateQueries(
          refetchType === undefined
            ? { queryKey: infiniteKey }
            : { queryKey: infiniteKey, refetchType },
        );
      }
      await client.refetchQueries({ queryKey: ordinaryKey, type: "all" });
      await client.refetchQueries({ queryKey: infiniteKey, type: "all" });
    });
    expect(ordinaryExecute).toHaveBeenCalledTimes(1);
    expect(infiniteExecute).toHaveBeenCalledTimes(1);
    expect(client.getQueryState(ordinaryKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(infiniteKey)?.isInvalidated).toBe(true);

    client.invalidateQueries = async (filters, options) => {
      await Promise.resolve();
      return QueryClient.prototype.invalidateQueries.call(client, filters, options);
    };
    await act(async () => {
      await client.invalidateQueries({ refetchType: "all" });
    });
    expect(ordinaryExecute).toHaveBeenCalledTimes(1);
    expect(infiniteExecute).toHaveBeenCalledTimes(1);
  });

  it("updates static invalidation protection from the latest committed options", async () => {
    const client = createClient();
    const ordinaryKey = ["changing-static-ordinary"] as const;
    const infiniteKey = ["changing-static-infinite"] as const;
    const ordinaryExecute = vi.fn(async () => "ordinary-fresh");
    const infiniteExecute = vi.fn(async () => "infinite-fresh");
    client.setQueryData(ordinaryKey, "ordinary-seed");
    client.setQueryData(infiniteKey, {
      pages: ["infinite-seed"],
      pageParams: [0],
    });
    const hook = renderHook(
      ({ isStatic }) => {
        useQueryLite({
          queryKey: ordinaryKey,
          queryFn: ordinaryExecute,
          staleTime: isStatic ? "static" : Infinity,
          refetchOnMount: false,
        });
        useInfiniteQueryLite({
          queryKey: infiniteKey,
          queryFn: infiniteExecute,
          initialPageParam: 0,
          getNextPageParam: () => undefined,
          staleTime: isStatic ? "static" : Infinity,
          refetchOnMount: false,
        });
      },
      { wrapper: provider(client), initialProps: { isStatic: true } },
    );

    await act(async () => {
      await client.invalidateQueries({ refetchType: "all" });
    });
    expect(ordinaryExecute).not.toHaveBeenCalled();
    expect(infiniteExecute).not.toHaveBeenCalled();

    hook.rerender({ isStatic: false });
    await act(async () => {
      await client.invalidateQueries({ refetchType: "all" });
    });
    expect(ordinaryExecute).toHaveBeenCalledTimes(1);
    expect(infiniteExecute).toHaveBeenCalledTimes(1);
  });

  it("keeps invalidation tracking when the client method implementation is replaced", async () => {
    const client = createClient();
    const queryKey = ["replaced-invalidate-method"] as const;
    const request = deferred<string>();
    client.setQueryData(queryKey, "seed");
    const hook = renderHook(
      () =>
        useQueryLite({
          queryKey,
          queryFn: () => request.promise,
          staleTime: Infinity,
        }),
      { wrapper: provider(client) },
    );
    expect(hook.result.current.data).toBe("seed");

    const replacement: typeof client.invalidateQueries = async (filters, options) => {
      await Promise.resolve();
      return QueryClient.prototype.invalidateQueries.call(client, filters, options);
    };
    client.invalidateQueries = replacement;
    expect(client.invalidateQueries).not.toBe(replacement);
    let settled = false;
    const invalidation = client.invalidateQueries({ queryKey }).then(() => {
      settled = true;
    });
    await act(async () => Promise.resolve());
    expect(settled).toBe(false);
    request.resolve("fresh");
    await act(async () => invalidation);
    expect(client.getQueryData(queryKey)).toBe("fresh");
  });

  it("does not recurse when an invalidateQueries decorator forwards normalized filters", async () => {
    const client = createClient();
    const queryKey = ["decorated-invalidate-method"] as const;
    const request = deferred<string>();
    client.setQueryData(queryKey, "seed");
    renderHook(
      () =>
        useQueryLite({
          queryKey,
          queryFn: () => request.promise,
          staleTime: Infinity,
        }),
      { wrapper: provider(client) },
    );

    const trackedInvalidate = client.invalidateQueries;
    let decoratorCalls = 0;
    client.invalidateQueries = async (filters, options) => {
      decoratorCalls += 1;
      if (decoratorCalls > 5) throw new Error("recursive invalidateQueries decorator");
      await Promise.resolve();
      return trackedInvalidate(
        filters === undefined ? undefined : { ...filters },
        options === undefined ? undefined : { ...options },
      );
    };

    let settled = false;
    const invalidation = client.invalidateQueries({ queryKey }).then(() => {
      settled = true;
    });
    await act(async () => Promise.resolve());
    expect(decoratorCalls).toBe(1);
    expect(settled).toBe(false);
    request.resolve("fresh");
    await act(async () => invalidation);
    expect(client.getQueryData(queryKey)).toBe("fresh");
  });

  it("runs an async invalidateQueries decorator for each concurrent public call", async () => {
    const client = createClient();
    const queryKey = ["concurrent-invalidate-decorator"] as const;
    client.setQueryData(queryKey, "seed");
    renderHook(
      () =>
        useQueryLite({
          queryKey,
          queryFn: async () => "unused",
          staleTime: Infinity,
        }),
      { wrapper: provider(client) },
    );

    const trackedInvalidate = client.invalidateQueries;
    const gate = deferred<void>();
    let decoratorCalls = 0;
    client.invalidateQueries = async (filters, options) => {
      decoratorCalls += 1;
      await gate.promise;
      return trackedInvalidate(
        filters === undefined ? undefined : { ...filters },
        options,
      );
    };

    const first = client.invalidateQueries({ queryKey, refetchType: "none" });
    const second = client.invalidateQueries({ queryKey, refetchType: "none" });
    await act(async () => Promise.resolve());
    expect(decoratorCalls).toBe(2);
    gate.resolve();
    await act(async () => Promise.all([first, second]));
  });

  it("composes sequential invalidateQueries decorators around the native implementation", async () => {
    const client = createClient();
    const queryKey = ["stacked-invalidate-decorators"] as const;
    client.setQueryData(queryKey, "seed");
    renderHook(
      () =>
        useQueryLite({
          queryKey,
          queryFn: async () => "unused",
          staleTime: Infinity,
        }),
      { wrapper: provider(client) },
    );

    const nativeTracked = client.invalidateQueries;
    let firstCalls = 0;
    client.invalidateQueries = (filters, options) => {
      firstCalls += 1;
      return nativeTracked(
        filters === undefined ? undefined : { ...filters },
        options,
      );
    };
    const firstTracked = client.invalidateQueries;
    let secondCalls = 0;
    client.invalidateQueries = async (filters, options) => {
      secondCalls += 1;
      await Promise.resolve();
      return firstTracked(
        filters === undefined ? undefined : { ...filters },
        options,
      );
    };

    await act(async () => {
      await client.invalidateQueries({ queryKey, refetchType: "none" });
    });
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(1);
  });

  it("does not patch invalidateQueries during an uncommitted server render", () => {
    const client = createClient();
    const originalInvalidate = client.invalidateQueries;

    function View() {
      useQueryLite({
        queryKey: ["server-render-invalidation"],
        queryFn: async () => "unused",
        subscribed: false,
      });
      return <span>server</span>;
    }

    renderToString(
      <QueryClientProvider client={client}>
        <View />
      </QueryClientProvider>,
    );
    expect(client.invalidateQueries).toBe(originalInvalidate);
  });

  it("keeps duplicate query entry notifications independent before combine", () => {
    const client = createClient();
    const queryKey = ["duplicate-combine-notification"] as const;
    client.setQueryData(queryKey, 1);
    const hook = renderHook(
      () =>
        useQueriesLite({
          queries: [
            {
              queryKey,
              queryFn: async () => 1,
              select: (value: number) => (value === 2 ? "A" : "B"),
            },
            {
              queryKey,
              queryFn: async () => 1,
              select: () => "B",
              notifyOnChangeProps: "all",
            },
          ],
          combine: (results) => results[0].data,
        }),
      { wrapper: provider(client) },
    );
    expect(hook.result.current).toBe("B");

    act(() => client.setQueryData(queryKey, 2));
    expect(hook.result.current).toBe("A");
  });

  it("uses committed notifyOnChangeProps after an ordinary render is abandoned", async () => {
    const client = createClient();
    const queryKey = ["abandoned-notify-options"] as const;
    const never = new Promise<never>(() => undefined);
    client.setQueryData(queryKey, "old");
    let setVersion!: (value: number) => void;

    function View({ version }: { version: number }) {
      const result = useQueryLite({
        queryKey,
        queryFn: async () => "fetched",
        notifyOnChangeProps: version === 0 ? ["data"] : [],
        staleTime: Infinity,
      });
      if (version === 1) throw never;
      return <span data-testid="abandoned-notify">{result.data}</span>;
    }

    function App() {
      const [version, updateVersion] = useState(0);
      setVersion = updateVersion;
      return (
        <Suspense fallback={<span>notify-loading</span>}>
          <View version={version} />
        </Suspense>
      );
    }

    render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("abandoned-notify").textContent).toBe("old");
    act(() => {
      startTransition(() => setVersion(1));
    });
    act(() => client.setQueryData(queryKey, "new"));
    await waitFor(() => {
      expect(screen.getByTestId("abandoned-notify").textContent).toBe("new");
    });
  });

  it("uses committed notifyOnChangeProps after an Infinite render is abandoned", async () => {
    const client = createClient();
    const queryKey = ["abandoned-infinite-notify-options"] as const;
    const never = new Promise<never>(() => undefined);
    client.setQueryData(queryKey, { pages: ["old"], pageParams: [0] });
    let setVersion!: (value: number) => void;

    function View({ version }: { version: number }) {
      const result = useInfiniteQueryLite({
        queryKey,
        queryFn: async () => "fetched",
        initialPageParam: 0,
        getNextPageParam: () => undefined,
        notifyOnChangeProps: version === 0 ? ["data"] : [],
        staleTime: Infinity,
      });
      if (version === 1) throw never;
      return <span data-testid="abandoned-infinite-notify">{result.data?.pages[0]}</span>;
    }

    function App() {
      const [version, updateVersion] = useState(0);
      setVersion = updateVersion;
      return (
        <Suspense fallback={<span>infinite-notify-loading</span>}>
          <View version={version} />
        </Suspense>
      );
    }

    render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("abandoned-infinite-notify").textContent).toBe("old");
    act(() => {
      startTransition(() => setVersion(1));
    });
    act(() => {
      client.setQueryData(queryKey, { pages: ["new"], pageParams: [0] });
    });
    await waitFor(() => {
      expect(screen.getByTestId("abandoned-infinite-notify").textContent).toBe("new");
    });
  });

  it("does not use an abandoned ordinary select result as the committed notification baseline", async () => {
    const client = createClient();
    const queryKey = ["abandoned-select-baseline"] as const;
    const never = new Promise<never>(() => undefined);
    client.setQueryData(queryKey, 1);
    let setVersion!: (value: number) => void;

    function View({ version }: { version: number }) {
      const result = useQueryLite({
        queryKey,
        queryFn: async () => 1,
        select: version === 0
          ? (value: number) => (value === 2 ? "new" : "old")
          : () => "new",
        notifyOnChangeProps: ["data"],
        staleTime: Infinity,
      });
      if (version === 1) throw never;
      return <span data-testid="abandoned-select">{result.data}</span>;
    }

    function App() {
      const [version, updateVersion] = useState(0);
      setVersion = updateVersion;
      return (
        <Suspense fallback={<span>select-loading</span>}>
          <View version={version} />
        </Suspense>
      );
    }

    render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("abandoned-select").textContent).toBe("old");
    act(() => {
      startTransition(() => setVersion(1));
    });
    act(() => client.setQueryData(queryKey, 2));
    await waitFor(() => {
      expect(screen.getByTestId("abandoned-select").textContent).toBe("new");
    });
  });

  it("does not use an abandoned Infinite select result as the committed notification baseline", async () => {
    const client = createClient();
    const queryKey = ["abandoned-infinite-select-baseline"] as const;
    const never = new Promise<never>(() => undefined);
    client.setQueryData(queryKey, { pages: [1], pageParams: [0] });
    let setVersion!: (value: number) => void;

    function View({ version }: { version: number }) {
      const result = useInfiniteQueryLite({
        queryKey,
        queryFn: async () => 1,
        initialPageParam: 0,
        getNextPageParam: () => undefined,
        select: version === 0
          ? (data) => ({
            ...data,
            pages: data.pages.map((value) => (value === 2 ? "new" : "old")),
          })
          : (data) => ({ ...data, pages: data.pages.map(() => "new") }),
        notifyOnChangeProps: ["data"],
        staleTime: Infinity,
      });
      if (version === 1) throw never;
      return <span data-testid="abandoned-infinite-select">{result.data?.pages[0]}</span>;
    }

    function App() {
      const [version, updateVersion] = useState(0);
      setVersion = updateVersion;
      return (
        <Suspense fallback={<span>infinite-select-loading</span>}>
          <View version={version} />
        </Suspense>
      );
    }

    render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("abandoned-infinite-select").textContent).toBe("old");
    act(() => {
      startTransition(() => setVersion(1));
    });
    act(() => {
      client.setQueryData(queryKey, { pages: [2], pageParams: [0] });
    });
    await waitFor(() => {
      expect(screen.getByTestId("abandoned-infinite-select").textContent).toBe("new");
    });
  });

  it("keeps invalidateQueries pending until a Lite-only active refetch settles", async () => {
    const client = createClient();
    const queryKey = ["invalidate-awaits-lite"] as const;
    const request = deferred<string>();
    client.setQueryData(queryKey, "seed");
    const hook = renderHook(
      () =>
        useQueryLite({
          queryKey,
          queryFn: () => request.promise,
          staleTime: Infinity,
        }),
      { wrapper: provider(client) },
    );
    expect(hook.result.current.data).toBe("seed");

    let settled = false;
    const invalidation = client.invalidateQueries({ queryKey }).then(() => {
      settled = true;
    });
    await act(async () => Promise.resolve());
    expect(settled).toBe(false);
    expect(hook.result.current.data).toBe("seed");

    request.resolve("fresh");
    await act(async () => invalidation);
    expect(settled).toBe(true);
    expect(hook.result.current.data).toBe("fresh");
  });

  it("restarts an in-flight Lite refetch when active invalidation cancels it", async () => {
    const client = createClient();
    const queryKey = ["invalidate-restarts-lite"] as const;
    const requests: Array<ReturnType<typeof deferred<string>>> = [];
    const signals: AbortSignal[] = [];
    client.setQueryData(queryKey, "seed");
    const queryFn = vi.fn(({ signal }: { signal: AbortSignal }) => {
      const request = deferred<string>();
      requests.push(request);
      signals.push(signal);
      signal.addEventListener("abort", () => {
        request.reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
      return request.promise;
    });
    const hook = renderHook(
      () => useQueryLite({ queryKey, queryFn, staleTime: Infinity }),
      { wrapper: provider(client) },
    );
    expect(hook.result.current.data).toBe("seed");

    void hook.result.current.refetch();
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));
    const invalidation = client.invalidateQueries({ queryKey });
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
    expect(signals[0]?.aborted).toBe(true);
    requests[1]!.resolve("v2");
    await act(async () => invalidation);
    expect(client.getQueryData(queryKey)).toBe("v2");
    await waitFor(() => expect(hook.result.current.data).toBe("v2"));
  });

  it("resolves invalidation while Lite-only ordinary and Infinite refetches are paused", async () => {
    onlineManager.setOnline(false);
    const client = createClient();
    const ordinaryKey = ["paused-ordinary-invalidation"] as const;
    const infiniteKey = ["paused-infinite-invalidation"] as const;
    client.setQueryData(ordinaryKey, "seed");
    client.setQueryData(infiniteKey, { pages: ["seed"], pageParams: [0] });
    const ordinary = renderHook(
      () =>
        useQueryLite({
          queryKey: ordinaryKey,
          queryFn: async () => "fresh",
          staleTime: Infinity,
        }),
      { wrapper: provider(client) },
    );
    const infinite = renderHook(
      () =>
        useInfiniteQueryLite({
          queryKey: infiniteKey,
          queryFn: async () => "fresh",
          initialPageParam: 0,
          getNextPageParam: () => undefined,
          staleTime: Infinity,
        }),
      { wrapper: provider(client) },
    );
    expect(ordinary.result.current.data).toBe("seed");
    expect(infinite.result.current.data?.pages).toEqual(["seed"]);

    const invalidations = Promise.all([
      client.invalidateQueries({ queryKey: ordinaryKey }),
      client.invalidateQueries({ queryKey: infiniteKey }),
    ]);
    const outcome = await Promise.race([
      invalidations.then(() => "settled" as const),
      new Promise<"timeout">((resolve) => {
        setTimeout(() => resolve("timeout"), 50);
      }),
    ]);
    expect(outcome).toBe("settled");
    expect(client.getQueryState(ordinaryKey)?.fetchStatus).toBe("paused");
    expect(client.getQueryState(infiniteKey)?.fetchStatus).toBe("paused");

    onlineManager.setOnline(true);
    await waitFor(() => {
      expect(client.getQueryState(ordinaryKey)?.fetchStatus).toBe("idle");
      expect(client.getQueryState(infiniteKey)?.fetchStatus).toBe("idle");
    });
  });

  it("returns committed ordinary and Infinite selections from manual refetch after an abandoned render", async () => {
    const client = createClient();
    const ordinaryKey = ["abandoned-manual-result"] as const;
    const infiniteKey = ["abandoned-infinite-manual-result"] as const;
    const never = new Promise<never>(() => undefined);
    client.setQueryData(ordinaryKey, 1);
    client.setQueryData(infiniteKey, { pages: [1], pageParams: [0] });
    let setVersion!: (value: number) => void;
    let refetchOrdinary!: () => Promise<{ data: string | undefined }>;
    let refetchInfinite!: () => Promise<{
      data: { pages: string[] } | undefined;
    }>;

    function View({ version }: { version: number }) {
      const ordinary = useQueryLite({
        queryKey: ordinaryKey,
        queryFn: async () => 2,
        select: version === 0
          ? (value: number) => `C${value}`
          : (value: number) => `A${value}`,
        subscribed: false,
      });
      const infinite = useInfiniteQueryLite({
        queryKey: infiniteKey,
        queryFn: async () => 2,
        initialPageParam: 0,
        getNextPageParam: () => undefined,
        select: version === 0
          ? (data) => ({ ...data, pages: data.pages.map((value) => `C${value}`) })
          : (data) => ({ ...data, pages: data.pages.map((value) => `A${value}`) }),
        subscribed: false,
      });
      refetchOrdinary = ordinary.refetch;
      refetchInfinite = infinite.refetch;
      if (version === 1) throw never;
      return (
        <span data-testid="abandoned-manual-result">
          {ordinary.data}/{infinite.data?.pages[0]}
        </span>
      );
    }

    function App() {
      const [version, updateVersion] = useState(0);
      setVersion = updateVersion;
      return (
        <Suspense fallback={<span>manual-loading</span>}>
          <View version={version} />
        </Suspense>
      );
    }

    render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("abandoned-manual-result").textContent).toBe("C1/C1");
    act(() => {
      startTransition(() => setVersion(1));
    });

    const [ordinaryResult, infiniteResult] = await act(async () =>
      Promise.all([refetchOrdinary(), refetchInfinite()]),
    );
    expect(ordinaryResult.data).toBe("C2");
    expect(infiniteResult.data?.pages).toEqual(["C2"]);
    expect(client.getQueryData(ordinaryKey)).toBe(2);
    expect(client.getQueryData<{ pages: number[] }>(infiniteKey)?.pages).toEqual([2]);
    expect(screen.getByTestId("abandoned-manual-result").textContent).toBe("C1/C1");
  });

  it("acquires and releases an aggregate item lease when subscribed changes", async () => {
    vi.useFakeTimers();
    const client = createClient();
    const queryKey = ["aggregate-item-subscription-lease"] as const;
    const queryFn = vi.fn(async () => queryFn.mock.calls.length);
    const hook = renderHook(
      ({ subscribed }) =>
        useQueriesLite({
          queries: [{
            queryKey,
            queryFn,
            gcTime: 20,
            subscribed,
          } as UseQueryOptions<number> & { subscribed: boolean }],
        }),
      { wrapper: provider(client), initialProps: { subscribed: false } },
    );
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(queryFn).not.toHaveBeenCalled();

    hook.rerender({ subscribed: true });
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(queryFn).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(120));
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(client.getQueryCache().find({ queryKey })).toBeDefined();

    hook.rerender({ subscribed: false });
    await act(async () => vi.advanceTimersByTimeAsync(21));
    expect(client.getQueryCache().find({ queryKey })).toBeUndefined();
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it("uses the latest committed Infinite refetchIntervalInBackground without resetting polling", async () => {
    vi.useFakeTimers();
    focusManager.setFocused(false);
    const client = createClient();
    const queryFn = vi.fn(async () => queryFn.mock.calls.length);
    const hook = renderHook(
      ({ inBackground }) =>
        useInfiniteQueryLite({
          queryKey: ["infinite-background-polling"],
          queryFn,
          initialPageParam: 0,
          getNextPageParam: () => undefined,
          refetchInterval: 20,
          refetchIntervalInBackground: inBackground,
        }),
      { wrapper: provider(client), initialProps: { inBackground: false } },
    );
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(queryFn).toHaveBeenCalledTimes(1);
    hook.rerender({ inBackground: true });
    await act(async () => vi.advanceTimersByTimeAsync(21));
    expect(queryFn.mock.calls.length).toBeGreaterThan(1);
  });

  it("retains a shared QueryCache entry until every Lite client releases it", async () => {
    vi.useFakeTimers();
    const cache = new QueryCache();
    const firstClient = new QueryClient({
      queryCache: cache,
      defaultOptions: { queries: { gcTime: 0 } },
    });
    const secondClient = new QueryClient({
      queryCache: cache,
      defaultOptions: { queries: { gcTime: 0 } },
    });
    clients.add(firstClient);
    clients.add(secondClient);
    const queryKey = ["shared-cache-lite-leases"] as const;
    firstClient.setQueryData(queryKey, "seed");
    const firstFetch = vi.fn(async () => "first");
    const secondFetch = vi.fn(async () => "second");
    const first = renderHook(
      () =>
        useQueryLite({
          queryKey,
          queryFn: firstFetch,
          staleTime: Infinity,
          gcTime: 0,
        }),
      { wrapper: provider(firstClient) },
    );
    const second = renderHook(
      () =>
        useQueryLite({
          queryKey,
          queryFn: secondFetch,
          staleTime: Infinity,
          gcTime: 0,
        }),
      { wrapper: provider(secondClient) },
    );
    expect(first.result.current.data).toBe("seed");
    expect(second.result.current.data).toBe("seed");

    first.unmount();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(secondClient.getQueryData(queryKey)).toBe("seed");
    expect(second.result.current.data).toBe("seed");
    expect(secondFetch).not.toHaveBeenCalled();

    second.unmount();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(cache.find({ queryKey })).toBeUndefined();
  });

  it("makes a shared-cache client await a Lite-only active invalidation", async () => {
    const cache = new QueryCache();
    const liteClient = new QueryClient({ queryCache: cache });
    const nativeClient = new QueryClient({ queryCache: cache });
    clients.add(liteClient);
    clients.add(nativeClient);
    const queryKey = ["shared-cache-active-semantics"] as const;
    const request = deferred<string>();
    liteClient.setQueryData(queryKey, "seed");
    const hook = renderHook(
      () =>
        useQueryLite({
          queryKey,
          queryFn: () => request.promise,
          staleTime: Infinity,
        }),
      { wrapper: provider(liteClient) },
    );
    expect(hook.result.current.data).toBe("seed");
    expect(Object.hasOwn(nativeClient, "invalidateQueries")).toBe(false);

    let settled = false;
    const invalidation = nativeClient.invalidateQueries({ queryKey }).then(() => {
      settled = true;
    });
    await act(async () => Promise.resolve());
    expect(settled).toBe(false);
    expect(nativeClient.getQueryState(queryKey)?.fetchStatus).toBe("fetching");

    request.resolve("fresh");
    await act(async () => invalidation);
    expect(hook.result.current.data).toBe("fresh");
  });

  it("shares static semantics across clients and restores native Query methods", async () => {
    const cache = new QueryCache();
    const liteClient = new QueryClient({ queryCache: cache });
    const nativeClient = new QueryClient({ queryCache: cache });
    clients.add(liteClient);
    clients.add(nativeClient);
    const queryKey = ["shared-cache-static-semantics"] as const;
    const queryFn = vi.fn(async () => "fresh");
    liteClient.setQueryData(queryKey, "seed");
    const query = cache.find({ queryKey })!;
    expect(Object.hasOwn(query, "isActive")).toBe(false);
    expect(Object.hasOwn(query, "isDisabled")).toBe(false);
    expect(Object.hasOwn(query, "isStatic")).toBe(false);
    const hook = renderHook(
      () =>
        useQueryLite({
          queryKey,
          queryFn,
          staleTime: "static",
          refetchOnMount: false,
        }),
      { wrapper: provider(liteClient) },
    );
    expect(hook.result.current.data).toBe("seed");
    expect(query.isActive()).toBe(true);
    expect(query.isDisabled()).toBe(false);
    expect(query.isStatic()).toBe(true);

    await act(async () => {
      await nativeClient.refetchQueries({ queryKey, type: "all" });
      await nativeClient.invalidateQueries({ queryKey, refetchType: "all" });
    });
    expect(queryFn).not.toHaveBeenCalled();
    expect(nativeClient.getQueryState(queryKey)?.isInvalidated).toBe(true);

    hook.unmount();
    expect(Object.hasOwn(query, "isActive")).toBe(false);
    expect(Object.hasOwn(query, "isDisabled")).toBe(false);
    expect(Object.hasOwn(query, "isStatic")).toBe(false);
    await nativeClient.refetchQueries({ queryKey, type: "all" });
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it("updates shared native active filters from committed enabled options", async () => {
    const cache = new QueryCache();
    const liteClient = new QueryClient({ queryCache: cache });
    const nativeClient = new QueryClient({ queryCache: cache });
    clients.add(liteClient);
    clients.add(nativeClient);
    const queryKey = ["shared-cache-enabled-semantics"] as const;
    const queryFn = vi.fn(async () => "fresh");
    liteClient.setQueryData(queryKey, "seed");
    const hook = renderHook(
      ({ enabled }) =>
        useQueryLite({
          queryKey,
          queryFn,
          enabled,
          staleTime: Infinity,
          refetchOnMount: false,
        }),
      { wrapper: provider(liteClient), initialProps: { enabled: false } },
    );
    const query = cache.find({ queryKey })!;
    expect(query.isActive()).toBe(false);
    expect(query.isDisabled()).toBe(true);
    await nativeClient.refetchQueries({ queryKey, type: "active" });
    await nativeClient.refetchQueries({ queryKey, type: "all" });
    expect(queryFn).not.toHaveBeenCalled();

    hook.rerender({ enabled: true });
    expect(query.isActive()).toBe(true);
    expect(query.isDisabled()).toBe(false);
    await act(async () => {
      await nativeClient.refetchQueries({ queryKey, type: "active" });
    });
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it("combines skipToken, enabled, and native observer leases for shared filters", async () => {
    const client = createClient();
    const queryKey = ["mixed-query-semantics"] as const;
    const queryFn = vi.fn(async () => "fresh");
    client.setQueryData(queryKey, "seed");
    const skipped = renderHook(
      () =>
        useQueryLite({
          queryKey,
          queryFn: skipToken,
          staleTime: Infinity,
        }),
      { wrapper: provider(client) },
    );
    const enabled = renderHook(
      () =>
        useQueryLite({
          queryKey,
          queryFn,
          staleTime: Infinity,
          refetchOnMount: false,
        }),
      { wrapper: provider(client) },
    );
    const query = client.getQueryCache().find({ queryKey })!;
    expect(query.isActive()).toBe(true);
    expect(query.isDisabled()).toBe(false);

    enabled.unmount();
    expect(query.isActive()).toBe(false);
    expect(query.isDisabled()).toBe(true);
    await client.refetchQueries({ queryKey, type: "all" });
    expect(queryFn).not.toHaveBeenCalled();

    const native = renderHook(
      () =>
        useNativeQuery({
          queryKey,
          queryFn,
          staleTime: Infinity,
        }),
      { wrapper: provider(client) },
    );
    expect(query.isActive()).toBe(true);
    expect(query.isDisabled()).toBe(false);
    native.unmount();
    expect(query.isActive()).toBe(false);
    expect(query.isDisabled()).toBe(true);

    skipped.unmount();
    expect(Object.hasOwn(query, "isActive")).toBe(false);
    expect(Object.hasOwn(query, "isDisabled")).toBe(false);
    expect(Object.hasOwn(query, "isStatic")).toBe(false);
  });

  it("does not retain a query when semantic method installation fails", async () => {
    vi.useFakeTimers();
    const client = new QueryClient({
      defaultOptions: { queries: { gcTime: 25, retry: false } },
    });
    clients.add(client);
    const queryKey = ["non-extensible-query"] as const;
    const query = client.getQueryCache().build(
      client,
      client.defaultQueryOptions({ queryKey, queryFn: async () => "value" }),
    );
    Object.preventExtensions(query);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() =>
      renderHook(
        () => useQueryLite({ queryKey, queryFn: async () => "value", gcTime: 25 }),
        { wrapper: provider(client) },
      ),
    ).toThrow(/non-extensible Query/);
    expect(query.gcTime).toBe(25);
    expect(Object.hasOwn(query, "isActive")).toBe(false);
    expect(Object.hasOwn(query, "isDisabled")).toBe(false);
    expect(Object.hasOwn(query, "isStatic")).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(30));
    expect(client.getQueryCache().find({ queryKey })).toBeUndefined();
    consoleError.mockRestore();
  });

  it("rolls back a single-query lease when a timer option throws during commit", async () => {
    vi.useFakeTimers();
    const client = new QueryClient({
      defaultOptions: { queries: { gcTime: 25, retry: false } },
    });
    clients.add(client);
    const queryKey = ["throwing-interval-rollback"] as const;
    client.setQueryData(queryKey, "seed");
    const query = client.getQueryCache().find({ queryKey })!;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    let thrown: unknown;
    try {
      renderHook(
        () =>
          useQueryLite({
            queryKey,
            queryFn: async () => "value",
            gcTime: 25,
            refetchInterval: () => {
              throw new Error("interval boom");
            },
          }),
        { wrapper: provider(client) },
      );
    } catch (error) {
      thrown = error;
    }
    const errors = thrown instanceof AggregateError ? thrown.errors : [thrown];
    expect(errors.map(String).join("\n")).toContain("interval boom");
    expect(query.gcTime).toBe(25);
    expect(query.isActive()).toBe(false);
    expect(Object.hasOwn(query, "isActive")).toBe(false);
    expect(Object.hasOwn(query, "isDisabled")).toBe(false);
    expect(Object.hasOwn(query, "isStatic")).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(30));
    expect(client.getQueryCache().find({ queryKey })).toBeUndefined();
    consoleError.mockRestore();
  });

  it("rolls back an Infinite lease when cache subscription setup throws", async () => {
    vi.useFakeTimers();
    const cache = new QueryCache();
    const client = new QueryClient({
      queryCache: cache,
      defaultOptions: { queries: { gcTime: 25, retry: false } },
    });
    clients.add(client);
    const queryKey = ["infinite-subscribe-rollback"] as const;
    client.setQueryData(queryKey, { pages: ["seed"], pageParams: [0] });
    const query = cache.find({ queryKey })!;
    const subscribe = vi.spyOn(cache, "subscribe").mockImplementation(() => {
      throw new Error("cache subscribe boom");
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() =>
      renderHook(
        () =>
          useInfiniteQueryLite({
            queryKey,
            queryFn: async ({ pageParam }) => String(pageParam),
            initialPageParam: 0,
            getNextPageParam: () => undefined,
            gcTime: 25,
          }),
        { wrapper: provider(client) },
      ),
    ).toThrow("cache subscribe boom");
    subscribe.mockRestore();
    expect(query.gcTime).toBe(25);
    expect(Object.hasOwn(query, "isActive")).toBe(false);
    expect(Object.hasOwn(query, "isDisabled")).toBe(false);
    expect(Object.hasOwn(query, "isStatic")).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(30));
    expect(cache.find({ queryKey })).toBeUndefined();
    consoleError.mockRestore();
  });

  it("rolls back earlier aggregate leases when a later query cannot commit", async () => {
    vi.useFakeTimers();
    const client = new QueryClient({
      defaultOptions: { queries: { gcTime: 25, retry: false } },
    });
    clients.add(client);
    const firstKey = ["aggregate-rollback", "first"] as const;
    const secondKey = ["aggregate-rollback", "second"] as const;
    client.setQueryData(firstKey, "first");
    client.setQueryData(secondKey, "second");
    const first = client.getQueryCache().find({ queryKey: firstKey })!;
    const second = client.getQueryCache().find({ queryKey: secondKey })!;
    Object.preventExtensions(second);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() =>
      renderHook(
        () =>
          useQueriesLite({
            queries: [
              { queryKey: firstKey, queryFn: async () => "first", gcTime: 25 },
              { queryKey: secondKey, queryFn: async () => "second", gcTime: 25 },
            ],
          }),
        { wrapper: provider(client) },
      ),
    ).toThrow(/non-extensible Query/);
    for (const query of [first, second]) {
      expect(query.gcTime).toBe(25);
      expect(Object.hasOwn(query, "isActive")).toBe(false);
      expect(Object.hasOwn(query, "isDisabled")).toBe(false);
      expect(Object.hasOwn(query, "isStatic")).toBe(false);
    }
    await act(async () => vi.advanceTimersByTimeAsync(30));
    expect(client.getQueryCache().find({ queryKey: firstKey })).toBeUndefined();
    expect(client.getQueryCache().find({ queryKey: secondKey })).toBeUndefined();
    consoleError.mockRestore();
  });

  it("keeps invalidation tracking retryable after accessor installation fails", () => {
    const client = createClient();
    const hub = getLiteHub(client);
    const query = hub.buildQuery({
      queryKey: ["non-extensible-client"] as const,
      queryFn: async () => "value",
    });
    Object.preventExtensions(client);

    for (let attempt = 0; attempt < 2; attempt++) {
      const lease = {};
      hub.setQuerySemantics(query, lease, {
        isActive: () => true,
        isStatic: () => false,
      });
      expect(() => hub.retain(query, 25)).toThrow(/not extensible/);
      hub.clearQuerySemantics(lease);
      expect(Object.hasOwn(client, "invalidateQueries")).toBe(false);
      expect(Object.hasOwn(query, "isActive")).toBe(false);
      expect(query.gcTime).not.toBe(Infinity);
    }
  });

  it("does not publish an abandoned transition queryFn to the committed subscription", async () => {
    const client = createClient();
    const queryKey = ["abandoned-query-fn"] as const;
    const never = new Promise<never>(() => undefined);
    const execute = vi.fn((value: number) => value);
    let setVersion!: (value: number) => void;

    function QueryView({ version }: { version: number }) {
      const result = useQueryLite({
        queryKey,
        queryFn: () => execute(version),
        staleTime: Infinity,
      });
      if (version === 1) throw never;
      return <span data-testid="abandoned-query-fn">{result.data}</span>;
    }

    function App() {
      const [version, updateVersion] = useState(0);
      setVersion = updateVersion;
      return (
        <Suspense fallback={<span>transition-loading</span>}>
          <QueryView version={version} />
        </Suspense>
      );
    }

    render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("abandoned-query-fn").textContent).toBe("0"));

    act(() => {
      startTransition(() => setVersion(1));
    });
    expect(screen.getByTestId("abandoned-query-fn").textContent).toBe("0");

    await act(async () => {
      await client.invalidateQueries({ queryKey });
    });
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(client.getQueryData(queryKey)).toBe(0);
    expect(screen.getByTestId("abandoned-query-fn").textContent).toBe("0");
  });

  it("uses the last committed query for placeholderData after an abandoned key", async () => {
    const client = createClient();
    const baseKey = "abandoned-placeholder-key";
    client.setQueryData([baseKey, 0], "zero");
    client.setQueryData([baseKey, 1], "one");
    const never = new Promise<string>(() => undefined);
    let setVersion!: (value: number) => void;

    function QueryView({ version }: { version: number }) {
      const result = useQueryLite({
        queryKey: [baseKey, version] as const,
        queryFn: () => never,
        placeholderData: (previous) => previous,
        staleTime: Infinity,
      });
      if (version === 1) throw never;
      return <span data-testid="abandoned-placeholder">{result.data}</span>;
    }

    function App() {
      const [version, updateVersion] = useState(0);
      setVersion = updateVersion;
      return (
        <Suspense fallback={<span>placeholder-loading</span>}>
          <QueryView version={version} />
        </Suspense>
      );
    }

    render(<App />, { wrapper: provider(client) });
    expect(screen.getByTestId("abandoned-placeholder").textContent).toBe("zero");
    act(() => startTransition(() => setVersion(1)));
    expect(screen.getByTestId("abandoned-placeholder").textContent).toBe("zero");
    act(() => setVersion(2));
    await waitFor(() =>
      expect(screen.getByTestId("abandoned-placeholder").textContent).toBe("zero"),
    );
  });

  it("keeps the committed useQueries key subscription during an abandoned transition", async () => {
    const client = createClient();
    const never = new Promise<never>(() => undefined);
    client.setQueryData(["abandoned-list", 0], "zero");
    client.setQueryData(["abandoned-list", 1], "one");
    let setVersion!: (value: number) => void;

    function QueryList({ version }: { version: number }) {
      const results = useQueriesLite({
        queries: [
          {
            queryKey: ["abandoned-list", version],
            queryFn: () => `network-${version}`,
            staleTime: Infinity,
          },
        ],
      });
      if (version === 1) throw never;
      return <span data-testid="abandoned-list">{results[0].data}</span>;
    }

    function App() {
      const [version, updateVersion] = useState(0);
      setVersion = updateVersion;
      return (
        <Suspense fallback={<span>list-loading</span>}>
          <QueryList version={version} />
        </Suspense>
      );
    }

    render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("abandoned-list").textContent).toBe("zero");

    act(() => {
      startTransition(() => setVersion(1));
    });
    expect(screen.getByTestId("abandoned-list").textContent).toBe("zero");

    act(() => client.setQueryData(["abandoned-list", 0], "updated-zero"));
    await waitFor(() => {
      expect(screen.getByTestId("abandoned-list").textContent).toBe("updated-zero");
    });
  });

  it("keeps committed aggregate focus and reconnect behavior during an abandoned subscribed render", async () => {
    focusManager.setFocused(false);
    const client = createClient();
    const queryKey = ["abandoned-list-subscribed"] as const;
    const never = new Promise<never>(() => undefined);
    const queryFn = vi.fn(async () => queryFn.mock.calls.length);
    client.setQueryData(queryKey, 0);
    let setSubscribed!: (value: boolean) => void;

    function QueryList({ subscribed }: { subscribed: boolean }) {
      const results = useQueriesLite({
        queries: [{
          queryKey,
          queryFn,
          staleTime: 0,
          refetchOnMount: false,
          refetchOnWindowFocus: true,
          refetchOnReconnect: true,
        }],
        subscribed,
      });
      if (!subscribed) throw never;
      return <span data-testid="abandoned-list-subscribed">{results[0].data}</span>;
    }

    function App() {
      const [subscribed, updateSubscribed] = useState(true);
      setSubscribed = updateSubscribed;
      return (
        <Suspense fallback={<span>list-subscribed-loading</span>}>
          <QueryList subscribed={subscribed} />
        </Suspense>
      );
    }

    render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("abandoned-list-subscribed").textContent).toBe("0");
    expect(queryFn).not.toHaveBeenCalled();

    act(() => {
      startTransition(() => setSubscribed(false));
    });
    expect(screen.getByTestId("abandoned-list-subscribed").textContent).toBe("0");

    act(() => focusManager.setFocused(true));
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));
    act(() => onlineManager.setOnline(false));
    act(() => onlineManager.setOnline(true));
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
  });

  it("does not publish an abandoned Infinite Query callback to cache invalidation", async () => {
    const client = createClient();
    const queryKey = ["abandoned-infinite-query-fn"] as const;
    const never = new Promise<never>(() => undefined);
    const execute = vi.fn((value: number) => value);
    let setVersion!: (value: number) => void;

    function InfiniteView({ version }: { version: number }) {
      const result = useInfiniteQueryLite({
        queryKey,
        queryFn: () => execute(version),
        initialPageParam: 0,
        getNextPageParam: () => undefined,
        staleTime: Infinity,
      });
      if (version === 1) throw never;
      return <span data-testid="abandoned-infinite">{result.data?.pages[0]}</span>;
    }

    function App() {
      const [version, updateVersion] = useState(0);
      setVersion = updateVersion;
      return (
        <Suspense fallback={<span>infinite-loading</span>}>
          <InfiniteView version={version} />
        </Suspense>
      );
    }

    render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("abandoned-infinite").textContent).toBe("0"));

    act(() => {
      startTransition(() => setVersion(1));
    });
    expect(screen.getByTestId("abandoned-infinite").textContent).toBe("0");

    await act(async () => {
      await client.invalidateQueries({ queryKey });
    });
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(client.getQueryData<{ pages: number[] }>(queryKey)?.pages).toEqual([0]);
    expect(screen.getByTestId("abandoned-infinite").textContent).toBe("0");
  });
});
