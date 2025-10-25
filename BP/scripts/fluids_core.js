import { world, system, BlockPermutation } from "@minecraft/server";

// === PATCH: persisted orientation support ===
function getPersistedMemDir(block, spec) {
  try {
    if (spec && spec.props && spec.props.mem) {
      try {
        const m = block.permutation.getState(spec.props.mem);
        if (m) return m;
      } catch (e) { /* no sag:mem_dir */ }
    }
    if (spec && spec.props && spec.props.facing) {
      try {
        const f = block.permutation.getState(spec.props.facing);
        if (f !== undefined && f !== null) {
          // Bedrock facing_direction Р?Р?С?С?Р?Р? 0..5, С?Р?Р?Р?С?С?Р?Р?Р?РµР?Р?Рµ Р?Р? Р?Р?РµС?Р?РµР? РєР?Р?Рµ.
          // Р?Р?РµС?С? Р?С?Р?С?С?Р? Р?Р?Р?Р?С?Р?С?Р?РµР? РєР?Рє РµС?С?С?; Р?Р?РµС?Р?Р?Р? РєР?Р? Р?Р?Р?Р?РµР? С?Р?РµС?С? Р?Р?Р?Р?Р?С?С?.
          return f;
        }
      } catch (e) { /* no minecraft:facing_direction */ }
    }
  } catch (e) { }
  try {
    if (typeof PIPE_MEMORY !== "undefined") {
      const k = (typeof keyOf === "function") ? keyOf(block) : null;
      if (k && PIPE_MEMORY.has(k)) return PIPE_MEMORY.get(k);
    }
  } catch (e) { }
  return "north";
}
// === END PATCH ===



/** ---------------- Basics ---------------- */
const DIRS = {
  north: { dx: 0, dy: 0, dz: -1, short: "n" },
  east: { dx: 1, dy: 0, dz: 0, short: "e" },
  south: { dx: 0, dy: 0, dz: 1, short: "s" },
  west: { dx: -1, dy: 0, dz: 0, short: "w" },
  up: { dx: 0, dy: 1, dz: 0, short: "u" },
  down: { dx: 0, dy: -1, dz: 0, short: "d" },
};
const ORDER = ["north", "east", "south", "west", "up", "down"];
const OPP = { north: "south", east: "west", south: "north", west: "east", up: "down", down: "up" };

// Р?Р?С?Р?Рµ РєР?С?С?Р? С?Р?С?С?Р?С?Р?Р?Р?, Р?С?РµР?Р?Р?Р?Р?Р?Р?РµС?С?С? Р?Р?Р?Р? Р? С?Р?С? Р?Рµ Р?Р?Р?Р?С? Р?Р?С? fluid_pipe_all Р? gas_pipe_all
const PROP_KEYS = {
  center: "sag:center_core",
  mem: "sag:mem_dir",
  has: (s) => `sag:has_${s}`,
  open: (s) => `sag:open_${s}`,
  facing: "minecraft:facing_direction",
};

/** ---------------- Pipe Specs (fluid & gas) ---------------- */
const PIPE_SPECS = {
  fluid: {
    singularId: "sag:fluid_pipe",
    networkId: "sag:fluid_pipe_all",
    pipeIds: new Set(["sag:fluid_pipe", "sag:fluid_pipe_all"]),
    deviceIds: new Set(["sag:fluid_tank", "sag:fluid_pump"]),
    pumpIds: new Set(["sag:fluid_pump"]),
    pumpValidDirs: new Set(["north", "south"]),
    props: PROP_KEYS,
  },
  gas: {
    singularId: "sag:gas_pipe",
    networkId: "sag:gas_pipe_all",
    pipeIds: new Set(["sag:gas_pipe", "sag:gas_pipe_all"]),
    // Р?Р?Р?Р?Р?: Р?Р?Р?Р?Р?Р?С? С?С?С?Р?Р? РєР?Р?Р?РµРєС?Р?С?С?С? С?Р?Р?С?РєР? Рє С?С?Р?Р? Р?Р?Р?РєР?Р?
    deviceIds: new Set(["sag:fluid_tank", "sag:gas_boiler", "sag:gas_pump"]),
    pumpIds: new Set(["sag:gas_pump"]),
    pumpValidDirs: new Set(["north", "south"]), // С?Р? Р?Рµ Р?Р?Р?Р?РєР?, С?С?Р? Р? С? Р?Р?Р?РєР?С?С?Р?Р?Р?Р? Р?Р?С?Р?С?Р?
    props: PROP_KEYS,
  },
};

