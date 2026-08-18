import { describe, expect, it } from 'vitest'
import {
  encodeMulticaFrame,
  MulticaProtocolError,
  multicaModelId,
  parseMulticaCommand,
} from '../src/protocol.ts'

describe('Multica protocol', () => {
  it('normalizes an execute request and both MCP transports', () => {
    expect(parseMulticaCommand(JSON.stringify({
      v: 1,
      type: 'execute',
      request_id: 'request-1',
      cwd: '/work',
      prompt: 'fix it',
      resume_session_id: 'session-1',
      model: { provider: 'deepseek-official', id: 'deepseek-v4-flash', reasoning_effort: 'high' },
      mcp_servers: [
        {
          name: 'files', transport: 'stdio', command: 'server', args: ['--root', '/work'],
          env: { TOKEN: 'secret' }, tool_call_timeout_ms: 1234,
        },
        {
          name: 'remote', transport: 'streamable-http', url: 'https://example.test/mcp',
          headers: { Authorization: 'Bearer secret' },
        },
      ],
      ignored: true,
    }))).toEqual({
      v: 1,
      type: 'execute',
      request_id: 'request-1',
      cwd: '/work',
      prompt: 'fix it',
      resume_session_id: 'session-1',
      model: { provider: 'deepseek-official', id: 'deepseek-v4-flash', reasoning_effort: 'high' },
      mcp_servers: [
        {
          name: 'files', transport: 'stdio', command: 'server', args: ['--root', '/work'],
          env: { TOKEN: 'secret' }, tool_call_timeout_ms: 1234,
        },
        {
          name: 'remote', transport: 'streamable-http', url: 'https://example.test/mcp',
          headers: { Authorization: 'Bearer secret' },
        },
      ],
    })
  })

  it('accepts cancel and defaults optional collections', () => {
    expect(parseMulticaCommand('{"v":1,"type":"cancel","request_id":"r"}'))
      .toEqual({ v: 1, type: 'cancel', request_id: 'r' })
    expect(parseMulticaCommand('{"v":1,"type":"execute","request_id":"r","cwd":"/w","prompt":""}'))
      .toMatchObject({ mcp_servers: [] })
  })

  it.each([
    { line: '{', code: 'INVALID_JSON' },
    { line: 'null', code: 'INVALID_REQUEST' },
    { line: '{}', code: 'UNSUPPORTED_VERSION' },
    { line: '{"v":2,"type":"cancel","request_id":"r"}', code: 'UNSUPPORTED_VERSION' },
    { line: '{"v":1,"type":"wat","request_id":"r"}', code: 'UNKNOWN_COMMAND' },
    { line: '{"v":1,"type":"execute","request_id":"r","cwd":"/w","prompt":"x","mcp_servers":{}}', code: 'INVALID_REQUEST' },
    { line: '{"v":1,"type":"execute","request_id":"r","cwd":"/w","prompt":"x","mcp_servers":[{"name":"x","transport":"sse"}]}', code: 'INVALID_REQUEST' },
    { line: '{"v":1,"type":"execute","request_id":"r","cwd":"/w","prompt":"x","mcp_servers":[{"name":"x","transport":"stdio","command":"c","args":{},"env":{}}]}', code: 'INVALID_REQUEST' },
    { line: '{"v":1,"type":"execute","request_id":"r","cwd":"/w","prompt":"x","mcp_servers":[{"name":"x","transport":"stdio","command":"c","tool_call_timeout_ms":0}]}', code: 'INVALID_REQUEST' },
  ])('rejects invalid input with $code', ({ line, code }) => {
    expect(() => parseMulticaCommand(line)).toThrow(MulticaProtocolError)
    try {
      parseMulticaCommand(line)
    } catch (error) {
      expect(error).toMatchObject({ code })
    }
  })

  it('encodes model ids and newline-terminated frames', () => {
    expect(multicaModelId('openai/gateway', 'org/model v2')).toBe('openai%2Fgateway/org%2Fmodel%20v2')
    expect(encodeMulticaFrame({ v: 1, type: 'probe' })).toBe('{"v":1,"type":"probe"}\n')
  })
})
