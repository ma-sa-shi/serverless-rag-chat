from typing import Annotated

import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.auth import get_current_user_id
from tests.conftest import ISSUER

# DynamoDB等に依存せずJWT検証だけを確かめるための最小アプリ
app = FastAPI()


@app.get("/protected")
def protected(user_id: Annotated[str, Depends(get_current_user_id)]):
    return {"user_id": user_id}


client = TestClient(app)


def get(token: str | None):
    headers = {} if token is None else {"Authorization": f"Bearer {token}"}
    return client.get("/protected", headers=headers)


def test_valid_token_returns_sub_as_user_id(make_token):
    res = get(make_token(sub="user-abc"))
    assert res.status_code == 200
    assert res.json() == {"user_id": "user-abc"}


def test_access_token_cookie_is_accepted_without_header(make_token):
    token = make_token(sub="user-cookie")
    res = client.get("/protected", headers={"Cookie": f"__Host-access_token={token}"})
    assert res.status_code == 200
    assert res.json() == {"user_id": "user-cookie"}


def test_header_takes_precedence_over_cookie(make_token):
    res = client.get(
        "/protected",
        headers={
            "Authorization": f"Bearer {make_token(sub='user-header')}",
            "Cookie": f"__Host-access_token={make_token(sub='user-cookie')}",
        },
    )
    assert res.json() == {"user_id": "user-header"}


def test_invalid_cookie_returns_401():
    res = client.get("/protected", headers={"Cookie": "__Host-access_token=not-a-jwt"})
    assert res.status_code == 401


def test_missing_header_returns_401(make_token):
    res = get(None)
    assert res.status_code == 401
    assert res.headers["WWW-Authenticate"] == "Bearer"


def test_non_jwt_string_returns_401():
    assert get("not-a-jwt").status_code == 401


def test_token_signed_with_other_key_returns_401(make_token):
    other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    assert get(make_token(key=other_key)).status_code == 401


def test_expired_token_returns_401(make_token):
    assert get(make_token(expires_in=-120)).status_code == 401


def test_token_issued_slightly_ahead_of_local_clock_is_accepted(make_token):
    # ローカルの時計がCognitoより遅れていても、発行直後のトークンを拒否しない
    assert get(make_token(issued_in=5)).status_code == 200


def test_token_issued_far_in_the_future_returns_401(make_token):
    assert get(make_token(issued_in=600)).status_code == 401


def test_wrong_issuer_returns_401(make_token):
    res = get(make_token(issuer=f"{ISSUER}-other"))
    assert res.status_code == 401


def test_wrong_client_id_returns_401(make_token):
    assert get(make_token(client_id="other-client")).status_code == 401


@pytest.mark.parametrize("token_use", ["id", None])
def test_non_access_token_returns_401(make_token, token_use):
    assert get(make_token(token_use=token_use)).status_code == 401
