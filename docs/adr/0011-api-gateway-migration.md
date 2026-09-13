# ADR-0011: api-fnとchat-fnの公開経路をAPI Gatewayへ移行する

- Status: Accepted
- Date: 2026-08-02
- Updated: 2026-08-13

## Context

ADR-0009では、CloudFrontの`/api/*`のOriginをLambda Function URLとし、Origin Access Controlを適用しない構成を採用した。OACのSigV4署名が、Cognitoのアクセストークンを運ぶ`Authorization`ヘッダーと同じヘッダーを使うためである。

この構成ではFunction URLがインターネットから直接到達可能なまま残る。データを返すルートはFastAPIのJWT検証で保護されるが、検証はLambdaの起動後に行われる。そのため、ドメインが判明した場合は、無効なトークンを付けたリクエストでもLambdaの実行回数と実行時間が課金され、レートの上限もない。

ADR-0009がAPI Gatewayを採用しなかった理由は次の2点である。

- Lambda起動前の拒否やレート制限を必要とする事象が発生していなかった
- SSEは中間層が増えるほどバッファリングやタイムアウトで壊れやすく、REST APIのレスポンスストリーミングによる動作を検証できていなかった

SSEを配信する条件は揃っている。統合の`responseTransferMode`はaws-cdk-lib 2.261.0のL2の`IntegrationOptions`で設定できる。統合タイムアウトはサービスクォータ`Maximum integration timeout in milliseconds`に縛られるが、これが適用されるのは`BUFFERED`の統合のみであり、[`STREAM`の統合](https://docs.aws.amazon.com/apigateway/latest/developerguide/response-transfer-mode.html)は申請なしで最大15分まで設定できる。Self-RAGが最大7回のLLM呼び出しを行う場合でも、統合タイムアウトに収まる。

## Decision

api-fnとchat-fnの公開経路を、REST APIのリージョナルエンドポイントへ移行する。CloudFrontの`/api/*`のOriginをAPI Gatewayへ変更し、切り替え後にFunction URLを削除する。

理由は、不正なリクエストをLambdaの起動前に拒否できることである。API GatewayのCognito User Poolオーソライザは、統合を呼び出す前にJWTの署名と有効期限を検証する。そのため、無効なトークンのリクエストはLambdaへ到達せず、実行回数を消費しない。オーソライザは無認証の`/api/health`を除く全ルートへ適用する。ステージのスロットリングにより、有効なトークンを持つリクエストにもレートの上限を設ける。

`/api/chats/stream`をchat-fnへ、それ以外をapi-fnへ振り分ける。SSEは統合の`responseTransferMode`をSTREAMにして配信する。統合タイムアウトはストリーム全体の上限となるため、chat-fnのLambdaタイムアウトに合わせる。

メソッドには認可スコープ`openid`を指定する。Cognitoオーソライザは、認可スコープが未指定のときトークンをIDトークンとして検証する。本システムのSPAが送るのはアクセストークンであるため、未指定のままでは有効なトークンでもすべて401になる。認可スコープを指定するとアクセストークンの`scope`クレームで検証するようになる。SPAが要求するスコープは`openid` / `email` / `profile`であり、共通する`openid`を要求する。

FastAPI側のJWT検証は残す。オーソライザが検証するのはトークンが自User Poolの有効なものであることまでであり、リクエストされたドキュメントやチャットが本人のものかという認可はアプリケーションでしか判定できない。またローカル開発ではAPI Gatewayを経由しないため、検証をオーソライザへ一本化すると開発時と本番で認証経路が食い違う。

API GatewayにCloudFrontからのアクセスのみを許可するリソースポリシーは設定しない。`Authorization`ヘッダーの競合はAPI Gatewayでも同じであり、SigV4署名を用いる保護は成立しない。直接アクセスはオーソライザとスロットリングで受け止める。

## Consequences

メリット

- 無効なトークンのリクエストがLambdaへ到達せず、実行回数と実行時間が課金されない
- スロットリングにより、有効なトークンを用いた大量リクエストにも上限を設けられる
- SPAの実装は変わらない。引き続き`Authorization: Bearer`でアクセストークンを送る

デメリット・制約

- SSEのストリームを継続させるための調整箇所が、CloudFrontに加えてAPI Gateway側にも増える
- api-fnの統合は`BUFFERED`であり、統合タイムアウトはサービスクォータの既定値29秒に縛られる。これを超える処理を置く場合は引き上げの申請が要る
- `STREAM`の統合にはイベント間隔のアイドルタイムアウトがあり、リージョナルエンドポイントでは5分となる。本構成ではCloudFrontの60秒が先に適用されるため制約として表面化しない
- JWTの検証がオーソライザとFastAPIの2箇所になる。検証の設定を変更する際は両方を更新する必要がある
- API Gatewayのリクエスト課金が加わる
- API Gatewayのエンドポイントもインターネットから直接到達可能である。Function URLと同じく、CloudFrontのビヘイビアやキャッシュ設定は迂回できる

見直し条件

- 認可の判定にUser Pool以外の情報が必要になった場合はLambdaオーソライザを検討する
- CloudFrontの設定を迂回されることが問題になった場合は、`Authorization`ヘッダーを使わない経路保護を再検討する

## Alternatives

### Function URL構成を維持する

ADR-0009の構成をそのまま続ける案である。中間層が増えず、SSEの設定項目も現状のままとなる。

不採用の理由は、Lambda起動前に拒否する手段がこの構成には存在しないことである。ADR-0009はこのリスクを、実害が出ていないことを根拠に受け入れていた。実害を待つ必要はなく、対策の手段がある以上はリスクを残さない。

### HTTP API(API Gateway v2)を使う

HTTP APIはREST APIよりリクエスト単価が安く、JWTオーソライザを標準で備える。

不採用の理由は、Lambdaのレスポンスストリーミングに対応していないことである。chat-fnのSSEが成立せず、chat-fnだけFunction URLに残す構成となる。公開経路が2種類になり、認可とスロットリングの設定も二重管理となるため、単価差に見合わない。

### CloudFront FunctionsまたはLambda@EdgeでJWTを検証する

エッジでトークンを検証すれば、Lambdaの起動前に拒否できる。

不採用の理由は、検証の実装と鍵の取り回しを自前で持つことになる点である。JWKSの取得とキャッシュ、鍵ローテーションへの追従を実装する必要があり、Cognitoオーソライザが標準で提供する機能を再実装することになる。Lambda@Edgeは実行課金も追加される。
