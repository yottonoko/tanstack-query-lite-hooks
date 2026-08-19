# API reference

この package は native TanStack Query の React Context と `QueryClient` を利用します。root entrypoint に Lite hook と同一 identity の unsuffixed aliasを公開し、`@tanstack/react-query` の object、cache、result type と組み合わせて使います。

## Import 表

| 目的 | import 元 | 主な export |
| --- | --- | --- |
| 通常 query | `tanstack-query-lite-hooks` | `useQueryLite` / `useQuery`, `useQueriesLite` / `useQueries` |
| Suspense query | `tanstack-query-lite-hooks` | `useSuspenseQueryLite` / `useSuspenseQuery`, `useSuspenseQueriesLite` / `useSuspenseQueries` |
| client 解決 | `tanstack-query-lite-hooks` | `useQueryClientLite` / `useQueryClient` |
| Infinite Query | `tanstack-query-lite-hooks` | `useInfiniteQueryLite` / `useInfiniteQuery`, `useSuspenseInfiniteQueryLite` / `useSuspenseInfiniteQuery` |
| Lite options helper | `tanstack-query-lite-hooks` | `queryOptionsLite` / `queryOptions`, `infiniteQueryOptionsLite` / `infiniteQueryOptions`, `skipTokenLite` / `skipToken` |
| native options | `@tanstack/react-query` | `queryOptions`, `infiniteQueryOptions`, `skipToken` |
| native client/provider | `@tanstack/react-query` | `QueryClient`, `QueryClientProvider` |
| SSR | `@tanstack/react-query` | `dehydrate`, `hydrate`, `HydrationBoundary` |

同じ項目にある二つの名前は別実装ではありません。たとえば `useQuery === useQueryLite`、`useQueries === useQueriesLite` が成立します。native API と名前を並べる必要がない場合も、canonical name の `Lite` suffix を使用すると source code 上の境界が明確になります。

## Provider と QueryClient

Lite は `QueryClient`、`QueryClientProvider`、Context を作りません。native の provider を application scope に一つ設置します。

```tsx
import {
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query'
import { useQueryLite } from 'tanstack-query-lite-hooks'

const client = new QueryClient()

export function Root() {
  return (
    <QueryClientProvider client={client}>
      <TodoScreen />
    </QueryClientProvider>
  )
}

function TodoScreen() {
  const query = useQueryLite({
    queryKey: ['todos'],
    queryFn: fetchTodos,
  })
  return <pre>{JSON.stringify(query.data)}</pre>
}
```

provider がない場合は native hook と同じく client を解決できません。複数 client を使う場合も native provider の nesting と Context 解決規則に従います。

`useQueryClientLite`（alias: `useQueryClient`）は、最寄りの native `QueryClientProvider` が持つ client を返します。明示 client を渡した場合は provider より優先し、返却値の型と object identity は native `QueryClient` と同じです。

```tsx
import { useQueryClientLite } from 'tanstack-query-lite-hooks'

function RefreshButton() {
  const client = useQueryClientLite()
  return <button onClick={() => client.invalidateQueries({ queryKey: ['todos'] })}>Refresh</button>
}
```

## `useQueryLite`

```ts
useQueryLite(options, explicitClient?): UseQueryResult
```

`options` は TanStack Query v5.101.x の query options を受け取ります。`queryKey` と `queryFn` は必須です。`meta`、`enabled`、`staleTime`、`gcTime`、`retry`、`retryDelay`、`select`、`initialData`、`placeholderData`、`refetchInterval`、focus/reconnect policy、`structuralSharing`、`throwOnError`、`networkMode` など、Lite が意味を保てる option は native state へ渡されます。

`queryFn` には native QueryClient の `QueryFunctionContext` が渡されます。

```tsx
const result = useQueryLite({
  queryKey: ['search', keyword],
  queryFn: async ({ queryKey, signal, meta }) => {
    const [, term] = queryKey
    return searchApi(String(term), { signal, meta })
  },
})
```

返却 result の data、error、status、fetch status、stale 判定、`refetch` は native query state を元にします。Lite は native `QueryObserver` instance を返しません。observer instance、observer count、observer 専用 option を使うコードには [compatibility](compatibility.md) の制限が適用されます。

## `useQueriesLite`

`queries` は readonly/immutable な入力として扱います。query options の内容や順序を変更する場合は新しい配列を渡してください。同じ配列 object をその場で mutate する使い方はサポートしません。同じ配列 identity のまま cache data だけが更新された場合、Lite は default options と Query lookup を再利用して大量 query の一件更新を軽量に保ちます。

