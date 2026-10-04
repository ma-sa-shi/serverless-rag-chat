"""CognitoのトークンのJWT検証。

アクセストークンはAPIの認証に、IDトークンはサインイン時のプロフィール同期にだけ使う。
トークンの保存と受け渡しはADR-0018、検証の仕様はdocs/authorization.mdを参照。
"""

import logging

# Least Recently Used Cacheは、functools モジュールが提供する関数の結果をキャッシュするデコレータ
from functools import lru_cache
from typing import Annotated, Any, NamedTuple

import jwt
from fastapi import Cookie, Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt import PyJWKClient

from app.settings import Settings, get_settings

logger = logging.getLogger(__name__)

# 接頭辞により、ブラウザはSecureとPathの条件を満たさないCookieを受け付けない
ACCESS_TOKEN_COOKIE = "__Host-access_token"
REFRESH_TOKEN_COOKIE = "__Secure-refresh_token"
AUTH_TRANSACTION_COOKIE = "__Secure-auth_tx"

# コールバックは発行直後のトークンを検証する為、時計がCognitoより遅れているとiatが未来になり拒否される。
# expの判定も同じ幅だけ緩むが、本番ではAPI Gatewayのオーソライザがexpを別に検証する
CLOCK_SKEW_LEEWAY_SECONDS = 60

# Authorization ヘッダーが存在しない場合、FastAPIは自動的に 403 Forbidden エラーを発生する
# auto_error=False: Authorizationヘッダなしを403ではなく401で返す
_bearer = HTTPBearer(auto_error=False)


class IdTokenClaims(NamedTuple):
    sub: str
    name: str
    email: str


# JWKSの公開鍵取得をプロセス内でキャッシュする
@lru_cache
def _jwks_client(jwks_url: str) -> PyJWKClient:
    return PyJWKClient(jwks_url)


def _unauthorized() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid authentication credentials",
        # HTTP仕様（RFC 7235 / RFC 6750）に準拠し、クライアントに正しい認証方式を通知・指示するため
        headers={"WWW-Authenticate": "Bearer"},
    )


def _decode(
    token: str,
    settings: Settings,
    audience: str | None,
    required: list[str],
) -> dict[str, Any]:
    """署名・iss・expを検証する。失敗はjwt.PyJWTErrorで送出する。"""
    jwks_client = _jwks_client(f"{settings.cognito_issuer}/.well-known/jwks.json")
    signing_key = jwks_client.get_signing_key_from_jwt(token)
    return jwt.decode(
        token,
        signing_key.key,
        algorithms=["RS256"],
        issuer=settings.cognito_issuer,
        audience=audience,
        leeway=CLOCK_SKEW_LEEWAY_SECONDS,
        options={"require": ["exp", "iss", "sub", *required]},
    )


def get_current_user_id(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    settings: Annotated[Settings, Depends(get_settings)],
    access_token_cookie: Annotated[
        str | None, Cookie(alias=ACCESS_TOKEN_COOKIE)
    ] = None,
) -> str:
    # 本番ではCloudFront FunctionがCookieをAuthorizationへ写す。
    # CloudFrontを経由しないローカル開発ではCookieを直接読む
    token = credentials.credentials if credentials else access_token_cookie
    if token is None:
        logger.warning("JWT rejected: access token missing")
        raise _unauthorized()

    # デジタル署名の確認
    try:
        claims = _decode(token, settings, audience=None, required=[])
    except jwt.PyJWTError as exc:
        logger.warning("JWT rejected: %s", exc)
        raise _unauthorized() from None

    # JWTの内容検証
    # Cognitoのアクセストークンはaudを持たず、client_id / token_useクレームで検証する
    if claims.get("token_use") != "access":
        logger.warning("JWT rejected: token_use=%s", claims.get("token_use"))
        raise _unauthorized()
    if claims.get("client_id") != settings.cognito_client_id:
        logger.warning("JWT rejected: unexpected client_id")
        raise _unauthorized()

    return claims["sub"]


def verify_id_token(token: str, settings: Settings) -> IdTokenClaims | None:
    """検証に失敗した場合はNoneを返す。"""
    try:
        claims = _decode(
            token,
            settings,
            audience=settings.cognito_client_id,
            required=["aud", "name", "email"],
        )
    except jwt.PyJWTError as exc:
        logger.warning("ID token rejected: %s", exc)
        return None

    if claims.get("token_use") != "id":
        logger.warning("ID token rejected: token_use=%s", claims.get("token_use"))
        return None

    return IdTokenClaims(sub=claims["sub"], name=claims["name"], email=claims["email"])
