// multiblock_core.js (patched)
// Adds safe dimension.getBlock() calls to prevent LocationOutOfWorldBoundariesError
// and minor resilience in ray casts and validators.

import { world, system, Player, BlockPermutation } from "@minecraft/server";

function safeGetBlock(dim, pos) {
    try {
        return dim.getBlock(pos);
    } catch (_e) {
        return undefined;
    }
}

class MultiBlockStructure {
    constructor(config) {
        // ---- Required config ----
        this.matches = config.matches; // (block) => boolean
        this.expansion = config.expansion; // "cardinal_up" | "cardinal_xz"
        this.sizes = config.sizes;       // [{x,z}, ...] (XZ footprint options)
        // ---- Optional config ----
        this.verticalStack = !!config.verticalStacking; // allow vertical merge (tanks)
        this.axisState = config.horizontalAxisState || null; // e.g. "sag:horizontal_axis" -> "x"|"z"
        this.usePositionStates = (config.usePositionStates !== false); // default true
        this.useHeightState = (config.useHeightState !== false); // default true
        this.sizeValueMode = config.sizeValueMode || "auto"; // "auto"|"min"|"max"|"x"|"z"
        this.stateKeys = Object.assign({
            size: "sag:size",
            height: "sag:height",
            posX: "sag:pos_x",
            posZ: "sag:pos_z"
        }, config.stateKeys || {});

        // ---- Runtime ----
        this.structures = []; // Array<Structure>
        this.blockToStructure = new Map(); // "x,y,z" -> Structure
        this.lastValidatedId = -1;
    }

    static genId() {
        return Math.floor(1000000 + Math.random() * 9000000);
    }
    static key(pos) { return `${pos.x},${pos.y},${pos.z}`; }

    // Association helpers
    getByBlock(pos) { return this.blockToStructure.get(MultiBlockStructure.key(pos)); }
    setStructBlocks(struct) {
        for (const p of struct.blocks) this.blockToStructure.set(MultiBlockStructure.key(p), struct);
    }
    clearStructBlocks(struct) {
        for (const p of struct.blocks) this.blockToStructure.delete(MultiBlockStructure.key(p));
    }

    // Create a structure record
    makeStructure(newBlocks, size, min, max, dim) {
        return { id: MultiBlockStructure.genId(), blocks: newBlocks, size, min, max, dimension: dim };
    }

    // Core assembly entrypoint (dispatch by expansion mode)
    expandOrAssembleStructuresAround(block) {
        if (!this.matches(block)) return;
        if (this.expansion === "cardinal_up") {
            this.#assembleVertical(block);
        } else if (this.expansion === "cardinal_xz") {
            this.#assembleHorizontal(block);
        }
    }

    // Vertical assembly (original tank behavior)
    #assembleVertical(block) {
        const dim = block.dimension;
        const { x, y, z } = block.location;
        const regionCache = new Set();

