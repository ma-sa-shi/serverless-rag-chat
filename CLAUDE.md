# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

An internal RAG chat application on AWS serverless infrastructure. The system design document (in Japanese) is in `docs/architecture.md`, and individual architecture decision records are in `docs/adr/` — read them before making design decisions.

Three independent workspaces, each with its own dependencies:

- `apps/frontend/` — Vite + React 19 + TypeScript SPA (React Router, TanStack Query, axios)
- `apps/backend/` — FastAPI app, Python 3.12, managed with `uv`
- `cdk/` — AWS CDK (TypeScript) infrastructure

## Commands

### Root (Makefile)

```bash
make install           # npm install (frontend) + uv sync (backend)
make dev               # run frontend (:5173) and backend (:8000) dev servers together
make lint              # eslint + prettier --check (frontend), ruff check + format --check (backend)
make format            # prettier --write (frontend), ruff --fix + format (backend)
make test              # frontend vitest + backend pytest
make docker-build      # build the api-fn image (web target)
make docker-build-chat    # build the chat-fn image (chat target)
make docker-build-worker  # build the ingest-fn image (worker target)
make docker-up         # run the web image on :8000 (stop the native backend first)
make docker-down
```

Day-to-day development is native (uv/npm). Docker exists only to build the production Lambda images and verify the web image starts locally — the backend Dockerfile has three final targets from one shared builder: `web` (Lambda Web Adapter + uvicorn, for api-fn), `chat` (web plus the `chat` dependency group — langgraph/langchain, for chat-fn) and `worker` (awslambdaric plain handler plus the `ingest` dependency group — pypdf, for ingest-fn); CDK selects the target and per-function env vars (see ADR-0003). No local Lambda emulation (SAM/LocalStack/RIE); Lambda-specific behavior is verified in the CDK-deployed dev environment.

### Frontend (`apps/frontend/`)

```bash
npm run dev            # dev server on http://localhost:5173
npm run build          # tsc -b && vite build
npm test               # vitest run (test:watch for watch mode)
npx vitest run test/lib/sse.test.ts        # single test file
npx vitest run -t "コメント行を読み飛ばす"   # single test by name
npm run lint           # eslint
npm run format         # prettier --write (format:check for CI-style check)
```

Frontend tests live in `apps/frontend/test/`, mirroring the `src/` layout, and
run in jsdom with React Testing Library. Vitest globals are not injected — each
test imports `describe` / `it` / `expect` / `vi` from `vitest`. The network
boundary is faked with `vi.mock` and `fetch` stubs, not MSW. `tsconfig.test.json`
is in `tsconfig.json`'s references, so `npm run build` type-checks the tests too.

### Backend (`apps/backend/`)

```bash
uv sync                                # install deps
uv run uvicorn app.main:app --reload   # dev server on http://localhost:8000
uv run pytest                          # all tests
uv run pytest tests/test_health.py::test_health   # single test
uv run ruff check .                    # lint
uv run ruff format .                   # format
```

### CDK (`cdk/`)

```bash
npm run typecheck      # tsc --noEmit (tsx runs TS directly; no build step)
npm test               # jest (all tests)
npx jest test/cdk.test.ts              # single test file
npx jest -t "SQS Queue Created"        # single test by name
npx cdk synth / diff / deploy
```

