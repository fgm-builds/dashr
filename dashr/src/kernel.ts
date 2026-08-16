/**
 * Minimal IPython kernel bridge: spawns `python -m ipykernel_launcher`, speaks
 * the Jupyter wire protocol over ZeroMQ (shell/iopub/control), serializes cell
 * execution, and bridges kernel-side host requests (binding calls) over comms.
 * Ported from PA's `KernelManager` (prime-agent/packages/coding-agent/src/core/kernel/index.ts)
 * down to the subset DASHR needs; see README for the build-vs-reuse decision.
 *
 * Lifecycle is owned by the caller (the Cordis plugin registers it as a
 * `ctx.effect`); this class installs no process-level signal handlers, unlike
 * its PA ancestor.
 * @module dashr/kernel
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Dealer, Subscriber } from 'zeromq'
import { HOST_COMM_TARGET, KERNEL_BOOTSTRAP } from './bootstrap.ts'
import { buildRestoreCell, buildSnapshotCell } from './python.ts'
import type { SnapshotSpec } from './python.ts'
import { extractStream } from './output.ts'

/** Constructor options; every deployment-varying value arrives validated. */
export interface KernelBridgeOptions {
  /** Absolute or PATH-resolved python interpreter with `ipykernel` installed. */
  python: string
  /** Working directory for the kernel subprocess. */
  cwd?: string
  /** Budget for spawn → kernel_info reply, in milliseconds. */
  startupTimeoutMs: number
  /** Budget for graceful dispose (shutdown_request → SIGTERM → SIGKILL), in milliseconds. */
  disposeTimeoutMs: number
  /**
   * Confirm window between the control-channel interrupt and the SIGALRM
   * escalation, in milliseconds; must stay below every execute's grace.
   */
  interruptConfirmMs: number
  /** Budget for internal snapshot/restore cells (dill dump/load), in milliseconds. */
  snapshotTimeoutMs: number
  /** Jupyter username stamped on every message. */
  username: string
}

/** Host-supplied inputs a snapshot cell records beside the dill payload. */
export type { SnapshotSpec }

/** One snapshot attempt's terminal outcome, parsed from the cell envelope. */
export type SnapshotOutcome =
  | { kind: 'ok', sizeBytes: number, names: number }
  | { kind: 'skipped', reason: string, estimateBytes?: number, sizeBytes?: number, capBytes: number }
  | { kind: 'failed', reason: string }

/** One restore attempt's terminal outcome, parsed from the cell envelope. */
export type RestoreStateOutcome =
  | { kind: 'restored', count: number }
  | { kind: 'degraded', reason: string }


/** One host-request resolution: ok carries the reply payload, not-ok a message. */
export type HostRequestOutcome = { ok: true, result: unknown } | { ok: false, message: string }

/** Dispatches one typed request from kernel-side code. */
export type HostRequestHandler = (data: Record<string, unknown>) => Promise<HostRequestOutcome>

export interface ExecuteCellOptions {
  /** Wall budget for the cell; interrupts then force-settles on expiry. */
  timeoutMs: number
  /** Grace between interrupt and force-settle, in milliseconds. */
  interruptGraceMs: number
  /**
   * Confirm window between the control-channel interrupt and the SIGALRM
   * escalation, in milliseconds; must stay below {@link interruptGraceMs}.
   * The zmq interrupt alone settles any cell that yields to the kernel event
   * loop, so SIGALRM — the channel that can terminate an idle kernel (see
   * {@link IpyKernelBridge.interrupt | interrupt}) — is only sent when the
   * cell provably ignored phase one. The kernel-side busy guard makes a
   * signal that still sneaks onto an idle kernel harmless.
   */
  interruptConfirmMs: number
  /** Aborting interrupts the kernel and settles the cell as aborted. */
  signal?: AbortSignal
  /** Host-request dispatcher active while this cell executes. */
  hostRequestHandler?: HostRequestHandler
}

/** A cell's terminal outcome; substrate-level failures arrive as `forced`. */
export type CellOutcome =
  | {
    outcome: 'completed'
    status: 'ok' | 'error'
    streamText: string
    cellError?: { ename: string, evalue: string, traceback: string[] }
  }
  | {
    outcome: 'forced'
    failure: { kind: 'timeout' | 'abort' | 'worker-exit', message: string }
    streamText: string
  }

