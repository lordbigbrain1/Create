
import { world, system, Player, BlockPermutation } from "@minecraft/server";

const STRUCT_SIZES = [
    { x: 3, z: 3 },
    { x: 2, z: 2 },
    { x: 1, z: 1 }
];

const BLOCK_ID = "sag:fluid_tank";

function generateId() {
    return Math.floor(1000000 + Math.random() * 9000000);
}

if (!Array.prototype.removeIf) {
    Array.prototype.removeIf = function (callback) {
        let i = 0;
        while (i < this.length) {
            if (callback(this[i])) this.splice(i, 1);
            else i++;
        }
    };
}

const allTanks = [];
const blockToTank = new Map();

function blockKey({ x, y, z }) {
    return `${x},${y},${z}`;
}

function getTankByBlock(pos) {
    return blockToTank.get(blockKey(pos));
}

function setTankBlocks(tank) {
    for (const b of tank.blocks) blockToTank.set(blockKey(b), tank);
}

function clearTankBlocks(tank) {
    for (const b of tank.blocks) blockToTank.delete(blockKey(b));
}

function createNewStructure(newBlocks, size, min, max, dim) {
    return {
        id: generateId(),
        blocks: newBlocks,
        size,
        min,
        max,
        dimension: dim
    };
}

function isTankBlock(block) {
    return block && block.typeId === BLOCK_ID;
}

// ---- NEW: safe getter that swallows out-of-bounds coordinates ----
function safeGetBlock(dim, pos) {
    try {
        return dim.getBlock(pos);
    } catch (e) {
        // LocationOutOfWorldBoundariesError or similar -> treat as "no block"
        return null;
    }
}

function expandOrAssembleStructuresAround(block) {
    const dim = block.dimension;
    const { x, y, z } = block.location;
    const regionCache = new Set();

    for (const size of STRUCT_SIZES) {
        for (let dx = -2; dx <= 2; dx++) {
            for (let dz = -2; dz <= 2; dz++) {
                for (let dy = -10; dy <= 10; dy++) {
                    const center = { x: x + dx, y: y + dy, z: z + dz };
                    const b = safeGetBlock(dim, center);
                    if (!isTankBlock(b)) continue;

                    for (let ox = -size.x + 1; ox <= 0; ox++) {
                        for (let oz = -size.z + 1; oz <= 0; oz++) {
                            const min = { x: center.x + ox, y: center.y, z: center.z + oz };
                            const max = { x: min.x + size.x - 1, y: center.y, z: min.z + size.z - 1 };
                            const regKey = `${min.x},${min.y},${min.z},${max.x},${max.y},${max.z}`;

                            if (regionCache.has(regKey)) continue;
                            regionCache.add(regKey);

                            let maxUp = 0, maxDown = 0;
                            const yBase = center.y;

                            // Scan upwards
                            while (true) {
                                let valid = true;
                                for (let dx2 = 0; dx2 < size.x && valid; dx2++) {
                                    for (let dz2 = 0; dz2 < size.z && valid; dz2++) {
                                        const pos = { x: min.x + dx2, y: yBase + maxUp, z: min.z + dz2 };
                                        const bb = safeGetBlock(dim, pos);
                                        if (!isTankBlock(bb)) {
                                            valid = false;
                                            break;
                                        }
                                        const tank = getTankByBlock(pos);
                                        if (tank && (tank.size.x > size.x || tank.size.z > size.z)) {
                                            valid = false;
                                            break;
                                        }
                                    }
                                }
                                if (!valid) break;
                                maxUp++;
                            }

                            if (maxUp === 0) continue;

                            // Scan downwards
                            while (true) {
                                let valid = true;
                                for (let dx2 = 0; dx2 < size.x && valid; dx2++) {
                                    for (let dz2 = 0; dz2 < size.z && valid; dz2++) {
                                        const pos = { x: min.x + dx2, y: yBase - maxDown - 1, z: min.z + dz2 };
                                        const bb = safeGetBlock(dim, pos);
                                        if (!isTankBlock(bb)) {
                                            valid = false;
                                            break;
                                        }
                                        const tank = getTankByBlock(pos);
                                        if (tank && (tank.size.x > size.x || tank.size.z > size.z)) {
                                            valid = false;
                                            break;
                                        }
                                    }
                                }
                                if (!valid) break;
                                maxDown++;
                            }

                            const yMin = yBase - maxDown;
                            const yMax = yBase + maxUp - 1;
                            const totalY = yMax - yMin + 1;

                            if (totalY < 1) continue;

                            const newBlocks = [];
                            for (let yy = yMin; yy <= yMax; yy++) {
                                for (let dx2 = 0; dx2 < size.x; dx2++) {
                                    for (let dz2 = 0; dz2 < size.z; dz2++) {
                                        newBlocks.push({ x: min.x + dx2, y: yy, z: min.z + dz2 });
                                    }
                                }
                            }

                            if (!newBlocks.some((bbb) => bbb.x === center.x && bbb.y === center.y && bbb.z === center.z))
                                continue;

                            const tanksInside = allTanks.filter(
                                (tank) =>
                                    tank.dimension === dim &&
                                    tank.blocks.every(
                                        (bk) =>
                                            bk.x >= min.x &&
                                            bk.x <= max.x &&
                                            bk.z >= min.z &&
                                            bk.z <= max.z &&
                                            bk.y >= yMin &&
                                            bk.y <= yMax
                                    )
                            );

                            let mergedBlocks = [...newBlocks];
                            for (const t of tanksInside) {
                                mergedBlocks = mergedBlocks.filter(
                                    (bk) => !t.blocks.some((tb) => tb.x === bk.x && tb.y === bk.y && tb.z === bk.z)
                                );
                            }

                            let conflict = false;
                            for (const bpos of mergedBlocks) {
                                const t = getTankByBlock(bpos);
                                if (t && !tanksInside.includes(t)) {
                                    conflict = true;
                                    break;
                                }
                            }

                            if (conflict) continue;

                            const shouldExpand =
                                tanksInside.length > 0 &&
                                (max.x - min.x + 1 > Math.max(...tanksInside.map((t) => t.size.x)) ||
                                    max.z - min.z + 1 > Math.max(...tanksInside.map((t) => t.size.z)) ||
                                    yMax - yMin + 1 > Math.max(...tanksInside.map((t) => t.size.y)));

                            if (
                                (tanksInside.length > 0 && shouldExpand) ||
                                (tanksInside.length === 0 && mergedBlocks.length === newBlocks.length)
                            ) {
                                for (const t of tanksInside) {
                                    clearTankBlocks(t);
                                    allTanks.removeIf((a) => a.id === t.id);
                                }

                                const structure = createNewStructure(
                                    newBlocks,
                                    { x: size.x, y: totalY, z: size.z },
                                    { x: min.x, y: yMin, z: min.z },
                                    { x: max.x, y: yMax, z: max.z },
                                    dim
                                );

                                allTanks.push(structure);
                                setTankBlocks(structure);

                                for (const pos of newBlocks) {
                                    setTankVisual(pos, dim, structure);
                                }

                                mergeVertical(structure);
                            }
                        }
                    }
                }
            }
        }
    }
}

