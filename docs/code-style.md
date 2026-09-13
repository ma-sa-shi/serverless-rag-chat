# コード規約の具体例

CLAUDE.md の「TypeScript Code Style」「Python Code Style」「Comments」で定めた規約について、判断に迷いやすい箇所を実際のコードで示す。規約そのものは CLAUDE.md が正であり、この文書は解釈と適用例を補うものとする。

引用元を示していないコード片は、説明用のダミーコードである。

## 目次

- [1. TypeScript](#1-typescript)
  - [1.1 分岐に名前を付ける](#11-分岐に名前を付ける)
  - [1.2 早期リターンで平坦にする](#12-早期リターンで平坦にする)
  - [1.3 中間変数は業務ルールに名前を付けるために使う](#13-中間変数は業務ルールに名前を付けるために使う)
  - [1.4 イディオムとして許容するもの](#14-イディオムとして許容するもの)
  - [1.5 抽象化を先取りしない](#15-抽象化を先取りしない)
  - [1.6 判断が割れる例](#16-判断が割れる例)
- [2. コメントとdocstring](#2-コメントとdocstring)
  - [2.1 残す価値のあるコメント](#21-残す価値のあるコメント)
  - [2.2 消すべきコメント](#22-消すべきコメント)
  - [2.3 docstring](#23-docstring)
- [3. Python](#3-python)
  - [3.1 匿名の入れ子dictを型にする](#31-匿名の入れ子dictを型にする)
  - [3.2 外部データの形はTypedDictで宣言する](#32-外部データの形はtypeddictで宣言する)
  - [3.3 Anyを使ってよい境界](#33-anyを使ってよい境界)
  - [3.4 状態とループ](#34-状態とループ)
- [4. 規約整備時に直した箇所](#4-規約整備時に直した箇所)

## 1. TypeScript

### 1.1 分岐に名前を付ける

ステータスのような有限の文字列ユニオンを扱う場合、三項演算子のネストを避け、マップ構造として記述する。

非推奨:

```tsx
export function StatusBadge({ status }: { status: DocumentStatus }) {
  return (
    <span className={`status-badge status-${status}`}>
      {status === "uploading"
        ? "アップロード中"
        : status === "uploaded"
          ? "未取込"
          : status === "processing"
            ? "取込中"
            : status === "ingested"
              ? "取込済"
              : "失敗"}
    </span>
  );
}
```

推奨（`apps/frontend/src/components/StatusBadge.tsx`）:

```tsx
const LABELS: Record<DocumentStatus, string> = {
  uploading: "アップロード中",
  uploaded: "未取込",
  processing: "取込中",
  ingested: "取込済",
  failed: "失敗",
};

export function StatusBadge({ status }: { status: DocumentStatus }) {
  return (
    <span className={`status-badge status-${status}`}>
      <span className="status-dot" aria-hidden="true" />
      {LABELS[status] ?? status}
    </span>
  );
}
```

`Record<DocumentStatus, string>` は全キーの定義を要求するため、`DocumentStatus` にステータスが増えたときに定義漏れがコンパイルエラーになる。一方、三項演算子の連鎖では追加したステータスが最後の分岐（`"失敗"`）に流れてしまい、漏れに気付けない。

### 1.2 早期リターンで平坦にする

条件ごとに戻り値が確定する関数は、ネストを作らず早期リターンで平坦に記述する。

非推奨:

```ts
export function toErrorMessage(error: unknown, fallback: string): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    if (status === 401 || status === 403) {
      return "認証の有効期限が切れた可能性があります。ページを再読み込みしてください。";
    } else if (status === 404) {
      return "対象のドキュメントが見つかりません。一覧を再取得してください。";
    } else {
      if (!error.response) {
        return `${fallback}（サーバーに接続できませんでした）`;
      } else {
        const detail = (error.response.data as { detail?: unknown } | undefined)
          ?.detail;
        return typeof detail === "string" ? `${fallback}（${detail}）` : fallback;
      }
    }
  } else {
    return fallback;
  }
}
```

推奨（`apps/frontend/src/lib/errors.ts`）:

```ts
export function toErrorMessage(error: unknown, fallback: string): string {
  if (!axios.isAxiosError(error)) {
    return fallback;
  }
  const status = error.response?.status;
  if (status === 401 || status === 403) {
    return "認証の有効期限が切れた可能性があります。ページを再読み込みしてください。";
  }
  if (status === 404) {
    return "対象のドキュメントが見つかりません。一覧を再取得してください。";
  }
  if (status === 409) {
    return "ドキュメントの状態が変わっています。一覧を再取得しました。";
  }
  if (!error.response) {
    return `${fallback}（サーバーに接続できませんでした）`;
  }
  const detail = (error.response.data as { detail?: unknown } | undefined)
    ?.detail;
  return typeof detail === "string" ? `${fallback}（${detail}）` : fallback;
}
```

条件分岐が同階層に揃うため、エラーケースの追加が単一ブロックの追加のみで完了する。末尾の三項演算子はネストされておらず、「`detail` が文字列の場合のみ付加する」という1段階の評価であるため、そのまま残して問題ない。

### 1.3 中間変数は業務ルールに名前を付けるために使う

非推奨:

```tsx
{document.userId === currentUserId &&
  ["uploaded", "failed"].includes(document.status) && (
    <button type="button" onClick={() => onIngest(document.documentId)}>
      取込開始
    </button>
  )}
```

推奨（`apps/frontend/src/components/DocumentTable.tsx`）:

```tsx
// バックエンドのステータス遷移(uploaded|failed → processing)に合わせる
const INGESTABLE = ["uploaded", "failed"];

const canIngest =
  document.userId === currentUserId && INGESTABLE.includes(document.status);
```

「本人のドキュメントかつ取込可能状態」という業務ルールに対し、`canIngest` と命名して明確化する。JSX 内で条件式を組み立てると、表示ロジックと業務ルールが混在し直感的に把握しづらくなる。

なお、値を移し替えるだけの中間変数は定義しない（例: `const filename = document.filename`）。ラッパー関数も同じ基準で判断する。`apps/frontend/src/pages/Documents.tsx` の `invalidateDocuments` は中身が1行だが3箇所から呼ばれ、「一覧のキャッシュを無効化する」という操作に名前を与えているため残す。一方、呼び出しが1箇所しかない1行のラッパーは書かない。

### 1.4 イディオムとして許容するもの

```tsx
onSuccess: () => void invalidateDocuments(),
onOpen={(id) => void handleOpen(id)}
```

`void` は、ESLint の `no-misused-promises` に対して戻り値の `Promise` を意図的に捨てることを示す定型表現であり、エコシステムで広く共有されている。この例外は意図が一目で伝わるイディオムにのみ適用し、`!!value` や `~list.indexOf(x)` のように短くするために意味を圧縮した書き方は許容しない。

### 1.5 抽象化を先取りしない

非推奨:

```ts
function createResourceHooks<T>(queryKey: string[], fetcher: () => Promise<T[]>) {
  return {
    useList: () => useQuery({ queryKey, queryFn: fetcher }),
    useInvalidate: () => {
      const queryClient = useQueryClient();
      return () => queryClient.invalidateQueries({ queryKey });
    },
  };
}

const documentHooks = createResourceHooks(["documents"], listDocuments);
```

推奨（`apps/frontend/src/pages/Documents.tsx`）:

```ts
const documentsQuery = useQuery({
  queryKey: DOCUMENTS_QUERY_KEY,
  queryFn: listDocuments,
  // 取込中の行があればキャッシュを定期的に更新する。
  refetchInterval: (query) =>
    query.state.data?.some((document) => document.status === "processing")
      ? POLL_INTERVAL_MS
      : false,
});
```

現時点で一覧取得処理を持つリソースはドキュメントのみであるため、共通フックを作成しても呼び出し側の記述は簡潔にならない。むしろ `refetchInterval` のようなリソース固有の設定を汎用フック経由で渡す必要が生じ、抽象化が破綻する。2つ目のリソースが登場し、共通パターンが確定してから共通化を行う。

### 1.6 判断が割れる例

`apps/frontend/src/pages/Documents.tsx` にあった次のコードは規約違反（三項演算子のネスト）ではないが、JSX 属性内で条件式と `??` が重なり、読み取りに一拍かかる。

```tsx
ingestingId={
  ingestMutation.isPending ? (ingestMutation.variables ?? null) : null
}
```

変数へ抽出すると、`isPending` で絞り込む理由をコメントで補える場所ができる。

```tsx
// mutationのvariablesは実行中のdocumentIdを指す。完了後も直前の値が残る為isPendingで絞る
const ingestingId = ingestMutation.isPending
  ? (ingestMutation.variables ?? null)
  : null;
```

判断基準: 「JSX を上から順に読み進めた際、渡されている属性値の意図が一読で解釈できるか」。解釈に引っかかりが生じる場合は props に渡す前に命名・抽出する。

## 2. コメントとdocstring

### 2.1 残す価値のあるコメント

コードから読み取れない「採用理由」「制約条件」「他モジュールとのインターフェース契約」を記載する。

```ts
// apps/frontend/src/lib/fileTypes.ts
// text/markdownはブラウザが表示せずダウンロードしてしまう為、原本閲覧のできるtext/plainで保存する。
// バックエンドはContent-Typeではなく拡張子で形式を判定するので取込結果は変わらない
".md": "text/plain; charset=utf-8",
```

```ts
// apps/frontend/src/pages/Documents.tsx
// await後のwindow.openはポップアップブロックの対象になる為、クリック直後に空タブを開く
const tab = window.open("", "_blank");
```

```python
# apps/backend/app/ingest/chunking.py
"""抽出テキストを検索単位のチャンクへ分割する。

langchain-text-splittersはlangchain-coreを引き込みworkerイメージを重くする為、自前実装する(ADR-0003)。
"""
```

```python
# apps/backend/app/ingest/pipeline.py
"""再取込でチャンク数が減ったときに、余った古いベクトルを削除する。

既存keyは上書きされるため、超過分だけを消せば良い
ListVectorsにprefix絞り込みがない為、前回のチャンク数から削除対象を決める
"""
```

判断基準: 「そのコメントを削った場合、後続の担当者が背景調査や再検証を強いられるか」。ADR に詳細がある場合は 1 行に要約し、参照先リンクを記載する。

### 2.2 消すべきコメント

コードの挙動を単にトレースするだけのコメントは削除する。

```python
# apps/backend/app/rag/utils.py（修正前）
sorted_items = sorted(
    doc_score_map.items(),
    key=lambda x: x[1]["score"],
    reverse=True,  # 降順
)
```

`reverse=True` 自体が降順を意味しており情報量が増えていない。関数の型定義・命名から自明なコメントも同様に削除する。

```ts
// ドキュメント一覧を取得する
export async function listDocuments(): Promise<DocumentSummary[]> {
```

関数名と戻り値の型が既に述べている。

### 2.3 docstring

非推奨（`apps/backend/app/rag/utils.py` の修正前）:

```python
def reciprocal_rank_fusion(
    retriever_outputs: list[list[Document]], k: int = 60, top_n: int = 20
) -> list[Document]:
    """複数クエリの検索結果を相互順位融合(RRF)で1本に統合する。

    Args:
        retriever_outputs: クエリごとの検索結果
        k: 順位の影響を緩めるRRFの定数
        top_n: 返すドキュメント数

    Returns:
        スコア降順のドキュメント。同一ドキュメントはdoc.idで名寄せされる
    """
```

型定義・引数名から自明な情報（`retriever_outputs`, `top_n`）の列挙は省略する。署名から読み取れない仕様（`k` の役割、`doc.id` による名寄せなど）のみを簡潔に記述する。

推奨:

```python
def reciprocal_rank_fusion(
    retriever_outputs: list[list[Document]], k: int = 60, top_n: int = 20
) -> list[Document]:
    """複数クエリの検索結果を相互順位融合(RRF)で1本に統合する。

    同一ドキュメントはdoc.idで名寄せする。kは順位差の影響を緩める定数。
    """
```

例外が呼び出し側との契約に含まれる場合は `Raises:` を書く。`DocumentRepository.update_status` の `DocumentStatusError` はルーターが 409 へ変換する必要があるため、`Raises:` で送出条件を明示している。

## 3. Python

### 3.1 匿名の入れ子dictを型にする

非推奨（`apps/backend/app/rag/utils.py` の修正前）:

```python
# { doc_id: {score: スコア, document: Documentオブジェクト} }
doc_score_map: dict[str, dict] = {}

for docs in retriever_outputs:
    for rank, doc in enumerate(docs):
        if doc.id not in doc_score_map:
            doc_score_map[doc.id] = {"score": 0.0, "document": doc}
        doc_score_map[doc.id]["score"] += 1 / (rank + k)

sorted_items = sorted(doc_score_map.items(), key=lambda x: x[1]["score"], reverse=True)
return [item[1]["document"] for item in sorted_items[:top_n]]
```

ここには3つの問題がある。内側の `dict` に型引数がなく中身が型で表現されていない点、そのデータ構造をコメントで説明している点、そして `item[1]["document"]` のように位置インデックスや文字列キーで値を取り出している点である。

推奨:

```python
@dataclass
class _FusedDocument:
    document: Document
    score: float = 0.0


def reciprocal_rank_fusion(
    retriever_outputs: list[list[Document]], k: int = 60, top_n: int = 20
) -> list[Document]:
    """複数クエリの検索結果を相互順位融合(RRF)で1本に統合する。

    同一ドキュメントはdoc.idで名寄せする。kは順位差の影響を緩める定数。
    """
    fused: dict[str, _FusedDocument] = {}
    for docs in retriever_outputs:
        for rank, doc in enumerate(docs):
            entry = fused.setdefault(doc.id, _FusedDocument(document=doc))
            entry.score += 1 / (rank + k)

    ranked = sorted(fused.values(), key=lambda entry: entry.score, reverse=True)
    return [entry.document for entry in ranked[:top_n]]
```

構造を補足していたコメントが型定義へ置き換わり、`entry.score` や `entry.document` として直感的に読み取れるようになる。

### 3.2 外部データの形はTypedDictで宣言する

DynamoDB の項目のように、辞書の形がモジュール間の契約になっている場合は `TypedDict` で宣言する。

非推奨（`apps/backend/app/repositories/documents.py` の修正前）:

```python
def get_owned(self, user_id: str, document_id: str) -> dict | None: ...
def list_recent(self, limit: int) -> list[dict]: ...
```

呼び出し側は `document["s3Key"]` や `document.get("chunkCount", 0)` のようにキーを直接書くが、そのキーが存在するかどうかは型に現れない。

推奨:

```python
class DocumentItem(TypedDict):
    PK: str
    SK: str
    documentId: str
    userId: str
    filename: str
    s3Key: str
    status: str
    createdAt: str
    updatedAt: str


class IngestedDocumentItem(DocumentItem):
    # 取込完了後のみ付与される。再取込で余剰ベクトルを削除する際に参照する
    chunkCount: NotRequired[Decimal]


def get_owned(self, user_id: str, document_id: str) -> DocumentItem | None: ...
def list_recent(self, limit: int) -> list[DocumentItem]: ...
```

`chunkCount` が任意項目であることや、DynamoDB の数値が `Decimal` で返ることが型に現れる。そのため `pipeline.py` の次のコメントは、型と重なる説明を削って2行から1行に減らせた。

```python
# 修正前
# 初回取込ではchunkCountを持たないため0で代替する
# DynamoDBの数値はDecimalで返り、そのままではrange()に渡せない
previous_count=int(document.get("chunkCount", 0)),

# 修正後
# 初回取込ではchunkCountを持たない。Decimalのままではrange()へ渡せない
previous_count=int(document.get("chunkCount", 0)),
```

### 3.3 Anyを使ってよい境界

非推奨（`apps/backend/app/ingest/pipeline.py` の修正前）:

```python
@dataclass(frozen=True)
class IngestPipeline:
    bucket_name: str
    repository: DocumentRepository
    embedder: Any
    vector_index: VectorIndex
    s3_client: Any
```

`s3_client` は boto3 が動的に生成するクライアントであり、正確な型を付けられないため `Any` が妥当である。一方 `embedder` の実体は自前の `BedrockEmbedder` なので、テストで差し替えたいだけなら必要なメソッドを `Protocol` で宣言すればよい。

推奨:

```python
class Embedder(Protocol):
    def embed_documents(self, texts: list[str]) -> list[list[float]]: ...


@dataclass(frozen=True)
class IngestPipeline:
    bucket_name: str
    repository: DocumentRepository
    embedder: Embedder
    vector_index: VectorIndex
    # boto3のクライアントは動的に生成され、型を付けられない
    s3_client: Any
```

「型が付けられないから `Any`」と「差し替えたいから `Any`」を区別する。前者は理由をコメントに残し、後者は `Protocol` で必要なメソッドだけを宣言する。

### 3.4 状態とループ

同一の状態を表す変数を複数保持しない。

```python
# 非推奨
kept: list[str] = []
kept_count = 0
for chunk in chunks:
    if chunk:
        kept.append(chunk)
        kept_count += 1

# 推奨
kept = [chunk for chunk in chunks if chunk]
kept_count = len(kept)
```

関数の引数は再代入せず、新しいローカル変数を割り当てる。

```python
# 非推奨
def split_text(text: str, *, chunk_size: int = CHUNK_SIZE) -> list[str]:
    text = text.strip()
    ...

# 推奨
def split_text(text: str, *, chunk_size: int = CHUNK_SIZE) -> list[str]:
    normalized = text.strip()
    ...
```

複雑な状態管理が避けられない場合は、維持すべき不変条件をコメントに書く。`apps/backend/app/ingest/chunking.py` の `_merge` 関数がこれに該当する。

```python
chunks: list[str] = []
current: list[str] = []
# currentをseparatorで連結したときの長さ
total = 0
```

`total` は `current` から算出できる派生値だが、ループのたびに再計算するとチャンク分割の計算量が O(n²) になるため保持している。このような場合は「`total` が何と一致していなければならないか」を1行のコメントで書く。派生値のキャッシュは、性能上の明確な理由がある場合に限る。

## 4. 規約整備時に直した箇所

規約制定前に書かれたコードについて、以下の修正を行った。

| 箇所 | 内容 |
| --- | --- |
| `app/rag/utils.py` | `dict[str, dict]` を `_FusedDocument` へリファクタリング。`Args:` / `Returns:` の冗長な列挙や `reverse=True, # 降順` コメントを削除し、位置参照からフィールド名参照へ変更 |
| `app/repositories/*.py` | 戻り値の `dict` / `list[dict]` を `DocumentItem` 等の `TypedDict` へ変更。ステータス属性の型を `DocumentStatus`（Literal型）に変更 |
| `app/rag/stream.py` | `to_document_payload` の戻り値を `RetrievedDocument` へ変更。`_attempts` の `list[tuple]` を `Attempt`（`NamedTuple`）へ変更 |
| `app/ingest_queue.py` / `app/ingest_handler.py` | SQS メッセージ構造を `IngestMessage` として明示的に宣言 |
| `app/ingest/pipeline.py` | `embedder: Any` を `Embedder`（`Protocol`）へ変更。`s3_client: Any` は理由をコメントに残して維持 |
| `app/rag/state.py` | `GraphState` の docstring を、実装から読み取れない内容だけに絞った |
| `app/routers/*.py` | 内包表記内の変数名 `i` を `item` へ修正 |
| `apps/frontend/src/pages/Documents.tsx` | JSX 属性内で組み立てていた `ingestingId` をローカル変数へ抽出 |

RAG 関連（`app/rag/`）は既存実装からの移植が多く、規約制定前の書き方が入り込みやすい。そのため、機能の追加や変更のたびに合わせて本規約を適用する。
