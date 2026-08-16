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
 * `json`, and `ipykernel.comm` (present by construction — it IS the kernel).
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
    from ipykernel.comm import Comm
    import asyncio
    _dashr_install_control_comm_handlers()
    loop = asyncio.get_running_loop()
    future = loop.create_future()
    # primary=True publishes comm_open so the host learns this comm_id; the
    # request itself travels as the first comm_msg.
    comm = Comm(target_name=${JSON.stringify(HOST_COMM_TARGET)})

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
    # A BARE callable global (M3-B rlm()/rlm_await(): 'callable: true' on the
    # namespace) instead of an object holder. Unlike member proxies, a
    # callable global may receive keyword arguments (rlm(prompt, *, label=…)),
    # so the call is packaged uniformly as {'args': [...], 'kwargs': {...}}
    # and the HOST binding function owns the signature validation — the same
    # "the host owns the namespace" rule as attribute misses above. The single
    # functions-entry name is transport-only: the program never sees it.
    async def _dashr_callable(*args, **kwargs):
        payload = {
            'type': 'binding.call',
            'global': global_name,
            'name': function_name,
            'args': {'args': list(args), 'kwargs': kwargs},
        }
        try:
            return await _dashr_host_request(payload)
        except _DashrRejected as rejected:
            cls = globals().get(error_class_name) if error_class_name else None
            if cls is None:
                raise
            raise cls(str(rejected), function_name) from None

    return _dashr_callable


class _DashrReturn(BaseException):
    # BaseException so a program's own 'except Exception' cannot swallow a
    # top-level 'return' the way it could swallow an ordinary exception.
    def __init__(self, value):
        BaseException.__init__(self)
        self.value = value


class _DashrNoValue:
    # Distinguishes 'no top-level return executed' (this sentinel) from an
    # explicit 'return None' (real None) so the host can keep an absent
    # completion value and an explicit JSON null apart.
    __slots__ = ()


_DASHR_NO_VALUE = _DashrNoValue()


class _DashrReturnRewriter(_dashr_ast.NodeTransformer):
    # Rewrites program-depth 'return' into the sentinel raise; nested scopes
    # (functions, lambdas, classes) keep their own return semantics.
    def visit_FunctionDef(self, node):
        return node

    def visit_AsyncFunctionDef(self, node):
        return node

    def visit_ClassDef(self, node):
        return node

    def visit_Lambda(self, node):
        return node

    def visit_Return(self, node):
        value = node.value if node.value is not None else _dashr_ast.Constant(None)
        return [
            _dashr_ast.Raise(
                exc=_dashr_ast.Call(
                    func=_dashr_ast.Name(id='_DashrReturn', ctx=_dashr_ast.Load()),
                    args=[value],
                    keywords=[],
                )
            )
        ]


def _dashr_indent(source):
    # Indent every physical line for the __dashr_body__ scaffold EXCEPT the
    # continuation rows of tokens that span lines — only multi-line string
    # literals qualify, and their interior rows must keep their exact bytes or
    # the literal's content silently changes. Prefixing any other physical row
    # only adds whitespace between tokens (statement heads, bracketed or
    # backslash continuations), which Python ignores.
    import io as _dashr_io
    import tokenize as _dashr_tokenize
    no_indent = set()
    try:
        for token in _dashr_tokenize.generate_tokens(_dashr_io.StringIO(source).readline):
            if token.end[0] > token.start[0]:
                no_indent.update(range(token.start[0] + 1, token.end[0] + 1))
    except Exception:
        # Unparseable program: fall back to the plain indent; the parse below
        # reports the SyntaxError either way.
        no_indent.clear()
    return ''.join(
        ('' if row in no_indent else '    ') + line + '\\n'
        for row, line in enumerate(source.splitlines(), start=1)
    )


async def _dashr_run_program(source):
    # Run one program with the user namespace as BOTH globals and locals —
    # REPL semantics, so 'count = count + ...' reads state left by earlier
    # runs even though this program assigns the same name (a real function
    # body would make it an unbound local). Compiled with top-level await
    # allowed, exec hands back a coroutine when the program awaits.
    import inspect as _dashr_inspect
    user_ns = globals()
    if not source.strip():
        source = 'pass'
    parsed = _dashr_ast.parse('async def __dashr_body__():' + chr(10) + _dashr_indent(source))
    rewriter = _DashrReturnRewriter()
    body = []
    for statement in parsed.body[0].body:
        rewritten = rewriter.visit(statement)
        body.extend(rewritten if isinstance(rewritten, list) else [rewritten])
    if not body:
        body = [_dashr_ast.Pass()]
    module = _dashr_ast.Module(body=body, type_ignores=[])
    _dashr_ast.fix_missing_locations(module)
    code = compile(
        module,
        '<dashr program>',
        'exec',
        flags=_dashr_ast.PyCF_ALLOW_TOP_LEVEL_AWAIT,
    )
    # The rewriter already unwrapped the 'async def' — module body IS the
    # program's statements, REPL semantics via user_ns as globals AND locals.
    # IPython's own run_code pattern: with PyCF_ALLOW_TOP_LEVEL_AWAIT, plain
    # exec() DISCARDS the module coroutine silently; eval() under await
    # returns it and runs the code (IPython InteractiveShell.run_code does
    # exactly 'await eval(code_obj, user_global_ns, user_ns)').
    try:
        result = eval(code, user_ns, user_ns)
        if _dashr_inspect.iscoroutine(result):
            await result
    except _DashrReturn as returned:
        return returned.value
    return _DASHR_NO_VALUE


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
        if error_class:
            user_ns[error_class['name']] = _dashr_make_error_class(
                error_class['name'],
                error_class['memberNameProperty'],
            )
        fresh[global_name] = namespace
    user_ns['__dashr_injected__'] = fresh


def _dashr_encode(value):
    if value is _DASHR_NO_VALUE:
        return {'ok': True}
    try:
        return {'ok': True, 'json': _dashr_json.dumps(value, allow_nan=False)}
    except (TypeError, ValueError, OverflowError):
        return {'ok': False}
`
