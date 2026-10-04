import { useQuery } from "@tanstack/react-query";
import { fetchMe } from "../api/users";

/** プロフィールはサインイン時にしか変わらない為、画面を開いている間は取り直さない。 */
export function useCurrentUser() {
  return useQuery({
    queryKey: ["users", "me"],
    queryFn: fetchMe,
    staleTime: Infinity,
    // 401はインターセプタが更新を試した後の結果であり、再試行しても変わらない
    retry: false,
  });
}
