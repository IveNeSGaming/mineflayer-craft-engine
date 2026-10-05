'use strict'

const { normalizeItemName, resolveItem } = require('../utils/items')

function slotItemId (slot) {
  if (!slot) return null
  if (slot.present === false) return null
  return slot.itemId ?? slot.type ?? slot.id ?? null
}

function slotItemCount (slot) {
  return slot?.itemCount ?? slot?.count ?? 1
}

/**
 * Collects every item id that appears in a declared recipe's ingredient list.
 * Handles the shaped (nested width/height arrays) and shapeless layouts used
 * by 1.17.1 - 1.21.1. Returns null when the packet carries no ingredients.
 */
function collectIngredientIds (data) {
  if (!data || !Array.isArray(data.ingredients)) return null
  const ids = new Set()
  const walk = value => {
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry)
      return
    }
    const id = slotItemId(value)
    if (id != null) ids.add(id)
  }
  walk(data.ingredients)
  return ids
}

function isCraftingRecordType (type) {
  // Unknown/unmapped types are kept so custom servers are not filtered out.
  if (type == null || typeof type !== 'string') return true
  const name = type.replace(/^minecraft:/, '')
  return name === 'crafting_shaped' || name === 'crafting_shapeless'
}

function recipeRequirementIds (recipe) {
  const ids = new Set()
  if (Array.isArray(recipe?.delta) && recipe.delta.length) {
    for (const delta of recipe.delta) if (delta.count < 0) ids.add(delta.id)
    return ids
  }
  const parts = recipe?.inShape ? recipe.inShape.flat() : recipe?.ingredients || []
  for (const part of parts) if (part && part.id !== -1) ids.add(part.id)
  return ids
}

class RecipeRegistry {
  constructor (bot) {
    this.bot = bot
    this.byId = new Map()
    this.byResultId = new Map()
    this.manualRecipeIds = new Map()
    this.customRecipes = new Map()
    this._onDeclareRecipes = packet => this.ingestDeclaredRecipes(packet)
    bot._client.on('declare_recipes', this._onDeclareRecipes)
  }

  dispose () {
    this.bot._client.removeListener('declare_recipes', this._onDeclareRecipes)
  }

  /**
   * `declare_recipes` is a full replacement (sent on join and on /reload), so
   * previous records are dropped instead of being appended again.
   */
  ingestDeclaredRecipes (packet) {
    const recipes = Array.isArray(packet?.recipes) ? packet.recipes : []
    this.byId.clear()
    this.byResultId.clear()
    for (const entry of recipes) {
      const recipeId = entry.recipeId || entry.id || entry.name
      if (!recipeId) continue
      const data = entry.data || entry
      const result = data.result || data.output || data.slotDisplay?.data || null
      const resultId = slotItemId(result)
      const record = {
        id: recipeId,
        type: entry.type || data.type || null,
        resultId,
        resultCount: slotItemCount(result),
        ingredientIds: collectIngredientIds(data),
        raw: entry
      }
      this.byId.set(recipeId, record)
      if (resultId != null) {
        if (!this.byResultId.has(resultId)) this.byResultId.set(resultId, [])
        this.byResultId.get(resultId).push(record)
      }
    }
  }

  registerRecipeId (itemName, recipeId) {
    this.manualRecipeIds.set(normalizeItemName(itemName), recipeId)
  }

  registerCustomRecipe (definition) {
    if (!definition || !definition.result) throw new TypeError('Custom recipe requires result')
    const item = resolveItem(this.bot, definition.result.item || definition.result.name || definition.result.id)
    const normalized = {
      id: definition.id || `custom:${item.name}`,
      result: {
        id: item.id,
        metadata: definition.result.metadata ?? null,
        count: definition.result.count ?? 1
      },
      requiresTable: definition.requiresTable !== false,
      inShape: null,
      ingredients: null,
      outShape: null,
      delta: []
    }

    if (definition.shape) {
      normalized.inShape = definition.shape.map(row => row.map(value => {
        if (value == null) return { id: -1, metadata: null, count: 1 }
        const ingredient = typeof value === 'object' ? value : { item: value }
        const resolved = resolveItem(this.bot, ingredient.item || ingredient.name || ingredient.id)
        return { id: resolved.id, metadata: ingredient.metadata ?? null, count: ingredient.count ?? 1 }
      }))
    } else if (definition.ingredients) {
      normalized.ingredients = definition.ingredients.map(value => {
        const ingredient = typeof value === 'object' ? value : { item: value }
        const resolved = resolveItem(this.bot, ingredient.item || ingredient.name || ingredient.id)
        return { id: resolved.id, metadata: ingredient.metadata ?? null, count: ingredient.count ?? 1 }
      })
    } else {
      throw new TypeError('Custom recipe requires shape or ingredients')
    }

    const totals = new Map()
    const parts = normalized.inShape ? normalized.inShape.flat() : normalized.ingredients
    for (const ingredient of parts) {
      if (ingredient.id === -1) continue
      totals.set(ingredient.id, (totals.get(ingredient.id) || 0) + ingredient.count)
    }
    normalized.delta = [...totals.entries()].map(([id, count]) => ({ id, metadata: null, count: -count }))
    normalized.delta.push({ id: item.id, metadata: normalized.result.metadata, count: normalized.result.count })

    if (!this.customRecipes.has(item.id)) this.customRecipes.set(item.id, [])
    this.customRecipes.get(item.id).push(normalized)
    if (definition.recipeId) this.registerRecipeId(item.name, definition.recipeId)
    return normalized
  }

  recipesForResult (itemId) {
    return this.byResultId.get(itemId) || []
  }

  customRecipesForResult (itemId) {
    return this.customRecipes.get(itemId) || []
  }

  /**
   * Picks the server-declared crafting recipe that best matches `recipe`.
   * Smelting/stonecutting/smithing records that share the result item are
   * ignored, and records whose ingredients contain every ingredient of the
   * chosen recipe win over others (e.g. `stick` from planks vs. bamboo).
   */
  declaredRecordFor (itemName, recipe) {
    const resultId = recipe?.result?.id
    if (resultId == null) return null
    const all = this.recipesForResult(resultId)
    if (!all.length) return null
    const crafting = all.filter(record => isCraftingRecordType(record.type))
    const declared = crafting.length ? crafting : all
    if (declared.length === 1) return declared[0]

    const name = normalizeItemName(itemName)
    const required = recipeRequirementIds(recipe)
    const matching = declared.filter(record => {
      if (!record.ingredientIds || !required.size) return true
      for (const id of required) if (!record.ingredientIds.has(id)) return false
      return true
    })
    const pool = matching.length ? matching : declared
    return pool.find(record => record.id === `minecraft:${name}` || record.id === name) ||
      pool.find(record => String(record.id).endsWith(`:${name}`)) ||
      pool[0]
  }

  resolveRecipeId (itemName, recipe, explicitRecipeId) {
    if (explicitRecipeId) return explicitRecipeId
    const name = normalizeItemName(itemName)
    if (this.manualRecipeIds.has(name)) return this.manualRecipeIds.get(name)
    const record = this.declaredRecordFor(name, recipe)
    if (record) return record.id
    return `minecraft:${name}`
  }
}

module.exports = { RecipeRegistry, slotItemId, collectIngredientIds, isCraftingRecordType }
