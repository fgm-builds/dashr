import { describe, expect, it } from 'vitest'
import type {
  CodeBindingErrorClass,
  CodeBindingFunction,
  CodeBindingNamespace,
  CodeJsonValue,
  CodeRunFailure,
  CodeRunRequest,
  CodeRunResult,
  RLMRuntime,
} from 'dashr-code-runtime-ipython'
import type {
  RlmBindingErrorClass,
  RlmBindingFunction,
  RlmBindingNamespace,
  RlmJsonValue,
  RlmRunFailure,
  RlmRunRequest,
  RlmRunResult,
  RlmRuntimeSurface,
} from '../src/runtime-surface.ts'

/**
 * Compile-time drift control for the structural seam mirror (see
 * `src/runtime-surface.ts`): the presentation plugin depends on the vendored
 * Service Definition's SHAPE, not its import graph. The assignments below are
 * the assertions; each direction locks a different half of the contract, and
 * neither direction alone is the whole story (verified empirically by the
 * M2A verifier):
 *
 * - FORWARD (`vendored` value assignable to `mirror`): the mirror must accept
 *   everything the runtime's contract provides. A vendored field whose type
 *   stops matching a mirror field — or a mirror field the contract no longer
 *   provides — fails this package's typecheck. This direction is
 *   variance-safe: a NEW required field on the vendored side does NOT trip it
 *   (a real request still satisfies the mirror's field subset).
 * - REVERSE (`mirror` value assignable to `vendored`): the mirror carries
 *   every field the contract currently REQUIRES. A new required field added
 *   to the vendored contract (e.g. `CodeRunRequest.mode: string`) fails here
 *   immediately. This is the direction that catches upstream contract
 *   additions, which is exactly the drift the blueprint §7.7 mitigation
 *   exists for.
 *
 * The one deliberately absent reverse is `RlmRuntimeSurface => RLMRuntime`:
 * `RLMRuntime` is an abstract `Service` class and its instance type carries
 * protected Cordis members that a structural stand-in can never satisfy by
 * assignment, so that assertion would fail forever without conveying any
 * drift. The runtime SERVICE is consumed by `ctx.get('rlmRuntime')` (keyed
 * resolution, not class identity), and the value-level pieces of its surface
 * are covered above on both directions.
 */

// Forward: the mirror must accept every vendored vocabulary value.
const _jsonAccepts: (value: CodeJsonValue) => RlmJsonValue = value => value
const _fnAccepts: (fn: CodeBindingFunction) => RlmBindingFunction = fn => fn
const _errorClassAccepts: (e: CodeBindingErrorClass) => RlmBindingErrorClass = e => e
const _namespaceAccepts: (ns: CodeBindingNamespace) => RlmBindingNamespace = ns => ns
const _failureAccepts: (f: CodeRunFailure) => RlmRunFailure = f => f
const _requestAccepts: (r: CodeRunRequest) => RlmRunRequest = r => r
const _resultAccepts: (r: CodeRunResult) => RlmRunResult = r => r
// A concrete provider must satisfy the surface the plugin consumes.
const _runtimeAccepts: (runtime: RLMRuntime) => RlmRuntimeSurface = runtime => runtime

// Reverse: the mirror must satisfy every field the vendored contract requires
// (upstream contract ADDITIONS fail this package's typecheck here).
const _jsonProvides: (value: RlmJsonValue) => CodeJsonValue = value => value
const _fnProvides: (fn: RlmBindingFunction) => CodeBindingFunction = fn => fn
const _errorClassProvides: (e: RlmBindingErrorClass) => CodeBindingErrorClass = e => e
const _namespaceProvides: (ns: RlmBindingNamespace) => CodeBindingNamespace = ns => ns
const _failureProvides: (f: RlmRunFailure) => CodeRunFailure = f => f
const _requestProvides: (r: RlmRunRequest) => CodeRunRequest = r => r
const _resultProvides: (r: RlmRunResult) => CodeRunResult = r => r
// `RlmRuntimeSurface => RLMRuntime` is intentionally absent: the abstract
// Service class's protected members make structural assignment to its
// instance type unsatisfiable by design — see the module doc above.

describe('runtime surface compatibility', () => {
  it('the vendored Service Definition and the local mirror are mutually assignable (checked at compile time)', () => {
    // The assertions above are the test; this body only keeps the file a
    // valid suite and silences unused-const linters.
    expect([
      _jsonAccepts, _fnAccepts, _errorClassAccepts, _namespaceAccepts, _failureAccepts, _requestAccepts, _resultAccepts, _runtimeAccepts,
      _jsonProvides, _fnProvides, _errorClassProvides, _namespaceProvides, _failureProvides, _requestProvides, _resultProvides,
    ]).toHaveLength(15)
  })
})
