import base64
import hashlib
import json
from datetime import UTC, datetime, timedelta
from http.cookies import SimpleCookie
from urllib.parse import parse_qs, urlparse

import jwt
import pytest
from fastapi.testclient import TestClient

from app.cognito import CognitoError, TokenSet
from app.dependencies import get_cognito_client
from app.main import app
from tests.conftest import CLIENT_ID, ISSUER

APP_ORIGIN = "https://rag.example.com"
COGNITO_DOMAIN = "https://auth.example.com"

# follow_redirects=Falseで、リダイレクト先とSet-Cookieをレスポンスのまま検証する
client = TestClient(app, follow_redirects=False)


class FakeCognito:
    """Cognitoのエンドポイントの代わりに、呼び出しを記録して決めた結果を返す。"""

    def __init__(self, tokens: TokenSet | None) -> None:
        self.tokens = tokens
        self.exchanged: list[tuple[str, str, str]] = []
        self.refreshed: list[str] = []
        self.revoked: list[str] = []

    def authorize_url(self, redirect_uri: str, state: str, code_challenge: str) -> str:
        return f"{COGNITO_DOMAIN}/oauth2/authorize?" + "&".join(
            [
                f"redirect_uri={redirect_uri}",
                f"state={state}",
                f"code_challenge={code_challenge}",
            ]
        )

    def logout_url(self, logout_uri: str) -> str:
        return f"{COGNITO_DOMAIN}/logout?logout_uri={logout_uri}"

    def exchange_code(
        self, code: str, redirect_uri: str, code_verifier: str
    ) -> TokenSet:
        self.exchanged.append((code, redirect_uri, code_verifier))
        return self._result()

    def refresh(self, refresh_token: str) -> TokenSet:
        self.refreshed.append(refresh_token)
        return self._result()

    def revoke(self, refresh_token: str) -> None:
        self.revoked.append(refresh_token)
        if self.tokens is None:
            raise CognitoError("revoke failed")

    def _result(self) -> TokenSet:
        if self.tokens is None:
            raise CognitoError("invalid_grant")
        return self.tokens


@pytest.fixture(autouse=True)
def auth_env(monkeypatch):
    monkeypatch.setenv("APP_ORIGIN", APP_ORIGIN)
    monkeypatch.setenv("COGNITO_DOMAIN", COGNITO_DOMAIN)


@pytest.fixture
def make_id_token(rsa_key):
    def _make(*, sub="user-123", audience=CLIENT_ID, token_use="id", issued_in=0):
        now = datetime.now(UTC)
        claims = {
            "sub": sub,
            "iss": ISSUER,
            "aud": audience,
            "token_use": token_use,
            "name": "山田 太郎",
            "email": "taro@example.com",
            "iat": now + timedelta(seconds=issued_in),
            "exp": now + timedelta(hours=1),
        }
        return jwt.encode(claims, rsa_key, algorithm="RS256")

    return _make


@pytest.fixture
def use_cognito():
    """FakeCognitoを差し込み、テスト後に差し替えを戻す。"""

    def _use(tokens: TokenSet | None) -> FakeCognito:
        fake = FakeCognito(tokens)
        app.dependency_overrides[get_cognito_client] = lambda: fake
        return fake

    yield _use
    app.dependency_overrides.pop(get_cognito_client, None)


def set_cookies(res) -> dict[str, SimpleCookie]:
    """Set-Cookieをヘッダーの行ごとに解析し、Cookie名で引けるようにする。"""
    parsed: dict[str, SimpleCookie] = {}
    for header in res.headers.get_list("set-cookie"):
        cookie = SimpleCookie()
        cookie.load(header)
        for name in cookie:
            parsed[name] = cookie
    return parsed


def cookie_header(**cookies: str) -> dict[str, str]:
    # TestClientはhttp://testserverへ送る為、Secure属性付きのCookieをクッキージャー経由では送らない
    return {"Cookie": "; ".join(f"{name}={value}" for name, value in cookies.items())}


def auth_tx(*, state="state-1", code_verifier="verifier-1", return_to="/") -> str:
    payload = {"state": state, "codeVerifier": code_verifier, "returnTo": return_to}
    return base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()