function mergeVertical(tank) {
    // Check for tank below
    const below = allTanks.find(
        (t) =>
            t !== tank &&
            t.dimension === tank.dimension &&
            t.size.x === tank.size.x &&
            t.size.z === tank.size.z &&
            t.max.x === tank.max.x &&
            t.max.z === tank.max.z &&
            t.max.y + 1 === tank.min.y
    );

    if (below) {
        clearTankBlocks(below);
        clearTankBlocks(tank);
        allTanks.removeIf((t) => t.id === below.id || t.id === tank.id);

        const newBlocks = [...below.blocks, ...tank.blocks];
        const structure = createNewStructure(
            newBlocks,
            { x: tank.size.x, y: below.size.y + tank.size.y, z: tank.size.z },
            { x: tank.min.x, y: below.min.y, z: tank.min.z },
            { x: tank.max.x, y: tank.max.y, z: tank.max.z },
            tank.dimension
        );

        allTanks.push(structure);
        setTankBlocks(structure);

        for (const b of newBlocks) {
            setTankVisual(b, structure.dimension, structure);
        }

        mergeVertical(structure);
        return;
    }

    // Check for tank above
    const above = allTanks.find(
        (t) =>
            t !== tank &&
            t.dimension === tank.dimension &&
            t.size.x === tank.size.x &&
            t.size.z === tank.size.z &&
            t.min.x === tank.min.x &&
            t.min.z === tank.min.z &&
            t.min.y === tank.max.y + 1
    );

    if (above) {
        clearTankBlocks(above);
        clearTankBlocks(tank);
        allTanks.removeIf((t) => t.id === above.id || t.id === tank.id);

        const newBlocks = [...tank.blocks, ...above.blocks];
        const structure = createNewStructure(
            newBlocks,
            { x: tank.size.x, y: tank.size.y + above.size.y, z: tank.size.z },
            { x: tank.min.x, y: tank.min.y, z: tank.min.z },
            { x: tank.max.x, y: above.max.y, z: tank.max.z },
            tank.dimension
        );

        allTanks.push(structure);
        setTankBlocks(structure);

        for (const b of newBlocks) {
            setTankVisual(b, structure.dimension, structure);
        }

        mergeVertical(structure);
    }
}

