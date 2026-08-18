# Multica JSONL protocol

English | [中文](protocol.zh.md)

The bridge implements protocol version `1`. Each input command and output event is one compact JSON object followed by `\n`. Multica writes commands to stdin, reads protocol events from stdout, and treats stderr as diagnostic text only.

## Process modes

`dsh --profile multica --probe` prints one discovery object and exits successfully:

```json
{"v":1,"type":"probe","runtime":"dsh","plugin_version":"0.1.0","protocol_version":1}
```

`dsh --profile multica --list-models` prints one `models` event. Model ids percent-encode the DSH provider and model ids around one `/` separator.

`dsh --profile multica --stdio` starts the task protocol. It first prints `ready`, then accepts at most one `execute` command. A `cancel` command may follow while that request is active.

## Execute

The minimal command is:

```json
{"v":1,"type":"execute","request_id":"task-1","cwd":"/workspace","prompt":"Fix the failing test"}
```

Optional fields select a model, restore a durable session, and add task-scoped MCP servers:

```json
{
  "v": 1,
  "type": "execute",
  "request_id": "task-2",
  "cwd": "/workspace",
  "prompt": "Continue the implementation",
  "resume_session_id": "multica-existing-session",
  "model": {
    "provider": "deepseek",
    "id": "deepseek-chat",
    "reasoning_effort": "high"
  },
  "mcp_servers": [
    {
      "name": "local-tools",
      "transport": "stdio",
      "command": "node",
      "args": ["server.mjs"],
      "env": {},
      "tool_call_timeout_ms": 60000
    },
    {
      "name": "remote-tools",
      "transport": "streamable-http",
      "url": "https://example.test/mcp",
      "headers": {},
      "tool_call_timeout_ms": 60000
    }
  ]
}
```

`prompt` may be empty. `request_id`, `cwd`, provider/model ids, session ids, MCP names, commands, and URLs must be non-empty strings. Timeouts are positive safe integers in milliseconds.

## Events

After accepting an execute command, the bridge emits a `session` event before task output. It then streams any of these events:

- `text` and `thinking` carry incremental `content`.
- `tool_call` carries `call_id`, `name`, and serialized `arguments`.
- `tool_result` carries `call_id`, textual `output`, and `is_error`.
- `usage` carries provider/model ids and input, output, cache-read, and cache-write token counts.

Exactly one terminal `result` follows an accepted execute command. Its `status` is `completed`, `cancelled`, or `failed`. The `stop_reason` distinguishes normal completion, token exhaustion, cancellation, startup failure, bridge failure, blocked work, and incomplete turns. A resumed session that no longer exists reports `resume_rejected: true` with `AGENT_START_FAILED`.

Malformed commands produce `protocol_error`. Invalid JSON or an invalid execute command stops the process with exit code `1`; a cancel for a request that is not active reports `REQUEST_NOT_ACTIVE` and leaves the process running.

## Cancellation and lifecycle

Cancel the active request with:

```json
{"v":1,"type":"cancel","request_id":"task-1"}
```

The request id must match the active execute command. The bridge aborts pending setup, asks an already-created Agent to cancel, flushes durable session state after the Agent becomes idle, writes the terminal result, and exits. Closing stdin also cancels active work. Starting a second execute command in the same process reports `REQUEST_ACTIVE`.

Exit code `0` means the protocol completed normally, including a task whose terminal result has `status: "failed"`; clients must use the terminal result for task status. Exit code `1` means the protocol stream itself could not complete, such as malformed input or an uncaught runner failure.
