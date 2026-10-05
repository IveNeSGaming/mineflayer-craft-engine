'use strict'

const { resolveItem, inventoryCounts, cloneCounts } = require('../utils/items')
const { error } = require('../core/errors')

class RecipePlanner {
  constructor (bot, registry) {
    this.bot = bot
    this.registry = registry
  }

  recipesAll (item, tableAvailable = true) {
    const custom = this.registry.customRecipesForResult(item.id)
    const vanilla = typeof this.bot.recipesAll === 'function'
      ? this.bot.recipesAll(item.id, null, tableAvailable ? {} : null)
      : []
    return [...custom, ...vanilla].filter(recipe => !recipe.requiresTable || tableAvailable)
  }

  requirements (recipe) {
    const merged = new Map()
    if (Array.isArray(recipe.delta) && recipe.delta.length) {
      for (const delta of recipe.delta) {
        if (delta.count >= 0) continue
        const key = `${delta.id}:${delta.metadata ?? '*'}`
        const current = merged.get(key) || { id: delta.id, metadata: delta.metadata ?? null, count: 0 }
        current.count += Math.abs(delta.count)
        merged.set(key, current)
      }
    } else {
      const ingredients = recipe.inShape ? recipe.inShape.flat() : recipe.ingredients || []
      for (const ingredient of ingredients) {
        if (!ingredient || ingredient.id === -1) continue
        const key = `${ingredient.id}:${ingredient.metadata ?? '*'}`
        const current = merged.get(key) || { id: ingredient.id, metadata: ingredient.metadata ?? null, count: 0 }
        current.count += ingredient.count || 1
        merged.set(key, current)
      }
    }
    return [...merged.values()]
  }

  /**
   * Chooses the recipe with the fewest missing materials. When `reachable`
   * (itemId -> boolean) is given, recipes whose missing ingredients are all
   * obtainable from inventory/base items win first, so `stick` picks
   * oak_planks when the source chest holds oak_log instead of an arbitrary
   * plank variant that can never be obtained.
   */
  chooseRecipe (itemSelector, options = {}) {
    const item = resolveItem(this.bot, itemSelector)
    let recipes = this.recipesAll(item, options.tableAvailable !== false)
    if (options.excludeItemIds?.length) {
      const excluded = new Set(options.excludeItemIds)
      recipes = recipes.filter(recipe => !this.requirements(recipe).some(req => excluded.has(req.id)))
    }
    if (!recipes.length) throw error('NO_RECIPE', `No recipe found for ${item.name}`, { item: item.name })

    const counts = options.counts || inventoryCounts(this.bot)
    const reachable = typeof options.reachable === 'function' ? options.reachable : null
    const scored = recipes.map((recipe, index) => {
      const requirements = this.requirements(recipe)
      const missing = requirements.reduce((sum, req) => sum + Math.max(0, req.count - (counts.get(req.id) || 0)), 0)
      const unreachable = reachable && missing > 0
        ? requirements.some(req => (counts.get(req.id) || 0) < req.count && !reachable(req.id))
        : false
      return { recipe, index, missing, unreachable: unreachable ? 1 : 0, requirementKinds: requirements.length }
    }).sort((a, b) =>
      a.unreachable - b.unreachable ||
      a.missing - b.missing ||
      a.requirementKinds - b.requirementKinds ||
      a.index - b.index
    )

    return scored[0].recipe
  }

  /**
   * Builds a memoised "can this item be obtained" predicate: an item is
   * reachable when it is in `counts`, listed as a base item, or craftable from
   * reachable items. Recipe cycles count as unreachable. Returns null when no
   * base items are known (the old fewest-missing ordering is used then).
   */
  createReachability (counts, baseItemIds, tableAvailable) {
    const base = baseItemIds instanceof Set ? baseItemIds : new Set(baseItemIds || [])
    if (!base.size) return null
    const memo = new Map()
    const visiting = new Set()

    const reachable = itemId => {
      if ((counts.get(itemId) || 0) > 0 || base.has(itemId)) return true
      if (memo.has(itemId)) return memo.get(itemId)
      if (visiting.has(itemId)) return false
      visiting.add(itemId)
      let result = false
      try {
        const item = this.bot.registry.items[itemId]
        const recipes = item ? this.recipesAll(item, tableAvailable) : []
        result = recipes.some(recipe => {
          const requirements = this.requirements(recipe)
          return requirements.length > 0 && requirements.every(req => req.id !== itemId && reachable(req.id))
        })
      } finally {
        visiting.delete(itemId)
      }
      memo.set(itemId, result)
      return result
    }
    return reachable
  }

