# tanstack-query-lite-hooks

`tanstack-query-lite-hooks` は、TanStack Query v5 の `QueryClient`、`QueryCache`、query state をそのまま利用する、observer-free の React hooks package です。TanStack Query の React adapter が各 hook に用意する observer 層を使わず、既存の native cache へ直接購読します。query key、取得中の request、成功 data、`dataUpdatedAt`、invalidate、cancel は native TanStack Query と共有されます。

この package は独立した private package です。npm には publish せず、private GitHub repository から取得して利用します。runtime は ESM の `.mjs` と TypeScript declaration を提供し、CommonJS bundle は生成しません。

## 対応環境

- Node.js 20 以上
- React / React DOM 18.3 以上 20 未満
- TypeScript 7 系（この repository の declaration check は TypeScript 7.0.2）
- `@tanstack/react-query` 5.101.x（peer range は `>=5.101.0 <5.102.0`）
- ESM を読み込める bundler または runtime

## インストール

private repository を読める GitHub 認証を設定したうえで、利用側の project から install します。

```sh
pnpm add "github:yottonoko/tanstack-query-lite-hooks#main"
pnpm add "@tanstack/react-query@5.101.x" react react-dom
```

GitHub の SSH 認証を使う場合は、次の形式も利用できます。

```sh
pnpm add "git+ssh://git@github.com/yottonoko/tanstack-query-lite-hooks.git#main"
```

private package のため、CI では package install の前に read-only repository token または deploy key を設定してください。npm registry への publish を前提にした設定はありません。

## 最小例

Lite は独自の `QueryClient` や `QueryClientProvider` を作りません。必ず native TanStack Query の client と provider を一つ設置し、その Context の下で Lite hook を呼び出します。

```tsx
import {
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query'
import {
  useQueryLite,
} from 'tanstack-query-lite-hooks'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
})

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Todos />
    </QueryClientProvider>
  )
}

function Todos() {
  const todos = useQueryLite({
    queryKey: ['todos'],
    queryFn: async ({ signal }) => {
      const response = await fetch('/api/todos', { signal })
      if (!response.ok) throw new Error('Failed to load todos')
      return response.json() as Promise<Array<{ id: number; title: string }>>
    },
  })

  if (todos.isPending) return <p>Loading...</p>
  if (todos.isError) return <p>{todos.error.message}</p>
  return (
    <ul>
      {todos.data?.map((todo) => <li key={todo.id}>{todo.title}</li>)}
    </ul>
  )
}
```

## Native API と同じ画面で使う

Native hook と Lite hook は同じ provider、client、query key を使えます。canonical name は `Lite` suffix 付きです。名前の衝突を避けたい場合や、native hook と比較する場合は suffix 付きのまま import してください。

```tsx
import {
  QueryClient,
  QueryClientProvider,
  queryOptions,
  useQuery as useNativeQuery,
} from '@tanstack/react-query'
import {
  useQueryLite,
  useQueriesLite,
} from 'tanstack-query-lite-hooks'

const client = new QueryClient()
const userOptions = queryOptions({
  queryKey: ['user', 42] as const,
  queryFn: async ({ signal }) => fetchUser(42, signal),
})

function Screen() {
  const native = useNativeQuery(userOptions)
  const lite = useQueryLite(userOptions)
  const rows = useQueriesLite({ queries: [userOptions] })
  return <pre>{JSON.stringify({ native: native.data, lite: lite.data, rows: rows[0]?.data })}</pre>
}

export function Root() {
  return (
    <QueryClientProvider client={client}>
      <Screen />
    </QueryClientProvider>
  )
}
```

`useQueryLite` と `useQuery`、`useQueriesLite` と `useQueries` などの unsuffixed alias は同じ runtime value identity を持ちます。alias は別 client、別 cache、別 provider、別 observer を作りません。native API と同じ名前を使う場合でも、native import と Lite import の source を明示しておくと移行時の混同を避けられます。

主な canonical names は次のとおりです。

| Lite canonical name | 同一 identity の alias |
| --- | --- |
| `useQueryLite` | `useQuery` |
| `useQueriesLite` | `useQueries` |
| `useQueryClientLite` | `useQueryClient` |
| `useSuspenseQueryLite` | `useSuspenseQuery` |
| `useSuspenseQueriesLite` | `useSuspenseQueries` |
| `queryOptionsLite` | `queryOptions` |
| `useInfiniteQueryLite` | `useInfiniteQuery` |
| `useSuspenseInfiniteQueryLite` | `useSuspenseInfiniteQuery` |
| `infiniteQueryOptionsLite` | `infiniteQueryOptions` |
| `skipTokenLite` | `skipToken` |

