# 認証認可設計

- 親ドキュメント: [architecture.md](./architecture.md)

本ドキュメントでは、architecture.mdにおける認証・認可設計の詳細仕様を定義する。認証基盤の選定理由はADR-0004に、トークン保存方針の決定理由はADR-0018にそれぞれ記載している。

## 設計方針

本システムでは、認証処理を Amazon Cognito に委譲する。バックエンド（FastAPI）は Cognito とのトークンのやり取りと JWT の検証を行い、トークンを HttpOnly Cookie に保存する。

- 認証方式には OAuth 2.0 Authorization Code Flow + PKCE を採用する
- 認可コードの交換、トークンの更新と失効は api-fn が行い、SPA は Cognito と直接通信しない
- 取得したトークンは HttpOnly Cookie に保存し、JavaScript からは読み取らせない
- FastAPI はパスワード管理とトークン発行を実装しない。サーバー側にセッションも持たない

## 認証フロー

```text
SPA（未認証）
    │ ⓪/api/auth/login へ遷移する。
    ▼
api-fn（/api/auth/login）
    │ ①code_verifier と state を生成して Cookie に保存し、SHA-256 でハッシュ化した code_challenge を付けて Cognito の認可エンドポイントへリダイレクトする。
    ▼
Cognito Hosted UI
    │ ②メールアドレスとパスワードによる認証成功後、認可コードを付与して /api/auth/callback へリダイレクトする。
    ▼
api-fn（/api/auth/callback）
    │ ③state を照合し、認可コードと code_verifier を Cognito のトークンエンドポイントへ送信して各トークンを受け取る。
    │ ④ID Token を検証して表示名とメールアドレスを DynamoDB へ同期し、Access Token と Refresh Token を Cookie に保存して元の画面へリダイレクトする。
    ▼
SPA
    │ ⑤以降の API リクエストでは、ブラウザが Cookie を自動で送信する。
    ▼
CloudFront Function
    │ ⑥Cookie の Access Token を Authorization ヘッダーへ写す。
    ▼
API Gateway オーソライザ / FastAPI
      ⑦JWKS による署名検証を実施し、iss / client_id / exp / token_use=access を検証した上で sub を user_id として利用する。
```

ローカル開発では CloudFront を経由しないため、FastAPI が Cookie から Access Token を直接読む。Authorization ヘッダーがある場合はそちらを優先する。

---

## ユーザー登録

- ユーザー自身によるセルフサインアップは許可せず、管理者が Cognito コンソール上でユーザーアカウントを作成する。作成後、Cognito より有効期限7日間の初期パスワードを含む招待メールが対象ユーザーへ送信される。
- 招待メールを受信したユーザーは、初回サインイン時に本パスワードを設定する。

## IdP連携

初期導入時は Cognito によるメールアドレス・パスワード認証を採用し、Google Workspace や Microsoft Entra ID 等との SAML / OIDC 連携機能は必要に応じて後から追加する方針とする。
外部 IdP との連携は Hosted UI が担うため、IdP を追加しても SPA と api-fn の改修は不要であり、Cognito の設定変更のみで完了する。

---

## トークン仕様

| Token | 有効期限 | 用途 |
|-------|---------|------|
| Access Token | 1時間（Cognito既定値） | API リクエストの認証に使用 |
| ID Token | 1時間（Cognito既定値） | サインイン時のプロフィール同期にのみ使用し、保存しない |
| Refresh Token | 30日 | Access Token の更新に使用 |

- Access Token の期限が切れると API は401を返す。SPA は `POST /api/auth/refresh` を呼んで Access Token を更新し、元のリクエストを1回だけ送り直す。同時に401を受けた複数のリクエストは1回の更新を共有する。
- 更新にも失敗した場合、画面の表示時はサインインへ遷移させ、操作中は再読み込みを促すメッセージを表示する。
- Cookie はタブ間で共有されるため、1つのタブで更新した Access Token を他のタブもそのまま使える。

---

## Cookie仕様

| Cookie | 値 | Path | SameSite | 有効期限 |
|--------|----|------|----------|---------|
| `__Host-access_token` | Access Token | `/` | Strict | 1時間 |
| `__Secure-refresh_token` | Refresh Token | `/api/auth` | Strict | 30日 |
| `__Secure-auth_tx` | state、code_verifier、サインイン後の遷移先 | `/api/auth` | Lax | 10分 |

- すべての Cookie に HttpOnly と Secure を付け、Domain は指定しない。
- `__Secure-auth_tx` だけを Lax とするのは、Cognito から戻るコールバックが別サイトからの遷移であり、Strict では送信されないためである。
- サインイン後の遷移先は、`/` で始まり `//` で始まらないパスだけを受け付ける。外部サイトへのオープンリダイレクトを防ぐためである。

---

## エンドポイント

| エンドポイント | 処理 |
|---------------|------|
| `GET /api/auth/login?returnTo=` | Hosted UI の認可エンドポイントへリダイレクトする |
| `GET /api/auth/callback` | 認可コードを交換し、Cookie を発行して `returnTo` へリダイレクトする |
| `POST /api/auth/refresh` | Access Token の Cookie を更新する。失敗時は Cookie を削除して401を返す |
| `POST /api/auth/logout` | Refresh Token を失効させて Cookie を削除し、Cognito の `/logout` の URL を返す |
| `GET /api/users/me` | サインイン中のユーザーのプロフィールを返す |

`/api/auth/*` には API Gateway のオーソライザを適用しない。期限切れの Access Token しか持たない状態で呼ばれるためである。Cognito へ渡すリダイレクト先は環境変数 `APP_ORIGIN` から組み立て、リクエストの Host は使わない。CloudFront がオリジンへ渡す Host は API Gateway のドメインだからである。

---

## CSRF対策

- Access Token と Refresh Token の Cookie を SameSite=Strict とし、別サイトから始まるリクエストには送信させない。
- POST・PUT・PATCH・DELETE のリクエストが `Origin` ヘッダーを持ち、その値が `APP_ORIGIN` と異なる場合は403を返す。
- サインインの開始とコールバックでは state を照合し、攻撃者の認可コードで別人のアカウントへサインインさせる攻撃を防ぐ。

---

## サインアウト

- アプリケーションヘッダー内にサインアウトボタンを配置する（独立したサインアウトルートは作成しない）
- サインアウト実行時は `POST /api/auth/logout` で Refresh Token を失効させて Cookie を削除し、返された Cognito の `/logout` へ遷移して Hosted UI 側のセッションも破棄する。
- サインアウト完了後のリダイレクト先はルートパス（/）とする。

---

## バックエンド検証

FastAPI では、Access Token に対して以下の検証を実施する。

- JWKS エンドポイント（`/.well-known/jwks.json`）を用いた JWT の署名検証（取得した公開鍵はプロセス内でキャッシュする）
- `iss`（User PoolのIssuer）、`client_id`、`exp`（有効期限）、および `token_use=access` の妥当性検証
- `sub` クレームの値を抽出して user_id として識別利用
- `iat` と `exp` の判定では、Cognito との時計のずれとして60秒を許容する。コールバックは発行直後のトークンを検証するため、時計がわずかに遅れているだけで `iat` が未来と判定されるためである

API の認可に使うのは Access Token のみである。Cognito が発行する Access Token には `aud` クレームが含まれないため、受取先の妥当性検証は `client_id` および `token_use` クレームを用いて行う。

ID Token はサインイン時のコールバックでのみ検証する。署名と `iss`、`exp` に加え、`aud` が `client_id` と一致すること、`token_use=id` であることを確かめた上で、`name` と `email` を DynamoDB のプロフィールへ同期する。

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
