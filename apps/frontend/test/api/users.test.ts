import type { InternalAxiosRequestConfig } from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../src/api/client";
import { fetchUserQuota } from "../../src/api/users";

afterEach(() => {
  vi.restoreAllMocks();
  delete api.defaults.adapter;
});

describe("fetchUserQuota", () => {
  it("ユーザーIDのquotaを取得する", async () => {
    let captured: InternalAxiosRequestConfig | undefined;
    api.defaults.adapter = (config) => {
      captured = config;
      return Promise.resolve({
        data: { limit: 20, used: 3 },
        status: 200,
        statusText: "OK",
        headers: {},
        config,
      });
    };

    const quota = await fetchUserQuota("user-abc");

    expect(captured?.method).toBe("get");
    expect(captured?.url).toBe("/users/user-abc/quota");
    expect(quota).toEqual({ limit: 20, used: 3 });
  });
});
