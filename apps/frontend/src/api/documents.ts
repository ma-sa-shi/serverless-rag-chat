import axios from "axios";
import { api } from "./client";

export type DocumentStatus =
  "uploading" | "uploaded" | "processing" | "ingested" | "failed";

export interface DocumentSummary {
  documentId: string;
  userId: string;
  filename: string;
  status: DocumentStatus;
  createdAt: string;
  updatedAt: string;
  /** 全ユーザー横断の一覧だけが返す。プロフィールが未登録の投稿者はnull */
  ownerName?: string | null;
}

interface CreateUploadUrlResponse {
  documentId: string;
  uploadUrl: string;
}

interface DownloadUrlResponse {
  downloadUrl: string;
  filename: string;
}

/** 全ユーザー横断のドキュメント一覧を新しい順で取得する。 */
export async function listDocuments(): Promise<DocumentSummary[]> {
  const res = await api.get<DocumentSummary[]>("/documents");
  return res.data;
}

/** uploading状態でドキュメントを登録し、アップロード用の署名付きPUT URLを取得する。 */
export async function createUploadUrl(
  filename: string,
  contentType: string,
): Promise<CreateUploadUrlResponse> {
  const res = await api.post<CreateUploadUrlResponse>("/documents/upload-url", {
    filename,
    contentType,
  });
  return res.data;
}

/** 署名付きURLでS3へ直接アップロードする。
 *
 * apiインスタンスはAuthorizationヘッダーを付与するインターセプタを持ち、
 * 署名付きURLへ送ると認証方式の重複でS3が400を返す為、ここでは素のaxiosを使う。
 * Content-Typeは署名に含まれているので、URL発行時と同じ値を送る必要がある。
 */
export async function putToS3(
  uploadUrl: string,
  file: File,
  contentType: string,
): Promise<void> {
  await axios.put(uploadUrl, file, {
    headers: { "Content-Type": contentType },
  });
}

/** アップロード完了を登録し、ステータスをuploadedにする。 */
export async function completeUpload(documentId: string): Promise<void> {
  await api.post(`/documents/${documentId}/complete`);
}

/** 取込をキューへ送り、ステータスをprocessingにする。 */
export async function startIngest(documentId: string): Promise<void> {
  await api.post(`/documents/${documentId}/ingest`);
}

/** ベクトル・原本・レコードをまとめて削除する。削除できるのは自分のドキュメントのみ。 */
export async function deleteDocument(documentId: string): Promise<void> {
  await api.delete(`/documents/${documentId}`);
}

/** 原本閲覧用の署名付きGET URLを取得する。 */
export async function fetchDownloadUrl(
  documentId: string,
): Promise<DownloadUrlResponse> {
  const res = await api.get<DownloadUrlResponse>(
    `/documents/${documentId}/download-url`,
  );
  return res.data;
}
