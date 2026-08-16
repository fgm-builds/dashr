/**
 * The host-side registry of live rlm() runs: one {@link DASHRSubagentRun}
 * per `run_id`, held from non-blocking admission until `rlm_await` settles it
 * or the parent session ends. Lives at the presentation tool-definition level
 * (one per composition/mount), not per `run_cell` call — rlm() in one cell and
 * rlm_await() in a LATER cell must resolve the same handle. Run ids are the
 * provider's unique parent-scoped ids, so one shared map is safe across the
 * sessions joined to a standing mount; teardown filters by the parent agent's
 * id recorded at admission.
 * @module dashr-plugin/rlm-runs
 */

import type { DASHRSubagentRun } from './subagents-surface.ts'

/** One live run plus the parent identity that owns it. */
export interface RlmRunRecord {
  run: DASHRSubagentRun
  parentId: string
}

/** Map of live rlm() runs with per-parent disposal. */
export class RlmRunRegistry {
  private readonly runs = new Map<string, RlmRunRecord>()

  /** Admit one published run under its run id. */
  set(runId: string, record: RlmRunRecord): void {
    this.runs.set(runId, record)
  }

  /** Look up a live run by id. */
  get(runId: string): RlmRunRecord | undefined {
    return this.runs.get(runId)
  }

  /** Remove one run after settlement (or abandonment). */
  delete(runId: string): void {
    this.runs.delete(runId)
  }

  /** Number of live runs (diagnostics/tests). */
  get size(): number {
    return this.runs.size
  }

  /** Dispose every run still owned by one parent session; safe when none match. */
  async disposeFor(parentId: string): Promise<void> {
    const owned: { id: string, run: DASHRSubagentRun }[] = []
    for (const [id, record] of this.runs) {
      if (record.parentId === parentId) owned.push({ id, run: record.run })
    }
    for (const { id, run } of owned) {
      this.runs.delete(id)
      try {
        await run.dispose()
      } catch {
        // A run that already settled still must not block the others.
      }
    }
  }

  /** Dispose every run (composition teardown). */
  async disposeAll(): Promise<void> {
    const runs = [...this.runs.values()]
    this.runs.clear()
    await Promise.all(runs.map(({ run }) => run.dispose().catch(() => undefined)))
  }
}
