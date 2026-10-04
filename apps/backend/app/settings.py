import os
from dataclasses import dataclass
from functools import lru_cache


# 生成後に値を書き換えられないようにする
@dataclass(frozen=True)
class Settings:
    # 関数ごとに必要な環境変数が異なるため、未設定でも空文字でフォールバックする
    # (例: ingest-fnはHTTPを受けないためCognitoの設定を持たない)
    cognito_issuer: str
    cognito_client_id: str
    # Hosted UIのベースURL。認可コードの交換やトークンの更新に使い、api-fnだけが持つ
    cognito_domain: str
    # Cognitoへ渡すリダイレクト先とCSRF検証の基準。リクエストのHostはAPI Gatewayを指す為使わない
    app_origin: str
    table_name: str
    documents_bucket_name: str
    ingest_queue_url: str
    vector_index_arn: str
    bedrock_answer_model: str
    bedrock_utility_model: str
    bedrock_embedding_model: str
    bedrock_rerank_model: str
    chat_daily_quota: int


# キャッシュ化により、os.environの読み込みを1回だけにする
@lru_cache
def get_settings() -> Settings:
    return Settings(
        cognito_issuer=os.environ.get("COGNITO_ISSUER", ""),
        cognito_client_id=os.environ.get("COGNITO_CLIENT_ID", ""),
        cognito_domain=os.environ.get("COGNITO_DOMAIN", ""),
        app_origin=os.environ.get("APP_ORIGIN", ""),
        table_name=os.environ["TABLE_NAME"],
        documents_bucket_name=os.environ.get("DOCUMENTS_BUCKET_NAME", ""),
        ingest_queue_url=os.environ.get("INGEST_QUEUE_URL", ""),
        vector_index_arn=os.environ.get("VECTOR_INDEX_ARN", ""),
        # 第一候補のgpt-5.6-lunaはアカウントで未開放のため、暫定でNova 2 Liteに統一する。
        # 開放後は回答生成だけを環境変数でlunaへ戻せる(ADR-0016)
        bedrock_answer_model=os.environ.get(
            "BEDROCK_ANSWER_MODEL", "jp.amazon.nova-2-lite-v1:0"
        ),
        bedrock_utility_model=os.environ.get(
            "BEDROCK_UTILITY_MODEL", "jp.amazon.nova-2-lite-v1:0"
        ),
        bedrock_embedding_model=os.environ.get(
            "BEDROCK_EMBEDDING_MODEL", "cohere.embed-v4:0"
        ),
        bedrock_rerank_model=os.environ.get(
            "BEDROCK_RERANK_MODEL", "cohere.rerank-v3-5:0"
        ),
        # 1チャット約$0.006の実測を根拠に、1人1日20回を既定とする(ADR-0017)
        chat_daily_quota=int(os.environ.get("CHAT_DAILY_QUOTA", "20")),
    )
