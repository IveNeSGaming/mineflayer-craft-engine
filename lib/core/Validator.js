'use strict'

const { toVec3, boxVolume } = require('../utils/positions')
const { resolveItem } = require('../utils/items')
const { isRangeSource } = require('../sources/SourceManager')
const { isRangeType } = require('../destinations/DestinationManager')
const { normalizeProductionOptions } = require('../production/ProductionJob')

const CONTAINER_BLOCK_NAMES = ['chest', 'trapped_chest', 'barrel', 'ender_chest']

function isContainerBlockName (name) {
  if (!name) return false
  if (CONTAINER_BLOCK_NAMES.includes(name)) return true
  return name.includes('shulker_box')
}

function pushIssue (issues, code, message, field) {
  issues.push({ code, message, field })
}

function checkPosition (position, issues, field) {
  try {
    return toVec3(position)
  } catch (err) {
    pushIssue(issues, 'BAD_POSITION', err.message, field)
    return null
  }
}

function checkContainerBlock (bot, position, issues, field) {
  const vec = checkPosition(position, issues, field)
  if (!vec) return

  const block = bot.blockAt(vec)
  if (!block) {
    pushIssue(issues, 'BLOCK_NOT_LOADED', `No block loaded at ${vec} for ${field} (chunk may not be loaded)`, field)
    return
  }
  if (!isContainerBlockName(block.name)) {
    pushIssue(issues, 'NOT_A_CONTAINER', `Expected a chest/barrel/shulker/ender_chest at ${vec} for ${field}, found ${block.name}`, field)
  }
}

function checkCraftingTable (bot, position, issues, field) {
  const vec = checkPosition(position, issues, field)
  if (!vec) return

  const block = bot.blockAt(vec)
  if (!block) {
    pushIssue(issues, 'BLOCK_NOT_LOADED', `No block loaded at ${vec} for ${field} (chunk may not be loaded)`, field)
    return
  }
  if (block.name !== 'crafting_table') {
    pushIssue(issues, 'NOT_A_CRAFTING_TABLE', `Expected crafting_table at ${vec} for ${field}, found ${block.name}`, field)
  }
}

function checkRange (range, issues, field) {
  const start = checkPosition(range.start || range.from || range.startPosition, issues, `${field}.start`)
  const end = checkPosition(range.end || range.to || range.endPosition, issues, `${field}.end`)
  if (!start || !end) {
    if (!start && !(range.start || range.from || range.startPosition)) pushIssue(issues, 'MISSING_POSITION', `${field} is a range but has no start`, `${field}.start`)
    if (!end && !(range.end || range.to || range.endPosition)) pushIssue(issues, 'MISSING_POSITION', `${field} is a range but has no end`, `${field}.end`)
    return
  }
  const limit = Number(range.maxRangeBlocks) > 0 ? Number(range.maxRangeBlocks) : 131072
  const volume = boxVolume(start, end)
  if (volume > limit) {
    pushIssue(issues, 'RANGE_TOO_LARGE', `${field} covers ${volume} blocks (limit ${limit}); check the coordinates`, field)
  }
}

function checkShopSource (engine, source, issues, field) {
  const usesBuiltInAdapter = typeof source.adapter !== 'object'

  if (usesBuiltInAdapter) {
    try {
      engine.shops.get(source.adapter || 'command-gui')
    } catch (err) {
      pushIssue(issues, 'SHOP_ADAPTER_NOT_FOUND', err.message, field)
    }
  }

  // command-gui (the default adapter) needs a command to open the shop.
  if (usesBuiltInAdapter && (!source.adapter || source.adapter === 'command-gui')) {
    if (!source.command && !source.openCommand) {
      pushIssue(issues, 'SHOP_COMMAND_MISSING', `${field} is a shop source but has no command/openCommand`, field)
    }
  }

  if (source.maxSpend != null && !(Number(source.costPerUnit) > 0)) {
    pushIssue(issues, 'SHOP_BUDGET_MISCONFIGURED', `${field} sets maxSpend but no positive costPerUnit — the budget will never apply`, field)
  }
}

