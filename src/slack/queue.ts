export type QueuedTask<Result> = () => Promise<Result>;

export interface ChannelQueue {
  enqueue<Result>(channelId: string, task: QueuedTask<Result>): Promise<Result>;
}

export class InMemoryChannelQueue implements ChannelQueue {
  private readonly tailsByChannel = new Map<string, Promise<void>>();

  enqueue<Result>(channelId: string, task: QueuedTask<Result>): Promise<Result> {
    const previousTail = this.tailsByChannel.get(channelId) ?? Promise.resolve();
    const result = previousTail.catch(() => undefined).then(task);
    const nextTail = result.then(
      () => undefined,
      () => undefined,
    );

    this.tailsByChannel.set(channelId, nextTail);
    nextTail.then(() => {
      if (this.tailsByChannel.get(channelId) === nextTail) {
        this.tailsByChannel.delete(channelId);
      }
    });

    return result;
  }
}

