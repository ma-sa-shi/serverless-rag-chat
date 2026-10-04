import type { ChatSummary } from "./chats";
import { api } from "./client";
import type { DocumentSummary } from "./documents";

/** サインイン時にCognitoから同期したプロフィール。マスタはCognito側にある。 */
export interface UserProfile {
  userId: string;
  displayName: string;
  email: string;
  createdAt: string;
  updatedAt: string;
}

/** サインイン中のユーザー。プロフィールはサインイン時にapi-fnが同期する。 */
export async function fetchMe(): Promise<UserProfile> {
  const res = await api.get<UserProfile>("/users/me");
  return res.data;
}

export async function fetchUser(userId: string): Promise<UserProfile> {
  const res = await api.get<UserProfile>(`/users/${userId}`);
  return res.data;
}

/** 当日分の利用状況。日付の境界はJSTで、バックエンドがリセットを担う。 */
export interface UserQuota {
  limit: number;
  used: number;
}

export async function fetchUserQuota(userId: string): Promise<UserQuota> {
  const res = await api.get<UserQuota>(`/users/${userId}/quota`);
  return res.data;
}

export async function listUserChats(userId: string): Promise<ChatSummary[]> {
  const res = await api.get<ChatSummary[]>(`/users/${userId}/chats`);
  return res.data;
}

export async function listUserDocuments(
  userId: string,
): Promise<DocumentSummary[]> {
  const res = await api.get<DocumentSummary[]>(`/users/${userId}/documents`);
  return res.data;
}