function checkSource (bot, engine, source, issues, field) {
  const type = source.type || 'inventory'
  if (type === 'inventory') return

  if (type === 'shop') {
    checkShopSource(engine, source, issues, field)
    return
  }

  if (isRangeSource(source)) {
    checkRange(source, issues, field)
    return
  }

  if (['chest', 'barrel', 'shulker', 'ender_chest', 'container'].includes(type)) {
    const position = source.position || source.pos || source.chest
    if (!position) {
      pushIssue(issues, 'MISSING_POSITION', `${field} is a ${type} source but has no position`, field)
      return
    }
    checkContainerBlock(bot, position, issues, field)
    return
  }

  if (type === 'custom') {
    if (typeof source.acquire !== 'function') {
      pushIssue(issues, 'CUSTOM_SOURCE_MISSING_ACQUIRE', `${field} is a custom source but has no acquire() function`, field)
    }
    return
  }

  pushIssue(issues, 'SOURCE_TYPE_UNSUPPORTED', `${field} has an unsupported source type: ${type}`, field)
}

function checkDestination (bot, destination, issues, field) {
  if (!destination || destination.type === 'inventory') return
  const type = destination.type || (destination.start && destination.end ? 'container-range' : 'chest')

  if (isRangeType(type) || (destination.start && destination.end)) {
    checkRange(destination, issues, field)
    return
  }

  if (['chest', 'barrel', 'shulker', 'ender_chest', 'container'].includes(type)) {
    const position = destination.position || destination.pos || destination.chest
    if (!position) {
      pushIssue(issues, 'MISSING_POSITION', `${field} is a ${type} destination but has no position`, field)
      return
    }
    checkContainerBlock(bot, position, issues, field)
    return
  }

  if (type === 'drop') return

  if (type === 'custom') {
    if (typeof destination.deposit !== 'function') {
      pushIssue(issues, 'CUSTOM_DESTINATION_MISSING_DEPOSIT', `${field} is a custom destination but has no deposit() function`, field)
    }
    return
  }

  pushIssue(issues, 'DESTINATION_TYPE_UNSUPPORTED', `${field} has an unsupported destination type: ${type}`, field)
}

/*
 * production() ishga tushishidan OLDIN uning konfiguratsiyasini
 * tekshiradi — hech qanday konteyner ochilmaydi, hech narsa sotib
 * olinmaydi, bot joyidan qimirlamaydi. Ko'p-bot/ko'p-server sozlamalarda
 * (masalan har xil koordinatali bir nechta akkaunt) xato koordinata yoki
 * yo'q bloklarni ISHGA TUSHISHDAN OLDIN topish uchun.
 */
function validateProductionOptions (engine, options) {
  const issues = []
  let config

  try {
    config = normalizeProductionOptions(options)
  } catch (err) {
    return { ok: false, issues: [{ code: 'BAD_OPTIONS', message: err.message, field: null }] }
  }

  try {
    resolveItem(engine.bot, config.target.item)
  } catch (err) {
    pushIssue(issues, 'UNKNOWN_ITEM', err.message, 'target.item')
  }

  if (config.craftingTable) {
    checkCraftingTable(engine.bot, config.craftingTable, issues, 'craftingTable')
  }

  config.sources.forEach((source, index) => {
    checkSource(engine.bot, engine, source, issues, `sources[${index}]`)
  })

  if (config.output) checkDestination(engine.bot, config.output, issues, 'output')
  if (config.leftovers) checkDestination(engine.bot, config.leftovers, issues, 'leftovers')
  if (config.inventoryBuffer) checkDestination(engine.bot, config.inventoryBuffer, issues, 'inventoryBuffer')

  try {
    engine.planner.chooseRecipe(config.target.item, { tableAvailable: Boolean(config.craftingTable) })
  } catch (err) {
    pushIssue(issues, 'NO_RECIPE', err.message, 'target.item')
  }

  return { ok: issues.length === 0, issues }
}

module.exports = { validateProductionOptions, isContainerBlockName }
