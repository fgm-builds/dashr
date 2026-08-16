/**
 * The Continual Harness store (M4-B, blueprint §6): per-agent durable prompt
 * state — notes, memories, skills — that the `dasher:harness` system-prompt
 * section re-renders at EVERY assembly (prompt-as-variable), so a refine()
 * that lands mid-session is visible to the very next model request without
 * any restart. Storage is one JSON file per agent under the configured
 * `harnessDir` (atomic tmp-sibling + rename, the shape of upstream
 * `dsh-atomic-write` in miniature — deliberately self-implemented so the
 * presentation adds no runtime dependency for this); with no `harnessDir`
 * the store is memory-only and dies with the composition, the same
 * opt-in posture `snapshotDir` takes on the runtime side (the D2 precedent:
 * an absent key means "disabled", never a silent default location).
 *
 * Keying is per-agent (`exec.agent.id`, the same principal the kernel map
 * and the rlm run registry key on), so sessions joined to one standing mount
 * never see each other's harness. `agent/disposed` drops the in-memory cache
 * only; the FILE survives by design — "continual" means the next session of
 * the same agent id restores its entries.
 * @module dashr-tool-presentation/harness-store
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** The v1 controlled entry kinds, mirroring the harness taxonomy the blueprint names (subagent specs deferred — rlm() itself is DASHR's delegation surface). */
export const HARNESS_KINDS = ['note', 'memory', 'skill'] as const

/** One durable harness entry. */
export type HarnessKind = (typeof HARNESS_KINDS)[number]

/** The stored shape of one entry (JSON-serialized verbatim). */
export interface HarnessEntry {
  /** Stable per-agent id (`<kind>-<n>`); refine ops address entries by it. */
  id: string
  /** Controlled kind; fixed at creation (v1: update patches title/content only). */
  kind: HarnessKind
  /** Short human/model-readable label. */
  title: string
  /** The carried body text. */
  content: string
  /** ISO timestamp of creation. */
  createdAt: string
  /** ISO timestamp of the last update. */
  updatedAt: string
}

/** On-disk document shape; `format` gates restore (a future schema change refuses old files loudly). */
interface HarnessDocument {
  format: 1
  entries: HarnessEntry[]
}

/** Soft caps keeping one runaway refine() from bloating every future prompt (constants, documented in the README). */
export const HARNESS_LIMITS = {
  /** Maximum entries per agent. */
  maxEntries: 64,
  /** Maximum title length, in UTF-16 code units. */
  maxTitleChars: 200,
  /** Maximum content length, in UTF-16 code units. */
  maxContentChars: 8000,
} as const

/** One validated refine() operation (the op-schema the LLM is asked to emit). */
export type HarnessOp =
  | { op: 'add'; kind: HarnessKind; title: string; content: string }
  | { op: 'update'; id: string; title?: string; content?: string }
  | { op: 'delete'; id: string }

/** What applyOps did, mirrored back to the cell as the refine() summary. */
export interface HarnessApplyReport {
  /** Per-op outcomes in submission order. */
  applied: Array<{ op: 'add' | 'update' | 'delete'; id: string; kind?: HarnessKind; title?: string }>
  /** Entry count before the batch. */
  before: number
  /** Entry count after the batch. */
  after: number
}

/** Encode one agent id as a single path segment (ported from the runtime provider's snapshot keying: separators and traversal neutralized). */
function keyDirectoryName(agentId: string): string {
  return encodeURIComponent(agentId).replace(/^\.+/, dots => dots.replace(/\./g, '%2E'))
}

/**
 * Atomic replace, miniature: write a fresh exclusive-create (`wx`) temp
 * sibling carrying 0o600, then rename over the target. A reader therefore
 * observes either the previous or the next complete document, never a torn
 * one. No cross-process lock: within one process the per-agent write queue
 * serializes read-modify-write cycles, and two compositions sharing a
 * directory are last-writer-wins per file (documented boundary).
 */
