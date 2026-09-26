# Server adapter checklist

For a custom GUI shop, record these values:

1. Command used to open the shop.
2. Exact or partial window title.
3. Product slot.
4. Left, right, shift-left or shift-right click.
5. Quantity received per click.
6. Whether a confirmation GUI opens.
7. Confirmation slot.
8. Minimum safe delay between clicks.
9. How insufficient money is reported.
10. Whether the purchased item has custom NBT, display name or lore.

Start with `mode: 'adaptive'` and a non-zero `clickDelayMs`. Reduce the delay only
after checking that inventory counts remain synchronized.
