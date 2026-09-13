# 認証認可設計

- 親ドキュメント: [architecture.md](./architecture.md)

本ドキュメントでは、architecture.mdにおける認証・認可設計の詳細仕様を定義する。認証基盤の選定理由はADR-0004に、トークン保存方針の決定理由はADR-0010にそれぞれ記載している。

## 設計方針

本システムでは、認証処理を Amazon Cognito に委譲し、バックエンド（FastAPI）側では JWT の検証処理のみを行う。

- 認証方式には OAuth 2.0 Authorization Code Flow + PKCE を採用する
- SPA 側の認証機能は `react-oidc-context` を用いて実装する
- 取得したトークンは localStorage に保存する
- FastAPI では JWKS によるアクセストークンの検証のみを行い、パスワード管理、トークン発行、およびセッション管理機能は実装しない

## 認証フロー

```text
SPA（未認証）
    │ ⓪code_verifierを生成し、SHA-256でハッシュ化したcode_challengeをCognitoの認可エンドポイントへ送信する。
    │
    ▼
Cognito Hosted UI
    │ ①メールアドレスとパスワードによる認証成功後、認可コードを付与して redirect_uri へリダイレクトする。
    ▼
/auth/callback?code=...
    │ ②認可コードと code_verifier を Cognito のトークンエンドポイントへ送信する。
    ▼
Cognito Token Endpoint
    │ ③code_verifier と code_challenge の一致を検証し、各トークン（access_token / id_token / refresh_token）を発行する。
    ▼
SPA
    │ ④トークンを localStorage に保存し、以降の API リクエスト時に Authorization ヘッダーへ JWT を付与して送信する。
    ▼
FastAPI
      ⑤JWKS による署名検証を実施し、iss / client_id / exp / token_use=access を検証した上で sub を user_id として利用する。
```

---

## ユーザー登録

- ユーザー自身によるセルフサインアップは許可せず、管理者が Cognito コンソール上でユーザーアカウントを作成する。作成後、Cognito より有効期限7日間の初期パスワードを含む招待メールが対象ユーザーへ送信される。
- 招待メールを受信したユーザーは、初回サインイン時に本パスワードを設定する。

## IdP連携

初期導入時は Cognito によるメールアドレス・パスワード認証を採用し、Google Workspace や Microsoft Entra ID 等との SAML / OIDC 連携機能は必要に応じて後から追加する方針とする。
フロントエンド側では標準 OIDC クライアントライブラリを採用しているため、将来的な IdP 追加時にも SPA 側の改修は設定変更のみで完了する。

---

## トークン仕様

| Token | 有効期限 | 用途 |
|-------|---------|------|
| Access Token | 1時間（Cognito既定値） | API リクエスト時の Authorization ヘッダーに使用 |
| ID Token | 1時間（Cognito既定値） | SPA 画面上でのユーザー表示名およびメールアドレス表示にのみ使用 |
| Refresh Token | 30日 | Access Token および ID Token の自動更新に使用 |

- Access Token および ID Token は、`react-oidc-context` の `automaticSilentRenew` 機能により自動更新される。
- Refresh Token はタブの破棄後も localStorage に保持されるため、トークン更新は Refresh Token Grant フローによって実行される。iframe を使用したサイレントサインインを行わない構成のため、サードパーティ Cookie に対するブラウザの制限仕様の影響を受けない。
- Refresh Token の有効期限切れ（失効）が発生した場合のみ、Hosted UI 画面へ自動リダイレクトして再認証を促す。

---

## SPA実装

認証処理には `react-oidc-context` ライブラリを使用する。設定情報は `apps/frontend/src/auth/userManager.ts` の `UserManager` インスタンスへ集約し、AuthProvider および axios インターセプター間で同一インスタンスを共有する。認可コード受取用のリダイレクト先エンドポイントは `/auth/callback` とし、要求するスコープ（Scope）は `openid email profile` とする（profile スコープはユーザー表示名の取得に必要となる）。

### ライブラリ選定理由

