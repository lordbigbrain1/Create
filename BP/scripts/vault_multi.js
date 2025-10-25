// vault_multi.js
// Validator & grouper for sag:vault with stability, canonical facing, and independent-adjacent assembly.
// - Valid forms: 1x1x1, 1x1xL(L>=2), 2x2x1, 2x2xL(L>=2), 3x3x1, 3x3xL(L>=2)
// - Canonical facing: NORTH -> SOUTH; WEST -> EAST
// - Stable: valid structures are not rebuilt by stray neighbors unless a FULL new length-layer is completed
// - Independent assembly: a new structure can assemble even if it touches another valid structure (side-by-side)
// - On break/change, structures rebuild into the maximal valid partition
// - Uses world dynamic property registry and signature-based fast exit
//
// Requirements for block sag:vault:
// - orientation state: "minecraft:cardinal_direction" в€€ {"north","south","west","east"}
// - states: "sag:tier" в€€ {"1","2","3"}, "sag:segment" в€€ {"unit","face","middle","back"},
//           "sag:cell" в€€ {"single","lu","ru","lb","rb","tl","tc","tr","ml","mc","mr","bl","bc","br"}
//
// Place under behavior_packs/<your_pack>/scripts/ and import from main.js:
//   import "./vault_multi.js";
//
// No Vector3; modern @minecraft/server.
import { world, system } from "@minecraft/server";

// ===================== Config =====================
const NET_BLOCK_ID = "sag:vault";
const CARDINAL_PROP = "minecraft:cardinal_direction";
const INVERT_VERTICAL = true;            // 0-row is TOP (invert Y for cells)
const APPLY_FALLBACK_FOR_INVALID = true; // fallback states for non-valid leftover blocks
const MAX_LENGTH = 9;                    // set null to remove cap

// world dynamic property key for groups registry
const REG_KEY = "sag:vault_groups_v1";

// ===================== Adjacency =====================
const OFFS6 = [
  [1, 0, 0], [-1, 0, 0],
  [0, 1, 0], [0, -1, 0],
  [0, 0, 1], [0, 0, -1],
];

// ===================== Utils =====================
const isVault = (b) => b && b.typeId === NET_BLOCK_ID;
const canonicalFacing = (f) => (f === "north" ? "south" : (f === "west" ? "east" : f));

function keyOf(b) {
  return `${b.dimension.id}|${b.location.x}|${b.location.y}|${b.location.z}`;
}

function facingOf(b) {
  try { return b.permutation.getState(CARDINAL_PROP); } catch { return undefined; }
}

function setFacingIfNeeded(b) {
  try {
    const perm = b.permutation;
    const f = perm.getState(CARDINAL_PROP);
    const cf = canonicalFacing(f);
    if (cf !== f) {
      const np = perm.withState(CARDINAL_PROP, cf);
      b.setPermutation(np);
      return true; // changed
    }
  } catch { }
  return false;
}

function basisFor(facing) {
  // local axes: F (length), L (left), U (up)
  switch (facing) {
    case "east": return { F: [1, 0, 0], L: [0, 0, -1], U: [0, 1, 0] };
    case "west": return { F: [-1, 0, 0], L: [0, 0, 1], U: [0, 1, 0] };
    case "south": return { F: [0, 0, 1], L: [1, 0, 0], U: [0, 1, 0] };
    case "north":
    default: return { F: [0, 0, -1], L: [-1, 0, 0], U: [0, 1, 0] };
  }
}

function worldToLocal(pos, origin, B) {
  const dx = pos.x - origin.x;
  const dy = pos.y - origin.y;
  const dz = pos.z - origin.z;
  return {
    s: dx * B.F[0] + dy * B.F[1] + dz * B.F[2],
    u: dx * B.L[0] + dy * B.L[1] + dz * B.L[2],
    t: dx * B.U[0] + dy * B.U[1] + dz * B.U[2],
  };
}

function localToWorld(origin, B, s, u, t) {
  return {
    x: origin.x + s * B.F[0] + u * B.L[0] + t * B.U[0],
    y: origin.y + s * B.F[1] + u * B.L[1] + t * B.U[1],
    z: origin.z + s * B.F[2] + u * B.L[2] + t * B.U[2],
  };
}

