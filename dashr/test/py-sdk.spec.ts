import { describe, expect, it } from 'vitest'
import { renderToolsSdkPy } from '../src/py-sdk.ts'
import type { DASHRSdkSchema } from '../src/py-sdk.ts'

/** One tool schema fixture with typed object args and output. */
const echo: DASHRSdkSchema = {
  name: 'echo',
  description: 'Echo the value back.',
  parameters: {
    type: 'object',
    properties: {
      value: { type: 'string', description: 'The value to echo.' },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['value'],
    additionalProperties: false,
  },
  output: { type: 'string' },
}

/** A fixture whose arguments nest objects two levels deep. */
const nested: DASHRSdkSchema = {
  name: 'deploy',
  description: 'Deploy a service.',
  parameters: {
    type: 'object',
    properties: {
      target: {
        type: 'object',
        description: 'Where to deploy.',
        properties: {
          region: { type: 'string' },
          replicas: { type: 'integer' },
          labels: { type: 'object', properties: { env: { type: 'string' } }, required: ['env'], additionalProperties: true },
        },
        required: ['region'],
        additionalProperties: false,
      },
      dryRun: { type: 'boolean' },
    },
    required: ['target'],
    additionalProperties: false,
  },
  output: {
    type: 'object',
    properties: { url: { type: 'string' }, skipped: { type: 'boolean' } },
    required: ['url'],
    additionalProperties: false,
  },
}

describe('renderToolsSdkPy — determinism and shape (flat v0.1.5 render)', () => {
  it('renders byte-identical text for identical input across two renders', () => {
    const schemas = [echo, nested]
    expect(renderToolsSdkPy(schemas)).toBe(renderToolsSdkPy(schemas))
  })

  it('renders byte-identical text regardless of input array order (lexicographic emission)', () => {
    expect(renderToolsSdkPy([nested, echo])).toBe(renderToolsSdkPy([echo, nested]))
  })

  it('emits nested TypedDict classes, child before parent, with exact field names and requiredness', () => {
    const text = renderToolsSdkPy([nested])
    expect(text).toContain('class DeployArgs(TypedDict):')
    expect(text).toContain('class DeployArgsTarget(TypedDict):')
    expect(text).toContain('class DeployArgsTargetLabels(TypedDict):')
    expect(text).toContain('class DeployOutput(TypedDict):')
    // Child class declared before the parent that references it.
    expect(text.indexOf('class DeployArgsTarget(TypedDict):')).toBeLessThan(text.indexOf('class DeployArgs(TypedDict):'))
    // Required fields are bare; optional ones wrap in NotRequired.
    expect(text).toContain('    region: str')
    expect(text).toContain('    dryRun: NotRequired[bool]')
    expect(text).toContain('    replicas: NotRequired[int]')
  })

  it('renders each tool as a TOP-LEVEL async def — no Tools protocol, no tools singleton', () => {
    const text = renderToolsSdkPy([nested, echo])
    expect(text).toContain('async def echo(args: EchoArgs) -> str:')
    expect(text).toContain('async def deploy(args: DeployArgs) -> DeployOutput:')
    expect(text).not.toContain('class Tools(Protocol)')
    expect(text).not.toContain('tools: Tools')
    expect(text).not.toContain('Protocol')
    // Docstring carries the description, indented one level (function body).
    expect(text).toContain('    """Echo the value back."""')
    expect(text).toContain('    """Deploy a service."""')
    // Function defs come after the TypedDict declarations they reference.
    expect(text.indexOf('class DeployOutput(TypedDict):')).toBeLessThan(text.indexOf('async def deploy('))
  })

  it('lists exactly the typing symbols used, in the canonical order', () => {
    const text = renderToolsSdkPy([nested])
    expect(text).toContain('from typing import NotRequired, TypedDict\n')
  })

  it('renders an empty tool set as the error declaration alone (still parseable)', () => {
    const text = renderToolsSdkPy([])
    expect(text).toContain('class ToolCallError(Exception):\n    toolName: str')
    expect(text).not.toContain('async def')
    // No typing symbols used → the import line is omitted entirely.
    expect(text).not.toContain('from typing import')
  })

  it('degrades an object whose field names are not legal class-syntax members, without dropping the tool', () => {
    const exotic: DASHRSdkSchema = {
      name: 'mixed',
      description: 'Has an exotic field.',
      parameters: {
        type: 'object',
        properties: {
          ok: { type: 'string' },
          'not-an-identifier': { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      output: { type: 'string' },
    }
    const text = renderToolsSdkPy([exotic])
    expect(text).toContain('args: dict[str, Any]')
    expect(text).toContain('async def mixed(')
    expect(text).toContain('from typing import Any')
  })
})

describe('renderToolsSdkPy — non-bindable tool names', () => {
  it('routes a hard-keyword tool name to a not-callable comment with its signature and description', () => {
    const text = renderToolsSdkPy([{
      name: 'class',
      description: 'Reserved name tool.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { type: 'string' },
    }])
    expect(text).toContain('# "class": registered but NOT callable from cells (its name is not a usable flat global) — (args: ClassArgs) -> str')
    expect(text).toContain('#   Reserved name tool.')
    expect(text).not.toContain('async def class(')
  })

  it('routes an exotic (non-identifier) tool name to a not-callable comment', () => {
    const text = renderToolsSdkPy([{
      name: 'my-tool',
      description: 'Hyphenated tool.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { type: 'string' },
    }])
    expect(text).toContain('# "my-tool": registered but NOT callable from cells')
  })

  it('routes an underscore-leading tool name to a not-callable comment (kernel-shim prefix)', () => {
    const text = renderToolsSdkPy([{
      name: '_private',
      description: 'Underscore tool.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { type: 'string' },
    }])
    expect(text).toContain('# "_private": registered but NOT callable from cells')
  })

  it('routes a portable-seam-reserved name (legal Python, reserved on the seam) to a not-callable comment', () => {
    // `type` is a Python SOFT keyword (legal as a def name) but reserved by
    // the seam's portable word set — the catalog must not teach a flat
    // global the runtime would refuse as a binding.
    const text = renderToolsSdkPy([{
      name: 'type',
      description: 'Soft-keyword tool.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { type: 'string' },
    }])
    expect(text).toContain('# "type": registered but NOT callable from cells')
    expect(text).not.toContain('async def type(')
  })

  it('still names the derived class for a commented tool with typed args', () => {
    const text = renderToolsSdkPy([{
      name: 'class',
      description: 'Reserved name tool.',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false,
      },
      output: { type: 'string' },
    }])
    expect(text).toMatch(/class ClassArgs\(TypedDict\):[\s\S]*?value: str/)
  })

  it('marks file_glob with the stdlib-shadow note, from the model\'s perspective', () => {
    const text = renderToolsSdkPy([{
      name: 'file_glob',
      description: 'Glob files by pattern.',
      parameters: {
        type: 'object',
        properties: { pattern: { type: 'string' } },
        required: ['pattern'],
        additionalProperties: false,
      },
      output: { type: 'string' },
    }])
    expect(text).toContain('async def file_glob(args: FileGlobArgs) -> str')
    expect(text).toContain('would shadow the stdlib `glob` module')
    // The note explains the rename without referencing any upstream.
    expect(text).not.toContain('upstream')
  })
})

describe('renderToolsSdkPy — DASHR cell instructions', () => {
  it('states the persistent-kernel cell semantics, ipython by name', () => {
    const text = renderToolsSdkPy([echo])
    expect(text).toContain('## Writing cells for ipython')
    expect(text).toContain('PERSISTENT IPython kernel')
    expect(text).toContain('still alive in later ones')
    expect(text).toContain('Top-level `await` works; a top-level `return` is a SyntaxError')
  })

  it('states the completion-value contract exactly as the runtime implements it', () => {
    const text = renderToolsSdkPy([echo])
    expect(text).toContain('end the cell with a bare expression — its value becomes the cell')
    expect(text).toContain('A cell ending in a statement (or a `None` expression) yields no value')
    expect(text).toContain('ONLY what you print and the final value come back')
  })

  it('declares the flat binding set and the TypedDict static-stub caveat', () => {
    const text = renderToolsSdkPy([echo])
    expect(text).toContain('the bound names are `ToolCallError` and every tool function declared below')
    expect(text).toContain('the `TypedDict` classes do NOT exist at run time')
    expect(text).toContain('await echo({"field": 1})')
    // No holder, no prefix promise anywhere.
    expect(text).not.toContain('await tools.')
    expect(text).not.toContain('`tools`')
  })

  it('declares only the flat binding set — no separate bridge-tools block', () => {
    const text = renderToolsSdkPy([echo])
    expect(text).toContain('the bound names are `ToolCallError` and every tool function declared below')
    expect(text).not.toContain('declared in the block after this one')
  })

  it('declares the ToolCallError contract (toolName + message) and the concurrency contract', () => {
    const text = renderToolsSdkPy([echo])
    expect(text).toContain('A FAILED tool call raises `ToolCallError`')
    expect(text).toContain('`toolName` identifies the failed tool')
    expect(text).toContain('`asyncio.gather`')
    expect(text).toContain('any other tool runs alone, waiting for overlapping calls to drain first')
  })

  it('never states the upstream one-shot program contract', () => {
    const text = renderToolsSdkPy([echo])
    expect(text).not.toContain('body of an async function')
    expect(text).not.toContain('Writing code for run_code')
    expect(text).not.toContain('run_code')
  })

  it('declares ToolCallError inside one fenced python block', () => {
    const text = renderToolsSdkPy([echo])
    expect(text).toContain('```python\nfrom typing import')
    expect(text).toContain('class ToolCallError(Exception):\n    toolName: str')
    expect(text.endsWith('```'))
  })
})
