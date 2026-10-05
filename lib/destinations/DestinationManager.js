'use strict'

const { itemMatches } = require('../utils/items')

class DestinationManager {
  constructor (bot, containerManager, engine) {
    this.bot = bot
    this.containers = containerManager
    this.engine = engine
  }

  async send (destination, selector, amount = 'all') {
    if (!destination || destination.type === 'inventory') return 0
    const type = destination.type || inferDestinationType(destination)

    if (isRangeType(type) || (destination.start && destination.end)) {
      return this.containers.depositRange(destination, selector, amount, destination)
    }

    if (['chest', 'barrel', 'shulker', 'ender_chest', 'container'].includes(type)) {
      return this.containers.deposit(destination.position || destination.pos || destination.chest, selector, amount, destination)
    }
    if (type === 'drop') {
      let moved = 0
      let remaining = amount === 'all' || amount === Infinity ? Infinity : Math.max(0, Number(amount) || 0)
      const stacks = this.bot.inventory.items().filter(stack => itemMatches(stack, selector, this.bot))
      for (const stack of stacks) {
        if (remaining <= 0) break
        // Read the count before tossing: Mineflayer mutates the live stack.
        const count = stack.count
        if (remaining >= count) {
          await this.bot.tossStack(stack)
          moved += count
          if (remaining !== Infinity) remaining -= count
        } else {
          await this.bot.toss(stack.type, stack.metadata, remaining)
          moved += remaining
          remaining = 0
        }
      }
      return moved
    }
    if (type === 'custom' && typeof destination.deposit === 'function') {
      return Number(await destination.deposit({ bot: this.bot, engine: this.engine, selector, amount })) || 0
    }
    throw new Error(`Unsupported destination type: ${type}`)
  }

  async clean (destination, options = {}) {
    if (!destination) return 0
    const keep = options.keep || []
    const protectedSelectors = [...keep, ...(options.protect || [])]
    const predicate = stack => !protectedSelectors.some(selector => itemMatches(stack, selector, this.bot))
    const type = destination.type || inferDestinationType(destination)

    if (isRangeType(type) || (destination.start && destination.end)) {
      return this.containers.depositWhereRange(destination, predicate, destination)
    }

    if (['chest', 'barrel', 'shulker', 'ender_chest', 'container'].includes(type)) {
      return this.containers.depositWhere(destination.position || destination.pos || destination.chest, predicate, destination)
    }
    if (type === 'drop') {
      let moved = 0
      for (const stack of this.bot.inventory.items().filter(predicate)) {
        const count = stack.count
        await this.bot.tossStack(stack)
        moved += count
      }
      return moved
    }
    return 0
  }
}

function inferDestinationType (destination) {
  return destination?.start && destination?.end ? 'container-range' : 'chest'
}

function isRangeType (type) {
  return ['range', 'container-range', 'container_range', 'chest-range', 'chest_range'].includes(type)
}

module.exports = { DestinationManager, isRangeType, inferDestinationType }
