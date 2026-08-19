# Compatibility and limitations

`tanstack-query-lite-hooks` は TanStack Query v5.101.x の native cache と state を利用する薄い React hook 層です。native React adapter を置き換えることを目的にしていますが、`QueryObserver` を使わないため、native の全 API と同じ lifecycle や active semantics を提供するものではありません。

## Version matrix

| component | supported baseline |
| --- | --- |
| `@tanstack/react-query` | `5.101.x`（peer range `>=5.101.0 <5.102.0`） |
| React / React DOM | `18.3.x` 以上 `20` 未満 |
| TypeScript | `7.x`（declaration baseline は `7.0.2`） |
| runtime | Node.js `20` 以上、ESM `.mjs` |

TanStack Query の minor version を跨いだ更新では、React adapter の option/result shape、QueryCache event、hydration schema が変わる可能性があります。peer range 外の version で動作したとしても互換性を保証しません。

## Shared native objects

Lite は次の native object を直接利用します。

- `QueryClientProvider` が解決する native `QueryClient`
- `queryClient.getQueryCache()` が返す real `QueryCache`
- query key hash、query state、request、retry、`AbortSignal`
- `dataUpdatedAt`、invalidate、`setQueryData`、remove、clear
- native `dehydrate` / `hydrate` が扱う state

Lite 用の cache mirror や private `QueryClient` を作らないため、次の例は同じ data と timestamp を参照します。

```tsx
const key = ['profile', 1] as const

function NativeAndLite() {
  const native = useNativeQuery({ queryKey: key, queryFn: fetchProfile })
  const lite = useQueryLite({ queryKey: key, queryFn: fetchProfile })
  return <pre>{JSON.stringify({ native: native.data, lite: lite.data })}</pre>
}
```

同じ key の native と Lite query function は一つの native query state と in-flight request を共有します。query function の副作用、retry、error object、abort の結果も native state machine が決めます。

native と Lite の両方が同じ query を購読している状態で `invalidateQueries` を呼んだ場合、commit 済みで有効な Lite subscription を共有 Query record の active 判定へ含めます。どの QueryClient から呼んでも native refetch pass が同じ in-flight request、cancel、paused、error、Promise 処理を利用します。`refetchType: 'inactive'` は有効な Lite query を除外し、`'all'` は含め、`'none'` は invalidate のみにします。commit 済み Lite subscription の `staleTime: 'static'` も Query record へ反映し、`refetchQueries` と `invalidateQueries` のいずれでも invalidate のみにします。最後の該当 lease を解除した時は native method を正確に復元します。

最初の Lite subscription を commit した時、package はその Query record の `isActive` / `isDisabled` / `isStatic` を lease 期間だけ拡張し、Lite hook が使う `QueryClient` instance の `invalidateQueries` には別実装向けの Promise 追跡 accessor を設置します。通常の代入で decorator や別実装を登録しても accessor は維持され、decorator が取得済みの旧 method へ正規化済み filters を渡す場合も再帰しません。複数の decorator は登録順の chain を保ち、async decorator と並行呼び出しも前段を飛ばしません。async の別実装が `await` 後に `QueryClient.prototype.invalidateQueries` を呼ぶ場合も、返された Promise は対象 Lite refetch を待ちます。`Object.defineProperty` で accessor 自体を置き換えるコードまでは仲介できません。server render や破棄された未 commit render だけでは QueryClient/Query を変更しません。

この commit-time 拡張には通常の TanStack Query が生成する extensible な `Query` / `QueryClient` が必要です。`Object.freeze`、`Object.seal`、`Object.preventExtensions`、または non-configurable な同名 own method descriptor を外部から適用した object はサポートしません。拡張できない場合は subscription retention より前に例外を投げ、method、GC lease、`gcTime` を残しません。

## Native observer との相違

Lite は `QueryObserver`、`InfiniteQueryObserver`、またはその subclass を生成しません。hook は QueryCache の state/event を直接購読し、`useQueriesLite` は複数 key の変更を aggregate して React へ通知します。

この設計には次の意味があります。

- Lite subscription は `query.getObserversCount()` の native observer 数へ加算されません
- `query.isActive()` と active/inactive query filter は commit 済みで有効な Lite subscription を含みます
- observer list と observer count は native observer のみを表示します。Devtools が `isActive()` を使う表示は Lite lease を含む場合があります
- native observer の focus/reconnect dispatch は Lite を対象にせず、LiteHub が同じ trigger を別に処理します
- native `QueryObserver` を受け取る third-party plugin や observer callback は Lite hook を検出しません

observer count や observer instance を基準にした plugin 互換性が必要な画面では、該当部分に native `useQuery` / `useInfiniteQuery` を利用します。

## GC と lifecycle

query data は real QueryCache にある一方、LiteHub は Lite subscription ごとの lease と GC を独自に管理します。Lite は native observer ではありませんが、Lite component が購読している間は LiteHub がその query record を保持します。native QueryClient の observer-based GC だけで Lite-only query を削除することはありません。

native observer が一つもない Lite-only screen では、次の差が生じます。

1. Lite が render 中に state を読んでいても、native QueryCache の active observer 数は 0 のままです。
2. LiteHub は Lite subscription の lease がある限り query を保持し、最後の Lite subscription が外れた後は Lite の `gcTime` ルールで回収します。
3. native observer の `gcTime` と LiteHub の `gcTime` は同一の lifecycle ではないため、Devtools の observer count と retained query 数は一致しない場合があります。
4. native observer が残っている場合も、Lite の unmount はその native observer、request、native GC lease を解除しません。
5. 複数 QueryClient が一つの QueryCache を共有する場合、Lite lease は QueryClient ごとではなく QueryCache と Query object の組み合わせで集約します。

