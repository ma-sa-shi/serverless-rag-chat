# CDK

AWS CDK(TypeScript)によるインフラ定義。スタック構成はCertificateStack / DataStack / AppStack / EdgeStack / CiStack。認証のCognitoリソース(User Pool / Hosted UIドメイン / SPAクライアント)はDataStackで、SPA配信用S3バケットはOACのバケットポリシーと同居させるためEdgeStackで管理する。CertificateStackは公開ドメインのACM証明書だけを持ち、CloudFrontの制約からus-east-1に置く。CiStackはGitHub ActionsがOIDCで引き受けるデプロイ用ロールを持つ。

## コマンド

- `npm run typecheck` — 型チェック(tsxで直接実行するためビルド不要)
- `npm test` — jestユニットテスト
- `npx cdk synth` — CloudFormationテンプレート生成
- `npx cdk diff` — デプロイ済みスタックとの差分表示
- `npx cdk deploy --all` — 全スタックをデプロイ

## デプロイ前準備

### ブートストラップ(初回のみ)

CertificateStack以外の4スタックはap-northeast-1へデプロイする。デプロイ先はCDK CLIのプロファイル(`CDK_DEFAULT_REGION`)で決まるため、初回はこのリージョンをブートストラップする。

```bash
npx cdk bootstrap aws://<AWSアカウントID>/ap-northeast-1
```

### Bedrockのモデルアクセス有効化(初回のみ)

推論はすべてBedrock経由で行う(ADR-0016)。モデルアクセスの有効化はアカウントとリージョンごとの操作であり、AppStackのデプロイ前にap-northeast-1で次の3モデルを有効にする。Cohereのようなサードパーティモデルの有効化にはMarketplaceのサブスクライブ権限が要る。

| 用途 | モデル/プロファイルID |
| --- | --- |
| 回答生成・クエリ生成・自己評価・失敗分析 | `jp.amazon.nova-2-lite-v1:0` |
| Embedding | `cohere.embed-v4:0` |
| Rerank | `cohere.rerank-v3-5:0` |

有効化の状態は次のコマンドで確認できる。

```bash
aws bedrock list-foundation-models --region ap-northeast-1
```

CDKはLambdaの実行ロールへ関数ごとに必要なモデルの呼び出し権限だけを付与し、モデルIDを環境変数(`BEDROCK_ANSWER_MODEL`など)で渡す。APIキーは持たないため、キー更新のための再デプロイも不要である。

### Docker

AppStackのLambdaはイメージアセット(`apps/backend/`のDockerfile、`web` / `chat` / `worker`ターゲット)としてデプロイ時にビルドされるため、`cdk deploy`にはDockerデーモンが必要。

### ACM証明書の発行(初回のみ)

公開ドメインは`rag.business-efficiency.pro`で、CloudFrontへ関連付ける証明書はus-east-1になければならない(ADR-0013)。CertificateStackだけはus-east-1へデプロイするため、このリージョンもブートストラップする。

```bash
npx cdk bootstrap aws://<AWSアカウントID>/us-east-1
npx cdk deploy CertificateStack
```

DNSはお名前.comで管理しているため、検証用レコードはCDKの管理外となる。`deploy`は検証待ちのまま進まないため、別のシェルを開き、登録するレコードの値を取得する。

```bash
aws acm list-certificates --region us-east-1 \
  --query "CertificateSummaryList[?DomainName=='rag.business-efficiency.pro'].CertificateArn"
aws acm describe-certificate --region us-east-1 --certificate-arn <取得したARN> \
  --query 'Certificate.DomainValidationOptions[].ResourceRecord'
```

得られた`Name`と`Value`をお名前.comのDNSレコード設定へCNAMEとして登録する。ホスト名の入力欄には、末尾のドメイン部分`.business-efficiency.pro`を除いた値を入れる。ACMがレコードを確認すると証明書が発行され、止まっていた`deploy`が完了する。

## デプロイ

```bash
npx cdk deploy --all -c alarmEmail=you@example.com
```

`alarmEmail`はDLQアラームの通知先で、指定を省略するとSNSのサブスクリプションが作られない。サブスクリプションが作成済みの場合、`alarmEmail`を省略したデプロイで削除されるため、毎回指定する。

各スタックは他のスタックのリソースを参照するため、DataStack → AppStack → EdgeStack → CiStackの順にデプロイされる。EdgeStackはCloudFrontの代替ドメイン名へ証明書を関連付けるため、AppStackに加えてCertificateStackにも依存する。

スタック間の参照は`Fn::GetStackOutput`でデプロイ時に解決され、CloudFormationのExportを作らない。参照先のリソースを削除するスタック更新でも、Exportの削除がブロックされることはない。証明書のようにリージョンを跨ぐ参照も同じ仕組みで解決されるため、受け渡し用のカスタムリソースは作られない。

### DLQアラームのサブスクリプション確認(初回のみ)

DataStackはingest-fnのDLQに対するCloudWatchアラームと、通知用のSNSトピックを作る。通知先のメールアドレスはリポジトリへ残さないため、コンテキスト`alarmEmail`でデプロイ時に渡す。