        for (const size of this.sizes) {
            for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = -10; dy <= 10; dy++) {
                const center = { x: x + dx, y: y + dy, z: z + dz };
                const b = safeGetBlock(dim, center);
                if (!b || !this.matches(b)) continue;

                for (let ox = -size.x + 1; ox <= 0; ox++) for (let oz = -size.z + 1; oz <= 0; oz++) {
                    const min = { x: center.x + ox, y: center.y, z: center.z + oz };
                    const max = { x: min.x + size.x - 1, y: center.y, z: min.z + size.z - 1 };
                    const regKey = `${min.x},${min.y},${min.z},${max.x},${max.y},${max.z}`;
                    if (regionCache.has(regKey)) continue;
                    regionCache.add(regKey);

                    let maxUp = 0, maxDown = 0;
                    const yBase = center.y;

                    // scan up
                    while (true) {
                        let valid = true;
                        for (let dx2 = 0; dx2 < size.x && valid; dx2++)
                            for (let dz2 = 0; dz2 < size.z && valid; dz2++) {
                                const pos = { x: min.x + dx2, y: yBase + maxUp, z: min.z + dz2 };
                                const bb = safeGetBlock(dim, pos);
                                if (!bb || !this.matches(bb)) { valid = false; break; }
                                const ex = this.getByBlock(pos);
                                if (ex && (ex.size.x > size.x || ex.size.z > size.z)) { valid = false; break; }
                            }
                        if (!valid) break;
                        maxUp++;
                    }
                    if (maxUp === 0) continue;

                    // scan down
                    while (true) {
                        let valid = true;
                        for (let dx2 = 0; dx2 < size.x && valid; dx2++)
                            for (let dz2 = 0; dz2 < size.z && valid; dz2++) {
                                const pos = { x: min.x + dx2, y: yBase - maxDown - 1, z: min.z + dz2 };
                                const bb = safeGetBlock(dim, pos);
                                if (!bb || !this.matches(bb)) { valid = false; break; }
                                const ex = this.getByBlock(pos);
                                if (ex && (ex.size.x > size.x || ex.size.z > size.z)) { valid = false; break; }
                            }
                        if (!valid) break;
                        maxDown++;
                    }

                    const yMin = yBase - maxDown;
                    const yMax = yBase + maxUp - 1;
                    const totalY = yMax - yMin + 1;
                    if (totalY < 1) continue;

                    // collect blocks
                    const newBlocks = [];
                    for (let yy = yMin; yy <= yMax; yy++)
                        for (let dx2 = 0; dx2 < size.x; dx2++)
                            for (let dz2 = 0; dz2 < size.z; dz2++)
                                newBlocks.push({ x: min.x + dx2, y: yy, z: min.z + dz2 });

                    // ensure center is included
                    if (!newBlocks.some(p => p.x === center.x && p.y === center.y && p.z === center.z)) continue;

                    // existing structures fully inside
                    const inside = this.structures.filter(s =>
                        s.dimension === dim &&
                        s.blocks.every(bk =>
                            bk.x >= min.x && bk.x <= max.x &&
                            bk.z >= min.z && bk.z <= max.z &&
                            bk.y >= yMin && bk.y <= yMax
                        )
                    );

                    // filter out overlapped blocks from inside structs
                    let mergedBlocks = [...newBlocks];
                    for (const s of inside) {
                        mergedBlocks = mergedBlocks.filter(bk =>
                            !s.blocks.some(tb => tb.x === bk.x && tb.y === bk.y && tb.z === bk.z)
                        );
                    }

                    // conflicts with other structures
                    let conflict = false;
                    for (const bpos of mergedBlocks) {
                        const other = this.getByBlock(bpos);
                        if (other && !inside.includes(other)) { conflict = true; break; }
                    }
                    if (conflict) continue;

                    // decide expand / create
                    const shouldExpand = inside.length > 0 &&
                        (max.x - min.x + 1 > Math.max(...inside.map(s => s.size.x)) ||
                            max.z - min.z + 1 > Math.max(...inside.map(s => s.size.z)) ||
                            yMax - yMin + 1 > Math.max(...inside.map(s => s.size.y)));

                    if ((inside.length > 0 && shouldExpand) ||
                        (inside.length === 0 && mergedBlocks.length === newBlocks.length)) {

                        for (const s of inside) { this.clearStructBlocks(s); this.structures = this.structures.filter(a => a.id !== s.id); }

                        const structure = this.makeStructure(
                            newBlocks,
                            { x: size.x, y: totalY, z: size.z },
                            { x: min.x, y: yMin, z: min.z },
                            { x: max.x, y: yMax, z: max.z },
                            dim
                        );
                        this.structures.push(structure);
                        this.setStructBlocks(structure);

                        for (const pos of newBlocks) this.setBlockVisual(pos, dim, structure);

                        if (this.verticalStack) this.mergeVertical(structure);
                    }
                }
            }
        }
    }

    // Horizontal assembly (XZ only, rotation-aware with axis state)
    #assembleHorizontal(block) {
        const dim = block.dimension;
        const { x, y, z } = block.location;
        const yBase = y;
        const regionCache = new Set();

        // Resolve axis once from the center block
        let axis = "x";
        if (this.axisState) {
            try { axis = block.permutation.getState(this.axisState) || "x"; }
            catch { axis = "x"; }
        }

        for (const size0 of this.sizes) {
            // rotate size if axis is 'z' (swap x/z)
            const size = (axis === "z") ? { x: size0.z, z: size0.x } : { x: size0.x, z: size0.z };

            for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
                const center = { x: x + dx, y: yBase, z: z + dz };
                const b = safeGetBlock(dim, center);
                if (!b || !this.matches(b)) continue;

                for (let ox = -size.x + 1; ox <= 0; ox++) for (let oz = -size.z + 1; oz <= 0; oz++) {
                    const min = { x: center.x + ox, y: yBase, z: center.z + oz };
                    const max = { x: min.x + size.x - 1, y: yBase, z: min.z + size.z - 1 };
                    const regKey = `${min.x},${min.y},${min.z},${max.x},${max.y},${max.z}`;
                    if (regionCache.has(regKey)) continue;
                    regionCache.add(regKey);

                    const newBlocks = [];
                    for (let dx2 = 0; dx2 < size.x; dx2++)
                        for (let dz2 = 0; dz2 < size.z; dz2++)
                            newBlocks.push({ x: min.x + dx2, y: yBase, z: min.z + dz2 });

                    if (!newBlocks.some(p => p.x === center.x && p.y === center.y && p.z === center.z)) continue;

                    const inside = this.structures.filter(s =>
                        s.dimension === dim &&
                        s.blocks.every(bk =>
                            bk.x >= min.x && bk.x <= max.x &&
                            bk.z >= min.z && bk.z <= max.z &&
                            bk.y === yBase
                        )
                    );

                    let mergedBlocks = [...newBlocks];
                    for (const s of inside) {
                        mergedBlocks = mergedBlocks.filter(bk =>
                            !s.blocks.some(tb => tb.x === bk.x && tb.y === bk.y && tb.z === bk.z)
                        );
                    }

                    let conflict = false;
                    for (const bpos of mergedBlocks) {
                        const other = this.getByBlock(bpos);
                        if (other && !inside.includes(other)) { conflict = true; break; }
                    }
                    if (conflict) continue;

                    const shouldExpand = inside.length > 0 &&
                        (size.x > Math.max(...inside.map(s => s.size.x)) ||
                            size.z > Math.max(...inside.map(s => s.size.z)));

                    if ((inside.length > 0 && shouldExpand) ||
                        (inside.length === 0 && mergedBlocks.length === newBlocks.length)) {

                        for (const s of inside) { this.clearStructBlocks(s); this.structures = this.structures.filter(a => a.id !== s.id); }

                        const structure = this.makeStructure(
                            newBlocks,
                            { x: size.x, y: 1, z: size.z },
                            { x: min.x, y: yBase, z: min.z },
                            { x: max.x, y: yBase, z: max.z },
                            dim
                        );
                        this.structures.push(structure);
                        this.setStructBlocks(structure);
                        for (const pos of newBlocks) this.setBlockVisual(pos, dim, structure);
                    }
                }
            }
        }
    }

    // Merge vertical stacks if they align
    mergeVertical(struct) {
        const dim = struct.dimension;

        // below
        const below = this.structures.find(t =>
            t !== struct && t.dimension === dim &&
            t.size.x === struct.size.x && t.size.z === struct.size.z &&
            t.max.x === struct.max.x && t.max.z === struct.max.z &&
            t.max.y + 1 === struct.min.y
        );
        if (below) {
            this.clearStructBlocks(below); this.clearStructBlocks(struct);
            this.structures = this.structures.filter(t => t.id !== below.id && t.id !== struct.id);
            const newBlocks = [...below.blocks, ...struct.blocks];
            const merged = this.makeStructure(
                newBlocks,
                { x: struct.size.x, y: below.size.y + struct.size.y, z: struct.size.z },
                { x: struct.min.x, y: below.min.y, z: struct.min.z },
                { x: struct.max.x, y: struct.max.y, z: struct.max.z },
                dim
            );
            this.structures.push(merged); this.setStructBlocks(merged);
            for (const b of newBlocks) this.setBlockVisual(b, merged.dimension, merged);
            this.mergeVertical(merged);
            return;
        }

        // above
        const above = this.structures.find(t =>
            t !== struct && t.dimension === dim &&
            t.size.x === struct.size.x && t.size.z === struct.size.z &&
            t.min.x === struct.min.x && t.min.z === struct.min.z &&
            t.min.y === struct.max.y + 1
        );
        if (above) {
            this.clearStructBlocks(above); this.clearStructBlocks(struct);
            this.structures = this.structures.filter(t => t.id !== above.id && t.id !== struct.id);
            const newBlocks = [...struct.blocks, ...above.blocks];
            const merged = this.makeStructure(
                newBlocks,
                { x: struct.size.x, y: struct.size.y + above.size.y, z: struct.size.z },
                { x: struct.min.x, y: struct.min.y, z: struct.min.z },
                { x: struct.max.x, y: above.max.y, z: struct.max.z },
                dim
            );
            this.structures.push(merged); this.setStructBlocks(merged);
            for (const b of newBlocks) this.setBlockVisual(b, merged.dimension, merged);
            this.mergeVertical(merged);
        }
    }

    // Called when any block of the structure is broken
    breakAndReassemble(block) {
        const struct = this.getByBlock(block.location);
        if (!struct) {
            this.expandOrAssembleStructuresAround(block);
            return;
        }
        this.clearStructBlocks(struct);
        this.structures = this.structures.filter(t => t.id !== struct.id);

        const dim = block.dimension;
        for (const pos of struct.blocks) {
            if (pos.x === block.location.x && pos.y === block.location.y && pos.z === block.location.z) continue;
            const b = safeGetBlock(dim, pos);
            if (b && this.matches(b)) this.expandOrAssembleStructuresAround(b);
        }
    }

    // Compute block state map used to render geometry
    getBlockStates(sx, sy, sz, loc, min, max) {
        // height
        if (sy < 1) sy = 1;
        let height = "single";
        if (this.useHeightState) {
            if (sy === 1) height = "single";
            else if (loc.y === min.y) height = "bottom";
            else if (loc.y === max.y) height = "top";
            else height = "middle";
        }

        // size value selection
        let sizeVal;
        switch (this.sizeValueMode) {
            case "min": sizeVal = Math.min(sx, sz); break;
            case "max": sizeVal = Math.max(sx, sz); break;
            case "x": sizeVal = sx; break;
            case "z": sizeVal = sz; break;
            default:
                sizeVal = (this.expansion === "cardinal_xz") ? Math.min(sx, sz) : sx;
        }

        const states = {};
        states[this.stateKeys.size] = sizeVal;
        if (this.useHeightState) states[this.stateKeys.height] = height;
        if (this.usePositionStates) {
            states[this.stateKeys.posX] = (loc.x - min.x);
            states[this.stateKeys.posZ] = (loc.z - min.z);
        }
        return states;
    }

    // Update a single block's visual permutation
    setBlockVisual(loc, dim, struct) {
        const block = safeGetBlock(dim, loc);
        if (!block) return;
        const states = this.getBlockStates(struct.size.x, struct.size.y, struct.size.z, loc, struct.min, struct.max);
        try {
            // Resolve permutation using the block's own typeId (supports many different blocks)
            block.setPermutation(BlockPermutation.resolve(block.typeId, states));
        } catch (e) {
            console.warn(`Failed to set visual at ${loc.x},${loc.y},${loc.z} for ${block.typeId}: ${e}`);
        }
    }

    // Ensure all blocks of a structure are still valid, otherwise rebuild
    validate(struct) {
        const dim = struct.dimension;
        for (const pos of struct.blocks) {
            const b = safeGetBlock(dim, pos);
            if (!b || !this.matches(b)) {
                this.breakAndReassemble({ dimension: dim, location: pos });
                return;
            }
        }
    }
}

