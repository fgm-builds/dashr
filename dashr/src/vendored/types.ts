/**
 * Vocabulary types for the code-execution seam: what a caller hands a
 * {@link ./rlm-runtime.ts | RLMRuntime} and what it gets back. Pure types — no
 * runtime code lives here.
 *
 * Vendored from `@deepseek-ai/dsh-code-runtime@0.1.0-rc.6` (`src/types.ts`)
 * per blueprint v0.5 §7.6: type shapes are the interop contract our
 * presentation/SDK work builds against, so they are carried unchanged apart
 * from the recorded deltas:
 *
 * 1. the module header and the two `../index.ts` doc links were rewritten for
 *    this location;
 * 2. `CodeRunRequest.principal` is a DASHR-OWNED field (M3-A, blueprint §6
 *    "kernel per-session 键控"): upstream's seam deliberately has no session
 *    concept, but a stateful backend must key its persistent substrate by the
 *    calling session or every session sharing one service instance would
 *    share one namespace. Optional so upstream-shaped requests stay valid —
 *    an absent principal addresses the provider's shared default key.
 * 3. `CodeBindingNamespace.callable` is a DASHR-OWNED field (M3-B, blueprint
 *    §9 rlm() binding): upstream's object-holder model (a global whose
 *    MEMBERS are callable) cannot express a bare callable global like
 *    `rlm(prompt)`. `callable: true` declares the global itself is a
 *    function; `functions` then carries exactly one entry — the single host
 *    function the global call dispatches. Optional so upstream-shaped
 *    namespaces stay valid.
 *
 * @module dashr/vendored/types
 */

/**
 * One host-side function exposed to the program as an async callable. The
 * runtime bridges calls to it (possibly across a serialization boundary), so
 * `args` and the resolution value MUST be lossless JSON. A runtime rejects a
 * lossy or non-cloneable value with a descriptive error rather than corrupting
 * the run. No seam-level byte cap applies to a binding resolution. A rejection
 * of this function surfaces inside the program as a rejection of the
 * corresponding call.
 */
export type CodeBindingFunction = (args: unknown) => Promise<CodeJsonValue>

/** A lossless JSON value transferable through the dependency-light Service Definition. */
export type CodeJsonValue = null | boolean | number | string | CodeJsonValue[] | { [key: string]: CodeJsonValue }

/**
 * Program-visible typed rejection for one binding namespace. The runtime
 * injects a real error constructor under `name`; rejected member calls become
 * its instances and expose the exact member name through
 * `memberNameProperty`. Both strings are runtime data rather than knowledge
 * of a particular consumer such as Code Mode.
 */
export interface CodeBindingErrorClass {
  /** Constructor global and resulting `Error.name`; same portable identifier rule as {@link CodeBindingNamespace.global}. */
  name: string
  /**
   * Non-empty own property for the member name. The portable exclusion set is
   * `RESERVED_ERROR_MEMBERS` plus dunder-form names (`__x__`, non-empty
   * middle), enforced identically by every backend; any other name —
   * identifiers or not — is accepted everywhere.
   */
  memberNameProperty: string
}

/**
 * A named group of {@link CodeBindingFunction}s the runtime exposes to the
 * program as one global object (e.g. `tools`). Function names are arbitrary
 * strings — a runtime must treat names like `__proto__` or `constructor` as
 * ordinary own properties (null-prototype construction), never as prototype
 * collisions.
 */
export interface CodeBindingNamespace {
  /**
   * The global identifier the program sees. Must match the LANGUAGE-PORTABLE
   * identifier subset `[A-Za-z_][A-Za-z0-9_]*` and no language's reserved
   * words, so the same namespace list works against every backend regardless
   * of `language` — a JS-only spelling like `$tools` is rejected by design,
   * not just by the Python backend. Names that satisfy the identifier rule but
   * name a backend-owned slot (`RESERVED_BINDING_GLOBALS`, e.g. `console`,
   * `__dsh_main__`) are also refused everywhere; see its declaration for the
   * exact set and why each entry is reserved.
   */
  global: string
  /** The callable members, keyed by the exact name the program calls. */
  functions: Record<string, CodeBindingFunction>
  /**
   * Materialize the global itself as a callable function rather than an
   * object whose members are callable. When true, `functions` must contain
   * EXACTLY ONE entry — the single host function the bare global call
   * dispatches (its key is a transport detail, not a program-visible member).
   * DASHR-owned delta (M3-B, blueprint §9): the rlm() family and the flat
   * per-tool bindings are bare callable globals, which the object-holder
   * model cannot express.
   */
  callable?: true
  /** Optional program-visible typed rejection contract for this namespace. */
  errorClass?: CodeBindingErrorClass
}

