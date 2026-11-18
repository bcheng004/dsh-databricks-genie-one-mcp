# @local/dsh-databricks-genie-one-mcp

Databricks **Genie One** for DeepSeek Harness: four granular MCP tools plus one
blocking question-and-answer tool, all over the same Genie One MCP server.

Genie grounds answers in Genie Ontology — business terms, metric definitions and
table relationships — and returns a deep link back into the Databricks UI.

## What you get

| Tool | Purpose |
|---|---|
| `genie_answer` | Ask a question and **wait** for the finished answer. One call in, one grounded Markdown answer out. |
| `mcp__genie_one__genie_ask` | Start a question. Returns `conversation_id`, `response_id`, and an in-flight state. |
| `mcp__genie_one__genie_poll_response` | Fetch the current state as Markdown, plus `status`, `deep_link` and query items. |
| `mcp__genie_one__genie_get_query_result` | Read the schema and inline rows for one SQL query Genie ran. |
| `mcp__genie_one__genie_cancel_response` | Stop a response that is still generating. |

### Which one to reach for

Genie is asynchronous by design. The MCP tools expose that honestly, which is
right for a long investigation — you see the SQL as it is written, keep the
answer resumable, and can cancel it. The cost is that the polling loop lives in
the model's hands, and a model that polls once then stops reports a
half-finished answer.

`genie_answer` exists for that reason: it runs the whole cycle inside one tool
call — ask, then poll every few seconds until the response completes, fails, or
passes its deadline — and returns only the finished text.

| Situation | Tool |
|---|---|
| One question, one answer | `genie_answer` |
| Want to watch SQL being written | the `mcp__genie_one__*` tools |
| Need the rows behind a query | `genie_get_query_result` |
| Want to stop a running answer | `genie_cancel_response` |

## Install

Requirements:

- The workspace exposes `system.ai.genie_one_mcp` through Unity Gateway, and the
  caller may invoke it (Unity Gateway grant or policy).
- A credential reference holding a workspace bearer token. The companion
  [dsh-databricks-oauth](https://github.com/bcheng004/dsh-databricks-oauth)
  bundle fills `DATABRICKS_API_KEY` with a rotating OAuth token, which is what
  this configuration points at.

### 1. Add the bundle

```
github:bcheng004/dsh-databricks-genie-one-mcp
```

or, pinned to a commit so DSH can offer **Update** later:

```sh
dsh plugin --profile <profile-name> add github:bcheng004/dsh-databricks-genie-one-mcp#<commit>
```

The bundle ships a placeholder workspace. Activation fails with an unresolvable
host until the next step names yours, which is easier to diagnose than a plugin
that silently starts with no Genie tools.

### 2. Name your workspace

Both rows need your endpoint, and an override replaces a row's complete
configuration, so set both in your profile's `cordis.patch.yml`:

```yaml
- id: mcp-genie-one
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: genie_one
    transport: streamable-http
    url: https://<workspace-hostname>/ai-gateway/mcp-services/system.ai.genie_one_mcp
    headers:
      Authorization: 'Bearer ${credential:DATABRICKS_API_KEY}'
    expandTemplates: true
    toolCallTimeoutMs: 120000
    failOnStartupError: true

- id: genie-answer
  name: '@local/dsh-databricks-genie-one-mcp'
  config:
    url: https://<workspace-hostname>/ai-gateway/mcp-services/system.ai.genie_one_mcp
    ref: DATABRICKS_API_KEY
    pollIntervalMs: 3000
    deadlineMs: 600000
```

## Configuration

The MCP row (`mcp-genie-one`):

| Field | Default | Meaning |
|---|---|---|
| `serverName` | `genie_one` | Prefix of the four tool names. |
| `transport` | `streamable-http` | The Unity Gateway endpoint is Streamable HTTP. |
| `url` | — | The workspace's `system.ai.genie_one_mcp` endpoint. |
| `headers.Authorization` | — | `Bearer ${credential:REF}`, resolved per connection and never stored in configuration. |
| `expandTemplates` | `true` | Resolves `${credential:REF}` at runtime and redacts it from diagnostics. **Required** for a rotating token; a `!!js` expression would freeze the token at load. |
| `toolCallTimeoutMs` | `120000` | Per-call limit. Genie work outlasts the 60 s client default. |
| `failOnStartupError` | `true` | A rejected activation beats starting with zero tools. |

The wrapper row (`genie-answer`):

| Field | Default | Meaning |
|---|---|---|
| `url` | — | Same endpoint. Required; empty refuses activation. |
| `ref` | `DATABRICKS_API_KEY` | Credential reference, resolved per request so a rotated token applies to the next answer. |
| `pollIntervalMs` | `3000` | Delay between polls. |
| `deadlineMs` | `600000` | Hard bound on one answer. Exceeding it fails with the conversation id instead of hanging. |
| `requestTimeoutMs` | `60000` | Per-request bound, including session negotiation. |
| `maxAnswerChars` | `24000` | Truncates a long answer, marking how much was cut. |

`genie_answer` declares `timeoutMs = deadlineMs + 30s` on its tool definition,
so the harness limit sits above the plugin's own deadline and the plugin fails
first with an actionable message.

## Requirements and limitations

- **Governed twice.** Unity Gateway grants and policies decide who may invoke
  the service; the caller's Unity Catalog and warehouse permissions decide what
  generated SQL can read.
- **`genie_answer` blocks.** It occupies one tool slot for as long as Genie
  takes and shows no incremental progress, because a tool returns a value rather
  than a stream. Use the MCP tools when progress matters.
- **The MCP server owns the answers.** Answers are attributed to the
  credential's identity, and a workspace without the service answers `404`.
- **Two connections.** The MCP row keeps a long-lived session; the wrapper opens
  one per answer. They are independent, so one failing leaves the other usable.

## Turning it off

Disable the bundle in **Plugins**. Nothing is written to the credential store,
so disabling only removes the tools.
