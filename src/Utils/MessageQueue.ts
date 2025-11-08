import { EventEmitter } from 'node:events'
import { debounce } from 'lodash'

export declare interface MessageQueue {
  on(event: 'process', listener: (messages: string[], queueTime: number) => void): this
  emit(event: 'process', messages: string[], queueTime: number): boolean
}

/**
 * A message queue that batches messages and processes them after a debounce period
 * 
 * @event process - Emitted when the queue is processed
 *   @param messages - Array of messages in the queue
 *   @param queueTime - Time in milliseconds between the oldest message and processing time
 * 
 * @example
 * ```typescript
 * const queue = new MessageQueue(1000); // 1 second debounce
 * queue.on('process', (messages, queueTime) => {
 *   console.log(`Processing ${messages.length} messages after ${queueTime}ms`);
 * });
 * queue.addMessage('test');
 * ```
 */
export class MessageQueue extends EventEmitter {
  private queue: Array<{ message: string; timestamp: number }> = []
  private readonly debounceTime: number = 1000

  constructor(debounceTime: number = 1000) {
    super()
    this.debounceTime = debounceTime
  }

  /**
   * Add a message to the queue
   * @param message The message to add
   */
  public addMessage(message: string): void {
    this.queue.push({
      message,
      timestamp: Date.now()
    })
    this.scheduleProcess()
  }

  private scheduleProcess = debounce(() => {
    this.processQueue()
  }, this.debounceTime)

  private processQueue(): void {
    if (this.queue.length === 0) return

    const now = Date.now()
    const oldestMessageTime = Math.min(...this.queue.map(item => item.timestamp))
    const queueTime = now - oldestMessageTime

    this.emit('process', this.queue.map(item => item.message), queueTime)
    this.queue = []
  }
}