// Р?Р?Р?Р?С? Р?С?РµС? С?С?С?Р?Р?-ID, С?С?Р?Р?С? Р?С?С?С?С?Р? С?Р?С?Р?Р?Р?Р?Р?Р?Р?С?С? "С?С?Р? С?С?С?Р?Р??"
const ALL_PIPE_IDS = new Set([
  ...PIPE_SPECS.fluid.pipeIds,
  ...PIPE_SPECS.gas.pipeIds,
]);

/** ---------------- Runtime memory ---------------- */
const PIPE_MEMORY = new Map(); // key -> direction ("north"|"east"|...)
const REGISTRY = new Map(); // key -> {dim,x,y,z,lastNear,lastFar}
let TICK = 0;

// === PATCH: Rebuild/refresh pipes after reload by scanning around player spawn ===
function __sag_scan_pipes_around(player) {
  try {
    const dim = player.dimension;
    const base = {
      x: Math.floor(player.location.x),
      y: Math.floor(player.location.y),
      z: Math.floor(player.location.z),
    };
    const R = 16; // horizontal radius
    const HY = 2; // half height to scan
    for (let dy = -HY; dy <= HY; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        for (let dz = -R; dz <= R; dz++) {
          try {
            const b = dim.getBlock({ x: base.x + dx, y: base.y + dy, z: base.z + dz });
            if (!b) continue;
            if (!ALL_PIPE_IDS.has(b.typeId)) continue;
            try {
              const spec = getSpecForBlock(b);
              if (spec && typeof keyOf === "function" && typeof getPersistedMemDir === "function" && typeof PIPE_MEMORY !== "undefined") {
                try { PIPE_MEMORY.set(keyOf(b), getPersistedMemDir(b, spec)); } catch { }
              }
              registerPipe(b);
              updatePipeVisual(b);
            } catch { }
          } catch { }
        }
      }
    }
  } catch { }
}

if (typeof globalThis !== "undefined" && !globalThis.__SAG_FLUIDS_SPAWN_SCAN__) {
  globalThis.__SAG_FLUIDS_SPAWN_SCAN__ = true;
  try {
    world.afterEvents.playerSpawn.subscribe(ev => {
      try {
        const p = ev.player;
        // Staggered runs to handle chunk streaming order
        system.run(() => __sag_scan_pipes_around(p));
        system.runTimeout(() => __sag_scan_pipes_around(p), 10);
        system.runTimeout(() => __sag_scan_pipes_around(p), 40);
      } catch { }
    });
  } catch { }
}
// === END PATCH ===



/** ---------------- Utils ---------------- */
function keyOf(block) {
  const d = block.dimension.id;
  const p = block.location;
  return `${d}:${p.x},${p.y},${p.z}`;
}
function blockAt(block, dir) {
  const v = DIRS[dir], p = block.location;
  return block.dimension.getBlock({ x: p.x + v.dx, y: p.y + v.dy, z: p.z + v.dz });
}
function isParallel(dir1, dir2) {
  return dir1 === dir2 || OPP[dir1] === dir2;
}
function getSpecForBlock(blockOrId) {
  const id = typeof blockOrId === "string" ? blockOrId : blockOrId.typeId;
  if (PIPE_SPECS.fluid.pipeIds.has(id)) return PIPE_SPECS.fluid;
  if (PIPE_SPECS.gas.pipeIds.has(id)) return PIPE_SPECS.gas;
  return null;
}

