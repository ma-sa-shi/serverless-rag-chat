import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./index.css";
import App from "./App.tsx";
import { removeLegacyTokens } from "./auth/session.ts";

removeLegacyTokens(window.localStorage);

// アプリ全体で共有するキャッシュ。再生成するとキャッシュが失われる為モジュールスコープに置く
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 4xxを何度も投げ直さない
      retry: 1,
      staleTime: 30_000,
      // 別タブ→元タブに戻った時に自動で再フェッチしない
      refetchOnWindowFocus: false,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  // Provideで囲み、Contextをアプリ全体で利用可能にする
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
