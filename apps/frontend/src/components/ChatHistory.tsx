import { Link } from "react-router-dom";
import type { ChatSummary } from "../api/chats";
import { GradeBadge } from "./GradeBadge";
import "./ChatHistory.css";

interface ChatHistoryProps {
  chats: ChatSummary[];
  currentUserId: string | undefined;
  /** ユーザーページのように投稿者が自明な一覧では省く */
  showOwner?: boolean;
}

const dateFormatter = new Intl.DateTimeFormat("ja-JP", {
  dateStyle: "short",
  timeStyle: "short",
});

export function ChatHistory({
  chats,
  currentUserId,
  showOwner,
}: ChatHistoryProps) {
  return (
    <ul className="chat-history">
      {chats.map((chat) => (
        // アンカーは入れ子にできない為、行リンクと投稿者リンクをliへ並べる
        <li className="chat-history-row" key={chat.chatId}>
          <Link className="chat-history-item" to={`/chat/${chat.chatId}`}>
            <span className="chat-question">{chat.question}</span>
            <span className="chat-meta">
              {chat.finalGrade && <GradeBadge grade={chat.finalGrade} />}
              {chat.retryCount > 0 && (
                <span className="chat-retry">再試行{chat.retryCount}回</span>
              )}
              <time dateTime={chat.createdAt}>
                {dateFormatter.format(new Date(chat.createdAt))}
              </time>
            </span>
          </Link>
          {showOwner && (
            <Link className="chat-owner" to={`/user/${chat.userId}`}>
              {chat.userId === currentUserId
                ? "自分"
                : (chat.ownerName ?? "ユーザー")}
            </Link>
          )}
        </li>
      ))}
    </ul>
  );
}