async function writeFileAtomicMini(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${randomUUID().slice(0, 8)}.tmp`
  try {
    await writeFile(temp, content, { flag: 'wx', mode: 0o600 })
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

/** Parse a stored id into its counter, for deriving the next per-kind id. */
function idCounter(entry: HarnessEntry): number {
  const match = /^-(\d+)$/.exec(entry.id.slice(entry.kind.length))
  return match === null ? 0 : Number.parseInt(match[1]!, 10)
}

/**
 * The per-agent harness store. Sync reads (the prompt-section renderer runs
 * inside a synchronous `text` provider), lazy first-touch file load, and
 * serialized async persistence.
 */
export class HarnessStore {
  private readonly agents = new Map<string, HarnessEntry[]>()
  private readonly queues = new Map<string, Promise<unknown>>()

  /**
   * @param dir - directory root for per-agent files; `undefined` = memory-only.
   */
  constructor(private readonly dir: string | undefined = undefined) {}

  /** All entries for one agent, in insertion (id) order; loads the file on first touch. */
  list(agentId: string): HarnessEntry[] {
    return [...this.load(agentId)]
  }

  /** One entry by id, or undefined. */
  get(agentId: string, id: string): HarnessEntry | undefined {
    return this.load(agentId).find(entry => entry.id === id)
  }

  /**
   * Validate a whole op batch, then apply it and persist. All-or-nothing: a
   * batch containing any invalid op mutates nothing and throws — the refine()
   * caller converts the throw into a structured cell error with the store
   * untouched, which is the failure contract this milestone pins.
   * @returns the per-op summary plus before/after counts.
   */
  async applyOps(agentId: string, ops: HarnessOp[]): Promise<HarnessApplyReport> {
    const entries = this.load(agentId)
    const before = entries.length
    const staged = entries.map(entry => ({ ...entry }))
    const applied: HarnessApplyReport['applied'] = []
    for (const op of ops) {
      if (op.op === 'add') {
        if (staged.length >= HARNESS_LIMITS.maxEntries) {
          throw new Error(`harness is full (${HARNESS_LIMITS.maxEntries} entries); delete before adding`)
        }
        const now = new Date().toISOString()
        const counter = staged.reduce((max, entry) => Math.max(max, entry.kind === op.kind ? idCounter(entry) : 0), 0)
        const entry: HarnessEntry = {
          id: `${op.kind}-${counter + 1}`,
          kind: op.kind,
          title: op.title,
          content: op.content,
          createdAt: now,
          updatedAt: now,
        }
        staged.push(entry)
        applied.push({ op: 'add', id: entry.id, kind: entry.kind, title: entry.title })
      } else if (op.op === 'update') {
        const entry = staged.find(candidate => candidate.id === op.id)
        if (entry === undefined) throw new Error(`update: no harness entry "${op.id}"`)
        if (op.title !== undefined) entry.title = op.title
        if (op.content !== undefined) entry.content = op.content
        entry.updatedAt = new Date().toISOString()
        applied.push({ op: 'update', id: entry.id, title: entry.title })
      } else {
        const index = staged.findIndex(candidate => candidate.id === op.id)
        if (index < 0) throw new Error(`delete: no harness entry "${op.id}"`)
        staged.splice(index, 1)
        applied.push({ op: 'delete', id: op.id })
      }
    }
    this.agents.set(agentId, staged)
    await this.persist(agentId)
    return { applied, before, after: staged.length }
  }

  /** Drop one agent's in-memory cache (agent/disposed). Files persist; memory-only stores lose the data. */
  drop(agentId: string): void {
    this.agents.delete(agentId)
    this.queues.delete(agentId)
  }

  /** Load (and cache) one agent's entries; a missing or unparsable file yields empty (a corrupt file logs nothing and starts fresh — the harness is advisory prompt state, not a ledger of record). */
  private load(agentId: string): HarnessEntry[] {
    const cached = this.agents.get(agentId)
    if (cached !== undefined) return cached
    let entries: HarnessEntry[] = []
    if (this.dir !== undefined) {
      try {
        const raw = readFileSync(join(this.dir, keyDirectoryName(agentId), 'harness.json'), 'utf8')
        const parsed = JSON.parse(raw) as HarnessDocument
        if (parsed?.format === 1 && Array.isArray(parsed.entries)) {
          entries = parsed.entries.filter(entry => HARNESS_KINDS.includes(entry?.kind as HarnessKind))
        }
      } catch {
        // Absent file (the common case) or unreadable content: start empty.
      }
    }
    this.agents.set(agentId, entries)
    return entries
  }

  /** Serialize one agent's persistence behind the previous one (read-modify-write cycles never interleave in-process). */
  private persist(agentId: string): Promise<void> {
    const run = async (): Promise<void> => {
      if (this.dir === undefined) return
      const entries = this.agents.get(agentId) ?? []
      const document: HarnessDocument = { format: 1, entries }
      await writeFileAtomicMini(
        join(this.dir, keyDirectoryName(agentId), 'harness.json'),
        `${JSON.stringify(document, null, 2)}\n`,
      )
    }
    const previous = this.queues.get(agentId) ?? Promise.resolve()
    const next = previous.then(run, run)
    this.queues.set(agentId, next)
    return next
  }
}

/**
 * Render the `dasher:harness` section text for one agent's entries. Empty
 * input renders the empty string — `renderPrompt` drops empty sections, so an
 * empty harness contributes nothing (chosen over skipping registration: the
 * section is a standing capability, and absence-of-section vs empty-section
 * is indistinguishable to the model either way).
 *
 * Entry text is foreign to the prompt-variable machinery: a literal `{{name}}`
 * inside a memory would otherwise throw at every assembly (unknown prompt
 * variable) or silently interpolate a registered one. Braces are split with a
 * space at render time — visible, rare, and assembly-proof.
 * @param entries - the agent's current entries.
 * @returns the section body, or '' when there is nothing to carry.
 */
export function renderHarnessSection(entries: readonly HarnessEntry[]): string {
  if (entries.length === 0) return ''
  const neutralize = (text: string): string => text.replaceAll('{{', '{ {')
  const lines: string[] = [
    'Durable agent state (the Continual Harness). These entries were refined by this agent and carry into every session. Edit them only through refine() from a cell.',
    '',
  ]
  for (const entry of entries) {
    lines.push(`[${entry.id}] ${entry.kind} — ${neutralize(entry.title)}`)
    for (const line of neutralize(entry.content).split('\n')) lines.push(`  ${line}`)
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}
