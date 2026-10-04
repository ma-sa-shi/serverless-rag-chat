import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router-dom";
import {
  fetchUser,
  fetchUserQuota,
  listUserChats,
  listUserDocuments,
} from "../api/users";
import { useCurrentUser } from "../auth/useCurrentUser";
import { ChatHistory } from "../components/ChatHistory";
import { DocumentTable } from "../components/DocumentTable";
import { isNotFound, toErrorMessage } from "../lib/errors";
import { useDeleteDocument } from "../lib/useDeleteDocument";
import { useOpenDocument } from "../lib/useOpenDocument";
import "./UserDetail.css";

const dateFormatter = new Intl.DateTimeFormat("ja-JP", {
  dateStyle: "short",
  timeStyle: "short",
});

export function UserDetail() {
  const params = useParams();
  // ルート定義上userIdは必ず入る
  const userId = params.userId!;
  const { data: currentUser } = useCurrentUser();
  const [error, setError] = useState<string | null>(null);
  const { openDocument, openingId } = useOpenDocument(setError);
  const { removeDocument, deletingId } = useDeleteDocument(setError);

  const userQuery = useQuery({
    queryKey: ["user", userId],
    queryFn: () => fetchUser(userId),
  });
  // 他人の画面では「残り」ではなく実績として見せる為、残数ではなく利用回数を表示する
  const quotaQuery = useQuery({
    queryKey: ["user", userId, "quota"],
    queryFn: () => fetchUserQuota(userId),
  });
  const chatsQuery = useQuery({
    queryKey: ["user", userId, "chats"],
    queryFn: () => listUserChats(userId),
  });
  const documentsQuery = useQuery({
    queryKey: ["user", userId, "documents"],
    queryFn: () => listUserDocuments(userId),
  });

  const handleOpen = (documentId: string) => {
    setError(null);
    void openDocument(documentId);
  };

  const handleDelete = (documentId: string) => {
    setError(null);
    removeDocument(documentId);
  };

  return (
    <div className="user-detail">
      <h1 className="page-title">ユーザー</h1>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      {userQuery.isPending && <p className="placeholder">読み込み中…</p>}

      {userQuery.isError &&
        (isNotFound(userQuery.error) ? (
          <p className="placeholder">ユーザーが見つかりません</p>
        ) : (
          <p className="placeholder">
            {toErrorMessage(userQuery.error, "ユーザーを取得できませんでした")}{" "}
            <button type="button" onClick={() => void userQuery.refetch()}>
              再試行
            </button>
          </p>
        ))}

      {userQuery.data && (
        <section className="user-profile">
          <h2>{userQuery.data.displayName}</h2>
          <dl>
            <dt>メールアドレス</dt>
            <dd>{userQuery.data.email}</dd>
            <dt>本日の利用回数</dt>
            <dd>
              {quotaQuery.data
                ? `${quotaQuery.data.used} / ${quotaQuery.data.limit} 回`
                : "—"}
            </dd>
            <dt>登録日時</dt>
            <dd>
              <time dateTime={userQuery.data.createdAt}>
                {dateFormatter.format(new Date(userQuery.data.createdAt))}
              </time>
            </dd>
          </dl>
        </section>
      )}

      <h2 className="section-title">チャット履歴</h2>

      {chatsQuery.isPending && <p className="placeholder">読み込み中…</p>}

      {chatsQuery.isError && (
        <p className="placeholder">
          {toErrorMessage(chatsQuery.error, "履歴を取得できませんでした")}{" "}
          <button type="button" onClick={() => void chatsQuery.refetch()}>
            再試行
          </button>
        </p>
      )}

      {chatsQuery.data &&
        (chatsQuery.data.length === 0 ? (
          <p className="placeholder">チャットはまだありません</p>
        ) : (
          <ChatHistory
            chats={chatsQuery.data}
            currentUserId={currentUser?.userId}
          />
        ))}

      <h2 className="section-title">アップロード履歴</h2>

      {documentsQuery.isPending && <p className="placeholder">読み込み中…</p>}

      {documentsQuery.isError && (
        <p className="placeholder">
          {toErrorMessage(documentsQuery.error, "一覧を取得できませんでした")}{" "}
          <button type="button" onClick={() => void documentsQuery.refetch()}>
            再試行
          </button>
        </p>
      )}

      {documentsQuery.data &&
        (documentsQuery.data.length === 0 ? (
          <p className="placeholder">ドキュメントはまだありません</p>
        ) : (
          <div className="table-scroll">
            {/* 取込は/documentsに集約している為、ここは閲覧と削除だけ */}
            <DocumentTable
              documents={documentsQuery.data}
              currentUserId={currentUser?.userId}
              onOpen={handleOpen}
              openingId={openingId}
              onDelete={handleDelete}
              deletingId={deletingId}
            />
          </div>
        ))}
    </div>
  );
}
