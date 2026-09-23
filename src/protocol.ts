/** Versioned Multica JSONL wire types and untrusted-input validation. */

/** Protocol version implemented by both Multica and this bundle. */
export const MULTICA_PROTOCOL_VERSION = 2

/** Per-run guardrails supplied by Multica. */
export interface MulticaToolCallBudget {
  soft_limit: number
  hard_limit: number
}

/** Ask a silent run to publish user-visible progress without stopping it. */
export interface MulticaProgressReminder {
  silence_ms: number
  tool_calls: number
}

/** Model selection carried by an execute command. */
export interface MulticaModelSelection {
  provider: string
  id: string
  reasoning_effort?: string
}

/** One per-task MCP server requested by Multica. */
export type MulticaMcpServer =
  | {
    name: string
    transport: 'stdio'
    command: string
    args: string[]
    env: Record<string, string>
    cwd?: string
    tool_call_timeout_ms?: number
  }
  | {
    name: string
    transport: 'streamable-http'
    url: string
    headers: Record<string, string>
    tool_call_timeout_ms?: number
  }

/** Start one task. A bridge process accepts at most one execute command. */
export interface MulticaExecuteCommand {
  v: 2
  type: 'execute'
  request_id: string
  cwd: string
  prompt: string
  image_attachment_ids?: string[]
  resume_session_id?: string
  model?: MulticaModelSelection
  reasoning_effort?: string
  mcp_servers: MulticaMcpServer[]
  tool_call_budget?: MulticaToolCallBudget
  progress_reminder?: MulticaProgressReminder
}

/** Cancel the currently active task. */
export interface MulticaCancelCommand {
  v: 2
  type: 'cancel'
  request_id: string
}

/** Any accepted input frame. */
export type MulticaCommand = MulticaExecuteCommand | MulticaCancelCommand

