/**
 * Python-side bootstrap executed once as an internal cell right after kernel
 * startup. Seeds the user namespace with the host-request comm bridge
 * (`dashr.host` target, the PA `host_request()` pattern), the binding-proxy
 * factories, the typed rejection classes, and the lossless-JSON completion
 * encoder. Names are `_dashr`/`__dashr` prefixed (any case) so they are
 * excluded from namespace snapshots and never leak into user state.
 * @module dashr/bootstrap
 */

/** Comm target the kernel-side shim opens for typed host requests. */
export const HOST_COMM_TARGET = 'dashr.host'

/**
 * The bootstrap source. Kept dependency-free apart from `ast`, `asyncio`,
 * `json`, and `comm` (present by construction — it IS the kernel).
 */
export const KERNEL_BOOTSTRAP = `
import ast as _dashr_ast
import json as _dashr_json


def _dashr_install_control_comm_handlers():
    # Host replies arrive as comm_msg on the CONTROL channel while the shell
    # channel is busy executing our cell; teach the kernel to route them.
    try:
        from IPython import get_ipython
    except Exception:
        return
    shell = get_ipython()
    kernel = getattr(shell, 'kernel', None)
    comm_manager = getattr(kernel, 'comm_manager', None)
    control_handlers = getattr(kernel, 'control_handlers', None)
    if comm_manager is None or not isinstance(control_handlers, dict):
        return
    control_handlers.setdefault('comm_msg', comm_manager.comm_msg)
    control_handlers.setdefault('comm_close', comm_manager.comm_close)


def _dashr_install_interrupt():
    # ipykernel's async-cell SIGINT handling only schedules a callback on the
    # kernel event loop, and a non-yielding cell ('while True: pass') blocks
    # that very loop, so the control-channel interrupt can never break it.
    # SIGALRM is untouched by ipykernel: raising KeyboardInterrupt from its
    # handler breaks any cell, and the host sends it (after a confirm window,
    # see the bridge) on timeout/abort. Best effort — where SIGALRM is
    # unavailable the control-channel interrupt is all there is.
    #
    # The busy guard is load-bearing (M3-A, blueprint §5 "SIGALRM-at-idle 双重
    # 窗口"): a KeyboardInterrupt raised OUTSIDE cell execution — while the
    # kernel boots, idles between cells, or unwinds a finished one — escapes
    # the shell's containment and terminates the process cleanly, which used
    # to kill the kernel deterministically (10/10 same-tick aborts, 40/40
    # during cold boot; dev/m2a-report.md §5.1). The handler therefore only
    # raises while a dashr cell is actually executing, tracked by the
    # module-level _dashr_state dict below and set/cleared by the run/snapshot
    # cell scaffolds around their whole body. A stray SIGALRM outside that
    # window is swallowed — the host's force-settle already resolves the run,
    # and the kernel lives. The dict (not a bare flag) is captured by the
    # handler closure, so user code rebinding the NAME cannot disarm the
    # guard; mutating the dict itself stays possible and accepted — this shim
    # is a capability seam, not a security boundary.
    try:
        import signal as _dashr_signal

        def _dashr_on_sigalrm(_signum, _frame):
            if not _dashr_state['executing']:
                return
            raise KeyboardInterrupt

        _dashr_signal.signal(_dashr_signal.SIGALRM, _dashr_on_sigalrm)
    except (ImportError, AttributeError, OSError, ValueError):
        pass


# The dashr busy-guard flag (see _dashr_install_interrupt): True for the whole
# duration of a run or snapshot cell — the only window in which a SIGALRM may
# raise KeyboardInterrupt. Lives at module (user-namespace) level so the cell
# scaffolds can flip it; excluded from snapshots by the _dashr prefix rule.
_dashr_state = {'executing': False}


_dashr_install_interrupt()


class _DashrRejected(Exception):
    def __init__(self, message):
        Exception.__init__(self, message)


def _dashr_host_request(payload):
    from comm import create_comm
    import asyncio
    _dashr_install_control_comm_handlers()
    loop = asyncio.get_running_loop()
    future = loop.create_future()
    # primary=True publishes comm_open so the host learns this comm_id; the
    # request itself travels as the first comm_msg.
    comm = create_comm(target_name=${JSON.stringify(HOST_COMM_TARGET)})

    def _resolve(action):
        def _apply():
            if future.done():
                return
            action()
            comm.close()
        # Replies arrive on the kernel's control channel, which may run off
        # the event-loop thread; only call_soon_threadsafe may touch the
        # future from there.
        loop.call_soon_threadsafe(_apply)

    def _on_msg(msg):
        content = msg.get('content', {})
        reply = content.get('data', {}) if isinstance(content, dict) else {}
        if not isinstance(reply, dict) or future.done():
            return
        status = reply.get('status')
        if status == 'ok':
            _resolve(lambda: future.set_result(reply.get('result')))
        elif status == 'error':
            _resolve(lambda: future.set_exception(_DashrRejected(reply.get('error') or 'host request failed')))

    comm.on_msg(_on_msg)
    comm.send(dict(payload))
    return future


def _dashr_make_error_class(name, member_property):
    def _init(self, message, member=None):
        Exception.__init__(self, message)
        if member is not None:
            setattr(self, member_property, member)
    return type(name, (Exception,), {'__init__': _init})


def _dashr_make_proxy(global_name, function_name, error_class_name, member_property):
    async def _dashr_proxy(*args, **kwargs):
        if kwargs:
            raise TypeError('dashr binding calls do not accept keyword arguments')
        if len(args) == 1:
            call_args = args[0]
        elif len(args) == 0:
            call_args = None
        else:
            call_args = list(args)
        payload = {
            'type': 'binding.call',
            'global': global_name,
            'name': function_name,
            'args': call_args,
        }
        try:
            return await _dashr_host_request(payload)
        except _DashrRejected as rejected:
            cls = globals().get(error_class_name) if error_class_name else None
            if cls is None:
                raise
            raise cls(str(rejected), function_name) from None
    return _dashr_proxy


def _dashr_make_holder(global_name, error_class_name, member_property):
    # Attribute misses travel to the host instead of raising AttributeError
    # here: the host owns the namespace, so IT rejects an unknown member as an
    # unknown binding rather than the kernel inventing a local error class.
    class _DashrBindingHolder:
        def __getattr__(self, function_name):
            return _dashr_make_proxy(
                global_name,
                function_name,
                error_class_name,
                member_property,
            )

    return _DashrBindingHolder()


def _dashr_make_callable(global_name, function_name, error_class_name, member_property):
    # A BARE callable global (the flat per-tool bindings AND the bridge
    # tools: 'callable: true' on the namespace) instead of an object
    # holder. The one-object form is the single convention: every callable
    # takes exactly one positional arguments object (e.g.
    # rlm({'mode': 'spawn', ...})), and keyword / multi-positional forms are
    # rejected HERE, at the Python call boundary, so the introspectable
    # signature tells the truth and a TypeError names the binding global
    # (read(...) got an unexpected keyword argument ...). The wire envelope
    # keeps the historical {'args': [...], 'kwargs': {}} shape so the host's
    # parseRlmCall / flatToolArgs / flatBridgeToolArgs validation layers stay
    # authoritative and unchanged. The single functions-entry name is
    # transport-only: the program never sees it, and a typed rejection
    # carries the GLOBAL name as its member (for a flat tool binding the
    # global IS the tool name the program knows). __name__/__qualname__ are
    # pinned to the global name so introspection shows the binding's name,
    # not the factory-local _dashr_callable.
    async def _dashr_callable(args=None, /):
        payload = {
            'type': 'binding.call',
            'global': global_name,
            'name': function_name,
            'args': {'args': [] if args is None else [args], 'kwargs': {}},
        }
        try:
            return await _dashr_host_request(payload)
        except _DashrRejected as rejected:
            cls = globals().get(error_class_name) if error_class_name else None
            if cls is None:
                raise
            raise cls(str(rejected), global_name) from None

    _dashr_callable.__name__ = global_name
    _dashr_callable.__qualname__ = global_name
    return _dashr_callable


class _DashrNoValue:
    # Marks 'no completion value': a cell whose last statement is not an
    # expression, or whose last expression evaluates to None — the REPL
    # displayhook suppresses None (IPython behavior), so no value crosses.
    __slots__ = ()


_DASHR_NO_VALUE = _DashrNoValue()


class _DashrTopLevelReturnChecker(_dashr_ast.NodeVisitor):
    # A cell runs at module scope, like any native IPython cell: a top-level
    # 'return'/'yield' is a SyntaxError decided by the kernel itself, exactly
    # as in a real REPL. Nested scopes (functions, lambdas, classes) keep
    # their own return semantics.
    def visit_FunctionDef(self, node):
        return

    def visit_AsyncFunctionDef(self, node):
        return

    def visit_ClassDef(self, node):
        return

    def visit_Lambda(self, node):
        return

    def visit_Return(self, node):
        raise SyntaxError("'return' outside function")

    def visit_Yield(self, node):
        raise SyntaxError("'yield' outside function")


async def _dashr_run_program(source):
    # Run one cell with the user namespace as BOTH globals and locals —
    # module-scope REPL semantics: state persists across cells, top-level
    # 'await' is legal (PyCF_ALLOW_TOP_LEVEL_AWAIT, the same mechanism IPython
    # uses), a top-level 'return'/'yield' is a SyntaxError decided here by the
    # kernel — exactly as in a native IPython cell — and the last expression's
    # value is the cell's result (the REPL displayhook handoff).
    import inspect as _dashr_inspect
    user_ns = globals()
    if not source.strip():
        source = 'pass'
    parsed = _dashr_ast.parse(source, '<dashr program>', 'exec')
    _DashrTopLevelReturnChecker().visit(parsed)
    body = parsed.body
    if body and isinstance(body[-1], _dashr_ast.Expr):
        # Capture the last expression the way a REPL's displayhook shows it:
        # its value feeds the completion envelope instead of being discarded.
        # The name is distinct from the scaffold's __dashr_completion__ (the
        # envelope holder) so a statement-ending cell can never pop a stale
        # envelope left by an earlier run.
        last = body[-1]
        body[-1] = _dashr_ast.Assign(
            targets=[_dashr_ast.Name(id='__dashr_cell_value__', ctx=_dashr_ast.Store())],
            value=last.value,
        )
        _dashr_ast.fix_missing_locations(body[-1])
    code = compile(
        parsed,
        '<dashr program>',
        'exec',
        flags=_dashr_ast.PyCF_ALLOW_TOP_LEVEL_AWAIT,
    )
    # IPython's own run_code pattern: with PyCF_ALLOW_TOP_LEVEL_AWAIT, plain
    # exec() DISCARDS the module coroutine silently; eval() under await
    # returns it and runs the code (IPython InteractiveShell.run_code does
    # exactly 'await eval(code_obj, user_global_ns, user_ns)').
    result = eval(code, user_ns, user_ns)
    if _dashr_inspect.iscoroutine(result):
        await result
    value = user_ns.pop('__dashr_cell_value__', _DASHR_NO_VALUE)
    if value is None:
        return _DASHR_NO_VALUE
    return value


def _dashr_install_bindings(spec_json):
    spec = _dashr_json.loads(spec_json)
    user_ns = globals()
    injected = user_ns.get('__dashr_injected__', {})
    for old_name, old_spec in list(injected.items()):
        if old_name not in spec:
            user_ns.pop(old_name, None)
            if old_spec.get('errorClass'):
                user_ns.pop(old_spec['errorClass']['name'], None)
    fresh = {}
    # The flat per-tool shape declares the SAME error class on many
    # namespaces: materialize each DISTINCT name once, so every proxy's
    # raise-time globals() lookup finds ONE class and a single
    # 'except ToolCallError' catches failures from every binding.
    error_classes = {}
    for global_name, namespace in spec.items():
        error_class = namespace.get('errorClass')
        if namespace.get('callable'):
            # Exactly one function entry was validated by the host; its key is
            # the transport name, the bare global itself is the callable.
            function_name = next(iter(namespace['functions']))
            user_ns[global_name] = _dashr_make_callable(
                global_name,
                function_name,
                error_class['name'] if error_class else None,
                error_class['memberNameProperty'] if error_class else None,
            )
        else:
            user_ns[global_name] = _dashr_make_holder(
                global_name,
                error_class['name'] if error_class else None,
                error_class['memberNameProperty'] if error_class else None,
            )
        if error_class and error_class['name'] not in error_classes:
            cls = _dashr_make_error_class(
                error_class['name'],
                error_class['memberNameProperty'],
            )
            error_classes[error_class['name']] = cls
            user_ns[error_class['name']] = cls
        fresh[global_name] = namespace
    user_ns['__dashr_injected__'] = fresh


def _dashr_encode(value):
    if value is _DASHR_NO_VALUE:
        return {'ok': True}
    try:
        return {'ok': True, 'json': _dashr_json.dumps(value, allow_nan=False)}
    except (TypeError, ValueError, OverflowError):
        # Not lossless JSON: pass its repr TEXT through instead of failing
        # the cell. The upstream renders the tool result as text either way,
        # so a non-JSON value costs the model nothing; the host keeps a
        # plain string it forwards untouched. The envelope itself never
        # fails, so the completion never gate-rejects a return value.
        return {'ok': True, 'json': _dashr_json.dumps(repr(value))}
`