/** Р?Р?Р?С?С?Р?С?Р?С?Р?С?С?РµР? С?Р?С?РµР?Р? Р?С?Р?Р?С?Р?С?РµР?С?Р?Р? С?РµРєС?С?РµР? Р?Р?Р?Р?Р? Р?Р?Р?Р? spec */
function classifyNeighbor(block, dir, spec) {
  const nb = blockAt(block, dir);
  if (!nb) return "none";
  const id = nb.typeId;

  // Р?Р?РµР?Р?Р?С?РµР?С?С? С? С?С?С?Р?Р?Р? Р?Р?Р?Р?Р?Р? С?Р?Р?Р? Р?Рµ С?Р?Р?Р?
  if (spec.pipeIds.has(id)) return "pipe";

  // Р?Р?С?Р?С?С? в?? С? Р?Р?С?Р?Р?Р?С?РµР?Р?РµР? С?С?Р?С?Р?Р? (north/south)
  if (spec.pumpIds.has(id)) {
    return spec.pumpValidDirs.has(dir) ? "device" : "none";
  }

  // Р?С?С?Р?Р?С?Р?С?Рµ С?С?С?С?Р?Р?С?С?Р?Р? Р?Р? whitelist
  if (spec.deviceIds.has(id)) return "device";

  return "none";
}

function getPlacementDirection(evt) {
  try {
    const v = evt.player.getViewDirection();
    if (Math.abs(v.y) > Math.max(Math.abs(v.x), Math.abs(v.z))) {
      return v.y >= 0 ? "up" : "down";
    }
    if (Math.abs(v.x) >= Math.abs(v.z)) {
      return v.x >= 0 ? "east" : "west";
    }
    return v.z >= 0 ? "south" : "north";
  } catch {
    return "north";
  }
}

/** ---------------- Visual update ---------------- */
function updatePipeVisual(block) {
  // === PATCH: sync PIPE_MEMORY from persisted block permutation ===
  try {
    if (typeof getSpecForBlock === "function") {
      const __spec = getSpecForBlock(block);
      if (__spec && typeof PIPE_MEMORY !== "undefined" && typeof keyOf === "function") {
        const __mem = getPersistedMemDir(block, __spec);
        try { PIPE_MEMORY.set(keyOf(block), __mem); } catch (e) { }
      }
    }
  } catch (e) { }
  // === END PATCH ===

  const spec = getSpecForBlock(block);
  if (!spec) return;

  const key = keyOf(block);

  // Р?Р?Р?Р?Р?Р? С?Р?С?РµР?РµР?
  const connections = {};
  let connectionCount = 0;
  for (const dir of ORDER) {
    const type = classifyNeighbor(block, dir, spec);
    connections[dir] = type;
    if (type !== "none") connectionCount++;
  }

  // 0 РєР?Р?Р?РµРєС?Р?Р? в?? Р?Р?Р?Р?Р?С?Р?Р?С? С?С?С?Р?Р?
  if (connectionCount === 0) {
    const facing = PIPE_MEMORY.get(key) || "north";
    setSinglePipe(block, facing, spec);
    return;
  }

  // Р?Р?С?Р?Р?Р?Р? С?Р?С?С?Р?С?Р?Р?С?
  const states = {
    [spec.props.center]: false,
    [spec.props.has("n")]: false, [spec.props.open("n")]: false,
    [spec.props.has("e")]: false, [spec.props.open("e")]: false,
    [spec.props.has("s")]: false, [spec.props.open("s")]: false,
    [spec.props.has("w")]: false, [spec.props.open("w")]: false,
    [spec.props.has("u")]: false, [spec.props.open("u")]: false,
    [spec.props.has("d")]: false, [spec.props.open("d")]: false,
    [spec.props.mem]: PIPE_MEMORY.get(key) || "north",
  };

  // Р?РµР?Р?С?Р?С?Рµ С?Р?С?РµР?С?РєР?Рµ РєР?Р?Р?РµРєС?С?
  for (const dir of ORDER) {
    const type = connections[dir];
    if (type !== "none") {
      const s = DIRS[dir].short;
      states[spec.props.has(s)] = true;
      // Р?С?РєС?С?Р?Р?РµР? Р?Р?Рє, РµС?Р?Р? С?С?Р? "С?С?С?С?Р?Р?С?С?Р?Р?" (Р?Рµ С?С?С?Р?Р?)
      if (type === "device") {
        states[spec.props.open(s)] = true;
      }
    }
  }

  // Р?Р?Р?Р?Р? 1 С?Р?С?РµР? в?? Р?Р?С?Р?С?Р?Р?Р?С?С? Р?С?Р?С?С?С? "Р?Р?Р?С?" Р?Р? Р?Р?Р?Р?РєРµ Р?Р?Р?С?С?Р? Р?Р?Р?Р?С?Р?С?Р?
  if (connectionCount === 1) {
    const connectedDir = ORDER.find(d => connections[d] !== "none");
    const placementDir = PIPE_MEMORY.get(key) || "north";

    if (isParallel(connectedDir, placementDir)) {
      // Р?Р?С?Р?Р?Р?РµР?С?Р?Р? в?? Р?Р?Р?Р?Р?Р?С?С? Р?С?Р?С?Р?Р?Р?Р?Р?Р?Р?Р?Р?С?С? С?С?Р?С?Р?Р?С? (open)
      const oppDir = OPP[connectedDir];
      const oppShort = DIRS[oppDir].short;
      states[spec.props.has(oppShort)] = true;
      states[spec.props.open(oppShort)] = true;
    } else {
      // Р?РµС?Р?РµР?Р?Р?РєС?Р?С?С? в?? Р?Р?Р?Р?Р?Р?С?С? "Р?Р?Р?С?" Р? Р?С?Р?С?Р?Р?Р?Р?Р?Р?Р?Р?Р?С?С? С?С?Р?С?Р?Р?С? Р?С? Р?РµР?-Р?С?Р?РµР?С?Р?С?Р?Р?
      const oppPlacement = OPP[placementDir];
      const oppShort = DIRS[oppPlacement].short;
      states[spec.props.has(oppShort)] = true;
      states[spec.props.open(oppShort)] = true;
    }
  }

  // 4+ РєР?Р?Р?РµРєС?Р?Р? в?? С?РµР?С?С?Р?Р?С?Р?С?Р? С?Р?РµР?
  if (connectionCount >= 4) {
    states[spec.props.center] = true;
  }

  // Р?С?Р?Р?РµР?Р?С?С? СЃРµС‚РєСѓ РґР»СЏ "all"
  const perm = BlockPermutation.resolve(spec.networkId, states);
  block.setPermutation(perm);
}

