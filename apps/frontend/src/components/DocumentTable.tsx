import { Link } from "react-router-dom";
import type { DocumentSummary } from "../api/documents";
import { StatusBadge } from "./StatusBadge";
import "./DocumentTable.css";

interface DocumentTableProps {
  documents: DocumentSummary[];
  /** サインイン中のユーザーのsub。取込は本人のドキュメントにしか実行できない */
  currentUserId: string | undefined;
  onOpen: (documentId: string) => void;
  openingId: string | null;
  /** ユーザーページのように投稿者が自明な一覧では省く */
  showOwner?: boolean;
  /** 省くと取込開始ボタンを出さない */
  onIngest?: (documentId: string) => void;
  ingestingId?: string | null;
  /** 省くと削除ボタンを出さない */
  onDelete?: (documentId: string) => void;
  deletingId?: string | null;
}

const dateFormatter = new Intl.DateTimeFormat("ja-JP", {
  dateStyle: "short",
  timeStyle: "short",
});

// バックエンドのステータス遷移(uploaded|failed → processing)に合わせる
const INGESTABLE = ["uploaded", "failed"];

export function DocumentTable({
  documents,
  currentUserId,
  onOpen,
  openingId,
  showOwner,
  onIngest,
  ingestingId,
  onDelete,
  deletingId,
}: DocumentTableProps) {
  return (
    <table className="document-table">
      <thead>
        <tr>
          <th scope="col">ファイル名</th>
          <th scope="col">状態</th>
          {showOwner && <th scope="col">投稿者</th>}
          <th scope="col">更新日時</th>
          <th scope="col">操作</th>
        </tr>
      </thead>
      <tbody>
        {documents.map((document) => {
          const canIngest =
            onIngest !== undefined &&
            document.userId === currentUserId &&
            INGESTABLE.includes(document.status);
          // 取込中の削除は後からベクトルが登録される為、バックエンドが409を返す
          const canDelete =
            onDelete !== undefined &&
            document.userId === currentUserId &&
            document.status !== "processing";
          return (
            <tr key={document.documentId}>
              <td className="filename">{document.filename}</td>
              <td>
                <StatusBadge status={document.status} />
              </td>
              {showOwner && (
                <td className="owner">
                  <Link to={`/user/${document.userId}`}>
                    {document.userId === currentUserId
                      ? "自分"
                      : (document.ownerName ?? "ユーザー")}
                  </Link>
                </td>
              )}
              <td className="updated-at">
                {dateFormatter.format(new Date(document.updatedAt))}
              </td>
              <td className="actions">
                <button
                  type="button"
                  onClick={() => onOpen(document.documentId)}
                  disabled={openingId === document.documentId}
                >
                  開く
                </button>
                {canIngest && (
                  <button
                    type="button"
                    className="primary"
                    onClick={() => onIngest(document.documentId)}
                    disabled={ingestingId === document.documentId}
                  >
                    取込開始
                  </button>
                )}
                {canDelete && (
                  <button
                    type="button"
                    className="danger"
                    onClick={() => onDelete(document.documentId)}
                    disabled={deletingId === document.documentId}
                  >
                    削除
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
