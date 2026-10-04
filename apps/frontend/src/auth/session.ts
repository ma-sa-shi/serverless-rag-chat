import axios from "axios";

// サインイン・更新・サインアウトはapi-fnがCookieで扱う(ADR-0018)。
// apiインスタンスのインターセプタが更新を呼ぶ為、ここでは素のaxiosを使い再帰を避ける

let refreshing: Promise<boolean> | null = null;

/** 同時に401を受けた複数のリクエストが、1回の更新を共有して待つようにする。 */
export function refreshSession(): Promise<boolean> {
  if (refreshing === null) {
    refreshing = requestRefresh().finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

async function requestRefresh(): Promise<boolean> {
  try {
    await axios.post("/api/auth/refresh");
    return true;
  } catch {
    return false;
  }
}

/** サインイン後に今の画面へ戻れるよう、パスとクエリを渡してHosted UIへ向かう。 */
export function redirectToSignin(): void {
  const returnTo = `${window.location.pathname}${window.location.search}`;
  window.location.assign(
    `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
  );
}

interface LogoutResponse {
  logoutUrl: string;
}

/** Cookieを消した後、Hosted UIのセッションも破棄する為にCognitoの/logoutへ遷移する。 */
export async function signOut(): Promise<void> {
  const res = await axios.post<LogoutResponse>("/api/auth/logout");
  window.location.assign(res.data.logoutUrl);
}

/** localStorageへトークンを保存していた頃の残り。XSSで読まれないよう起動時に消す。 */
export function removeLegacyTokens(storage: Storage): void {
  const legacyKeys = Object.keys(storage).filter((key) =>
    key.startsWith("oidc."),
  );
  for (const key of legacyKeys) {
    storage.removeItem(key);
  }
}
