import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  dehydrate,
  focusManager,
  hydrate,
  IsRestoringProvider,
  onlineManager,
  QueryClient as NativeQueryClient,
  QueryClientProvider as NativeQueryClientProvider,
  type UseQueryOptions,
  useQuery as useNativeQuery,
} from "@tanstack/react-query";
import {
  Component,
  StrictMode,
  Suspense,
  type PropsWithChildren,
  type ReactNode,
} from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  infiniteQueryOptions,
  infiniteQueryOptionsLite,
  queryOptions,
  queryOptionsLite,
  skipToken,
  skipTokenLite,
  useInfiniteQuery,
  useInfiniteQueryLite,
  useQueries,
  useQueriesLite,
  useQuery,
  useQueryClient,
  useQueryLite,
  useSuspenseInfiniteQuery,
  useSuspenseInfiniteQueryLite,
  useSuspenseQueries,
  useSuspenseQueriesLite,
  useSuspenseQuery,
  useSuspenseQueryLite,
} from "../src/index.js";

const clients = new Set<NativeQueryClient>();

function createClient(options?: ConstructorParameters<typeof NativeQueryClient>[0]) {
  const client = new NativeQueryClient(options);
  clients.add(client);
  return client;
}

function provider(client: NativeQueryClient) {
  return function Provider({ children }: PropsWithChildren) {
    return (
      <NativeQueryClientProvider client={client}>
        {children}
      </NativeQueryClientProvider>
    );
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    return this.state.error ? (
      <span data-testid="error">{this.state.error.message}</span>
    ) : (
      this.props.children
    );
  }
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

describe("public aliases and native QueryClient context", () => {
  it("keeps Lite and unsuffixed values identical", () => {
    expect(useQueryLite).toBe(useQuery);
    expect(useQueriesLite).toBe(useQueries);
    expect(useSuspenseQueryLite).toBe(useSuspenseQuery);
    expect(useSuspenseQueriesLite).toBe(useSuspenseQueries);
    expect(useInfiniteQueryLite).toBe(useInfiniteQuery);
    expect(useSuspenseInfiniteQueryLite).toBe(useSuspenseInfiniteQuery);
    expect(queryOptionsLite).toBe(queryOptions);
    expect(infiniteQueryOptionsLite).toBe(infiniteQueryOptions);
    expect(skipTokenLite).toBe(skipToken);
  });

  it("uses the nearest native provider and supports an explicit client", () => {
    const outer = createClient();
    const inner = createClient();
    const explicit = createClient();
    function Wrapper({ children }: PropsWithChildren) {
      return (
        <NativeQueryClientProvider client={outer}>
          <NativeQueryClientProvider client={inner}>
            {children}
          </NativeQueryClientProvider>
        </NativeQueryClientProvider>
      );
    }

    const nearest = renderHook(() => useQueryClient(), { wrapper: Wrapper });
    expect(nearest.result.current).toBe(inner);
    const selected = renderHook(() => useQueryClient(explicit), {
      wrapper: Wrapper,
    });
    expect(selected.result.current).toBe(explicit);
  });

  it("follows provider client replacement", () => {
    const first = createClient();
    const second = createClient();
    let current = first;
    function Wrapper({ children }: PropsWithChildren) {
      return (
        <NativeQueryClientProvider client={current}>
          {children}
        </NativeQueryClientProvider>
      );
    }

    const hook = renderHook(() => useQueryClient(), { wrapper: Wrapper });
    expect(hook.result.current).toBe(first);
    current = second;
    hook.rerender();
    expect(hook.result.current).toBe(second);
  });

  it("rebinds aggregate entries when the provider client changes", () => {
    const first = createClient();
    const second = createClient();
    const queryKey = ["aggregate-provider-switch"] as const;
    first.setQueryData(queryKey, "first");
    second.setQueryData(queryKey, "second");
    let current = first;
    function Wrapper({ children }: PropsWithChildren) {
      return (
        <NativeQueryClientProvider client={current}>
          {children}
        </NativeQueryClientProvider>
      );
    }
    const hook = renderHook(
      () =>
        useQueriesLite({
          queries: [{ queryKey, queryFn: async () => "unused", staleTime: Infinity }],
        })[0].data,
      { wrapper: Wrapper },
    );
    expect(hook.result.current).toBe("first");
    current = second;
    hook.rerender();
    expect(hook.result.current).toBe("second");
    act(() => second.setQueryData(queryKey, "updated"));
    expect(hook.result.current).toBe("updated");
  });
});

describe("native cache and query state interoperability", () => {
  it("shares a native Query object, state, and data updates without observers", async () => {
    const client = createClient();
    const queryKey = ["native-cache-sharing"] as const;
    const seed = { value: 1 };
    client.setQueryData(queryKey, seed);
    const queryBefore = client.getQueryCache().find({ queryKey });

    const hook = renderHook(
      () =>
        useQueryLite({
          queryKey,
          queryFn: async () => ({ value: 2 }),
          staleTime: Infinity,
        }),
      { wrapper: provider(client) },
    );

    expect(hook.result.current.data).toBe(seed);
    expect(queryBefore).toBeDefined();
    expect(queryBefore?.getObserversCount()).toBe(0);
    act(() => client.setQueryData(queryKey, { value: 3 }));
    await waitFor(() => expect(hook.result.current.data?.value).toBe(3));
    await act(async () => {
      await hook.result.current.refetch();
    });
    expect(hook.result.current.data?.value).toBe(2);
    expect(client.getQueryCache().find({ queryKey })).toBe(queryBefore);
    expect(queryBefore?.getObserversCount()).toBe(0);
    hook.unmount();
    expect(queryBefore?.getObserversCount()).toBe(0);
  });

  it("deduplicates native useQuery and Lite requests for one key", async () => {
    const client = createClient();
    const request = deferred<number>();
    const queryFn = vi.fn(() => request.promise);
    const native = renderHook(
      () => useNativeQuery({ queryKey: ["cross-hook-dedupe"], queryFn }),
      { wrapper: provider(client) },
    );
    const lite = renderHook(
      () =>
        useQueryLite({
          queryKey: ["cross-hook-dedupe"],
          queryFn,
          retry: false,
        }),
      { wrapper: provider(client) },
    );
    expect(queryFn).toHaveBeenCalledTimes(1);
    await act(async () => request.resolve(42));
    await waitFor(() => expect(lite.result.current.data).toBe(42));
    expect(native.result.current.data).toBe(42);
    native.unmount();
    lite.unmount();
    expect(
      client.getQueryCache().find({ queryKey: ["cross-hook-dedupe"] })?.getObserversCount(),
    ).toBe(0);
  });

  it("aborts a consumed signal and restores the previous state on cancelQueries", async () => {
    const client = createClient();
    const queryKey = ["cancel-signal"] as const;
    let signal: AbortSignal | undefined;
    const queryFn = vi.fn(
      ({ signal: requestSignal }: { signal: AbortSignal }) => {
        signal = requestSignal;
        return new Promise<string>((resolve, reject) => {
          requestSignal.addEventListener("abort", () => {
            reject(requestSignal.reason ?? new DOMException("aborted", "AbortError"));
          });
          void resolve;
        });
      },
    );
    const hook = renderHook(
      () => useQueryLite({ queryKey, queryFn, retry: false }),
      { wrapper: provider(client) },
    );
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));
    await act(async () => {
      await client.cancelQueries({ queryKey });
    });
    expect(signal?.aborted).toBe(true);
    await waitFor(() => {
      expect(hook.result.current.fetchStatus).toBe("idle");
      expect(hook.result.current.isFetching).toBe(false);
    });
    expect(client.getQueryCache().find({ queryKey })?.state.fetchStatus).toBe("idle");
  });

  it("preserves canonical nested identities with structural sharing", async () => {
    const client = createClient();
    const first = { nested: { stable: true }, changed: 1 };
    const second = { nested: { stable: true }, changed: 2 };
    const values = [first, second];
    const hook = renderHook(
      () =>
        useQueryLite({
          queryKey: ["structural-sharing"],
          queryFn: async () => values.shift() ?? second,
          structuralSharing: true,
          retry: false,
        }),
      { wrapper: provider(client) },
    );
    await waitFor(() => expect(hook.result.current.data).toBe(first));
    await act(async () => {
      await hook.result.current.refetch();
    });
    expect(hook.result.current.data).toEqual(second);
    expect(hook.result.current.data).not.toBe(first);
    expect(hook.result.current.data?.nested).toBe(first.nested);
  });

  it("rebinds to a native Query recreated with the same hash", async () => {
    const client = createClient();
    const queryKey = ["remove-recreate"] as const;
    client.setQueryData(queryKey, 1);
    const firstQuery = client.getQueryCache().find({ queryKey });
    const hook = renderHook(
      () =>
        useQueryLite({
          queryKey,
          queryFn: async () => 3,
          staleTime: Infinity,
        }),
      { wrapper: provider(client) },
    );
    expect(hook.result.current.data).toBe(1);
    act(() => {
      client.removeQueries({ queryKey });
      client.setQueryData(queryKey, 2);
    });
    await waitFor(() => expect(hook.result.current.data).toBe(2));
    expect(client.getQueryCache().find({ queryKey })).not.toBe(firstQuery);
    expect(client.getQueryCache().find({ queryKey })?.getObserversCount()).toBe(0);
  });
});

