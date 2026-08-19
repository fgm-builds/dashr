/**
 * `DashrRuntime`: DASHR's STATEFUL `ctx.rlmRuntime` backend (our vendored
 * Service Definition, blueprint v0.5 §7.6), the standing-mount layer of the
 * v0.1.5 architecture — between the profile-level DashrDaemon concept (a v0.1.5
 * empty shell: named, not yet built) and the session-level ipykernel
 * subprocess (a pure Python interpreter with no harness awareness). One
 * instance per standing mount owns a map of one persistent kernel subprocess
 * per SESSION (the run's `principal`) — the upstream "plugins key their
 * state by Session/Agent" model, which the roster's per-mount realm cannot
 * provide on its own (blueprint §7.4.1: an entry-local realm is one instance
 * per MOUNT, and every session joined to a standing mount shares it) — which
 * makes DashrRuntime the DE FACTO daemon today: it listens for `agent/disposed`,
 * keys kernels per session, snapshots them, and dispatches loopback host
 * requests. Each `run()` is exactly one cell on that session's kernel;
 * variables assigned in run N survive into run N+1 (blueprint §1.1 channel ②
 * — state codification, deliberately NOT the per-run isolation the
 * worker-thread backend provides), and two sessions never see each other's
 * variables. Kernels spawn lazily on a key's first run and die with their
 * session (the dsh `agent/disposed` event) or with the plugin. Binding
 * namespaces are materialized kernel-side as callable Python objects whose
 * calls travel back to the host over the `dashr.host` comm target (the PA
 * `host_request()` pattern). This is a capability seam, not a security
 * boundary.
 *
 * M3-B adds the namespace persistence half: turn-end snapshots (size-capped,
 * blueprint §8.3), restore-on-first-boot, and the death→revive chain (§8.3
 * "kernel death 行为链") that respawns onto the nearest replayable snapshot
 * instead of M3-A's fresh-empty respawn.
 * @module dsh-rlm-mode/runtime
 */

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { snapshotJsonValue } from './snapshot-json.ts'
import {
  DUNDER_MEMBER,
  PORTABLE_RESERVED_WORDS,
  RESERVED_BINDING_GLOBALS,
  RESERVED_ERROR_MEMBERS,
  RLMRuntime,
} from './vendored/rlm-runtime.ts'
import type {
  CodeBindingNamespace,
  CodeJsonValue,
  CodeRunFailure,
  CodeRunRequest,
  CodeRunResult,
} from './vendored/rlm-runtime.ts'
import { IpyKernelBridge } from './kernel.ts'
import type { CellOutcome, HostRequestOutcome, SnapshotSpec } from './kernel.ts'
import { buildRunCell } from './python.ts'
import type { NamespaceSpecs } from './python.ts'
import { MIN_OUTPUT_BYTES, extractStream, finalizeOutput, plainTraceback } from './output.ts'

/** Plugin config: every tunable, changeable from `cordis.yml` (no hardcoded tunables). */
export interface Config {
  /** Python interpreter with `ipykernel` installed. */
  python?: string
  /** Budget for kernel spawn → ready, in milliseconds. */
  startupTimeoutMs?: number
  /** Wall budget per run; expiry interrupts the kernel then force-settles. */
  runTimeoutMs?: number
  /** Grace between a timeout/abort interrupt and the force-settle, in milliseconds. */
  interruptGraceMs?: number
  /**
   * Confirm window between the control-channel interrupt and the SIGALRM
   * escalation, in milliseconds; must stay below {@link Config.interruptGraceMs}.
   * See the bridge's two-phase interrupt for why the escalation is deferred.
   */
  interruptConfirmMs?: number
  /** Budget for graceful kernel teardown (shutdown_request → SIGKILL), in milliseconds. */
  disposeTimeoutMs?: number
  /** Budget for internal snapshot/restore cells (dill dump/load), in milliseconds. */
  snapshotTimeoutMs?: number
  /** Hard cap for serialized log-array, completion-value, and failure-message payloads. */
  maxOutputBytes?: number
  /** Directory for per-session namespace snapshots (`state.dill` + `manifest.json`); none when absent. */
  snapshotDir?: string
  /** Serialized-size cap for a turn-end snapshot, in bytes; over-cap snapshots are skipped with a one-time model warning. */
  snapshotSizeCapBytes?: number
  /** Jupyter username stamped on wire messages. */
  username?: string
}

