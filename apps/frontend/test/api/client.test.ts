import { AxiosError, type InternalAxiosRequestConfig } from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../src/api/client";

const refreshSession = vi.fn<() => Promise<boolean>>();
vi.mock("../../src/auth/session", () => ({
  refreshSession: () => refreshSession(),
}));

/** 指定した順にステータスを返すアダプタを差し込み、送信したconfigを記録する。 */
function respondWith(...statuses: number[]) {
  const sent: InternalAxiosRequestConfig[] = [];
  api.defaults.adapter = (config) => {
    sent.push(config);
    const status = statuses[sent.length - 1];
    const response = {
      data: {},
      status,
      statusText: "",
      headers: {},
      config,
    };
    if (status >= 400) {
      return Promise.reject(
        new AxiosError("failed", undefined, config, undefined, response),
      );
    }
    return Promise.resolve(response);
  };
  return sent;
}

beforeEach(() => {
  refreshSession.mockReset();
});

afterEach(() => {
  delete api.defaults.adapter;
});

describe("api", () => {
  it("baseURLに/apiを使い、Authorizationヘッダーを付けない", async () => {
    const sent = respondWith(200);

    await api.get("/documents");

    expect(sent[0].baseURL).toBe("/api");
    // アクセストークンはHttpOnly Cookieでブラウザが送る(ADR-0018)
    expect(sent[0].headers.Authorization).toBeUndefined();
  });

  it("401ならセッションを更新して1回だけ送り直す", async () => {
    refreshSession.mockResolvedValue(true);
    const sent = respondWith(401, 200);

    const res = await api.get("/documents");

    expect(res.status).toBe(200);
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(2);
  });

  it("更新に失敗したら送り直さず401を投げる", async () => {
    refreshSession.mockResolvedValue(false);
    const sent = respondWith(401);

    await expect(api.get("/documents")).rejects.toMatchObject({
      response: { status: 401 },
    });
    expect(sent).toHaveLength(1);
  });

  it("送り直しも401なら再度は更新しない", async () => {
    refreshSession.mockResolvedValue(true);
    const sent = respondWith(401, 401);

    await expect(api.get("/documents")).rejects.toMatchObject({
      response: { status: 401 },
    });
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(2);
  });

  it("401以外のエラーは更新せずそのまま投げる", async () => {
    respondWith(403);

    await expect(api.get("/documents")).rejects.toMatchObject({
      response: { status: 403 },
    });
    expect(refreshSession).not.toHaveBeenCalled();
  });
});
