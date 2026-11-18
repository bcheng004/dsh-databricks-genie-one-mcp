/**
 * One blocking Genie tool: ask, wait, answer.
 *
 * The Genie One MCP server is deliberately asynchronous — `genie_ask` returns
 * an in-flight response and leaves polling to the caller. That is right for
 * long investigations, but it also lets a model stop after one call and report
 * a half-finished answer. This plugin owns the whole cycle behind a single tool
 * call, so the model never sees an in-flight state.
 *
 * It speaks MCP directly rather than calling the server's tools through the
 * harness registry, which keeps it independent of another plugin's rows.
 *
 * @module @local/dsh-databricks-genie-one-mcp
 */

/** Registered plugin name, also the prefix of every log line. */
export const name = 'dsh-databricks-genie-one-mcp'

/** The credential seam supplies the bearer; the tool registry receives the tool. */
export const inject = ['credentials', 'tools']

/** Defaults overridden by the row's `config`. */
const DEFAULTS = {
  url: '',
  ref: 'DATABRICKS_API_KEY',
  pollIntervalMs: 3000,
  deadlineMs: 600000,
  requestTimeoutMs: 60000,
  maxAnswerChars: 24000,
}

const PROTOCOL_VERSION = '2025-06-18'

/**
 * Prefer the Cordis logger and fall back to the console.
 * @param {object} ctx - the plugin context.
 * @returns {object} something with `info` and `warn` methods.
 */
function pickLogger(ctx) {
  try {
    if (typeof ctx.logger === 'function') {
      const logger = ctx.logger(name)
      if (logger !== undefined && logger !== null) return logger
    }
  } catch {
    // A composition without a logger still gets its warnings on stdout.
  }
  return console
}

/**
 * Fail with a message that names the setting to fix.
 * @param {string} message - what went wrong.
 * @param {string} [code] - stable identifier for programmatic handling.
 * @returns {Error} the failure.
 */
function fail(message, code) {
  const error = new Error(message)
  if (code !== undefined) error.code = code
  return error
}

/**
 * Read a JSON-RPC reply from either a JSON body or an SSE stream.
 *
 * The endpoint answered model calls with `application/json`, but Streamable
 * HTTP permits `text/event-stream` for the same request, so both are accepted
 * and the last complete JSON event wins.
 * @param {Response} response - the fetch reply.
 * @returns {Promise<object>} the JSON-RPC envelope.
 */
async function readRpc(response) {
  const text = await response.text()
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('text/event-stream')) {
    const payloads = text
      .split('\n')
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trim())
      .filter(payload => payload !== '' && payload !== '[DONE]')
    if (payloads.length === 0) throw fail('MCP stream carried no data event', 'MCP_EMPTY')
    return JSON.parse(payloads[payloads.length - 1])
  }
  try {
    return JSON.parse(text)
  } catch {
    throw fail(`MCP replied with a non-JSON body (HTTP ${String(response.status)})`, 'MCP_BAD_BODY')
  }
}

/**
 * Unwrap one `tools/call` result into its text and typed fields.
 *
 * `genie_ask` answers with a JSON document in its text block, while the poll
 * tools answer with Markdown beside a `structuredContent` object, so both are
 * read here and the caller decides which one it has.
 * @param {object} envelope - the JSON-RPC envelope.
 * @param {string} tool - the tool name, for diagnostics.
 * @returns {{text: string, structured: object | undefined}} the payload.
 */
function readToolResult(envelope, tool) {
  if (envelope?.error !== undefined && envelope.error !== null) {
    const message = envelope.error.message ?? 'unknown MCP error'
    throw fail(`MCP tool ${tool} failed: ${String(message)}`, 'MCP_TOOL_ERROR')
  }
  const result = envelope?.result
  if (result === undefined || result === null) {
    throw fail(`MCP tool ${tool} returned no result`, 'MCP_NO_RESULT')
  }
  const blocks = Array.isArray(result.content) ? result.content : []
  const text = blocks
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
  if (result.isError === true) {
    throw fail(`MCP tool ${tool} reported an error: ${text.slice(0, 400)}`, 'MCP_TOOL_ERROR')
  }
  return { text, structured: result.structuredContent }
}