function setSinglePipe(block, facing, spec) {
  try {
    const perm = BlockPermutation.resolve(spec.singularId, { [spec.props.facing]: facing });
    block.setPermutation(perm);
  } catch {
    block.setPermutation(BlockPermutation.resolve(spec.singularId));
  }
}

function updateNeighbors(block) {
  for (const dir of ORDER) {
    const nb = blockAt(block, dir);
    if (nb && ALL_PIPE_IDS.has(nb.typeId)) {
      updatePipeVisual(nb);
    }
  }
}

function registerPipe(block) {
  const key = keyOf(block);
  if (!REGISTRY.has(key)) {
    REGISTRY.set(key, {
      dim: block.dimension.id,
      x: block.location.x, y: block.location.y, z: block.location.z,
      lastNear: TICK, lastFar: 0
    });
  }
}

/** ---------------- Events ---------------- */
// Place
world.afterEvents.playerPlaceBlock.subscribe((evt) => {
  const block = evt.block;
  if (!ALL_PIPE_IDS.has(block.typeId)) return;

  const placementDir = getPlacementDirection(evt);
  const key = keyOf(block);

  PIPE_MEMORY.set(key, placementDir);

  registerPipe(block);
  updatePipeVisual(block);
  updateNeighbors(block);

  system.runTimeout(() => {
    updatePipeVisual(block);
    updateNeighbors(block);
  }, 1);
});

// Break
world.afterEvents.playerBreakBlock.subscribe(({ block }) => {
  if (!ALL_PIPE_IDS.has(block.typeId)) return;
  const key = keyOf(block);
  PIPE_MEMORY.delete(key);
  REGISTRY.delete(key);

  for (const dir of ORDER) {
    const nb = blockAt(block, dir);
    if (nb && ALL_PIPE_IDS.has(nb.typeId)) {
      updatePipeVisual(nb);
      registerPipe(nb);
    }
  }
});

