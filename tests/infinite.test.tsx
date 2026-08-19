import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import {
  focusManager,
  IsRestoringProvider,
  onlineManager,
  QueryClient as NativeQueryClient,
  QueryClientProvider as NativeQueryClientProvider,
} from "@tanstack/react-query";
import { Suspense, type PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  infiniteQueryOptions,
  infiniteQueryOptionsLite,
  useInfiniteQuery,
  useInfiniteQueryLite,
  useSuspenseInfiniteQuery,
  useSuspenseInfiniteQueryLite,
} from "../src/index.js";

const clients = new Set<NativeQueryClient>();

function createClient() {
  const client = new NativeQueryClient();
  clients.add(client);
  return client;
}

function provider(client: NativeQueryClient) {
  return function Provider({ children }: PropsWithChildren) {
    return <NativeQueryClientProvider client={client}>{children}</NativeQueryClientProvider>;
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

afterEach(() => {
  for (const client of clients) {
    client.clear();
    client.unmount();
  }
  clients.clear();
  focusManager.setFocused(true);
  onlineManager.setOnline(true);
  vi.useRealTimers();
});

describe("infinite query public API", () => {
  it("keeps Infinite Query aliases and options identity", () => {
    expect(useInfiniteQueryLite).toBe(useInfiniteQuery);
    expect(useSuspenseInfiniteQueryLite).toBe(useSuspenseInfiniteQuery);
    expect(infiniteQueryOptionsLite).toBe(infiniteQueryOptions);
  });

  it("reports optimistic loading state during the first cold render", async () => {
    const client = createClient();
    const request = deferred<number>();
    const hook = renderHook(
      () =>
        useInfiniteQueryLite({
          queryKey: ["infinite-optimistic-loading"],
          queryFn: () => request.promise,
          initialPageParam: 0,
          getNextPageParam: () => undefined,
          retry: false,
        }),
      { wrapper: provider(client) },
    );
    expect(hook.result.current.status).toBe("pending");
    expect(hook.result.current.fetchStatus).toBe("fetching");
    expect(hook.result.current.isLoading).toBe(true);
    expect(hook.result.current.isFetching).toBe(true);
    await act(async () => request.resolve(0));
    await waitFor(() => expect(hook.result.current.data?.pages).toEqual([0]));
  });

  it("recomputes cached Infinite data when select changes", () => {
    const client = createClient();
    const queryKey = ["infinite-select-change"] as const;
    client.setQueryData(queryKey, {
      pages: [{ value: 3 }],
      pageParams: [0],
    });
    const hook = renderHook(
      ({ formatted }) =>
        useInfiniteQueryLite({
          queryKey,
          queryFn: async () => ({ value: 3 }),
          initialPageParam: 0,
          getNextPageParam: () => undefined,
          staleTime: Infinity,
          select: formatted
            ? (data) => `v${data.pages[0]!.value}`
            : (data) => String(data.pages[0]!.value),
        }),
      { wrapper: provider(client), initialProps: { formatted: false } },
    );
    expect(hook.result.current.data).toBe("3");
    hook.rerender({ formatted: true });
    expect(hook.result.current.data).toBe("v3");
  });

  it("fetches initial, next, and previous pages while enforcing maxPages", async () => {
    const client = createClient();
    const options = infiniteQueryOptions({
      queryKey: ["infinite-pages"] as const,
      queryFn: async ({ pageParam }: { pageParam: number }) => pageParam,
      initialPageParam: 0,
      getNextPageParam: (lastPage: number) => (lastPage < 3 ? lastPage + 1 : undefined),
      getPreviousPageParam: (firstPage: number) => (firstPage > -2 ? firstPage - 1 : undefined),
      maxPages: 2,
      retry: false,
    });
    const hook = renderHook(() => useInfiniteQueryLite(options), {
      wrapper: provider(client),
    });

    await waitFor(() => {
      expect(hook.result.current.data?.pages).toEqual([0]);
      expect(hook.result.current.hasNextPage).toBe(true);
      expect(hook.result.current.hasPreviousPage).toBe(true);
    });
    await act(async () => {
      await hook.result.current.fetchNextPage();
    });
    expect(hook.result.current.data?.pages).toEqual([0, 1]);
    expect(hook.result.current.isFetchingNextPage).toBe(false);
    await act(async () => {
      await hook.result.current.fetchPreviousPage();
    });
    expect(hook.result.current.data?.pages).toEqual([-1, 0]);
    expect(hook.result.current.data?.pages).toHaveLength(2);
    expect(hook.result.current.data?.pageParams).toEqual([-1, 0]);
    expect(hook.result.current.hasPreviousPage).toBe(true);
  });

  it("deduplicates next-page work and restores pages when cancellation aborts signal", async () => {
    const client = createClient();
    let nextSignal: AbortSignal | undefined;
    const nextRequest = deferred<number>();
    const queryFn = vi.fn(({ pageParam, signal }: { pageParam: number; signal: AbortSignal }) => {
      if (pageParam === 0) return Promise.resolve(0);
      nextSignal = signal;
      signal.addEventListener("abort", () => {
        nextRequest.reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      });
      return nextRequest.promise;
    });
    const options = {
      queryKey: ["infinite-cancel"] as const,
      queryFn,
      initialPageParam: 0,
      getNextPageParam: (lastPage: number) => lastPage + 1,
      retry: false,
    };
    const hook = renderHook(() => useInfiniteQueryLite(options), {
      wrapper: provider(client),
    });
    await waitFor(() => expect(hook.result.current.data?.pages).toEqual([0]));
    const next = hook.result.current.fetchNextPage();
    await waitFor(() => expect(nextSignal).toBeDefined());
    await act(async () => {
      await client.cancelQueries({ queryKey: ["infinite-cancel"] });
    });
    expect(nextSignal?.aborted).toBe(true);
    await act(async () => {
      await next.catch(() => undefined);
    });
    expect(hook.result.current.data?.pages).toEqual([0]);
    expect(hook.result.current.isFetchingNextPage).toBe(false);
  });

  it("does not refetch for inline queryFn identity changes and responds to invalidation", async () => {
    const client = createClient();
    const queryKey = ["infinite-inline"] as const;
    const source = vi.fn(async (pageParam: number) => pageParam);
    const hook = renderHook(
      () =>
        useInfiniteQueryLite({
          queryKey,
          queryFn: ({ pageParam }) => source(pageParam),
          initialPageParam: 0,
          getNextPageParam: (lastPage) => lastPage + 1,
          retry: false,
        }),
      { wrapper: provider(client) },
    );
    await waitFor(() => expect(hook.result.current.data?.pages).toEqual([0]));
    expect(source).toHaveBeenCalledTimes(1);
    await act(async () => {
      await client.invalidateQueries({ queryKey });
    });
    await waitFor(() => expect(source).toHaveBeenCalledTimes(2));
  });

  it("rebinds after the native infinite Query is removed and recreated", async () => {
    const client = createClient();
    const queryKey = ["infinite-recreate"] as const;
    const options = {
      queryKey,
      queryFn: async ({ pageParam }: { pageParam: number }) => pageParam,
      initialPageParam: 0,
      getNextPageParam: (lastPage: number) => lastPage + 1,
      staleTime: Infinity,
    };
    const hook = renderHook(() => useInfiniteQueryLite(options), {
      wrapper: provider(client),
    });
    await waitFor(() => expect(hook.result.current.data?.pages).toEqual([0]));
    act(() => {
      client.removeQueries({ queryKey });
      client.setQueryData(queryKey, { pages: [9], pageParams: [9] });
    });
    await waitFor(() => expect(hook.result.current.data?.pages).toEqual([9]));
    expect(client.getQueryCache().find({ queryKey })?.getObserversCount()).toBe(0);
  });

  it("honors notifyOnChangeProps for fetch-status-only infinite updates", async () => {
    const client = createClient();
    const next = deferred<number>();
    let renders = 0;
    function View() {
      renders += 1;
      const result = useInfiniteQueryLite({
        queryKey: ["infinite-notify"],
        queryFn: ({ pageParam }: { pageParam: number }) =>
          pageParam === 0 ? Promise.resolve(0) : next.promise,
        initialPageParam: 0,
        getNextPageParam: (lastPage) => lastPage + 1,
        notifyOnChangeProps: ["data"],
      });
      return <button onClick={() => void result.fetchNextPage()}>{result.data?.pages.join(",")}</button>;
    }
    const view = render(<NativeQueryClientProvider client={client}><View /></NativeQueryClientProvider>);
    await waitFor(() => expect(view.getByRole("button").textContent).toBe("0"));
    const settledRenders = renders;
    act(() => view.getByRole("button").click());
    await Promise.resolve();
    expect(renders).toBe(settledRenders);
    await act(async () => next.resolve(1));
    await waitFor(() => expect(view.getByRole("button").textContent).toBe("0,1"));
    expect(renders).toBeGreaterThan(settledRenders);
  });

  it("suppresses Infinite polling and environment requests while restoring", async () => {
    vi.useFakeTimers();
    const client = createClient();
    const queryFn = vi.fn(async ({ pageParam }: { pageParam: number }) => pageParam);
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
        useInfiniteQueryLite({
          queryKey: ["infinite-restoring"],
          queryFn,
          initialPageParam: 0,
          getNextPageParam: (lastPage) => lastPage + 1,
          refetchInterval: 5,
          refetchOnReconnect: "always",
          refetchOnWindowFocus: "always",
        }),
      { wrapper: Wrapper },
    );
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    onlineManager.setOnline(false);
    onlineManager.setOnline(true);
    await act(async () => vi.advanceTimersByTimeAsync(20));
    expect(queryFn).not.toHaveBeenCalled();
    restoring = false;
    hook.rerender();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(queryFn).toHaveBeenCalled();
  });

  it("keeps Suspense Infinite paused without requests during restoration", async () => {
    const client = createClient();
    const queryFn = vi.fn(async ({ pageParam }: { pageParam: number }) => pageParam);
    function View() {
      const result = useSuspenseInfiniteQueryLite({
        queryKey: ["suspense-infinite-restoring"],
        queryFn,
        initialPageParam: 0,
        getNextPageParam: (lastPage) => lastPage + 1,
      });
      return <span data-testid="suspense-infinite-restoring">{result.data.pages.join(",")}</span>;
    }
    function App({ restoring }: { restoring: boolean }) {
      return (
        <NativeQueryClientProvider client={client}>
          <IsRestoringProvider value={restoring}>
            <Suspense fallback={<span>infinite-restoring-fallback</span>}>
              <View />
            </Suspense>
          </IsRestoringProvider>
        </NativeQueryClientProvider>
      );
    }
    const view = render(<App restoring />);
    expect(screen.getByText("infinite-restoring-fallback")).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(queryFn).not.toHaveBeenCalled();
    view.rerender(<App restoring={false} />);
    await waitFor(() => {
      expect(screen.getByTestId("suspense-infinite-restoring").textContent).toBe("0");
    });
  });

  it("suspends for an Infinite Query and returns page data after resolve", async () => {
    const client = createClient();
    let resolve!: (value: number) => void;
    const request = new Promise<number>((resolvePromise) => {
      resolve = resolvePromise;
    });
    function View() {
      const result = useSuspenseInfiniteQueryLite({
        queryKey: ["suspense-infinite"],
        queryFn: () => request,
        initialPageParam: 1,
        getNextPageParam: () => undefined,
        retry: false,
      });
      return <span data-testid="infinite-value">{result.data.pages[0]}</span>;
    }
    render(
      <NativeQueryClientProvider client={client}>
        <Suspense fallback={<span>infinite-loading</span>}>
          <View />
        </Suspense>
      </NativeQueryClientProvider>,
    );
    expect(screen.getByText("infinite-loading")).toBeTruthy();
    await act(async () => resolve(1));
    await waitFor(() => expect(screen.getByTestId("infinite-value").textContent).toBe("1"));
  });
});
