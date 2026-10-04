import axios from "axios";
import type { InternalAxiosRequestConfig } from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../src/api/client";
import { deleteDocument, putToS3 } from "../../src/api/documents";

afterEach(() => {
  vi.restoreAllMocks();
  delete api.defaults.adapter;
});

describe("putToS3", () => {
  it("素のaxiosで送り、Authorizationヘッダーを付けない", async () => {
    // apiインスタンス経由だと署名付きURLへ認証ヘッダーが二重に付き、S3が400を返す
    const put = vi.spyOn(axios, "put").mockResolvedValue({ status: 200 });
    const file = new File(["本文"], "manual.pdf", { type: "application/pdf" });

    await putToS3("https://example.com/signed", file, "application/pdf");

    expect(put).toHaveBeenCalledWith("https://example.com/signed", file, {
      headers: { "Content-Type": "application/pdf" },
    });
    const [, , config] = put.mock.calls[0];
    expect(config?.headers).not.toHaveProperty("Authorization");
  });

  it("署名発行時と同じContent-Typeをそのまま送る", async () => {
    const put = vi.spyOn(axios, "put").mockResolvedValue({ status: 200 });
    const file = new File(["# 見出し"], "readme.md", { type: "" });

    await putToS3(
      "https://example.com/signed",
      file,
      "text/plain; charset=utf-8",
    );

    const [, , config] = put.mock.calls[0];
    expect(config?.headers).toEqual({
      "Content-Type": "text/plain; charset=utf-8",
    });
  });
});

describe("deleteDocument", () => {
  it("ドキュメントのパスへDELETEを送る", async () => {
    let captured: InternalAxiosRequestConfig | undefined;
    api.defaults.adapter = (config) => {
      captured = config;
      return Promise.resolve({
        data: "",
        status: 204,
        statusText: "No Content",
        headers: {},
        config,
      });
    };

    await deleteDocument("doc-1");

    expect(captured?.method).toBe("delete");
    expect(captured?.url).toBe("/documents/doc-1");
  });
});
