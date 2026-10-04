import axios, { type InternalAxiosRequestConfig } from "axios";
import { refreshSession } from "../auth/session";

// アクセストークンはHttpOnly Cookieで送られる為、ヘッダーへ載せる処理は持たない(ADR-0018)
export const api = axios.create({
  baseURL: "/api",
});

interface RetriableRequestConfig extends InternalAxiosRequestConfig {
  retriedAfterRefresh?: boolean;
}

/** アクセストークンの期限切れによる401は、更新してから1回だけ送り直す。
 * 更新にも失敗した場合は元のエラーを投げ、サインインへの遷移はRequireAuthに任せる。
 */
async function retryAfterRefresh(error: unknown): Promise<unknown> {
  if (!axios.isAxiosError(error) || error.response?.status !== 401) {
    throw error;
  }
  const config = error.config as RetriableRequestConfig | undefined;
  if (config === undefined || config.retriedAfterRefresh) {
    throw error;
  }
  if (!(await refreshSession())) {
    throw error;
  }
  config.retriedAfterRefresh = true;
  return api.request(config);
}

api.interceptors.response.use(undefined, retryAfterRefresh);