/** {@link Config} after schemastery fills the defaults. */
type ResolvedConfig = Required<Omit<Config, 'snapshotDir'>> & Pick<Config, 'snapshotDir'>

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Names the kernel-side shim owns (`_dashr`/`__dashr` prefixed, any case —
 * bootstrap helpers plus the per-run `__dashr_completion__` and
 * `__dashr_injected__`), refused as binding globals on top of the seam's
 * shared set.
 */
const KERNEL_OWNED_NAME = /^_+dashr/i

/** Manifest format version; a snapshot written under a different version is not replayable. */
const SNAPSHOT_FORMAT = 1

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Key under which the per-session kernel map stores agentless runs. */
const AGENTLESS_KEY = '(agentless)'

/**
 * Encode one principal as a single path segment for its per-key snapshot
 * subdirectory: `encodeURIComponent` neutralizes separators and traversal,
 * and a leading run of dots (which would encode to itself, addressing `.` or
 * `..`) is re-escaped so every key lands strictly inside `snapshotDir`.
 */
function keyDirectoryName(principal: string): string {
  return encodeURIComponent(principal).replace(/^\.+/, dots => dots.replace(/\./g, '%2E'))
}

/** One session's kernel plus the bookkeeping its lifecycle needs. */
interface KeyedKernel {
  /** The map key (the run principal, or {@link AGENTLESS_KEY}). */
  key: string
  /** The kernel's working directory (the session's workspace), fixed at first spawn. */
  cwd?: string
  /** The subprocess bridge; replaced, never restarted, once dead. */
  bridge: IpyKernelBridge
  /**
   * Whether any cell has completed on this kernel — i.e. whether it may hold
   * user state a consumer could mistakenly assume still exists. Gates the
   * explicit namespace-lost error on respawn.
   */
  ranCells: boolean
  /** How many cells completed on this kernel — the snapshot "turn" counter. */
  turn: number
  /** Turn number of the last successfully written snapshot, when one exists. */
  lastSnapshotTurn?: number
  /** Whether the one-time snapshot-size-cap warning has been delivered to the model. */
  warnedSnapshotSkip?: boolean
  /** Whether restore-from-snapshot has been attempted for this entry (once per boot). */
  restoreAttempted?: boolean
  /** One-run notice (restore/degrade outcome) to surface on the next completed run. */
  pendingNotice?: string
}

/** What `restoreEntry` found and did, for the first-run notice and revive messaging. */
type RestoreOutcome =
  | { kind: 'none' }
  | { kind: 'restored', turn: number }
  | { kind: 'degraded', reason: string }

/** Manifest fields the host reads before dispatching the restore cell. */
interface SnapshotManifest {
  snapshotFormat?: unknown
  skipped?: unknown
  turn?: unknown
}

/**
 * The {@link RLMRuntime} backend this package registers (`ctx.rlmRuntime`)
 * — the standing-mount layer of the v0.1.5 architecture, the de facto daemon
 * while the profile-level DashrDaemon stays an empty shell. One service
 * instance per mount holds one lazily-spawned kernel per session principal;
 * each kernel's lifecycle — snapshot and shutdown on session end, snapshot
 * and shutdown of every key on plugin disposal — is effect-owned.
 */
export class DashrRuntime extends RLMRuntime {
  static Config: z<Config> = z.object({
    python: z.string().default('python3'),
    startupTimeoutMs: z.number().default(30_000),
    runTimeoutMs: z.number().default(120_000),
    interruptGraceMs: z.number().default(2_000),
    interruptConfirmMs: z.number().default(250),
    disposeTimeoutMs: z.number().default(5_000),
    snapshotTimeoutMs: z.number().default(30_000),
    maxOutputBytes: z.number().default(67_108_864),
    snapshotDir: z.string(),
    snapshotSizeCapBytes: z.number().default(268_435_456),
    username: z.string().default('dashr'),
  })

  readonly language = 'python'
  readonly isolation = 'process'

