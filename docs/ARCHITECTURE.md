# Architecture

## Flow

```text
CraftEngine API
    ├── RecipeRegistry
    ├── RecipePlanner
    ├── CraftingManager
    ├── SourceManager
    │   ├── ContainerManager
    │   └── ShopRegistry
    ├── DestinationManager
    ├── ProductionJob
    └── CraftSupervisor
```

## Fast crafting

1. Resolve the target item and a Mineflayer recipe.
2. Resolve the protocol recipe identifier from `declare_recipes`, a manual override,
   or the vanilla `minecraft:<item_name>` convention.
3. Open the crafting-table window when required.
4. Send `craft_recipe_request` with `makeAll`.
5. Wait for result-slot synchronization.
6. Shift-click slot `0` using Mineflayer's inventory transaction implementation.
7. Count output in the open window's player-inventory range.
8. Close the window so Mineflayer copies the window inventory back to
   `bot.inventory`.
9. If any fast step fails, adaptive mode falls back to `bot.craft()`.

The package intentionally lets Mineflayer create `window_click` packets because
Mineflayer already tracks `stateId`, changed slots and cursor state on modern
protocols.

## Recursive planning

The planner treats the desired output as an additional quantity. Existing target
items do not reduce the requested production quantity, while existing ingredient
items do reduce missing requirements.

Cycle prevention is required for reversible recipes such as:

```text
emerald ↔ emerald_block
iron_ingot ↔ iron_block
```

Ancestor item IDs are excluded from candidate recipes. `baseItems` can explicitly
stop recursion at materials supplied by a chest or shop.

## Sources

- `inventory`: use existing inventory.
- container sources: withdraw matching stacks from chest-like blocks.
- `shop`: delegate to a registered adapter.
- `custom`: user-provided acquisition function.

A generic container source without an `items` list is inspected once at production
start. Its current contents are treated as possible base materials.

## Destinations

- inventory: no movement.
- chest-like containers: exact-count deposit.
- drop: toss matching stacks.
- custom: user callback.

## Recovery

`ProductionJob` handles pause, resume, stop and death/spawn recovery within one
connection. `CraftSupervisor` handles full connection replacement by creating a new
Mineflayer bot and restarting production from the last checkpoint.

## Validation included in the package

- JavaScript syntax scan.
- Node unit tests for recipe calculations, cycle prevention, recipe ID capture,
  configuration normalization and fast packet flow.
- TypeScript declaration compilation.
- `npm pack` validation.

A real Minecraft server is still required to validate a server-specific shop GUI,
custom recipes, anticheat limits and real latency behavior.
