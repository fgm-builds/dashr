/**
 * Dasher Code Mode codegen — Python flavor, cell edition.
 *
 * The pure projection from one calling scope's visible tool schemas to the
 * Python SDK text the model programs against inside `run_cell` cells. Ported
 * from `@deepseek-ai/dsh-tools` `py-types.ts` (0.1.0-rc.6) per blueprint
 * §7.4, deliberately slimmed to Dasher's single-language, stateful surface:
 *
 * - The usage instructions are OURS, not upstream's: upstream promises a
 *   one-shot program ("runs as the body of an async function", value-less
 *   between calls), while a Dasher cell runs on a PERSISTENT kernel whose
 *   variables, imports, and definitions survive across `run_cell` calls.
 *   The prose here must never state the throwaway contract.
 * - No language table and no context-free renderer: Dasher renders Python
 *   only, and object shapes always render through the named-`TypedDict`
 *   path this module owns. (Upstream's exported `jsonSchemaToPy` degrades
 *   every object to `dict[str, Any]`; reusing it would lose the shape.)
 * - The bare-identifier rule, `camelCase` derivation, class-name capping
 *   and collision suffixing, `typing` import emission, and the
 *   deterministic lexicographic member order are ported near-verbatim: the
 *   parseability invariants (NFKC stability, reserved words, unprintable
 *   escapes, bracket-nesting cap) exist because the emitted block is the
 *   model's ONLY declaration of the tools, and a syntax error in it poisons
 *   the whole mode.
 * @module dashr-tool-presentation/py-sdk
 */

import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import type { JsonSchemaNode, JsonSchemaScalar } from '@deepseek-ai/dsh-tools'

/**
 * One tool as the SDK renderer sees it: the model-facing schema
 * (name/description/parameters) plus the tool's canonical output schema.
 * The caller (the presentation plugin) excludes `run_cell` itself and reads
 * both through the tool registry's public projection APIs.
 */
export interface DasherSdkSchema {
  /** Tool name as registered (may be exotic; the renderer routes those to subscript comments). */
  readonly name: string
  /** Tool description, rendered as the method docstring. */
  readonly description: string
  /** Validated JSON-Schema node for the arguments object. */
  readonly parameters: unknown
  /** Validated JSON-Schema node for the canonical output value. */
  readonly output: unknown
}

/**
 * The reference grammar's `xid_start xid_continue*` — the set
 * `str.isidentifier()` accepts on a CPython whose Unicode tables match the
 * engine's. See {@link isBareIdentifier} for the version-skew stance.
 */
const IDENTIFIER = /^[\p{XID_Start}_]\p{XID_Continue}*$/u

/**
 * Whether a name can be emitted as a bare Python identifier rather than
 * routed to the subscript/`dict[str, Any]` path. Two conditions, both
 * ported from upstream `py-types.ts`:
 *
 * 1. `IDENTIFIER` matches — Python identifiers are not ASCII (`路径` is a
 *    legal field name), and rejecting such a name would degrade the whole
 *    enclosing object, dropping every field's name, requiredness, and type.
 * 2. NFKC stability (`name.normalize('NFKC') === name`) — CPython normalizes
 *    identifiers at compile time while JSON keys are compared as written, so
 *    an unstable name (`ﬁeld`) would be advertised under a spelling the
 *    harness never accepts.
 *
 * Both conditions are evaluated against the ENGINE's tables; a CPython older
 * than the engine could reject a character this accepts (the dangerous
 * direction — the tokenizer refuses the character and the whole SDK block
 * goes down). Dasher targets the kernel venv shipped with the runtime
 * (`npm run kernel:venv`, Python 3.11), which tracks modern CPython; the
 * residual skew is accepted rather than carrying upstream's deferred
 * target-interpreter-version plumbing.
 */
function isBareIdentifier(name: string): boolean {
  return IDENTIFIER.test(name) && name.normalize('NFKC') === name
}

/**
 * Python hard keywords: reserved everywhere, so a tool or field named
 * `class` or `lambda` is legal on the wire but not as an attribute
 * (`tools.class` would be a `SyntaxError`) and not as a class-syntax
 * `TypedDict` field. Such tools render under subscript access and such
 * objects degrade to `dict[str, Any]`. Soft keywords (`match`, `case`,
 * `type`, `_`) are deliberately absent (each is special in exactly one
 * syntactic position); `__debug__` joins as a compile-time assignment
 * refusal. Ported verbatim from upstream.
 */
const RESERVED = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class',
  'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global',
  'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise',
  'return', 'try', 'while', 'with', 'yield',
  '__debug__',
])

