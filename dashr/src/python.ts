/**
 * Per-run cell generation. One `run()` is exactly one `execute_request`: the
 * cell installs the run's binding namespaces, runs the program through
 * `_dashr_run_program` (module-body statements executed with the user
 * namespace as BOTH globals and locals — REPL semantics — under
 * `await eval(...)`, so top-level `await` and `return` work per the seam's
 * function-body contract), and prints the completion envelope under a per-run
 * nonce sentinel so the host can recover the exact JSON bytes from the
 * captured stream.
 *
 * The snapshot and restore cells live here too: they are internal cells on
 * the SAME kernel, generated the same way, and must therefore obey the same
 * busy-guard discipline as a user cell.
 * @module dashr/python
 */

/** Binding namespaces as seen by the kernel-side installer, keyed by global. */
export type NamespaceSpecs = Record<string, {
  functions: string[]
  /** Materialize the global itself as a callable function (single `functions` entry). */
  callable?: true
  errorClass?: { name: string, memberNameProperty: string }
}>

/**
 * Build the single cell for one run.
 * @param program - the model's program, the body of an async function.
 * @param specJson - the JSON-encoded {@link NamespaceSpecs} map.
 * @param sentinel - per-run nonce prefix; the envelope line starts with it.
 * @returns the complete cell source.
 */
export function buildRunCell(program: string, specJson: string, sentinel: string): string {
  // The program executes via _dashr_run_program (exec with the user
  // namespace as BOTH globals and locals — REPL semantics, so
  // 'count = count + ...' reads state left by earlier runs instead of
  // raising UnboundLocalError in a real function scope). Its result is the
  // rewritten top-level return value.
  // The scaffold brackets the whole cell with the SIGALRM busy guard (see the
  // bootstrap's _dashr_state): from the kernel's first bytecode of this cell
  // to its last, an interrupt may raise KeyboardInterrupt — the window where
  // breaking the cell is the intended outcome. Outside it (boot, idle,
  // post-cell unwind) the kernel-side handler swallows the signal instead of
  // dying to it.
  return [
    `_dashr_state['executing'] = True`,
    `try:`,
    // The program executes via _dashr_run_program (exec with the user
    // namespace as BOTH globals and locals — REPL semantics, so
    // 'count = count + ...' reads state left by earlier runs instead of
    // raising UnboundLocalError in a real function scope). Its result is the
    // rewritten top-level return value.
    `    _dashr_install_bindings(${JSON.stringify(specJson)})`,
    `    __dashr_completion__ = _dashr_encode(await _dashr_run_program(${JSON.stringify(program)}))`,
    // The full envelope is printed (never just the value's JSON text) so a
    // rejected encoding cannot collide with a value that serializes to
    // '{"ok": false}' itself.
    `    print(${JSON.stringify(sentinel)} + _dashr_json.dumps(__dashr_completion__))`,
    `finally:`,
    `    _dashr_state['executing'] = False`,
  ].join('\n')
}

/** Host-supplied inputs a snapshot cell records beside the dill payload. */
export interface SnapshotSpec {
  /** Which completed run this snapshot belongs to (the revive "turn-N" counter). */
  turn: number
  /** Minimal replay metadata: skills the kernel environment must provide (none today). */
  skills: string[]
  /** Serialized-size cap in bytes; over-cap snapshots are skipped, not written. */
  sizeCapBytes: number
}

