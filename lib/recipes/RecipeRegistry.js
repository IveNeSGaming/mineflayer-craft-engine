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

  ingestDeclaredRecipes (packet) {
    const recipes = Array.isArray(packet?.recipes) ? packet.recipes : []
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

  resolveRecipeId (itemName, recipe, explicitRecipeId) {
    if (explicitRecipeId) return explicitRecipeId
    const name = normalizeItemName(itemName)
    if (this.manualRecipeIds.has(name)) return this.manualRecipeIds.get(name)

    const declared = this.recipesForResult(recipe.result.id)
    if (declared.length === 1) return declared[0].id
    if (declared.length > 1) {
      const exact = declared.find(record => record.id === `minecraft:${name}` || record.id.endsWith(`:${name}`))
      if (exact) return exact.id
      return declared[0].id
    }

    return `minecraft:${name}`
  }
}

module.exports = { RecipeRegistry, slotItemId }
