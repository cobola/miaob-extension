import type { TextBlock } from '../dom/types'

/** 单次请求的文本上限（服务端 chunk 4000，取一半留出分隔符与抖动） */
export const MAX_GROUP_CHARS = 2000
/** 分组送检的并发度：再多会把服务端 LLM 队列打满 */
export const BLOCK_CONCURRENCY = 2

/** 相邻块合并成批，减少请求数；单块超限则独立成批 */
export function batchBlocks(blocks: TextBlock[], maxChars = MAX_GROUP_CHARS): TextBlock[][] {
  const batches: TextBlock[][] = []
  let current: TextBlock[] = []
  let size = 0

  for (const block of blocks) {
    const standalone = block.text.length >= maxChars
    if (current.length > 0 && (standalone || size + block.text.length > maxChars)) {
      batches.push(current)
      current = []
      size = 0
    }
    current.push(block)
    size += block.text.length
    if (size >= maxChars) {
      batches.push(current)
      current = []
      size = 0
    }
  }
  if (current.length > 0) batches.push(current)
  return batches
}

/** 有限并发跑完所有任务，某个任务失败不中断其余任务 */
export async function runConcurrent<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      await worker(items[index], index)
    }
  })
  await Promise.all(runners)
}

/** 让出主线程，避免大页面检查期间页面卡住 */
export function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}
