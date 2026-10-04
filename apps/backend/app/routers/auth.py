"""サインイン・更新・サインアウトと、トークンを入れるCookieの発行(ADR-0018)。

API Gatewayのオーソライザを付けない唯一のルート群であり、期限切れのアクセストークンしか
持たない状態でも呼び出せる。
"""

import base64
import hashlib
import json
import logging
import secrets
from typing import Annotated, Literal, TypedDict

from fastapi import APIRouter, Cookie, Depends, HTTPException, Query, status
from fastapi.responses import JSONResponse, RedirectResponse, Response

from app.auth import (
    ACCESS_TOKEN_COOKIE,
    AUTH_TRANSACTION_COOKIE,
    REFRESH_TOKEN_COOKIE,
    verify_id_token,
)
from app.cognito import CognitoClient, CognitoError
from app.dependencies import get_cognito_client, get_user_repository
from app.repositories.users import UserRepository
from app.settings import Settings, get_settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth")

# 有効期限はCognitoアプリクライアントのトークン有効期限と揃える
ACCESS_TOKEN_MAX_AGE = 60 * 60
REFRESH_TOKEN_MAX_AGE = 30 * 24 * 60 * 60
AUTH_TRANSACTION_MAX_AGE = 10 * 60

# リフレッシュトークンとサインイン途中の状態は、更新とコールバックにだけ送らせる
AUTH_COOKIE_PATH = "/api/auth"


class AuthTransaction(TypedDict):
    state: str
    codeVerifier: str
    returnTo: str


def _set_cookie(
    response: Response,
    key: str,
    value: str,
    *,
    max_age: int,
    path: str,
    samesite: Literal["lax", "strict"],
) -> None:
    response.set_cookie(
        key,
        value,
        max_age=max_age,
        path=path,
        secure=True,
        httponly=True,
        samesite=samesite,
    )


def _delete_cookie(response: Response, key: str, path: str) -> None:
    # 接頭辞付きのCookieは、削除のSet-CookieにもSecureが無いとブラウザに無視される
    response.delete_cookie(key, path=path, secure=True, httponly=True)


def _set_access_token(response: Response, access_token: str) -> None:
    _set_cookie(
        response,
        ACCESS_TOKEN_COOKIE,
        access_token,
        max_age=ACCESS_TOKEN_MAX_AGE,
        path="/",
        samesite="strict",
    )


def _issue_session(response: Response, access_token: str, refresh_token: str) -> None:
    _set_access_token(response, access_token)
    _set_cookie(
        response,
        REFRESH_TOKEN_COOKIE,
        refresh_token,
        max_age=REFRESH_TOKEN_MAX_AGE,
        path=AUTH_COOKIE_PATH,
        samesite="strict",
    )


def _clear_session(response: Response) -> None:
    _delete_cookie(response, ACCESS_TOKEN_COOKIE, "/")
    _delete_cookie(response, REFRESH_TOKEN_COOKIE, AUTH_COOKIE_PATH)


def _callback_uri(settings: Settings) -> str:
    return f"{settings.app_origin}/api/auth/callback"


def _safe_return_to(return_to: str) -> str:
    """同一オリジンのパスだけを許し、外部サイトへのオープンリダイレクトを防ぐ。"""
    # ブラウザは`/\`を`//`と同じくプロトコル相対URLとして解釈する
    if not return_to.startswith("/") or return_to.startswith(("//", "/\\")):
        return "/"
    return return_to


def _code_challenge(code_verifier: str) -> str:
    digest = hashlib.sha256(code_verifier.encode()).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


def _encode_transaction(transaction: AuthTransaction) -> str:
    # Cookieの値に使えない`"`や`,`を含まないよう、JSONをbase64urlで包む
    return base64.urlsafe_b64encode(json.dumps(transaction).encode()).decode()


def _decode_transaction(value: str | None) -> AuthTransaction | None:
    if value is None:
        return None
    try:
        decoded = json.loads(base64.urlsafe_b64decode(value.encode()))
    except ValueError:
        return None
    if not isinstance(decoded, dict) or not all(
        isinstance(decoded.get(key), str)
        for key in ("state", "codeVerifier", "returnTo")
    ):
        return None
    return AuthTransaction(
        state=decoded["state"],
        codeVerifier=decoded["codeVerifier"],
        returnTo=decoded["returnTo"],
    )


