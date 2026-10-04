import axios from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  redirectToSignin,
  refreshSession,
  removeLegacyTokens,
  signOut,
} from "../../src/auth/session";

function stubLocation() {
  const assign = vi.fn();
  vi.stubGlobal("location", {
    pathname: "/chat/abc",
    search: "?tab=1",
    assign,
  });
  return assign;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("refreshSession", () => {
  it("同時の呼び出しは1回の更新を共有する", async () => {
    let resolve: () => void = () => undefined;
    const post = vi.spyOn(axios, "post").mockReturnValue(
      new Promise((r) => {
        resolve = () => r({ status: 204 });
      }),
    );

    const first = refreshSession();
    const second = refreshSession();
    resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("/api/auth/refresh");
  });

  it("更新が終わった後の呼び出しは改めて更新する", async () => {
    const post = vi.spyOn(axios, "post").mockResolvedValue({ status: 204 });

    await refreshSession();
    await refreshSession();

    expect(post).toHaveBeenCalledTimes(2);
  });

  it("更新が拒否されたらfalseを返す", async () => {
    vi.spyOn(axios, "post").mockRejectedValue(new Error("401"));

    await expect(refreshSession()).resolves.toBe(false);
  });
});

describe("redirectToSignin", () => {
  it("今のパスとクエリをreturnToに付けてサインインへ遷移する", () => {
    const assign = stubLocation();

    redirectToSignin();

    expect(assign).toHaveBeenCalledWith(
      `/api/auth/login?returnTo=${encodeURIComponent("/chat/abc?tab=1")}`,
    );
  });
});

describe("signOut", () => {
  it("Cookieを消した後、返されたCognitoのログアウトURLへ遷移する", async () => {
    const assign = stubLocation();
    const post = vi.spyOn(axios, "post").mockResolvedValue({
      data: { logoutUrl: "https://auth.example.com/logout?client_id=c" },
    });

    await signOut();

    expect(post).toHaveBeenCalledWith("/api/auth/logout");
    expect(assign).toHaveBeenCalledWith(
      "https://auth.example.com/logout?client_id=c",
    );
  });
});

describe("removeLegacyTokens", () => {
  it("oidc-client-tsが保存したキーだけを消す", () => {
    window.localStorage.setItem("oidc.user:https://issuer:client", "{}");
    window.localStorage.setItem("oidc.state", "{}");
    window.localStorage.setItem("other", "keep");

    removeLegacyTokens(window.localStorage);

    expect(Object.keys(window.localStorage)).toEqual(["other"]);
  });
});
