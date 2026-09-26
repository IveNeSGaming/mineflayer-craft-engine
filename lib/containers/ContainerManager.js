'use strict'

const { toVec3, positionsInBox } = require('../utils/positions')
const { resolveItem, itemMatches, countItem } = require('../utils/items')
const { retry, sleep } = require('../utils/async')
const { error } = require('../core/errors')

const DEFAULT_CONTAINER_NAMES = [
  'chest',
  'trapped_chest',
  'barrel',
  'ender_chest'
]

class ContainerManager {
  constructor (bot, engine) {
    this.bot = bot
    this.engine = engine
  }

  async goTo (position, range = 2) {
    if (!position) return
    const target = toVec3(position)
    if (this.bot.entity?.position?.distanceTo(target) <= range + 1) return
    if (!this.bot.pathfinder?.goto) {
      throw error('OUT_OF_REACH', `Bot is not near ${target} and mineflayer-pathfinder is not loaded`)
    }
    const { goals } = require('mineflayer-pathfinder')
    await this.bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, range))
  }

  getBlock (position) {
    const vector = toVec3(position)
    const block = this.bot.blockAt(vector)
    if (!block) throw error('BLOCK_NOT_FOUND', `No block found at ${vector}`)
    return block
  }

  async open (position, options = {}) {
    await this.goTo(position, options.range ?? 2)
    const block = this.getBlock(position)
    return retry(async () => {
      const container = await this.bot.openContainer(block)
      if (!container) throw error('CONTAINER_OPEN_FAILED', `Could not open ${block.name} at ${block.position}`)
      return container
    }, {
      attempts: options.attempts ?? 3,
      delayMs: options.retryDelayMs ?? 120,
      onRetry: (cause, attempt) => this.engine.emit('retry', { operation: 'openContainer', attempt, cause })
    })
  }

  async inspect (position, options = {}) {
    const container = await this.open(position, options)
    try {
      return container.containerItems().map(item => ({
        name: item.name,
        type: item.type,
        metadata: item.metadata,
        count: item.count,
        displayName: item.displayName
      }))
    } finally {
      container.close()
    }
  }

  async count (position, selector, options = {}) {
    const container = await this.open(position, options)
    try {
      return countItem(container.containerItems(), selector, this.bot)
    } finally {
      container.close()
    }
  }

  async withdraw (position, selector, amount, options = {}) {
    const item = typeof selector === 'string' || typeof selector === 'number' ? resolveItem(this.bot, selector) : null
    const container = await this.open(position, options)
    let moved = 0
    try {
      const stacks = container.containerItems().filter(stack => itemMatches(stack, selector, this.bot))
      let remaining = amount === 'all' || amount === Infinity ? Infinity : Math.max(0, Number(amount))
      for (const stack of stacks) {
        if (remaining <= 0) break
        const count = remaining === Infinity ? stack.count : Math.min(stack.count, remaining)
        await container.withdraw(stack.type, stack.metadata, count, stack.nbt)
        moved += count
        if (remaining !== Infinity) remaining -= count
      }
      if (options.required && moved < amount) {
        throw error('SOURCE_SHORTAGE', `Container supplied ${moved}/${amount} ${item?.name || 'items'}`, { moved, amount })
      }
      return moved
    } finally {
      container.close()
    }
  }

  async deposit (position, selector, amount = 'all', options = {}) {
    const container = await this.open(position, options)
    let moved = 0
    try {
      const stacks = this.bot.inventory.items().filter(stack => itemMatches(stack, selector, this.bot))
      let remaining = amount === 'all' || amount === Infinity ? Infinity : Math.max(0, Number(amount))
      for (const stack of stacks) {
        if (remaining <= 0) break
        const count = remaining === Infinity ? stack.count : Math.min(stack.count, remaining)
        await container.deposit(stack.type, stack.metadata, count, stack.nbt)
        moved += count
        if (remaining !== Infinity) remaining -= count
      }
      return moved
    } finally {
      container.close()
    }
  }

  async depositWhere (position, predicate, options = {}) {
    const container = await this.open(position, options)
    let moved = 0
    try {
      const stacks = this.bot.inventory.items().filter(predicate)
      for (const stack of stacks) {
        await container.deposit(stack.type, stack.metadata, stack.count, stack.nbt)
        moved += stack.count
      }
      return moved
    } finally {
      container.close()
    }
  }

  /**
   * Deposit only the amount that physically fits in one container.
   * This avoids Mineflayer's `destination full` cursor state, where a partially
   * filled chest can make the local inventory temporarily look empty and stop
   * range routing before the next chest is tried.
   */
  async depositUpToCapacity (position, selector, amount = 'all', options = {}) {
    const container = await this.open(position, options)
    let moved = 0
    let full = false

    try {
      let remaining = amount === 'all' || amount === Infinity ? Infinity : Math.max(0, Number(amount))
      const stacks = this.bot.inventory.items().filter(stack => itemMatches(stack, selector, this.bot))

      for (const stack of stacks) {
        if (remaining <= 0) break

        const capacity = containerCapacityForStack(container, stack)
        if (capacity <= 0) {
          full = true
          break
        }

        const wanted = remaining === Infinity ? stack.count : Math.min(stack.count, remaining)
        const count = Math.min(wanted, capacity)
        if (count <= 0) break

        await container.deposit(stack.type, stack.metadata, count, stack.nbt)
        moved += count
        if (remaining !== Infinity) remaining -= count

        if (containerCapacityForStack(container, stack) <= 0) full = true
      }

      return { moved, full }
    } finally {
      container.close()
    }
  }


  /**
   * Withdraw matching items from every container in an inclusive coordinate range.
   * Containers with less than minAvailable matching items can be skipped.
   */
  async withdrawRange (range, selector, amount = 'all', options = {}) {
    const start = range.start || range.from || range.startPosition
    const end = range.end || range.to || range.endPosition
    if (!start || !end) throw new TypeError('Range source requires start and end coordinates')

    const positions = this.findInRange(start, end, { ...range, ...options })
    if (!positions.length) return 0

    let remaining = amount === 'all' || amount === Infinity ? Infinity : Math.max(0, Number(amount))
    let movedTotal = 0
    const minAvailable = Math.max(1, Number(range.minAvailable || range.minimumAvailable || range.minimumStack || 1))

    for (const position of positions) {
      if (remaining <= 0) break
      let available = 0
      try {
        available = await this.count(position, selector, { ...range, ...options })
      } catch (cause) {
        this.engine.emit('rangeSourceTried', { position, available: 0, moved: 0, skipped: true, error: cause })
        continue
      }

      if (available < minAvailable) {
        this.engine.emit('rangeSourceTried', { position, available, moved: 0, skipped: true })
        continue
      }

      const wanted = remaining === Infinity ? available : Math.min(available, remaining)
      const before = countItem(this.bot.inventory.items(), selector, this.bot)
      let cause = null
      try {
        await this.withdraw(position, selector, wanted, { ...range, ...options })
      } catch (err) {
        cause = err
      }
      const after = countItem(this.bot.inventory.items(), selector, this.bot)
      const moved = Math.max(0, after - before)
      movedTotal += moved
      if (remaining !== Infinity) remaining = Math.max(0, remaining - moved)

      this.engine.emit('rangeSourceTried', {
        position,
        available,
        moved,
        skipped: false,
        error: cause || null
      })

      if (cause && !isInventoryCapacityError(cause)) throw cause
      if (cause && isInventoryCapacityError(cause)) break
      if (typeof this.bot.inventory.emptySlotCount === 'function' && this.bot.inventory.emptySlotCount() <= 0) break
    }

    return movedTotal
  }

  /** Find all supported containers inside an inclusive coordinate range. */
  findInRange (start, end, options = {}) {
    const explicit = options.blockNames || options.blocks || options.containerNames
    const allowed = new Set((explicit || DEFAULT_CONTAINER_NAMES).map(String))
    const includeShulkers = options.includeShulkers !== false
    const result = []
    const seen = new Set()

    for (const position of positionsInBox(start, end)) {
      const block = this.bot.blockAt(position)
      if (!block) continue
      const allowedName = allowed.has(block.name) || (includeShulkers && block.name.endsWith('_shulker_box'))
      if (!allowedName) continue

      const key = this.canonicalContainerKey(block)
      if (seen.has(key)) continue
      seen.add(key)
      result.push(block.position.clone ? block.position.clone() : toVec3(block.position))
    }

    if (options.nearestFirst && this.bot.entity?.position) {
      result.sort((a, b) => this.bot.entity.position.distanceTo(a) - this.bot.entity.position.distanceTo(b))
    }
    return result
  }

  /**
   * Deposit across many chests. A full chest is skipped automatically.
   * Returns the number of items moved in total.
   */
  async depositRange (range, selector, amount = 'all', options = {}) {
    const start = range.start || range.from || range.startPosition
    const end = range.end || range.to || range.endPosition
    if (!start || !end) throw new TypeError('Range destination requires start and end coordinates')

    const positions = this.findInRange(start, end, { ...range, ...options })
    if (!positions.length) {
      throw error('CONTAINER_RANGE_EMPTY', 'No chest/container was found inside the configured start/end range', { start, end })
    }

    this.engine.emit('rangeDestinationScan', {
      start: toVec3(start),
      end: toVec3(end),
      count: positions.length,
      positions
    })

    let remaining = amount === 'all' || amount === Infinity ? Infinity : Math.max(0, Number(amount))
    let movedTotal = 0
    const settleDelayMs = Math.max(0, Number(range.settleDelayMs ?? options.settleDelayMs ?? 100))

    for (const position of positions) {
      if (remaining <= 0) break
      const before = countItem(this.bot.inventory.items(), selector, this.bot)
      if (before <= 0) break

      let result = { moved: 0, full: false }
      let cause = null
      try {
        result = await this.depositUpToCapacity(position, selector, remaining, { ...range, ...options })
      } catch (err) {
        cause = err
      }

      if (settleDelayMs > 0) await sleep(settleDelayMs)

      // Prefer the successful exact transfer count. If the server changed the
      // inventory by a different amount, use the verified delta instead.
      const after = countItem(this.bot.inventory.items(), selector, this.bot)
      const verifiedDelta = Math.max(0, before - after)
      const moved = cause ? verifiedDelta : Math.max(result.moved, verifiedDelta)

      movedTotal += moved
      if (remaining !== Infinity) remaining = Math.max(0, remaining - moved)

      const full = Boolean(result.full || (cause && isDestinationFullError(cause)))
      this.engine.emit('rangeDestinationTried', {
        position,
        moved,
        full,
        error: cause || null
      })

      if (cause && !isDestinationFullError(cause)) throw cause
    }

    if (settleDelayMs > 0) await sleep(settleDelayMs)
    const stillInInventory = countItem(this.bot.inventory.items(), selector, this.bot)
    const requestedNotMoved = remaining === Infinity ? stillInInventory : remaining
    if (requestedNotMoved > 0 && stillInInventory > 0) {
      throw error('DESTINATION_RANGE_FULL', 'All chests in the configured destination range are full', {
        start,
        end,
        moved: movedTotal,
        remaining: Math.min(stillInInventory, requestedNotMoved),
        containersTried: positions.length
      })
    }

    return movedTotal
  }

  async depositWhereRange (range, predicate, options = {}) {
    const start = range.start || range.from || range.startPosition
    const end = range.end || range.to || range.endPosition
    if (!start || !end) throw new TypeError('Range destination requires start and end coordinates')
    const positions = this.findInRange(start, end, { ...range, ...options })
    let movedTotal = 0

    for (const position of positions) {
      const matchingBefore = this.bot.inventory.items().filter(predicate).reduce((sum, stack) => sum + stack.count, 0)
      if (matchingBefore <= 0) break
      let cause = null
      try {
        await this.depositWhere(position, predicate, { ...range, ...options })
      } catch (err) {
        cause = err
      }
      const matchingAfter = this.bot.inventory.items().filter(predicate).reduce((sum, stack) => sum + stack.count, 0)
      movedTotal += Math.max(0, matchingBefore - matchingAfter)
      if (cause && !isDestinationFullError(cause)) throw cause
    }
    return movedTotal
  }

  canonicalContainerKey (block) {
    const position = block.position
    const properties = typeof block.getProperties === 'function' ? block.getProperties() : {}
    const chestType = properties?.type

    if ((block.name === 'chest' || block.name === 'trapped_chest') && chestType && chestType !== 'single') {
      const neighbors = [
        position.offset(1, 0, 0),
        position.offset(-1, 0, 0),
        position.offset(0, 0, 1),
        position.offset(0, 0, -1)
      ]
      for (const neighborPosition of neighbors) {
        const neighbor = this.bot.blockAt(neighborPosition)
        if (!neighbor || neighbor.name !== block.name) continue
        const neighborType = typeof neighbor.getProperties === 'function' ? neighbor.getProperties()?.type : null
        if (!neighborType || neighborType === 'single') continue
        const pair = [position, neighborPosition]
          .map(pos => `${pos.x},${pos.y},${pos.z}`)
          .sort()
        return `double:${pair.join('|')}`
      }
    }

    return `${block.name}:${position.x},${position.y},${position.z}`
  }
}

