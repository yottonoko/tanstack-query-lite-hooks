# Performance methodology

この package は、native QueryCache/state の共有を保ったまま React adapter 層の通知・allocation cost を減らすことを目的にしています。絶対時間や全ての application workload の優位性を保証するものではありません。速度と memory は別の指標として測定します。

## Lite が速くなり得る理由

TanStack Query の native React adapter は、多数の query を扱うために observer、result tracking、通知、option の細かな互換処理を提供します。これは広い API と observer semantics を支えるためのコストです。

Lite は次の設計により、同じ real QueryCache と state を使いながら adapter 層の仕事を小さくします。

- query ごとに `QueryObserver` instance を生成せず、cache event と state を直接購読します
- `useQueriesLite` は query ごとの React observer 配列を作らず、複数 key の変更を aggregate subscription へまとめます
- native QueryClient の request deduplication、hash、retry、cancellation を再実装せず、そのまま利用します
- Lite result の shape と tracking surface を限定し、observer-only の互換処理を実行しません
- LiteHub の subscription lease と GC を query record 単位で管理し、native observer 数とは独立した保持判定を行います

このため、同じ key の大量購読や大量 `useQueries` では、observer object の生成、個別 subscription、result 配列の再計算が少なくなり、React commit 前後の時間を短縮できる可能性があります。

## Native の大量 observer が遅く見える理由

native `useQueries` は、各 query の observer lifecycle、property tracking、option 差異、Devtools/active semantics など、より広い契約を維持します。10,000 件や 20,000 件のように query 数を極端に増やした場合、これらの observer 単位の作業が mount と更新に積み上がることがあります。

これは upstream の実装が不要という意味ではありません。native adapter は API の完全性と observer semantics を優先し、Lite は用途を限定して aggregate subscription と小さな result surface を選びます。比較は同じ version、同じ query data、同じ browser、同じ production bundle で行い、native の機能を無効化したり、Lite にない契約を無視したりしないでください。

## Browser benchmark

`pnpm bench:compare` は Vite の production build と Headless Chromium を使います。runner は Vite の programmatic `build()` / `preview()` API を使って一時 bundle を作り、同一 browser run 内で native TanStack Query、Lite、SWR を比較します。開発 server、source module、React Dev mode の測定ではありません。

### 1,000-hook core scenario

shared key と distinct key をそれぞれ 1,000 hooks で測定します。

| 項目 | 値 |
| --- | ---: |
| warmup | 10 回 |
| measured | 30 回 |
| key modes | `shared`, `distinct` |
| core phases | `mount`, `resolve`, `singleUpdate`, `allUpdate` |
| summary | 各 library/mode の median |

`resolve` は controlled fetcher の Promise を解決し、全 hook が期待値を commit するまでを測ります。`singleUpdate` は 1 key、`allUpdate` は shared では 1 key、distinct では 1,000 keys を更新します。measurement は React commit と passive/layout effect の barrier を含みます。

### Core acceptance

各 mode の各 core phase で、Lite の median は同じ run の SWR median に対して次の上限以内である必要があります。

```text
Lite <= max(SWR + 0.25 ms, SWR * 1.10)
```

さらに、distinct-key の `resolve` は native TanStack Query の median の 0.8 倍以内である必要があります。

```text
Lite distinct resolve <= native TanStack distinct resolve * 0.80
```

SWR との比較は scheduler と browser jitter の小差を吸収するための variance-aware gate です。TanStack Query との比較は distinct resolve のようにこの package の設計目的を直接測る phase に限定します。shared mount など native が得意な phase の常時勝利は acceptance に含めません。

### Fetch deduplication

各 core trial は controlled fetcher の invocation count を記録します。

- `shared` は 1,000 hook が同じ key を使い、fetch invocation が 1 回であること
- `distinct` は 1,000 key がそれぞれ 1 回であること

fetch count が期待値と異なる trial は、速度が gate 内でも失敗とします。これにより cache hit だけで速く見える実装や、同じ request の重複を見落とさないようにします。

### Rotating order

各 round の library order を rotate します。大規模 scenario では round ごとに native/Lite の順を reverse します。常に同じ library を最初に実行することで発生する JIT、cache、scheduler の偏りを減らします。run の順番は report の config に出力します。

## 10,000 / 20,000 `useQueries` scenario

large scenario は query count ごとに query data を先に native QueryClient へ seed し、preseeded state を `useQueriesLite` または native `useQueries` で読む構成です。fetch latency ではなく、large hook mount と 1 key update の adapter cost を測ります。

| 項目 | 値 |
| --- | ---: |
| query counts | 10,000 / 20,000 |
| warmup | 2 回 |
| measured | 5 回 |
| phases | `mount`, `singleUpdate` |
| state | preseeded |
| summary | 各 library/count の median |

acceptance は次のすべてです。

1. Lite 20,000 件の `mount` が native 20,000 件より短い
2. Lite 20,000 件の `singleUpdate` が native 20,000 件より短い
3. Lite の 20,000/10,000 比が `mount` と `singleUpdate` の両方で 3 倍以内

large scenario の `singleUpdate` は key 0 だけを `setQueryData` し、変更が一つの result へ伝播するまでを測定します。20,000 件全てを同時に書き換える phase は core `allUpdate` と役割が異なるため、large acceptance には含めません。