const DELIM = Buffer.from('<IDS|MSG>')
const PROTOCOL_VERSION = '5.3'
/** Loopback PUB/SUB subscription propagation guard before the first execute. */
const IOPUB_SUBSCRIBE_DELAY_MS = 50
const CONNECT_POLL_MS = 25
const SHUTDOWN_DRAIN_MS = 200

interface ConnectionInfo {
  ip: string
  transport: 'tcp'
  shell_port: number
  iopub_port: number
  stdin_port: number
  control_port: number
  hb_port: number
  signature_scheme: 'hmac-sha256'
  key: string
  kernel_name: string
}

interface JupyterMessage {
  header: { msg_id: string, msg_type: string, [key: string]: unknown }
  parent_header: Record<string, unknown>
  content: Record<string, unknown>
}

interface ActiveExecution {
  requestMsgId: string
  opts: ExecuteCellOptions
  streamText: string
  cellError?: { ename: string, evalue: string, traceback: string[] }
  status: 'ok' | 'error'
  settled: boolean
  resolve: (outcome: CellOutcome) => void
  forceTimer?: ReturnType<typeof setTimeout>
  timeoutTimer?: ReturnType<typeof setTimeout>
  /** The phase-two SIGALRM escalation timer; cleared on every settle path like the others. */
  alarmTimer?: ReturnType<typeof setTimeout>
  /** Detach the caller signal's abort listener; EVERY settle path must run it exactly once. */
  detachSignal?: () => void
  /** Set when the budget/abort interrupt was sent; the interrupt's own error must not masquerade as a program exception. */
  pendingForce?: { kind: 'timeout' | 'abort', message: string }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function buildMessage(msgType: string, content: Record<string, unknown>, session: string, username: string): JupyterMessage {
  return {
    header: {
      msg_id: randomUUID(),
      session,
      username,
      date: new Date().toISOString(),
      msg_type: msgType,
      version: PROTOCOL_VERSION,
    },
    parent_header: {},
    content,
  }
}

function encode(msg: JupyterMessage, key: string): Buffer[] {
  const parts = [
    Buffer.from(JSON.stringify(msg.header)),
    Buffer.from(JSON.stringify(msg.parent_header)),
    Buffer.from('{}'),
    Buffer.from(JSON.stringify(msg.content)),
  ]
  const hmac = createHmac('sha256', key)
  for (const part of parts) hmac.update(part)
  return [DELIM, Buffer.from(hmac.digest('hex')), ...parts]
}

function decode(frames: Buffer[]): JupyterMessage | null {
  let i = 0
  while (i < frames.length && !frames[i]!.equals(DELIM)) i++
  if (i + 5 >= frames.length) return null
  try {
    return {
      header: JSON.parse(frames[i + 2]!.toString()) as JupyterMessage['header'],
      parent_header: JSON.parse(frames[i + 3]!.toString()) as JupyterMessage['parent_header'],
      content: JSON.parse(frames[i + 5]!.toString()) as JupyterMessage['content'],
    }
  } catch {
    return null
  }
}

function makeConnection(): { path: string, tempDir: string } {
  const info: ConnectionInfo = {
    ip: '127.0.0.1',
    transport: 'tcp',
    shell_port: 0,
    iopub_port: 0,
    stdin_port: 0,
    control_port: 0,
    hb_port: 0,
    signature_scheme: 'hmac-sha256',
    key: randomBytes(16).toString('hex'),
    kernel_name: 'python3',
  }
  const tempDir = mkdtempSync(join(tmpdir(), 'dashr-kernel-'))
  const path = join(tempDir, 'connection.json')
  writeFileSync(path, JSON.stringify(info, null, 2), { mode: 0o600 })
  return { path, tempDir }
}

function readResolvedConnection(path: string): ConnectionInfo | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!isRecord(parsed) || parsed.ip !== '127.0.0.1' || parsed.transport !== 'tcp' || parsed.signature_scheme !== 'hmac-sha256' || typeof parsed.key !== 'string') return null
    for (const port of ['shell_port', 'iopub_port', 'stdin_port', 'control_port', 'hb_port'] as const) {
      const value = parsed[port]
      if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return null
    }
    return parsed as unknown as ConnectionInfo
  } catch {
    return null
  }
}

