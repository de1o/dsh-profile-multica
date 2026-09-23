import { describe, expect, it, vi } from 'vitest'
import { loadMulticaImages } from '../src/images.ts'

const id = '11111111-1111-1111-1111-111111111111'
const env = {
  MULTICA_SERVER_URL: 'https://multica.example',
  MULTICA_TOKEN: 'mat_secret',
  MULTICA_WORKSPACE_ID: 'workspace-1',
  MULTICA_TASK_ID: 'task-1',
}

describe('Multica DSH image input', () => {
  it('fetches scoped metadata then signed bytes without forwarding the task token', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({ id, content_type: 'image/png', filename: 'chart.png', download_url: 'https://cdn.example/signed' }))
      .mockResolvedValueOnce(new Response(new Uint8Array([137, 80, 78, 71])))
    const images = await loadMulticaImages([id], 100, new AbortController().signal, env, request)
    expect(images).toEqual([{ data: new Uint8Array([137, 80, 78, 71]), mediaType: 'image/png', name: 'chart.png' }])
    expect(request.mock.calls[0]![0].toString()).toBe(`https://multica.example/api/attachments/${id}`)
    expect(request.mock.calls[0]![1].headers).toMatchObject({ Authorization: 'Bearer mat_secret', 'X-Workspace-ID': 'workspace-1', 'X-Task-ID': 'task-1' })
    expect(request.mock.calls[1]![0].toString()).toBe('https://cdn.example/signed')
    expect(request.mock.calls[1]![1].headers).toBeUndefined()
  })

  it('rejects inaccessible images and oversized downloads', async () => {
    const denied = vi.fn().mockResolvedValue(new Response('', { status: 404 }))
    await expect(loadMulticaImages([id], 100, new AbortController().signal, env, denied)).rejects.toThrow('HTTP 404')
    const oversized = vi.fn()
      .mockResolvedValueOnce(Response.json({ id, content_type: 'image/png', download_url: '/signed' }))
      .mockResolvedValueOnce(new Response(new Uint8Array(101)))
    await expect(loadMulticaImages([id], 100, new AbortController().signal, env, oversized)).rejects.toThrow('exceeds DSH image limit')
  })

  it('does not make requests for text-only turns', async () => {
    const request = vi.fn()
    expect(await loadMulticaImages([], 100, new AbortController().signal, {}, request)).toEqual([])
    expect(request).not.toHaveBeenCalled()
  })
})
