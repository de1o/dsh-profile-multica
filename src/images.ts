import type { SaveImageAttachment, ImageMediaType } from '@deepseek-ai/dsh-attachment'

const mediaTypes = new Set<ImageMediaType>(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

export async function loadMulticaImages(
  ids: readonly string[],
  maxImageBytes: number,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch,
): Promise<SaveImageAttachment[]> {
  if (ids.length === 0) return []
  const server = env.MULTICA_SERVER_URL
  const token = env.MULTICA_TOKEN
  const workspace = env.MULTICA_WORKSPACE_ID
  const task = env.MULTICA_TASK_ID
  if (!server || !token || !workspace || !task) throw new Error('Multica image input requires task-scoped authentication')

  const images: SaveImageAttachment[] = []
  for (const id of ids) {
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id)) throw new Error('Invalid Multica image attachment id')
    const metadataURL = new URL(`/api/attachments/${encodeURIComponent(id)}`, server)
    const metadataResponse = await request(metadataURL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Workspace-ID': workspace,
        'X-Task-ID': task,
      },
      signal,
    })
    if (!metadataResponse.ok) throw new Error(`Cannot read Multica image ${id}: HTTP ${metadataResponse.status}`)
    const metadata: unknown = await metadataResponse.json()
    if (metadata === null || typeof metadata !== 'object') throw new Error(`Invalid Multica image metadata: ${id}`)
    const item = metadata as Record<string, unknown>
    if (item.id !== id || typeof item.content_type !== 'string' || !mediaTypes.has(item.content_type as ImageMediaType)
      || typeof item.download_url !== 'string' || !item.download_url) {
      throw new Error(`Unsupported Multica image attachment: ${id}`)
    }
    const downloadURL = new URL(item.download_url, server)
    if (downloadURL.protocol !== 'https:' && downloadURL.protocol !== 'http:') throw new Error('Invalid Multica image download URL')
    const response = await request(downloadURL, { signal })
    if (!response.ok || !response.body) throw new Error(`Cannot download Multica image ${id}: HTTP ${response.status}`)
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > maxImageBytes) throw new Error(`Multica image ${id} exceeds DSH image limit`)
        chunks.push(value)
      }
    } catch (error) {
      await reader.cancel()
      throw error
    } finally {
      reader.releaseLock()
    }
    const data = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      data.set(chunk, offset)
      offset += chunk.byteLength
    }
    images.push({ data, mediaType: item.content_type as ImageMediaType,
      ...typeof item.filename === 'string' ? { name: item.filename } : {} })
  }
  return images
}