/**
 * One persistent IPython kernel subprocess with its ZeroMQ channels. Cell
 * execution is serialized on an internal queue (the Jupyter shell channel is
 * request/reply).
 */
export class IpyKernelBridge {
  private readonly session = randomUUID()
  private state: 'idle' | 'starting' | 'running' | 'shutdown' = 'idle'
  private startPromise?: Promise<void>
  private kernel?: ChildProcess
  private shell?: Dealer
  private iopub?: Subscriber
  private control?: Dealer
  private connection?: ConnectionInfo
  private tempDir?: string
  private kernelStderr = ''
  private executionQueue: Promise<unknown> = Promise.resolve()
  private activeExec?: ActiveExecution
  private readonly commTargets = new Map<string, string>()
  private readonly servedComms = new Set<string>()
  private iopubPump?: Promise<void>

  constructor(private readonly options: KernelBridgeOptions) {}

  /** The kernel subprocess pid, for lifecycle assertions; absent before spawn. */
  get pid(): number | undefined {
    return this.kernel?.pid
  }

  get isRunning(): boolean {
    return this.state === 'running'
  }

  /**
   * Whether the subprocess is gone (crashed or disposed). A dead bridge is
   * never resurrected — the owning provider replaces it with a fresh one
   * (respawn, M3-A), because kernel state is unrecoverable in-process.
   */
  get isDead(): boolean {
    return this.state === 'shutdown'
  }

  /**
   * Start the kernel (idempotent; concurrent callers share one startup).
   * @throws when the subprocess cannot spawn, ports never resolve, the
   *   kernel_info probe times out, or the bootstrap cell fails.
   */
  async start(): Promise<void> {
    if (!this.startPromise) {
      this.startPromise = this.doStart().catch((error: unknown) => {
        this.startPromise = undefined
        throw error
      })
    }
    return this.startPromise
  }

  private stderrTail(): string {
    return this.kernelStderr.slice(-1024) || '(empty)'
  }

