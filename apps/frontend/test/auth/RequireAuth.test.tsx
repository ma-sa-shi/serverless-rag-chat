import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { AxiosError, AxiosHeaders } from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RequireAuth } from "../../src/auth/RequireAuth";

const fetchMe = vi.fn();
vi.mock("../../src/api/users", () => ({
  fetchMe: () => fetchMe(),
}));

const redirectToSignin = vi.fn();
vi.mock("../../src/auth/session", () => ({
  redirectToSignin: () => redirectToSignin(),
}));

function httpError(status: number): AxiosError {
  const config = { headers: new AxiosHeaders() };
  return new AxiosError("failed", undefined, config, undefined, {
    data: {},
    status,
    statusText: "",
    headers: {},
    config,
  });
}

function renderGuarded() {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <RequireAuth>
        <p>保護された画面</p>
      </RequireAuth>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("RequireAuth", () => {
  it("ユーザーを取得できたら子要素を表示する", async () => {
    fetchMe.mockResolvedValue({ userId: "user-1" });

    renderGuarded();

    expect(await screen.findByText("保護された画面")).toBeInTheDocument();
    expect(redirectToSignin).not.toHaveBeenCalled();
  });

  it("401ならサインインへ遷移し、子要素を表示しない", async () => {
    fetchMe.mockRejectedValue(httpError(401));

    renderGuarded();

    await vi.waitFor(() => expect(redirectToSignin).toHaveBeenCalledTimes(1));
    expect(screen.getByText("サインインしています…")).toBeInTheDocument();
    expect(screen.queryByText("保護された画面")).not.toBeInTheDocument();
  });

  it("401以外の失敗は再読み込みを案内する", async () => {
    fetchMe.mockRejectedValue(httpError(500));

    renderGuarded();

    expect(
      await screen.findByText(
        "ユーザー情報を取得できませんでした。ページを再読み込みしてください。",
      ),
    ).toBeInTheDocument();
    expect(redirectToSignin).not.toHaveBeenCalled();
  });
});
