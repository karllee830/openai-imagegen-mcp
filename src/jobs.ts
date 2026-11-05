import { randomBytes } from 'node:crypto';

export type JobState = 'running' | 'completed' | 'failed';

export interface Job<T> {
  readonly id: string;
  readonly startedAt: number;
  finishedAt?: number;
  state: JobState;
  result?: T;
  error?: unknown;
  readonly settled: Promise<void>;
  abort(): void;
}

/**
 * Runs work independently of the MCP request that started it, so a call can stop
 * waiting before the client's timeout while the work continues and stays collectable.
 */
export class JobStore<T> {
  private readonly jobs = new Map<string, Job<T>>();

  constructor(private readonly retentionMs = 60 * 60 * 1000) {}

  start(task: (signal: AbortSignal, id: string) => Promise<T>): Job<T> {
    const controller = new AbortController();
    const id = `img_${randomBytes(6).toString('hex')}`;

    const job: Job<T> = {
      id,
      startedAt: Date.now(),
      state: 'running',
      abort: () => controller.abort(),
      settled: task(controller.signal, id).then(
        (result) => {
          job.result = result;
          job.state = 'completed';
          this.finish(job);
        },
        (error: unknown) => {
          job.error = error;
          job.state = 'failed';
          this.finish(job);
        },
      ),
    };
    this.jobs.set(id, job);
    return job;
  }

  get(id: string): Job<T> | undefined {
    return this.jobs.get(id);
  }

  /** Resolves when the job settles, the time is up, or the signal aborts, whichever is first. */
  wait(job: Job<T>, ms: number, signal: AbortSignal): Promise<void> {
    if (job.state !== 'running' || signal.aborted) return Promise.resolve();

    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      signal.addEventListener('abort', finish, { once: true });
      void job.settled.then(finish);
    });
  }

  private finish(job: Job<T>): void {
    job.finishedAt = Date.now();
    setTimeout(() => this.jobs.delete(job.id), this.retentionMs).unref();
  }
}
