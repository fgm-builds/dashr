/**
 * Result assembly helpers: sentinel extraction from the captured stream and
 * the outer-output ledger. Pure functions; the plugin owns their wiring.
 * @module dashr/output
 */

import type { CodeJsonValue, CodeRunFailure, CodeRunResult } from './vendored/rlm-runtime.ts'

/** ANSI color escapes, which ipykernel embeds in published tracebacks. */
const ANSI_ESCAPE = /\x1b\[[0-9;]*[A-Za-z]/g

/** Smallest cap that can represent an empty logs array plus a quoted message. */
export const MIN_OUTPUT_BYTES = 4

export interface StreamCapture {
  /** Emission lines with the completion envelope removed, in order. */
  logs: string[]
  /** The raw JSON text after the sentinel, when the envelope line arrived. */
  envelope: string | undefined
}

/**
 * Split captured stream text into log lines and the completion envelope.
 * Tolerates a sentinel that landed mid-line after an emission without a
 * trailing newline (the prefix stays in the logs).
 * @param streamText - concatenated iopub stream text for one cell.
 * @param sentinel - per-run nonce prefix of the envelope line.
 */
export function extractStream(streamText: string, sentinel: string): StreamCapture {
  const logs: string[] = []
  let envelope: string | undefined
  for (const line of streamText.split('\n')) {
    const at = line.indexOf(sentinel)
    if (at === -1) {
      logs.push(line)
      continue
    }
    if (at > 0) logs.push(line.slice(0, at))
    envelope = line.slice(at + sentinel.length)
  }
  // A trailing '\n' yields a final empty line that is a split artifact, not an
  // emission.
  if (logs.length > 0 && logs.at(-1) === '') logs.pop()
  return { logs, envelope: envelope === '' ? undefined : envelope }
}

/** Strip ANSI escapes from an ipykernel traceback for a model-facing message. */
export function plainTraceback(ename: string, evalue: string, traceback: string[]): string {
  const body = traceback.map(line => line.replace(ANSI_ESCAPE, '')).join('\n')
  return body.length > 0 ? `${ename}: ${evalue}\n${body}` : `${ename}: ${evalue}`
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** Serialized size of the counted payloads: logs array, value, failure message. */
function payloadBytes(logs: string[], value: CodeJsonValue | undefined, errorMessage: string | undefined): number {
  let total = 2 // []
  for (const [i, text] of logs.entries()) total += (i > 0 ? 1 : 0) + byteLength(JSON.stringify(text))
  if (value !== undefined) total += byteLength(JSON.stringify(value))
  if (errorMessage !== undefined) total += byteLength(JSON.stringify(errorMessage))
  return total
}

/**
 * Apply the outer-output ledger: admit the result when the combined serialized
 * payloads fit, otherwise retain a fitting log prefix and report an explicit
 * `output-limit` failure. Conservative accounting — it may underuse the cap,
 * never exceed it.
 * @param logs - captured emission lines.
 * @param value - the completion value, when one crossed the JSON boundary.
 * @param error - the failure, when the run failed.
 * @param maxBytes - the configured cap for the combined counted payloads.
 */
export function finalizeOutput(
  logs: string[],
  value: CodeJsonValue | undefined,
  error: CodeRunFailure | undefined,
  maxBytes: number,
): CodeRunResult {
  if (payloadBytes(logs, value, error?.message) <= maxBytes) {
    return { logs, ...value !== undefined ? { value } : {}, ...error ? { error } : {} }
  }
  const limitMessage = `outer output exceeded ${maxBytes} bytes`
  const messageBytes = byteLength(JSON.stringify(limitMessage)) + 4
  const budget = Math.max(0, maxBytes - 2 - messageBytes)
  const retained: string[] = []
  let used = 0
  for (const text of logs) {
    const serialized = byteLength(JSON.stringify(text))
    const separator = retained.length > 0 ? 1 : 0
    if (used + separator + serialized > budget) break
    retained.push(text)
    used += separator + serialized
  }
  return { logs: retained, error: { kind: 'output-limit', message: limitMessage } }
}
