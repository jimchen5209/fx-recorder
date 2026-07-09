import { EventEmitter } from 'node:events'
import { debounce } from 'lodash'

export declare interface MessageQueue {
  on(event: 'process', listener: (messages: string[], queueTime: number) => void): this
  emit(event: 'process', messages: string[], queueTime: number): boolean
}

/**
 * A message queue that batches messages and processes them after a debounce period.
 * Forces a flush when maxSize is reached to prevent unbounded queue growth.
 *
 * @event process - Emitted when the queue is processed
 *   @param messages - Array of messages in the queue
 *   @param queueTime - Time in milliseconds between the oldest message and processing time
 *
 * @example
 * ```typescript
 * const queue = new MessageQueue(1000, 100); // 1 second debounce, flush at 100 messages
 * queue.on('process', (messages, queueTime) => {
 *   console.log(`Processing ${messages.length} messages after ${queueTime}ms`);
 * });
 * queue.addMessage('test');
 * ```
 */
// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: initialized in EventEmitter
export class MessageQueue extends EventEmitter {
  private queue: Array<{ message: string; timestamp: number }> = []
  private readonly debounceTime: number = 1000
  private readonly maxSize: number = 100

  constructor(debounceTime: number = 1000, maxSize: number = 100) {
    super()
    this.debounceTime = debounceTime
    this.maxSize = maxSize
  }

  /**
   * Add a message to the queue.
   * Automatically flushes the queue if maxSize is reached to prevent unbounded growth
   * when messages arrive faster than the debounce interval.
   * @param message The message to add
   */
  public addMessage(message: string): void {
    this.queue.push({
      message,
      timestamp: Date.now()
    })
    if (this.queue.length >= this.maxSize) {
      this.scheduleProcess.flush()
    } else {
      this.scheduleProcess()
    }
  }

  private scheduleProcess = debounce(() => {
    this.processQueue()
  }, this.debounceTime)

  private processQueue(): void {
    if (this.queue.length === 0) return

    const now = Date.now()
    const oldestMessageTime = Math.min(...this.queue.map((item) => item.timestamp))
    const queueTime = now - oldestMessageTime

    this.emit(
      'process',
      this.queue.map((item) => item.message),
      queueTime
    )
    this.queue = []
  }
}