// Periodic refresh (near/far)
system.runInterval(() => {
  TICK++;
  const players = world.getAllPlayers();
  if (players.length === 0) return;

  const NEAR_DIST = 8 * 8;
  const FAR_DIST = (12 * 16) * (12 * 16);

  for (const [key, rec] of REGISTRY) {
    const pipePos = { x: rec.x, y: rec.y, z: rec.z };

    let minDist = Infinity, minHoriz = Infinity;
    for (const p of players) {
      if (p.dimension.id !== rec.dim) continue;
      const dx = pipePos.x - p.location.x;
      const dy = pipePos.y - p.location.y;
      const dz = pipePos.z - p.location.z;
      const d3 = dx * dx + dy * dy + dz * dz;
      const dh = dx * dx + dz * dz;
      if (d3 < minDist) { minDist = d3; minHoriz = dh; }
    }
    if (minDist === Infinity) continue;

    if (minDist <= NEAR_DIST) {
      if (rec.lastNear !== TICK) {
        const b = world.getDimension(rec.dim).getBlock(pipePos);
        if (b) updatePipeVisual(b);
        rec.lastNear = TICK;
      }
    } else if (minHoriz <= FAR_DIST) {
      if ((TICK - rec.lastFar) >= 18) {
        const b = world.getDimension(rec.dim).getBlock(pipePos);
        if (b) updatePipeVisual(b);
        rec.lastFar = TICK;
      }
    }
  }
}, 1);

// Backup registration check
system.runInterval(() => {
  for (const p of world.getAllPlayers()) {
    const ray = p.getBlockFromViewDirection?.();
    if (!ray?.block) continue;
    const b = ray.block;
    for (const dir of ORDER) {
      const nb = blockAt(b, dir);
      if (nb && ALL_PIPE_IDS.has(nb.typeId)) {
        registerPipe(nb);
      }
    }
  }
}, 40);

// === PATCH: neighbor updates on break/place/explosion ===
function updateNeighborsAround(dimension, center) {
  if (!dimension || !center) return;
  const base = {
    x: center.x ?? center?.x ?? center[0] ?? 0,
    y: center.y ?? center?.y ?? center[1] ?? 0,
    z: center.z ?? center?.z ?? center[2] ?? 0
  };
  const offs = [
    { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 },
    { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 },
  ];
  for (const o of offs) {
    try {
      const b = dimension.getBlock({ x: base.x + o.x, y: base.y + o.y, z: base.z + o.z });
      if (!b) continue;
      const spec = (typeof getSpecForBlock === "function") ? getSpecForBlock(b) : null;
      if (!spec) continue; // РЅРµ РЅР°С€Р° С‚СЂСѓР±Р°
      // РџРѕРґС‚СЏРіРёРІР°РµРј РїР°РјСЏС‚СЊ РѕСЂРёРµРЅС‚Р°С†РёРё Рё Р°РїРґРµР№С‚РёРј РІРёР·СѓР°Р»
      if (typeof keyOf === "function" && typeof PIPE_MEMORY !== "undefined" && typeof getPersistedMemDir === "function") {
        try {
          PIPE_MEMORY.set(keyOf(b), getPersistedMemDir(b, spec));
        } catch (e) { }
      }
      if (typeof updatePipeVisual === "function") updatePipeVisual(b);
    } catch (e) { /* ignore single neighbor failure */ }
  }
}
// === END PATCH ===

// === PATCH: subscribe to break/place/explosion to force neighbor refresh ===
if (typeof globalThis !== "undefined" && !globalThis.__SAG_FLUIDS_EVENTS__) {
  globalThis.__SAG_FLUIDS_EVENTS__ = true;
  try {
    if (typeof world !== "undefined" && world.afterEvents) {
      try {
        world.afterEvents.blockBreak.subscribe(ev => {
          try {
            const dim = ev.block?.dimension ?? ev.dimension;
            const loc = ev.block?.location ?? ev.blockPos ?? ev.location;
            if (!dim || !loc) return;
            // Purge cache of the broken block (now air)
            if (typeof keyOf === "function" && typeof PIPE_MEMORY !== "undefined") {
              try {
                const b = dim.getBlock(loc);
                PIPE_MEMORY.delete(keyOf(b));
              } catch (e) { }
            }
            updateNeighborsAround(dim, loc);
          } catch (e) { }
        });
      } catch (e) { }

      try {
        world.afterEvents.blockPlace.subscribe(ev => {
          try {
            const dim = ev.block?.dimension ?? ev.dimension;
            const loc = ev.block?.location ?? ev.blockPos ?? ev.location;
            if (!dim || !loc) return;
            updateNeighborsAround(dim, loc);
          } catch (e) { }
        });
      } catch (e) { }

      // explosions (optional, guarded)
      try {
        world.afterEvents.explosion.subscribe(ev => {
          try {
            const impacted = ev.impactedBlocks ?? ev.getImpactedBlocks?.() ?? [];
            for (const it of impacted) {
              try { updateNeighborsAround(it.dimension ?? it.block?.dimension, it.location ?? it.block?.location); } catch (e) { }
            }
          } catch (e) { }
        });
      } catch (e) { }
    }
  } catch (e) { }
}
// === END PATCH ===