describe("query options and result state", () => {
  it("reports optimistic loading state during the first cold render", () => {
    const client = createClient();
    const request = deferred<number>();
    const firstRender: Array<[string, boolean]> = [];
    function View() {
      const result = useQueryLite({
        queryKey: ["optimistic-loading"],
        queryFn: () => request.promise,
        retry: false,
      });
      if (firstRender.length === 0) {
        firstRender.push([result.fetchStatus, result.isLoading]);
      }
      return null;
    }
    render(
      <NativeQueryClientProvider client={client}>
        <View />
      </NativeQueryClientProvider>,
    );
    expect(firstRender).toEqual([["fetching", true]]);
  });

  it("does not report optimistic fetching when subscribed is false", () => {
    const client = createClient();
    const hook = renderHook(
      () =>
        useQueryLite({
          queryKey: ["unsubscribed-result"],
          queryFn: async () => 1,
          subscribed: false,
        }),
      { wrapper: provider(client) },
    );
    expect(hook.result.current.fetchStatus).toBe("idle");
    expect(hook.result.current.isLoading).toBe(false);
  });
  it("supports skipToken and starts after it becomes active", async () => {
    const client = createClient();
    const queryFn = vi.fn(async () => "loaded");
    const hook = renderHook(
      ({ active }) =>
        useQueryLite({
          queryKey: ["skip-token"],
          queryFn: active ? queryFn : skipToken,
          retry: false,
        }),
      { wrapper: provider(client), initialProps: { active: false } },
    );
    expect(hook.result.current.fetchStatus).toBe("idle");
    expect(queryFn).not.toHaveBeenCalled();
    await expect(hook.result.current.refetch()).rejects.toThrow(/Missing queryFn/);
    hook.rerender({ active: true });
    await waitFor(() => expect(hook.result.current.data).toBe("loaded"));
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it("honors enabled and manual refetch", async () => {
    const client = createClient();
    const queryFn = vi.fn(async () => "enabled");
    const hook = renderHook(
      ({ enabled }) =>
        useQueryLite({
          queryKey: ["enabled"],
          queryFn,
          enabled,
          retry: false,
        }),
      { wrapper: provider(client), initialProps: { enabled: false } },
    );
    expect(queryFn).not.toHaveBeenCalled();
    expect(hook.result.current.fetchStatus).toBe("idle");
    await act(async () => {
      await hook.result.current.refetch();
    });
    expect(hook.result.current.data).toBe("enabled");
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it("applies select while keeping raw cache data and reports select errors", async () => {
    const client = createClient();
    const raw = { items: [1, 2, 3] };
    const selected = renderHook(
      () =>
        useQueryLite({
          queryKey: ["select"],
          queryFn: async () => raw,
          select: (value) => value.items.length,
          retry: false,
        }),
      { wrapper: provider(client) },
    );
    await waitFor(() => expect(selected.result.current.data).toBe(3));
    expect(client.getQueryData(["select"])).toBe(raw);

    const selectError = new Error("select failed");
    const errored = renderHook(
      () =>
        useQueryLite({
          queryKey: ["select-error"],
          queryFn: async () => raw,
          select: () => {
            throw selectError;
          },
          retry: false,
        }),
      { wrapper: provider(client) },
    );
    await waitFor(() => expect(errored.result.current.isError).toBe(true));
    expect(errored.result.current.error).toBe(selectError);
    expect(client.getQueryData(["select-error"])).toBe(raw);
  });

  it("distinguishes placeholderData from cache-backed initialData", async () => {
    const client = createClient();
    const placeholderRequest = deferred<string>();
    const placeholder = renderHook(
      () =>
        useQueryLite({
          queryKey: ["placeholder"],
          queryFn: () => placeholderRequest.promise,
          placeholderData: "placeholder",
          retry: false,
        }),
      { wrapper: provider(client) },
    );
    expect(placeholder.result.current.data).toBe("placeholder");
    expect(placeholder.result.current.isPlaceholderData).toBe(true);
    expect(client.getQueryData(["placeholder"])).toBeUndefined();
    await act(async () => placeholderRequest.resolve("actual"));
    await waitFor(() => {
      expect(placeholder.result.current.data).toBe("actual");
      expect(placeholder.result.current.isPlaceholderData).toBe(false);
    });

    const initialQueryFn = vi.fn(async () => "network");
    const initial = renderHook(
      () =>
        useQueryLite({
          queryKey: ["initial-data"],
          queryFn: initialQueryFn,
          initialData: "seed",
          staleTime: Infinity,
        }),
      { wrapper: provider(client) },
    );
    expect(initial.result.current.data).toBe("seed");
    expect(initial.result.current.status).toBe("success");
    expect(client.getQueryData(["initial-data"])).toBe("seed");
    expect(initialQueryFn).not.toHaveBeenCalled();
  });

  it("reports status flags and transitions through refetch", async () => {
    const client = createClient();
    const second = deferred<number>();
    const queryFn = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(1)
      .mockImplementationOnce(() => second.promise);
    const hook = renderHook(
      () => useQueryLite({ queryKey: ["status-refetch"], queryFn, retry: false }),
      { wrapper: provider(client) },
    );
    await waitFor(() => {
      expect(hook.result.current.data).toBe(1);
      expect(hook.result.current.isSuccess).toBe(true);
      expect(hook.result.current.isFetched).toBe(true);
      expect(hook.result.current.fetchStatus).toBe("idle");
    });
    const refetch = hook.result.current.refetch();
    await waitFor(() => expect(hook.result.current.isFetching).toBe(true));
    second.resolve(2);
    await act(async () => {
      await refetch;
    });
    expect(hook.result.current.data).toBe(2);
    expect(hook.result.current.isFetching).toBe(false);
    expect(hook.result.current.isSuccess).toBe(true);
  });

  it("tracks data notifications without rerendering for fetch-only changes", async () => {
    const client = createClient();
    const queryFn = vi.fn(async () => 1);
    let renders = 0;
    function View() {
      renders += 1;
      const result = useQueryLite({
        queryKey: ["notify-tracking"],
        queryFn,
        notifyOnChangeProps: ["data"],
        retry: false,
      });
      return <span data-testid="notify-value">{result.data}</span>;
    }
    render(
      <NativeQueryClientProvider client={client}>
        <View />
      </NativeQueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("notify-value").textContent).toBe("1"));
    const settledRenders = renders;
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["notify-tracking"] });
    });
    expect(queryFn).toHaveBeenCalledTimes(2);
    expect(renders).toBe(settledRenders);
  });

  it("refetches on interval, focus, and reconnect", async () => {
    vi.useFakeTimers();
    const client = createClient();
    const queryFn = vi.fn(async () => queryFn.mock.calls.length);
    const hook = renderHook(
      () =>
        useQueryLite({
          queryKey: ["polling"],
          queryFn,
          refetchInterval: 10,
          refetchOnWindowFocus: true,
          refetchOnReconnect: true,
          retry: false,
        }),
      { wrapper: provider(client) },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(queryFn).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(21);
    });
    expect(queryFn.mock.calls.length).toBeGreaterThan(1);

    focusManager.setFocused(false);
    const beforeFocus = queryFn.mock.calls.length;
    focusManager.setFocused(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(queryFn.mock.calls.length).toBeGreaterThan(beforeFocus);
    onlineManager.setOnline(false);
    const beforeReconnect = queryFn.mock.calls.length;
    onlineManager.setOnline(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(queryFn.mock.calls.length).toBeGreaterThan(beforeReconnect);
    hook.unmount();
  });

  it("does not postpone polling when parent renders repeat", async () => {
    vi.useFakeTimers();
    const client = createClient();
    const queryFn = vi.fn(async () => queryFn.mock.calls.length);
    const hook = renderHook(
      () =>
        useQueryLite({
          queryKey: ["polling-rerenders"],
          queryFn,
          refetchInterval: 20,
          retry: false,
        }),
      { wrapper: provider(client) },
    );
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(queryFn).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 5; index += 1) {
      hook.rerender();
      await act(async () => vi.advanceTimersByTimeAsync(5));
    }
    expect(queryFn.mock.calls.length).toBeGreaterThan(1);
  });

  it("refetches invalidated Lite subscriptions independently of refetchOnMount", async () => {
    const client = createClient();
    const queryFn = vi.fn(async () => queryFn.mock.calls.length);
    const hook = renderHook(
      () =>
        useQueryLite({
          queryKey: ["invalidate-mounted"],
          queryFn,
          refetchOnMount: false,
          retry: false,
        }),
      { wrapper: provider(client) },
    );
    await waitFor(() => expect(hook.result.current.data).toBe(1));
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["invalidate-mounted"] });
    });
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
  });

  it("publishes finite stale-time transitions for single and aggregate hooks", async () => {
    const client = createClient();
    client.setQueryData(["stale-single"], 1);
    client.setQueryData(["stale-aggregate"], 2);
    const single = renderHook(
      () =>
        useQueryLite({
          queryKey: ["stale-single"],
          queryFn: async () => 1,
          staleTime: 20,
          refetchOnMount: false,
        }).isStale,
      { wrapper: provider(client) },
    );
    const aggregate = renderHook(
      () =>
        useQueriesLite({
          queries: [
            {
              queryKey: ["stale-aggregate"],
              queryFn: async () => 2,
              staleTime: 20,
              refetchOnMount: false,
            },
          ],
        })[0].isStale,
      { wrapper: provider(client) },
    );
    expect(single.result.current).toBe(false);
    expect(aggregate.result.current).toBe(false);
    await waitFor(() => {
      expect(single.result.current).toBe(true);
      expect(aggregate.result.current).toBe(true);
    });
  });
});