Infinite Query、options helper、`skipToken` は root entrypoint から export されます。`Lite` suffix 付きの名前は package 側の canonical name、unsuffixed name は同じ value identity の alias です。native の `queryOptions`、`infiniteQueryOptions`、`skipToken` も Lite hook の入力として利用できます。

## Native QueryCache と state の共有

Lite は cache の複製を作りません。native client の `getQueryCache()` が返す real `QueryCache` と、その query の state を読み書きします。

```ts
const query = queryClient.getQueryCache().find({ queryKey: ['todos'] })
const data = queryClient.getQueryData<Todo[]>(['todos'])

queryClient.setQueryData(['todos'], (previous: Todo[] | undefined) => [
  ...(previous ?? []),
  { id: 3, title: 'new todo' },
])
```

native hook が取得した data を Lite hook が読めます。逆方向も同じです。in-flight request の deduplication、`AbortSignal`、retry、invalidate、`setQueryData`、`dataUpdatedAt` は native QueryClient の state machine に従います。

ただし Lite の購読は TanStack Query の `QueryObserver` として登録されません。そのため native の observer 数、Devtools の active 表示、active query 判定は native observer だけを対象にします。LiteHub は Lite subscription の lease と GC を独自に管理するため、native observer の数と Lite query の保持状態は一致しません。詳細な互換性と GC の差は [compatibility](docs/compatibility.md) を参照してください。

## `queryOptions`、`infiniteQueryOptions`、`skipToken`

native helper の戻り値はそのまま Lite hook に渡せます。TypeScript 7 の const type parameter と TanStack Query の DataTag を維持するため、options を共有する時も native helper を利用してください。

```tsx
import { queryOptions, skipToken } from '@tanstack/react-query'
import {
  queryOptionsLite,
  skipTokenLite,
  useQueryLite,
} from 'tanstack-query-lite-hooks'

const userOptions = queryOptions({
  queryKey: ['user', userId] as const,
  queryFn: userId === undefined
    ? skipTokenLite
    : ({ signal }) => fetchUser(userId, signal),
})

const user = useQueryLite(userOptions)
```

`queryOptionsLite` と `queryOptions` は同じ options value を返します。`skipTokenLite` と `skipToken` も package 内で同じ value identity を持ち、native `skipToken` は入力として認識されます。無効中は automatic fetch を行いません。Lite result の `refetch()` を明示的に呼ぶと、有効な query function がないことを示す Promise rejection を返します。この点は error result を返す native observer の細部とは異なります。Suspense hook と `skipToken` を組み合わせることはできません。

## Cancellation

query function には native QueryClient が管理する `AbortSignal` が渡されます。`fetch` など対応する client へ必ず signal を渡してください。

```tsx
useQueryLite({
  queryKey: ['search', keyword],
  queryFn: ({ signal }) => searchApi(keyword, { signal }),
})

await queryClient.cancelQueries({ queryKey: ['search', keyword] })
```

Lite が native observer を増やさないことから、Lite-only component の unmount を native observer の unmount と同一視しないでください。LiteHub は購読中の query を独自 lease で保持しますが、request の中止は native QueryClient の state と native observer の有無に従います。明示的な cancel が必要な request は `cancelQueries` を利用します。

## Suspense

`useSuspenseQueryLite` と `useSuspenseQueriesLite` は native Query state にある pending Promise を Suspense boundary へ渡し、取得後の data 型に不要な `undefined` を付加しません。

```tsx
import { Suspense } from 'react'
import { useSuspenseQueryLite } from 'tanstack-query-lite-hooks'

function Profile() {
  const profile = useSuspenseQueryLite({
    queryKey: ['profile'],
    queryFn: fetchProfile,
  })
  return <h1>{profile.data.name}</h1>
}

export function ProfileBoundary() {
  return (
    <Suspense fallback={<p>Loading...</p>}>
      <Profile />
    </Suspense>
  )
}
```

Suspense tree が commit される前に始まった request の扱いは native QueryClient の lifecycle に従います。fallback の unmount だけで request が必ず cancel されるとは限りません。

## SSR と hydration

SSR では Lite 独自の snapshot protocol を使わず、TanStack Query の native `dehydrate`、`hydrate`、`HydrationBoundary` を利用します。server/client で同じ native QueryClient を構成し、Lite は hydration 済みの state をそのまま読みます。