/**
 * Read the response status the server reported, from either field shape.
 * @param {{text: string, structured: object | undefined}} payload - tool output.
 * @returns {string | undefined} the status when one is present.
 */
function statusOf(payload) {
  const structured = payload.structured
  if (structured !== undefined && structured !== null && typeof structured.status === 'string') {
    return structured.status
  }
  if (payload.text.startsWith('{')) {
    try {
      const parsed = JSON.parse(payload.text)
      if (typeof parsed?.status === 'string') return parsed.status
    } catch {
      // Fall through to the rendered form.
    }
  }
  const match = /\*\*Status:\*\*\s*`?([a-z_]+)`?/i.exec(payload.text)
  return match === null ? undefined : match[1].toLowerCase()
}

/**
 * Trim an answer to a bound the model can afford, marking the cut explicitly.
 * @param {string} text - the full answer.
 * @param {number} limit - maximum characters.
 * @returns {string} the answer, possibly shortened.
 */
function bound(text, limit) {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n\n[truncated ${String(text.length - limit)} characters]`
}

/**
 * Register the blocking Genie tool and the MCP session it rides on.
 * @param {object} ctx - the plugin context.
 * @param {object} config - the row's config, overriding {@link DEFAULTS}.
 */
export function apply(ctx, config) {
  const options = { ...DEFAULTS, ...(config ?? {}) }
  const log = pickLogger(ctx)
  const label = 'genie-answer'

  if (options.url === '') {
    throw new Error('genie-answer: `url` must name your workspace Genie One MCP endpoint')
  }

  /** @type {string | undefined} */
  let sessionId
  /** @type {Promise<string> | undefined} */
  let connecting

  /**
   * The bearer for one call. Resolved per request so a rotated token applies
   * immediately, exactly as the MCP client does for its own connection.
   * @returns {Promise<string>} the token.
   */
  async function bearer() {
    const credentials = ctx.get('credentials')
    if (credentials === undefined) throw fail('genie-answer: no credentials service is mounted', 'NO_CREDENTIAL_STORE')
    const hit = await credentials.resolve(options.ref)
    if (hit === undefined || hit.value === '') {
      throw fail(`genie-answer: credential ${options.ref} is not set`, 'MISSING_CREDENTIAL')
    }
    return hit.value
  }

  /**
   * One JSON-RPC exchange, optionally carrying the session.
   * @param {object} body - the JSON-RPC request.
   * @param {string | undefined} session - the negotiated session id.
   * @param {AbortSignal | undefined} signal - caller cancellation.
   * @returns {Promise<{envelope: object, session: string | undefined}>} the reply.
   */
  async function rpc(body, session, signal) {
    const token = await bearer()
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL_VERSION,
    }
    if (session !== undefined) headers['Mcp-Session-Id'] = session
    const timeout = AbortSignal.timeout(options.requestTimeoutMs)
    const response = await fetch(options.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    })
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 400)
      throw fail(`genie-answer: MCP request failed with HTTP ${String(response.status)}: ${detail}`, 'MCP_HTTP')
    }
    return { envelope: await readRpc(response), session: response.headers.get('mcp-session-id') ?? session }
  }

  /**
   * Negotiate a session once and reuse it, so a poll loop opens one connection.
   * @param {AbortSignal | undefined} signal - caller cancellation.
   * @returns {Promise<string>} the session id.
   */
  async function connect(signal) {
    if (sessionId !== undefined) return sessionId
    if (connecting !== undefined) return await connecting
    connecting = (async () => {
      const { envelope, session } = await rpc({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'dsh-databricks-genie-answer', version: '1.0.0' },
        },
      }, undefined, signal)
      if (envelope?.error !== undefined) {
        throw fail(`genie-answer: MCP initialize failed: ${String(envelope.error.message)}`, 'MCP_INIT')
      }
      if (session === undefined || session === '') {
        throw fail('genie-answer: MCP server returned no session id', 'MCP_NO_SESSION')
      }
      // The notification has no reply; a failure here is not worth aborting on.
      await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, session, signal).catch(() => {})
      sessionId = session
      return session
    })()
    try {
      return await connecting
    } finally {
      connecting = undefined
    }
  }

  /**
   * Call one MCP tool, re-negotiating a session that the server dropped.
   * @param {string} tool - the server's tool name.
   * @param {object} args - the tool arguments.
   * @param {AbortSignal | undefined} signal - caller cancellation.
   * @returns {Promise<{text: string, structured: object | undefined}>} the payload.
   */
  async function callTool(tool, args, signal) {
    let session = await connect(signal)
    let reply
    try {
      reply = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } }, session, signal)
    } catch (error) {
      if (error?.code !== 'MCP_HTTP') throw error
      sessionId = undefined
      session = await connect(signal)
      reply = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } }, session, signal)
    }
    return readToolResult(reply.envelope, tool)
  }

  const delay = (ms, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(fail('genie-answer: cancelled', 'CANCELLED'))
    }, { once: true })
  })

  /**
   * Ask, then poll until the response leaves `in_progress`.
   * @param {string} question - the natural-language question.
   * @param {string | undefined} conversationId - continue an existing thread.
   * @param {AbortSignal | undefined} signal - caller cancellation.
   * @returns {Promise<string>} the finished answer.
   */
  async function answer(question, conversationId, signal) {
    const asked = await callTool('genie_ask', {
      question,
      ...conversationId === undefined ? {} : { conversation_id: conversationId },
    }, signal)

    let conversation
    let responseId
    if (asked.text.startsWith('{')) {
      const parsed = JSON.parse(asked.text)
      conversation = parsed.conversation_id
      responseId = parsed.response_id
    }
    if (typeof conversation !== 'string' || typeof responseId !== 'string') {
      throw fail(`genie-answer: genie_ask did not return ids: ${asked.text.slice(0, 200)}`, 'BAD_ASK_RESULT')
    }

    const deadline = Date.now() + options.deadlineMs
    let last = asked
    while (statusOf(last) === 'in_progress' || statusOf(last) === undefined) {
      if (Date.now() > deadline) {
        throw fail(
          `genie-answer: Genie did not finish within ${String(Math.round(options.deadlineMs / 1000))}s.`
          + ` Conversation ${conversation}, response ${responseId}; poll it yourself with the Genie One MCP tools.`,
          'GENIE_TIMEOUT',
        )
      }
      await delay(options.pollIntervalMs, signal)
      last = await callTool('genie_poll_response', { conversation_id: conversation, response_id: responseId }, signal)
    }

    const status = statusOf(last)
    const body = bound(last.text, options.maxAnswerChars)
    const deepLink = last.structured?.deep_link
    const footer = typeof deepLink === 'string' ? `\n\n[Explore in Databricks](${deepLink})` : ''
    if (status === 'failed' || status === 'incomplete') {
      throw fail(`genie-answer: Genie finished with status ${String(status)}.\n\n${body}${footer}`, 'GENIE_FAILED')
    }
    return `${body}${footer}`
  }

  ctx.tools.register({
    name: 'genie_answer',
    description:
      'Ask Databricks Genie a natural-language question about enterprise data and wait for the finished answer.'
      + ' Returns the grounded Markdown answer, with a deep link when Genie provides one.'
      + ' Use this instead of the Genie One MCP tools when you want one result rather than progress updates.',
    // The registry wants a JSON Schema here; `defineTool` is only a typing and
    // validation helper that converts its DSL into exactly this shape.
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The natural-language data question.' },
        conversation_id: { type: 'string', description: 'Continue an earlier Genie conversation by its ID.' },
      },
      required: ['question'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    // The harness reads this from the registry; it sits just above the plugin's
    // own deadline so the plugin fails first, with a message naming the
    // conversation, instead of a bare tool-call timeout.
    timeoutMs: options.deadlineMs + 30000,
    async execute(args, exec) {
      if (typeof args?.question !== 'string' || args.question.trim() === '') {
        throw fail('genie_answer: `question` must be a non-empty string', 'BAD_ARGUMENTS')
      }
      log.info?.(`${label}: asking Genie`)
      return await answer(args.question.trim(), args.conversation_id, exec?.signal)
    },
  })
}
