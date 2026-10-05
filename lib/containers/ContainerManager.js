'use strict'

const { toVec3, positionsInBox, boxVolume } = require('../utils/positions')
const { resolveItem, itemMatches, countItem } = require('../utils/items')
const { retry, sleep } = require('../utils/async')
const { error } = require('../core/errors')

const DEFAULT_CONTAINER_NAMES = [
  'chest',
  'trapped_chest',
  'barrel',
  'ender_chest'
]

// Guards against a mistyped coordinate turning a range into millions of blocks.
const DEFAULT_MAX_RANGE_BLOCKS = 131072

const HORIZONTAL_OFFSETS = {
  north: [0, 0, -1],
  south: [0, 0, 1],
  east: [1, 0, 0],
  west: [-1, 0, 0]
}
const CLOCKWISE = { north: 'east', east: 'south', south: 'west', west: 'north' }
const COUNTER_CLOCKWISE = { north: 'west', west: 'south', south: 'east', east: 'north' }

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
    try {
      await this.bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, range))
    } catch (cause) {
      // Containers and tables behind a wall/table often have no standing spot
      // within `range`, yet can be used from anywhere they are visible within
      // reach. Retry with that goal before giving up.
      if (!goals.GoalLookAtBlock || !isNoPathError(cause)) throw cause
      this.engine.emit('retry', { operation: 'goTo:lookAtBlock', attempt: 1, cause })
      await this.bot.pathfinder.goto(new goals.GoalLookAtBlock(target.floored(), this.bot.world, { reach: 4.5 }))
    }
  }

  getBlock (position) {
    const vector = toVec3(position)
    const block = this.bot.blockAt(vector)
    if (!block) {
      // blockAt() returns null only for chunks the client has not loaded,
      // which almost always means the bot is somewhere else than expected.
      const own = this.bot.entity?.position
      const where = own ? `; bot is at ${own.floored()} (${Math.round(own.distanceTo(vector))} blocks away), chunk not loaded` : ''
      throw error('BLOCK_NOT_FOUND', `No block found at ${vector}${where}`, { position: vector, botPosition: own || null })
    }
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

  /**
   * Withdraws at most what fits into the player-inventory part of an open
   * container window. Mineflayer's transfer throws `destination full` while
   * still holding the item on the cursor, so the amount is clamped first.
   */
  async withdrawFromWindow (container, selector, amount) {
    // Grouped by item kind: Mineflayer moves items across several stacks in
    // one withdraw() call and mutates the stack objects while doing so, so a
    // per-stack snapshot loop would stop early.
    const kinds = groupByKind(container.containerItems().filter(stack => itemMatches(stack, selector, this.bot)))
    let remaining = parseAmount(amount)
    let moved = 0
    let full = false
    for (const kind of kinds) {
      if (remaining <= 0) break
      const wanted = Math.min(kind.total, remaining)
      const capacity = playerCapacityForStack(container, kind.stack)
      const count = Math.min(wanted, capacity)
      if (count > 0) {
        await container.withdraw(kind.stack.type, kind.stack.metadata, count, kind.stack.nbt)
        moved += count
        if (remaining !== Infinity) remaining -= count
      }
      if (count < wanted) full = true
    }
    return { moved, full }
  }

  async withdraw (position, selector, amount, options = {}) {
    const item = typeof selector === 'string' || typeof selector === 'number' ? resolveItem(this.bot, selector) : null
    const container = await this.open(position, options)
    try {
      const { moved } = await this.withdrawFromWindow(container, selector, amount)
      if (options.required && amount !== 'all' && amount !== Infinity && moved < Number(amount)) {
        throw error('SOURCE_SHORTAGE', `Container supplied ${moved}/${amount} ${item?.name || 'items'}`, { moved, amount })
      }
      return moved
    } finally {
      container.close()
    }
  }

  /**
   * Deposits into one container without exceeding its free capacity. Throws a
   * clean DESTINATION_FULL error (nothing left on the cursor) when the
   * requested amount does not fit; `details.moved` holds what was stored.
   */
  async deposit (position, selector, amount = 'all', options = {}) {
    const requested = parseAmount(amount)
    const available = countItem(this.bot.inventory.items(), selector, this.bot)
    const { moved, full } = await this.depositUpToCapacity(position, selector, amount, options)
    const wanted = requested === Infinity ? available : Math.min(requested, available)
    if (full && moved < wanted) {
      throw error('DESTINATION_FULL', `Container at ${toVec3(position)} is full (${moved}/${wanted} stored)`, { moved, requested: wanted, position })
    }
    return moved
  }

  async depositWhere (position, predicate, options = {}) {
    const container = await this.open(position, options)
    let moved = 0
    let blocked = 0
    try {
      for (const kind of groupByKind(this.bot.inventory.items().filter(predicate))) {
        const capacity = containerCapacityForStack(container, kind.stack)
        const count = Math.min(kind.total, capacity)
        if (count > 0) {
          await container.deposit(kind.stack.type, kind.stack.metadata, count, kind.stack.nbt)
          moved += count
        }
        blocked += kind.total - count
      }
    } finally {
      container.close()
    }
    if (blocked > 0) {
      throw error('DESTINATION_FULL', `Container at ${toVec3(position)} is full (${blocked} items did not fit)`, { moved, remaining: blocked, position })
    }
    return moved
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
      let remaining = parseAmount(amount)
      const kinds = groupByKind(this.bot.inventory.items().filter(stack => itemMatches(stack, selector, this.bot)))

      for (const kind of kinds) {
        if (remaining <= 0) break
        const wanted = Math.min(kind.total, remaining)
        const capacity = containerCapacityForStack(container, kind.stack)
        const count = Math.min(wanted, capacity)
        if (count > 0) {
          await container.deposit(kind.stack.type, kind.stack.metadata, count, kind.stack.nbt)
          moved += count
          if (remaining !== Infinity) remaining -= count
        }
        if (count < wanted || containerCapacityForStack(container, kind.stack) <= 0) full = true
      }

      return { moved, full }
    } finally {
      container.close()
    }
  }

  /**
   * Withdraw matching items from every container in an inclusive coordinate range.
   * Containers with less than minAvailable matching items can be skipped.
   * Each container is opened once (count + withdraw in the same window).
   */
  async withdrawRange (range, selector, amount = 'all', options = {}) {
    const start = range.start || range.from || range.startPosition
    const end = range.end || range.to || range.endPosition
    if (!start || !end) throw new TypeError('Range source requires start and end coordinates')

    const positions = this.findInRange(start, end, { ...range, ...options })
    if (!positions.length) return 0

    let remaining = parseAmount(amount)
    let movedTotal = 0
    const minAvailable = Math.max(1, Number(range.minAvailable || range.minimumAvailable || range.minimumStack || 1))

    for (const position of positions) {
      if (remaining <= 0) break
      let container
      try {
        container = await this.open(position, { ...range, ...options })
      } catch (cause) {
        this.engine.emit('rangeSourceTried', { position, available: 0, moved: 0, skipped: true, error: cause })
        continue
      }

      let available = 0
      let moved = 0
      let full = false
      let cause = null
      let skipped = false
      try {
        available = countItem(container.containerItems(), selector, this.bot)
        if (available < minAvailable) {
          skipped = true
        } else {
          const wanted = remaining === Infinity ? available : Math.min(available, remaining)
          const before = countItem(container.items(), selector, this.bot)
          try {
            full = (await this.withdrawFromWindow(container, selector, wanted)).full
          } catch (err) {
            cause = err
          }
          moved = Math.max(0, countItem(container.items(), selector, this.bot) - before)
        }
      } finally {
        container.close()
      }

      movedTotal += moved
      if (remaining !== Infinity) remaining = Math.max(0, remaining - moved)
      this.engine.emit('rangeSourceTried', { position, available, moved, skipped, error: cause })

      if (cause && !isInventoryCapacityError(cause)) throw cause
      if (full || cause) break
    }

    return movedTotal
  }

  /** Find all supported containers inside an inclusive coordinate range. */
  findInRange (start, end, options = {}) {
    const explicit = options.blockNames || options.blocks || options.containerNames
    const allowed = new Set((explicit || DEFAULT_CONTAINER_NAMES).map(String))
    const includeShulkers = options.includeShulkers !== false
    const maxBlocks = Number(options.maxRangeBlocks) > 0 ? Number(options.maxRangeBlocks) : DEFAULT_MAX_RANGE_BLOCKS
    const volume = boxVolume(start, end)
    if (volume > maxBlocks) {
      throw error('RANGE_TOO_LARGE', `Container range covers ${volume} blocks (limit ${maxBlocks}); check start/end coordinates or raise maxRangeBlocks`, { start, end, volume })
    }
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

    let remaining = parseAmount(amount)
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

  /**
   * Returns one key per physical container so both halves of a double chest
   * are visited once. The partner half is located from the `facing` + `type`
   * block state exactly like vanilla does, so two separate double chests
   * standing side by side are never merged or split incorrectly.
   */
  canonicalContainerKey (block) {
    const position = block.position
    const properties = typeof block.getProperties === 'function' ? block.getProperties() : {}
    const chestType = properties?.type

    if ((block.name === 'chest' || block.name === 'trapped_chest') && chestType && chestType !== 'single') {
      const pairKey = partner => {
        const pair = [position, partner]
          .map(pos => `${pos.x},${pos.y},${pos.z}`)
          .sort()
        return `double:${pair.join('|')}`
      }

      const facing = properties?.facing
      const direction = chestType === 'left' ? CLOCKWISE[facing] : chestType === 'right' ? COUNTER_CLOCKWISE[facing] : null
      if (direction) {
        const partner = position.offset(...HORIZONTAL_OFFSETS[direction])
        const neighbor = this.bot.blockAt(partner)
        if (neighbor && neighbor.name === block.name) return pairKey(partner)
        // Partner not loaded / not a chest: treat this half as its own container.
        return `${block.name}:${position.x},${position.y},${position.z}`
      }

      // No facing data (old/custom block states): fall back to a neighbour scan.
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
        if (!neighborType || neighborType === 'single' || neighborType === chestType) continue
        return pairKey(neighborPosition)
      }
    }

    return `${block.name}:${position.x},${position.y},${position.z}`
  }
}

