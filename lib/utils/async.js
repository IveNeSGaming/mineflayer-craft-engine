'use strict'

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function withTimeout (promise, ms, message = 'Operation timed out') {
  let timer
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Resolves with the event arguments once `event` fires and `predicate` accepts
 * them. Every listener (including rejectEvents) is removed on resolve, reject
 * AND timeout, so repeated timeouts in a long-running job do not leak
 * listeners. `timeout: 0` or `Infinity` waits forever. An AbortSignal in
 * `signal` cancels the wait.
 */
function waitForEvent (emitter, event, options = {}) {
  const { timeout = 5000, predicate = () => true, rejectEvents = [], signal } = options
  return new Promise((resolve, reject) => {
    let timer = null
    const rejectHandlers = []
    const onAbort = () => {
      cleanup()
      reject(signal.reason instanceof Error ? signal.reason : new Error(`Stopped waiting for ${event}`))
    }
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      emitter.removeListener(event, onEvent)
      for (const [name, handler] of rejectHandlers) emitter.removeListener(name, handler)
    }
    const onEvent = (...args) => {
      try {
        if (!predicate(...args)) return
        cleanup()
        resolve(args)
      } catch (error) {
        cleanup()
        reject(error)
      }
    }
    for (const name of rejectEvents) {
      const handler = (...args) => {
        cleanup()
        reject(new Error(`Interrupted by ${name}: ${args[0]?.message || ''}`.trim()))
      }
      emitter.on(name, handler)
      rejectHandlers.push([name, handler])
    }
    emitter.on(event, onEvent)
    if (signal) {
      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort)
    }
    if (Number.isFinite(timeout) && timeout > 0) {
      timer = setTimeout(() => {
        cleanup()
        reject(new Error(`Timed out waiting for ${event}`))
      }, timeout)
    }
  })
}

async function retry (fn, options = {}) {
  const {
    attempts = 3,
    delayMs = 150,
    factor = 1.8,
    shouldRetry = () => true,
    onRetry = () => {}
  } = options
  let delay = delayMs
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt)
    } catch (error) {
      lastError = error
      if (attempt >= attempts || !shouldRetry(error)) break
      onRetry(error, attempt)
      await sleep(delay)
      delay = Math.ceil(delay * factor)
    }
  }
  throw lastError
}

module.exports = { sleep, withTimeout, waitForEvent, retry }