Authorization Code Flow や PKCE フローを自前で実装することによるセキュリティリスクを回避し、検証済みの標準ライブラリに処理を委譲することが安全であると判断した。また、`react-oidc-context` は React 向けに AuthProvider コンポーネントおよび useAuth フックを提供しており、認証状態をコンポーネントツリー全体へ容易に組み込むことができる。さらに標準 OIDC クライアント規格に準拠しているため、将来的な IdP 変更時にも特定ベンダーへロックインされず、SPA 側の変更を設定更新のみに抑えられるメリットがある。

### 採用を見送った代替案

| 代替案 | 見送り理由 |
|--------|-----------|
| AWS Amplify (Auth) | 単一の認証機能を実現するために、Amplify 固有の設定体系および巨大なランタイムライブラリを導入する必要が生じるため |
| `amazon-cognito-identity-js` | 独自ログインフォームの構築を前提としたライブラリであり、Hosted UI を活用する設計方針と合致しないため |
| PKCE自前実装 | Authorization Code Flow + PKCE フローの自作は実装の不備に伴うセキュリティリスクが高いため |

---

## トークン保存方針

`oidc-client-ts` の `WebStorageStateStore` を利用し、トークンを localStorage に保存する。本構成は、ページリロード時や複数タブ間でのセッション永続化・共有を優先した選択である。選定理由の詳細、XSS リスクの許容範囲、および sessionStorage や HttpOnly Cookie との比較検討についてはADR-0010に記載している。

---

## サインアウト

- アプリケーションヘッダー内にサインアウトボタンを配置する（独立したサインアウトルートは作成しない）
- サインアウト実行時は localStorage 内のトークン情報を破棄した上で、Cognito の `/logout` エンドポイントへリダイレクトして Hosted UI 側のセッションも同時に破棄する。
- サインアウト完了後のリダイレクト先はルートパス（/）とする。

---

## バックエンド検証

FastAPI では、以下の検証処理のみを実施する。

- JWKS エンドポイント（`/.well-known/jwks.json`）を用いた JWT の署名検証（取得した公開鍵はプロセス内でキャッシュする）
- `iss`（User PoolのIssuer）、`client_id`、`exp`（有効期限）、および `token_use=access` の妥当性検証
- `sub` クレームの値を抽出して user_id として識別利用

バックエンドでの検証対象は Access Token であり、ID Token は検証しない。ID Token はユーザー属性を SPA 側に伝達するためのものであり、API 実行認可に使用するトークンではないためである。なお、Cognito が発行する Access Token には `aud` クレームが含まれないため、受取先の妥当性検証は `client_id` および `token_use` クレームを用いて行う。

---

## 認可制御

- 認証済みのユーザーは、全ユーザーが作成したチャット履歴およびアップロードドキュメントを閲覧できる。
- データ更新系操作（ドキュメントのアップロード・取込、チャット作成、データ削除）は、本人が作成したリソースに対してのみ実行可能とする。
- 管理者ロールは当面定義せず、ユーザーアカウント管理は Cognito コンソール上で直接行う。

### 閲覧権限を全ユーザーへ開放する理由

本システムの主要目的は「社内ナレッジの共有」であり、他ユーザーが「どのような資料を基にどのような問い合わせを行ったか」を相互参照できる点に価値がある。閲覧権限を作成者本人のみに制限した場合、同様の質問が重複して行われ、蓄積された回答資産が再利用されない課題が生じるためである。

そのため、以下の前提運用を条件として閲覧範囲を全ユーザーに開放する。

- システム利用者は Cognito に登録された社内ユーザーに限定され、アカウントは管理者による招待制で作成される
- 部門の極秘情報や個人情報（PII）を含む文書は投入しない運用ルールを徹底する
- データの更新および削除権限は作成者本人に限定し、他ユーザーによるデータの改変・破棄を防ぐ

なお、将来的にアクセス範囲の制限が必要となった場合でも、DynamoDB のキー設計においてユーザー単位の絞り込みが可能な構成となっているため、データ取得クエリの追加および認可ロジックの補強によって容易に対応可能である。