/**
 * Build the internal cell that dumps the user namespace to a dill snapshot and
 * writes a JSON manifest next to it. Only USER state is captured: IPython's
 * own session plumbing (`exit`, `quit`, `get_ipython`, … tracked in the
 * shell's `user_ns_hidden` and still bound to the object IPython installed)
 * reaches unpicklable kernel machinery — e.g. the history manager's
 * sqlite3.Connection — and is never restored as program state anyway. Shim
 * names (any `_dashr`/`__dashr` spelling) are excluded by prefix.
 *
 * Size-cap policy (M3-B, blueprint §8.3): dill cannot report a serialized
 * size before dumping, and a GB-sized `DataFrame` dumped EVERY turn is the IO
 * storm the cap exists to stop. The cell therefore gates in two tiers:
 * first a bounded-depth namespace walk estimates the footprint (counting
 * container lengths and reading `nbytes` / `memory_usage(deep=True)` for
 * numpy/pandas objects — the stated pathological case — so the dump is
 * skipped BEFORE any dill IO), then the actual dump goes to a sibling
 * `.part` file whose true byte size is measured before it replaces the
 * previous good snapshot. Skipped snapshots leave the previous
 * `state.dill` + manifest untouched, so a revive restores the last good turn.
 * @param payloadPath - absolute path for the dill payload.
 * @param manifestPath - absolute path for the JSON manifest.
 * @param spec - turn counter, skills list, and the size cap.
 * @param sentinel - per-cell nonce prefix for the outcome envelope.
 * @returns the complete cell source.
 */
export function buildSnapshotCell(payloadPath: string, manifestPath: string, spec: SnapshotSpec, sentinel: string): string {
  // Bracketed by the same SIGALRM busy guard as a run cell: a timed-out
  // snapshot (e.g. dill stuck on a pathological object graph) must be
  // breakable by the host's interrupt ladder exactly like user code.
  return [
    `_dashr_state['executing'] = True`,
    `try:`,
    `    import dill as _dashr_dill, json as _dashr_json, platform as _dashr_platform`,
    `    import os as _dashr_os, sys as _dashr_sys, datetime as _dashr_dt`,
    `    _dashr_shell = globals().get('get_ipython', lambda: None)()`,
    `    _dashr_hidden = getattr(_dashr_shell, 'user_ns_hidden', None) or {}`,
    `    _dashr_user_ns = {`,
    `        name: value`,
    `        for name, value in globals().items()`,
    `        if not name.lower().startswith(('_dashr', '__dashr'))`,
    `        and (name not in _dashr_hidden or _dashr_hidden[name] is not value)`,
    `    }`,
    `    _dashr_cap = ${JSON.stringify(spec.sizeCapBytes)}`,
    `    def _dashr_estimate(value, depth):`,
    `        if value is None or isinstance(value, (bool, int, float, complex)):`,
    `            return 32`,
    `        if isinstance(value, (str, bytes, bytearray)):`,
    `            return len(value) + 64`,
    `        if isinstance(value, (list, tuple, set, frozenset)):`,
    `            if depth <= 0:`,
    `                return 4096`,
    `            return 64 + sum(_dashr_estimate(item, depth - 1) for item in value)`,
    `        if isinstance(value, dict):`,
    `            if depth <= 0:`,
    `                return 4096`,
    `            total = 64`,
    `            for key, item in value.items():`,
    `                total += _dashr_estimate(key, depth - 1)`,
    `                total += _dashr_estimate(item, depth - 1)`,
    `                if total > _dashr_cap:`,
    `                    return total`,
    `            return total`,
    `        _dashr_nbytes = getattr(value, 'nbytes', None)`,
    `        if isinstance(_dashr_nbytes, int) and _dashr_nbytes > 0:`,
    `            return _dashr_nbytes + 128`,
    `        _dashr_mem = getattr(value, 'memory_usage', None)`,
    `        if callable(_dashr_mem):`,
    `            try:`,
    `                _dashr_usage = _dashr_mem(deep=True)`,
    `                _dashr_sum = getattr(_dashr_usage, 'sum', None)`,
    `                if callable(_dashr_sum):`,
    `                    # pandas returns a numpy scalar (np.int64), which is`,
    `                    # not a Python int subclass; coerce, don't isinstance.`,
    `                    _dashr_n = int(_dashr_sum())`,
    `                    if _dashr_n > 0:`,
    `                        return _dashr_n + 128`,
    `            except Exception:`,
    `                pass`,
    `        return 4096`,
    `    _dashr_estimate_bytes = sum(_dashr_estimate(value, 4) for value in _dashr_user_ns.values())`,
    `    if _dashr_estimate_bytes > _dashr_cap:`,
    `        print(${JSON.stringify(sentinel)} + _dashr_json.dumps({`,
    `            'ok': False, 'skipped': True, 'reason': 'estimate',`,
    `            'estimateBytes': _dashr_estimate_bytes, 'capBytes': _dashr_cap,`,
    `        }))`,
    `    else:`,
    `        _dashr_part = ${JSON.stringify(payloadPath)} + '.part'`,
    `        try:`,
    `            with open(_dashr_part, 'wb') as _dashr_f:`,
    `                _dashr_dill.dump(_dashr_user_ns, _dashr_f)`,
    `            _dashr_size = _dashr_os.path.getsize(_dashr_part)`,
    `            if _dashr_size > _dashr_cap:`,
    `                print(${JSON.stringify(sentinel)} + _dashr_json.dumps({`,
    `                    'ok': False, 'skipped': True, 'reason': 'actual',`,
    `                    'sizeBytes': _dashr_size, 'capBytes': _dashr_cap,`,
    `                }))`,
    `            else:`,
    `                _dashr_os.replace(_dashr_part, ${JSON.stringify(payloadPath)})`,
    `                _dashr_manifest = {`,
    `                    'snapshotFormat': 1,`,
    `                    'turn': ${JSON.stringify(spec.turn)},`,
    `                    'pythonVersion': _dashr_platform.python_version(),`,
    `                    'venvPath': _dashr_sys.executable,`,
    `                    'skills': ${JSON.stringify(spec.skills)},`,
    `                    'names': sorted(_dashr_user_ns),`,
    `                    'sizeBytes': _dashr_size,`,
    `                    'skipped': False,`,
    `                    'createdAt': _dashr_dt.datetime.now(_dashr_dt.timezone.utc).isoformat(),`,
    `                }`,
    `                with open(${JSON.stringify(manifestPath)}, 'w', encoding='utf-8') as _dashr_f:`,
    `                    _dashr_json.dump(_dashr_manifest, _dashr_f)`,
    `                print(${JSON.stringify(sentinel)} + _dashr_json.dumps({`,
    `                    'ok': True, 'sizeBytes': _dashr_size, 'names': len(_dashr_user_ns),`,
    `                }))`,
    `        finally:`,
    `            if _dashr_os.path.exists(_dashr_part):`,
    `                try:`,
    `                    _dashr_os.unlink(_dashr_part)`,
    `                except OSError:`,
    `                    pass`,
    `finally:`,
    `    _dashr_state['executing'] = False`,
  ].join('\n')
}

