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

function waitForEvent (emitter, event, options = {}) {
  const { timeout = 5000, predicate = () => true, rejectEvents = [] } = options
  return withTimeout(new Promise((resolve, reject) => {
    const cleanup = () => {
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
    const rejectHandlers = rejectEvents.map(name => {
      const handler = (...args) => {
        cleanup()
        reject(new Error(`Interrupted by ${name}: ${args[0]?.message || ''}`.trim()))
      }
      emitter.on(name, handler)
      return [name, handler]
    })
    emitter.on(event, onEvent)
  }), timeout, `Timed out waiting for ${event}`)
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