describe("GC retention around native observers and requests", () => {
  it("retains a Lite query while a native observer remains, then collects it", async () => {
    const client = createClient();
    const queryKey = ["gc-native-observer"] as const;
    const native = renderHook(
      () =>
        useNativeQuery({
          queryKey,
          queryFn: async () => "ready",
          staleTime: Infinity,
          gcTime: 20,
        }),
      { wrapper: provider(client) },
    );
    await waitFor(() => expect(native.result.current.data).toBe("ready"));

    vi.useFakeTimers();
    const lite = renderHook(
      () => useQueryLite({ queryKey, queryFn: async () => "lite", gcTime: 20 }),
      { wrapper: provider(client) },
    );
    lite.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25);
    });
    expect(client.getQueryCache().find({ queryKey })).toBeDefined();
    expect(client.getQueryCache().find({ queryKey })?.getObserversCount()).toBe(1);

    native.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(21);
    });
    expect(client.getQueryCache().find({ queryKey })).toBeUndefined();
  });

  it("does not collect a query while a native fetch request is still running", async () => {
    vi.useFakeTimers();
    const client = createClient();
    const queryKey = ["gc-native-request"] as const;
    const request = deferred<string>();
    const fetch = client.fetchQuery({
      queryKey,
      queryFn: () => request.promise,
      gcTime: 20,
      retry: false,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25);
    });
    const query = client.getQueryCache().find({ queryKey });
    expect(query).toBeDefined();
    expect(query?.state.fetchStatus).toBe("fetching");

    request.resolve("done");
    await act(async () => {
      await fetch;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(21);
    });
    expect(client.getQueryCache().find({ queryKey })).toBeUndefined();
  });
});

