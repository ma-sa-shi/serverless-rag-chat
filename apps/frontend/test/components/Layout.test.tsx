import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Layout } from "../../src/components/Layout";

const signoutRedirect = vi.fn();
const removeUser = vi.fn();

vi.mock("react-oidc-context", () => ({
  useAuth: () => ({
    user: { profile: { sub: "user-1", name: "テストユーザー" } },
    settings: { client_id: "test-client" },
    signoutRedirect,
    removeUser,
  }),
}));

describe("Layout", () => {
  beforeEach(() => {
    signoutRedirect.mockReset();
    removeUser.mockReset();
  });

  it("サインアウトはCognitoの/logoutが要求するパラメータでsignoutRedirectに任せる", async () => {
    render(
      <MemoryRouter>
        <Layout />
      </MemoryRouter>,
    );

    await userEvent.click(screen.getByRole("button", { name: "サインアウト" }));

    expect(signoutRedirect).toHaveBeenCalledWith({
      extraQueryParams: {
        client_id: "test-client",
        logout_uri: window.location.origin,
      },
    });
    // 先にトークンを消すとRequireAuthのサインインリダイレクトと競合する
    expect(removeUser).not.toHaveBeenCalled();
  });
});
