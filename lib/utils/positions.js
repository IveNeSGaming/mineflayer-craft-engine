'use strict'

const { Vec3 } = require('vec3')

function toVec3 (position) {
  if (!position) return null
  if (position instanceof Vec3) return position
  if (Array.isArray(position) && position.length >= 3) return new Vec3(Number(position[0]), Number(position[1]), Number(position[2]))
  if (typeof position === 'object' && ['x', 'y', 'z'].every(key => Number.isFinite(Number(position[key])))) {
    return new Vec3(Number(position.x), Number(position.y), Number(position.z))
  }
  throw new TypeError(`Invalid position: ${JSON.stringify(position)}`)
}

function axisValues (start, end) {
  const values = []
  const step = start <= end ? 1 : -1
  for (let value = start; step > 0 ? value <= end : value >= end; value += step) values.push(value)
  return values
}

/**
 * Returns every integer block position inside the inclusive start/end box.
 * Traversal follows the start -> end direction on each axis.
 */
function positionsInBox (start, end) {
  const a = toVec3(start).floored()
  const b = toVec3(end).floored()
  const xs = axisValues(a.x, b.x)
  const ys = axisValues(a.y, b.y)
  const zs = axisValues(a.z, b.z)
  const positions = []

  // X is innermost so a normal chest row on X is visited start-to-end.
  for (const y of ys) {
    for (const z of zs) {
      for (const x of xs) positions.push(new Vec3(x, y, z))
    }
  }
  return positions
}

module.exports = { toVec3, positionsInBox }
