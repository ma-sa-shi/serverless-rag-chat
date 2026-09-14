from datetime import UTC, datetime
from typing import TypedDict

import boto3

BATCH_GET_MAX_KEYS = 100


class UserProfileItem(TypedDict):
    PK: str
    SK: str
    displayName: str
    email: str
    createdAt: str
    updatedAt: str


class UserRepository:
    """DynamoDBシングルテーブルのUsersエンティティを扱う。

    ユーザー情報はCognitoがマスタで、ここにはユーザー画面表示用の
    キャッシュ(表示名・メールアドレス)を保存する。
    """

    def __init__(self, table_name: str) -> None:
        self._dynamodb = boto3.resource("dynamodb")
        self._table = self._dynamodb.Table(table_name)

    def get_profile(self, user_id: str) -> UserProfileItem | None:
        res = self._table.get_item(Key={"PK": f"USER#{user_id}", "SK": "PROFILE"})
        return res.get("Item")

    def get_display_names(self, user_ids: set[str]) -> dict[str, str]:
        """プロフィールが未登録のユーザーは結果に含めない。"""
        names: dict[str, str] = {}
        pending = [{"PK": f"USER#{user_id}", "SK": "PROFILE"} for user_id in user_ids]
        # BatchGetItemは1回100キーまで。容量の都合で返らなかったキーはUnprocessedKeysに載る
        while pending:
            res = self._dynamodb.batch_get_item(
                RequestItems={
                    self._table.name: {
                        "Keys": pending[:BATCH_GET_MAX_KEYS],
                        "ProjectionExpression": "PK, displayName",
                    }
                }
            )
            names.update(
                {
                    item["PK"].removeprefix("USER#"): item["displayName"]
                    for item in res["Responses"].get(self._table.name, [])
                }
            )
            unprocessed = (
                res["UnprocessedKeys"].get(self._table.name, {}).get("Keys", [])
            )
            pending = pending[BATCH_GET_MAX_KEYS:] + unprocessed
        return names

    def upsert_profile(self, user_id: str, display_name: str, email: str) -> None:
        now = datetime.now(UTC).isoformat()
        self._table.update_item(
            Key={"PK": f"USER#{user_id}", "SK": "PROFILE"},
            UpdateExpression=(
                "SET displayName = :display_name, email = :email, "
                "updatedAt = :now, createdAt = if_not_exists(createdAt, :now)"
            ),
            ExpressionAttributeValues={
                ":display_name": display_name,
                ":email": email,
                ":now": now,
            },
        )
