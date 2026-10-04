from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.auth import get_current_user_id
from app.dependencies import (
    get_chat_repository,
    get_document_repository,
    get_quota_repository,
    get_user_repository,
)
from app.repositories.chats import ChatRepository
from app.repositories.documents import DocumentRepository
from app.repositories.quota import QuotaRepository
from app.repositories.users import UserRepository
from app.schemas import ChatSummaryResponse, DocumentResponse

router = APIRouter(prefix="/users")


class UpsertProfileRequest(BaseModel):
    # 値はCognitoのIDトークンclaims由来のため形式検証はしない
    display_name: str = Field(alias="displayName", min_length=1)
    email: str = Field(min_length=1)


class QuotaResponse(BaseModel):
    limit: int
    used: int


class UserResponse(BaseModel):
    user_id: str = Field(alias="userId")
    display_name: str = Field(alias="displayName")
    email: str
    created_at: str = Field(alias="createdAt")
    updated_at: str = Field(alias="updatedAt")


@router.post("/me", status_code=status.HTTP_204_NO_CONTENT)
def upsert_me(
    body: UpsertProfileRequest,
    user_id: Annotated[str, Depends(get_current_user_id)],
    repository: Annotated[UserRepository, Depends(get_user_repository)],
) -> None:
    """サインイン時にSPAから呼ばれ、Cognitoの表示名とメールをキャッシュする(冪等)。"""
    repository.upsert_profile(user_id, body.display_name, body.email)


# `/{user_id}`より先に定義しないと、"me"がユーザーIDとして扱われる
@router.get("/me")
def get_me(
    user_id: Annotated[str, Depends(get_current_user_id)],
    repository: Annotated[UserRepository, Depends(get_user_repository)],
) -> UserResponse:
    """サインイン中のユーザーのプロフィールを返す。サインイン時に同期済みである。"""
    profile = repository.get_profile(user_id)
    if profile is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="user not found")
    return UserResponse.model_validate({**profile, "userId": user_id})


@router.get("/{user_id}")
def get_user(
    user_id: str,
    _caller_id: Annotated[str, Depends(get_current_user_id)],
    repository: Annotated[UserRepository, Depends(get_user_repository)],
) -> UserResponse:
    """ユーザー画面表示用のプロフィールを返す。他ユーザーも取得できる。"""
    profile = repository.get_profile(user_id)
    if profile is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="user not found")
    return UserResponse.model_validate({**profile, "userId": user_id})


@router.get("/{user_id}/quota")
def get_user_quota(
    user_id: str,
    _caller_id: Annotated[str, Depends(get_current_user_id)],
    repository: Annotated[QuotaRepository, Depends(get_quota_repository)],
) -> QuotaResponse:
    """指定ユーザーの本日の利用状況を返す。他ユーザーも取得できる。

    プロフィールの有無は問わない。未使用のユーザーはused=0を返す。
    """
    quota = repository.get_status(user_id)
    return QuotaResponse(limit=quota.limit, used=quota.used)


@router.get("/{user_id}/documents")
def list_user_documents(
    user_id: str,
    _caller_id: Annotated[str, Depends(get_current_user_id)],
    repository: Annotated[DocumentRepository, Depends(get_document_repository)],
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
) -> list[DocumentResponse]:
    """指定ユーザーのドキュメント一覧を新しい順で返す。"""
    return [
        DocumentResponse.model_validate(item)
        for item in repository.list_by_user(user_id, limit)
    ]


@router.get("/{user_id}/chats")
def list_user_chats(
    user_id: str,
    _caller_id: Annotated[str, Depends(get_current_user_id)],
    repository: Annotated[ChatRepository, Depends(get_chat_repository)],
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
) -> list[ChatSummaryResponse]:
    """指定ユーザーのチャット一覧を新しい順で返す。"""
    return [
        ChatSummaryResponse.model_validate(item)
        for item in repository.list_by_user(user_id, limit)
    ]
