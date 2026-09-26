'use strict'

class CraftEngineError extends Error {
  constructor (code, message, details = {}) {
    super(message)
    this.name = 'CraftEngineError'
    this.code = code
    this.details = details
  }
}

function error (code, message, details) {
  return new CraftEngineError(code, message, details)
}

module.exports = { CraftEngineError, error }