  /*
   * Serverning o'zi e'lon qilgan (`declare_recipes` paketi) retsept bilan
   * kutubxona tanlagan retsept (odatda mineflayer'ning statik minecraft-data
   * bazasidan) BIR XIL natija itemini ishlab chiqarsa-yu, lekin natija
   * MIQDORI (masalan 1 dona o'rniga 4 dona) farq qilsa — bu real
   * production'da "Not enough materials" kabi tushunarsiz xatolarning
   * yashirin sababi bo'lishi mumkin, chunki operations/miqdor hisob-kitobi
   * NOTO'G'RI (eskirgan yoki mos kelmaydigan) retsept asosida ketadi.
   * Faqat engine haqiqatda so'raydigan declared retsept bilan solishtiriladi
   * (aks holda `stick` (4) va `stick_from_bamboo_item` (1) soxta signal beradi).
   */
  findDeclaredMismatch (item, recipe) {
    const record = typeof this.registry.declaredRecordFor === 'function'
      ? this.registry.declaredRecordFor(item.name, recipe)
      : (this.registry.recipesForResult(recipe.result.id) || [])[0]
    if (!record) return null
    if (!Number.isFinite(record.resultCount) || record.resultCount === recipe.result.count) return null

    return {
      item: item.name,
      expectedCount: recipe.result.count,
      declaredCount: record.resultCount,
      recipeId: record.id
    }
  }

  maxOperations (recipe, counts = inventoryCounts(this.bot)) {
    const requirements = this.requirements(recipe)
    if (!requirements.length) return 0
    let max = Infinity
    for (const req of requirements) {
      max = Math.min(max, Math.floor((counts.get(req.id) || 0) / req.count))
    }
    return Number.isFinite(max) ? Math.max(0, max) : 0
  }

  operationsForOutput (recipe, outputCount) {
    return Math.ceil(outputCount / recipe.result.count)
  }

  simulateRecursive (itemSelector, outputCount, counts = inventoryCounts(this.bot), options = {}) {
    const wantedOutput = Number(outputCount)
    if (!Number.isFinite(wantedOutput) || wantedOutput < 0) {
      throw new TypeError(`simulateRecursive() needs a finite, non-negative amount, got ${outputCount}`)
    }
    const working = cloneCounts(counts)
    const steps = []
    const stack = []
    const tableAvailable = options.tableAvailable !== false
    const baseItemIds = new Set(options.baseItemIds || [])
    const rootItem = resolveItem(this.bot, itemSelector)
    const reachable = this.createReachability(cloneCounts(counts), baseItemIds, tableAvailable)

    const build = (selector, wanted) => {
      const item = resolveItem(this.bot, selector)
      const have = working.get(item.id) || 0
      if (have >= wanted) return
      const missing = wanted - have
      if (item.id !== rootItem.id && baseItemIds.has(item.id)) {
        throw error('MISSING_MATERIAL', `Missing base material ${item.name}`, { itemId: item.id, required: missing })
      }
      if (stack.includes(item.id)) throw error('RECIPE_CYCLE', `Recipe cycle detected at ${item.name}`)
      stack.push(item.id)

      const recipe = this.chooseRecipe(item.id, { counts: working, tableAvailable, excludeItemIds: stack, reachable })
      const operations = this.operationsForOutput(recipe, missing)
      for (const req of this.requirements(recipe)) {
        const total = req.count * operations
        const current = working.get(req.id) || 0
        if (current < total) build(req.id, total)
        if ((working.get(req.id) || 0) < total) {
          throw error('MISSING_MATERIAL', `Missing material ${this.bot.registry.items[req.id]?.name || req.id}`, { itemId: req.id, required: total })
        }
        working.set(req.id, (working.get(req.id) || 0) - total)
      }
      const produced = recipe.result.count * operations
      working.set(item.id, (working.get(item.id) || 0) + produced)
      steps.push({ item, recipe, operations, outputCount: produced })
      stack.pop()
    }

    const existingRoot = working.get(rootItem.id) || 0
    build(rootItem.id, existingRoot + wantedOutput)
    return { steps, finalCounts: working }
  }

