import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamChat } from "../../src/api/chats";
import type { ChatStreamEvent } from "../../src/api/chats";
import { streamOf } from "../helpers/stream";

const refreshSession = vi.fn<() => Promise<boolean>>();
vi.mock("../../src/auth/session", () => ({
  refreshSession: () => refreshSession(),
}));

const INTERRUPTED_MESSAGE =
  "回答の生成が中断されました。もう一度お試しください。";

function stubFetchSequence(...responses: Response[]) {
  const fetchMock = vi.fn<typeof fetch>();
  for (const response of responses) {
    fetchMock.mockResolvedValueOnce(response);
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stubFetch(response: Response | Error) {
  const fetchMock = vi.fn<typeof fetch>(() => {
    if (response instanceof Error) return Promise.reject(response);
    return Promise.resolve(response);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sseResponse(...chunks: string[]): Response {
  return new Response(streamOf(...chunks), { status: 200 });
}

function collector() {
  const events: ChatStreamEvent[] = [];
  return { events, onEvent: (event: ChatStreamEvent) => events.push(event) };
}

beforeEach(() => {
  refreshSession.mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("streamChat", () => {
  it("updateとdoneを届いた順にonEventへ渡し、doneで終了する", async () => {
    stubFetch(
      sseResponse(
        'event: update\ndata: {"node":"generate_queries_node","state":{"retry_count":0}}\n\n',
        'event: done\ndata: {"chatId":"chat-1","finalGrade":"useful","retryCount":0}\n\n',
      ),
    );
    const { events, onEvent } = collector();

    await streamChat("質問", onEvent, new AbortController().signal);

    expect(events).toEqual([
      {
        type: "update",
        node: "generate_queries_node",
        state: { retry_count: 0 },
      },
      {
        type: "done",
        chatId: "chat-1",
        finalGrade: "useful",
        retryCount: 0,
      },
    ]);
  });

  it("doneより後のイベントは読まない", async () => {
    stubFetch(
      sseResponse(
        'event: done\ndata: {"chatId":"chat-1","finalGrade":null,"retryCount":0}\n\n',
        'event: update\ndata: {"node":"generate_answer_node","state":{}}\n\n',
      ),
    );
    const { events, onEvent } = collector();

    await streamChat("質問", onEvent, new AbortController().signal);

    expect(events).toHaveLength(1);
  });

  it("トークンはCookieに任せ、Authorizationヘッダーを付けない", async () => {
    const fetchMock = stubFetch(
      sseResponse(
        'event: done\ndata: {"chatId":"c","finalGrade":null,"retryCount":0}\n\n',
      ),
    );
    const signal = new AbortController().signal;

    await streamChat("質問", collector().onEvent, signal);

    expect(fetchMock).toHaveBeenCalledWith("/api/chats/stream", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ question: "質問" }),
      signal,
    });
  });

  it("401ならセッションを更新して1回だけ送り直す", async () => {
    const fetchMock = stubFetchSequence(
      new Response("", { status: 401 }),
      sseResponse(
        'event: done\ndata: {"chatId":"c","finalGrade":null,"retryCount":0}\n\n',
      ),
    );
    const { events, onEvent } = collector();

    await streamChat("質問", onEvent, new AbortController().signal);

    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      { type: "done", chatId: "c", finalGrade: null, retryCount: 0 },
    ]);
  });

  it("更新に失敗したら送り直さず認証切れの案内をthrowする", async () => {
    refreshSession.mockResolvedValue(false);
    const fetchMock = stubFetch(new Response("", { status: 401 }));

    await expect(
      streamChat("質問", collector().onEvent, new AbortController().signal),
    ).rejects.toThrow("認証の有効期限が切れた可能性があります。");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("送り直しも401なら再度は更新しない", async () => {
    const fetchMock = stubFetchSequence(
      new Response("", { status: 401 }),
      new Response("", { status: 401 }),
    );

    await expect(
      streamChat("質問", collector().onEvent, new AbortController().signal),
    ).rejects.toThrow("認証の有効期限が切れた可能性があります。");
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("errorイベントでリクエストID付きのエラーをthrowする", async () => {
    stubFetch(
      sseResponse(
        'event: error\ndata: {"message":"生成に失敗しました","requestId":"req-1"}\n\n',
      ),
    );

    await expect(
      streamChat("質問", collector().onEvent, new AbortController().signal),
    ).rejects.toThrow("生成に失敗しました（リクエストID: req-1）");
  });

  it("401と403のレスポンスで認証切れの案内をthrowする", async () => {
    refreshSession.mockResolvedValue(false);
    for (const status of [401, 403]) {
      stubFetch(new Response("", { status }));

      await expect(
        streamChat("質問", collector().onEvent, new AbortController().signal),
      ).rejects.toThrow(
        "認証の有効期限が切れた可能性があります。ページを再読み込みしてください。",
      );
    }
  });

  it("エラーレスポンスのdetailをメッセージへ含める", async () => {
    stubFetch(
      new Response(JSON.stringify({ detail: "質問が長すぎます" }), {
        status: 422,
      }),
    );

    await expect(
      streamChat("質問", collector().onEvent, new AbortController().signal),
    ).rejects.toThrow("回答の生成に失敗しました（質問が長すぎます）");
  });

  it("429は生成の失敗として包まず、サーバーの文言をそのまま投げる", async () => {
    stubFetch(
      new Response(
        JSON.stringify({
          detail:
            "本日の利用上限(20回)に達しました。日付が変わると再び送信できます。",
        }),
        { status: 429 },
      ),
    );

    await expect(
      streamChat("質問", () => {}, new AbortController().signal),
    ).rejects.toThrow(
      "本日の利用上限(20回)に達しました。日付が変わると再び送信できます。",
    );
  });

  it("detailのないエラーレスポンスはステータスを添える", async () => {
    stubFetch(new Response("Internal Server Error", { status: 500 }));

    await expect(
      streamChat("質問", collector().onEvent, new AbortController().signal),
    ).rejects.toThrow("回答の生成に失敗しました（HTTP 500）");
  });

  it("doneが届かないままbodyが閉じたら中断のエラーをthrowする", async () => {
    stubFetch(
      sseResponse(
        'event: update\ndata: {"node":"generate_answer_node","state":{}}\n\n',
      ),
    );

    await expect(
      streamChat("質問", collector().onEvent, new AbortController().signal),
    ).rejects.toThrow(INTERRUPTED_MESSAGE);
  });

  it("bodyのないレスポンスも中断として扱う", async () => {
    stubFetch(new Response(null, { status: 200 }));

    await expect(
      streamChat("質問", collector().onEvent, new AbortController().signal),
    ).rejects.toThrow(INTERRUPTED_MESSAGE);
  });

  it("AbortErrorはそのまま投げ直す", async () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    stubFetch(abortError);

    await expect(
      streamChat("質問", collector().onEvent, new AbortController().signal),
    ).rejects.toBe(abortError);
  });

  it("通信エラーは接続失敗の案内へ包み、原因を残す", async () => {
    const cause = new TypeError("Failed to fetch");
    stubFetch(cause);

    const promise = streamChat(
      "質問",
      collector().onEvent,
      new AbortController().signal,
    );

    await expect(promise).rejects.toThrow(
      "回答の生成に失敗しました（サーバーに接続できませんでした）",
    );
    await expect(promise).rejects.toHaveProperty("cause", cause);
  });

  it("未知のイベント名を読み飛ばす", async () => {
    stubFetch(
      sseResponse(
        "event: ping\ndata: {}\n\n",
        'event: done\ndata: {"chatId":"c","finalGrade":null,"retryCount":0}\n\n',
      ),
    );
    const { events, onEvent } = collector();

    await streamChat("質問", onEvent, new AbortController().signal);

    expect(events).toEqual([
      { type: "done", chatId: "c", finalGrade: null, retryCount: 0 },
    ]);
  });
});