@router.get("/login")
def login(
    settings: Annotated[Settings, Depends(get_settings)],
    cognito: Annotated[CognitoClient, Depends(get_cognito_client)],
    return_to: Annotated[str, Query(alias="returnTo")] = "/",
) -> RedirectResponse:
    """PKCEとstateを用意し、Hosted UIへリダイレクトする。"""
    transaction = AuthTransaction(
        state=secrets.token_urlsafe(32),
        codeVerifier=secrets.token_urlsafe(64),
        returnTo=_safe_return_to(return_to),
    )
    response = RedirectResponse(
        cognito.authorize_url(
            _callback_uri(settings),
            transaction["state"],
            _code_challenge(transaction["codeVerifier"]),
        ),
        status_code=status.HTTP_302_FOUND,
    )
    # コールバックはCognitoのドメインから戻る遷移であり、Strictでは送信されない
    _set_cookie(
        response,
        AUTH_TRANSACTION_COOKIE,
        _encode_transaction(transaction),
        max_age=AUTH_TRANSACTION_MAX_AGE,
        path=AUTH_COOKIE_PATH,
        samesite="lax",
    )
    return response


@router.get("/callback")
def callback(
    settings: Annotated[Settings, Depends(get_settings)],
    cognito: Annotated[CognitoClient, Depends(get_cognito_client)],
    repository: Annotated[UserRepository, Depends(get_user_repository)],
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    auth_transaction: Annotated[
        str | None, Cookie(alias=AUTH_TRANSACTION_COOKIE)
    ] = None,
) -> RedirectResponse:
    """認可コードを交換し、プロフィールを同期してからCookieを発行する。"""
    if error is not None:
        logger.warning("sign-in rejected by Cognito: %s", error)
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="sign-in failed")

    transaction = _decode_transaction(auth_transaction)
    # stateの照合で、攻撃者の認可コードによって別人のアカウントへサインインさせる攻撃を防ぐ
    if (
        code is None
        or state is None
        or transaction is None
        or not secrets.compare_digest(state, transaction["state"])
    ):
        logger.warning("sign-in rejected: state mismatch or missing code")
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="sign-in failed")

    try:
        tokens = cognito.exchange_code(
            code, _callback_uri(settings), transaction["codeVerifier"]
        )
    except CognitoError as exc:
        logger.warning("sign-in rejected: %s", exc)
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, detail="sign-in failed"
        ) from None

    claims = verify_id_token(tokens.id_token, settings)
    if claims is None or tokens.refresh_token is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="sign-in failed")

    # 表示名とメールアドレスはIDトークンにしか無く、IDトークン自体はここで捨てる
    repository.upsert_profile(claims.sub, claims.name, claims.email)

    response = RedirectResponse(
        transaction["returnTo"], status_code=status.HTTP_302_FOUND
    )
    _issue_session(response, tokens.access_token, tokens.refresh_token)
    _delete_cookie(response, AUTH_TRANSACTION_COOKIE, AUTH_COOKIE_PATH)
    return response


@router.post("/refresh", status_code=status.HTTP_204_NO_CONTENT)
def refresh(
    cognito: Annotated[CognitoClient, Depends(get_cognito_client)],
    refresh_token: Annotated[str | None, Cookie(alias=REFRESH_TOKEN_COOKIE)] = None,
) -> Response:
    """アクセストークンを更新する。失敗した場合はCookieを消し、再サインインを求める。"""
    if refresh_token is None:
        return _session_expired()
    try:
        tokens = cognito.refresh(refresh_token)
    except CognitoError as exc:
        logger.warning("refresh rejected: %s", exc)
        return _session_expired()

    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    _set_access_token(response, tokens.access_token)
    return response


def _session_expired() -> JSONResponse:
    response = JSONResponse(
        {"detail": "session expired"}, status_code=status.HTTP_401_UNAUTHORIZED
    )
    _clear_session(response)
    return response


@router.post("/logout")
def logout(
    settings: Annotated[Settings, Depends(get_settings)],
    cognito: Annotated[CognitoClient, Depends(get_cognito_client)],
    refresh_token: Annotated[str | None, Cookie(alias=REFRESH_TOKEN_COOKIE)] = None,
) -> JSONResponse:
    """リフレッシュトークンを失効させ、Hosted UIのサインアウト先を返す。"""
    if refresh_token is not None:
        try:
            cognito.revoke(refresh_token)
        except CognitoError as exc:
            # 失効に失敗してもCookieは消す。トークンは有効期限で失効する
            logger.warning("revoke failed: %s", exc)

    response = JSONResponse({"logoutUrl": cognito.logout_url(settings.app_origin)})
    _clear_session(response)
    return response