```ts
useQueriesLite({ queries }, explicitClient?): readonly UseQueryResult[]
```

複数 query を一つの Lite aggregate subscription で購読します。同じ render の query は native QueryCache の state と request を共有し、同じ key の query function は deduplicate されます。`combine`、`notifyOnChangeProps`、`subscribed` は native `useQueries` と同じ入力として利用できます。

```tsx
const results = useQueriesLite({
  queries: [
    {
      queryKey: ['user', userId],
      queryFn: ({ signal }) => fetchUser(userId, signal),
    },
    {
      queryKey: ['settings'],
      queryFn: fetchSettings,
      select: (settings) => settings.theme,
    },
  ],
})
```

tuple の data type は TypeScript 7 と native options の推論に合わせます。observer 配列そのものを受け取る native の拡張処理や `QueryObserver` の instance method は提供しません。

## `queryOptionsLite` / native `queryOptions`

package の `queryOptionsLite` は native `queryOptions` と同じ options value を返し、`queryOptions` は同一 identity の unsuffixed aliasです。native helper の戻り値もそのまま Lite hook に渡せます。

```tsx
import { queryOptions } from '@tanstack/react-query'
import {
  queryOptionsLite,
  useQueryLite,
} from 'tanstack-query-lite-hooks'

const projectOptions = queryOptionsLite({
  queryKey: ['project', projectId] as const,
  queryFn: ({ signal }) => fetchProject(projectId, signal),
  select: (project) => project.name,
})

const project = useQueryLite(projectOptions)
```

DataTag と `select` の型は native helper が付与したものを維持します。options object は変更せず、dynamic な値は通常どおり query key または query function closure へ含めます。native `queryOptions()` の戻り値も同じ推論で受け取ります。

## `skipTokenLite` / native `skipToken`

conditional query には package の `skipTokenLite`（unsuffixed alias は `skipToken`）または native `skipToken` を使います。

```tsx
import { skipTokenLite, useQueryLite } from 'tanstack-query-lite-hooks'

const query = useQueryLite({
  queryKey: ['user', userId],
  queryFn: userId === undefined
    ? skipTokenLite
    : ({ signal }) => fetchUser(userId, signal),
})
```

`skipTokenLite` と package の `skipToken` は同じ value identity です。native `skipToken`（上の例では `nativeSkipToken`）も受け取れます。`skipToken` 中は automatic fetch、polling、focus/reconnect refetch を行いません。Lite result の `refetch()` を明示的に呼ぶと、有効な query function がないことを示す Promise rejection を返します。この点は error result を返す native observer の細部とは異なります。Suspense query では `skipToken` を使えません。

## Native cache と imperative API

Lite が読む cache は `client.getQueryCache()` が返す real `QueryCache` です。別の Map、sidecar cache、Lite 専用 data snapshot は作りません。

```ts
const key = ['todos'] as const

const before = client.getQueryData<Todo[]>(key)
client.setQueryData(key, (todos = []) => [...todos, newTodo])
await client.invalidateQueries({ queryKey: key })
await client.cancelQueries({ queryKey: key })
```

native hook の write は Lite result に通知され、Lite hook の更新は native `getQueryData` と native observer へ通知されます。共有される範囲は query key の hash、query state、request、timestamp、structural sharing、retry/cancellation です。

`getQueryCache().find()`、`findAll()`、`subscribe()`、Devtools など native QueryCache を直接扱う API も同じ object を見ます。ただし Lite subscription は native `QueryObserver` の subscriber ではないため、active observer 数は増えません。

## Cancellation

native QueryClient が作る `AbortSignal` を query function 内で利用します。

```tsx
useQueryLite({
  queryKey: ['document', id],
  queryFn: ({ signal }) => fetch(`/documents/${id}`, { signal }).then((r) => r.json()),
})
```

明示キャンセルは native method を使います。

```ts
await client.cancelQueries({ queryKey: ['document', id], exact: true })
```

同じ key に native observer が残っている場合、Lite component の unmount はその native observer を解除しません。request の中止を component lifecycle に依存させる場合は、native observer の有無と `cancelQueries` の呼び出しを設計に含めてください。

## Suspense

```tsx
import { useSuspenseQueryLite } from 'tanstack-query-lite-hooks'

function Account() {
  const account = useSuspenseQueryLite({
    queryKey: ['account'],
    queryFn: fetchAccount,
  })
  return <h1>{account.data.name}</h1>
}
```