  private readonly config: ResolvedConfig
  private readonly logger: ReturnType<Context['logger']>
  /** One entry per session principal that has run code (lazy — never pre-seeded). */
  private readonly kernels = new Map<string, KeyedKernel>()
  private disposed = false

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = config as ResolvedConfig
    // Schemastery filled the defaults; the cast records that. Positivity is a
    // semantic check the schema's plain number type does not carry.
    for (const key of ['startupTimeoutMs', 'runTimeoutMs', 'interruptGraceMs', 'disposeTimeoutMs', 'snapshotTimeoutMs'] as const) {
      const value = this.config[key]
      if (!(Number.isFinite(value) && value > 0)) {
        throw new Error(`dsh-rlm-mode: config.${key} must be a positive number, got ${String(value)}`)
      }
    }
    // The SIGALRM escalation must fire strictly inside the force-settle grace,
    // or it would never get its chance to break a busy cell before the run
    // resolves.
    if (!(this.config.interruptConfirmMs > 0 && this.config.interruptConfirmMs < this.config.interruptGraceMs)) {
      throw new Error(`dsh-rlm-mode: config.interruptConfirmMs must be positive and below interruptGraceMs (${this.config.interruptGraceMs}), got ${String(this.config.interruptConfirmMs)}`)
    }
    if (!Number.isSafeInteger(this.config.maxOutputBytes) || this.config.maxOutputBytes < MIN_OUTPUT_BYTES) {
      throw new Error(`dsh-rlm-mode: config.maxOutputBytes must be a safe integer of at least ${MIN_OUTPUT_BYTES}, got ${String(this.config.maxOutputBytes)}`)
    }
    if (!Number.isSafeInteger(this.config.snapshotSizeCapBytes) || this.config.snapshotSizeCapBytes < 1) {
      throw new Error(`dsh-rlm-mode: config.snapshotSizeCapBytes must be a positive safe integer, got ${String(this.config.snapshotSizeCapBytes)}`)
    }
    this.logger = ctx.logger('dsh-rlm-mode')
    ctx.effect(() => () => this.teardown(), 'ipython code-runtime teardown')

