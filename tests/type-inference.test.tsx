import { queryOptions as nativeQueryOptions, type DataTag } from "@tanstack/react-query";
import { describe, expectTypeOf, it } from "vitest";
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
  useQueryLite,
  useSuspenseInfiniteQuery,
  useSuspenseInfiniteQueryLite,
  useSuspenseQuery,
  useSuspenseQueryLite,
} from "../src/index.js";
import { useInfiniteQuery as nativeUseInfiniteQuery } from "@tanstack/react-query";

class DomainError extends Error {
  readonly code = "DOMAIN" as const;
}

function assertQueryOptionInference() {
  const contextOptions = queryOptions({
    queryKey: ["context", 7] as const,
    queryFn: async ({ queryKey, signal, client, meta }) => {
      expectTypeOf(queryKey).toEqualTypeOf<readonly ["context", 7]>();
      expectTypeOf(signal).toEqualTypeOf<AbortSignal>();
      expectTypeOf(client).toMatchTypeOf<import("@tanstack/react-query").QueryClient>();
      expectTypeOf(meta).toEqualTypeOf<Record<string, unknown> | undefined>();
      return { id: queryKey[1] };
    },
  });
  expectTypeOf(useQueryLite(contextOptions).data).toEqualTypeOf<{ id: 7 } | undefined>();
  expectTypeOf(useQuery(contextOptions).data).toEqualTypeOf<{ id: 7 } | undefined>();

  const selected = queryOptions({
    queryKey: ["select", 1] as const,
    queryFn: async () => ({ id: 1, name: "Ada" }),
    select: (value) => value.name,
  });
  expectTypeOf(useQueryLite(selected).data).toEqualTypeOf<string | undefined>();

  const customError = queryOptions<number, DomainError>({
    queryKey: ["custom-error"] as const,
    queryFn: async () => 1,
  });
  expectTypeOf(useQueryLite(customError).error).toEqualTypeOf<DomainError | null>();

  const initial = queryOptions({
    queryKey: ["defined-initial"] as const,
    queryFn: async () => 1,
    initialData: 0,
  });
  expectTypeOf(useQueryLite(initial).data).toEqualTypeOf<number>();

  const enabledBySentinel = queryOptions({
    queryKey: ["conditional"] as const,
    queryFn: Math.random() > 0.5 ? async () => 2 : skipToken,
  });
  expectTypeOf(useQueryLite(enabledBySentinel).data).toEqualTypeOf<number | undefined>();
  const enabledBySentinelLite = queryOptionsLite({
    queryKey: ["conditional-lite"] as const,
    queryFn: Math.random() > 0.5 ? async () => 3 : skipTokenLite,
  });
  expectTypeOf(useQueryLite(enabledBySentinelLite).data).toEqualTypeOf<number | undefined>();

  const taggedKey = ["tagged"] as const;
  const tagged = nativeQueryOptions({
    queryKey: taggedKey as DataTag<typeof taggedKey, { id: number }, DomainError>,
    queryFn: async () => ({ id: 4 }),
  });
  expectTypeOf(useQueryLite(tagged).data).toEqualTypeOf<{ id: number } | undefined>();
  expectTypeOf(useQueryLite(tagged).error).toEqualTypeOf<Error | null>();

  const heterogeneous = useQueriesLite({
    queries: [selected, contextOptions, customError] as const,
  });
  expectTypeOf(heterogeneous[0].data).toEqualTypeOf<string | undefined>();
  expectTypeOf(heterogeneous[1].data).toEqualTypeOf<{ id: 7 } | undefined>();
  expectTypeOf(heterogeneous[2].data).toEqualTypeOf<number | undefined>();
  expectTypeOf(heterogeneous[2].error).toEqualTypeOf<DomainError | null>();

  const combined = useQueriesLite({
    queries: [selected, contextOptions] as const,
    combine: (results) => results.map((result) => result.data),
  });
  expectTypeOf(combined).toEqualTypeOf<(string | { id: 7 } | undefined)[]>();

  const suspense = queryOptions({
    queryKey: ["suspense"] as const,
    queryFn: async () => "ready" as const,
  });
  expectTypeOf(useSuspenseQueryLite(suspense).data).toEqualTypeOf<"ready">();
  expectTypeOf(useSuspenseQuery(suspense).data).toEqualTypeOf<"ready">();
}

function assertInfiniteInference() {
  const options = infiniteQueryOptions({
    queryKey: ["infinite", "types"] as const,
    queryFn: async ({ pageParam }) => {
      expectTypeOf(pageParam).toEqualTypeOf<number>();
      return pageParam;
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, _pages, lastPageParam) => {
      expectTypeOf(lastPage).toEqualTypeOf<number>();
      expectTypeOf(lastPageParam).toEqualTypeOf<number>();
      return lastPage + 1;
    },
    getPreviousPageParam: (firstPage, _pages, firstPageParam) => {
      expectTypeOf(firstPage).toEqualTypeOf<number>();
      expectTypeOf(firstPageParam).toEqualTypeOf<number>();
      return firstPage - 1;
    },
  });
  expectTypeOf(useInfiniteQueryLite(options).data?.pages).toEqualTypeOf<number[] | undefined>();
  expectTypeOf(useSuspenseInfiniteQueryLite(options).data.pages).toEqualTypeOf<number[]>();
  expectTypeOf(useInfiniteQuery(options).data?.pages).toEqualTypeOf<number[] | undefined>();
  expectTypeOf(useSuspenseInfiniteQuery(options).data.pages).toEqualTypeOf<number[]>();

  const liteOptions = infiniteQueryOptionsLite({
    queryKey: ["infinite-lite"] as const,
    queryFn: async ({ pageParam }) => pageParam,
    initialPageParam: "first" as string,
    getNextPageParam: (_last, _pages, lastPageParam) => `${lastPageParam}!`,
  });
  const liteInfiniteResult = useInfiniteQueryLite(liteOptions);
  const nativeInfiniteResult = nativeUseInfiniteQuery(liteOptions);
  expectTypeOf(liteInfiniteResult.data?.pageParams).toEqualTypeOf(
    nativeInfiniteResult.data?.pageParams,
  );

  expectTypeOf<typeof useQueryLite>().toEqualTypeOf<typeof useQuery>();
  expectTypeOf<typeof useQueriesLite>().toEqualTypeOf<typeof useQueries>();
  expectTypeOf<typeof useSuspenseQueryLite>().toEqualTypeOf<typeof useSuspenseQuery>();
  expectTypeOf<typeof useInfiniteQueryLite>().toEqualTypeOf<typeof useInfiniteQuery>();
  expectTypeOf<typeof useSuspenseInfiniteQueryLite>().toEqualTypeOf<typeof useSuspenseInfiniteQuery>();
  expectTypeOf<typeof queryOptionsLite>().toEqualTypeOf<typeof queryOptions>();
  expectTypeOf<typeof infiniteQueryOptionsLite>().toEqualTypeOf<typeof infiniteQueryOptions>();
}

describe("public TypeScript inference", () => {
  it("preserves query data, error, select, context, and tuple types", () => {
    expectTypeOf(assertQueryOptionInference).toBeFunction();
  });

  it("preserves Infinite Query page and pageParam types", () => {
    expectTypeOf(assertInfiniteInference).toBeFunction();
  });
});