// ===================== Groups registry =====================
let groups = new Map();     // id -> { dimId, facing, size, sStart, sEnd, origin:{x,y,z}, uMin, tMin, keys:Set<string>, signature:string }
let indexByKey = new Map(); // blockKey -> groupId
let nextGroupId = 1;

function saveGroups() {
  try {
    const serial = {
      nextGroupId,
      groups: [...groups.entries()].map(([id, g]) => [id, { ...g, keys: [...g.keys] }]),
    };
    world.setDynamicProperty(REG_KEY, JSON.stringify(serial));
  } catch { }
}

function loadGroups() {
  try {
    const raw = world.getDynamicProperty(REG_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    nextGroupId = obj.nextGroupId || 1;
    groups.clear(); indexByKey.clear();
    for (const [id, g] of obj.groups) {
      g.keys = new Set(g.keys);
      groups.set(+id, g);
      for (const k of g.keys) indexByKey.set(k, +id);
    }
  } catch { }
}

function signatureFor(g) {
  const sorted = [...g.keys].sort().join("|");
  return `${g.facing}|${g.size}|${g.sStart}|${g.sEnd}|${sorted}`;
}

// initial load
loadGroups();

// ===================== Cross-section masks =====================
function maskForSize(size) {
  if (size === 1) return [[0, 0]];
  if (size === 2) return [[0, 0], [1, 0], [0, 1], [1, 1]];
  return [
    [0, 0], [1, 0], [2, 0],
    [0, 1], [1, 1], [2, 1],
    [0, 2], [1, 2], [2, 2],
  ];
}
const tierMaskSize = { 1: 1, 2: 4, 3: 9 };

// ===================== Floods =====================
function floodComponentSameFacing(seed) {
  const dim = seed.dimension;
  const facing = canonicalFacing(facingOf(seed));
  const stack = [seed];
  const seen = new Set();
  const nodes = [];
  const kf = (b) => `${b.location.x}|${b.location.y}|${b.location.z}`;

  while (stack.length) {
    const b = stack.pop();
    const kk = kf(b);
    if (seen.has(kk)) continue;
    seen.add(kk);
    if (!isVault(b)) continue;
    if (canonicalFacing(facingOf(b)) !== facing) continue;
    nodes.push(b);
    for (const [dx, dy, dz] of OFFS6) {
      const nb = dim.getBlock({ x: b.location.x + dx, y: b.location.y + dy, z: b.location.z + dz });
      if (nb) stack.push(nb);
    }
  }
  return { nodes, facing };
}

// independent flood (barrier = already registered groups)
function floodIndependentSameFacing(seed) {
  const dim = seed.dimension;
  const facing = canonicalFacing(facingOf(seed));
  const stack = [seed];
  const seen = new Set();
  const nodes = [];
  const kf = (b) => `${b.location.x}|${b.location.y}|${b.location.z}`;

  while (stack.length) {
    const b = stack.pop();
    const kk = kf(b);
    if (seen.has(kk)) continue;
    seen.add(kk);
    if (!isVault(b)) continue;
    if (canonicalFacing(facingOf(b)) !== facing) continue;
    if (indexByKey.has(keyOf(b))) continue; // barrier
    nodes.push(b);
    for (const [dx, dy, dz] of OFFS6) {
      const nb = dim.getBlock({ x: b.location.x + dx, y: b.location.y + dy, z: b.location.z + dz });
      if (nb) stack.push(nb);
    }
  }
  return { nodes, facing };
}

// ===================== States application =====================
function applyStates(block, tier, segment, cell) {
  try {
    const perm = block.permutation;
    const t = perm.getState("sag:tier");
    const s = perm.getState("sag:segment");
    const c = perm.getState("sag:cell");
    if (t === tier && s === segment && c === cell) return;
    const np = perm.withState("sag:tier", tier).withState("sag:segment", segment).withState("sag:cell", cell);
    block.setPermutation(np);
  } catch { }
}

function applyFallback(block) {
  applyStates(block, "1", "unit", "single");
}

// ===================== Classification =====================
function classifyValidGroups(locList) {
  if (!locList.length) return { groups: [], leftovers: [], uMin: 0, tMin: 0, sMin: 0 };

  let sMin = Infinity, sMax = -Infinity, uMin = Infinity, uMax = -Infinity, tMin = Infinity, tMax = -Infinity;
  for (const v of locList) {
    if (v.s < sMin) sMin = v.s; if (v.s > sMax) sMax = v.s;
    if (v.u < uMin) uMin = v.u; if (v.u > uMax) uMax = v.u;
    if (v.t < tMin) tMin = v.t; if (v.t > tMax) tMax = v.t;
  }

  // s -> Map("u,t" -> {block,uIdx,tIdx})
  const mapS = new Map();
  for (const v of locList) {
    const sIdx = v.s - sMin;
    const uIdx = v.u - uMin;
    const tIdx = v.t - tMin;
    const cellK = `${uIdx},${tIdx}`;
    let m = mapS.get(sIdx);
    if (!m) { m = new Map(); mapS.set(sIdx, m); }
    if (!m.has(cellK)) m.set(cellK, { block: v.block, uIdx, tIdx });
  }

  function sMaskEqualsSize(sIdx, size) {
    const m = mapS.get(sIdx);
    if (!m) return false;
    const need = maskForSize(size);
    if (m.size !== need.length) return false;
    const allowed = new Set(need.map(([u, t]) => `${u},${t}`));
    for (const k of m.keys()) if (!allowed.has(k)) return false;
    return true;
  }

  const fit = { 3: new Set(), 2: new Set(), 1: new Set() }; // size -> set of s
  const sIndices = Array.from(mapS.keys()).sort((a, b) => a - b);
  for (const s of sIndices) {
    if (sMaskEqualsSize(s, 3)) fit[3].add(s);
    else if (sMaskEqualsSize(s, 2)) fit[2].add(s);
    else if (sMaskEqualsSize(s, 1)) fit[1].add(s);
  }

  function runsFromSet(set) {
    const arr = Array.from(set).sort((a, b) => a - b);
    const runs = [];
    let i = 0;
    while (i < arr.length) {
      let start = arr[i], end = arr[i];
      i++;
      while (i < arr.length && arr[i] === end + 1) { end = arr[i]; i++; }
      runs.push([start, end]);
    }
    return runs;
  }

  const taken = new Set();
  const groupsOut = [];

  for (const size of [3, 2, 1]) {
    const runs = runsFromSet(fit[size]);
    for (const [a, b] of runs) {
      const usable = [];
      for (let s = a; s <= b; s++) if (!taken.has(s)) usable.push(s);
      if (!usable.length) continue;

      let start = usable[0], prev = usable[0];
      for (let i = 1; i < usable.length; i++) {
        const cur = usable[i];
        if (cur !== prev + 1) {
          groupsOut.push({ size, sStart: start, sEnd: prev });
          start = cur;
        }
        prev = cur;
      }
      groupsOut.push({ size, sStart: start, sEnd: prev });
      for (let s = start; s <= prev; s++) taken.add(s);
    }
  }

  // length + cap
  const final = [];
  for (const g of groupsOut) {
    const L = g.sEnd - g.sStart + 1;
    if (!(L === 1 || L >= 2)) continue;
    if (MAX_LENGTH && L > MAX_LENGTH) {
      let start = g.sStart;
      while (start <= g.sEnd) {
        const end = Math.min(start + MAX_LENGTH - 1, g.sEnd);
        final.push({ size: g.size, sStart: start, sEnd: end });
        start = end + 1;
      }
    } else {
      final.push(g);
    }
  }

  // fill blocks
  const groupsFilled = [];
  for (const g of final) {
    const blocks = [];
    for (let s = g.sStart; s <= g.sEnd; s++) {
      const m = mapS.get(s);
      const need = new Set(maskForSize(g.size).map(([u, t]) => `${u},${t}`));
      for (const needCell of need) {
        const rec = m.get(needCell);
        if (rec) blocks.push({ block: rec.block, s, uIdx: rec.uIdx, tIdx: rec.tIdx });
      }
    }
    const tier = String(g.size);
    groupsFilled.push({ ...g, tier, blocks });
  }

  // leftovers
  const usedKeys = new Set(groupsFilled.flatMap(gr => gr.blocks.map(v => keyOf(v.block))));
  const leftovers = [];
  for (const s of sIndices) {
    const m = mapS.get(s);
    for (const rec of m.values()) {
      const k = keyOf(rec.block);
      if (!usedKeys.has(k)) leftovers.push(rec.block);
    }
  }

  return { groups: groupsFilled, leftovers, uMin, tMin, sMin };
}

// ===================== Apply states for group =====================
function setStatesForGroup(group, invertVertical) {
  const size = group.size; // 1|2|3
  const tier = String(size);
  const L = group.sEnd - group.sStart + 1;

  for (const { block, s, uIdx, tIdx } of group.blocks) {
    let segment;
    if (L === 1) segment = "unit";
    else if (s === group.sStart) segment = "face";
    else if (s === group.sEnd) segment = "back";
    else segment = "middle";

    let cell = "single";
    if (size === 2) {
      const topIdx = invertVertical ? (size - 1) - tIdx : tIdx; // 0=top,1=bottom
      const left = (uIdx === 0), top = (topIdx === 0);
      if (top && left) cell = "lu";
      else if (top && !left) cell = "ru";
      else if (!top && left) cell = "lb";
      else cell = "rb";
    } else if (size === 3) {
      const topIdx = invertVertical ? (size - 1) - tIdx : tIdx; // 0..2
      const U = ["l", "c", "r"][uIdx];
      const T = ["t", "m", "b"][topIdx];
      const tbl = {
        "t_l": "tl", "t_c": "tc", "t_r": "tr",
        "m_l": "ml", "m_c": "mc", "m_r": "mr",
        "b_l": "bl", "b_c": "bc", "b_r": "br",
      };
      cell = tbl[`${T}_${U}`] || "mc";
    }

    applyStates(block, tier, segment, cell);
  }
}

// ===================== Core recomputes =====================
function validateAndApplyFrom(seedBlock) {
  if (!seedBlock || !isVault(seedBlock)) return;

  // canonicalize seed
  const rotated = setFacingIfNeeded(seedBlock);
  if (rotated) {
    system.run(() => validateAndApplyFrom(seedBlock));
    return;
  }

  const { nodes, facing } = floodComponentSameFacing(seedBlock);
  if (!nodes.length) return;

  // canonicalize all nodes
  let anyChanged = false;
  for (const b of nodes) if (setFacingIfNeeded(b)) anyChanged = true;
  if (anyChanged) { system.run(() => validateAndApplyFrom(seedBlock)); return; }

  doValidate(nodes, facing, seedBlock);
}

// validate only the independent component (exclude already-registered groups)
function validateIndependentFrom(seedBlock) {
  if (!seedBlock || !isVault(seedBlock)) return;

  const rotated = setFacingIfNeeded(seedBlock);
  if (rotated) { system.run(() => validateIndependentFrom(seedBlock)); return; }

  const { nodes, facing } = floodIndependentSameFacing(seedBlock);
  if (!nodes.length) return;

  let anyChanged = false;
  for (const b of nodes) if (setFacingIfNeeded(b)) anyChanged = true;
  if (anyChanged) { system.run(() => validateIndependentFrom(seedBlock)); return; }

  doValidate(nodes, facing, seedBlock);
}

// Common validate pipeline
function doValidate(nodes, facing, seedBlock) {
  const B = basisFor(facing);
  const origin = nodes[0].location;
  const dimId = seedBlock.dimension.id;

  // local coords
  const loc = nodes.map(b => {
    const v = worldToLocal(b.location, origin, B);
    return { block: b, s: v.s, u: v.u, t: v.t };
    // s = along length, u = left-right, t = up-down
  });

  // classify
  const { groups: groupsNew, leftovers, uMin, tMin, sMin } = classifyValidGroups(loc);

  // fast exit vs old touching groups
  const oldGroupIds = new Set(loc.map(v => indexByKey.get(keyOf(v.block))).filter(Boolean));
  const oldSignatures = new Set([...oldGroupIds].map(id => groups.get(id)?.signature).filter(Boolean));

  const tmpNew = groupsNew.map(g => {
    const keys = new Set(g.blocks.map(v => keyOf(v.block)));
    const sig = signatureFor({
      dimId, facing, size: g.size,
      sStart: g.sStart, sEnd: g.sEnd,
      origin, uMin, tMin,
      keys
    });
    return { g, keys, signature: sig };
  });

  const newSigs = new Set(tmpNew.map(x => x.signature));
  let same = (oldSignatures.size === newSigs.size);
  if (same) for (const s of newSigs) if (!oldSignatures.has(s)) { same = false; break; }
  if (same) return;

  // apply
  for (const x of tmpNew) setStatesForGroup(x.g, INVERT_VERTICAL);
  if (APPLY_FALLBACK_FOR_INVALID) for (const b of leftovers) applyFallback(b);

  // registry update
  for (const id of oldGroupIds) {
    const g = groups.get(id);
    if (!g) continue;
    for (const k of g.keys) indexByKey.delete(k);
    groups.delete(id);
  }
  for (const x of tmpNew) {
    const id = nextGroupId++;
    const rec = {
      dimId, facing, size: x.g.size,
      sStart: x.g.sStart, sEnd: x.g.sEnd,
      origin, uMin, tMin,
      keys: x.keys,
      signature: x.signature
    };
    groups.set(id, rec);
    for (const k of rec.keys) indexByKey.set(k, id);
    x.id = id;
  }
  saveGroups();

  scheduleMergeCheck(tmpNew.map(x => x.id).filter(Boolean));
}

// ===================== Join policy (extended) =====================
function findAdjacentValidGroup(block) {
  for (const [dx, dy, dz] of OFFS6) {
    const nb = block.dimension.getBlock({ x: block.location.x + dx, y: block.location.y + dy, z: block.location.z + dz });
    if (!nb) continue;
    const gid = indexByKey.get(keyOf(nb));
    if (!gid) continue;
    const g = groups.get(gid);
    if (!g) continue;
    // dimension & facing match
    const bf = canonicalFacing(facingOf(block));
    if (g.dimId !== block.dimension.id) continue;
    if (bf && bf !== g.facing) continue;
    return g;
  }
  return null;
}

function toLocalOfGroup(block, g) {
  const B = basisFor(g.facing);
  return worldToLocal(block.location, g.origin, B); // {s,u,t}
}

function isProspectiveLayerFull(g, sPros) {
  const B = basisFor(g.facing);
  const dim = world.getDimension(g.dimId);
  const need = maskForSize(g.size);
  for (const [u, t] of need) {
    const p = localToWorld(g.origin, B, sPros, g.uMin + u, g.tMin + t);
    const b = dim.getBlock(p);
    if (!isVault(b)) return false;
    if (canonicalFacing(facingOf(b)) !== g.facing) return false;
  }
  return true;
}

function scheduleMergeCheck(ids) {
  if (!ids.length) return;
  system.run(() => {
    for (const id of ids) attemptMergeGroup(id);
  });
}

function attemptMergeGroup(id) {
  const g = groups.get(id);
  if (!g) return;

  const dim = world.getDimension(g.dimId);
  if (!dim) return;

  const B = basisFor(g.facing);
  const mask = maskForSize(g.size);

  for (const dir of [-1, 1]) {
    const sNeighbor = dir === -1 ? g.sStart - 1 : g.sEnd + 1;
    const candidateIds = new Set();
    let valid = true;

    for (const [uOff, tOff] of mask) {
      const pos = localToWorld(g.origin, B, sNeighbor, g.uMin + uOff, g.tMin + tOff);
      const key = `${g.dimId}|${pos.x}|${pos.y}|${pos.z}`;
      const otherId = indexByKey.get(key);
      if (!otherId || otherId === id) { valid = false; break; }
      candidateIds.add(otherId);
      if (candidateIds.size > 1) { valid = false; break; }
    }

    if (!valid || candidateIds.size !== 1) continue;

    const otherId = candidateIds.values().next().value;
    const h = groups.get(otherId);
    if (!h) continue;
    if (h.size !== g.size || h.facing !== g.facing || h.dimId !== g.dimId) continue;

    const Bh = basisFor(h.facing);
    const maskCheck = maskForSize(g.size);
    let aligned = true;
    for (const [uOff, tOff] of maskCheck) {
      const worldPos = localToWorld(g.origin, B, sNeighbor, g.uMin + uOff, g.tMin + tOff);
      const localH = worldToLocal(worldPos, h.origin, Bh);
      const sInt = Math.round(localH.s);
      const uInt = Math.round(localH.u);
      const tInt = Math.round(localH.t);
      if (uInt < h.uMin || uInt >= h.uMin + h.size) { aligned = false; break; }
      if (tInt < h.tMin || tInt >= h.tMin + h.size) { aligned = false; break; }
      if (dir === -1) {
        if (sInt !== h.sEnd) { aligned = false; break; }
      } else {
        if (sInt !== h.sStart) { aligned = false; break; }
      }
    }
    if (!aligned) continue;

    const anchorS = dir === -1 ? g.sStart : g.sEnd;
    const anchorPos = localToWorld(g.origin, B, anchorS, g.uMin, g.tMin);
    const anchorBlock = dim.getBlock(anchorPos);
    if (isVault(anchorBlock)) {
      system.run(() => validateAndApplyFrom(anchorBlock));
    }
  }
}

// ===================== Subscriptions =====================
world.afterEvents.playerPlaceBlock.subscribe((ev) => {
  const b = ev.block;
  if (!isVault(b)) return;

  // normalize facing immediately
  const rotated = setFacingIfNeeded(b);
  if (rotated) {
    system.run(() => handlePlacement(b));
  } else {
    handlePlacement(b);
  }
}, { blockTypes: [NET_BLOCK_ID] });

function handlePlacement(b) {
  const g = findAdjacentValidGroup(b);
  if (g) {
    const loc = toLocalOfGroup(b, g);
    const s = loc.s, u = loc.u, t = loc.t;

    const extendsFront = (s === g.sStart - 1);
    const extendsBack  = (s === g.sEnd + 1);
    const insideW = (u >= g.uMin && u < g.uMin + g.size);
    const insideH = (t >= g.tMin && t < g.tMin + g.size);

    let revalidate = false;

    if ((extendsFront || extendsBack) && insideW && insideH) {
      // Only when full new layer is completed we merge/extend
      const full = isProspectiveLayerFull(g, s);
      if (full) {
        system.run(() => validateAndApplyFrom(b));
        revalidate = true; // merging layer should rescan original structure
      } else {
        // not a full layer: assemble as an independent structure to allow side-by-side growth
        system.run(() => validateIndependentFrom(b));
      }
    } else {
      // touching but not a valid extension -> assemble as an INDEPENDENT structure (do not merge)
      system.run(() => validateIndependentFrom(b));
    }

    if (revalidate) {
      // additionally, re-validate the adjacent group to keep it maximal/valid
      system.run(() => {
        const anyKey = [...g.keys][0];
        if (anyKey) {
          const [dimId, x, y, z] = anyKey.split("|");
          const dim = world.getDimension(dimId);
          const blk = dim.getBlock({ x: +x, y: +y, z: +z });
          if (isVault(blk)) validateAndApplyFrom(blk);
        }
      });
    }
    return;
  }

  // No adjacent group -> fresh/isolated component
  system.run(() => validateAndApplyFrom(b));
}

// On break: recompute neighbors -> maximal valid partition after damage
world.afterEvents.playerBreakBlock.subscribe((ev) => {
  const dim = ev.block.dimension;
  const { x, y, z } = ev.block.location;
  system.run(() => {
    for (const [dx, dy, dz] of OFFS6) {
      const nb = dim.getBlock({ x: x + dx, y: y + dy, z: z + dz });
      if (isVault(nb)) validateAndApplyFrom(nb);
    }
  });
}, { blockTypes: [NET_BLOCK_ID] });
