# 社内RAGチャットアプリ

社内ドキュメントを横断検索し、根拠となる情報源を添えて回答するRAGチャットアプリ。AWSのサーバーレスサービスのみで構成し、固定費を抑えた運用を実現します。

## デモ

https://github.com/user-attachments/assets/281f1c77-528e-4e81-9cb9-13ff9673abb9

サインインからドキュメントのアップロード・取込、チャットでの質問、回答根拠の確認、プロフィール画面での履歴確認までの一連の流れです。

## 背景と目的

手順書や過去の案件資料といったプロジェクト固有のドキュメントは、蓄積が進むにつれて保管場所が分散し、どこに何があるかを把握しづらくなります。また、ファイルにアクセスできたとしても情報量が多ければ、必要な情報を探すのに時間がかかります。

本アプリは、社内ドキュメントを対象としたRAGチャットにより、目的の情報への迅速なアクセスを実現することを目的としています。回答の根拠となったドキュメントをユーザー自身で確認できるほか、チャット履歴をナレッジとして全ユーザーで共有・閲覧できます。

## アーキテクチャ

![アプリ設計図](./docs/diagrams/アプリ設計図.svg)

ブラウザからのリクエスト経路は以下の3つに分かれます。

1. Cognito Hosted UI によるユーザー認証
2. CloudFront 経由の画面表示およびAPI呼び出し
3. 署名付きURL を利用したS3への直接アップロード

`/api/*` へのリクエストは API Gateway へ転送され、Cognitoオーソライザでアクセストークンを検証した上で Lambda に引き渡されます。

バックエンドは FastAPI の単一コードベースを1つの Dockerfile でビルドし、責務に応じて3つの Lambda へデプロイしています。

| Function | 責務 | 実行構成 |
|---|---|---|
| api-fn | REST API（チャット履歴・ドキュメント・プロフィールの一覧取得、チャット詳細取得、署名付きURL発行、取り込み開始、ドキュメント削除） | Lambda Web Adapter / 512MB / 30秒 |
| chat-fn | LangGraphによるSelf-RAGの実行およびSSE配信 | Lambda Web Adapter（ストリーミング） / 1024MB / 300秒 |
| ingest-fn | テキスト抽出・チャンク分割・Embedding生成・S3 Vectors登録 | SQSトリガー / 1024MB / 600秒 |

ファイルのアップロードとデータの取込処理は、ユーザー操作レベルで分離しています。ファイルは Lambda を経由させず S3 へ直接 PUT し、Embedding 生成処理はユーザーが取込を実行したタイミングで SQS 経由で開始します。ドキュメントのステータスは `uploading → uploaded → processing → ingested | failed` の順に遷移します。

回答生成には Self-RAG を採用しています。Multi Query、ベクトル検索、RRFによる結果統合、Rerank、回答生成、自己評価、および最大1回のリトライまでの一連のフローを LangGraph で構築しています。

![RAGパイプライン](./docs/diagrams/RAGパイプライン.svg)

![CICD設計図](./docs/diagrams/CICD設計図.svg)

CI/CD パイプラインは GitHub Actions で構築し、AWS への認証には OIDC を利用して長期アクセスキーを持たせない安全な構成にしています。プルリクエスト作成時には lint とテストのみを実行し、`main` ブランチへのマージ時にフロントエンドの S3 同期およびバックエンドの ECR プッシュ・Lambda 更新を実行します。なお、インフラ構成の変更はワークフローに含めず、ローカル環境から `cdk deploy` を実行する運用としています。

詳細な構成については[システム設計書](./docs/architecture.md)をご参照ください。

## 技術スタック

| 領域 | 採用技術 |
|---|---|
| フロントエンド | Vite / React 19 / TypeScript / React Router / TanStack Query / axios / oidc-client-ts |
| バックエンド | Python 3.12 / FastAPI / LangGraph / LangChain / uv |
| インフラ | AWS CDK(TypeScript) / Lambda(arm64・コンテナイメージ) / API Gateway / CloudFront / S3 / S3 Vectors / DynamoDB / SQS / Cognito / Bedrock / ECR |
| モデル | Amazon Bedrock経由でNova 2 Lite / Cohere Embed 4 / Cohere Rerank 3.5 |
| 監視 | Lambda Powertools(Logger / Metrics / Tracer) / CloudWatch / X-Ray / SNS |
| CI/CD | GitHub Actions(OIDC) |
| テスト | Vitest + Testing Library / pytest + moto / Jest(CDKスナップショット) |

## 設計上の判断(ADR)

主な設計判断は以下の通りです。全15件の記録は[docs/adr/](./docs/adr/)を参照してください。