/**
 * Build the internal cell that restores a dill snapshot into the user
 * namespace. The kernel validates the manifest ITSELF (it is the only party
 * that knows its own python version and `sys.executable`): a python-version
 * mismatch, a different interpreter (`venvPath`), a non-empty skills list, or
 * an unreadable/corrupt payload degrades to an empty namespace WITHOUT
 * touching globals, and reports the reason through the envelope so the host
 * can tell the model "snapshot not replayable, started from empty". Shim and
 * IPython-hidden names are re-filtered on the way in — the same exclusion the
 * snapshot applied on the way out, applied again defensively.
 * @param payloadPath - absolute path of the dill payload.
 * @param manifestPath - absolute path of the JSON manifest.
 * @param sentinel - per-cell nonce prefix for the outcome envelope.
 * @returns the complete cell source.
 */
export function buildRestoreCell(payloadPath: string, manifestPath: string, sentinel: string): string {
  return [
    `_dashr_state['executing'] = True`,
    `try:`,
    `    import dill as _dashr_dill, json as _dashr_json, platform as _dashr_platform`,
    `    import os as _dashr_os, sys as _dashr_sys`,
    `    _dashr_manifest = None`,
    `    _dashr_reason = 'snapshot manifest could not be read'`,
    `    try:`,
    `        with open(${JSON.stringify(manifestPath)}, 'r', encoding='utf-8') as _dashr_f:`,
    `            _dashr_manifest = _dashr_json.load(_dashr_f)`,
    `    except Exception as _dashr_err:`,
    `        _dashr_reason = 'snapshot manifest could not be read: ' + repr(_dashr_err)`,
    `    if _dashr_manifest is None:`,
    `        print(${JSON.stringify(sentinel)} + _dashr_json.dumps({'ok': False, 'reason': _dashr_reason}))`,
    `    elif _dashr_manifest.get('snapshotFormat') != 1:`,
    `        print(${JSON.stringify(sentinel)} + _dashr_json.dumps({'ok': False, 'reason': 'snapshot format is not replayable'}))`,
    `    elif _dashr_manifest.get('skipped'):`,
    `        print(${JSON.stringify(sentinel)} + _dashr_json.dumps({'ok': False, 'reason': 'snapshot was skipped (namespace exceeded the size cap)'}))`,
    `    elif _dashr_manifest.get('pythonVersion') != _dashr_platform.python_version():`,
    `        print(${JSON.stringify(sentinel)} + _dashr_json.dumps({'ok': False, 'reason': 'python version mismatch: snapshot ' + str(_dashr_manifest.get('pythonVersion')) + ' vs kernel ' + _dashr_platform.python_version()}))`,
    `    elif _dashr_os.path.realpath(_dashr_manifest.get('venvPath') or '') != _dashr_os.path.realpath(_dashr_sys.executable):`,
    `        print(${JSON.stringify(sentinel)} + _dashr_json.dumps({'ok': False, 'reason': 'kernel interpreter differs from the snapshot venv'}))`,
    `    elif _dashr_manifest.get('skills'):`,
    `        print(${JSON.stringify(sentinel)} + _dashr_json.dumps({'ok': False, 'reason': 'snapshot skills are not replayable in this provider'}))`,
    `    else:`,
    `        try:`,
    `            with open(${JSON.stringify(payloadPath)}, 'rb') as _dashr_f:`,
    `                _dashr_restored = _dashr_dill.load(_dashr_f)`,
    `        except Exception as _dashr_err:`,
    `            _dashr_restored = None`,
    `            _dashr_reason = 'snapshot payload could not be loaded: ' + repr(_dashr_err)`,
    `        if not isinstance(_dashr_restored, dict):`,
    `            print(${JSON.stringify(sentinel)} + _dashr_json.dumps({'ok': False, 'reason': _dashr_reason if _dashr_restored is None else 'snapshot payload is not a namespace dict'}))`,
    `        else:`,
    `            _dashr_shell = globals().get('get_ipython', lambda: None)()`,
    `            _dashr_hidden = getattr(_dashr_shell, 'user_ns_hidden', None) or {}`,
    `            _dashr_user_ns = globals()`,
    `            _dashr_restored_count = 0`,
    `            for _dashr_name, _dashr_value in _dashr_restored.items():`,
    `                if not isinstance(_dashr_name, str):`,
    `                    continue`,
    `                if _dashr_name.lower().startswith(('_dashr', '__dashr')):`,
    `                    continue`,
    `                if _dashr_name in _dashr_hidden and _dashr_hidden[_dashr_name] is _dashr_value:`,
    `                    continue`,
    `                _dashr_user_ns[_dashr_name] = _dashr_value`,
    `                _dashr_restored_count += 1`,
    `            print(${JSON.stringify(sentinel)} + _dashr_json.dumps({'ok': True, 'restored': _dashr_restored_count}))`,
    `finally:`,
    `    _dashr_state['executing'] = False`,
  ].join('\n')
}