// ---- Global registry and shared events ----
const instances = [];
let eventsInit = false;

export function registerMultiblock(config) {
    const inst = new MultiBlockStructure(config);
    instances.push(inst);

    if (!eventsInit) {
        eventsInit = true;

        // Shared validation loop for all registered types
        system.runInterval(() => {
            const players = [...world.getPlayers()];
            for (const inst of instances) {
                const immediate = new Set();

                // Validate the block the player is looking at
                for (const p of players) {
                    if (!(p instanceof Player)) continue;
                    const view = p.getViewDirection();
                    const origin = p.location;
                    const eye = { x: origin.x, y: origin.y + 1.6, z: origin.z };
                    const step = 0.5;
                    let prevKey = null;
                    for (let d = 0; d <= 12; d += step) {
                        const cx = eye.x + view.x * d;
                        const cy = eye.y + view.y * d;
                        const cz = eye.z + view.z * d;
                        const bx = Math.floor(cx), by = Math.floor(cy), bz = Math.floor(cz);
                        const key = `${bx},${by},${bz}`;
                        if (prevKey === key) continue;
                        prevKey = key;
                        const blk = safeGetBlock(p.dimension, { x: bx, y: by, z: bz });
                        if (!blk) break;
                        if (inst.matches(blk)) {
                            const s = inst.getByBlock({ x: bx, y: by, z: bz });
                            if (s) { inst.validate(s); immediate.add(s.id); }
                            break;
                        } else if (blk.typeId !== "minecraft:air") break;
                    }
                }

                // Periodic validation of structures near players
                const near = inst.structures.filter(s =>
                    players.some(p => {
                        if (s.dimension !== p.dimension) return false;
                        const dx = s.min.x + (s.max.x - s.min.x + 1) / 2 - p.location.x;
                        const dz = s.min.z + (s.max.z - s.min.z + 1) / 2 - p.location.z;
                        return dx * dx + dz * dz <= 128 * 128;
                    })
                ).filter(s => !immediate.has(s.id));

                if (near.length) {
                    near.sort((a, b) => a.id - b.id);
                    const pick = near[0];
                    inst.validate(pick);
                }
            }
        }, 1);

        // Place / Break events: try every registered instance; only the one whose predicate matches will act
        world.afterEvents.playerPlaceBlock.subscribe(ev => {
            const b = ev.block;
            for (const inst of instances) {
                if (inst.matches(b)) inst.expandOrAssembleStructuresAround(b);
            }
        });
        world.afterEvents.playerBreakBlock.subscribe(ev => {
            const b = ev.block;
            for (const inst of instances) {
                // Always attempt to handle breaks; the instance will look up any structure at this location.
                inst.breakAndReassemble(b);
            }
        });
    }

    return inst;
}
