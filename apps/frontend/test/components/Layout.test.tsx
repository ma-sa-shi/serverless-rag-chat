import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Layout } from "../../src/components/Layout";

const signOut = vi.fn();
vi.mock("../../src/auth/session", () => ({
  signOut: () => signOut(),
}));

vi.mock("../../src/auth/useCurrentUser", () => ({
  useCurrentUser: () => ({
    data: { userId: "user-1", displayName: "テストユーザー" },
  }),
}));

describe("Layout", () => {
  beforeEach(() => {
    signOut.mockReset();
  });

  it("サインイン中のユーザーの表示名からユーザー画面へリンクする", () => {
    render(
      <MemoryRouter>
        <Layout />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("link", { name: "テストユーザー" }),
    ).toHaveAttribute("href", "/user/user-1");
  });

  it("サインアウトボタンでsignOutを呼ぶ", async () => {
    render(
      <MemoryRouter>
        <Layout />
      </MemoryRouter>,
    );

    await userEvent.click(screen.getByRole("button", { name: "サインアウト" }));

    expect(signOut).toHaveBeenCalledTimes(1);
  });
});
