from datetime import UTC, datetime
from decimal import Decimal

from fastapi.testclient import TestClient
from ulid import ULID

from app.main import app
from app.repositories.users import UserRepository
from tests.conftest import TABLE_NAME
from tests.factories import put_attempt, put_chat

client = TestClient(app)


def headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def ulid_at(second: int) -> str:
    """指定秒のタイムスタンプを持つULIDを返す。ランダム部を含むため呼ぶたびに異なる。"""
    return str(ULID.from_datetime(datetime(2026, 7, 23, 10, 0, second, tzinfo=UTC)))


def test_chat_list_is_cross_user_newest_first(make_token, aws):
    chat1, chat2, chat3 = ulid_at(1), ulid_at(2), ulid_at(3)
    put_chat(aws.table, user_id="user-a", chat_id=chat1, question="質問1")
    put_chat(aws.table, user_id="user-b", chat_id=chat2, question="質問2")
    put_chat(aws.table, user_id="user-a", chat_id=chat3, question="質問3")

    res = client.get("/api/chats", headers=headers(make_token()))
    assert res.status_code == 200
    chats = res.json()
    assert [c["chatId"] for c in chats] == [chat3, chat2, chat1]
    assert chats[0]["question"] == "質問3"
    assert chats[0]["finalAnswer"] == "回答"
    assert chats[0]["finalGrade"] == "useful"
    assert chats[0]["retryCount"] == 0


def test_user_chat_list_returns_only_own_chats(make_token, aws):
    chat1, chat2 = ulid_at(1), ulid_at(2)
    put_chat(aws.table, user_id="user-a", chat_id=chat1)
    put_chat(aws.table, user_id="user-b", chat_id=chat2)

    res = client.get("/api/users/user-a/chats", headers=headers(make_token()))
    assert res.status_code == 200
    assert [c["chatId"] for c in res.json()] == [chat1]


def test_chat_detail_returns_all_outputs_per_attempt(make_token, aws):
    chat_id = ulid_at(1)
    put_chat(
        aws.table,
        user_id="user-a",
        chat_id=chat_id,
        question="RAGとは",
        final_answer=None,
        final_grade="useless",
        retry_count=1,
    )
    put_attempt(
        aws.table,
        user_id="user-a",
        chat_id=chat_id,
        attempt_no=0,
        queries=["RAGの定義", "RAGの仕組み"],
        documents=[
            {
                "documentId": "doc-1",
                "filename": "rag.pdf",
                "text": "RAGは検索拡張生成である",
                # DynamoDBはfloatを扱えないためDecimalで保存される
                "score": Decimal("0.9"),
            }
        ],
        answer="初回回答",
        grade="useless",
        feedback="根拠不足",
    )
    put_attempt(
        aws.table,
        user_id="user-a",
        chat_id=chat_id,
        attempt_no=1,
        answer=None,
        grade="useless",
        feedback="根拠不足",
        failure_analysis="検索対象に該当資料がない",
    )

    res = client.get(f"/api/chats/{chat_id}", headers=headers(make_token()))
    assert res.status_code == 200
    body = res.json()
    assert body["chatId"] == chat_id
    assert body["userId"] == "user-a"
    assert body["question"] == "RAGとは"
    assert body["retryCount"] == 1

    attempts = body["attempts"]
    assert [a["attemptNo"] for a in attempts] == [0, 1]
    assert attempts[0]["queries"] == ["RAGの定義", "RAGの仕組み"]
    assert attempts[0]["documents"] == [
        {
            "documentId": "doc-1",
            "filename": "rag.pdf",
            "text": "RAGは検索拡張生成である",
            "score": 0.9,
        }
    ]
    assert attempts[0]["answer"] == "初回回答"
    assert attempts[0]["grade"] == "useless"
    assert attempts[0]["failureAnalysis"] is None
    assert attempts[1]["failureAnalysis"] == "検索対象に該当資料がない"


def test_attempts_from_other_chats_are_excluded(make_token, aws):
    chat_id = ulid_at(1)
    other_id = ulid_at(2)
    put_chat(aws.table, user_id="user-a", chat_id=chat_id)
    put_chat(aws.table, user_id="user-a", chat_id=other_id)
    put_attempt(aws.table, user_id="user-a", chat_id=chat_id, attempt_no=0)
    put_attempt(aws.table, user_id="user-a", chat_id=other_id, attempt_no=0)

    res = client.get(f"/api/chats/{chat_id}", headers=headers(make_token()))
    assert len(res.json()["attempts"]) == 1


def test_unknown_chat_returns_404(make_token, aws):
    res = client.get("/api/chats/unknown-chat", headers=headers(make_token()))
    assert res.status_code == 404


def test_missing_token_returns_401(aws):
    assert client.get("/api/chats").status_code == 401


def test_chat_list_includes_owner_display_name(make_token, aws):
    chat1, chat2 = ulid_at(1), ulid_at(2)
    UserRepository(TABLE_NAME).upsert_profile("user-a", "山田 太郎", "taro@example.com")
    put_chat(aws.table, user_id="user-a", chat_id=chat1)
    put_chat(aws.table, user_id="user-without-profile", chat_id=chat2)

    res = client.get("/api/chats", headers=headers(make_token()))
    assert res.status_code == 200
    owner_names = {c["chatId"]: c["ownerName"] for c in res.json()}
    assert owner_names == {chat1: "山田 太郎", chat2: None}