  leafRequirements (itemSelector, outputCount, options = {}) {
    const counts = options.counts ? cloneCounts(options.counts) : new Map()
    const leaves = new Map()
    const stack = []
    const tableAvailable = options.tableAvailable !== false
    const baseItemIds = new Set(options.baseItemIds || [])
    const rootItem = resolveItem(this.bot, itemSelector)
    const reachable = this.createReachability(cloneCounts(counts), baseItemIds, tableAvailable)

    const expand = (selector, wanted) => {
      const item = resolveItem(this.bot, selector)
      const existing = counts.get(item.id) || 0
      if (existing >= wanted) {
        counts.set(item.id, existing - wanted)
        return
      }
      const missing = wanted - existing
      counts.set(item.id, 0)
      if (item.id !== rootItem.id && baseItemIds.has(item.id)) {
        leaves.set(item.id, (leaves.get(item.id) || 0) + missing)
        return
      }
      if (stack.includes(item.id)) throw error('RECIPE_CYCLE', `Recipe cycle detected at ${item.name}`)
      stack.push(item.id)
      let recipe
      try {
        recipe = this.chooseRecipe(item.id, { counts, tableAvailable, excludeItemIds: stack, reachable })
      } catch (err) {
        if (err.code !== 'NO_RECIPE') throw err
        leaves.set(item.id, (leaves.get(item.id) || 0) + missing)
        stack.pop()
        return
      }
      const operations = this.operationsForOutput(recipe, missing)
      for (const req of this.requirements(recipe)) expand(req.id, req.count * operations)
      const surplus = recipe.result.count * operations - missing
      if (surplus > 0) counts.set(item.id, (counts.get(item.id) || 0) + surplus)
      stack.pop()
    }

    const existingRoot = counts.get(rootItem.id) || 0
    expand(rootItem.id, existingRoot + outputCount)
    return [...leaves.entries()].map(([id, count]) => ({ id, name: this.bot.registry.items[id]?.name, count }))
  }

  maxRecursiveOutput (itemSelector, upperBound, counts = inventoryCounts(this.bot), options = {}) {
    let low = 0
    const bound = Number(upperBound)
    // A non-finite bound (Infinity/NaN) would make the binary search loop forever.
    let high = Number.isFinite(bound) ? Math.max(0, Math.floor(bound)) : 0
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      try {
        this.simulateRecursive(itemSelector, mid, counts, options)
        low = mid
      } catch (err) {
        if (!['MISSING_MATERIAL', 'NO_RECIPE', 'RECIPE_CYCLE'].includes(err.code)) throw err
        high = mid - 1
      }
    }
    return low
  }

  describe (itemSelector, amount, options = {}) {
    const item = resolveItem(this.bot, itemSelector)
    const recipe = this.chooseRecipe(item.id, { tableAvailable: options.tableAvailable !== false })
    const operations = amount === 'all' ? this.maxOperations(recipe) : this.operationsForOutput(recipe, amount)
    return {
      item: item.name,
      resultPerOperation: recipe.result.count,
      operations,
      requirements: this.requirements(recipe).map(req => ({
        item: this.bot.registry.items[req.id]?.name || String(req.id),
        count: req.count * operations
      }))
    }
  }
}

module.exports = { RecipePlanner }
