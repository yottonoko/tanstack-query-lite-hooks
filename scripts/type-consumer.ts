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
  useQueryClient,
  useQuery,
  useQueryLite,
  useSuspenseInfiniteQuery,
  useSuspenseInfiniteQueryLite,
  useSuspenseQueries,
  useSuspenseQuery,
  useSuspenseQueryLite,
} from "tanstack-query-lite-hooks";
import {
  QueryClient,
  queryOptions as nativeQueryOptions,
  type DataTag,
  type QueryFunctionContext,
} from "@tanstack/react-query";

type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
  ? true
  : false;
type Assert<Value extends true> = Value;

const nativeOptions = nativeQueryOptions({
  queryKey: ["consumer", 1] as const,
  queryFn: async ({ queryKey, signal, client, meta }) => {
    const _key: readonly ["consumer", 1] = queryKey;
    const _signal: AbortSignal = signal;
    const _client: QueryClient = client;
    const _meta: Record<string, unknown> | undefined = meta;
    void _key;
    void _signal;
    void _client;
    void _meta;
    return queryKey[1];
  },
});
const nativeSelected = nativeQueryOptions({
  queryKey: ["consumer-selected"] as const,
  queryFn: async () => ({ id: 1 }),
  select: (value) => value.id.toString(),
});
const initialData = queryOptions({
  queryKey: ["consumer-initial"] as const,
  queryFn: async () => 2,
  initialData: 0,
});
const taggedKey = ["consumer-tagged"] as const;
const tagged = nativeQueryOptions({
  queryKey: taggedKey as DataTag<typeof taggedKey, { id: number }, Error>,
  queryFn: async () => ({ id: 3 }),
});

const nativeData: number | undefined = useQueryLite(nativeOptions).data;
const selectedData: string | undefined = useQueryLite(nativeSelected).data;
const definedData: number = useQueryLite(initialData).data;
const taggedData: { id: number } | undefined = useQueryLite(tagged).data;
void nativeData;
void selectedData;
void definedData;
void taggedData;

const conditionalOptions = queryOptionsLite({
  queryKey: ["consumer-conditional"] as const,
  queryFn: Math.random() > 0.5 ? async () => 4 : skipTokenLite,
});
const conditionalData: number | undefined = useQueryLite({
  ...conditionalOptions,
  queryFn: Math.random() > 0.5 ? conditionalOptions.queryFn : skipToken,
}).data;
void conditionalData;

const tuple = useQueriesLite({
  queries: [nativeSelected, nativeOptions, tagged] as const,
});
const tupleSelected: string | undefined = tuple[0].data;
const tupleNumber: number | undefined = tuple[1].data;
const tupleTagged: { id: number } | undefined = tuple[2].data;
void tupleSelected;
void tupleNumber;
void tupleTagged;

const combined = useQueriesLite({
  queries: [nativeSelected, nativeOptions] as const,
  combine: (results) => results.map((result) => result.data),
});
const combinedData: (string | number | undefined)[] = combined;
void combinedData;

const suspense = useSuspenseQueryLite(nativeSelected);
const suspenseData: string = suspense.data;
void suspenseData;
const suspenseAliasData: string = useSuspenseQuery(nativeSelected).data;
void suspenseAliasData;

const infinite = infiniteQueryOptions({
  queryKey: ["consumer-infinite"] as const,
  queryFn: async ({ pageParam }: QueryFunctionContext<readonly ["consumer-infinite"], number>) => pageParam,
  initialPageParam: 0,
  getNextPageParam: (lastPage) => lastPage + 1,
});
const infiniteResult = useInfiniteQueryLite(infinite);
const pageData: number[] | undefined = infiniteResult.data?.pages;
const suspenseInfiniteResult = useSuspenseInfiniteQueryLite(infinite);
const suspensePages: number[] = suspenseInfiniteResult.data.pages;
const aliasPageData: number[] | undefined = useInfiniteQuery(infinite).data?.pages;
const aliasSuspensePages: number[] = useSuspenseInfiniteQuery(infinite).data.pages;
void pageData;
void suspensePages;
void aliasPageData;
void aliasSuspensePages;

const liteInfinite = infiniteQueryOptionsLite({
  queryKey: ["consumer-infinite-lite"] as const,
  queryFn: async ({ pageParam }) => pageParam,
  initialPageParam: "first" as string,
  getNextPageParam: (_last, _pages, lastPageParam) => `${lastPageParam}!`,
});
void useInfiniteQueryLite(liteInfinite);
void useQuery(nativeOptions);
void useQueries({ queries: [nativeSelected, nativeOptions] as const });
void useSuspenseQueries({ queries: [nativeSelected] as const });

const client = new QueryClient();
const clientFromHook = useQueryClient(client);
void clientFromHook;

const sameQueryOptions: Assert<Equal<typeof queryOptionsLite, typeof queryOptions>> = true;
const sameInfiniteOptions: Assert<Equal<typeof infiniteQueryOptionsLite, typeof infiniteQueryOptions>> = true;
const sameSkipToken: Assert<Equal<typeof skipTokenLite, typeof skipToken>> = true;
void sameQueryOptions;
void sameInfiniteOptions;
void sameSkipToken;