describe("useQueries aggregate behavior", () => {
  it("keeps duplicate-key selectors and result state independent", () => {
    const client = createClient();
    const queryKey = ["duplicate-select"] as const;
    client.setQueryData(queryKey, { value: 2 });
    const hook = renderHook(
      () =>
        useQueriesLite({
          queries: [
            { queryKey, queryFn: async () => ({ value: 2 }), select: (data: { value: number }) => data.value },
            { queryKey, queryFn: async () => ({ value: 2 }), select: (data: { value: number }) => `v${data.value}` },
          ],
        }),
      { wrapper: provider(client) },
    );
    expect(hook.result.current[0].data).toBe(2);
    expect(hook.result.current[1].data).toBe("v2");
    act(() => client.setQueryData(queryKey, { value: 3 }));
    expect(hook.result.current[0].data).toBe(3);
    expect(hook.result.current[1].data).toBe("v3");
    expect(client.getQueryCache().find({ queryKey })?.getObserversCount()).toBe(0);
  });

  it("recomputes reused aggregate entries when a new options array changes select", () => {
    const client = createClient();
    const queryKey = ["aggregate-select-change"] as const;
    client.setQueryData(queryKey, { value: 2 });
    const hook = renderHook(
      ({ formatted }) =>
        useQueriesLite({
          queries: [
            {
              queryKey,
              queryFn: async () => ({ value: 2 }),
              select: formatted
                ? (data: { value: number }) => `v${data.value}`
                : (data: { value: number }) => data.value,
            },
          ],
        }),
      { wrapper: provider(client), initialProps: { formatted: false } },
    );
    expect(hook.result.current[0].data).toBe(2);
    hook.rerender({ formatted: true });
    expect(hook.result.current[0].data).toBe("v2");
  });

  it("does not notify an item whose subscribed option is false", () => {
    const client = createClient();
    const queryKey = ["item-unsubscribed"] as const;
    client.setQueryData(queryKey, 1);
    let renders = 0;
    const hook = renderHook(
      () => {
        renders += 1;
        return useQueriesLite({
          queries: [
            {
              queryKey,
              queryFn: async () => 1,
              subscribed: false,
            } as UseQueryOptions<number> & { subscribed: false },
          ],
        })[0].data;
      },
      { wrapper: provider(client) },
    );
    expect(hook.result.current).toBe(1);
    const settledRenders = renders;
    act(() => client.setQueryData(queryKey, 2));
    expect(renders).toBe(settledRenders);
    expect(hook.result.current).toBe(1);
    hook.rerender();
    expect(hook.result.current).toBe(2);
  });

  it("releases aggregate leases and timers when subscribed becomes false", async () => {
    vi.useFakeTimers();
    const client = createClient();
    const queryKey = ["aggregate-unsubscribe"] as const;
    const hook = renderHook(
      ({ subscribed }) =>
        useQueriesLite({
          queries: [{ queryKey, queryFn: async () => 1, gcTime: 0, refetchInterval: 10 }],
          subscribed,
        }),
      { wrapper: provider(client), initialProps: { subscribed: true } },
    );
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(client.getQueryCache().find({ queryKey })).toBeDefined();
    hook.rerender({ subscribed: false });
    await act(async () => vi.advanceTimersByTimeAsync(20));
    expect(client.getQueryCache().find({ queryKey })).toBeUndefined();
  });
  it("updates one key and supports dynamic keys and combine", async () => {
    const client = createClient();
    const firstKey = ["many", "first"] as const;
    const secondKey = ["many", "second"] as const;
    const firstFn = vi.fn(async () => 1);
    const secondFn = vi.fn(async () => "a");
    const combine = (results: readonly { data: unknown }[]) =>
      results.map((result) => result.data);
    const hook = renderHook(
      ({ includeSecond }) => {
        const queries: UseQueryOptions[] = includeSecond
            ? [
                { queryKey: firstKey, queryFn: firstFn, retry: false },
                { queryKey: secondKey, queryFn: secondFn, retry: false },
              ]
            : [{ queryKey: firstKey, queryFn: firstFn, retry: false }];
        return useQueriesLite({
          queries,
          combine,
        });
      },
      { wrapper: provider(client), initialProps: { includeSecond: false } },
    );
    await waitFor(() => expect(hook.result.current).toEqual([1]));
    hook.rerender({ includeSecond: true });
    await waitFor(() => expect(hook.result.current).toEqual([1, "a"]));
    act(() => client.setQueryData(firstKey, 2));
    await waitFor(() => expect(hook.result.current).toEqual([2, "a"]));
    expect(firstFn).toHaveBeenCalledTimes(1);
    expect(secondFn).toHaveBeenCalledTimes(1);
  });

  it("keeps 12,000 aggregate entries observer-free without timer fan-out", async () => {
    vi.useFakeTimers();
    const client = createClient();
    const queries = Array.from({ length: 12_000 }, (_, index) => ({
      queryKey: ["aggregate-12k", index] as const,
      queryFn: skipToken as typeof skipToken,
      gcTime: Infinity,
    }));
    const hook = renderHook(
      () => useQueriesLite({ queries }),
      { wrapper: provider(client) },
    );
    expect(hook.result.current).toHaveLength(12_000);
    const cachedQueries = client
      .getQueryCache()
      .getAll()
      .filter((query) => query.queryKey[0] === "aggregate-12k");
    expect(cachedQueries.every((query) => query.getObserversCount() === 0)).toBe(true);
    expect(vi.getTimerCount()).toBeLessThan(100);
    expect(hook.result.current[0]?.data).toBeUndefined();
    const defaultOptions = vi.spyOn(client, "defaultQueryOptions");
    act(() => client.setQueryData(["aggregate-12k", 0], 1));
    expect(hook.result.current[0]?.data).toBe(1);
    expect(defaultOptions).toHaveBeenCalledTimes(1);
    hook.unmount();
  }, 30_000);
});

