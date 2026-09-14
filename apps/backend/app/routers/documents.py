from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from ulid import ULID

from app.auth import get_current_user_id
from app.dependencies import (
    get_document_repository,
    get_document_storage,
    get_ingest_queue,
    get_user_repository,
    get_vector_index,
)
from app.ingest_queue import IngestQueue
from app.logger import logger
from app.repositories.documents import DocumentRepository, DocumentStatusError
from app.repositories.users import UserRepository
from app.schemas import DocumentResponse
from app.storage import DocumentStorage
from app.vectors import VectorIndex

router = APIRouter(prefix="/documents")


class DocumentListItemResponse(DocumentResponse):
    # プロフィールが未登録の投稿者はnull
    owner_name: str | None = Field(alias="ownerName", default=None)


class CreateUploadUrlRequest(BaseModel):
    filename: str = Field(min_length=1)
    content_type: str | None = Field(alias="contentType", default=None)


class CreateUploadUrlResponse(BaseModel):
    document_id: str = Field(alias="documentId")
    upload_url: str = Field(alias="uploadUrl")


class DownloadUrlResponse(BaseModel):
    download_url: str = Field(alias="downloadUrl")
    filename: str


class IngestResponse(BaseModel):
    document_id: str = Field(alias="documentId")
    status: str


@router.get("")
def list_documents(
    _caller_id: Annotated[str, Depends(get_current_user_id)],
    repository: Annotated[DocumentRepository, Depends(get_document_repository)],
    user_repository: Annotated[UserRepository, Depends(get_user_repository)],
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
) -> list[DocumentListItemResponse]:
    """全ユーザー横断のドキュメント一覧を、投稿者の表示名を付けて新しい順で返す。"""
    documents = repository.list_recent(limit)
    names = user_repository.get_display_names(
        {document["userId"] for document in documents}
    )
    return [
        DocumentListItemResponse.model_validate(
            {**document, "ownerName": names.get(document["userId"])}
        )
        for document in documents
    ]


@router.post("/upload-url", status_code=status.HTTP_201_CREATED)
def register_document_for_upload(
    body: CreateUploadUrlRequest,
    user_id: Annotated[str, Depends(get_current_user_id)],
    repository: Annotated[DocumentRepository, Depends(get_document_repository)],
    storage: Annotated[DocumentStorage, Depends(get_document_storage)],
) -> CreateUploadUrlResponse:
    """uploading状態のドキュメントを登録し、アップロード用presigned PUT URLを発行する。"""
    document_id = str(ULID())
    s3_key = f"documents/{user_id}/{document_id}/{body.filename}"
    repository.create(
        user_id=user_id,
        document_id=document_id,
        filename=body.filename,
        s3_key=s3_key,
    )
    upload_url = storage.presign_put(s3_key, body.content_type)
    logger.info("document upload url issued", document_id=document_id)
    return CreateUploadUrlResponse(documentId=document_id, uploadUrl=upload_url)


@router.post("/{document_id}/complete", status_code=status.HTTP_204_NO_CONTENT)
def complete_upload(
    document_id: str,
    user_id: Annotated[str, Depends(get_current_user_id)],
    repository: Annotated[DocumentRepository, Depends(get_document_repository)],
) -> None:
    """S3へのアップロード完了を登録し、ステータスをuploadedにする(冪等)。"""
    if repository.get_owned(user_id, document_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="document not found")
    try:
        repository.update_status(
            user_id, document_id, "uploaded", allowed_from=("uploading", "uploaded")
        )
    except DocumentStatusError:
        raise HTTPException(
            status.HTTP_409_CONFLICT, detail="document is not awaiting upload"
        ) from None
    logger.info("document upload completed", document_id=document_id)


@router.post("/{document_id}/ingest", status_code=status.HTTP_202_ACCEPTED)
def start_ingest(
    document_id: str,
    request: Request,
    user_id: Annotated[str, Depends(get_current_user_id)],
    repository: Annotated[DocumentRepository, Depends(get_document_repository)],
    queue: Annotated[IngestQueue, Depends(get_ingest_queue)],
) -> IngestResponse:
    """SQSへ取込要求を送信し、ステータスをprocessingにする。"""
    # ステータス更新→SQS送信の順序の理由はADR-0007のAddendumを参照
    document = repository.get_owned(user_id, document_id)
    if document is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="document not found")
    try:
        repository.update_status(
            user_id, document_id, "processing", allowed_from=("uploaded", "failed")
        )
    except DocumentStatusError:
        raise HTTPException(
            status.HTTP_409_CONFLICT, detail="document is not ready for ingest"
        ) from None
    try:
        queue.send(
            document_id=document_id,
            user_id=user_id,
            s3_key=document["s3Key"],
            request_id=request.state.request_id,
        )
    except Exception:
        # 送信できていないので元のステータスへ戻し、再実行できるようにする
        repository.update_status(
            user_id, document_id, document["status"], allowed_from=("processing",)
        )
        raise
    logger.info("document ingest queued", document_id=document_id)
    return IngestResponse(documentId=document_id, status="processing")


@router.delete("/{document_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_document(
    document_id: str,
    user_id: Annotated[str, Depends(get_current_user_id)],
    repository: Annotated[DocumentRepository, Depends(get_document_repository)],
    storage: Annotated[DocumentStorage, Depends(get_document_storage)],
    vector_index: Annotated[VectorIndex, Depends(get_vector_index)],
) -> None:
    """ベクトル・原本・レコードをまとめて削除する。削除できるのは本人のドキュメントのみ。"""
    # DynamoDBのレコードを最後に消すことで、途中で失敗しても同じ手順で再実行できる
    document = repository.get_owned(user_id, document_id)
    if document is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="document not found")
    if document["status"] == "processing":
        raise HTTPException(
            status.HTTP_409_CONFLICT, detail="document is being ingested"
        )

    # 未取込のドキュメントはchunkCountを持たない。Decimalのままではrange()へ渡せない
    chunk_count = int(document.get("chunkCount", 0))
    vector_index.delete_document(document_id, chunk_count)
    storage.delete_object(document["s3Key"])
    try:
        repository.delete(user_id, document_id)
    except DocumentStatusError:
        raise HTTPException(
            status.HTTP_409_CONFLICT, detail="document is being ingested"
        ) from None
    logger.info("document deleted", document_id=document_id, chunk_count=chunk_count)


@router.get("/{document_id}/download-url")
def issue_download_url(
    document_id: str,
    _caller_id: Annotated[str, Depends(get_current_user_id)],
    repository: Annotated[DocumentRepository, Depends(get_document_repository)],
    storage: Annotated[DocumentStorage, Depends(get_document_storage)],
) -> DownloadUrlResponse:
    """閲覧用presigned GET URLを発行する。全ユーザーのドキュメントを対象とする。"""
    document = repository.get(document_id)
    if document is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="document not found")
    return DownloadUrlResponse(
        downloadUrl=storage.presign_get(document["s3Key"]),
        filename=document["filename"],
    )
