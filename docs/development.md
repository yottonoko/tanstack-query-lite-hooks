# Development and verification

この repository は `tanstack-query-lite-hooks` の private package と browser benchmark を管理します。npm への publish は行いません。private GitHub clone、local build、利用側の private dependency install が基本 workflow です。

## 前提

- Node.js 20 以上
- pnpm 10 系
- TypeScript 7.0.2
- React 19 系と `@tanstack/react-query` 5.101.x（lockfile の baseline）
- Headless Chromium（browser benchmark を実行する場合のみ）

dependency は `pnpm-lock.yaml` に固定します。TanStack Query の minor version を更新する場合は compatibility docs と benchmark の version record も更新してください。

## 初回 setup

```sh
pnpm install --frozen-lockfile
```

private GitHub repository の clone と package install に使う GitHub credential は、環境変数や CI secret から注入します。repository に token、deploy key、registry credential を保存しません。

## 通常 check

```sh
pnpm check
```

`check` は typecheck、lint、unit test、React Compiler compatibility、ESM build、declaration check、bundle check をまとめて実行します。個別に確認する場合は次の command を使います。

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm check:react-compiler
pnpm check:declarations
pnpm check:bundle
pnpm build
```

runtime output は ESM `.mjs`、public type は `.d.ts` です。CommonJS output を追加しないでください。root entrypoint が native React adapter の不要な module を import していないことは `check:bundle` の対象です。

private GitHub dependency から build step なしで利用できるように、`dist/index.mjs`、source map、TypeScript declarations は repository に含めます。package tarball には README から参照する `docs/` も含めます。source を変更した commit では `pnpm build` 後の `dist/` も同じ commit に更新してください。npm registry への publish や install 時の `prepare` script は使いません。

## Public API の変更

Lite の public API は native TanStack Query の object と type を受け取ります。新しい hook、option、result field を追加する場合は、次の順で確認します。

1. real native `QueryCache` と query state を読み書きしていることを確認する
2. native `QueryClientProvider` の Context だけで動作することを確認する
3. canonical `Lite` name と unsuffixed alias が同じ runtime value identity を持つことを確認する
4. native hook と Lite hook を同じ key/provider/client に置いた test を追加する
5. unsupported option/result の development warning と production behavior を確認する
6. SSR native hydration、cancellation、Suspense、structural sharing の境界を確認する
7. compatibility docs と API examples を更新する

Lite 独自の `QueryClient`、`QueryClientProvider`、Context、cache mirror を追加しないでください。mutation hook や `QueryObserver` class が必要な変更は、native API の利用例と compatibility docs を更新する範囲に留めます。

## Tests

unit/type tests は次の挙動を固定します。

- native provider/client の Context 解決
- native と Lite の同一 key に対する data/state/request の共有
- same-key fetch deduplication と `AbortSignal`
- `setQueryData`、invalidate、cancel、retry の native semantics と LiteHub の subscription GC
- `useQueriesLite` aggregate subscription と dynamic query list
- `skipToken`、`queryOptions`、`infiniteQueryOptions` の native identity と型推論
- Suspense の Promise/data type
- native `dehydrate` / `hydrate` / `HydrationBoundary`
- structural sharing による data reference の再利用
- `queryOptionsLite` / `infiniteQueryOptionsLite` / `skipTokenLite` と unsuffixed alias の runtime identity と型同一性
- `combine`、`notifyOnChangeProps`、`subscribed`、`throwOnError`、`networkMode`
- unsupported option/result の development warning
- `QueryObserver`、mutation、独自 provider/client を誤って要求しないこと
- inline `queryFn` / options / query list を高速で更新しても余分な fetch や polling starvation を起こさないこと
- fresh-to-stale の parent rerender を新しい mount と誤認しないこと
- abandoned transition の callback/key/select result/top-level `subscribed` が commit 済み subscription や focus/reconnect 判定へ漏れないこと
- native/Lite 同時 invalidate の request deduplication、`refetchType`、`static`、await、cancel/restart、async/stacked decorator の再入
- aggregate item の `subscribed` 切り替えで lease と request が増殖しないこと
- 同じ QueryCache を使う複数 QueryClient 間の Lite GC lease

test を追加する時は、必要な native QueryClient を test scope で作り、provider を設置してください。Lite hook だけで cache を初期化する test は実運用の Context 境界を検証しません。

## Browser benchmark

長時間 benchmark は通常の `pnpm check` に含めません。必要な時だけ、負荷のない machine で実行します。

```sh
pnpm bench:compare
pnpm bench:memory
```

`bench:compare` は production Vite bundle を build し、Headless Chromium で次を測定します。

- 1,000 shared/distinct hook の `mount`、`resolve`、`singleUpdate`、`allUpdate`
- 10 warmup + 30 measured
- SWR の `max(SWR + 0.25ms, SWR * 1.10)` gate
- distinct resolve の native TanStack 0.8 倍 gate
- controlled fetcher の same-key deduplication
- rotating library order
- preseeded 10,000/20,000 `useQueries` の mount/singleUpdate
- 2 warmup + 5 measured
- Lite 20,000 の native 20,000 比較と 20,000/10,000 scaling 3 倍 gate

`bench:memory` は library/count ごとに fresh Chromium context を作り、CDP GC、heap/DOM counters、React unmount、client clear、DOM teardown を記録します。memory benchmark の結果を速度 acceptance と混ぜないでください。

benchmark API が実装と同時に変更される場合は、`benchmarks/benchmark.tsx` 上部の Lite import blockだけを更新します。native provider/client は同じ benchmark runtime で共有し、Lite 用の独自 provider/client を追加しないでください。

## Benchmark の変更

benchmark の比較対象と phase は、`docs/performance.md` の acceptance と一致させます。次の変更を単独で行わないでください。

- warmup/measured count の変更
- production build を dev server に置き換える変更
- library order の固定
- fetch count barrier の削除
- large query の preseed を削除する変更
- memory runner の fresh context、CDP GC、teardown の削除

API が未実装で benchmark を実行できない期間は、長時間 run を無理に実行せず、TypeScript syntax check と Vite production build までを確認します。実行不能な理由、未解決の import、最後に通った check を報告してください。

## Release hygiene

release 前には次を記録します。

- package version、Git commit、branch
- Node.js、pnpm、TypeScript、React、TanStack Query、SWR、Chromium version
- OS、architecture、`crossOriginIsolated` の状態
- benchmark の run order、median、fetch count、teardown delta
- compatibility docs の peer range

private package のため npm publish workflow、public registry tag、public CDN bundle を追加しません。GitHub Actions の追加や変更が必要な場合は、別途明示的な承認を得てから扱います。
