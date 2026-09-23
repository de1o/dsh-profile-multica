# Multica JSONL 协议

[English](protocol.md) | 中文

桥接器实现协议版本 `2`。每条输入命令和输出事件都是一个紧凑 JSON 对象，以 `\n` 结尾。Multica 向 stdin 写入命令、从 stdout 读取协议事件；stderr 仅承载诊断文本。

## 进程模式

`dsh --profile multica --probe` 输出一个发现对象并成功退出：

```json
{"v":2,"type":"probe","runtime":"dsh","plugin_version":"0.2.2","protocol_version":2}
```

`dsh --profile multica --list-models` 输出一个 `models` 事件。模型 id 分别对 DSH 提供方 id 和模型 id 做百分号编码，并用一个 `/` 分隔。

`dsh --profile multica --stdio` 启动任务协议。它先输出 `ready`，然后至多接受一条 `execute` 命令；请求活动期间可以再发送一条 `cancel` 命令。

## 执行请求

最小请求如下：

```json
{"v":2,"type":"execute","request_id":"task-1","cwd":"/workspace","prompt":"修复失败的测试"}
```

可选字段可以选择模型、恢复持久化 Session，并添加任务作用域内的 MCP server：

```json
{
  "v": 2,
  "type": "execute",
  "request_id": "task-2",
  "cwd": "/workspace",
  "prompt": "继续实现",
  "resume_session_id": "multica-existing-session",
  "model": {
    "provider": "deepseek",
    "id": "deepseek-chat",
    "reasoning_effort": "high"
  },
  "tool_call_budget": {
    "soft_limit": 60,
    "hard_limit": 120
  },
  "progress_reminder": {
    "silence_ms": 90000,
    "tool_calls": 5
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

`prompt` 可以为空。`request_id`、`cwd`、提供方/模型 id、Session id、MCP 名称、命令与 URL 必须是非空字符串。超时单位为毫秒，必须是正的安全整数。工具调用限制也必须是正的安全整数，并满足 `soft_limit < hard_limit`。达到软限制时，桥接器要求 Agent 停止宽泛探索并基于已有证据收尾；达到硬限制时取消 Agent，并返回 `TOOL_CALL_BUDGET_EXCEEDED`。

`progress_reminder` 是可选项。当 Agent 连续执行 `tool_calls` 次工具仍未输出可见文本，或工具活动静默达到 `silence_ms` 时，桥接器会追加一条隐藏的 next-step 提醒，要求 Agent 简要汇报进展后继续执行。在 Agent 输出可见文本前，桥接器不会重复追加提醒。

## 输出事件

桥接器接受 execute 命令后，会先于任务输出发送 `session` 事件，随后流式发送以下事件：

- `text` 与 `thinking` 通过 `content` 承载增量内容。
- `tool_call` 包含 `call_id`、`name` 和序列化后的 `arguments`。
- `tool_result` 包含 `call_id`、文本 `output` 和 `is_error`。
- `usage` 包含提供方/模型 id，以及输入、输出、缓存读取与缓存写入 token 数。

每个被接受的 execute 命令只产生一个终态 `result`。其 `status` 为 `completed`、`cancelled` 或 `failed`。`stop_reason` 用来区分正常完成、token 耗尽、取消、启动失败、桥接失败、操作受阻和回合未完整结束。恢复一个已不存在的 Session 时，结果会带有 `resume_rejected: true` 和 `AGENT_START_FAILED`。

格式错误的命令产生 `protocol_error`。无效 JSON 或无效 execute 命令会让进程以退出码 `1` 结束；取消一个非活动请求会返回 `REQUEST_NOT_ACTIVE`，进程继续运行。

## 取消与生命周期

使用下面的命令取消活动请求：

```json
{"v":2,"type":"cancel","request_id":"task-1"}
```

请求 id 必须与活动 execute 命令一致。桥接器会中止尚未完成的初始化、要求已创建的 Agent 取消、在 Agent 进入空闲状态后刷新持久化数据、写入终态结果并退出。关闭 stdin 也会取消活动任务。在同一进程中启动第二个 execute 命令会返回 `REQUEST_ACTIVE`。

退出码 `0` 表示协议流程正常结束，包括终态结果为 `status: "failed"` 的任务；客户端必须以终态结果判断任务状态。退出码 `1` 表示协议流本身无法完成，例如输入格式错误或运行器出现未捕获异常。
