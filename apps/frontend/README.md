# frontend

Vite + React 19によるSPAで、本番はS3へ配置しCloudFrontから配信する。`/api/*`は本番ではCloudFront、ローカルではVite dev serverのプロキシがバックエンドへ転送するため、どちらも同一オリジンで動作しCORSの設定は要らない。

## セットアップ

```bash
npm install
```

Cognitoの設定は持たない。サインインはバックエンドの`/api/auth/*`が行い、トークンはHttpOnly Cookieでブラウザが送る(ADR-0018)。

## 開発サーバー

```bash
npm run dev
```

http://localhost:5173 で待ち受け、`/api`を http://localhost:8000 へプロキシする。バックエンドの開発サーバーも必要なため、通常はリポジトリルートの`make dev`で両方を起動する。

## テスト

```bash
npm test
```

テストは`src/`と同じ構成で`test/`に置き、jsdomとReact Testing Libraryで実行する。Vitestのグローバルは注入していないため、`describe` / `it` / `expect` / `vi`は各ファイルでimportする。

## ビルド

```bash
npm run build
```

`tsc -b`が`src/`・`vite.config.ts`・`test/`を型チェックしたうえで、Viteが`dist/`へバンドルする。

## Lint / Format

```bash
npm run lint
npm run format
```