Lite-only query の再取得や保持期限を明示的に制御する場合は native `staleTime`、Lite query の `gcTime`、`invalidateQueries`、`cancelQueries` を設定してください。Devtools の count と実際の Lite component 数が一致しないことは仕様です。

## Render と callback identity

Lite は render 中に受け取った options/result memory と、最後に commit された options/result memory を分離します。inline `queryFn`、`select`、`enabled` function、interval resolver、query list が新しい identity になっても、それだけでは mount/refetch とみなしません。cache event、timer、manual refetch は commit 済み callback と result baseline を使い、Suspense や transition で破棄された render の callback/key/selected result を live subscription へ反映しません。

`useQueriesLite` の `queries` は immutable value として扱います。同内容の新しい配列を毎 render 渡すことは正しく動作しますが、大量 query では default options の再計算を避けるため stable array identity を推奨します。同じ配列をその場で mutate する使い方は検出できないため非対応です。

## Supported query surface

| API / feature | Lite での扱い |
| --- | --- |
| `useQuery` / `useQueryLite` | 対応。native cache/state を直接購読 |
| `useQueries` / `useQueriesLite` | 対応。aggregate subscription を使用 |
| `useSuspenseQuery` / `useSuspenseQueryLite` | 対応。native pending state の Promise を利用 |
| `useSuspenseQueries` / `useSuspenseQueriesLite` | 対応。pending query を同じ render で開始 |
| `queryOptions` | native helper の戻り値を受け取り |
| `queryOptionsLite` / `queryOptions` | 同じ options value identity の package helper/alias |
| `skipToken` | native identity を受け取り |
| `skipTokenLite` / `skipToken` | 同じ sentinel identity の package helper/alias。native sentinel も受け取り |
| `useInfiniteQuery` / `useInfiniteQueryLite` | root entrypoint で対応 |
| `infiniteQueryOptions` / `infiniteQueryOptionsLite` | root entrypoint で対応。native helper の戻り値も受け取り |
| `structuralSharing` | native Query state の設定を利用 |
| `dehydrate` / `hydrate` / `HydrationBoundary` | native API をそのまま利用 |
| `useMutation` | Lite では非対応。native hook を利用 |
| `QueryObserver` classes | Lite では非対応。native class を利用 |

## Option compatibility

Lite が意味を保てる option は native QueryClient へ委譲します。典型的な対応 option は次のとおりです。

- `queryKey`, `queryFn`, `meta`
- `enabled`, `staleTime`, `gcTime`
- `retry`, `retryDelay`
- `select`, `initialData`, `placeholderData`
- `refetchInterval`, `refetchOnWindowFocus`, `refetchOnReconnect`
- `structuralSharing`
- Infinite Query の `initialPageParam`、page param resolver、`maxPages`

次のような項目は、native observer instance や native React adapter の細かな通知契約に依存するため、対応できない場合があります。

- `QueryObserver` instance 自体を要求する設定
- mutation 専用 option、observer callback、private adapter extension

次の native option は Lite aggregate/runtime で対応します。

- `combine`
- `notifyOnChangeProps`
- `subscribed`
- `throwOnError`
- `networkMode`

`experimental_prefetchInRender` は public native type として受け取れますが、通常 Lite query の render 中 fetch を有効にしません。指定した場合は development build で一度だけ warning を出します。warning は production build では抑制されます。render 中の Promise が必要な query は Suspense hook または native hook を使用してください。

## Result compatibility

通常 query result の `data`、`error`、`status`、`fetchStatus`、`isPending`、`isFetching`、`isSuccess`、`isError`、`isStale`、`refetch` などは native query state から生成されます。Suspense result の data non-null contract も同じです。

一方、次の情報は Lite result の契約に含めません。

- experimental stable-promise 契約としての `promise`。property を読むと development build で一度だけ warning
- `QueryObserver` instance 自体
- native observer 数や Devtools active 状態を示す property
- observer callback の identity と lifecycle
- mutation の result、variables、context
- native adapter が内部用に持つ private field

対応しない result property を読み取った場合は development build で warning を出します。型が偶然通る場合でも、warning を抑制するための cast は使用しないでください。

## Cancellation

`queryFn` へ渡される `AbortSignal`、`queryClient.cancelQueries()`、native retry と request replacement は共有されます。

ただし、Lite-only component の unmount は native observer の解除ではありません。native observer がある query へ影響を与えずに LiteHub の subscription lease を解放できる一方、unmount だけで request cancel を要求する設計には向きません。確実な中止が必要な場合は native `cancelQueries` を明示します。

## SSR

Lite は hydration state を独自 serialize しません。server/client の native QueryClient を使い、native `dehydrate`、`hydrate`、`HydrationBoundary` を設定します。Lite は hydration 後の real QueryCache を読み取るため、native と Lite の間で別 snapshot を同期する処理は不要です。

## React Compiler

package の public hook は React Compiler と共存します。package 内部の mutable external-store runtime は `"use no memo"` で自動 memo 化から外し、利用側 component は通常どおり Compiler の対象にできます。compatibility check はこの境界を `panicThreshold: 'all_errors'` で検査しますが、利用側の conditional Hook call や render 中 mutate を修正するものではありません。

## 移行の目安

Lite は次のような画面に向きます。

- read-heavy な query 画面
- 同じ query state を多数の component が読む画面
- 大量の `useQueries` を aggregate subscription で扱いたい画面
- cache の source of truth と SSR/hydration を native QueryClient に統一したい application

次の要件がある画面は native hook を維持します。

- Devtools の active observer semantics を component 数と一致させる必要がある
- `QueryObserver` instance を third-party integration へ渡す
- mutation hook、mutation lifecycle、mutation cancellation が必要
- observer-specific option の細かな通知契約が必要