def callback(query: str, transaction: str | None):
    headers = (
        {}
        if transaction is None
        else cookie_header(**{"__Secure-auth_tx": transaction})
    )
    return client.get(f"/api/auth/callback?{query}", headers=headers)


def test_login_redirects_to_hosted_ui_with_pkce(use_cognito):
    use_cognito(None)

    res = client.get("/api/auth/login?returnTo=/chat/abc")

    assert res.status_code == 302
    location = urlparse(res.headers["location"])
    params = parse_qs(location.query)
    assert params["redirect_uri"] == [f"{APP_ORIGIN}/api/auth/callback"]

    cookie = set_cookies(res)["__Secure-auth_tx"]["__Secure-auth_tx"]
    assert cookie["path"] == "/api/auth"
    assert cookie["samesite"] == "lax"
    assert cookie["secure"] and cookie["httponly"]

    transaction = json.loads(base64.urlsafe_b64decode(cookie.value))
    assert params["state"] == [transaction["state"]]
    assert transaction["returnTo"] == "/chat/abc"
    # S256: code_challengeはcode_verifierのSHA-256をパディングなしのbase64urlにしたもの
    digest = hashlib.sha256(transaction["codeVerifier"].encode()).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
    assert params["code_challenge"] == [challenge]


@pytest.mark.parametrize(
    "return_to",
    ["https://evil.example.com", "//evil.example.com", "/\\evil.example.com"],
)
def test_login_replaces_external_return_to_with_root(use_cognito, return_to):
    use_cognito(None)

    res = client.get("/api/auth/login", params={"returnTo": return_to})

    cookie = set_cookies(res)["__Secure-auth_tx"]["__Secure-auth_tx"]
    assert json.loads(base64.urlsafe_b64decode(cookie.value))["returnTo"] == "/"


def test_callback_issues_cookies_and_syncs_profile(
    use_cognito, make_token, make_id_token, dynamodb_table
):
    access_token = make_token(sub="user-abc")
    fake = use_cognito(
        TokenSet(access_token, make_id_token(sub="user-abc"), "refresh-1")
    )

    res = callback(
        "code=code-1&state=state-1",
        auth_tx(state="state-1", code_verifier="verifier-1", return_to="/documents"),
    )

    assert res.status_code == 302
    assert res.headers["location"] == "/documents"
    assert fake.exchanged == [
        ("code-1", f"{APP_ORIGIN}/api/auth/callback", "verifier-1")
    ]

    cookies = set_cookies(res)
    access = cookies["__Host-access_token"]["__Host-access_token"]
    assert access.value == access_token
    assert access["path"] == "/"
    assert access["samesite"] == "strict"
    assert access["secure"] and access["httponly"]
    refresh = cookies["__Secure-refresh_token"]["__Secure-refresh_token"]
    assert refresh.value == "refresh-1"
    assert refresh["path"] == "/api/auth"
    assert refresh["samesite"] == "strict"
    # サインイン途中の状態は使い終わったら消す
    assert cookies["__Secure-auth_tx"]["__Secure-auth_tx"]["max-age"] == "0"

    profile = dynamodb_table.get_item(Key={"PK": "USER#user-abc", "SK": "PROFILE"})
    assert profile["Item"]["displayName"] == "山田 太郎"
    assert profile["Item"]["email"] == "taro@example.com"


@pytest.mark.parametrize(
    ("query", "transaction"),
    [
        ("code=code-1&state=other", auth_tx(state="state-1")),
        ("code=code-1&state=state-1", None),
        ("state=state-1", auth_tx(state="state-1")),
        ("error=access_denied&state=state-1", auth_tx(state="state-1")),
        ("code=code-1&state=state-1", "not-base64-json"),
    ],
)
def test_callback_rejects_invalid_request_without_exchange(
    use_cognito, make_token, make_id_token, query, transaction
):
    fake = use_cognito(TokenSet(make_token(), make_id_token(), "refresh-1"))

    res = callback(query, transaction)

    assert res.status_code == 400
    assert fake.exchanged == []
    assert "__Host-access_token" not in set_cookies(res)