pending data がない場合は native query state の Promise を Suspense boundary へ渡します。成功後の `data` に取得前状態の `undefined` を付けません。`useSuspenseQueriesLite` は同じ render で pending query を並列開始します。

Suspense では `enabled: false`、`placeholderData`、`skipToken` のように data がない状態を hook option で表す設計は利用できません。条件付き取得が必要なら通常の `useQueryLite` を使います。

## SSR hydration

Lite は SSR snapshot を定義しません。native `dehydrate`、`hydrate`、`HydrationBoundary` を使います。

```tsx
import {
  dehydrate,
  hydrate,
  HydrationBoundary,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query'

// server
const serverClient = new QueryClient()
await serverClient.prefetchQuery(projectOptions)
const state = dehydrate(serverClient)

// client
const client = new QueryClient()

hydrate(client, state)

createRoot(container).render(
  <QueryClientProvider client={client}>
    <HydrationBoundary state={state}>
      <ProjectScreen />
    </HydrationBoundary>
  </QueryClientProvider>,
)
```

`HydrationBoundary` を使う場合、native API の境界へ state を渡してください。Lite は hydrate 後の real QueryCache を読むだけです。serialize/filter、server error、dehydrate 対象の選択は native TanStack Query の仕様に従います。

## `infiniteQueryOptionsLite` / Infinite Query

Infinite Query は root entrypoint の `infiniteQueryOptionsLite`、`useInfiniteQueryLite`、`useSuspenseInfiniteQueryLite` を使います。unsuffixed `infiniteQueryOptions`、`useInfiniteQuery`、`useSuspenseInfiniteQuery` は同じ value identity の aliasです。native `infiniteQueryOptions()` の戻り値もそのまま入力できます。

```tsx
import {
  infiniteQueryOptionsLite,
  useInfiniteQueryLite,
} from 'tanstack-query-lite-hooks'

const messagesOptions = infiniteQueryOptionsLite({
  queryKey: ['messages'],
  queryFn: ({ pageParam, signal }) => fetchMessages(pageParam, signal),
  initialPageParam: 0,
  getNextPageParam: (lastPage) => lastPage.nextCursor,
  maxPages: 10,
})

function Messages() {
  const messages = useInfiniteQueryLite(messagesOptions)
  return <button onClick={() => messages.fetchNextPage()}>More</button>
}
```

Infinite Query の pages、page params、forward/backward fetch、`maxPages`、Suspense は native state の shape と method semantics を共有します。通常 query と Infinite Query は同じ key を使わないでください。query shape が異なるため、key を分ける必要があります。

## Structural sharing

`structuralSharing` は native option と同じ意味です。

```tsx
useQueryLite({
  queryKey: ['settings'],
  queryFn: fetchSettings,
  structuralSharing: true,
})
```

Lite は独自に data を clone しません。native QueryCache が決めた canonical reference を読み、native observer と同じ object identity を返します。custom structural sharing function を利用する場合も、返す value が application の immutable 更新規約を満たすようにしてください。

## 開発時 warning と result の制限

Lite は native options/result を型として受け取れても意味を一致させられない項目を黙って処理しません。現在は `experimental_prefetchInRender` を指定した場合と、experimental stable-promise 契約を保証しない result の `promise` を読み取った場合に、development build で項目名を一度だけ warning します。production build ではこの診断を抑制します。

代表的な対象は次のとおりです。

| 対象 | 方針 |
| --- | --- |
| `experimental_prefetchInRender` | 通常 Lite query は passive effect で開始するため、指定時に warning |
| result の `promise` | native の experimental stable-promise 契約を保証しないため、読取時に warning |
| mutation 専用 option / result | mutation hook がないため native mutation API を利用 |
| native observer 数、Devtools active 状態 | result field ではなく native cache の外部観測。Lite subscription は加算されない |

warning を抑制する目的で `as any` を使わず、必要な query だけ native hook へ戻してください。詳細な表は [compatibility](compatibility.md) にあります。

## 非対応 API

次の API は意図的に提供しません。

- `QueryObserver` / `InfiniteQueryObserver` class とその instance API
- `useMutationLite` などの mutation hook
- `QueryClientLite`、`QueryClientProviderLite`、Lite 独自 Context
- Lite subscription を native active observer として登録する機能

mutation は `@tanstack/react-query` の `useMutation` を利用し、query cache の invalidation も native `QueryClient` から実行します。
