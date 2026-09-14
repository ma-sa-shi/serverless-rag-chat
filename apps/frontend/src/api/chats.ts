import { userManager } from "../auth/userManager";
import { toAuthErrorMessage } from "../lib/errors";
import { readSse } from "../lib/sse";
import { api } from "./client";

/** 回答評価の結果。バックエンドのapp/rag/state.pyと対応する。 */
export type ChatGrade = "useful" | "useless" | "hallucination";

export interface ChatSummary {
  chatId: string;
  userId: string;
  question: string;
  finalAnswer: string | null;
  finalGrade: ChatGrade | null;
  retryCount: number;
  createdAt: string;
  /** 全ユーザー横断の一覧だけが返す。プロフィールが未登録の投稿者はnull */
  ownerName?: string | null;
}

export interface RetrievedDocument {
  documentId: string | null;
  filename: string | null;
  text: string | null;
  /** Rerankを通っていない場合はnull */
  score: number | null;
}

/** バックエンドのapp/rag/nodes.pyの関数名がそのまま識別子になっており、片方だけ変えると進行表示が壊れる。 */
export type RagNode =
  | "generate_queries_node"
  | "retrieve_contexts_node"
  | "generate_answer_node"
  | "grade_answer_node"
  | "analyze_failure_node";

/** キーはバックエンドのGraphStateに合わせたsnake_case。documentsの中身だけは他のAPIと同じcamelCaseで届く。
 * ノードは更新したキーだけを載せる為、全てoptional。
 */
export interface RagNodeState {
  queries?: string[];
  retry_count?: number;
  documents?: RetrievedDocument[];
  answer?: string;
  grade?: ChatGrade;
  feedback?: string;
  failure_analysis?: string;
}

export interface ChatNodeUpdate {
  node: RagNode;
  state: RagNodeState;
}

/** doneイベントで届く生成結果。回答本文は含まれず、進行表示の最後の試行が持つ。 */
export interface ChatCompletion {
  chatId: string;
  finalGrade: ChatGrade | null;
  retryCount: number;
}

/** 保存済みの1試行。失敗分析のように生成されない項目はnullで届く。 */
export interface ChatAttempt {
  attemptNo: number;
  queries: string[];
  documents: RetrievedDocument[];
  answer: string | null;
  grade: ChatGrade | null;
  feedback: string | null;
  failureAnalysis: string | null;
}

export interface ChatDetail extends ChatSummary {
  attempts: ChatAttempt[];
}

interface ErrorPayload {
  message: string;
  requestId: string;
}

/** 失敗の扱いを1箇所へまとめる為、SSEのerrorイベントはonEventへ渡さずthrowへ寄せる。 */
export type ChatStreamEvent =
  ({ type: "update" } & ChatNodeUpdate) | ({ type: "done" } & ChatCompletion);

export async function listChats(): Promise<ChatSummary[]> {
  const res = await api.get<ChatSummary[]>("/chats");
  return res.data;
}

/** チャット1件を試行ごとの全出力付きで取得する。 */
export async function getChat(chatId: string): Promise<ChatDetail> {
  const res = await api.get<ChatDetail>(`/chats/${chatId}`);
  return res.data;
}

/** API Gatewayの統合タイムアウトや接続の切断では、doneもerrorも届かないまま
 * bodyが閉じる。この終わり方を成功と取り違えないよう、中断として利用者に伝える。
 */
const INTERRUPTED_MESSAGE =
  "回答の生成が中断されました。もう一度お試しください。";

/** 429のdetailを読めなかった場合にだけ使う。通常はサーバーの文言を表示する。 */
const QUOTA_EXCEEDED_MESSAGE =
  "本日の利用上限に達しました。日付が変わると再び送信できます。";

/** POST + Authorizationヘッダーで購読する理由はADR-0012。
 * axiosは逐次読み出しに対応しない為ここだけfetchを使い、client.tsのインターセプタ相当を自前で書く。
 */
export async function streamChat(
  question: string,
  onEvent: (event: ChatStreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const user = await userManager.getUser();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  // トークンが無い場合はヘッダーを付けず、サーバー側に401を返させる
  if (user?.access_token) {
    headers.Authorization = `Bearer ${user.access_token}`;
  }

  let res: Response;
  try {
    res = await fetch("/api/chats/stream", {
      method: "POST",
      headers,
      body: JSON.stringify({ question }),
      signal,
    });
  } catch (e) {
    // 中断は呼び出し側で区別する為そのまま投げ直す
    if (e instanceof Error && e.name === "AbortError") throw e;
    throw new Error(
      "回答の生成に失敗しました（サーバーに接続できませんでした）",
      {
        cause: e,
      },
    );
  }

  // fetchは4xx/5xxでrejectしない為、ステータスを自分で確認する
  if (!res.ok) {
    const authMessage = toAuthErrorMessage(res.status);
    if (authMessage) {
      throw new Error(authMessage);
    }
    // 上限超過は生成の失敗ではない為、「回答の生成に失敗しました」で包まずそのまま見せる
    if (res.status === 429) {
      throw new Error((await readDetail(res)) ?? QUOTA_EXCEEDED_MESSAGE);
    }
    throw new Error(await toResponseMessage(res));
  }
  if (!res.body) {
    throw new Error(INTERRUPTED_MESSAGE);
  }

  for await (const sse of readSse(res.body)) {
    if (sse.event === "update") {
      const update = JSON.parse(sse.data) as ChatNodeUpdate;
      onEvent({ type: "update", ...update });
    } else if (sse.event === "done") {
      const completion = JSON.parse(sse.data) as ChatCompletion;
      onEvent({ type: "done", ...completion });
      return;
    } else if (sse.event === "error") {
      const { message, requestId } = JSON.parse(sse.data) as ErrorPayload;
      throw new Error(`${message}（リクエストID: ${requestId}）`);
    }
    // 上記以外のイベント名(KeepAlive等)は画面へ出さず読み飛ばす
  }

  throw new Error(INTERRUPTED_MESSAGE);
}

async function toResponseMessage(res: Response): Promise<string> {
  const detail = await readDetail(res);
  return detail === null
    ? `回答の生成に失敗しました（HTTP ${res.status}）`
    : `回答の生成に失敗しました（${detail}）`;
}

/** FastAPIのHTTPExceptionが返す{"detail": "..."}を取り出す。 */
async function readDetail(res: Response): Promise<string | null> {
  try {
    const body: unknown = await res.json();
    const detail = (body as { detail?: unknown }).detail;
    return typeof detail === "string" ? detail : null;
  } catch {
    return null;
  }
}