  private async doStart(): Promise<void> {
    if (this.state !== 'idle') return
    this.state = 'starting'
    const { path, tempDir } = makeConnection()
    this.tempDir = tempDir
    // Scrubbed environment: the interpreter is invoked by absolute path, and
    // the kernel needs no ambient credentials; HOME backs IPython's optional
    // history writes.
    const kernel = spawn(this.options.python, ['-m', 'ipykernel_launcher', '-f', path], {
      cwd: this.options.cwd,
      env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        LANG: 'C.UTF-8',
        HOME: process.env.HOME ?? tmpdir(),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.kernel = kernel
    kernel.stderr?.on('data', (buf: Buffer) => { this.kernelStderr += buf.toString() })
    kernel.on('error', (error: Error) => {
      this.kernelStderr += `spawn error: ${error.message}\n`
      this.onKernelDeath()
    })
    kernel.on('exit', (code, signal) => {
      if (this.state !== 'shutdown') this.kernelStderr += `unexpected exit code=${code} signal=${signal}\n`
      this.onKernelDeath()
    })

    let conn: ConnectionInfo
    try {
      conn = await this.waitForConnection(path)
      this.connection = conn
    } catch (error) {
      this.cleanupResources()
      this.state = 'idle'
      throw error
    }

    this.shell = new Dealer()
    this.iopub = new Subscriber()
    this.control = new Dealer()
    this.shell.connect(`${conn.transport}://${conn.ip}:${conn.shell_port}`)
    this.iopub.connect(`${conn.transport}://${conn.ip}:${conn.iopub_port}`)
    this.control.connect(`${conn.transport}://${conn.ip}:${conn.control_port}`)
    this.iopub.subscribe('')
    await sleep(IOPUB_SUBSCRIBE_DELAY_MS)
    this.startIopubPump()

    try {
      await this.probeReady()
    } catch (error) {
      this.cleanupResources()
      this.state = 'idle'
      throw error
    }

    const bootstrap = await this.executeCell(KERNEL_BOOTSTRAP, {
      timeoutMs: this.options.startupTimeoutMs,
      interruptGraceMs: 1_000,
      interruptConfirmMs: Math.min(this.options.interruptConfirmMs, 500),
    })
    if (bootstrap.outcome !== 'completed' || bootstrap.status !== 'ok') {
      const detail = bootstrap.outcome === 'completed' && bootstrap.cellError
        ? `${bootstrap.cellError.ename}: ${bootstrap.cellError.evalue}`
        : 'bootstrap cell failed'
      this.cleanupResources()
      this.state = 'idle'
      throw new Error(`dashr kernel bootstrap failed: ${detail}`)
    }

    this.state = 'running'
  }

  private async waitForConnection(path: string): Promise<ConnectionInfo> {
    const deadline = Date.now() + this.options.startupTimeoutMs
    while (Date.now() < deadline) {
      if (this.state === 'shutdown') {
        throw new Error(`kernel exited before resolving ports. stderr:\n${this.stderrTail()}`)
      }
      const info = readResolvedConnection(path)
      if (info) return info
      await sleep(CONNECT_POLL_MS)
    }
    throw new Error(`kernel did not resolve connection ports within ${this.options.startupTimeoutMs}ms. stderr tail:\n${this.stderrTail()}`)
  }

  private async probeReady(): Promise<void> {
    const conn = this.connection
    const shell = this.shell
    if (!conn || !shell) throw new Error('kernel channels are not connected')
    const msg = buildMessage('kernel_info_request', {}, this.session, this.options.username)
    const requestMsgId = msg.header.msg_id
    await shell.send(encode(msg, conn.key))

    const deadline = Date.now() + this.options.startupTimeoutMs
    while (Date.now() < deadline) {
      if (this.state === 'shutdown') {
        throw new Error(`kernel exited during startup. stderr:\n${this.stderrTail()}`)
      }
      const winner = await Promise.race([
        shell.receive().then(frames => ({ kind: 'frames' as const, frames })),
        sleep(Math.max(1, deadline - Date.now())).then(() => ({ kind: 'timeout' as const })),
      ])
      if (winner.kind === 'timeout') break
      const incoming = decode(winner.frames)
      if (incoming?.header.msg_type === 'kernel_info_reply'
        && (incoming.parent_header as { msg_id?: string }).msg_id === requestMsgId) {
        return
      }
    }
    throw new Error(`kernel did not answer kernel_info_request within ${this.options.startupTimeoutMs}ms. stderr tail:\n${this.stderrTail()}`)
  }

  /**
   * Execute one cell on the persistent kernel, serialized against all other
   * executions. Resolves with the cell's outcome — never rejects for
   * cell-level failures (program errors, timeouts, aborts, kernel death).
   * @param code - complete cell source.
   * @param opts - budgets, abort signal, and the host-request dispatcher.
   */
  async executeCell(code: string, opts: ExecuteCellOptions): Promise<CellOutcome> {
    const prev = this.executionQueue
    let releaseQueue!: () => void
    this.executionQueue = new Promise<void>(resolve => { releaseQueue = resolve })
    await prev
    try {
      if (this.state === 'shutdown' || this.state === 'idle') {
        return { outcome: 'forced', failure: { kind: 'worker-exit', message: 'kernel has been shut down' }, streamText: '' }
      }
      return await this.executeInner(code, opts)
    } finally {
      releaseQueue()
    }
  }

  private executeInner(code: string, opts: ExecuteCellOptions): Promise<CellOutcome> {
    const conn = this.connection
    const shell = this.shell
    if (!conn || !shell) {
      return Promise.resolve({ outcome: 'forced', failure: { kind: 'worker-exit', message: 'kernel channels are not connected' }, streamText: '' })
    }

    const msg = buildMessage('execute_request', {
      code,
      silent: false,
      store_history: false,
      user_expressions: {},
      allow_stdin: false,
      stop_on_error: true,
    }, this.session, this.options.username)

    return new Promise<CellOutcome>(resolve => {
      const execution: ActiveExecution = {
        requestMsgId: msg.header.msg_id,
        opts,
        streamText: '',
        status: 'ok',
        settled: false,
        resolve,
      }
      this.activeExec = execution

      const settle = (outcome: CellOutcome): void => {
        if (execution.settled) return
        execution.settled = true
        if (execution.forceTimer) clearTimeout(execution.forceTimer)
        if (execution.timeoutTimer) clearTimeout(execution.timeoutTimer)
        if (execution.alarmTimer) clearTimeout(execution.alarmTimer)
        execution.detachSignal?.()
        if (this.activeExec === execution) this.activeExec = undefined
        resolve(outcome)
      }

      // Interrupt in two phases, then force-settle with the failure after the
      // grace period. Phase one is the control-channel interrupt alone: it
      // settles any cell that yields to the kernel event loop and is harmless
      // to an idle kernel (measured: an idle ipykernel survives a bare
      // interrupt_request). SIGALRM — the phase that CAN terminate the
      // process when it lands outside cell execution — escalates only after
      // the confirm window, and only when this execution still needs
      // breaking. When an interrupt DOES break the cell, the resulting
      // KeyboardInterrupt reports as the armed failure kind, not as a program
      // exception.
      const interruptAndForce = (failure: { kind: 'timeout' | 'abort', message: string }): void => {
        // A stale interrupt (signal/timer fired after this execution left the
        // active slot) must never reach the kernel: even phase one has no
        // business hitting a cell that is no longer active.
        if (this.activeExec !== execution) return
        if (execution.pendingForce === undefined) execution.pendingForce = failure
        void this.sendInterrupt(execution)
        execution.forceTimer = setTimeout(() => {
          settle({ outcome: 'forced', failure, streamText: execution.streamText })
        }, opts.interruptGraceMs)
        execution.forceTimer.unref?.()
      }

      const onAbort = (): void => {
        interruptAndForce({ kind: 'abort', message: String(opts.signal?.reason) })
      }

      execution.timeoutTimer = setTimeout(() => {
        interruptAndForce({ kind: 'timeout', message: `cell exceeded ${opts.timeoutMs}ms wall budget` })
      }, opts.timeoutMs)
      execution.timeoutTimer.unref?.()

      opts.signal?.addEventListener('abort', onAbort, { once: true })
      // Detach on EVERY settle path (the `settle` closure here,
      // `settleCompleted`, and `forceSettleActive`): a listener surviving a
      // completed cell would fire interruptAndForce at an IDLE kernel on the
      // caller's next abort, and SIGALRM-ing an idle kernel kills it.
      execution.detachSignal = () => opts.signal?.removeEventListener('abort', onAbort)
      if (opts.signal?.aborted) onAbort()

      void shell.send(encode(msg, conn.key)).catch(() => {
        settle({ outcome: 'forced', failure: { kind: 'worker-exit', message: 'shell channel send failed' }, streamText: execution.streamText })
      })
    })
  }

  private startIopubPump(): void {
    if (this.iopubPump) return
    this.iopubPump = this.runIopubPump()
  }

  private async runIopubPump(): Promise<void> {
    const iopub = this.iopub
    if (!iopub) return
    try {
      for await (const frames of iopub) {
        const incoming = decode(frames)
        if (!incoming) continue
        const msgType = incoming.header.msg_type
        if (msgType === 'comm_open' || msgType === 'comm_msg' || msgType === 'comm_close') {
          this.handleCommMessage(incoming)
          continue
        }
        this.handleExecutionMessage(incoming)
      }
    } catch {
      // Socket closed during teardown; a live run settles via kernel-death path.
      if (this.state !== 'shutdown') {
        this.forceSettleActive({ kind: 'worker-exit', message: 'kernel iopub channel failed' })
      }
    } finally {
      if (this.iopub === iopub) this.iopubPump = undefined
    }
  }

  private forceSettleActive(failure: { kind: 'timeout' | 'abort' | 'worker-exit', message: string }): void {
    const execution = this.activeExec
    if (!execution || execution.settled) return
    execution.settled = true
    if (execution.forceTimer) clearTimeout(execution.forceTimer)
    if (execution.timeoutTimer) clearTimeout(execution.timeoutTimer)
    if (execution.alarmTimer) clearTimeout(execution.alarmTimer)
    execution.detachSignal?.()
    this.activeExec = undefined
    execution.resolve({ outcome: 'forced', failure, streamText: execution.streamText })
  }

  private handleExecutionMessage(incoming: JupyterMessage): void {
    const execution = this.activeExec
    if (!execution || execution.settled) return
    if ((incoming.parent_header as { msg_id?: string }).msg_id !== execution.requestMsgId) return
    const msgType = incoming.header.msg_type
    if (msgType === 'stream') {
      const content = incoming.content as { text?: string }
      if (typeof content.text === 'string') execution.streamText += content.text
    } else if (msgType === 'error') {
      const content = incoming.content as { ename?: string, evalue?: string, traceback?: string[] }
      execution.cellError = {
        ename: typeof content.ename === 'string' ? content.ename : 'Error',
        evalue: typeof content.evalue === 'string' ? content.evalue : '',
        traceback: Array.isArray(content.traceback) ? content.traceback : [],
      }
      execution.status = 'error'
    } else if (msgType === 'status') {
      const content = incoming.content as { execution_state?: string }
      if (content.execution_state === 'idle') {
        this.settleCompleted(execution)
      }
    }
  }

  private settleCompleted(execution: ActiveExecution): void {
    if (execution.settled) return
    execution.settled = true
    if (execution.forceTimer) clearTimeout(execution.forceTimer)
    if (execution.timeoutTimer) clearTimeout(execution.timeoutTimer)
    if (execution.alarmTimer) clearTimeout(execution.alarmTimer)
    execution.detachSignal?.()
    if (this.activeExec === execution) this.activeExec = undefined
    if (execution.pendingForce !== undefined) {
      execution.resolve({ outcome: 'forced', failure: execution.pendingForce, streamText: execution.streamText })
      return
    }
    execution.resolve({
      outcome: 'completed',
      status: execution.status,
      streamText: execution.streamText,
      ...execution.cellError ? { cellError: execution.cellError } : {},
    })
  }

  private handleCommMessage(incoming: JupyterMessage): void {
    const content = incoming.content
    const commId = content.comm_id
    if (typeof commId !== 'string') return
    const msgType = incoming.header.msg_type

    if (msgType === 'comm_close') {
      this.commTargets.delete(commId)
      this.servedComms.delete(commId)
      return
    }
    if (msgType === 'comm_open') {
      // Registration only: the shim opens the comm empty and carries its one
      // request as the first comm_msg.
      const targetName = content.target_name
      if (typeof targetName === 'string') this.commTargets.set(commId, targetName)
      return
    }
    if (msgType === 'comm_msg' && this.commTargets.get(commId) === HOST_COMM_TARGET) {
      this.serveHostRequest(commId, content.data)
    }
  }

  private serveHostRequest(commId: string, data: unknown): void {
    // One request per comm: the kernel-side shim closes the comm after its
    // reply, and duplicate delivery must not double-dispatch.
    if (this.servedComms.has(commId)) return
    this.servedComms.add(commId)

    const handler = this.activeExec?.opts.hostRequestHandler
    if (!handler) {
      void this.replyComm(commId, { status: 'error', error: 'no host request handler is active' }).catch(() => undefined)
      return
    }
    if (!isRecord(data)) {
      void this.replyComm(commId, { status: 'error', error: 'host request payload must be an object' }).catch(() => undefined)
      return
    }
    void (async () => {
      try {
        const outcome = await handler(data)
        if (outcome.ok) {
          await this.replyComm(commId, { status: 'ok', result: outcome.result })
        } else {
          await this.replyComm(commId, { status: 'error', error: outcome.message })
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        await this.replyComm(commId, { status: 'error', error: message }).catch(() => undefined)
      }
    })().catch(() => undefined)
  }

  private async replyComm(commId: string, data: Record<string, unknown>): Promise<void> {
    const channel = this.control ?? this.shell
    if (!channel || !this.connection) throw new Error('kernel channels are not connected')
    await channel.send(encode(buildMessage('comm_msg', { comm_id: commId, data }, this.session, this.options.username), this.connection.key))
  }

  /**
   * Phase one NOW, phase two on a timer: send the control-channel interrupt,
   * then — after the confirm window, and only if the execution has still not
   * settled — escalate to SIGALRM. The zmq interrupt only lands when the cell
   * yields to the kernel event loop; a busy sync cell ('while True: pass')
   * never does, which is why the escalation exists at all. Sending both
   * channels in the same tick (the M1 design) made SIGALRM the FIRST signal
   * an idle-or-booting kernel saw on timeout/abort: its handler raised
   * KeyboardInterrupt at the top level and the process exited cleanly — a
   * deterministic kill (10/10 same-tick aborts, 8/10 at +1-2ms, 40/40 during
   * cold boot; dev/m2a-report.md §5.1). Two-phase escalation plus the
   * kernel-side busy guard closes that window while keeping the hard-abort
   * contract: a busy loop still breaks, one confirm window later.
   */
  private async sendInterrupt(execution: ActiveExecution): Promise<void> {
    if (!this.control || !this.connection) return
    try {
      await this.control.send(encode(buildMessage('interrupt_request', {}, this.session, this.options.username), this.connection.key))
    } catch {
      // Channels closed mid-interrupt (kernel death owns the settle).
    }
    execution.alarmTimer = setTimeout(() => {
      // The execution settled inside the window — the zmq interrupt was
      // enough (an awaiting cell, or one that finished) — no signal needed.
      if (execution.settled) return
      if (this.kernel?.exitCode === null) {
        try { this.kernel.kill('SIGALRM') } catch { /* already gone */ }
      }
    }, execution.opts.interruptConfirmMs)
    execution.alarmTimer.unref?.()
  }

  /**
   * Snapshot the user namespace via an internal dill cell. Requires `dill` in
   * the kernel environment. The cell reports its outcome through a nonce
   * envelope (skipped-for-size vs written); a failed/skipped dump NEVER
   * replaces a previous good snapshot on disk.
   * @param payloadPath - dill payload destination.
   * @param manifestPath - JSON manifest destination (turn, names, python
   *   version, venv path, skills, size).
   * @param spec - turn counter, skills list, and the size cap.
   */
  async snapshotState(payloadPath: string, manifestPath: string, spec: SnapshotSpec): Promise<SnapshotOutcome> {
    if (!this.isRunning) return { kind: 'failed', reason: 'kernel is not running' }
    const sentinel = `__dashr_snapshot_${randomBytes(9).toString('hex')}__`
    const outcome = await this.executeCell(buildSnapshotCell(payloadPath, manifestPath, spec, sentinel), {
      timeoutMs: this.options.snapshotTimeoutMs,
      interruptGraceMs: 1_000,
      interruptConfirmMs: Math.min(this.options.interruptConfirmMs, 500),
    })
    if (outcome.outcome !== 'completed' || outcome.status !== 'ok') {
      return { kind: 'failed', reason: 'snapshot cell failed' }
    }
    return this.parseSnapshotEnvelope(outcome.streamText, sentinel)
  }

  /** Parse one snapshot cell's nonce envelope into its outcome. */
  private parseSnapshotEnvelope(streamText: string, sentinel: string): SnapshotOutcome {
    const capture = extractStream(streamText, sentinel)
    if (capture.envelope === undefined) return { kind: 'failed', reason: 'snapshot cell produced no envelope' }
    let envelope: unknown
    try {
      envelope = JSON.parse(capture.envelope)
    } catch {
      return { kind: 'failed', reason: 'snapshot envelope was not valid JSON' }
    }
    if (typeof envelope !== 'object' || envelope === null) return { kind: 'failed', reason: 'snapshot envelope was not an object' }
    const record = envelope as { ok?: unknown, skipped?: unknown, reason?: unknown, sizeBytes?: unknown, names?: unknown, estimateBytes?: unknown, capBytes?: unknown }
    if (record.ok === true) {
      return {
        kind: 'ok',
        sizeBytes: typeof record.sizeBytes === 'number' ? record.sizeBytes : 0,
        names: typeof record.names === 'number' ? record.names : 0,
      }
    }
    if (record.skipped === true) {
      return {
        kind: 'skipped',
        reason: typeof record.reason === 'string' ? record.reason : 'size cap',
        ...typeof record.estimateBytes === 'number' ? { estimateBytes: record.estimateBytes } : {},
        ...typeof record.sizeBytes === 'number' ? { sizeBytes: record.sizeBytes } : {},
        capBytes: typeof record.capBytes === 'number' ? record.capBytes : 0,
      }
    }
    return { kind: 'failed', reason: typeof record.reason === 'string' ? record.reason : 'snapshot failed' }
  }

  /**
   * Restore a dill snapshot into the user namespace via an internal cell. The
   * kernel validates the manifest (python version, interpreter identity,
   * skills) and reports restored vs degraded through a nonce envelope; a
   * degraded restore leaves the namespace empty.
   * @param payloadPath - dill payload source.
   * @param manifestPath - JSON manifest source.
   */
  async restoreState(payloadPath: string, manifestPath: string): Promise<RestoreStateOutcome> {
    if (!this.isRunning) return { kind: 'degraded', reason: 'kernel is not running' }
    const sentinel = `__dashr_restore_${randomBytes(9).toString('hex')}__`
    const outcome = await this.executeCell(buildRestoreCell(payloadPath, manifestPath, sentinel), {
      timeoutMs: this.options.snapshotTimeoutMs,
      interruptGraceMs: 1_000,
      interruptConfirmMs: Math.min(this.options.interruptConfirmMs, 500),
    })
    if (outcome.outcome !== 'completed' || outcome.status !== 'ok') {
      return { kind: 'degraded', reason: 'restore cell failed' }
    }
    const capture = extractStream(outcome.streamText, sentinel)
    if (capture.envelope === undefined) return { kind: 'degraded', reason: 'restore cell produced no envelope' }
    let envelope: unknown
    try {
      envelope = JSON.parse(capture.envelope)
    } catch {
      return { kind: 'degraded', reason: 'restore envelope was not valid JSON' }
    }
    if (typeof envelope !== 'object' || envelope === null) return { kind: 'degraded', reason: 'restore envelope was not an object' }
    const record = envelope as { ok?: unknown, restored?: unknown, reason?: unknown }
    if (record.ok === true) {
      return { kind: 'restored', count: typeof record.restored === 'number' ? record.restored : 0 }
    }
    return { kind: 'degraded', reason: typeof record.reason === 'string' ? record.reason : 'snapshot not replayable' }
  }

  private onKernelDeath(): void {
    this.state = 'shutdown'
    this.forceSettleActive({ kind: 'worker-exit', message: `kernel process died. stderr tail:\n${this.stderrTail()}` })
    this.cleanupResources()
  }

  private cleanupResources(): void {
    this.shell?.close()
    this.iopub?.close()
    this.control?.close()
    this.shell = undefined
    this.iopub = undefined
    this.control = undefined
    this.iopubPump = undefined
    this.connection = undefined
    try {
      this.kernel?.kill('SIGKILL')
    } catch {
      // Kernel already exited.
    }
    this.kernel = undefined
    if (this.tempDir) {
      try {
        rmSync(this.tempDir, { recursive: true, force: true })
      } catch {
        // Leave the temp dir for OS tmp cleanup.
      }
    }
    this.tempDir = undefined
  }

  /** Graceful teardown: shutdown_request, then SIGKILL after the dispose budget. */
  async dispose(): Promise<void> {
    if (this.state === 'shutdown') {
      this.cleanupResources()
      return
    }
    this.state = 'shutdown'
    try {
      if (this.control && this.connection) {
        await this.control.send(encode(buildMessage('shutdown_request', { restart: false }, this.session, this.options.username), this.connection.key))
        await sleep(SHUTDOWN_DRAIN_MS)
      }
    } catch {
      // Fall through to the kill path.
    }
    const kernel = this.kernel
    this.cleanupResources()
    if (kernel && kernel.exitCode === null && kernel.signalCode === null) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => {
          kernel.removeListener('exit', onExit)
          try {
            kernel.kill('SIGKILL')
          } catch {
            // Already gone.
          }
          resolve()
        }, this.options.disposeTimeoutMs)
        timer.unref?.()
        const onExit = (): void => {
          clearTimeout(timer)
          resolve()
        }
        kernel.once('exit', onExit)
      })
    }
  }
}
