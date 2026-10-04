from fastapi.testclient import TestClient

from app.main import app
from app.settings import get_settings
from tests.factories import put_quota

client = TestClient(app)


def post_me(token: str | None, body: dict):
    headers = {} if token is None else {"Authorization": f"Bearer {token}"}
    return client.post("/api/users/me", json=body, headers=headers)


def get_profile(table, user_id: str) -> dict | None:
    res = table.get_item(Key={"PK": f"USER#{user_id}", "SK": "PROFILE"})
    return res.get("Item")


def test_signin_registration_saves_profile(make_token, dynamodb_table):
    res = post_me(
        make_token(sub="user-abc"),
        {"displayName": "山田 太郎", "email": "taro@example.com"},
    )
    assert res.status_code == 204

    item = get_profile(dynamodb_table, "user-abc")
    assert item is not None
    assert item["displayName"] == "山田 太郎"
    assert item["email"] == "taro@example.com"
    assert item["createdAt"] == item["updatedAt"]


def test_reregistration_overwrites_and_preserves_created_at(make_token, dynamodb_table):
    token = make_token(sub="user-abc")
    post_me(token, {"displayName": "旧名", "email": "old@example.com"})
    created_at = get_profile(dynamodb_table, "user-abc")["createdAt"]

    res = post_me(token, {"displayName": "新名", "email": "new@example.com"})
    assert res.status_code == 204

    item = get_profile(dynamodb_table, "user-abc")
    assert item["displayName"] == "新名"
    assert item["email"] == "new@example.com"
    assert item["createdAt"] == created_at


def test_missing_token_returns_401(dynamodb_table):
    res = post_me(None, {"displayName": "山田 太郎", "email": "taro@example.com"})
    assert res.status_code == 401


def test_empty_display_name_returns_422(make_token, dynamodb_table):
    res = post_me(make_token(), {"displayName": "", "email": "taro@example.com"})
    assert res.status_code == 422


def test_can_get_other_users_profile(make_token, dynamodb_table):
    post_me(
        make_token(sub="user-abc"),
        {"displayName": "山田 太郎", "email": "taro@example.com"},
    )

    res = client.get(
        "/api/users/user-abc",
        headers={"Authorization": f"Bearer {make_token(sub='user-other')}"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["userId"] == "user-abc"
    assert body["displayName"] == "山田 太郎"
    assert body["email"] == "taro@example.com"


def test_unknown_user_returns_404(make_token, dynamodb_table):
    res = client.get(
        "/api/users/unknown-user",
        headers={"Authorization": f"Bearer {make_token()}"},
    )
    assert res.status_code == 404


def test_me_returns_signed_in_users_profile(make_token, dynamodb_table):
    post_me(
        make_token(sub="user-abc"),
        {"displayName": "山田 太郎", "email": "taro@example.com"},
    )

    res = client.get(
        "/api/users/me",
        headers={"Authorization": f"Bearer {make_token(sub='user-abc')}"},
    )
    assert res.status_code == 200
    assert res.json()["userId"] == "user-abc"
    assert res.json()["displayName"] == "山田 太郎"


def test_me_without_profile_returns_404(make_token, dynamodb_table):
    res = client.get(
        "/api/users/me",
        headers={"Authorization": f"Bearer {make_token(sub='user-new')}"},
    )
    assert res.status_code == 404


def test_me_requires_authentication(dynamodb_table):
    assert client.get("/api/users/me").status_code == 401


def get_quota(token: str | None, user_id: str):
    headers = {} if token is None else {"Authorization": f"Bearer {token}"}
    return client.get(f"/api/users/{user_id}/quota", headers=headers)


def test_未使用のユーザーはused0を返す(make_token, dynamodb_table):
    res = get_quota(make_token(), "user-abc")

    assert res.status_code == 200
    assert res.json() == {"limit": get_settings().chat_daily_quota, "used": 0}


def test_他ユーザーの利用回数を取得できる(make_token, dynamodb_table):
    put_quota(dynamodb_table, user_id="user-abc", used=3)

    res = get_quota(make_token(sub="user-other"), "user-abc")

    assert res.status_code == 200
    assert res.json()["used"] == 3


def test_前日の利用回数は当日分に数えない(make_token, dynamodb_table):
    put_quota(dynamodb_table, user_id="user-abc", used=20, date="2020-01-01")

    res = get_quota(make_token(), "user-abc")

    assert res.json()["used"] == 0


def test_利用回数の取得には認証が必要(dynamodb_table):
    assert get_quota(None, "user-abc").status_code == 401