describe("suspense, hydration, and render lifecycle", () => {
  it("suspends until data resolves and then exposes a stable result", async () => {
    const client = createClient();
    const request = deferred<string>();
    function View() {
      const result = useSuspenseQueryLite({
        queryKey: ["suspense"],
        queryFn: () => request.promise,
        retry: false,
      });
      return <span data-testid="suspense-value">{result.data}</span>;
    }
    render(
      <NativeQueryClientProvider client={client}>
        <Suspense fallback={<span>loading</span>}>
          <View />
        </Suspense>
      </NativeQueryClientProvider>,
    );
    expect(screen.getByText("loading")).toBeTruthy();
    await act(async () => request.resolve("ready"));
    await waitFor(() => expect(screen.getByTestId("suspense-value").textContent).toBe("ready"));
  });

  it("routes suspense query and query-list failures to an error boundary", async () => {
    const client = createClient();
    const failure = new Error("suspense failed");
    function QueryView() {
      useSuspenseQueryLite({
        queryKey: ["suspense-error"],
        queryFn: async () => {
          throw failure;
        },
        retry: false,
      });
      return null;
    }
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <NativeQueryClientProvider client={client}>
        <ErrorBoundary>
          <Suspense fallback={<span>loading-error</span>}>
            <QueryView />
          </Suspense>
        </ErrorBoundary>
      </NativeQueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("error").textContent).toBe("suspense failed"));
    expect(errorSpy).toHaveBeenCalled();
  });

  it("supports suspense useQueries and native dehydrate/hydrate", async () => {
    const source = createClient();
    const key = ["hydrated"] as const;
    source.setQueryData(key, { value: 7 });
    const snapshot = dehydrate(source);
    const target = createClient();
    hydrate(target, snapshot);

    function View() {
      const results = useSuspenseQueriesLite({
        queries: [
          {
            queryKey: key,
            queryFn: async () => ({ value: 7 }),
            staleTime: Infinity,
          },
          {
            queryKey: ["hydrated-second"],
            queryFn: async () => "second",
            retry: false,
          },
        ],
      });
      return <span data-testid="suspense-list">{`${results[0]?.data.value}:${results[1]?.data}`}</span>;
    }
    render(
      <NativeQueryClientProvider client={target}>
        <Suspense fallback={<span>loading-list</span>}>
          <View />
        </Suspense>
      </NativeQueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("suspense-list").textContent).toBe("7:second"));
    expect(target.getQueryData(key)).toEqual({ value: 7 });
  });

  it("waits for native restoration before starting ordinary queries", async () => {
    const client = createClient();
    const queryFn = vi.fn(async () => "restored");
    let restoring = true;
    function Wrapper({ children }: PropsWithChildren) {
      return (
        <NativeQueryClientProvider client={client}>
          <IsRestoringProvider value={restoring}>{children}</IsRestoringProvider>
        </NativeQueryClientProvider>
      );
    }
    const hook = renderHook(
      () =>
        useQueryLite({
          queryKey: ["restoring"],
          queryFn,
          refetchInterval: 5,
          refetchOnReconnect: "always",
          refetchOnWindowFocus: "always",
          retry: false,
        }),
      { wrapper: Wrapper },
    );
    expect(queryFn).not.toHaveBeenCalled();
    expect(hook.result.current.fetchStatus).toBe("idle");
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    onlineManager.setOnline(false);
    onlineManager.setOnline(true);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(queryFn).not.toHaveBeenCalled();
    restoring = false;
    hook.rerender();
    await waitFor(() => expect(hook.result.current.data).toBe("restored"));
    expect(queryFn.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("overrides disabled and placeholder client defaults for Suspense", async () => {
    const client = createClient({
      defaultOptions: {
        queries: {
          enabled: false,
          placeholderData: "placeholder",
          throwOnError: true,
        },
      },
    });
    function View() {
      const result = useSuspenseQueryLite({
        queryKey: ["suspense-defaults"],
        queryFn: async () => "loaded",
      });
      return <span data-testid="suspense-defaults">{result.data}</span>;
    }
    render(
      <NativeQueryClientProvider client={client}>
        <Suspense fallback={<span>loading-defaults</span>}>
          <View />
        </Suspense>
      </NativeQueryClientProvider>,
    );
    expect(screen.getByText("loading-defaults")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId("suspense-defaults").textContent).toBe("loaded");
    });
  });

  it("keeps Suspense paused without requests during restoration", async () => {
    const client = createClient();
    const queryFn = vi.fn(async () => "ready");
    function View() {
      const result = useSuspenseQueryLite({
        queryKey: ["suspense-restoring"],
        queryFn,
      });
      return <span data-testid="suspense-restoring">{result.data}</span>;
    }
    function App({ restoring }: { restoring: boolean }) {
      return (
        <NativeQueryClientProvider client={client}>
          <IsRestoringProvider value={restoring}>
            <Suspense fallback={<span>restoring-fallback</span>}>
              <View />
            </Suspense>
          </IsRestoringProvider>
        </NativeQueryClientProvider>
      );
    }
    const view = render(<App restoring />);
    expect(screen.getByText("restoring-fallback")).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(queryFn).not.toHaveBeenCalled();
    view.rerender(<App restoring={false} />);
    await waitFor(() => {
      expect(screen.getByTestId("suspense-restoring").textContent).toBe("ready");
    });
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it("does not retain observers or start requests during SSR/no-commit renders", () => {
    const client = createClient();
    const queryKey = ["ssr-no-commit"] as const;
    const queryFn = vi.fn(async () => "should-not-start");
    function View() {
      useQueryLite({ queryKey, queryFn, retry: false });
      return null;
    }
    renderToString(
      <NativeQueryClientProvider client={client}>
        <StrictMode>
          <View />
        </StrictMode>
      </NativeQueryClientProvider>,
    );
    expect(queryFn).not.toHaveBeenCalled();
    expect(client.getQueryCache().find({ queryKey })?.getObserversCount() ?? 0).toBe(0);
  });

  it("keeps StrictMode fetches deduplicated and observer-free", async () => {
    const client = createClient();
    const queryFn = vi.fn(async () => "strict");
    const hook = renderHook(
      () => useQueryLite({ queryKey: ["strict-mode"], queryFn, retry: false }),
      {
        wrapper: ({ children }) => (
          <NativeQueryClientProvider client={client}>
            <StrictMode>{children}</StrictMode>
          </NativeQueryClientProvider>
        ),
      },
    );
    await waitFor(() => expect(hook.result.current.data).toBe("strict"));
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(client.getQueryCache().find({ queryKey: ["strict-mode"] })?.getObserversCount()).toBe(0);
  });
});

describe("production and development diagnostics", () => {
  it("does not warn during a normal development render", async () => {
    const client = createClient();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const hook = renderHook(
      () => useQueryLite({ queryKey: ["warning-free"], queryFn: async () => 1 }),
      { wrapper: provider(client) },
    );
    await waitFor(() => expect(hook.result.current.data).toBe(1));
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns once for an unsupported option in development", async () => {
    const client = createClient();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const options = {
      queryKey: ["unsupported-option"],
      queryFn: async () => 1,
      experimental_prefetchInRender: true,
    };
    const hook = renderHook(() => useQueryLite(options), {
      wrapper: provider(client),
    });
    await waitFor(() => expect(hook.result.current.data).toBe(1));
    hook.rerender();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("warns once when the unsupported result promise is read", () => {
    const client = createClient();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const hook = renderHook(
      () => useQueryLite({ queryKey: ["unsupported-result"], queryFn: async () => 1 }),
      { wrapper: provider(client) },
    );
    void hook.result.current.promise;
    void hook.result.current.promise;
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("promise");
  });
});
