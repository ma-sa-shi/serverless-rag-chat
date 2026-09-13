# システム設計書: 社内RAGチャットアプリ

## 目次

- [1. 概要](#1-概要)
  - [1.1 背景・目的](#11-背景目的)
  - [1.2 設計方針](#12-設計方針)
- [2. システム全体構成](#2-システム全体構成)
- [3. フロントエンド設計](#3-フロントエンド設計)
  - [3.1 技術スタック](#31-技術スタック)
  - [3.2 画面構成・ルーティング](#32-画面構成ルーティング)
  - [3.3 配信構成](#33-配信構成)
- [4. 認証設計](#4-認証設計)
- [5. バックエンド設計](#5-バックエンド設計)
  - [5.1 構成方針](#51-構成方針)
  - [5.2 api-fn](#52-api-fn)
  - [5.3 chat-fn](#53-chat-fn)
  - [5.4 ingest-fn](#54-ingest-fn)
- [6. 処理フロー](#6-処理フロー)
  - [6.1 アップロードフロー](#61-アップロードフロー)
  - [6.2 取込フロー](#62-取込フロー)
  - [6.3 削除フロー](#63-削除フロー)
- [7. RAGパイプライン](#7-ragパイプライン)
  - [7.1 処理フロー](#71-処理フロー)
  - [7.2 使用モデル](#72-使用モデル)
  - [7.3 パラメータ](#73-パラメータ)
- [8. データ設計](#8-データ設計)
  - [8.1 DynamoDB](#81-dynamodb)
  - [8.2 S3](#82-s3)
  - [8.3 S3 Vectors](#83-s3-vectors)
- [9. インフラ設計](#9-インフラ設計)
  - [9.1 CDKスタック構成](#91-cdkスタック構成)
  - [9.2 CloudFront](#92-cloudfront)
  - [9.3 API Gateway](#93-api-gateway)
  - [9.4 モデル呼び出しの認可](#94-モデル呼び出しの認可)
- [10. 運用設計](#10-運用設計)
  - [10.1 ロギング・モニタリング](#101-ロギングモニタリング)
  - [10.2 CI/CD](#102-cicd)
- [11. コスト](#11-コスト)
  - [11.1 コスト方針](#111-コスト方針)
  - [11.2 コスト構造](#112-コスト構造)
- [12. 関連ドキュメント](#12-関連ドキュメント)

## 1. 概要

### 1.1 背景・目的

本システムは、社内ドキュメントを活用したRAG（検索拡張生成）チャットアプリである。AWSのサーバーレスアーキテクチャを中心に構成し、社内ナレッジの円滑な共有と活用を目的とする。

### 1.2 設計方針

設計方針を3つの観点に分けて示す。主要なアーキテクチャ上の決定理由および代替案はADRとして記録しており、一覧は[12. 関連ドキュメント](#12-関連ドキュメント)に記載している。

アーキテクチャ

- SPA + REST APIを基本とし、SSRを採用しない
- バックエンドはFastAPIへ集約し、Lambdaは責務ごとに分離する
- ファイルはSPAからS3へ直接アップロードする
- アップロードと取込を分離し、Embedding生成はユーザーの取込アクションをトリガーとする

採用技術

- LLM・Embedding・Rerank処理は全てBedrock経由で呼び出す
- ベクトル検索にはS3 Vectorsを採用する
- データストアにはDynamoDBを採用する
- 認証基盤にはCognitoを採用する

開発・運用

- 既存のRAG実装を移植・再利用する
- VPCを使用せず、固定費を極力ゼロに抑える
- 運用構成をシンプルに保つ

## 2. システム全体構成

システム全体の構成を以下に示す。ブラウザからのアクセス経路は、「認証」「画面表示・API呼び出し」「ファイルアップロード」の3系統に分かれる。

![CloudFront配下のSPAとAPI Gateway、3つのLambda、DynamoDB・S3・S3 Vectorsまでのアプリケーション構成](./diagrams/アプリ設計図.svg)

ブラウザはまずCognitoのHosted UIで認証を行う。以降の通信はCloudFrontを経由し、SPAの静的コンテンツ取得およびAPI呼び出しを実行する。パスが `/api/*` のリクエストはAPI Gatewayへ転送され、REST API処理は api-fn、ストリーミングチャット処理は chat-fn がそれぞれ担当する。API GatewayのCognitoオーソライザが、Lambdaの起動前にアクセストークンを検証する。

ファイルは署名付きURLを利用し、ブラウザからS3へ直接アップロードする。ドキュメントの取込処理では、api-fn がSQSへメッセージを投入し、ingest-fn が非同期で処理を実行してDynamoDB、S3、S3 Vectorsへ書き込む。

## 3. フロントエンド設計

### 3.1 技術スタック

フロントエンドは以下の技術で構成する。

- Vite
- React
- TypeScript
- React Router
- TanStack Query
- axios

TanStack Queryは、ドキュメント一覧やチャット履歴などサーバー状態のキャッシュ管理に利用する。データ取得中・エラー状態のハンドリングや再取得ロジックを画面ごとに個別実装せず、共通基盤に集約する。

axiosはREST APIの呼び出しに利用し、アクセストークンの自動付与処理をインターセプターへ集約する。なお、チャット応答のSSEはレスポンスの逐次読み込みが必要であり、axiosでは対応できないため fetch APIで実装する。

### 3.2 画面構成・ルーティング

画面とルーティングは次のとおり。

| Path | 画面 |
|------|------|
| / | RAGチャット + 全ユーザーのチャット履歴 |
| /chat/{chat_id} | チャット詳細（チャット履歴から遷移） |
| /user/{user_id} | ユーザー情報 + 該当ユーザーのチャット履歴 + アップロード履歴 |
| /documents | ドキュメント管理（一覧取得・アップロード・取込・削除） |
| /auth/callback | Cognito Hosted UIからのリダイレクト受け取り、認可コードのトークン交換 |

未認証時は`/auth/callback`を除く全ルートでHosted UIへリダイレクトする。

チャット履歴は、社内のナレッジ共有を目的として全ユーザーに公開する。

チャット詳細画面では、回答の試行ごとに以下の出力情報を全て表示する。

- 生成クエリ
- 検索ドキュメント
- 回答
- 評価。gradeとfeedbackを含む
- 失敗分析。リトライ上限到達時のみ生成される

参照ドキュメントにはリンクを付与し、S3上の原本ファイルを閲覧用の署名付きGET URLで直接開ける構成とする。

### 3.3 配信構成

SPAはビルド後の静的ファイルをS3へ配置し、CloudFront経由で配信する。SSRは採用しない。

## 4. 認証設計

認証にはCognito User PoolのHosted UIを利用し、認可フローには Authorization Code + PKCEを採用する。PKCEはSPA向けのOAuth拡張規格であり、認可コードの横取り攻撃を防ぐ。

認証フローの概要は以下の通り。

```text
SPA
↓
Cognito Hosted UI
↓
Authorization Code + PKCE
↓
Access Token
↓
Authorization Header
↓
FastAPI
```

SPAはHosted UIでの認証完了後、取得したAccess Tokenを `Authorization` ヘッダーに設定してFastAPIを呼び出す。

FastAPI側では、JWKS（JSON Web Key Set：署名検証用公開鍵のセット）を用いたJWT検証のみを行う。パスワード管理やJWT発行処理はバックエンド側には実装しない。ユーザー識別（user_id）にはJWTの `sub` クレームを使用し、独自ヘッダーによる識別は行わない。

ユーザー登録、トークンの取り扱い、ライブラリ選定、認可範囲の詳細設計は[authorization.md](./authorization.md)で管理する。トークンの保存先に関する判断理由は[ADR-0010](./adr/0010-token-storage-localstorage.md)に記載する。

## 5. バックエンド設計

### 5.1 構成方針

FastAPIを単一のDockerイメージとして管理し、責務に応じて3つのLambda関数へデプロイする。環境変数等の関数ごとの差分はCDK上で設定する。

api-fn および chat-fn では、HTTPサーバーであるFastAPIをLambda上で動作させるため、Lambda Web Adapterを採用する。Dockerfileはビルダー工程を共通化し、最終ステージを以下の3ターゲットに分割してCDKから関数ごとにターゲットを選択・指定する。

| ターゲット | Function | 構成 |
|-----------|----------|------|
| web | api-fn | Lambda Web Adapter + uvicorn |
| chat | chat-fn | web構成に chat 依存グループ（LangGraph / LangChain）を追加 |
| worker | ingest-fn | Adapterなし。awslambdaric + ingest 依存グループ（pypdf） |

3つのLambda関数はいずれもarm64アーキテクチャで実行する。x86_64と比較して実行単価が安価であり、11章のコスト試算も本構成を前提としている。CDKのイメージアセットおよびCIでのビルドは全て linux/arm64 で作成し、関数の実行環境と一致させる。

### 5.2 api-fn

REST APIを担当するLambda関数である。以下のエンドポイントを提供する。

- 認証API
- ドキュメント一覧（全ユーザー横断 / ユーザー別）
- チャット一覧（全ユーザー横断 / ユーザー別）
- チャット詳細（試行ごとの全出力を返却）
- ユーザー情報
- チャット利用回数（当日の上限および使用済み回数を返却）
- 署名付きURL発行（アップロード用PUT / 閲覧用GET）
- アップロード完了登録
- 取込開始
- ドキュメント削除

### 5.3 chat-fn

RAGチャットを担当するLambda関数である。LangGraphを用いたSelf-RAGを実行し、処理経過をSSEで逐次配信する。SSEは、サーバーからクライアントへイベントを継続的にプッシュ配信するHTTP通信方式である。

LangChain関連ライブラリはパッケージサイズが大きいため、chat-fn でのみロードする。

RAGパイプラインは既存実装を移植して使用する。移植に伴うコンポーネントの変更点は以下の通り。

| 対象 | 移植元 | 本構成 |
|------|--------|--------|
| Retriever | Chroma | S3 Vectors |
| チャット永続化 | MySQL | DynamoDB |
| ユーザー識別 | X-User-Idヘッダ | JWTの`sub` |

チャットは1問1答形式とし、複数ターンの文脈保持は行わない。過去の会話履歴はコンテキストとして利用せず、各質問を独立したリクエストとして処理する。

SSEでは、LangGraphのノードごとのState更新通知を配信する。トークン単位のストリーミング配信は行わない。

ストリーム配信は `POST /api/chats/stream` で行い、認証は `Authorization` ヘッダーを使用する。ブラウザ標準の EventSource を使用しない理由は[ADR-0012](./adr/0012-sse-post-with-authorization-header.md)に記載する。

処理フローを実行する前に、当日の利用回数を1回消費する。上限に達している場合はステータスコード429を返し、Bedrockの呼び出しを行わない。上限値は1ユーザー当たり1日20回とし、環境変数 `CHAT_DAILY_QUOTA` で変更可能とする。

### 5.4 ingest-fn

ドキュメントの取込処理を担当するLambda関数である。SQSイベントをトリガーに起動し、以下の処理を順次実行する。

- テキスト抽出
- チャンク生成
- Embedding生成
- S3 Vectorsへ登録

対応ファイル形式はPDF、Markdown、txtとする。PDFのテキスト抽出には pypdf を利用する。

チャンク分割の仕様は1チャンク当たり500文字、オーバーラップ50文字とし、段落、行、単語、文字の優先順位で分割する。Embeddingモデルには chat-fn の検索側と同一の Cohere Embed 4（`cohere.embed-v4:0`、1536次元）をBedrock経由で使用し、取込側の `input_type` には `search_document` を指定する。

Embeddingに渡すテキストは事前にNFKC正規化を行い、全角英数や半角カナの表記揺れを吸収する。同様の正規化を chat-fn の検索クエリにも適用し、取込側と検索側でベクトル空間の一貫性を保つ。ただし、S3 Vectorsに格納する `text` メタデータは原文のまま保持する。これは、NFKC正規化によって「①」が「1」へ変換されるなどの文字変化が生じ、回答の引用表示に影響を与えるのを防ぐためである。

本関数はHTTPリクエストを直接受け取らないため、Lambda Web Adapterは使用せず通常のLambda Handlerで実装する。また、chat-fn が使用するLangChain関連ライブラリはイメージに含めないため、チャンク生成およびEmbedding呼び出しはRAGパイプラインとコードを共有せず、ingest-fn 側に独立した実装を持つ。

各チャンクのベクトルは `<documentId>#<チャンク番号>` をキーとして登録する。取込に成功したドキュメントは総チャンク数をDynamoDBに保存し、再取込時にチャンク数が減少した場合は不要となった既存ベクトルを削除する。

取込失敗時はステータスを failed に更新した上で例外を送出する。SQSは1メッセージずつ処理し、3回連続で失敗したメッセージはDLQへ退避させる。キューの可視性タイムアウトは900秒に設定し、ingest-fn のLambdaタイムアウト（600秒）より長く設定する。可視性タイムアウトが短すぎると、Lambdaの処理完了前にメッセージが再度可視化され、別プロセスで重複処理されるリスクが生じるためである。

## 6. 処理フロー

アップロードと取込は独立したフローとして分離する。取り込んだドキュメントは削除フローによって一括消去する。

### 6.1 アップロードフロー

ファイルはLambdaを経由せず、SPAからS3へ直接アップロードする。処理は以下の3ステップで構成される。

```text
① 署名付きURL取得

SPA
    │
    ▼
api-fn

status = uploading

② Upload

SPA
    │
 PUT
    ▼
S3

③ Upload完了登録

SPA
    │
    ▼
api-fn

status = uploaded
```

SPAはまず api-fn からアップロード用の署名付きURLを取得する。api-fn はこの時点でドキュメントレコードを uploading ステータスで作成する。これにより、未完了状態のアップロードを事後監視でき、ログ追跡が容易になる。

SPAは取得したURLに対してファイルをPUT送信し、最後に api-fn へ完了登録を行う。完了登録を受け取った時点でステータスが uploaded へ遷移する。

### 6.2 取込フロー

Embedding生成はS3へのファイル保存をトリガーとせず、ユーザーが取込アクションを実行したタイミングで開始する。なお、取込アクションを実行できるのは、該当ドキュメントをアップロードしたユーザー本人のみに限定される。

```text
SPA
↓
api-fn
↓
SQS
↓
ingest-fn
```

api-fn は取込リクエストを受け取るとSQSへメッセージを送信し、ingest-fn がそれをキューから受信して非同期処理を実行する。処理に失敗したメッセージはDLQへ退避される。

ドキュメントステータスの遷移は以下の通り。

```text
uploading
    ↓
uploaded
    ↓
processing
    ↓
ingested または failed
```

取込処理中は processing となり、成功時は ingested、失敗時は failed に推移する。failed ステータスのドキュメントは手動で再取込を実行できる。

### 6.3 削除フロー

ドキュメント削除は、該当ドキュメントをアップロードした（取込を行った）ユーザー本人のみが実行可能であり、実行時にはベクトル・S3原本・DynamoDBレコードを一括で削除する。

```text
SPA
    │
    ▼
api-fn
    │
    ├─▶ S3 Vectors  ベクトル削除
    │
    ├─▶ S3          原本削除
    │
    └─▶ DynamoDB    レコード削除
```

api-fn はこれら3つのストアから順番にデータを削除する。途中で処理が失敗した場合でもDynamoDBのレコードが残るため、ユーザーが削除を再実行することで削除漏れを解消できる。なお、S3 VectorsおよびS3は、存在しないキーやオブジェクトの削除要求をエラーにしないため、同一手順を再実行しても副作用は発生しない。

取込処理中のドキュメントは削除不可とする。取込中に削除を許容すると、ingest-fn が後からベクトルを登録してしまい、DynamoDBレコードを持たない孤立ベクトルが残存するためである。

## 7. RAGパイプライン

チャットの回答生成には、LangGraphで実装したSelf-RAGアーキテクチャを採用する。生成した回答の品質を自己評価し、不十分な場合は自動で再試行を行う。

### 7.1 処理フロー

パイプラインの処理フローを以下に示す。

![質問からMulti Query、ベクトル検索、RRF、Rerank、回答生成、自己評価、最大1回のリトライを経て回答に至るRAGパイプライン](./diagrams/RAGパイプライン.svg)

入力質問からMulti Queryによって複数の検索クエリを生成し、クエリごとにS3 Vectorsでベクトル検索を実行する。検索結果はRRF（Reciprocal Rank Fusion）で統合し、上位ドキュメントをRerankによって関連度順に絞り込んだ上で、LLMが回答を生成する。生成結果は自己評価を行い、品質が不十分な場合は最大1回までリトライを実行する。

### 7.2 使用モデル

採用するモデル構成は以下の通り。

| 用途 | モデル | Bedrockのモデル/プロファイルID |
|------|--------|------------------|
| 回答生成 | Nova 2 Lite | `jp.amazon.nova-2-lite-v1:0` |
| クエリ生成 / 自己評価 / 失敗分析 | Nova 2 Lite | `jp.amazon.nova-2-lite-v1:0` |
| Embedding | Cohere Embed 4 | `cohere.embed-v4:0` |
| Rerank | Cohere Rerank 3.5 | `cohere.rerank-v3-5:0` |

4つのチェーン全てで同一モデル（Nova 2 Lite）を使用するが、回答生成と補助処理で設定値を独立して管理する。これにより、将来的に回答生成モデルのみを切り替えることが可能となる。クエリ生成および自己評価には構造化出力を使用するため、JSON Schemaの件数制約を遵守できるモデルを選定している。

回答生成の第一候補モデルは GPT-5.6 Luna であったが、モデル利用契約とは別にAWSアカウント単位の審査があり、本アカウントは現時点で基準を満たさない旨の回答をAWSより受けている。上表は申請が承認されるまでの代替構成である（ADR-0016）。

データ保持のリージョン要件は特段指定されていないが、採用モデルはいずれも国内リージョン内で完結して処理される。Cohereの2モデルは ap-northeast-1 のオンデマンド推論を使用し、Nova 2 Liteは東京・大阪を束ねる jp プロファイルを使用する。

オンデマンド推論のクォータ制限について、AWS既定値は Cohere Embed 4 が毎分1,000リクエスト、Cohere Rerank 3.5 が毎分250リクエストであるのに対し、現在のアカウントにはそれぞれ 10リクエスト/分、3リクエスト/分 が適用されている。1回のチャット処理でクエリ数分のEmbedding呼び出しと1回のRerank呼び出しが発生し、リトライ時には倍増するため、現在の制限値では同時アクセス発生時にスロットリングが発生するリスクがある。

### 7.3 パラメータ

各処理のパラメータ値は移植元実装に準拠する。

- Multi Query: 3〜5個の検索クエリを生成
- Vector Search: クエリごとに $k=5$  で全ユーザーのドキュメントを横断検索
- RRF: $k=60$ で検索結果を統合し、上位20件を抽出
- Rerank: RRFの上位20件から関連度の高い5件に絞り込み
- Self Evaluation: useful / useless / hallucination の3段階評価および feedback を返却
- Retry: 最大1回。リトライ上限到達時は失敗分析を生成して終了

## 8. データ設計

### 8.1 DynamoDB

DynamoDBはシングルテーブル設計を採用し、以下の4エンティティを単一テーブルで管理する。

- Users
- Documents
- Chat
- Chat Messages
- Quota

パーティションキーおよびソートキーの設定例は以下の通り。

```text
PK = USER#123
SK = CHAT#01K0R9WJH2T4Q6ZB8XN3E5VM7C
```

ドキュメントおよびチャットの識別子にはULIDを採用する。ULIDは先頭にミリ秒精度のタイムスタンプを持つため、辞書順ソートがそのまま作成日時順となる。ユーザーを示すPKと、エンティティ種別およびIDを組み合わせたSKにより、ユーザー単位の作成日時順一覧取得を実現する。

全ユーザー横断のチャット履歴取得にはGSIを使用する。GSIはChatとDocumentsで共用する。

```text
Chat:
  GSI1PK = CHAT
  GSI1SK = <chatId>

Document:
  GSI1PK = DOC
  GSI1SK = <documentId>
```

チャット一覧は `GSI1PK = CHAT`、ドキュメント一覧は `GSI1PK = DOC` 条件でQueryを実行して取得する。Scan処理やユーザーごとの個別Query呼び出しは行わない。GSI1SKにULIDが設定されているため、結果は自動的に作成日時順でソートされる。チャット詳細や閲覧用URL発行など、IDのみを指定した所有者を問わないデータ参照も同GSIへのQueryで実行する。

ユーザー情報はCognitoをマスターとし、サインイン時に表示名およびメールアドレスをDynamoDBに更新登録する。本データは `/user/{user_id}` 画面表示用のキャッシュデータである。

チャットデータには、生成クエリ、検索ドキュメント、回答内容、評価結果、および失敗分析結果を保存する。

チャットの利用回数は `SK = QUOTA#<JSTの日付>` の形式のアイテムで管理する。日付をキーに含めることで日毎に自動で別アイテムとなるため、カウントのリセット処理を実装する必要がない。過去ログは `expiresAt` 属性に基づくDynamoDB TTL機能により自動削除される。なお、TTLを設定しているエンティティはQuotaのみである。

### 8.2 S3

S3バケットは以下の2用途で使用する。

- SPAの静的コンテンツ配信
- アップロードされたドキュメントファイルの保存

### 8.3 S3 Vectors

S3 Vectorsは、Embeddingベクトルの保存および類似度検索に利用する。Embeddingはテキストを意味情報を保持した固定長数値ベクトルに変換したデータであり、コサイン類似度によって文章間の関連性を測定できる。インデックスの次元数は Cohere Embed 4 に合わせて 1536次元、距離計算アルゴリズムにはコサイン類似度を指定する。なお、次元数はインデックス作成後に変更できないため、モデル変更時はインデックスの再作成が必要となる。

各ベクトルには以下のメタデータを付与する。

| Key | フィルタ | 用途 |
|-----|---------|------|
| documentId | 可能 | 検索結果から原本ドキュメントを特定するためのID |
| text | 不可 | チャンク本文（回答生成のコンテキストとして利用） |
| filename | 不可 | 回答の出典元ファイル名表示 |

`text` および `filename` はフィルタ不可のメタデータとして登録する。フィルタ可否の設定はインデックス作成後に変更できないため、初期定義時に明示する。

ベクトルのキー構造は `<documentId>#<チャンク番号>` とする。S3 Vectorsの DeleteVectors APIはキーの直接指定のみをサポートし、メタデータ条件による一括削除に対応していない。そのため、ドキュメント削除時はDynamoDBに保持している `chunkCount` から削除キーリストを組み立てて実行する。整合性を担保するため、ingest-fn はベクトル登録前に `chunkCount` を事前に更新する。

ベクトル検索は全ユーザーのドキュメントを対象とした横断検索とし、ユーザーIDによるフィルタリングは行わない。

## 9. インフラ設計

### 9.1 CDKスタック構成

インフラストラクチャは AWS CDK で管理し、CertificateStack、DataStack、AppStack、EdgeStack、CiStack の5つのスタックに分割して構築する。

分割基準はリソースの変更頻度・ステートの有無に基づいている。ユーザーデータやドキュメントデータが蓄積されるステートフルなリソースは DataStack に集約し、変更頻度の高いアプリケーション層と分離する。認証基盤のCognitoも、ユーザーデータが蓄積されるため DataStack で管理する。CiStack はGitHub Actionsとの連携に必要なOIDCアイデンティティプロバイダおよびデプロイ用IAMロールのみを保持し、アプリケーションリソースは含まない。

例外として、SPA配信用のS3バケットは EdgeStack で管理する。これはOACによるアクセス制御を行う関係上、バケットポリシーが CloudFront ディストリビューションを参照する必要があるためである。

CertificateStack のみ、リージョン要件を理由にスタックを分離している。CloudFrontに設定するACM証明書は us-east-1 リージョンで作成する必要があるため、本スタックのみ切り出してデプロイし、他の4スタック（ap-northeast-1）と分離している。スタック間のパラメータ受け渡しはデプロイ時に参照元スタックの出力を取得する方式を採用しており、リージョンを跨ぐ設定連携でも追加のリソース作成は発生しない。

#### appDomainによる循環参照の回避

スタック間の依存関係は EdgeStack → AppStack → DataStack の一方向とする。CloudFrontはAPI Gatewayを参照し、LambdaはDynamoDBやS3を参照する構成である。EdgeStack は DataStack も直接参照する。これは、CSP（Content Security Policy）の `connect-src` にCognitoおよびドキュメント保存用S3バケットのオリジンを設定するためである([9.2](#92-cloudfront))。

一方、CognitoのコールバックURLおよびS3バケットのCORS許可オリジンには、SPAの公開ドメイン名が必要となる。このドメインを処理するのはCloudFrontであるため、DataStack から EdgeStack を直接参照するとスタック間で循環参照が発生する。

循環参照を回避するため、DataStack は EdgeStack を参照せず、外部からドメイン名を受け取る設計とする。パラメータ受け渡しにはCDKコンテキストの `appDomain` を利用し、既定値を `cdk.json` に定義する。独自サブドメインを利用する構成ではドメイン名が事前確定するため、デプロイごとの個別のパラメータ指定は不要であり、設定漏れによる不整合も防ぐことができる。

環境構築は単一ステージのみとする。dev/prod環境の分離は行わず、開発スピードを最優先とする。

### 9.2 CloudFront

SPAの公開ドメインは`https://rag.business-efficiency.pro`とする。CloudFrontの代替ドメイン名（CNAME）に本サブドメインを設定し、ACMでDNS検証・発行した証明書を関連付ける。DNS管理はお名前.comで行うため、証明書検証用CNAMEレコードおよびドメインルーティング設定はCDKの管理対象外となる。サブドメインを採用した理由は[ADR-0013](./adr/0013-custom-domain-subdomain-external-dns.md)に記載する。

CloudFrontはリクエストパスに応じて以下の3つのオリジンへルーティングを行う。

```text
/                  → S3
/api/chats/stream  → API Gateway (chat-fn)
/api/*             → API Gateway (api-fn)
```

ルートパスはSPAの静的コンテンツを格納したS3へルーティングし、`/api/*` はAPI Gatewayへ転送する。API側の2つのビヘイビアは同一のAPI Gatewayを指すが、SSEストリーミングと通常のREST APIでタイムアウトおよび圧縮の設定要件が異なるため、個別オリジンとして定義し、`/api/chats/stream` の優先評価を行う。どのLambda関数へルーティングするかはAPI Gateway側で判定する。

API向けのビヘイビアではキャッシュを無効化し、`Host` ヘッダーを除く全てのビューワーヘッダーをオリジンへ転送する。これにより、Cognitoアクセストークンを含む `Authorization` ヘッダーがAPI Gatewayのオーソライザおよびバックエンドまで透過する。`Host` ヘッダーを転送対象外とするのは、API Gatewayが `Host` ヘッダーに基づいてAPIのルーティング識別を行うためである。

SSEによるストリーミング配信は、Lambda、Lambda Web Adapter、API Gateway、CloudFrontのいずれかでレスポンスのバッファリングが発生すると正常に機能しない。そのため、chat-fn の通信経路には以下の設定を適用する。

| 対象 | 設定 | 理由 |
|------|------|------|
| chat-fn | `AWS_LWA_INVOKE_MODE=response_stream` | Lambda Web Adapterをレスポンスストリーミングモードに設定 |
| API Gateway | Response Transfer Mode: STREAM | 既定の BUFFERED では全データ完了までレスポンスが保持され、ストリーミング不可となるため |
| API Gateway | 統合タイムアウト: 300秒 | ストリーム全体のタイムアウト上限。chat-fn のLambdaタイムアウトに合わせる（STREAMモードは最大15分まで設定可能） |
| CloudFront | Origin Response Timeout: 60秒 | イベント間の無通信タイムアウト上限（ストリーム全体の制限ではない） |
| CloudFront | Origin KeepAlive Timeout: 20秒 | オリジンとの永続接続を維持し、イベントごとの再接続オーバーヘッドを回避 |
| CloudFront | 圧縮: 無効 | 圧縮に伴うバッファリングによるデータ到達遅延を防ぐため |

ストリーム全体の処理時間上限はAPI Gatewayの統合タイムアウト（300秒）が適用され、CloudFrontの60秒設定はイベント間の無通信間隔上限として機能する。KeepAlive設定により接続を維持し、通信の安定化を図る。

SPAでのクライアントサイドルーティング実行時、/chats/{chatId} などのパスに対応する実ファイルはS3上に存在しない。そのため、拡張子を含まないリクエストURIを /index.html へ内部書き換えする CloudFront Function をS3ビヘイビアにのみ適用する。なお、CloudFrontのカスタムエラーレスポンス機能はディストリビューション全体に影響し、API Gatewayが返却するエラーレスポンスまで上書きしてしまうため採用しない。

#### レスポンスヘッダー

S3向けビヘイビアに `ResponseHeadersPolicy` を適用し、セキュリティヘッダーを付与する。本設定はAPI向けビヘイビアには適用しない。CSPが有効に機能するのは、ブラウザがHTMLとしてレンダリングするSPAの通信経路のみだからである。

CSP設定は、アクセストークンを localStorage に保存する設計([ADR-0010](./adr/0010-token-storage-localstorage.md))に対するセキュリティ補強策であり、万が一XSS脆弱性が存在した場合でも、不正スクリプトの実行や外部への情報送信を阻止することを目的とする。

```text
default-src 'self';
connect-src 'self' <Cognitoのissuer>/ <Hosted UIのドメイン> <ドキュメント用S3バケット>;
object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
```

SPAが外部へ発行する通信は以下の3系統に限定されるため、`connect-src` ではこれらのみを追加許可する。API呼び出しおよびチャットSSE通信はCloudFront経由の同一オリジン通信となるため、`'self'` の指定でカバーされる。

| 許可先 | 用途 |
|------|------|
| Cognitoのissuer | `oidc-client-ts` が参照する OpenID Configuration および JWKS |
| Hosted UIのドメイン | トークンエンドポイント（issuerとホストが異なるため明示許可） |
| ドキュメント用S3バケット | 署名付きURLに対するダイレクトPUT通信([6.1](#61-アップロードフロー)) |

ドキュメント用S3バケットの許可ホストは、api-fn が生成する署名付きURLのホストと完全に一致させる必要がある。boto3のデフォルト挙動ではリージョン名を含まないグローバルエンドポイントへの変換や非推奨の SigV2 署名が行われる場合があるため、SigV4 および virtual-hosted style を明示的に指定してURLを生成する。

なお、ログイン・ログアウト処理は Hosted UI 画面への直接遷移であり、原本ドキュメントの閲覧も署名付きURLへの画面遷移であるため、これらは `connect-src` の制限対象外となる。

Cognitoの issuer URL設定時には末尾にスラッシュ / を付与する。CSPの仕様上、パス末尾にスラッシュが存在する場合にのみ前方一致判定が行われ、スラッシュがない場合は完全一致判定となり /.well-known/ 配下の参照がブロックされるためである。ドメイン単位ではなく User Pool の完全パスを指定することで、同一ホスト上に存在する他 User Pool への不正送信を防止する。

Viteによるビルド成果物は外部JS/CSSファイルのみで構成され、インラインスクリプトやインラインスタイルは含まれない。そのため `'unsafe-inline'` は許可しない。`object-src`、`base-uri`、`form-action` は `default-src` のフォールバックが適用されないため個別明示する。`X-Frame-Options` は `frame-ancestors 'none'` により代替されるため設定しない。

同一ポリシー内で以下のセキュリティヘッダーも同時に配信する。

| ヘッダー | 値 | 目的 |
|------|------|------|
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains` | 以降の通信をHTTPSに強制（preload登録はApexドメイン単位となるため未指定） |
| `X-Content-Type-Options` | `nosniff` | Content-Typeを無視したMIMEスニッフィング攻撃を防止 |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | クロスオリジン遷移時にパスやクエリ文字列を除外し、オリジン情報のみ送信 |

### 9.3 API Gateway

API Gatewayは api-fn および chat-fn への唯一の公開アクセス経路であり、CloudFrontからの `/api/*` リクエストを受け取る。エンドポイントタイプは、前段にCloudFrontを配置する構成のため「リージョナル」を選択する。Lambda Function URLを採用しない理由は[ADR-0011](./adr/0011-api-gateway-migration.md)に記載する。

API Gatewayの役割は、後続のLambda起動前に不正リクエストを遮断することである。Cognito User Poolオーソライザが `Authorization` ヘッダー内のアクセストークンを検証し、無効なトークンによるリクエストはLambdaへ到達させない。オーソライザを適用しない未認証エンドポイントは `/api/health` のみとする。各APIメソッドには認可スコープ `openid` を明示する。スコープ未指定の場合、オーソライザはトークンをIDトークンとして検証するため、アクセストークンを送信する本システムでは全リクエストが401エラーとなる。APIステージには レート: 20リクエスト/秒、バースト: 40リクエスト のスロットリング制限を設定し、有効トークンを用いた大量リクエスト攻撃に対する保護を行う。

リソースは、FastAPIのルート構成に合わせて次のとおり定義する。

```text
/api/health          GET   → api-fn (認可なし)
/api/chats/stream    POST  → chat-fn
/api/chats           ANY   → api-fn
/api/chats/{proxy+}  ANY   → api-fn
/api/{proxy+}        ANY   → api-fn
```

統合タイプにはLambdaプロキシ統合を使用し、詳細なパスルーティングはFastAPI側で処理する。`/api/chats` 配下には chat-fn と api-fn の両方のルートが存在するため、グリーディパス（{proxy+}）のみでは正しく振分けできない。API Gatewayの仕様上、グリーディパスよりも具体的なリソース定義が優先されるため、`/api/chats/stream` を個別リソースとして明示的に定義し、それ以外のリクエストをグリーディパスで受ける構成とする。

オーソライザが検証するのは、トークンの正当性および `openid` スコープの有無までである。要求されたドキュメントやチャットデータに対する個別のアクセス認可は、api-fn および chat-fn 側で判定する。バックエンド側でも独自にJWTを検証し、署名チェックに加えて `token_use` や `client_id` の妥当性を確認した上で、`sub` クレームをユーザー識別に使用する。

### 9.4 モデル呼び出しの認可

推論処理は全てAmazon Bedrockを経由して実行するため、アプリケーション側で外部APIキーを保持・管理する必要はない。権限管理はLambdaの実行ロールに集約し、CDKにより関数ごとに最小限のモデルアクセス権限を付与する(ADR-0016)。

chat-fn には使用する4モデル全てに対する `bedrock:InvokeModel` 権限と `bedrock:Rerank` 権限を付与する。ingest-fn にはEmbeddingモデルに対する `bedrock:InvokeModel` 権限のみを付与する。api-fn はモデル呼び出しを行わないため権限を付与しない。なお、SSE配信ではノード単位のState更新のみを行い、LLMのトークン単位ストリーミングは使用しないため、`bedrock:InvokeModelWithResponseStream` 権限は付与しない。

`bedrock:Rerank` アクションのみ、リソースARNに `*` を指定する。本アクションがIAMのリソースレベル権限指定に対応していないためである。呼び出し可能なリランクモデルの制限は `bedrock:InvokeModel` 側のリソース指定によって担保する。

モデルARNの指定において、オンデマンド推論モデルは基盤モデルのARNを指定し、推論プロファイル経由で呼ぶモデルはプロファイルARNと配下の基盤モデルARNの両方を指定する。推論プロファイル専用モデルの場合、両方のARNを許可しないと権限エラーとなる。Cohereの2モデルは前者に該当し、Nova 2 Liteは後者に該当する。また、将来的に GPT-5.6 Luna が利用可能となった際に環境変数変更のみで切り替えられるよう、同モデルへの権限も予め付与している。

推論プロファイルのうち、jp プロファイルは呼び出し先が東京および大阪リージョンに限定されるのに対し、global プロファイルは任意のリージョンへリクエストをルーティングする。ルーティング先リージョンを事前特定できないため、基盤モデル側のアクセス許可はリージョンを限定せずに設定する。なお、Bedrockモデルアクセスの有効化はアカウント・リージョンごとの手動作業であり、手順詳細は `cdk/README.md` に記載する。

## 10. 運用設計

### 10.1 ロギング・モニタリング

ロギングおよびモニタリングには AWS Powertools for AWS Lambda を導入し、以下の機能を活用する。

- Structured Logging（構造化ログ）
- Metrics（カスタムメトリクス）
- Tracing（分散トレーシング）

全サービス間で Request ID を透過・引き継ぎし、単一リクエストの処理過程をサービス横断で追跡可能にする。api-fn が採番した Request ID はドキュメント取込メッセージにも付与し、ingest-fn のログまで追跡コンテキストを統合する。

#### メトリクス

Metrics機能はEMF（Embedded Metric Format）形式のJSONを標準出力へ書き出し、CloudWatch Logsがこれを自動解析してカスタムメトリクスとして記録する。メトリクスの名前空間は `EventDrivenRag` とし、以下の5種類のメトリクスを発行する。

| メトリクス | 発行元 | 内容 |
| --- | --- | --- |
| DocumentsIngested | ingest-fn | 取込成功ドキュメント数 |
| DocumentIngestFailures | ingest-fn | 取込失敗ドキュメント数 |
| IngestedChunks | ingest-fn | S3 Vectorsへ登録した総チャンク数 |
| AnswersGraded | chat-fn | 自己評価の結果別の回答数 |
| ChatRetries | chat-fn | 再試行の発生回数 |

CloudWatchカスタムメトリクスの課金および無料枠は、「メトリクス名 + ディメンション」の組み合わせ単位でカウントされる。本構成において AnswersGraded は評価結果（3パターン）をディメンションに持つため3メトリクスとして数えられる。その他4種は各1メトリクスのため合計7メトリクスとなり、CloudWatchの無料枠（10メトリクス）内に収まる。なお、api-fn からのビジネスメトリクス発行は行わない。

chat-fn は標準的なLambda Handler構成をとらないため、SSEレスポンス配信完了時にアプリケーションコードから明示的にメトリクスをフラッシュ（送信）する。ただし、処理途中でエラーが発生した場合やクライアント側で通信が切断された場合は送信を行わず、正常完走したチャットのみをカウント対象とする。本仕様はDynamoDBへのデータ永続化条件と一致させている。

#### トレース

3つのLambda関数およびAPI Gatewayステージでアクティブトレーシングを有効化し、AWS X-Rayでリクエストの処理経路とレイテンシーを追跡する。アプリケーション内部のトレース処理は api-fn および ingest-fn で実装し、DynamoDB・S3・SQS・S3 Vectors・BedrockへのAPI呼び出しに加え、リクエスト全体処理および取込処理の各ステップをサブセグメントとして記録する。サブセグメントには Request ID をアノテーションとして付与し、ログとトレースの相互参照を可能にする。

ingest-fn は標準のLambda Handler構造であり、X-Rayコンテキストをランタイムから直接受け取る。一方、api-fn および chat-fn が利用する Lambda Web Adapter は、X-Rayのトレースヘッダーをアプリプロセスへ直接転送しない。また、ランタイムがリクエストごとに更新する環境変数はアプリの実行プロセスから参照できない。そのため、Lambda Web Adapterがヘッダー転送する Lambda Context 内のトレースIDからX-Rayコンテキストを復元・再構築する。

なお、chat-fn 内ではアプリケーションレベルの細かなトレース処理を行わない。これは、RAGパイプラインがベクトル検索を非同期並列実行する際、X-Ray SDKのスレッドローカルコンテキストが破損する問題があるためである。本判断の経緯は[ADR-0014](./adr/0014-xray-app-instrumentation-scope.md)に記載する。アプリケーション内トレースを除外した場合でも、Lambda自体の実行セグメントは記録されるため、サービスマップの生成および関数単位のレイテンシー把握は可能である。ノードごとの詳細処理時間は構造化ログに出力して追跡する。

#### アラーム

ingest-fn の処理がリトライ上限を超えた場合、該当メッセージはDLQへ退避される。放置による検知漏れを防ぐため、DLQのメッセージ数が1以上になった段階でCloudWatchアラームを発報し、Amazon SNSトピック経由で管理者へメール通知する。なお、通知先メールアドレスの購読確認（Subscription Confirm）は手動で実施する。アラーム数も無料枠（10個）を考慮し、監視アラームはこの1本に絞って構築する。

### 10.2 CI/CD

CI/CDパイプラインは GitHub Actions で構築する。プルリクエスト作成時は lint および自動テストによる検証のみを実行し、`main` ブランチへのマージをトリガーとして自動デプロイを実行する。

AWSへの認証には OIDCを使用し、長期アクセスキーはGitHub上に保存しない。CiStack で作成するデプロイ用IAMロールの信頼関係ポリシーは、該当リポジトリの `main` ブランチからのリクエストのみに厳格に限定する。

ワークフローが実行するのはアプリケーションコードの更新処理のみであり、インフラ構成の変更は手動での `cdk deploy` 実行とする。`cdk deploy` は内部で CloudFormation の CreateStack / UpdateStack 等を呼び出すため、これを自動ワークフローに含めると、デプロイ用ロールにIAM権限変更やネットワーク構成変更を許可する過大な権限を付与する必要が生じる。インフラデプロイを切り離すことで、CI/CD用ロールの権限を S3同期、ECRプッシュ、Lambdaコード更新 などの限定的な操作に絞り込むことができる。

デプロイ処理に必要なS3バケット名やLambda関数名などのリソース情報はGitHub側に静的保持せず、各スタックの出力を `DescribeStacks` APIで都度取得する。SPAビルド時に埋め込むCognito設定値等も同様に動的取得し、インフラ再構築時にも設定の同期ズレが発生しない構成とする。

CI/CDの全体像を以下に示す。

![GitHub ActionsからOIDCでAssumeRoleし、SPAをS3へ同期、イメージをECRへプッシュしてLambdaを更新するCI/CD構成](./diagrams/CICD設計図.svg)

フロントエンドは、ビルド後の静的ファイルをS3へ同期し、CloudFrontのキャッシュ削除を実行して変更を反映する。バックエンドは、Dockerイメージをビルドして Amazon ECR へプッシュし、3つのLambda関数のイメージタグを更新してデプロイを完了する。

## 11. コスト

### 11.1 コスト方針

固定費の発生を徹底的に回避するため、以下の常駐型・従量課金最小枠の大きいリソースは使用しない。

- VPC
- NAT Gateway
- ECS
- EC2
- Aurora

Lambdaの Provisioned Concurrency（事前割り当て）も使用しない。コールドスタートによる応答遅延が顕著な課題となった場合のみ、chat-fn への適用を検討する。

### 11.2 コスト構造

インフラ費用は、利用量に依存しない固定ストレージ費用（約\$0.4/月）に、チャット1件当たり約\$0.0004の従量課金が加算される構造である。従量課金の内訳は、chat-fn の実行時間、およびAPI Gatewayと api-fn のリクエスト課金である。

サービスごとの課金対象項目は以下の通り。

| Service | 課金対象 |
|---------|---------|
| Lambda | 実行時間（GB-秒）およびリクエスト数 |
| API Gateway | リクエスト数 |
| DynamoDB | 読み書きキャパシティ（On-Demand）およびストレージ容量 |
| S3 | ストレージ容量およびAPIリクエスト数 |
| S3 Vectors | ストレージ容量および検索リクエスト数 |
| X-Ray | 記録トレース数 |
| CloudFront | 無料枠内（1TB/月まで無料） |
| Cognito | 無料枠内（10,000 MAUまで無料） |
| SQS | 無料枠内（100万リクエスト/月まで無料） |
| CloudWatch | 無料枠内 |
| SNS | 無料枠内 |

詳細な単価計算および常駐型構成との損益分岐点比較は[コストモデルと損益分岐点](./cost-comparison.md)に記載している。

モニタリング構成はすべて無料枠内に収まるよう設計している。カスタムメトリクス数は7個、アラーム数は1個であり、いずれも無料枠の上限（10個）以下である。X-Rayトレーシングは月間10万件まで無料であるが、1回のチャット処理でAPI Gateway等へ約3リクエストが発生するため、月間約3万チャットに達した時点で無料枠を超過する。

Bedrockの推論費用は上記インフラ費用とは別に従量課金される。Self-RAGアーキテクチャでは1回のチャットで最大7回のLLM呼び出しが発生するため、単価の低いモデルを選択してコストを抑える。1チャットあたりの実測トークン量（入力5,514、出力485）に東京リージョンのNova 2 Liteの単価を当てると、LLM推論費が約\$0.0038、Rerank処理費が\$0.0020で、合計約\$0.006となる。

推論費用には自動的な利用量上限が存在しないため、1ユーザーあたり1日20回までの利用制限（Quota）を設ける。これにより月額最大費用を確実にキャップする。Quota消費に伴うDynamoDB書き込みがチャット1件につき1回増加するが、全体コストに与える影響は軽微である。

## 12. 関連ドキュメント

各種設計判断の根拠、検討した代替案、およびトレードオフは以下のADRに記録している。

- [ADR-0001: サーバーレス構成による固定費回避方針](./adr/0001-serverless-zero-fixed-cost.md)
- [ADR-0002: SPAによる静的配信を採用する](./adr/0002-spa-no-ssr.md)
- [ADR-0003: 単一のDockerfileから責務別に3つのLambdaをビルドする](./adr/0003-single-dockerfile-three-lambdas.md)
- [ADR-0004: Cognito Hosted UI採用、バックエンドはJWT検証のみ](./adr/0004-cognito-jwt-verification-only.md)
- [ADR-0005: ベクトルDBにS3 Vectorsを採用](./adr/0005-s3-vectors.md)
- [ADR-0006: 永続化先にDynamoDBを採用し、シングルテーブルで設計する](./adr/0006-dynamodb-single-table.md)
- [ADR-0007: 署名付きURLによる直接アップロードと取込の分離](./adr/0007-upload-ingest-separation.md)
- [ADR-0008: APIキー管理にSSM Parameter Storeを採用](./adr/0008-ssm-parameter-store.md) — ADR-0016により失効
- [ADR-0009: Lambda Function URLをCloudFront OACで保護しない](./adr/0009-function-url-no-oac.md) — ADR-0011により失効
- [ADR-0010: トークンをlocalStorageへ保存する](./adr/0010-token-storage-localstorage.md)
- [ADR-0011: api-fnとchat-fnの公開経路をAPI Gatewayへ移行する](./adr/0011-api-gateway-migration.md)
- [ADR-0012: チャットのSSEをPOSTとAuthorizationヘッダーで配信する](./adr/0012-sse-post-with-authorization-header.md)
- [ADR-0013: 独自ドメインはサブドメインで公開し、DNSをお名前.comに置く](./adr/0013-custom-domain-subdomain-external-dns.md)
- [ADR-0014: X-Rayのアプリ内トレース処理をapi-fnとingest-fnに限定する](./adr/0014-xray-app-instrumentation-scope.md)
- [ADR-0015: ドキュメントを物理削除し、ベクトルはキーの再構成で消す](./adr/0015-document-hard-delete.md)
- [ADR-0016: 推論の呼び出し経路をAmazon Bedrockへ統一する](./adr/0016-bedrock-inference.md)
- [ADR-0017: チャット利用量のデイリークォータ導入方針](./adr/0017-chat-daily-quota.md)

認証仕様の詳細およびコスト試算の根拠については、以下のドキュメントを参照のこと。

- [authorization.md](./authorization.md)
- [cost-comparison.md](./cost-comparison.md)