デプロイ後、AWSから届くサブスクリプション確認メールの`Confirm subscription`リンクを開く。確認を済ませるまで通知は配信されない。サブスクリプションの状態は次のコマンドで確認できる。

```bash
aws sns list-subscriptions-by-topic --topic-arn <DataStackのAlarmTopicArn出力>
```

`SubscriptionArn`が`PendingConfirmation`のままなら、まだ確認が済んでいない。

### 公開ドメインのDNS設定(初回のみ)

EdgeStackのデプロイ後、`DistributionDomainName`出力を確認し、ホスト名`rag`のCNAMEレコードとしてお名前.comのDNSレコード設定へ登録する。

```text
ホスト名: rag
TYPE:     CNAME
VALUE:    dxxxxxxxxxxxxx.cloudfront.net
```

CognitoのコールバックURLとドキュメント保存用バケットのCORS許可オリジンにも公開ドメインが必要だが、DataStackからEdgeStackを参照すると循環参照になる。そのためドメインはコンテキスト`appDomain`で渡している。ドメインは`cdk.json`のcontextへ既定値として置いているため、通常のデプロイで`-c appDomain=...`を指定する必要はない。公開ドメインを変更するときは`cdk.json`を書き換える。

### SPAの配信

通常は`main`へのマージで`.github/workflows/deploy-frontend.yml`が実行されるため、手動の操作は要らない。手元から反映する場合は、EdgeStackの`SpaBucketName`出力のバケットへビルド成果物を同期し、CloudFrontのキャッシュを無効化する。

```bash
(cd ../apps/frontend && npm run build)
aws s3 sync ../apps/frontend/dist s3://<SpaBucketName出力> --delete
aws cloudfront create-invalidation --distribution-id <DistributionId出力> --paths '/*'
```

## CI/CD (CiStack)

CiStackはGitHub ActionsのOIDC IDプロバイダと、Actionsが引き受けるデプロイ用ロール`serverless-rag-chat-github-actions`を作る。権限はSPAの同期、CloudFrontのキャッシュ無効化、ECRへのプッシュ、Lambdaのイメージ更新、スタック出力の読み取りに限定している。ワークフローは`cdk deploy`を行わないため、CloudFormationの更新権限は持たせていない。

### GitHub側の設定

CiStackのデプロイ後、`DeployRoleArn`出力とAWSアカウントIDをリポジトリのSecretsへ登録する。長期アクセスキーは登録しない。

```bash
npx cdk deploy CiStack
gh secret set AWS_ROLE_ARN --body "<DeployRoleArn出力>"
gh secret set AWS_ACCOUNT_ID --body "$(aws sts get-caller-identity --query Account --output text)"
```

### 信頼ポリシーのsubクレーム

GitHubは2026年7月15日以降に作成されたリポジトリのOIDCトークンで、subクレームにownerとrepositoryの数値IDを含める(immutable subject claims)。`cdk/lib/ci-stack.ts`はこの形式のsubをハードコードしており、名前だけの旧形式では`AssumeRoleWithWebIdentity`が失敗する。フォークや別リポジトリで使う場合はIDを取り直して定数を差し替える。

```bash
gh api /repos/<owner>/<repo> --jq '{id, owner_id: .owner.id}'
```

### バックエンドのイメージ参照先

AppStackのLambdaはイメージアセット(bootstrapのアセットリポジトリ)を参照する一方、CIは常設のECRリポジトリへプッシュして`update-function-code`で差し替える。そのため手動で`cdk deploy AppStack`を実行すると、参照先がアセットリポジトリへ戻る。イメージはローカルのソースからビルドし直されるため、コード自体は最新であり、そのまま運用してよい。常設リポジトリへ戻したい場合はバックエンドのワークフローを再実行する。

```bash
gh workflow run deploy-backend.yml
```

## デプロイ後の設定

### Cognitoユーザーの作成

セルフサインアップを無効にしているため、ユーザーは管理者が作成する(docs/authorization.md)。作成すると初期パスワード付きの招待メールが送信される。

```bash
aws cognito-idp admin-create-user \
  --user-pool-id <DataStackのUserPoolId出力> \
  --username user@example.com \
  --user-attributes \
    Name=email,Value=user@example.com \
    Name=email_verified,Value=true \
    Name=name,Value='表示名'
```

### ローカル開発の環境変数

Hosted UIのコールバックURLに`http://localhost:5173/auth/callback`を登録済みのため、デプロイ済みCognitoを使ってローカルで認証フローを動かせる。DataStackのCfnOutputの値を次の2箇所へ設定する。

- `apps/frontend/.env.local` — `.env.example`をコピーしてCognitoIssuer / UserPoolClientIdを設定する
- バックエンド(uvicorn)の環境変数 — JWT検証と、デプロイ済みのDynamoDB・S3・SQS・S3 Vectorsへのアクセスに使う

```bash
export COGNITO_ISSUER=<CognitoIssuer出力>
export COGNITO_CLIENT_ID=<UserPoolClientId出力>
export TABLE_NAME=<TableName出力>
export DOCUMENTS_BUCKET_NAME=<DocumentsBucketName出力>
export INGEST_QUEUE_URL=<IngestQueueUrl出力>
export VECTOR_INDEX_ARN=<VectorIndexArn出力>
```