/**
 * Groups stacks by item kind (type + metadata + NBT) and sums their counts.
 * The representative stack is copied so later Mineflayer mutations of the
 * live slot objects cannot change it.
 */
function groupByKind (stacks) {
  const kinds = new Map()
  for (const stack of stacks) {
    const id = `${stack.type}:${stack.metadata}:${stableNbt(stack.nbt)}`
    const entry = kinds.get(id)
    if (entry) entry.total += stack.count
    else kinds.set(id, { stack: { type: stack.type, metadata: stack.metadata, nbt: stack.nbt, stackSize: stack.stackSize, name: stack.name }, total: stack.count })
  }
  return [...kinds.values()]
}

function parseAmount (amount) {
  if (amount === 'all' || amount === Infinity) return Infinity
  const value = Number(amount)
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function capacityInSlots (slots, start, end, stack) {
  const stackSize = Math.max(1, Number(stack?.stackSize || 64))
  let capacity = 0
  for (let slot = start; slot < end; slot++) {
    const destination = slots?.[slot]
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

/** Free room for `stack` inside the container part of an open window. */
function containerCapacityForStack (container, stack) {
  const end = Math.max(0, Number(container?.inventoryStart || 0))
  return capacityInSlots(container?.slots, 0, end, stack)
}

/** Free room for `stack` inside the player-inventory part of an open window. */
function playerCapacityForStack (container, stack) {
  const start = Number(container?.inventoryStart)
  const end = Number(container?.inventoryEnd)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return Infinity
  return capacityInSlots(container.slots, start, end, stack)
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

function isNoPathError (cause) {
  const name = String(cause?.name || '')
  const message = String(cause?.message || '')
  return name === 'NoPath' || name === 'Timeout' || /no path|took to long|too long to decide/i.test(message)
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

module.exports = {
  ContainerManager,
  containerCapacityForStack,
  playerCapacityForStack,
  isDestinationFullError,
  isInventoryCapacityError,
  DEFAULT_CONTAINER_NAMES
}