```tsx
// server
import { dehydrate, QueryClient } from '@tanstack/react-query'

const serverClient = new QueryClient()
await serverClient.prefetchQuery(userOptions)
const dehydratedState = dehydrate(serverClient)

// client
import {
  HydrationBoundary,
  QueryClientProvider,
} from '@tanstack/react-query'

<QueryClientProvider client={client}>
  <HydrationBoundary state={dehydratedState}>
    <Screen />
  </HydrationBoundary>
</QueryClientProvider>
```

独自の hydration entrypoint、独自 provider、独自 client を追加する必要はありません。native の serialize/filter/error 方針をそのまま適用できます。

## Infinite Query

Infinite Query は native `infiniteQueryOptions()` の戻り値を受け取り、native QueryCache の Infinite Query state を共有します。

```tsx
import {
  infiniteQueryOptions,
} from '@tanstack/react-query'
import {
  infiniteQueryOptionsLite,
  useInfiniteQueryLite,
} from 'tanstack-query-lite-hooks'

const feedOptions = infiniteQueryOptionsLite(infiniteQueryOptions({
  queryKey: ['feed'],
  queryFn: ({ pageParam, signal }) => fetchFeed(pageParam, signal),
  initialPageParam: 0,
  getNextPageParam: (lastPage) => lastPage.nextCursor,
}))

function Feed() {
  const feed = useInfiniteQueryLite(feedOptions)
  return <button onClick={() => feed.fetchNextPage()}>Next</button>
}
```

通常 query と Infinite Query は native と同じ query key を共有できません。query shape の衝突を避けるため key を分けてください。`fetchNextPage`、`fetchPreviousPage`、`maxPages`、Infinite Query の Suspense 版の対応範囲は [API reference](docs/api.md) にまとめています。

## Structural sharing

structural sharing は native QueryClient の option と query option を使います。`true` または custom function を指定すると、native と Lite が同じ canonical data reference を観測できます。Lite 側で別の deep clone や別の structural sharing を実行しません。

```tsx
useQueryLite({
  queryKey: ['settings'],
  queryFn: fetchSettings,
  structuralSharing: true,
})
```

構造共有の traversal cost は、変更されていない枝を再利用する利益と合わせて評価してください。既定値や custom resolver の挙動は TanStack Query 5.101.x の仕様に合わせます。

## React Compiler

public hook は React Rules of Hooks と pure render を前提にしています。React Compiler を有効にした application でも利用できます。mutable external-store runtime を保持する package 内部の hook には公式 escape hatch の `"use no memo"` を付け、利用側 component の自動 memo 化からだけ境界を分離しています。package の build check は `panicThreshold: 'all_errors'` でこの境界が Compiler に受理されることを検査します。利用側で hook の呼び出しを条件分岐したり、query result を render 中に mutate したりしないでください。

## 開発時の warning

Lite が意味を保てない native option や result field を受け取った場合、development build では対象名を含む warning を一度だけ出します。現在は、指定しても通常 query の render 中 fetch を有効にしない `experimental_prefetchInRender` と、native の experimental stable-promise 契約を保証しない result の `promise` が対象です。`promise` は読み取った時点で warning します。`combine`、`notifyOnChangeProps`、`subscribed`、`throwOnError`、`networkMode` など対応する native option はそのまま利用できます。production build では warning を抑制します。

対応範囲と未対応項目は [compatibility](docs/compatibility.md) に記載しています。native helper が返す options の型を利用しつつ、実行時の warning も確認してください。

## 明確な非対応範囲

- `QueryObserver`、`InfiniteQueryObserver` などの observer class は提供しません
- mutation hook は提供しません。mutation は native `useMutation` を利用してください
- Lite 独自の `QueryClient`、`QueryClientProvider`、Context は提供しません
- Lite の subscription は TanStack Query の active observer として数えられません
- Devtools の active 表示、observer count、active-only の type semantics は native observer のみを対象にします
- native QueryCache の observer-based GC と LiteHub の subscription-based GC は同一ではありません

既存 application の query の一部だけを Lite へ移し、mutation、Devtools、observer API、SSR は native API のまま維持できます。

## 性能 benchmark

production Vite bundle と Headless Chromium を使う opt-in benchmark を `benchmarks/` に収録しています。1,000件の shared/distinct query、10,000/20,000件の preseeded `useQueries`、fetch deduplication、rotating order、fresh context + CDP GC の memory benchmarkを測定します。

```sh
pnpm bench:compare
pnpm bench:memory
```

長時間 benchmark は通常の check に含めません。測定条件と acceptance は [performance](docs/performance.md)、実行手順は [development](docs/development.md) を参照してください。

## ドキュメント

- [API reference](docs/api.md)
- [Compatibility and limitations](docs/compatibility.md)
- [Performance methodology](docs/performance.md)
- [Development and verification](docs/development.md)