/** `typing` symbols this module may emit, in the deterministic import order. */
const TYPING_ORDER = ['Any', 'Literal', 'NotRequired', 'Protocol', 'TypedDict'] as const

/** `indent`-deep line prefix (four spaces per level, PEP 8). */
function pad(indent: number): string {
  return '    '.repeat(indent)
}

/**
 * Collector threaded through {@link renderType}: the emitted `TypedDict`
 * declarations (nested classes precede the parent referencing them), taken
 * class names (collision suffixing), a per-base collision counter, and the
 * `typing` symbols actually used.
 */
interface RenderState {
  readonly classes: string[]
  readonly usedClassNames: Set<string>
  readonly nextClassCounter: Map<string, number>
  readonly typing: Set<string>
}

/**
 * The `Cc` code points with no printable form (C0, DEL, C1): CPython rejects
 * NUL anywhere in source and the rest are invisible, so one `\xNN` escape
 * form (covering U+0000–U+00FF exactly) keeps the SDK parseable and readable.
 * Ported from upstream.
 */
const UNPRINTABLE = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g

/**
 * Unpaired surrogate code points, escaped as `\uNNNN`: Python source must be
 * UTF-8-encodable and a lone surrogate is not, so `compile()` raises for one
 * anywhere in the text. Reachable from a wire description carrying `"\ud800"`.
 */
const LONE_SURROGATE = /[\ud800-\udfff]/gu

/**
 * The collapsed one-line `description` of a schema node, or `undefined` when
 * the node carries none that survives collapsing. Control characters left
 * after the whitespace collapse render as `\xNN` / `\uNNNN` escapes so the
 * emitted block stays valid Python.
 */
