# @local/dsh-databricks-genie-one-mcp

Connects DeepSeek Harness to the Databricks **Genie One** MCP server, so the
agent can answer questions about enterprise data by asking Genie instead of
guessing at SQL.

Genie grounds answers in Genie Ontology — business terms, metric definitions and
table relationships — and returns a deep link back into the Databricks UI.

## What you get

The server is exposed as `mcp__genie_one__<tool>`, and Genie's lifecycle maps
onto four tools:

| Tool | Purpose |
|---|---|
| `genie_ask` | Ask a question. Returns `conversation_id`, `response_id` and an initial state; pass `conversation_id` to continue a thread. |
| `genie_poll_response` | Fetch the current state of an in-flight or finished response as Markdown, plus `status`, `deep_link` and query items. |
| `genie_get_query_result` | Read the schema and inline rows for one SQL query Genie ran, once a response is `completed`. |
| `genie_cancel_response` | Stop a response that is still generating. |

An answer therefore takes a few calls: ask, poll until `completed`, then read
rows if the question needs actual data rather than prose.

## Why this is a bundle and not a tool plugin

The MCP server owns everything that made a hand-written integration expensive:
the asynchronous ask/poll/cancel lifecycle, conversation state, SQL execution,
result rendering, and the deep link. The DSH side is one configuration row.

## Install

Requirements:

- The workspace exposes `system.ai.genie_one_mcp` through Unity Gateway, and the
  caller is allowed to invoke it (Unity Gateway grant or policy).
- A credential reference holding a workspace bearer token. The companion
  [dsh-databricks-oauth](https://github.com/bcheng004/dsh-databricks-oauth)
  bundle fills `DATABRICKS_API_KEY` with a rotating OAuth token, which is what
  this configuration points at.

### 1. Add the bundle

**Plugins → Add plugin** accepts a package name, Git address, tarball, or
absolute local path:

```
github:bcheng004/dsh-databricks-genie-one-mcp
```

The same install from a shell, pinned to a commit so DSH can offer **Update**
later:

```sh
dsh plugin --profile <profile-name> add github:bcheng004/dsh-databricks-genie-one-mcp#<commit>
```

The bundle ships a placeholder workspace on purpose. Activation fails with an
unresolvable host until the next step names yours, which is easier to diagnose
than a row that silently starts with no Genie tools.

### 2. Name your workspace

Set your endpoint in your own profile's `cordis.patch.yml`. An override replaces
the row's complete configuration, so repeat every field:

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
```

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `serverName` | `genie_one` | Prefix of every tool name: `mcp__genie_one__genie_ask`. |
| `transport` | `streamable-http` | The Unity Gateway endpoint is Streamable HTTP. |
| `url` | — | `https://<workspace-hostname>/ai-gateway/mcp-services/system.ai.genie_one_mcp`. |
| `headers.Authorization` | — | `Bearer ${credential:REF}`. Resolved per connection, never stored in configuration. |
| `expandTemplates` | `true` | Resolves `${credential:REF}` at runtime and redacts the resolved value from diagnostics. **Required** for a rotating token. |
| `toolCallTimeoutMs` | `120000` | Genie work is slower than a typical tool; the MCP client default of 60 s is tight. |
| `failOnStartupError` | `true` | A rejected activation beats silently starting with zero Genie tools. |

`expandTemplates` is the part that matters. A `!!js` expression would run once
at load and freeze whatever token existed then; the template path re-resolves
the reference and rebuilds the connection when the credential changes, which is
what keeps an hourly-rotating OAuth token working.

## Requirements and limitations

- **Governed twice.** Unity Gateway grants and policies decide who may invoke
  the service; the caller's own Unity Catalog and warehouse permissions decide
  what the generated SQL can read. Both must allow the question.
- **Polling costs turns.** One business question is typically two to four tool
  calls. A model that asks and stops will report a half-finished answer.
- **Results are server-sized.** `genie_get_query_result` returns the rows the
  server chooses to inline; a wide result still lands in the model's context.
- **MCP session state.** The client keeps the negotiated session per connection;
  a reconnect re-syncs tools rather than accumulating duplicates.
- The plugin issues no network calls of its own beyond the MCP connection.

## Turning it off

Disable the bundle in **Plugins**, or remove the row. Nothing is written to the
credential store, so disabling has no side effects beyond the tools disappearing.