All FastAPI routes live under `/api` (matching CloudFront's `/api/*` routing). The Vite dev server proxies `/api` to `http://localhost:8000` (see `vite.config.ts`), so dev is same-origin like production — no CORS middleware. Run both dev servers for local development.

## Architecture

Target architecture (from `docs/architecture.md`; most of it is not yet implemented):

- **SPA + REST API only.** No SSR, no Next.js/OpenNext. SPA is served from S3 via CloudFront; `/api/*` routes through CloudFront to a Lambda Function URL.
- **One FastAPI Docker image deployed to three Lambdas**, split by responsibility:
  - `api-fn` — REST API (auth, document/chat lists, presigned URLs, ingest kickoff). Uses Lambda Web Adapter.
  - `chat-fn` — SSE streaming chat with LangGraph Self-RAG. Only this function loads LangChain libraries. Uses Lambda Web Adapter.
  - `ingest-fn` — text extraction, chunking, embedding, S3 Vectors registration. Plain Lambda handler (no Web Adapter), triggered by SQS with a DLQ.
- **Upload and ingest are separate flows.** Files go directly from SPA to S3 via presigned URLs (never through Lambda). Issuing the upload URL registers the document with status `uploading`; embeddings are generated only when the user explicitly triggers ingest, which enqueues to SQS. Document status: `uploading → uploaded → processing → ingested | failed`.
- **RAG pipeline** (chat-fn): Multi Query → Vector Search (S3 Vectors) → RRF → Cohere Rerank → LLM Generation → Self Evaluation → Retry (max 1).
- **Auth**: Cognito Hosted UI with Authorization Code + PKCE. FastAPI only verifies JWTs via JWKS — never implement password handling or token issuance in the backend.
- **Data**: DynamoDB single-table design (e.g. `PK=USER#123`, `SK=CHAT#<ULID>`) for documents, chats, and messages. IDs are ULIDs; GSI1 (`GSI1PK=DOC|CHAT`, `GSI1SK=<id>`) serves both cross-user lists and ID-only lookups. S3 Vectors metadata: `documentId` (filterable), `text`/`filename` (non-filterable).
- **Zero fixed cost is a hard constraint**: no VPC, no NAT, no ECS/EC2/Aurora, no Provisioned Concurrency.
- **CDK is five stacks**: CertificateStack, DataStack, AppStack, EdgeStack, CiStack (see `cdk/README.md` for deploy prerequisites like the manual SSM SecureString setup and the ACM DNS validation done at the registrar). The SPA bucket lives in EdgeStack, not DataStack, because its OAC policy references the distribution. CertificateStack holds only the ACM certificate for the public domain and lives in us-east-1, the only region CloudFront can use; `appDomain` (default in `cdk.json`) carries the domain to DataStack without a stack reference. CiStack holds only the GitHub Actions OIDC provider and deploy role.
- **CI/CD**: `.github/workflows/ci.yml` validates PRs (frontend lint/format/vitest/build, backend ruff/pytest, cdk typecheck/jest); `deploy-frontend.yml` and `deploy-backend.yml` deploy on merge to `main`. Workflows never run `cdk deploy` — infrastructure changes are applied manually. CDK snapshot tests normalize asset hashes via `cdk/test/helpers.ts`, so backend-only edits no longer break `npm test`.
- **Logging**: Lambda Powertools (structured logging, metrics, tracing); propagate the request ID across services.

## TypeScript Code Style

### Readability

- Optimize for the reader, not for line count.
- Prefer explicit `if` statements and block bodies when compact expressions reduce readability.
- Avoid nested ternary operators and nested arrow functions.
- Name every branch when handling finite sets of cases such as string unions, enums, or state machines.
- Prefer code that can be understood by reading top-to-bottom without mentally expanding expressions.
- Widely-shared ecosystem idioms that clearly communicate intent are not considered clever shortcuts. Do not use this exception to justify complex expressions or compressed business logic.
- Prefer early returns over deeply nested control flow.
- Introduce well-named intermediate variables when an expression performs multiple logical steps.

### Simplicity

- Introduce intermediate variables only to clarify intent or separate logical steps.
- Avoid unnecessary wrapper functions or abstractions.
- Avoid adding abstractions before they solve a real problem.
- Keep related code together. Split files only when responsibilities clearly diverge.

### Comments

Comments are the exception, not the default.

Prefer expressive names, types, and structure over comments.

Write comments only when the reason, constraint, or invariant cannot be inferred from the code.

Good comments explain:

- design constraints
- cross-module contracts
- platform or framework behavior that surprises experienced developers
- intentional deviations from the obvious implementation

Do not comment:

- what the code already says
- function summaries
- parameter descriptions
- control flow
- language or library basics

Python docstrings follow the same principles:

- A module docstring carries the why: constraints, cross-module contracts, and intentional deviations from the obvious implementation.
- A function docstring is a single line, and only when the name, types, and signature cannot fully express the contract.
- Do not write `Args:` / `Returns:` sections that merely repeat parameter names and type annotations.
- Write a `Raises:` section only when callers need to know about a specific exception as part of the function contract.

Keep comments concise (normally 1–3 lines).

If an explanation requires a paragraph, move it to CLAUDE.md (project rules) or docs/architecture.md / ADR (architectural rationale) and reference it instead.

## Python Code Style

Applies to `apps/backend/`.

### Data shapes

- Prefer named structures when values have semantic meaning.
- Prefer `dataclass` or `NamedTuple` for internal models. Use `TypedDict` for dictionary-shaped external data such as JSON.
- Avoid anonymous or loosely typed nested dictionaries when the schema is part of the contract. Define explicit types instead.
- Fully parameterize container types. Avoid incomplete annotations such as `list` or `dict`.
- Use `Any` only at boundaries where precise typing is not practical (for example, interacting with untyped third-party libraries).
- Prefer named field access over positional indexing when the data has semantic fields.

### State and loops

- Prefer comprehensions and built-in transformations over manual accumulation when practical.
- Avoid synchronizing multiple mutable variables that represent the same state.
- Avoid maintaining duplicate mutable state. Prefer recomputing derived values unless caching is required for performance.
- When an algorithm requires non-obvious state management, document the invariant or constraint that must be preserved.
- Prefer introducing a new local variable instead of reassigning parameters.

## Japanese Writing Quality

When generating Japanese text, write natural, idiomatic Japanese rather than translating English sentence by sentence.

This applies to all Japanese text, including:

- documentation
- ADRs
- issues
- PR descriptions
- source-code comments
- Python docstrings

### Writing Principles

- Preserve the meaning, but restructure sentences as necessary so that the Japanese reads naturally. Do not carry over English sentence structure.
- Prefer terminology commonly used in Japanese technical documentation, and follow the terminology and writing style already established in the repository.
- Do not introduce unnecessary English words when an established Japanese term is more natural.
- Keep established technical terms, product names, proper nouns, and standard abbreviations in their conventional form.
- Prefer clear, concise wording that a native Japanese technical writer would naturally use.
- Avoid novel terminology when a standard Japanese expression exists.
- Make logical relationships between adjacent sentences explicit when needed. Restructuring the sentences is an alternative to adding a connector.
- When two sentences express cause/effect, contrast, qualification, or conclusion, use an appropriate connector such as 「そのため」, 「しかし」,「ただし」,「一方で」 and 「つまり」 when the relationship is not already clear.
- Do not open every sentence with a connector, and drop those that add nothing.

### Self-Review

Before finishing, review the Japanese text separately from the drafting process.

Check that:

- It reads naturally to a native Japanese reader.
- It does not sound like a literal translation from English.
- English terms are used only where they are standard or appropriate.
- Terminology is consistent with the repository.
- The text is clear, concise, and easy to understand.
- Check for sequences of disconnected short sentences and add a conjunction or merge sentences when the logical relationship between them is not explicit. Three or more consecutive sentences without a connector in one paragraph is the signal to look; connectors opening more than about a third of the sentences is the signal you have overcorrected.

When Japanese is derived from English source material, review the Japanese on its own rather than sentence by sentence against the English source.

## Issues and Plans

`docs/issues/`, `docs/plans/`, and `docs/PRmessages/` hold gitignored local drafts — never commit them, and never cite these paths from a commit message, a PR body, or an issue. What counts is the issue or pull request on GitHub, and the code and the ADRs.

- `docs/issues/NNN-slug.md` — the human-facing issue text, pasted into a GitHub Issue as is. It states what the problem is and what would count as solved. It does not prescribe an implementation.
- `docs/plans/NNN-slug.md` — the design document to implement from, sharing its number with the issue. It fixes the approach, the scope of work, and the completion criteria.
- `docs/PRmessages/<pr>-slug.md` — a draft pull request body. The body on GitHub is the one that counts; keep the draft in step with it or delete it.

## Notes

- The diagrams in `README.md` and `docs/architecture.md` are SVGs exported from `docs/diagrams/blueprint.drawio`, one per page. Edit the drawio file, never the SVGs; the user re-exports them in draw.io.
- The break-even chart in `docs/cost-comparison.md` is generated by `docs/diagrams/cost_comparison.py` (no dependencies, writes SVG directly); regenerate `docs/diagrams/cost-comparison.svg` when the cost model changes.
