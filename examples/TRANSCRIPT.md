# agentmap — 30-second tour

Real captures from running agentmap against a **154-file public Next.js repo (vercel/ai-chatbot)**. Every block below is verbatim CLI output — no hand-editing beyond trimming a couple of long lists to ~10 lines (marked with `…`).

---

### `--hubs` — what matters most, ranked by PageRank

```
$ node agentmap.mjs --hubs
agentmap: 154 files (sha 2becdb4)
hubs (PageRank importance):
  lib/utils.ts (deg 52, pr 0.105171)
  lib/db/schema.ts (deg 21, pr 0.073744)
  lib/types.ts (deg 23, pr 0.067589)
  components/chat/artifact.tsx (deg 15, pr 0.036882)
  components/chat/icons.tsx (deg 27, pr 0.035378)
  lib/errors.ts (deg 9, pr 0.032787)
  lib/db/queries.ts (deg 14, pr 0.030085)
  components/ui/button.tsx (deg 16, pr 0.017086)
  lib/db/utils.ts (deg 2, pr 0.016627)
  lib/constants.ts (deg 9, pr 0.01483)
  …
```

*The most central files by importance, not just raw import count — note `lib/utils.ts` (deg 52) outranks everything, telling you where to look first when onboarding.*

---

### `--symbols 8` — the 8 highest-value symbols in the codebase

```
$ node agentmap.mjs --symbols 8
top 8 ranked symbols (Aider-style):
  0.109902  lib/utils.ts → cn (FunctionDeclaration)
  0.036013  lib/types.ts → ChatMessage (TypeAliasDeclaration)
  0.025686  components/chat/artifact.tsx → ArtifactKind (TypeAliasDeclaration)
  0.022461  lib/errors.ts → ChatbotError (ClassDeclaration)
  0.021068  lib/types.ts → CustomUIDataTypes (TypeAliasDeclaration)
  0.020872  lib/db/schema.ts → Document (TypeAliasDeclaration)
  0.020555  components/ai-elements/suggestion.tsx → Suggestion (VariableDeclaration)
  0.020555  lib/db/schema.ts → Suggestion (TypeAliasDeclaration)
```

*Aider-style identifier-graph ranking surfaces the exact exports the rest of the repo leans on — `cn` is the #1 symbol overall, so it's load-bearing across the entire UI layer.*

---

### `--map --tokens 400` — a token-budgeted repo digest you can paste into a prompt

```
$ node agentmap.mjs --map --tokens 400
# agentmap (154 files, sha 2becdb4) — focus: global, budget ~400 tok

lib/utils.ts:
  cn (FunctionDeclaration)
  generateUUID (FunctionDeclaration)

lib/types.ts:
  ChatMessage (TypeAliasDeclaration)
  CustomUIDataTypes (TypeAliasDeclaration)
  ChatTools (TypeAliasDeclaration)
  Attachment (TypeAliasDeclaration)

components/chat/artifact.tsx:
  ArtifactKind (TypeAliasDeclaration)
  UIArtifact (TypeAliasDeclaration)
  Artifact (VariableDeclaration)

lib/errors.ts:
  ChatbotError (ClassDeclaration)
  ErrorCode (TypeAliasDeclaration)

lib/db/schema.ts:
  Document (TypeAliasDeclaration)
  Suggestion (TypeAliasDeclaration)
  DBMessage (TypeAliasDeclaration)
  …
# ~387 tokens (14 files shown)
```

*Fits the whole repo's most important symbols into a hard ~400-token budget (it packed 14 files into 387 tokens) — drop it into any agent's context as a cheap map instead of dumping files.*

---

### `--relates lib/db/schema.ts` — blast radius + transitively related files

```
$ node agentmap.mjs --relates lib/db/schema.ts
relates: lib/db/schema.ts  (pr 0.073744)
exports (14): user(VariableDeclaration), User(TypeAliasDeclaration), chat(VariableDeclaration), Chat(TypeAliasDeclaration), message(VariableDeclaration), DBMessage(TypeAliasDeclaration), vote(VariableDeclaration), Vote(TypeAliasDeclaration), document(VariableDeclaration), Document(TypeAliasDeclaration), suggestion(VariableDeclaration), Suggestion(TypeAliasDeclaration), stream(VariableDeclaration), Stream(TypeAliasDeclaration)
imports (0): —
dependents (21): hooks/use-active-chat.tsx, lib/types.ts, lib/utils.ts, artifacts/text/client.tsx, components/chat/artifact-messages.tsx, components/chat/artifact.tsx, components/chat/code-editor.tsx, components/chat/create-artifact.tsx, components/chat/document-preview.tsx, components/chat/message-actions.tsx, …
related (random-walk relevance):
  lib/utils.ts (0.0476)
  lib/types.ts (0.0376)
  components/chat/artifact.tsx (0.0372)
  components/chat/icons.tsx (0.0264)
  components/chat/message.tsx (0.0237)
  lib/db/queries.ts (0.0225)
  app/(chat)/api/chat/route.ts (0.0218)
  components/chat/document-preview.tsx (0.0202)
  components/chat/text-editor.tsx (0.0174)
  lib/artifacts/server.ts (0.0173)
```

*Before you touch a file: exactly the 21 dependents that break if you change it, plus a random-walk relevance list of files that are related transitively (not just direct importers).*

---

### `--any cn` — one router that auto-resolves file vs. symbol vs. feature vs. live grep

```
$ node agentmap.mjs --any cn
[structure] 1 symbol, 0 feature match for "cn"
  lib/utils.ts → cn (FunctionDeclaration)
```

*One command, no flag-picking: `cn` resolved to a symbol and returned its definition site. If it had been a filename or feature name it would route there instead, and if nothing matched it falls back to a live `git grep` so string/copy lookups never come up empty.*
