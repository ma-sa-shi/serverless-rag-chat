# backend

3つのLambda(api-fn / chat-fn / ingest-fn)が共有するFastAPIのコードベース。CloudFrontの`/api/*`ルーティングに合わせ、エンドポイントは全て `/api` 配下に配置する

## セットアップ

```bash
uv sync
```

## 開発サーバー

```bash
uv run uvicorn app.main:app --reload
```

http://localhost:8000 で待ち受ける。フロントエンドの開発サーバーはここへ`/api`をプロキシする。

`/api/health`以外のルートはデプロイ済みのAWSリソースを直接参照する。そのため`.env.example`を`.env`へコピーし、DataStackとAppStackの出力値を設定したうえで、AWS認証情報も用意する(`cdk/README.md`)。`make dev`は`.env`があれば読み込む。特に`TABLE_NAME`は必須で、未設定のままリクエストするとエラーになる。

## テスト

```bash
uv run pytest
```

AWSのAPIはmotoで差し替えるため、認証情報のない環境でも実行できる。

## Lint / Format

```bash
uv run ruff check .
uv run ruff format .
```

## Docker

`Dockerfile`は本番用のイメージをビルドする。共通のビルダーから`web`(api-fn) / `chat`(chat-fn) / `worker`(ingest-fn)の3ターゲットに分かれ、デプロイ時にCDKがターゲットと環境変数を選ぶ(ADR-0003)。

普段の開発はネイティブ(`uv`)で行い、Dockerはイメージの確認にだけ使う。リポジトリルートで次を実行すると、`web`イメージが起動してHTTPを返すところまで確認できる。

```bash
make docker-up     # :8000で起動する。ネイティブの開発サーバーは先に停止する
make docker-down
```

一方、`chat`と`worker`はビルドの確認だけを行う(`make docker-build-chat` / `make docker-build-worker`)。
