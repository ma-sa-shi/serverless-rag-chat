"""Cognito Hosted UIのOAuth 2.0エンドポイントを呼び出す。

アプリクライアントはシークレットを持たないパブリッククライアントであり、
client_idだけで認可コードの交換・更新・失効を行える(ADR-0018)。
"""

from typing import NamedTuple, TypedDict
from urllib.parse import urlencode

import httpx

TIMEOUT_SECONDS = 10.0


class CognitoError(Exception):
    """Cognitoがトークンの発行・失効を拒否した。"""


class TokenSet(NamedTuple):
    access_token: str
    id_token: str
    # 更新のレスポンスには含まれない
    refresh_token: str | None


class _TokenResponse(TypedDict, total=False):
    access_token: str
    id_token: str
    refresh_token: str


class CognitoClient:
    def __init__(self, domain: str, client_id: str) -> None:
        self._domain = domain
        self._client_id = client_id

    def authorize_url(self, redirect_uri: str, state: str, code_challenge: str) -> str:
        query = urlencode(
            {
                "response_type": "code",
                "client_id": self._client_id,
                "redirect_uri": redirect_uri,
                # profileは表示名(name)の取得に必要
                "scope": "openid email profile",
                "state": state,
                "code_challenge": code_challenge,
                "code_challenge_method": "S256",
            }
        )
        return f"{self._domain}/oauth2/authorize?{query}"

    def logout_url(self, logout_uri: str) -> str:
        """Hosted UIのセッションを破棄するURL。ブラウザを遷移させる必要がある。"""
        query = urlencode({"client_id": self._client_id, "logout_uri": logout_uri})
        return f"{self._domain}/logout?{query}"

    def exchange_code(
        self, code: str, redirect_uri: str, code_verifier: str
    ) -> TokenSet:
        return self._request_tokens(
            {
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": redirect_uri,
                "code_verifier": code_verifier,
            }
        )

    def refresh(self, refresh_token: str) -> TokenSet:
        return self._request_tokens(
            {"grant_type": "refresh_token", "refresh_token": refresh_token}
        )

    def revoke(self, refresh_token: str) -> None:
        res = httpx.post(
            f"{self._domain}/oauth2/revoke",
            data={"token": refresh_token, "client_id": self._client_id},
            timeout=TIMEOUT_SECONDS,
        )
        if res.status_code != httpx.codes.OK:
            raise CognitoError(f"revoke failed: HTTP {res.status_code}")

    def _request_tokens(self, form: dict[str, str]) -> TokenSet:
        res = httpx.post(
            f"{self._domain}/oauth2/token",
            data={**form, "client_id": self._client_id},
            timeout=TIMEOUT_SECONDS,
        )
        if res.status_code != httpx.codes.OK:
            # 本文のerrorはinvalid_grantなどの種別だけで、トークンを含まない
            raise CognitoError(
                f"token request failed: HTTP {res.status_code} {res.text}"
            )
        body: _TokenResponse = res.json()
        return TokenSet(
            access_token=body["access_token"],
            id_token=body["id_token"],
            refresh_token=body.get("refresh_token"),
        )