/**
 * One run: the program source plus everything the runtime acts on. Per the
 * explicit-over-implicit convention, defaulting (time budgets, output caps)
 * is the implementation's validated config — a request carries no optional
 * tuning knobs for a hidden `??` to fill in.
 */
export interface CodeRunRequest {
  /**
   * The program source, in the runtime's {@link ./rlm-runtime.ts | language}. It
   * runs as the body of an async function: top-level `await` and `return`
   * are available, and the completion value becomes
   * {@link CodeRunResult.value}.
   */
  program: string
  /** Host functions exposed to the program, one global object per namespace. */
  bindings: CodeBindingNamespace[]
  /**
   * Abort the run: the runtime stops the program (hard, even mid-loop) and
   * resolves with a {@link CodeRunFailure} of kind `'abort'`. In-flight
   * binding calls are the CALLER's to settle — the runtime only stops asking.
   */
  signal?: AbortSignal
  /**
   * The calling session/agent identity the run's state belongs to — a
   * STATEFUL backend keys its persistent substrate by this (one namespace per
   * principal) so sessions sharing one service instance never share state.
   * DASHR-owned delta on the upstream seam (which is session-less); see the
   * module header. The presentation layer passes the calling `Agent`'s id; an
   * absent or empty principal addresses the provider's shared default key
   * (upstream-shaped requests keep their M1 meaning).
   */
  principal?: string
  /**
   * The kernel's working directory: the calling SESSION's workspace
   * (`agent.session.header.cwd`), threaded by the presentation layer. Never
   * the daemon's `process.cwd()`: a kernel is per-session state, so its cwd
   * is per-session state, and inheriting the host cwd leaked the systemd
   * unit's WorkingDirectory into every kernel regardless of the workspace the
   * session was opened in. Absent (older caller, agentless run) → spawn-time
   * inherit. Resolved ONLY on first spawn of a principal; a reused kernel
   * keeps the cwd it booted with (a session's workspace is fixed in its
   * header).
   */
  cwd?: string
}

/**
 * Why a run failed. The kinds are orthogonal outcomes reported independently
 * (per docs/defensive-patterns.md): a budget expiry is not an exception, an
 * abort is not a timeout, and a substrate death is neither.
 *
 * - `'exception'` — the program threw or failed to parse/transform.
 * - `'timeout'` — an implementation-owned budget expired; the message says which.
 * - `'abort'` — {@link CodeRunRequest.signal} fired.
 * - `'worker-exit'` — the execution substrate died without settling (e.g. OOM).
 * - `'invalid-output'` — the completion value was not lossless JSON.
 * - `'output-limit'` — the serialized outer logs/value/diagnostic exceeded the configured cap.
 */
export interface CodeRunFailure {
  /** The failure class (see the interface doc for each kind's meaning). */
  kind: 'exception' | 'timeout' | 'abort' | 'worker-exit' | 'invalid-output' | 'output-limit'
  /** Human-readable detail, suitable for feeding back to a model to self-correct. */
  message: string
}

/**
 * The outcome of one run. An error is a FIELD on a resolved result, never a
 * rejection of `run()` — reporting a failed program is the caller's job, not
 * an exception path.
 */
export interface CodeRunResult {
  /**
   * The program's completion value (its top-level `return`), when it ran to
   * completion and the value crossed the runtime's lossless-JSON boundary.
   * Invalid or over-limit completions fail the run instead of substituting a
   * rendered string; a failed or value-less run leaves this absent.
   */
  value?: CodeJsonValue
  /** Text the program emitted, in order, bounded only as part of the outer result. */
  logs: string[]
  /** Present iff the run failed; see {@link CodeRunFailure} for the taxonomy. */
  error?: CodeRunFailure
}