def test_callback_accepts_id_token_issued_ahead_of_local_clock(
    use_cognito, make_token, make_id_token, dynamodb_table
):
    # Cognitoの時計がわずかに進んでいると、発行直後のIDトークンのiatが未来になる
    use_cognito(TokenSet(make_token(), make_id_token(issued_in=5), "refresh-1"))

    res = callback("code=code-1&state=state-1", auth_tx(state="state-1"))

    assert res.status_code == 302


def test_callback_returns_400_when_exchange_fails(use_cognito):
    use_cognito(None)

    res = callback("code=code-1&state=state-1", auth_tx(state="state-1"))

    assert res.status_code == 400


@pytest.mark.parametrize(
    "id_token_kwargs", [{"audience": "other-client"}, {"token_use": "access"}]
)
def test_callback_rejects_invalid_id_token(
    use_cognito, make_token, make_id_token, dynamodb_table, id_token_kwargs
):
    use_cognito(TokenSet(make_token(), make_id_token(**id_token_kwargs), "refresh-1"))

    res = callback("code=code-1&state=state-1", auth_tx(state="state-1"))

    assert res.status_code == 400
    assert "__Host-access_token" not in set_cookies(res)


def test_refresh_reissues_access_token(use_cognito, make_token):
    access_token = make_token()
    fake = use_cognito(TokenSet(access_token, "id-token", None))

    res = client.post(
        "/api/auth/refresh",
        headers=cookie_header(**{"__Secure-refresh_token": "refresh-1"}),
    )

    assert res.status_code == 204
    assert fake.refreshed == ["refresh-1"]
    cookies = set_cookies(res)
    assert cookies["__Host-access_token"]["__Host-access_token"].value == access_token
    # 更新のレスポンスはリフレッシュトークンを含まない為、既存のCookieを残す
    assert "__Secure-refresh_token" not in cookies


def test_refresh_without_cookie_returns_401(use_cognito):
    fake = use_cognito(None)

    res = client.post("/api/auth/refresh")

    assert res.status_code == 401
    assert fake.refreshed == []


def test_refresh_failure_clears_session(use_cognito):
    use_cognito(None)

    res = client.post(
        "/api/auth/refresh",
        headers=cookie_header(**{"__Secure-refresh_token": "revoked"}),
    )

    assert res.status_code == 401
    cookies = set_cookies(res)
    assert cookies["__Host-access_token"]["__Host-access_token"]["max-age"] == "0"
    assert cookies["__Secure-refresh_token"]["__Secure-refresh_token"]["max-age"] == "0"


@pytest.mark.parametrize("tokens", [TokenSet("a", "i", None), None])
def test_logout_revokes_and_clears_session(use_cognito, tokens):
    # 失効に失敗した場合(tokens=None)もCookieは消す
    fake = use_cognito(tokens)

    res = client.post(
        "/api/auth/logout",
        headers=cookie_header(**{"__Secure-refresh_token": "refresh-1"}),
    )

    assert res.status_code == 200
    assert res.json() == {
        "logoutUrl": f"{COGNITO_DOMAIN}/logout?logout_uri={APP_ORIGIN}"
    }
    assert fake.revoked == ["refresh-1"]
    cookies = set_cookies(res)
    assert cookies["__Host-access_token"]["__Host-access_token"]["max-age"] == "0"
    assert cookies["__Secure-refresh_token"]["__Secure-refresh_token"]["max-age"] == "0"


def test_cross_origin_write_is_rejected(use_cognito):
    fake = use_cognito(None)

    res = client.post(
        "/api/auth/logout",
        headers={
            "Origin": "https://evil.example.com",
            **cookie_header(**{"__Secure-refresh_token": "refresh-1"}),
        },
    )

    assert res.status_code == 403
    assert fake.revoked == []


def test_same_origin_write_is_allowed(use_cognito):
    use_cognito(TokenSet("a", "i", None))

    res = client.post("/api/auth/logout", headers={"Origin": APP_ORIGIN})

    assert res.status_code == 200
