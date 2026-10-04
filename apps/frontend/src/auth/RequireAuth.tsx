import axios from "axios";
import { useEffect, useRef, type ReactNode } from "react";
import { redirectToSignin } from "./session";
import { useCurrentUser } from "./useCurrentUser";

export function RequireAuth({ children }: { children: ReactNode }) {
  const currentUser = useCurrentUser();
  // StrictModeの二重実行で多重にリダイレクトしないようにする
  const redirected = useRef(false);
  const unauthenticated =
    axios.isAxiosError(currentUser.error) &&
    currentUser.error.response?.status === 401;

  // 更新にも失敗した場合だけ401が届く。Hosted UIでサインインし直してもらう
  useEffect(() => {
    if (unauthenticated && !redirected.current) {
      redirected.current = true;
      redirectToSignin();
    }
  }, [unauthenticated]);

  if (currentUser.isPending || unauthenticated) {
    return <p>サインインしています…</p>;
  }
  if (currentUser.isError) {
    return (
      <p>
        ユーザー情報を取得できませんでした。ページを再読み込みしてください。
      </p>
    );
  }
  return children;
}
