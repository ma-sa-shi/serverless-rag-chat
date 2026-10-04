import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { ChatCompletion } from "../api/chats";
import { listChats, streamChat } from "../api/chats";
import { fetchUserQuota } from "../api/users";
import { useCurrentUser } from "../auth/useCurrentUser";
import { ChatHistory } from "../components/ChatHistory";
import { ChatProgress } from "../components/ChatProgress";
import { GradeBadge } from "../components/GradeBadge";
import { QuestionForm } from "../components/QuestionForm";
import type { Attempt } from "../lib/chatProgress";
import { applyUpdate } from "../lib/chatProgress";
import { toErrorMessage } from "../lib/errors";
import "./Home.css";

const CHATS_QUERY_KEY = ["chats"];

export function Home() {
  const { data: currentUser } = useCurrentUser();
  const queryClient = useQueryClient();
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [completion, setCompletion] = useState<ChatCompletion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 生成中に画面を離れた場合、レスポンスの読み出しを止める
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const chatsQuery = useQuery({
    queryKey: CHATS_QUERY_KEY,
    queryFn: listChats,
  });

  const userId = currentUser?.userId;
  const quotaQuery = useQuery({
    queryKey: ["user", userId, "quota"],
    queryFn: () => fetchUserQuota(userId!),
    enabled: userId !== undefined,
  });

  const chatMutation = useMutation({
    mutationFn: async (question: string) => {
      const controller = new AbortController();
      abortRef.current = controller;
      await streamChat(
        question,
        (event) => {
          if (event.type === "done") {
            setCompletion(event);
          } else {
            setAttempts((current) => applyUpdate(current, event));
          }
        },
        controller.signal,
      );
    },
    // 完了したチャットが履歴一覧へ載るよう取り直す
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: CHATS_QUERY_KEY }),
    // 上限超過で拒否された場合も残数の表示を合わせる為、成功・失敗を問わず取り直す
    onSettled: () =>
      void queryClient.invalidateQueries({
        queryKey: ["user", userId, "quota"],
      }),
    onError: (e) => {
      // 画面遷移による中断は利用者の操作なので、エラーとして見せない
      if (e instanceof Error && e.name === "AbortError") return;
      // streamChatは表示用の日本語メッセージを載せてthrowする
      setError(toErrorMessage(e, e.message));
    },
  });

  const handleSubmit = async (question: string) => {
    // 前回の結果に新しい進行状況を重ねない
    setAttempts([]);
    setCompletion(null);
    setError(null);
    try {
      await chatMutation.mutateAsync(question);
      return true;
    } catch {
      return false; // エラー表示はonErrorで行う
    }
  };

  // 最終回答はdone受信後に確定する(再試行した場合は最後の試行の回答)
  const finalAnswer = completion ? attempts.at(-1)?.answer : undefined;

  return (
    <div className="home">
      <h1 className="page-title">チャット</h1>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      <QuestionForm
        onSubmit={handleSubmit}
        isStreaming={chatMutation.isPending}
        quota={quotaQuery.data}
      />

      {attempts.length > 0 && (
        <ChatProgress
          attempts={attempts}
          isStreaming={chatMutation.isPending}
        />
      )}

      {completion && finalAnswer !== undefined && (
        <section className="final-answer">
          <div className="final-answer-head">
            <h2>回答</h2>
            {completion.finalGrade && (
              <GradeBadge grade={completion.finalGrade} />
            )}
            <Link to={`/chat/${completion.chatId}`}>詳細を見る</Link>
          </div>
          <p className="final-answer-body">{finalAnswer}</p>
          {/* 評価がusefulに達しない場合、バックエンドは必ず1回再試行してから終える */}
          {completion.finalGrade && completion.finalGrade !== "useful" && (
            <p className="final-answer-note">
              再試行しても自己評価が「有用」に達しませんでした。取り込み済みのドキュメントに根拠が無い可能性があります。
            </p>
          )}
        </section>
      )}

      <h2 className="history-title">チャット履歴</h2>

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
            currentUserId={userId}
            showOwner
          />
        ))}
    </div>
  );
}
