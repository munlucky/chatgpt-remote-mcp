/** Deadline covers provider execution and cleanup, up to Kernel's atomic handoff.
 * Once ingestion starts it is awaited; it is never abandoned by Promise.race. */
export class ReviewBudget {
  readonly controller = new AbortController();
  private readonly expiresAt: number;
  private readonly timer: ReturnType<typeof setTimeout>;
  private committing = false;
  constructor(timeoutMs: number) {
    this.expiresAt = performance.now() + timeoutMs;
    this.timer = setTimeout(() => this.controller.abort(), timeoutMs);
  }
  get signal() { return this.controller.signal; }
  check(): void {
    if (this.signal.aborted || (!this.committing && performance.now() >= this.expiresAt)) {
      this.controller.abort(); throw new Error("review_deadline_exceeded");
    }
  }
  async wait<T>(operation: () => Promise<T>): Promise<T> {
    this.check(); const result = await operation(); this.check(); return result;
  }
  beginCommit(): void {
    this.check(); this.committing = true; clearTimeout(this.timer);
  }
  dispose() { clearTimeout(this.timer); }
}

export class ReviewOutcomeJournal {
  outcome: unknown = null;
  observe(outcome: unknown) { this.outcome = structuredClone(outcome); }
}

export async function finalizeObservedReview<T extends { outcome: unknown }>(
  result: T, journal: ReviewOutcomeJournal, budget: ReviewBudget, cleanup: () => Promise<boolean>,
): Promise<T> {
  // Capture before any cleanup/ingestion await can fail or exceed the budget.
  journal.observe(result.outcome);
  budget.check();
  const clean = await cleanup();
  budget.check();
  if (!clean) throw new Error("reviewer_cleanup_unconfirmed");
  return result;
}
