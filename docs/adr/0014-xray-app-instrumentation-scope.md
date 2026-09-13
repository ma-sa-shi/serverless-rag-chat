# ADR-0014: X-Rayのアプリ内トレース処理をapi-fnとingest-fnに限定する

- Status: Accepted
- Date: 2026-08-16

## Context

Lambda PowertoolsのTracingでAWS X-Rayを導入するにあたり、3つのLambdaとAPI Gatewayのステージでアクティブトレースを有効にし、アプリ内でもサブセグメントを出力する方針で実装した。しかし、デプロイして実測したところ、2つの制約が明らかになった。

### Lambda Web Adapter配下ではトレースコンテキストを受け取れない

ingest-fnは通常のLambdaハンドラーなので、X-Ray SDKはランタイムが用意したコンテキストをそのまま使える。

一方、api-fnとchat-fnはLambda Web Adapterの配下で、uvicornの子プロセスとして動く。Lambda Web Adapterがアプリへ転送するヘッダーは`x-amzn-request-context`と`x-amzn-lambda-context`の2つだけで、X-Rayのトレースヘッダーは含まれない。さらに、ランタイムが呼び出しごとに更新する環境変数`_X_AMZN_TRACE_ID`も、起動済みの子プロセスには反映されない。そのためSDKは親セグメントを組み立てられず、サブセグメントは破棄される。

ただし、`x-amzn-lambda-context`のJSONにはトレースIDが含まれている。`main.py`のミドルウェアはすでにこのヘッダーからRequest IDを取り出しているので、同じ場所でトレースIDも取得できる。

### 並行実行するとX-Ray SDKのコンテキストが壊れる

chat-fnのRAGパイプラインは、`retriever.map()`でMulti Queryの5クエリを並行に検索し、各コルーチンがCohereの埋め込みAPIをhttpxで呼ぶ。一方、X-Ray SDK for Pythonは、トレースエンティティのスタックをスレッドローカルに持つ。そのため、1つのスレッドで複数のコルーチンがサブセグメントを開閉すると、このスタックが壊れる。

デプロイ環境での実測結果は次のとおりである。

- `AlreadyEndedException: Already ended segment and subsegment cannot be modified.`がlangchain-cohereの埋め込み呼び出しまで伝わり、LangChainが4秒待ってから再試行した
- アプリが作ったサブセグメントは1つも届かなかった。X-Rayに届いたのはSDKが自動で記録したS3 Vectors・DynamoDB・SSM・Cohereのサブセグメントだけで、それらもすべて存在しない親を指す孤児になっていた

一方、同じ実装でも、api-fnはリクエスト全体のサブセグメントを、ingest-fnはハンドラーと取込4段のサブセグメントを正しく記録した。どちらもトレースを取る処理が逐次に実行されるためである。

## Decision

X-Rayのアプリ内トレースはapi-fnとingest-fnに限定し、chat-fnでは`POWERTOOLS_TRACE_DISABLED`でTracerを無効にする。ただし、アクティブトレースは3関数とも有効のままとし、Lambda自身のセグメントは記録する。

api-fnのトレースコンテキストは、`x-amzn-lambda-context`から取り出したトレースIDを、X-Ray SDKが参照する環境変数へ書き戻して復元する。

chat-fnでトレースを取らない理由は次の3点である。

- 監視のためのトレース処理が、LLM呼び出しに例外を持ち込み、応答時間を延ばした。得られる情報より副作用の方が大きい
- サブセグメントは実際には届いておらず、そもそもトレースの価値が出ていない
- Lambdaのセグメントは残るため、サービスマップや関数単位のレイテンシ・エラー率は失われない。ノードごとの所要時間も、各ノードが出す構造化ログで追える

## Consequences

メリット

- チャットの応答処理にトレースが干渉しなくなる
- 届かないサブセグメントを作り続けずに済む
- 追加の依存や独自のコンテキスト管理を持ち込まずに済む。chat-fn側の対処は環境変数1つだけである

デメリット・制約

- chat-fnのDynamoDB・S3 Vectors・Cohere呼び出しの所要時間をX-Rayで確認できない。チャットの内訳はログで追う
- 3つのLambdaでトレースの粒度がそろわない
- api-fnのコンテキスト復元はプロセスの環境変数を介する。この方式は、Lambdaが1つの実行環境で1呼び出しずつ処理するから成り立つ。コールドスタートとウォームスタートを含む複数のリクエストで、トレースが混ざらないことは実測で確認した

見直し条件

- aws-xray-sdk-pythonがasyncioでのコンテキスト伝播に対応した場合は、chat-fnでのトレースを再検討する
- AWS Distro for OpenTelemetryへ移行する場合は、コンテキスト伝播の仕組みごと変わるため、この判断を前提から見直す

## Alternatives

### AsyncContextへ差し替える

X-Ray SDKが提供する`AsyncContext`は、トレースエンティティをタスクローカルに持つ。task factoryが並行タスクへエンティティのリストを複製するため、`asyncio.gather`によるスタックの破壊は防げる。

しかし、`asyncio.to_thread`の配下ではコンテキストが失われる。`AsyncContext`は`asyncio.current_task()`を前提としているが、ワーカースレッドではこれがNoneになるためである。boto3は同期APIなので、S3 Vectorsの検索もDynamoDBへの保存も`asyncio.to_thread`で別スレッドから呼んでいる。つまり、並行するHTTP呼び出しのトレースと引き換えに、チャットで最も見たい呼び出しのサブセグメントを失う。加えて、`LambdaContext`を置き換えると、セグメントの生成も自前で行う必要がある。そのため採用しない。

### chat-fnでhttpxのトレースだけを外す

例外は、並行に実行されるhttpxのトレースから発生している。ノード単位のサブセグメントは逐次に開閉されるため、httpxだけをトレース対象から外せば残せる。

しかし、「並行に実行する箇所へトレースを足さない」という制約は、コードで強制できない。RAGパイプラインは今後もノードの追加や並列化が見込まれ、`asyncio.gather`を1つ足しただけで同じ例外が再発する。そもそも、監視の仕組みがアプリケーションの書き方を縛る状態は避けたい。そのため採用しない。

### トレースを残したまま例外を抑止する

例外はSDKの内部で送出されるため、アプリケーション側には捕捉できる場所がない。また、`AWS_XRAY_CONTEXT_MISSING`はコンテキストがないときの扱いを変える設定であり、この例外には効かない。実用的な抑止手段がないため、採用しない。
