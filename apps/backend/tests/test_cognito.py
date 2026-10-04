from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from app import cognito
from app.cognito import CognitoClient, CognitoError, TokenSet

DOMAIN = "https://auth.example.com"


@pytest.fixture
def posted(monkeypatch):
    """httpx.postを差し替え、送信内容を記録して指定したレスポンスを返す。"""
    calls: list[tuple[str, dict[str, str]]] = []
    response = {"value": httpx.Response(200, json={})}

    def _post(url: str, *, data: dict[str, str], timeout: float) -> httpx.Response:
        calls.append((url, data))
        return response["value"]

    monkeypatch.setattr(cognito.httpx, "post", _post)

    def _respond(res: httpx.Response) -> list[tuple[str, dict[str, str]]]:
        response["value"] = res
        return calls

    return _respond


def test_authorize_url_requests_code_with_pkce():
    url = CognitoClient(DOMAIN, "client-1").authorize_url(
        "https://app.example.com/api/auth/callback", "state-1", "challenge-1"
    )

    parsed = urlparse(url)
    assert f"{parsed.scheme}://{parsed.netloc}{parsed.path}" == (
        f"{DOMAIN}/oauth2/authorize"
    )
    params = parse_qs(parsed.query)
    assert params["response_type"] == ["code"]
    assert params["client_id"] == ["client-1"]
    assert params["scope"] == ["openid email profile"]
    assert params["code_challenge_method"] == ["S256"]


def test_exchange_code_posts_verifier_and_returns_tokens(posted):
    calls = posted(
        httpx.Response(
            200,
            json={"access_token": "a", "id_token": "i", "refresh_token": "r"},
        )
    )

    tokens = CognitoClient(DOMAIN, "client-1").exchange_code(
        "code-1", "https://app.example.com/api/auth/callback", "verifier-1"
    )

    assert tokens == TokenSet("a", "i", "r")
    assert calls == [
        (
            f"{DOMAIN}/oauth2/token",
            {
                "grant_type": "authorization_code",
                "code": "code-1",
                "redirect_uri": "https://app.example.com/api/auth/callback",
                "code_verifier": "verifier-1",
                "client_id": "client-1",
            },
        )
    ]


def test_refresh_returns_tokens_without_refresh_token(posted):
    posted(httpx.Response(200, json={"access_token": "a", "id_token": "i"}))

    tokens = CognitoClient(DOMAIN, "client-1").refresh("r")

    assert tokens == TokenSet("a", "i", None)


def test_rejected_token_request_raises(posted):
    posted(httpx.Response(400, json={"error": "invalid_grant"}))

    with pytest.raises(CognitoError):
        CognitoClient(DOMAIN, "client-1").refresh("r")


def test_revoke_posts_refresh_token(posted):
    calls = posted(httpx.Response(200))

    CognitoClient(DOMAIN, "client-1").revoke("r")

    assert calls == [
        (f"{DOMAIN}/oauth2/revoke", {"token": "r", "client_id": "client-1"})
    ]


def test_rejected_revoke_raises(posted):
    posted(httpx.Response(400))

    with pytest.raises(CognitoError):
        CognitoClient(DOMAIN, "client-1").revoke("r")