function containerCapacityForStack (container, stack) {
  const end = Math.max(0, Number(container?.inventoryStart || 0))
  const stackSize = Math.max(1, Number(stack?.stackSize || 64))
  let capacity = 0

  for (let slot = 0; slot < end; slot++) {
    const destination = container.slots?.[slot]
    if (!destination) {
      capacity += stackSize
      continue
    }

    if (sameStackKind(destination, stack)) {
      capacity += Math.max(0, stackSize - Number(destination.count || 0))
    }
  }

  return capacity
}

function sameStackKind (a, b) {
  if (!a || !b) return false
  if (a.type !== b.type || a.metadata !== b.metadata) return false
  return stableNbt(a.nbt) === stableNbt(b.nbt)
}

function stableNbt (nbt) {
  if (nbt == null) return ''
  try {
    return JSON.stringify(nbt)
  } catch {
    return String(nbt)
  }
}

function isInventoryCapacityError (cause) {
  const code = String(cause?.code || '')
  const message = String(cause?.message || cause || '')
  return code === 'INVENTORY_FULL' || /inventory full|destination full|no space|not enough space/i.test(message)
}

function isDestinationFullError (cause) {
  const code = String(cause?.code || '')
  const message = String(cause?.message || cause || '')
  return code === 'DESTINATION_FULL' || /destination full|container full|inventory full|no space|not enough space/i.test(message)
}

module.exports = { ContainerManager, containerCapacityForStack, isDestinationFullError, isInventoryCapacityError, DEFAULT_CONTAINER_NAMES }