| ADR | 判断と理由 |
|---|---|
| [0001 サーバーレス構成による固定費回避方針](./docs/adr/0001-serverless-zero-fixed-cost.md) | 常駐リソースを持たずサーバーレスのみで構成。損益分岐点を下回る利用量ではアイドル時間が大半を占め、常駐リソースの固定コストが無駄になるため。 |
| [0003 単一のDockerfileから責務別に3つのLambdaをビルドする](./docs/adr/0003-single-dockerfile-three-lambdas.md) | ビルダーを共有しつつ最終ステージを3つのターゲットに分離。インポート処理が重い LangChain 関連を chat-fn のイメージに集約し、他 Function のコールドスタート遅延を防ぐため。 |
| [0005 ベクトルDBにS3 Vectorsを採用](./docs/adr/0005-s3-vectors.md) | Chroma は常駐プロセスと永続ストレージを前提とするため VPC 不使用の構成に適合しない。S3 Vectors であれば従量課金であり、固定費が発生しないため。 |
| [0006 永続化先にDynamoDBを採用し、シングルテーブルで設計する](./docs/adr/0006-dynamodb-single-table.md) | GSI1 のソートキーに ULID の ID そのものを入れることで、全体の一覧取得と ID 単独での取得を 1 つの GSI で効率的に賄うため。 |
| [0007 署名付きURLによる直接アップロードと取込の分離](./docs/adr/0007-upload-ingest-separation.md) | 署名付き URL で S3 に直接 PUT し、Embedding 生成はユーザーの取込操作で開始する方式。Lambda のペイロード上限（6MB）を回避し、誤アップロードによる不要な API コストの発生を防ぐため。 |
| [0011 api-fnとchat-fnの公開経路をAPI Gatewayへ移行する](./docs/adr/0011-api-gateway-migration.md) | Cognito オーソライザが統合リクエストの呼び出し前に JWT を検証するため、無効なトークンによるリクエストで Lambda の実行回数を消費させないため。 |
| [0012 チャットのSSEをPOSTとAuthorizationヘッダーで配信する](./docs/adr/0012-sse-post-with-authorization-header.md) | EventSource ではリクエストヘッダーを付与できず、トークンが URL に露出してしまうため。fetch でレスポンスをストリーミング読み込みし、他 REST API と認証方式を統一するため。 |

## 移植元構成からの変更

本アプリは、同一の RAG 機能を VPC・ECS Fargate・RDS MySQL による常駐構成で構築していた移植元アプリを、サーバーレス構成へ再構築したものです。

| 対象 | 移植元 | 本アプリ |
|---|---|---|
| 実行基盤 | ECS Fargate Spot(VPC内、平日9時から19時に稼働) | Lambda(VPC不使用) |
| ベクトルDB | Chroma on EFS | S3 Vectors |
| チャット永続化 | RDS MySQL | DynamoDB(シングルテーブル) |
| ユーザー識別 | X-User-Idヘッダ | CognitoのJWTの`sub` |

常駐構成では利用のない時間帯にも費用が発生し続けますが、Lambda の費用は実行時間に比例します。両構成の損益分岐点は月間ストリーミング時間で722時間、1チャット30秒として約86,600チャットです。移植元アプリ側の仮定を最も保守的に置いても、分岐点は約64,000チャット/月を下回りません。本アプリは、この下限である約64,000チャット/月を下回る利用量を前提としています。

詳細な費用モデルおよび導出根拠は[コストモデルと損益分岐点](./docs/cost-comparison.md)をご参照ください。

## ローカル実行

```bash
make install   # npm install (frontend) + uv sync (backend)
make dev       # frontend (:5173) と backend (:8000) を同時起動
```

Vite 開発サーバーが `/api` へのリクエストを `localhost:8000` へプロキシするため、ローカル開発時も本番同様の同一オリジン構成で動作します。

**フロントエンド設定**

Cognito の設定値をビルド時に埋め込みます。`apps/frontend/.env.example` を `.env.local` にコピーし、DataStack の出力値を設定してください。

**バックエンド設定**

デプロイ済みの AWS リソースを直接参照します。`/api/health` 以外のエンドポイントの動作には、`TABLE_NAME`、`DOCUMENTS_BUCKET_NAME`、`INGEST_QUEUE_URL`、`VECTOR_INDEX_ARN`、`COGNITO_ISSUER`、`COGNITO_CLIENT_ID` などの環境変数および AWS 認証情報が必要です。

```bash
make lint      # eslint + prettier / ruff
make test      # vitest + pytest
```

テスト実行時は moto を用いて AWS API をモックするため、AWS 認証情報がない環境でも実行可能です。CDK のテストは `cd cdk && npm test` で実行します。

※ デプロイの事前準備（Bedrock のモデルアクセス有効化や ACM 証明書の発行手順）については[cdk/README.md](./cdk/README.md)にまとめています。

## リポジトリ構成

```text
apps/
  frontend/           Vite + React SPA
  backend/            FastAPI（3つのLambdaで共有する単一コードベース）
cdk/                  CDK（CertificateStack / DataStack / AppStack / EdgeStack / CiStack）
docs/
  architecture.md     システム設計書
  adr/                ADR
  cost-comparison.md  移植元構成とのコスト損益分岐点
  diagrams/           構成図および生成スクリプト
.github/workflows/    PR検証および自動デプロイワークフロー
```

## 今後の課題

**1. マルチターン対話（連続した質問）への対応**

現在は1問1答形式で各質問を独立して処理しています。直前の会話文脈を考慮したやり取りが行えるよう、会話履歴をコンテキストとして保持・参照する仕組みを追加する予定です。

**2. Text-to-SQL 機能によるデータアクセスの拡張**

SQLの知識がないユーザーでもデータベース内の情報へ容易にアクセスできるよう、Text-to-SQL 機能の追加を検討しています。接続先 DB としては、既存の DB サーバーのほか Aurora DSQL や Aurora Serverless v2 を候補としています。