大量 query では `queries` 配列を immutable value として扱い、内容を変更する時は新しい配列を渡してください。同じ配列 identity の再 render では、Lite は default options と native Query lookup を再利用し、一件の cache event に対して全 options を処理し直しません。配列をその場で mutate する使い方はサポートしません。

同内容の新しい配列を毎 render 作る場合も、subscription lease、polling deadline、mount refetch 判定は維持されます。ただし options の走査と default 化は必要です。高頻度の parent render と 10,000 件以上の query を組み合わせる場合、正しさとは別の性能要件として stable array identity を利用してください。

## 2026-08-20 の実測結果

最終 MJS build を Headless Chrome 151、React 19.2.8、`@tanstack/react-query` 5.101.4、SWR 2.5.1 で測定しました。1,000-hook scenario は 10 warmups + 30 measured runs、large scenario は 2 warmups + 5 measured runs の median です。実行時の PC 負荷で数値は変動するため、絶対値ではなく同一 run 内の比較として扱います。

| scenario | Lite | native | SWR |
| --- | ---: | ---: | ---: |
| 1k shared mount | 5.20 ms | 4.80 ms | 7.05 ms |
| 1k shared resolve | 9.35 ms | 9.20 ms | 10.50 ms |
| 1k shared single update | 7.30 ms | 8.70 ms | 10.40 ms |
| 1k shared all update | 7.40 ms | 6.25 ms | 10.20 ms |
| 1k distinct mount | 6.70 ms | 5.70 ms | 9.00 ms |
| 1k distinct resolve | 15.85 ms | 197.90 ms | 15.45 ms |
| 1k distinct single update | 0.20 ms | 2.80 ms | 0.20 ms |
| 1k distinct all update | 9.35 ms | 10.40 ms | 13.00 ms |

| large scenario | Lite | native | Lite 20k/10k |
| --- | ---: | ---: | ---: |
| 10k mount | 55.9 ms | 64.2 ms | - |
| 20k mount | 122.1 ms | 123.7 ms | 2.184x |
| 10k single update | 4.2 ms | 21.8 ms | - |
| 20k single update | 8.2 ms | 44.3 ms | 1.952x |

core、fetch deduplication、large mount、large single-update、3x scaling の acceptance は全て通過しました。commit 済み options/result/entry memory の分離、failure-atomic lease setup、cache-wide active/static/disabled semantics、shared-key O(1) static method setup、default options の二重計算除去、invalidate filter/await/cancel/deduplication、duplicate entry notification、polling lifecycle 修正を含む build での値です。acceptance 外の parent-only rerender median は shared で Lite 7.70 ms / native 3.95 ms / SWR 10.45 ms、distinct で Lite 8.10 ms / native 3.40 ms / SWR 11.15 ms でした。parent rerender は native が短い一方、Lite は同じ run の SWR より短く、inline options の stress tests でも余分な fetch と timer reset がないことを別に検証しています。

この run の 20k mount 差は 1.6 ms で、PC 負荷による変動より十分に大きいとは断定できません。runner の pass は記録しますが、mount の継続的な優位を判断する場合は idle machine で複数 run を追加してください。一方、20k single update は同一 run で 8.2 ms / 44.3 ms と大きな差がありました。

## Retained-memory benchmark

memory benchmark は速度 gate と別の opt-in command です。

```sh
pnpm bench:memory
```

library/count の組み合わせごとに fresh Chromium context を作り、前の measurement の JavaScript object、DOM、event listener が次へ漏れないようにします。各 context では次の順に実行します。

1. production Vite bundle を読み込む
2. CDP `HeapProfiler.collectGarbage` を実行して baseline の heap/DOM counter を取得する
3. 10,000 または 20,000 件の preseeded query を mount する
4. passive subscription と 2 animation frames を待つ
5. CDP GC 後に mounted heap と DOM counter を取得する
6. React root を unmount し、QueryClient を clear し、host DOM を削除する
7. 2 frames を待ち、GC 後に teardown delta を取得する

runner は CDP `Runtime.getHeapUsage` と `Memory.getDOMCounters` を出力します。mounted delta は保持コストの診断、teardown delta は回収漏れの診断に使います。mounted heap が小さいことを速度優位の条件に含めません。

2026-08-19 時点の build では、10,000 件の retained `usedSize` は Lite 16,331,676 bytes / native 16,307,584 bytes、20,000 件は Lite 32,304,544 bytes / native 32,271,404 bytes でした。teardown 後の baseline 差は 20,000 件で Lite 341,804 bytes / native 348,408 bytes、DOM node 差はどちらも 0、event listener 差はどちらも 1 です。この値は現在の最終 build を再測定したものではありません。当時の結果は native QueryCache 自体が保持量の中心であることを示す診断値ですが、現在の build の leak 証明、一般的な memory 上限、速度 acceptance としては扱いません。

## 実行条件

- foreground/background の CPU・memory 負荷がない machine で実行する
- native、Lite、SWR の version と lockfile を固定する
- Chromium、Node.js、React、OS、architecture を report と一緒に記録する
- 同じ production Vite build と同じ run order で比較する
- median、fetch count、teardown を一緒に確認する
- benchmark が失敗した時は最初に console error、timeout、fetch count、order を確認する

この repository の通常 check は browser benchmark を実行しません。数値を README や release note に追加する場合は、測定条件を省略しないでください。