/** A validation failure with a stable protocol code. */
export class MulticaProtocolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new MulticaProtocolError('INVALID_REQUEST', `${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function string(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new MulticaProtocolError('INVALID_REQUEST', `${field} must be a ${allowEmpty ? '' : 'non-empty '}string`)
  }
  return value
}

function stringRecord(value: unknown, field: string): Record<string, string> {
  const source = value === undefined ? {} : record(value, field)
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(source)) result[key] = string(entry, `${field}.${key}`, true)
  return result
}

function timeout(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new MulticaProtocolError('INVALID_REQUEST', `${field} must be a positive integer`)
  }
  return value
}

function toolCallBudget(value: unknown): MulticaToolCallBudget {
  const source = record(value, 'tool_call_budget')
  const softLimit = timeout(source.soft_limit, 'tool_call_budget.soft_limit')
  const hardLimit = timeout(source.hard_limit, 'tool_call_budget.hard_limit')
  if (softLimit === undefined || hardLimit === undefined) {
    throw new MulticaProtocolError('INVALID_REQUEST', 'tool_call_budget requires soft_limit and hard_limit')
  }
  if (softLimit >= hardLimit) {
    throw new MulticaProtocolError('INVALID_REQUEST', 'tool_call_budget.soft_limit must be less than hard_limit')
  }
  return { soft_limit: softLimit, hard_limit: hardLimit }
}

function progressReminder(value: unknown): MulticaProgressReminder {
  const source = record(value, 'progress_reminder')
  const silenceMs = timeout(source.silence_ms, 'progress_reminder.silence_ms')
  const toolCalls = timeout(source.tool_calls, 'progress_reminder.tool_calls')
  if (silenceMs === undefined || toolCalls === undefined) {
    throw new MulticaProtocolError('INVALID_REQUEST', 'progress_reminder requires silence_ms and tool_calls')
  }
  return { silence_ms: silenceMs, tool_calls: toolCalls }
}

function mcpServer(value: unknown, index: number): MulticaMcpServer {
  const source = record(value, `mcp_servers[${index}]`)
  const prefix = `mcp_servers[${index}]`
  const name = string(source.name, `${prefix}.name`)
  const transport = string(source.transport, `${prefix}.transport`)
  const toolCallTimeout = timeout(source.tool_call_timeout_ms, `${prefix}.tool_call_timeout_ms`)
  if (transport === 'stdio') {
    const args = source.args === undefined ? [] : source.args
    if (!Array.isArray(args)) throw new MulticaProtocolError('INVALID_REQUEST', `${prefix}.args must be an array`)
    return {
      name,
      transport,
      command: string(source.command, `${prefix}.command`),
      args: args.map((entry, argIndex) => string(entry, `${prefix}.args[${argIndex}]`, true)),
      env: stringRecord(source.env, `${prefix}.env`),
      ...source.cwd === undefined ? {} : { cwd: string(source.cwd, `${prefix}.cwd`) },
      ...toolCallTimeout === undefined ? {} : { tool_call_timeout_ms: toolCallTimeout },
    }
  }
  if (transport === 'streamable-http') {
    return {
      name,
      transport,
      url: string(source.url, `${prefix}.url`),
      headers: stringRecord(source.headers, `${prefix}.headers`),
      ...toolCallTimeout === undefined ? {} : { tool_call_timeout_ms: toolCallTimeout },
    }
  }
  throw new MulticaProtocolError('INVALID_REQUEST', `${prefix}.transport must be stdio or streamable-http`)
}

/**
 * Parse and validate one untrusted JSONL line.
 * @param line - one line read from the process input stream.
 * @returns the normalized execute or cancel command.
 */
export function parseMulticaCommand(line: string): MulticaCommand {
  let decoded: unknown
  try {
    decoded = JSON.parse(line)
  } catch {
    throw new MulticaProtocolError('INVALID_JSON', 'input line is not valid JSON')
  }
  const source = record(decoded, 'request')
  if (source.v !== MULTICA_PROTOCOL_VERSION) {
    throw new MulticaProtocolError('UNSUPPORTED_VERSION', `protocol version must be ${MULTICA_PROTOCOL_VERSION}`)
  }
  const type = string(source.type, 'type')
  const requestId = string(source.request_id, 'request_id')
  if (type === 'cancel') return { v: 2, type, request_id: requestId }
  if (type !== 'execute') throw new MulticaProtocolError('UNKNOWN_COMMAND', `unsupported command type ${JSON.stringify(type)}`)
  const modelSource = source.model === undefined ? undefined : record(source.model, 'model')
  const model: MulticaModelSelection | undefined = modelSource === undefined
    ? undefined
    : {
      provider: string(modelSource.provider, 'model.provider'),
      id: string(modelSource.id, 'model.id'),
      ...modelSource.reasoning_effort === undefined
        ? {}
        : { reasoning_effort: string(modelSource.reasoning_effort, 'model.reasoning_effort') },
    }
  const servers = source.mcp_servers === undefined ? [] : source.mcp_servers
  if (!Array.isArray(servers)) throw new MulticaProtocolError('INVALID_REQUEST', 'mcp_servers must be an array')
  const images = source.image_attachment_ids === undefined ? [] : source.image_attachment_ids
  if (!Array.isArray(images) || images.length > 10) {
    throw new MulticaProtocolError('INVALID_REQUEST', 'image_attachment_ids must be an array of at most 10 ids')
  }
  return {
    v: 2,
    type,
    request_id: requestId,
    cwd: string(source.cwd, 'cwd'),
    prompt: string(source.prompt, 'prompt', true),
    ...images.length === 0 ? {} : { image_attachment_ids: images.map((id, index) => string(id, `image_attachment_ids[${index}]`)) },
    ...source.resume_session_id === undefined
      ? {}
      : { resume_session_id: string(source.resume_session_id, 'resume_session_id') },
    ...model === undefined ? {} : { model },
    ...source.reasoning_effort === undefined
      ? {}
      : { reasoning_effort: string(source.reasoning_effort, 'reasoning_effort') },
    mcp_servers: servers.map(mcpServer),
    ...source.tool_call_budget === undefined
      ? {}
      : { tool_call_budget: toolCallBudget(source.tool_call_budget) },
    ...source.progress_reminder === undefined
      ? {}
      : { progress_reminder: progressReminder(source.progress_reminder) },
  }
}

/**
 * Encode one JSON object as a newline-terminated frame.
 * @param frame - protocol fields to serialize.
 * @returns one JSONL frame.
 */
export function encodeMulticaFrame(frame: Readonly<Record<string, unknown>>): string {
  return `${JSON.stringify(frame)}\n`
}

/**
 * Encode a provider/model pair into Multica's slash-delimited model id.
 * @param provider - DSH model-provider id.
 * @param model - provider-local model id.
 * @returns the percent-encoded Multica catalog id.
 */
export function multicaModelId(provider: string, model: string): string {
  return `${encodeURIComponent(provider)}/${encodeURIComponent(model)}`
}