    // Session-end teardown, keyed: dsh's agent registry emits `agent/disposed`
    // (payload `{ agent }`, the agent's `id` being the session id our runs
    // carry as `principal`) once an agent's driver has quiesced and its own
    // scope unwound — the moment its kernel has no future caller. Listened
    // through the UNTYPED event service on purpose: this package keeps zero
    // dsh runtime dependencies (blueprint §7.6), and the typed `Events`
    // augmentation lives in `@deepseek-ai/dsh-agent`. Scope filtering still
    // applies — the listener rides this plugin's context, so under a preset
    // mount it receives exactly the agents composed under that mount (the
    // agent's scope key chains to the mount's) and a bare mount hears every
    // agent. Both are safe: destroyKey is a no-op for keys that never ran
    // code through THIS instance.
    ctx.events.on('agent/disposed', (payload: unknown) => {
      const principal = (payload as { agent?: { id?: unknown } } | null)?.agent?.id
      if (typeof principal === 'string' && principal.length > 0) {
        void this.destroyKey(principal).catch(() => undefined)
      }
    })
  }

  /**
   * The agentless-default kernel's pid, for lifecycle diagnostics; absent
   * before the first agentless run. Per-session pids: {@link kernelPids}.
   */
  get kernelPid(): number | undefined {
    return this.kernels.get(AGENTLESS_KEY)?.bridge.pid
  }

  /** Every live kernel subprocess pid, one per session that has run code. */
  get kernelPids(): number[] {
    return [...this.kernels.values()].map(entry => entry.bridge.pid).filter((pid): pid is number => pid !== undefined)
  }

  /**
   * Execute one program as one cell on the persistent kernel. Program
   * outcomes — including kernel startup failure — resolve with
   * `result.error`; the method rejects only for Service Definition contract
   * misuse (a disposed runtime, an invalid binding namespace).
   * @param request - the program, its bindings, and the abort signal.
   * @returns the run's outcome per the seam contract.
   */
  async run(request: CodeRunRequest): Promise<CodeRunResult> {
    if (this.disposed) throw new Error('dsh-rlm-mode: run() after disposal')
    const bindings = this.validateBindings(request)
    if (request.signal?.aborted) {
      return { logs: [], error: { kind: 'abort', message: String(request.signal.reason) } }
    }
    const key = request.principal && request.principal.length > 0 ? request.principal : AGENTLESS_KEY

    // A kernel that died since this key's last run is never silently reused:
    // its namespace is gone, and executing the program would surface a
    // misleading NameError instead of the substrate truth. The first run to
    // observe the death resolves with the explicit error (M3-B: after
    // respawning onto the nearest replayable snapshot, so the message can
    // name the turn) and the NEXT run continues on that restored kernel.
    // A kernel that died before ever completing a cell carried no user state
    // and is simply replaced (a prior SESSION's on-disk snapshot, if any, is
    // still restored by the normal first-boot path below).
    const dead = this.kernels.get(key)
    if (dead?.bridge.isDead) {
      this.kernels.delete(key)
      if (dead.ranCells) {
        return await this.reviveAfterDeath(key, dead)
      }
    }

    let entry: KeyedKernel
    try {
      entry = await this.ensureKernel(key, request.cwd)
    } catch (error: unknown) {
      return finalizeOutput([], undefined, { kind: 'worker-exit', message: `kernel failed to start: ${messageOf(error)}` }, this.config.maxOutputBytes)
    }
    // First boot of this entry (fresh session OR resume OR revive): restore
    // the on-disk snapshot before any user code, once per boot. The notice is
    // consumed by the next COMPLETED run's logs, so the model learns where its
    // namespace came from (turn-N restored, or degraded-empty).
    if (!entry.restoreAttempted) {
      entry.restoreAttempted = true
      const restore = await this.restoreEntry(entry)
      if (restore.kind === 'restored') {
        entry.pendingNotice = `namespace restored from the turn-${restore.turn} snapshot`
      } else if (restore.kind === 'degraded') {
        entry.pendingNotice = `snapshot not replayable (${restore.reason}); started from an EMPTY namespace — re-create any state you need`
      }
    }
    const kernel = entry.bridge

    const specs: NamespaceSpecs = Object.fromEntries([...bindings.entries()].map(([global, namespace]) => [global, {
      functions: Object.keys(namespace.functions),
      ...namespace.callable ? { callable: true as const } : {},
      ...namespace.errorClass ? { errorClass: namespace.errorClass } : {},
    }]))
    const sentinel = `__dashr_${randomBytes(9).toString('hex')}__`
    const cell = buildRunCell(request.program, JSON.stringify(specs), sentinel)
    const outcome = await kernel.executeCell(cell, {
      timeoutMs: this.config.runTimeoutMs,
      interruptGraceMs: this.config.interruptGraceMs,
      interruptConfirmMs: this.config.interruptConfirmMs,
      ...request.signal ? { signal: request.signal } : {},
      hostRequestHandler: data => this.dispatchHostRequest(data, bindings),
    })

    if (outcome.outcome === 'completed') {
      entry.ranCells = true
      entry.turn += 1
    } else if (outcome.outcome === 'forced' && outcome.failure.kind === 'worker-exit' && kernel.isDead && !this.disposed) {
      // The substrate died under this run. M3-B unifies this path with the
      // post-death-arrival branch: a kernel that had completed cells revives
      // onto its nearest snapshot and this run reports the turn-N loss; a
      // first-cell death has no state to lose and the run's own worker-exit
      // failure is the whole story.
      if (this.kernels.get(key) === entry) this.kernels.delete(key)
      if (entry.ranCells) {
        return await this.reviveAfterDeath(key, entry)
      }
    }
    let result = this.assembleResult(outcome, sentinel)

    if (outcome.outcome === 'completed') {
      // Turn-end snapshot (M3-B, blueprint §8.3): after every successful run,
      // size-capped. The cap warning is delivered ONCE per kernel to the
      // model through the run's own logs; the first-run restore notice rides
      // the same channel. Both are re-finalized so the outer-output cap stays
      // honest even with the notices appended.
      const snapshot = await this.snapshotTurnEnd(entry)
      const notices: string[] = []
      if (snapshot.skipped && !entry.warnedSnapshotSkip) {
        entry.warnedSnapshotSkip = true
        const detail = snapshot.estimateBytes !== undefined
          ? `estimated ${snapshot.estimateBytes} bytes`
          : `${snapshot.sizeBytes ?? 'unknown'} bytes serialized`
        notices.push(`[dashr] namespace snapshot skipped: ${detail} exceeds snapshotSizeCapBytes (${this.config.snapshotSizeCapBytes}) — later turn-end snapshots are skipped while the namespace stays this large`)
      }
      if (entry.pendingNotice) {
        notices.push(`[dashr] ${entry.pendingNotice}`)
        entry.pendingNotice = undefined
      }
      if (notices.length > 0) {
        result = finalizeOutput([...result.logs, ...notices], result.value, result.error, this.config.maxOutputBytes)
      }
    }
    return result
  }

  /** Map one cell outcome onto the seam's result shape under the output ledger. */
  private assembleResult(outcome: CellOutcome, sentinel: string): CodeRunResult {
    const capture = extractStream(outcome.streamText, sentinel)
    const maxBytes = this.config.maxOutputBytes

    if (outcome.outcome === 'forced') {
      return finalizeOutput(capture.logs, undefined, outcome.failure, maxBytes)
    }
    if (outcome.status === 'error') {
      const failure: CodeRunFailure = outcome.cellError
        ? { kind: 'exception', message: plainTraceback(outcome.cellError.ename, outcome.cellError.evalue, outcome.cellError.traceback) }
        : { kind: 'exception', message: 'the program failed without a traceback' }
      return finalizeOutput(capture.logs, undefined, failure, maxBytes)
    }

    // Completed without error: recover the completion envelope printed under
    // the sentinel.
    if (capture.envelope === undefined) {
      return finalizeOutput(capture.logs, undefined, undefined, maxBytes)
    }
    let envelope: unknown
    try {
      envelope = JSON.parse(capture.envelope)
    } catch {
      return finalizeOutput(capture.logs, undefined, { kind: 'invalid-output', message: 'completion envelope was not valid JSON' }, maxBytes)
    }
    if (typeof envelope !== 'object' || envelope === null || (envelope as { ok?: unknown }).ok !== true) {
      return finalizeOutput(capture.logs, undefined, { kind: 'invalid-output', message: 'program completion must be lossless JSON' }, maxBytes)
    }
    const json = (envelope as { json?: unknown }).json
    if (typeof json !== 'string') {
      // A value-less completion (no top-level `return` executed) leaves the
      // value absent rather than substituting a null.
      return finalizeOutput(capture.logs, undefined, undefined, maxBytes)
    }
    // An explicit `return None` crosses the JSON boundary as null — a real
    // completion value, matching the worker-thread backend's treatment.
    return finalizeOutput(capture.logs, JSON.parse(json) as CodeJsonValue, undefined, maxBytes)
  }

  /** Reject malformed binding globals or typed-error declarations as contract misuse. */
  private validateBindings(request: CodeRunRequest): Map<string, CodeBindingNamespace> {
    const bindings = new Map<string, CodeBindingNamespace>()
    for (const namespace of request.bindings) {
      if (!IDENTIFIER.test(namespace.global) || PORTABLE_RESERVED_WORDS.has(namespace.global)) {
        throw new Error(`dsh-rlm-mode: binding global ${JSON.stringify(namespace.global)} is not a usable identifier`)
      }
      if (RESERVED_BINDING_GLOBALS.has(namespace.global) || KERNEL_OWNED_NAME.test(namespace.global)) {
        throw new Error(`dsh-rlm-mode: reserved binding global ${JSON.stringify(namespace.global)}`)
      }
      if (bindings.has(namespace.global)) {
        throw new Error(`dsh-rlm-mode: duplicate binding global ${JSON.stringify(namespace.global)}`)
      }
      // A bare callable global dispatches exactly one host function; any other
      // count is a contract error (the kernel installer has no member to pick).
      if (namespace.callable === true && Object.keys(namespace.functions).length !== 1) {
        throw new Error(`dsh-rlm-mode: callable binding global ${JSON.stringify(namespace.global)} must declare exactly one function`)
      }
      bindings.set(namespace.global, namespace)
    }

    // The flat per-tool binding shape (v0.1.5) declares the SAME error class on
    // every tool namespace: one shared ToolCallError must catch failures from
    // all of them. An identical (name + member) re-declaration is therefore
    // legal and materializes once kernel-side; a same-name/different-member
    // clash stays a contract error.
    const errorClasses = new Map<string, string>()
    for (const namespace of request.bindings) {
      const descriptor = namespace.errorClass
      if (!descriptor) continue
      if (!IDENTIFIER.test(descriptor.name) || PORTABLE_RESERVED_WORDS.has(descriptor.name)) {
        throw new Error(`dsh-rlm-mode: binding error class ${JSON.stringify(descriptor.name)} is not a usable identifier`)
      }
      if (RESERVED_BINDING_GLOBALS.has(descriptor.name) || KERNEL_OWNED_NAME.test(descriptor.name)) {
        throw new Error(`dsh-rlm-mode: reserved binding global ${JSON.stringify(descriptor.name)}`)
      }
      if (bindings.has(descriptor.name)) {
        throw new Error(`dsh-rlm-mode: duplicate injected global ${JSON.stringify(descriptor.name)}`)
      }
      const member = descriptor.memberNameProperty
      if (member.length === 0 || RESERVED_ERROR_MEMBERS.has(member) || DUNDER_MEMBER.test(member)) {
        throw new Error(`dsh-rlm-mode: binding error member property ${JSON.stringify(descriptor.memberNameProperty)} is not usable`)
      }
      const declared = errorClasses.get(descriptor.name)
      if (declared !== undefined && declared !== member) {
        throw new Error(`dsh-rlm-mode: error class ${JSON.stringify(descriptor.name)} declared with conflicting member properties ${JSON.stringify(declared)} and ${JSON.stringify(member)}`)
      }
      errorClasses.set(descriptor.name, member)
    }
    return bindings
  }

  /** Dispatch one kernel-side host request; unknown types and bad payloads become error replies. */
  private async dispatchHostRequest(data: Record<string, unknown>, bindings: Map<string, CodeBindingNamespace>): Promise<HostRequestOutcome> {
    if (data.type !== 'binding.call' || typeof data.global !== 'string' || typeof data.name !== 'string') {
      return { ok: false, message: 'host request must be a binding.call with global and name' }
    }
    // Own-property lookup only: a forged name like 'constructor' must not
    // walk the record's prototype chain.
    const record = bindings.get(data.global)?.functions
    const fn = record && Object.hasOwn(record, data.name) ? record[data.name] : undefined
    if (typeof fn !== 'function') {
      return { ok: false, message: `unknown binding ${JSON.stringify(`${data.global}.${data.name}`)}` }
    }
    const args = snapshotJsonValue(data.args)
    if (args === undefined) {
      return { ok: false, message: 'binding arguments must be lossless JSON' }
    }
    let resolved: unknown
    try {
      resolved = await fn(args)
    } catch (error: unknown) {
      return { ok: false, message: messageOf(error) }
    }
    const value = snapshotJsonValue(resolved)
    if (value === undefined) {
      return { ok: false, message: 'binding resolution must be lossless JSON' }
    }
    return { ok: true, result: value }
  }

  /**
   * Spawn-or-reuse the kernel for one key. The lazy map guarantees one
   * entry is created here and nowhere else, so a key that never runs never
   * holds a subprocess — the subagent fan-out guarantee (blueprint §6:
   * rlm() ×N spawns nothing until a child actually executes code).
   * @param key - the run principal (or the agentless default).
   */
  private async ensureKernel(key: string, cwd?: string): Promise<KeyedKernel> {
    let entry = this.kernels.get(key)
    if (!entry) {
      // A session header cwd is a validated absolute path, but a workspace can
      // be deleted before the kernel first spawns (e.g. a resumed session over
      // a removed directory). Spawning with a missing cwd is a hard ENOENT, so
      // degrade to spawn-time inherit rather than fail the whole kernel.
      const kernelCwd = cwd && existsSync(cwd) ? cwd : undefined
      entry = {
        key,
        cwd: kernelCwd,
        bridge: new IpyKernelBridge({
          python: this.config.python,
          ...kernelCwd ? { cwd: kernelCwd } : {},
          startupTimeoutMs: this.config.startupTimeoutMs,
          disposeTimeoutMs: this.config.disposeTimeoutMs,
          interruptConfirmMs: this.config.interruptConfirmMs,
          snapshotTimeoutMs: this.config.snapshotTimeoutMs,
          username: this.config.username,
        }),
        ranCells: false,
        turn: 0,
      }
      this.kernels.set(key, entry)
    }
    await entry.bridge.start()
    return entry
  }

  /**
   * Restore a key's on-disk snapshot into a freshly booted kernel, when one
   * exists and its manifest is plausible. Called once per entry boot. The
   * kernel-side restore cell performs the authoritative environment checks
   * (python version, interpreter identity, skills); this method only gates on
   * the manifest the host can read cheaply, then records the turn so the
   * first-run notice and the revive chain can name it.
   */
  private async restoreEntry(entry: KeyedKernel): Promise<RestoreOutcome> {
    if (!this.config.snapshotDir) return { kind: 'none' }
    const dir = join(this.config.snapshotDir, keyDirectoryName(entry.key))
    const payloadPath = join(dir, 'state.dill')
    const manifestPath = join(dir, 'manifest.json')
    const manifest = this.readSnapshotManifest(entry.key)
    if (manifest === undefined) return { kind: 'none' }
    if (manifest.snapshotFormat !== SNAPSHOT_FORMAT) {
      return { kind: 'degraded', reason: `snapshot format ${String(manifest.snapshotFormat)} is not replayable` }
    }
    if (manifest.skipped === true) return { kind: 'none' }
    if (!existsSync(payloadPath)) return { kind: 'degraded', reason: 'snapshot payload is missing' }
    const restored = await entry.bridge.restoreState(payloadPath, manifestPath)
    if (restored.kind === 'restored') {
      entry.turn = typeof manifest.turn === 'number' && Number.isSafeInteger(manifest.turn) && manifest.turn >= 0 ? manifest.turn : 0
      entry.lastSnapshotTurn = entry.turn
      entry.ranCells = true
      return { kind: 'restored', turn: entry.turn }
    }
    return { kind: 'degraded', reason: restored.reason }
  }

  /** Read the per-key manifest's host-relevant fields; absent when unreadable/missing. */
  private readSnapshotManifest(key: string): SnapshotManifest | undefined {
    if (!this.config.snapshotDir) return undefined
    try {
      const manifest = JSON.parse(readFileSync(join(this.config.snapshotDir, keyDirectoryName(key), 'manifest.json'), 'utf8')) as SnapshotManifest
      return manifest
    } catch {
      return undefined
    }
  }

  /**
   * Revive one session's kernel after death: respawn a fresh kernel, restore
   * the nearest replayable snapshot onto it (the normal restore path), and
   * return the death-observing run's explicit error naming the turn. When no
   * replayable snapshot exists the message falls back to M3-A's fresh-empty
   * contract. The run itself does NOT execute — an error that lies about a
   * NameError costs the model more than one dropped cell (blueprint §8.3).
   * @param key - the run principal.
   * @param dead - the entry that died (its `turn` is the last completed turn).
   */
  private async reviveAfterDeath(key: string, dead: KeyedKernel): Promise<CodeRunResult> {
    let entry: KeyedKernel
    try {
      entry = await this.ensureKernel(key, dead.cwd)
    } catch (error: unknown) {
      return finalizeOutput([], undefined, {
        kind: 'worker-exit',
        message: `kernel died and respawn failed (${messageOf(error)}); the next run will retry a fresh kernel`,
      }, this.config.maxOutputBytes)
    }
    entry.restoreAttempted = true
    const restore = await this.restoreEntry(entry)
    const observingTurn = dead.turn + 1
    if (restore.kind === 'restored') {
      const lost = observingTurn - restore.turn
      const rounds = lost === 1 ? 'round' : 'rounds'
      return finalizeOutput([], undefined, {
        kind: 'worker-exit',
        message: `the kernel for this session died; its namespace was restored from the turn-${restore.turn} snapshot — the last ${lost} ${rounds} of variable operations must be replayed. This run did not execute.`,
      }, this.config.maxOutputBytes)
    }
    const detail = restore.kind === 'degraded' ? ` (${restore.reason})` : ''
    return finalizeOutput([], undefined, {
      kind: 'worker-exit',
      message: `the kernel for this session died and no replayable snapshot was available${detail}; the next run starts a fresh kernel with an EMPTY namespace — re-create any state you still need. This run did not execute.`,
    }, this.config.maxOutputBytes)
  }

  /**
   * Write one key's turn-end snapshot, when a snapshot directory is
   * configured. A size-cap skip is reported (so the run can warn the model
   * once); other failures log without disturbing the run.
   */
  private async snapshotTurnEnd(entry: KeyedKernel): Promise<{ skipped: boolean, estimateBytes?: number, sizeBytes?: number }> {
    if (!this.config.snapshotDir) return { skipped: false }
    const kernel = entry.bridge
    if (!kernel.isRunning) return { skipped: false }
    const dir = join(this.config.snapshotDir, keyDirectoryName(entry.key))
    mkdirSync(dir, { recursive: true })
    const spec: SnapshotSpec = { turn: entry.turn, skills: [], sizeCapBytes: this.config.snapshotSizeCapBytes }
    const outcome = await kernel.snapshotState(join(dir, 'state.dill'), join(dir, 'manifest.json'), spec)
    if (outcome.kind === 'ok') {
      entry.lastSnapshotTurn = entry.turn
      return { skipped: false }
    }
    if (outcome.kind === 'skipped') {
      return { skipped: true, ...outcome.estimateBytes !== undefined ? { estimateBytes: outcome.estimateBytes } : {}, ...outcome.sizeBytes !== undefined ? { sizeBytes: outcome.sizeBytes } : {} }
    }
    this.logger.warn(`turn-end snapshot for ${JSON.stringify(entry.key)} failed: ${outcome.reason}`)
    return { skipped: false }
  }

  /**
   * Dispose to quiescence: snapshot every live key's namespace when a
   * snapshot directory is configured (each under its own per-key
   * subdirectory), then shut the subprocesses down. Registered as the
   * plugin's `ctx.effect` disposer.
   */
  private async teardown(): Promise<void> {
    this.disposed = true
    const entries = [...this.kernels.values()]
    this.kernels.clear()
    await Promise.all(entries.map(entry => this.teardownKernel(entry)))
  }

  /**
   * Tear one session's kernel down (session end via the `agent/disposed`
   * listener). A no-op for keys that never ran code through this instance —
   * which is what makes hearing every agent's disposal safe.
   */
  private async destroyKey(key: string): Promise<void> {
    const entry = this.kernels.get(key)
    if (!entry) return
    this.kernels.delete(key)
    await this.teardownKernel(entry)
  }

  /** Snapshot (when configured) then dispose one key's kernel; failures log, never throw into a listener. */
  private async teardownKernel(entry: KeyedKernel): Promise<void> {
    const kernel = entry.bridge
    if (this.config.snapshotDir && kernel.isRunning) {
      try {
        // Per-key subdirectory: sessions sharing one snapshotDir must not
        // overwrite each other's state.dill.
        const dir = join(this.config.snapshotDir, keyDirectoryName(entry.key))
        mkdirSync(dir, { recursive: true })
        const spec: SnapshotSpec = { turn: entry.turn, skills: [], sizeCapBytes: this.config.snapshotSizeCapBytes }
        const saved = await kernel.snapshotState(join(dir, 'state.dill'), join(dir, 'manifest.json'), spec)
        if (saved.kind !== 'ok' && saved.kind !== 'skipped') {
          this.logger.warn(`kernel namespace snapshot for ${JSON.stringify(entry.key)} failed: ${saved.reason}`)
        }
      } catch (error: unknown) {
        this.logger.warn(`kernel namespace snapshot for ${JSON.stringify(entry.key)} failed: ${messageOf(error)}`)
      }
    }
    await kernel.dispose()
  }
}

export default DashrRuntime

/**
 * The vendored Service Definition's public contract, re-exported from the
 * package root so consumers (the sibling presentation package, its drift
 * tests, any future backend) can depend on the PUBLISHED shape instead of
 * reaching into `./src/*` (which the published tarball does not carry).
 */
export { RLMRuntime } from './vendored/rlm-runtime.ts'
export type {
  CodeBindingErrorClass,
  CodeBindingFunction,
  CodeBindingNamespace,
  CodeJsonValue,
  CodeRunFailure,
  CodeRunRequest,
  CodeRunResult,
} from './vendored/rlm-runtime.ts'
