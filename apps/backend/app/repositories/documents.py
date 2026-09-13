from datetime import UTC, datetime
from decimal import Decimal
from typing import Literal, NotRequired, TypedDict

import boto3
from boto3.dynamodb.conditions import Attr, Key

DocumentStatus = Literal["uploading", "uploaded", "processing", "ingested", "failed"]


class DocumentItem(TypedDict):
    """DynamoDBに保存するDocumentsエンティティ。

    chunkCountは取込時に付与され、登録済みのベクトル数以上であることを保つ。
    DynamoDBは数値をDecimalで返す。
    """

    PK: str
    SK: str
    GSI1PK: str
    GSI1SK: str
    documentId: str
    userId: str
    filename: str
    s3Key: str
    status: DocumentStatus
    createdAt: str
    updatedAt: str
    chunkCount: NotRequired[Decimal]


class DocumentStatusError(Exception):
    """現在のステータスでは許可されない遷移・操作。"""


class DocumentRepository:
    """DynamoDBシングルテーブルのDocumentsエンティティを扱う。

    ステータス遷移: uploading → uploaded → processing → ingested | failed
    SK・GSI1SKのdocumentIdはULIDのため、辞書順がそのまま作成時刻順になる。
    """

    def __init__(self, table_name: str) -> None:
        self._table = boto3.resource("dynamodb").Table(table_name)

    def create(
        self, *, user_id: str, document_id: str, filename: str, s3_key: str
    ) -> DocumentItem:
        now = datetime.now(UTC).isoformat()
        item: DocumentItem = {
            "PK": f"USER#{user_id}",
            "SK": f"DOC#{document_id}",
            "GSI1PK": "DOC",
            "GSI1SK": document_id,
            "documentId": document_id,
            "userId": user_id,
            "filename": filename,
            "s3Key": s3_key,
            "status": "uploading",
            "createdAt": now,
            "updatedAt": now,
        }
        self._table.put_item(Item=item)
        return item

    def get_owned(self, user_id: str, document_id: str) -> DocumentItem | None:
        """本人のドキュメントを取得する。ステータス更新系の所有チェックに使う。"""
        res = self._table.get_item(
            Key={"PK": f"USER#{user_id}", "SK": f"DOC#{document_id}"}
        )
        return res.get("Item")

    def get(self, document_id: str) -> DocumentItem | None:
        """所有者を問わずdocumentIdで取得する。閲覧用presigned URL発行に使う。"""
        res = self._table.query(
            IndexName="GSI1",
            KeyConditionExpression=Key("GSI1PK").eq("DOC")
            & Key("GSI1SK").eq(document_id),
        )
        items = res["Items"]
        return items[0] if items else None

    def list_recent(self, limit: int) -> list[DocumentItem]:
        res = self._table.query(
            IndexName="GSI1",
            KeyConditionExpression=Key("GSI1PK").eq("DOC"),
            ScanIndexForward=False,
            Limit=limit,
        )
        return res["Items"]

    def list_by_user(self, user_id: str, limit: int) -> list[DocumentItem]:
        res = self._table.query(
            KeyConditionExpression=Key("PK").eq(f"USER#{user_id}")
            & Key("SK").begins_with("DOC#"),
            ScanIndexForward=False,
            Limit=limit,
        )
        return res["Items"]

    def reserve_chunk_count(
        self, user_id: str, document_id: str, chunk_count: int
    ) -> None:
        """chunkCountを登録予定のチャンク数まで引き上げる。既に大きい場合は何もしない。

        取込がPutVectorsの後に失敗してもchunkCountが登録済みベクトル数を下回らないようにし、
        削除APIがベクトルを消し残さないための不変条件を保つ。
        """
        try:
            self._table.update_item(
                Key={"PK": f"USER#{user_id}", "SK": f"DOC#{document_id}"},
                UpdateExpression="SET chunkCount = :chunkCount",
                ConditionExpression=Attr("chunkCount").not_exists()
                | Attr("chunkCount").lt(chunk_count),
                ExpressionAttributeValues={":chunkCount": chunk_count},
            )
        except self._table.meta.client.exceptions.ConditionalCheckFailedException:
            pass

    def delete(self, user_id: str, document_id: str) -> None:
        """ドキュメントを削除する。削除済みのドキュメントを指定しても成功として扱う。

        取込中に削除するとingest-fnが後からベクトルを登録し、レコードのないベクトルが残る。
        条件付き削除でprocessingを弾き、DocumentStatusErrorを送出する。
        """
        try:
            self._table.delete_item(
                Key={"PK": f"USER#{user_id}", "SK": f"DOC#{document_id}"},
                # 属性の比較は項目が無いと偽になる為、削除済みを明示的に許可する
                ConditionExpression=Attr("status").ne("processing")
                | Attr("PK").not_exists(),
            )
        except self._table.meta.client.exceptions.ConditionalCheckFailedException:
            raise DocumentStatusError(
                "cannot delete a document being ingested"
            ) from None

    def update_status(
        self,
        user_id: str,
        document_id: str,
        new_status: DocumentStatus,
        *,
        allowed_from: tuple[DocumentStatus, ...],
        chunk_count: int | None = None,
    ) -> None:
        """条件付き更新でステータスを遷移させる。

        chunk_countは取込完了時のみ指定し、再取込での余剰ベクトル削除に使う。

        Raises:
            DocumentStatusError: 現在のステータスがallowed_from外の場合
        """
        expression = "SET #status = :status, updatedAt = :now"
        values: dict[str, str | int] = {
            ":status": new_status,
            ":now": datetime.now(UTC).isoformat(),
        }
        if chunk_count is not None:
            expression += ", chunkCount = :chunkCount"
            values[":chunkCount"] = chunk_count
        try:
            self._table.update_item(
                Key={"PK": f"USER#{user_id}", "SK": f"DOC#{document_id}"},
                UpdateExpression=expression,
                ConditionExpression=Attr("status").is_in(list(allowed_from)),
                ExpressionAttributeNames={"#status": "status"},
                ExpressionAttributeValues=values,
            )
        except self._table.meta.client.exceptions.ConditionalCheckFailedException:
            raise DocumentStatusError(
                f"transition to {new_status} requires status in {allowed_from}"
            ) from None
