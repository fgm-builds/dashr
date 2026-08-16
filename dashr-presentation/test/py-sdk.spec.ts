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

describe('renderToolsSdkPy — determinism and shape', () => {
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
    expect(text).toContain('    target: DeployArgsTarget')
    expect(text).toContain('    dryRun: NotRequired[bool]')
    expect(text).toContain('    replicas: NotRequired[int]')
    // Method signature with typed args and output.
    expect(text).toContain('    async def deploy(self, args: DeployArgs) -> DeployOutput:')
    // Docstring carries the description.
    expect(text).toContain('        """Deploy a service."""')
  })

  it('lists exactly the typing symbols used, in the canonical order', () => {
    const text = renderToolsSdkPy([nested])
    expect(text).toContain('from typing import NotRequired, Protocol, TypedDict\n')
  })

  it('renders an empty tool set as a parseable pass-only protocol', () => {
    const text = renderToolsSdkPy([])
    expect(text).toContain('class Tools(Protocol):\n    pass')
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
    expect(text).toContain('from typing import Any, Protocol')
  })
})

describe('renderToolsSdkPy — exotic, reserved, and underscore-leading tool names', () => {
  it('routes a hard-keyword tool name to a subscript comment line with its description', () => {
    const text = renderToolsSdkPy([{
      name: 'class',
      description: 'Reserved name tool.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { type: 'string' },
    }])
    expect(text).toContain('# tools["class"](args: ClassArgs) -> str')
    expect(text).toContain('#   Reserved name tool.')
    // The protocol still parses: a pass-only body plus the comment.
    expect(text).toContain('class Tools(Protocol):\n    pass')
  })

  it('routes an exotic (non-identifier) tool name to a subscript comment', () => {
    const text = renderToolsSdkPy([{
      name: 'my-tool',
      description: 'Hyphenated tool.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { type: 'string' },
    }])
    expect(text).toContain('# tools["my-tool"](args: MyToolArgs) -> str')
  })

  it('routes an underscore-leading tool name to a subscript comment (call-site hazards)', () => {
    const text = renderToolsSdkPy([{
      name: '_private',
      description: 'Underscore tool.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { type: 'string' },
    }])
    expect(text).toContain('# tools["_private"](args: PrivateArgs) -> str')
  })

  it('still names the derived class for a subscripted tool with typed args', () => {
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
})

describe('renderToolsSdkPy — DASHR cell instructions', () => {
  it('states the persistent-kernel cell semantics, run_cell by name', () => {
    const text = renderToolsSdkPy([echo])
    expect(text).toContain('## Writing cells for run_cell')
    expect(text).toContain('PERSISTENT IPython kernel')
    expect(text).toContain('still alive in later ones')
    expect(text).toContain('Top-level `await` and `return` both work')
  })

  it('states the completion-value contract exactly as the runtime implements it', () => {
    const text = renderToolsSdkPy([echo])
    expect(text).toContain('an explicit `return None` yields `null`')
    expect(text).toContain('a cell without `return` yields no value')
    expect(text).toContain('ONLY what you print and the returned value come back')
  })

  it('declares the runtime binding set and the TypedDict static-stub caveat', () => {
    const text = renderToolsSdkPy([echo])
    expect(text).toContain('exactly two of the names declared below are bound: `tools` and `ToolCallError`')
    expect(text).toContain('the `TypedDict` classes do NOT exist at run time')
    expect(text).toContain('await tools.name({"field": 1})')
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

  it('declares ToolCallError and the tools singleton inside one fenced python block', () => {
    const text = renderToolsSdkPy([echo])
    expect(text).toContain('```python\nfrom typing import')
    expect(text).toContain('class ToolCallError(Exception):\n    toolName: str')
    expect(text).toContain('class Tools(Protocol):')
    expect(text).toContain('tools: Tools')
    expect(text.endsWith('```'))
  })
})