function describe(schema: object): string | undefined {
  const description = (schema as Record<string, unknown>).description
  if (typeof description !== 'string') return undefined
  const collapsed = description
    .replace(/\s+/g, ' ')
    .replace(UNPRINTABLE, char => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`)
    .replace(LONE_SURROGATE, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .trim()
  return collapsed.length === 0 ? undefined : collapsed
}

/**
 * One-line docstring for a tool `description`, or no lines when there is
 * none. Backslashes are doubled and quotes escaped so a description ending
 * in `"` or an odd backslash cannot merge with the closing triple quote and
 * make the SDK syntactically invalid.
 */
function docLines(description: unknown, indent: number): string[] {
  const collapsed = describe({ description })
  if (collapsed === undefined) return []
  const escaped = collapsed.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  return [`${pad(indent)}"""${escaped}"""`]
}

/**
 * CamelCase a name into a Python type identifier: non-identifier characters
 * and `_` split words, a head that cannot start an identifier takes a
 * `Tool` prefix, and the result is NFKC-normalized so what CPython compiles
 * is identical to what is emitted. Ported from upstream.
 */
function camelCase(raw: string): string {
  const joined = raw
    .split(/[^\p{XID_Continue}]+|_+/u)
    .filter(part => part.length > 0)
    .map(part => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('')
    .normalize('NFKC')
  return (/^\p{XID_Start}/u.test(joined) ? joined : `Tool${joined}`).normalize('NFKC')
}

/** Class-name base cap keeping each emitted name — and total text — linear in schema depth. */
const MAX_CLASS_NAME_BASE = 120

/**
 * Deepest `list[…]` nesting emitted into one annotation before the item type
 * degrades to `Any`: CPython's tokenizer rejects more than 200 simultaneously
 * open brackets, and an array chain deeper than this would render an SDK block
 * that is not valid Python at all.
 */
const MAX_LIST_NESTING = 180

/**
 * Cap a class-name base at {@link MAX_CLASS_NAME_BASE}. `slice` counts UTF-16
 * code units, so an astral character straddling the boundary would leave a
 * lone surrogate; drop it rather than emit it.
 */
function capClassNameBase(base: string): string {
  if (base.length <= MAX_CLASS_NAME_BASE) return base
  const capped = base.slice(0, MAX_CLASS_NAME_BASE)
  return /[\uD800-\uDBFF]$/.test(capped) ? capped.slice(0, -1) : capped
}

/**
 * Reserve a unique class name from a base, suffixing `2`, `3`, … on
 * collision; the per-base counter keeps a deep chain sharing one capped base
 * amortized O(1) instead of rescanning from `2`.
 */
function allocateClassName(base: string, state: RenderState): string {
  const capped = capClassNameBase(base)
  let name = capped
  if (state.usedClassNames.has(name)) {
    let n = state.nextClassCounter.get(capped) ?? 2
    while (state.usedClassNames.has(`${capped}${n}`)) n++
    name = `${capped}${n}`
    state.nextClassCounter.set(capped, n + 1)
  }
  state.usedClassNames.add(name)
  return name
}

/**
 * Append a child-name segment to a parent class-name base, capping at
 * propagation so each level stays O(1) and normalizing the join (Hangul jamo
 * composition at the seam) so the emitted name is the symbol CPython sees.
 */
function childClassName(base: string, segment: string): string {
  return capClassNameBase(`${base}${segment}`.normalize('NFKC'))
}

/**
 * Render one validated scalar as Python literal text. A beyond-safe-range
 * integer takes `BigInt` digits — Python integers are arbitrary-precision,
 * and `String`'s shortest-round-trip padding can name an integer no double
 * holds. `JSON.stringify` for strings is what keeps the literal parseable
 * (its escapes are Python escapes too; ES2019 well-formedness covers
 * surrogates).
 */
function pyScalar(value: JsonSchemaScalar): string {
  if (value === true) return 'True'
  if (value === false) return 'False'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
    return BigInt(value).toString()
  }
  return String(value)
}

/** Render a validated scalar `const`/`enum` as `Literal[...]`, else the broad type. */
function renderConstrainedScalar(node: JsonSchemaNode, broad: string, state: RenderState): string {
  if (node.const !== undefined) {
    state.typing.add('Literal')
    return `Literal[${pyScalar(node.const)}]`
  }
  if (node.enum !== undefined) {
    state.typing.add('Literal')
    return `Literal[${node.enum.map(pyScalar).join(', ')}]`
  }
  return broad
}

/**
 * Map one JSON-Schema node to a Python type expression, threading `state`
 * for the `TypedDict` declarations and `typing` symbols a full render needs.
 * Iterative explicit-stack walk (ported): a hostile 5 000-deep schema must
 * not blow the host stack, and class declarations must precede the parent
 * that references them. An unsupported or malformed schema degrades to `Any`
 * without throwing — the stub is advisory prompt text, only required to
 * parse — exactly as upstream treats schemas trusted-after-validation.
 */
function renderType(schema: unknown, className: string, state: RenderState): string {
  interface Frame {
    schema: JsonSchemaNode
    className: string
    phase: 'start' | 'children'
    kind?: 'oneOf' | 'array' | 'typeddict'
    node?: JsonSchemaNode
    listDepth: number
    children: { schema: JsonSchemaNode; className: string; listDepth: number }[]
    childIndex: number
    childTypes: string[]
    entries: [string, JsonSchemaNode][]
    allocated?: string
  }
  const newFrame = (schema: JsonSchemaNode, className: string, listDepth: number): Frame =>
    ({ schema, className, phase: 'start', listDepth, children: [], childIndex: 0, childTypes: [], entries: [] })
  try {
    // Validate the WHOLE tree once, then trust it: the unified validator's
    // contract (ported stance). A failure throws before anything is emitted
    // and the catch degrades this node to `Any`.
    assertSupportedJsonSchema(schema)
    const frames: Frame[] = [newFrame(schema, className, 0)]
    let result: string | undefined
    const finish = (type: string): void => {
      frames.pop()
      const parent = frames.at(-1)
      if (parent === undefined) result = type
      else parent.childTypes.push(type)
    }

    while (frames.length > 0) {
      const frame = frames.at(-1)
      if (frame === undefined) break

      if (frame.phase === 'children') {
        if (frame.childIndex < frame.children.length) {
          const child = frame.children[frame.childIndex]
          if (child === undefined) throw new Error('dashr-tool-presentation: missing python render child')
          frame.childIndex++
          frames.push(newFrame(child.schema, child.className, child.listDepth))
          continue
        }
        if (frame.kind === 'oneOf') {
          let union = ''
          for (const [index, childType] of frame.childTypes.entries()) {
            union = index === 0 ? childType : `${union} | ${childType}`
          }
          finish(union)
          continue
        }
        if (frame.kind === 'array') {
          finish(`list[${frame.childTypes[0] ?? 'Any'}]`)
          continue
        }
        const node = frame.node
        const name = frame.allocated
        if (node === undefined || name === undefined) throw new Error('dashr-tool-presentation: missing typeddict frame state')
        const required = new Set(node.required)
        const lines = [`class ${name}(TypedDict):`]
        for (let index = 0; index < frame.entries.length; index++) {
          const entry = frame.entries[index]
          const fieldType = frame.childTypes[index]
          if (entry === undefined || fieldType === undefined) throw new Error('dashr-tool-presentation: missing typeddict field type')
          const [field, fieldSchema] = entry
          const description = describe(fieldSchema)
          if (description !== undefined) lines.push(`${pad(1)}# ${description}`)
          if (required.has(field)) {
            lines.push(`${pad(1)}${field}: ${fieldType}`)
          } else {
            state.typing.add('NotRequired')
            lines.push(`${pad(1)}${field}: NotRequired[${fieldType}]`)
          }
        }
        if (node.additionalProperties !== false) {
          lines.push(`${pad(1)}# Additional keys beyond those declared are allowed.`)
        }
        if (lines.length === 1) lines.push(`${pad(1)}pass`)
        state.classes.push(lines.join('\n'))
        finish(name)
        continue
      }

      frame.phase = 'children'
      const node = frame.schema
      if (node.oneOf !== undefined) {
        frame.kind = 'oneOf'
        frame.children = node.oneOf.map((branch, index) => ({ schema: branch, className: childClassName(frame.className, `${index + 1}`), listDepth: frame.listDepth }))
        continue
      }
      if (node.type === undefined) {
        state.typing.add('Any')
        finish('Any')
        continue
      }
      switch (node.type) {
        case 'string': finish(renderConstrainedScalar(node, 'str', state)); break
        case 'number': finish(renderConstrainedScalar(node, 'float', state)); break
        case 'integer': finish(renderConstrainedScalar(node, 'int', state)); break
        case 'boolean': finish(renderConstrainedScalar(node, 'bool', state)); break
        case 'null': finish('None'); break
        case 'array': {
          if (node.items === undefined) {
            state.typing.add('Any')
            finish('list[Any]')
            break
          }
          if (frame.listDepth >= MAX_LIST_NESTING) {
            state.typing.add('Any')
            finish('Any')
            break
          }
          frame.kind = 'array'
          frame.children = [{ schema: node.items, className: frame.className, listDepth: frame.listDepth + 1 }]
          break
        }
        case 'object': {
          const entries = Object.entries(node.properties ?? {})
          // A field name that is not a legal, non-reserved, non-mangling
          // Python attribute is inexpressible as a class-syntax TypedDict
          // field, so such an object degrades whole to `dict[str, Any]` —
          // the model still reaches every key without collisions.
          if (!entries.every(([name]) => isBareIdentifier(name) && !RESERVED.has(name) && !(name.startsWith('__') && !name.endsWith('__')))) {
            state.typing.add('Any')
            finish('dict[str, Any]')
            break
          }
          if (entries.length === 0 && node.additionalProperties !== false) {
            state.typing.add('Any')
            finish('dict[str, Any]')
            break
          }
          frame.kind = 'typeddict'
          frame.node = node
          frame.allocated = allocateClassName(frame.className, state)
          state.typing.add('TypedDict')
          frame.entries = entries
          frame.children = entries.map(([field, child]) => ({ schema: child, className: childClassName(frame.allocated ?? '', camelCase(field)), listDepth: 1 }))
          break
        }
        default: {
          state.typing.add('Any')
          finish('Any')
        }
      }
    }
    return result ?? 'Any'
  } catch {
    state.typing.add('Any')
    return 'Any'
  }
}

/**
 * The fixed model-facing usage contract rendered above the declarations —
 * Dasher's OWN text (do not copy upstream `py-types.ts` SDK_INSTRUCTIONS: it
 * promises one-shot program semantics, and our kernel is persistent).
 *
 * Every statement here must match what the `run_cell` transport actually
 * enforces: cell semantics (variables survive across calls), top-level
 * `await`/`return`, the completion-value contract (lossless JSON; explicit
 * `return None` → null; no `return` → no value), the `tools`/`ToolCallError`
 * runtime binding set, the static-stub caveat for `TypedDict`s, and the
 * sub-call concurrency contract implemented by the transport's scheduler
 * (submission-ordered starts; only concurrency-safe tools overlap, up to the
 * configured cap; exclusive tools run alone as barriers).
 */
const SDK_INSTRUCTIONS = `## Writing cells for run_cell

\`run_cell\` takes two required arguments: \`code\` — one Python cell — and \`description\`, a short summary of what the cell does. The cell runs on a PERSISTENT IPython kernel: variables, imports, and definitions created in any earlier \`run_cell\` call of this session are still alive in later ones (and in this one), so treat the kernel's namespace as your working memory. Top-level \`await\` and \`return\` both work. At run time exactly two of the names declared below are bound: \`tools\` and \`ToolCallError\`. Everything else is a STATIC STUB describing argument and return types — in particular the \`TypedDict\` classes do NOT exist at run time, so build arguments as plain \`dict\`/\`list\` JSON values: \`await tools.name({"field": 1})\`, never \`FooArgs(field=1)\`, which raises \`NameError\`. Inside a cell:

- Call tools as \`await tools.name(args)\` — subscript access for exotic, reserved, or underscore-leading names: \`await tools["my-tool"](args)\`. Every call resolves to the tool's typed canonical JSON value (each method's return type below). Tool arguments must be lossless JSON.
- A FAILED tool call raises \`ToolCallError\`, whose \`toolName\` identifies the failed tool and whose message is human-readable — wrap in \`try\`/\`except\` to handle and continue.
- Independent calls may overlap under \`asyncio.gather\`: cells dispatch sub-calls in submission order, and only tools marked safe to run side by side actually overlap (bounded by a cap); any other tool runs alone, waiting for overlapping calls to drain first. Sequence dependent work with plain \`await\`.
- Emit the answer with \`print(...)\` and/or a top-level \`return <value>\`. The returned value must be lossless JSON: an explicit \`return None\` yields \`null\`, and a cell without \`return\` yields no value at all. ONLY what you print and the returned value come back — intermediate tool results never enter the conversation, so extract just what you need.

The available tools:`

/**
 * Render the full `tools:dasher-sdk` prompt section: the cell-flavored
 * usage instructions above, one named `TypedDict` per tool argument or
 * output object (and per nested object), one awaitable method per visible
 * tool on a `Tools` protocol, the `ToolCallError` declaration, and the
 * `tools: Tools` singleton — inside one fenced ```python block. The
 * `typing` import line lists exactly the symbols the render used.
 *
 * Deterministic — tools are emitted in lexicographic name order and class
 * declarations precede the protocol in that same order (nested classes
 * before the parent that references them), so an unchanged tool set
 * produces byte-identical text across assemblies.
 * @param schemas - the calling scope's visible tools (caller excludes `run_cell`).
 * @returns the complete section text.
 */
export function renderToolsSdkPy(schemas: readonly DasherSdkSchema[]): string {
  const sorted = [...schemas].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  const state: RenderState = { classes: [], usedClassNames: new Set(), nextClassCounter: new Map(), typing: new Set(['Protocol']) }
  const members: string[] = []
  let statements = 0
  for (const schema of sorted) {
    const argType = renderType(schema.parameters, `${camelCase(schema.name)}Args`, state)
    const outputType = renderType(schema.output, `${camelCase(schema.name)}Output`, state)
    if (isBareIdentifier(schema.name) && !RESERVED.has(schema.name) && !schema.name.startsWith('_')) {
      // The docstring must be the method's FIRST statement to document it;
      // a description-less method takes the `...` stub body.
      const doc = docLines(schema.description, 2)
      members.push(`${pad(1)}async def ${schema.name}(self, args: ${argType}) -> ${outputType}:`)
      members.push(...(doc.length > 0 ? doc : [`${pad(2)}...`]))
      statements += 1
    } else {
      // Not reachable as `tools.name` — the model calls it as
      // `tools[name]`. Hard keywords and exotic names are not legal
      // attributes; underscore-leading names are legal but broken in three
      // separate ways at the call site (mangling, object-dunder shadowing,
      // implicit special-method lookup), so one rule routes the family here.
      members.push(`${pad(1)}# tools[${JSON.stringify(schema.name)}](args: ${argType}) -> ${outputType}`)
      const description = describe(schema)
      if (description !== undefined) members.push(`${pad(1)}#   ${description}`)
    }
  }
  // Subscript entries are COMMENTS, not statements: a class body of only
  // comments fails to parse, so `pass` is required whenever no method was
  // emitted.
  const bodyLines = statements > 0 ? members : [`${pad(1)}pass`, ...members]
  const body = bodyLines.join('\n')
  const imports = TYPING_ORDER.filter(symbol => state.typing.has(symbol))
  const classBlock = state.classes.length > 0 ? `${state.classes.join('\n\n')}\n\n` : ''
  const errorDeclaration = 'class ToolCallError(Exception):\n    toolName: str'
  const declaration = `from typing import ${imports.join(', ')}\n\n${errorDeclaration}\n\n${classBlock}class Tools(Protocol):\n${body}\n\ntools: Tools`
  return `${SDK_INSTRUCTIONS}\n\n\`\`\`python\n${declaration}\n\`\`\``
}