// === PATCH: Deferred neighbor refresh queue (handles post-reload break timing) ===
if (typeof globalThis !== "undefined" && !globalThis.__SAG_FLUIDS_REFRESH__) {
  globalThis.__SAG_FLUIDS_REFRESH__ = {
    set: new Set(),
    scheduled: false,
    processing: false
  };

  function __sag_key_from(dim, loc) {
    const d = (dim && (dim.id || dim.dimensionId || dim.typeId || "")) || "";
    const x = (loc && (loc.x ?? loc[0])) ?? 0;
    const y = (loc && (loc.y ?? loc[1])) ?? 0;
    const z = (loc && (loc.z ?? loc[2])) ?? 0;
    return d + "|" + x + "|" + y + "|" + z;
  }

  function __sag_enqueue(dim, loc) {
    try {
      const k = __sag_key_from(dim, loc);
      globalThis.__SAG_FLUIDS_REFRESH__.set.add(JSON.stringify({ d: (dim?.id ?? ""), x: (loc?.x ?? loc?.[0] ?? 0), y: (loc?.y ?? loc?.[1] ?? 0), z: (loc?.z ?? loc?.[2] ?? 0) }));
      if (!globalThis.__SAG_FLUIDS_REFRESH__.scheduled && typeof system !== "undefined") {
        globalThis.__SAG_FLUIDS_REFRESH__.scheduled = true;
        // Process twice with spacing to let world finish updating blocks after break
        system.run(() => __sag_process_queue());
        system.runTimeout(() => __sag_process_queue(), 2);
      }
    } catch (e) { }
  }

  function __sag_process_queue() {
    if (globalThis.__SAG_FLUIDS_REFRESH__.processing) return;
    globalThis.__SAG_FLUIDS_REFRESH__.processing = true;
    try {
      const items = Array.from(globalThis.__SAG_FLUIDS_REFRESH__.set);
      globalThis.__SAG_FLUIDS_REFRESH__.set.clear();
      for (const s of items) {
        try {
          const it = JSON.parse(s);
          const dim = world.getDimension?.(it.d || "minecraft:overworld");
          if (!dim) continue;
          const center = { x: it.x, y: it.y, z: it.z };
          // Update neighbors *after* world tick to ensure the broken block is already air
          if (typeof updateNeighborsAround === "function") {
            updateNeighborsAround(dim, center);
          } else {
            // Minimal inline update if helper not present
            const offs = [
              { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 },
              { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 },
              { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 },
            ];
            for (const o of offs) {
              const b = dim.getBlock({ x: center.x + o.x, y: center.y + o.y, z: center.z + o.z });
              if (!b) continue;
              const spec = (typeof getSpecForBlock === "function") ? getSpecForBlock(b) : null;
              if (!spec) continue;
              if (typeof keyOf === "function" && typeof PIPE_MEMORY !== "undefined" && typeof getPersistedMemDir === "function") {
                try { PIPE_MEMORY.set(keyOf(b), getPersistedMemDir(b, spec)); } catch (e) { }
              }
              if (typeof updatePipeVisual === "function") updatePipeVisual(b);
            }
          }
        } catch (e) { }
      }
    } finally {
      globalThis.__SAG_FLUIDS_REFRESH__.processing = false;
      globalThis.__SAG_FLUIDS_REFRESH__.scheduled = false;
    }
  }
}
// === END PATCH (queue) ===

