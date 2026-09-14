import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { ChatSummary } from "../../src/api/chats";
import { ChatHistory } from "../../src/components/ChatHistory";

const CURRENT_USER = "user-me";

function chat(
  overrides: Partial<ChatSummary> & { chatId: string },
): ChatSummary {
  return {
    userId: CURRENT_USER,
    question: `${overrides.chatId}の質問`,
    finalAnswer: "回答",
    finalGrade: "useful",
    retryCount: 0,
    createdAt: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

describe("ChatHistory", () => {
  it("showOwnerのとき自分の行を「自分」、他人の行を表示名で表示する", () => {
    render(
      <MemoryRouter>
        <ChatHistory
          chats={[
            chat({ chatId: "mine", ownerName: "自分の表示名" }),
            chat({
              chatId: "theirs",
              userId: "user-other",
              ownerName: "山田 太郎",
            }),
            chat({ chatId: "unknown", userId: "user-unknown" }),
          ]}
          currentUserId={CURRENT_USER}
          showOwner
        />
      </MemoryRouter>,
    );

    const [mine, theirs, unknown] = screen.getAllByRole("listitem");
    expect(within(mine).getByRole("link", { name: "自分" })).toBeVisible();
    expect(
      within(theirs).getByRole("link", { name: "山田 太郎" }),
    ).toHaveAttribute("href", "/user/user-other");
    expect(
      within(unknown).getByRole("link", { name: "ユーザー" }),
    ).toBeVisible();
  });
});