function breakAndReassemble(block) {
    const tank = getTankByBlock(block.location);

    if (!tank) {
        expandOrAssembleStructuresAround(block);
        return;
    }

    clearTankBlocks(tank);
    allTanks.removeIf((t) => t.id === tank.id);

    const dim = block.dimension;

    for (const pos of tank.blocks) {
        if (pos.x === block.location.x && pos.y === block.location.y && pos.z === block.location.z)
            continue;

        const b = safeGetBlock(dim, pos);
        if (isTankBlock(b)) {
            expandOrAssembleStructuresAround(b);
        }
    }
}

function getBlockStates(sx, sy, sz, loc, min, max) {
    const px = loc.x - min.x;
    const pz = loc.z - min.z;

    let height;
    if (sy === 1) {
        height = "single";
    } else if (loc.y === min.y) {
        height = "bottom";
    } else if (loc.y === max.y) {
        height = "top";
    } else {
        height = "middle";
    }

    return {
        "sag:size": sx,
        "sag:height": height,
        "sag:pos_x": px,
        "sag:pos_z": pz
    };
}

function setTankVisual(loc, dim, tank) {
    const block = safeGetBlock(dim, loc);
    if (!block) return;

    const states = getBlockStates(
        tank.size.x,
        tank.size.y,
        tank.size.z,
        loc,
        tank.min,
        tank.max
    );

    try {
        block.setPermutation(BlockPermutation.resolve(BLOCK_ID, states));
    } catch (e) {
        console.warn(`Failed to set tank visual at ${loc.x},${loc.y},${loc.z}: ${e}`);
    }
}

function validateTank(tank) {
    const dim = tank.dimension;

    for (const pos of tank.blocks) {
        const block = safeGetBlock(dim, pos);

        if (!isTankBlock(block)) {
            const brokenBlock = block ?? { dimension: dim, location: pos };
            breakAndReassemble(brokenBlock);
            return;
        }
    }
}

let lastValidatedId = -1;
let tickCount = 0;

system.runInterval(() => {
    tickCount++;
    const immediateValidated = new Set();

    // Validate tanks player is looking at
    for (const player of world.getPlayers()) {
        if (!(player instanceof Player)) continue;

        const view = player.getViewDirection();
        const origin = player.location;
        const eyePos = { x: origin.x, y: origin.y + 1.6, z: origin.z };
        const step = 0.5;
        let prevCoord = null;

        for (let d = 0; d <= 12; d += step) {
            const cx = eyePos.x + view.x * d;
            const cy = eyePos.y + view.y * d;
            const cz = eyePos.z + view.z * d;
            const bx = Math.floor(cx);
            const by = Math.floor(cy);
            const bz = Math.floor(cz);
            const key = `${bx},${by},${bz}`;

            if (prevCoord === key) continue;
            prevCoord = key;

            const block = safeGetBlock(player.dimension, { x: bx, y: by, z: bz });
            if (!block) break;

            const typeId = block.typeId;

            if (typeId === BLOCK_ID) {
                const tank = blockToTank.get(key);
                if (tank) {
                    validateTank(tank);
                    immediateValidated.add(tank.id);
                }
                break;
            } else if (typeId !== "minecraft:air") {
                break;
            }
        }
    }

    // Periodic validation of nearby tanks
    if (tickCount % 2 === 0) {
        const players = [...world.getPlayers()];
        const relevantTanks = allTanks.filter((tank) =>
            players.some((player) => {
                if (tank.dimension !== player.dimension) return false;

                const dx = tank.min.x + (tank.max.x - tank.min.x + 1) / 2 - player.location.x;
                const dz = tank.min.z + (tank.max.z - tank.min.z + 1) / 2 - player.location.z;

                return dx * dx + dz * dz <= 128 * 128;
            })
        );

        const others = relevantTanks.filter((tank) => !immediateValidated.has(tank.id));

        if (others.length > 0) {
            others.sort((a, b) => a.id - b.id);

            let targetTank;
            if (lastValidatedId === -1) {
                targetTank = others[0];
            } else {
                targetTank = others.find((t) => t.id > lastValidatedId) || others[0];
            }

            validateTank(targetTank);
            lastValidatedId = targetTank.id;
        }
    }
}, 1);

world.afterEvents.playerPlaceBlock.subscribe((ev) => {
    const { block } = ev;
    if (block.typeId !== BLOCK_ID) return;

    expandOrAssembleStructuresAround(block);
});

world.afterEvents.playerBreakBlock.subscribe((ev) => {
    const { block } = ev;
    if (block.typeId !== BLOCK_ID) return;

    breakAndReassemble(block);
});
