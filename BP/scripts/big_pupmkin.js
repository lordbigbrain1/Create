// scripts/structure_network.js
import { world, system, Player, BlockPermutation } from "@minecraft/server";

/**
 * Укажите тут все блоки, из которых строится структура/сеть.
 * Для демо оставлен sag:big_pumpkin. Добавьте свои: "sag:vault", ...
 */
const NETWORK_BLOCKS = new Set([
    "sag:big_pumpkin",
    // "sag:vault",
    // "sag:vault_small",
    // "sag:vault_medium",
]);

/** Если в ваших блоках нет стейта "middle", поставьте false */
const USE_MIDDLE = true;

/** Нормализация ориентации: N->S, W->E (по вашему требованию) */
function normalizeFacing(block) {
    try {
        const perm = block.permutation;
        const f = perm.getState("minecraft:cardinal_direction");
        let nf = f;
        if (f === "north") nf = "south";
        if (f === "west") nf = "east";
        if (nf !== f && nf) {
            block.setPermutation(perm.withState("minecraft:cardinal_direction", nf));
            return nf;
        }
        return f;
    } catch {
        return undefined;
    }
}

/** Безопасно получить блок */
function safeGetBlock(dim, pos) {
    try { return dim.getBlock(pos); } catch { return undefined; }
}

/** Это наш сетевой блок? */
function isNetworkBlock(b) {
    return !!b && NETWORK_BLOCKS.has(b.typeId);
}

/** Прочитать ориентацию */
function getFacing(block) {
    try { return block.permutation.getState("minecraft:cardinal_direction"); } catch { return undefined; }
}

/** Локальные оси для cardinal_direction */
function basisFor(facing) {
    // forward/right; up = +Y
    switch (facing) {
        case "south": return { fwd: { x: 0, y: 0, z: 1 }, right: { x: 1, y: 0, z: 0 } };
        case "north": return { fwd: { x: 0, y: 0, z: -1 }, right: { x: -1, y: 0, z: 0 } };
        case "east": return { fwd: { x: 1, y: 0, z: 0 }, right: { x: 0, y: 0, z: -1 } };
        case "west": return { fwd: { x: -1, y: 0, z: 0 }, right: { x: 0, y: 0, z: 1 } };
        default: return { fwd: { x: 0, y: 0, z: 1 }, right: { x: 1, y: 0, z: 0 } }; // south по умолчанию
    }
}

function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }

/** Перевод мировых координат в локальные (s — длина, u — поперёк, t — вверх) */
function toLocal(facing, origin, p) {
    const { fwd, right } = basisFor(facing);
    const d = { x: p.x - origin.x, y: p.y - origin.y, z: p.z - origin.z };
    return { s: dot(d, fwd), u: dot(d, right), t: d.y };
}

/** 6-соседей по клетке */
const OFF6 = [
    { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 },
    { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 },
];

/** BFS компонент связности: только наши блоки и только с одинаковым facing */
function bfsComponent(dim, startPos, mustFacing /*string|undefined*/) {
    const startBlock = safeGetBlock(dim, startPos);
    if (!isNetworkBlock(startBlock)) return { list: [], facing: undefined };

    const facing = mustFacing ?? getFacing(startBlock);
    if (!facing) return { list: [], facing: undefined };

    const seen = new Set();
    const q = [startPos];
    const out = [];

    const k = (p) => `${p.x}|${p.y}|${p.z}`;
    seen.add(k(startPos));
    out.push({ pos: startPos, block: startBlock });

    while (q.length) {
        const p = q.shift();
        for (const d of OFF6) {
            const np = { x: p.x + d.x, y: p.y + d.y, z: p.z + d.z };
            const nk = k(np);
            if (seen.has(nk)) continue;
            const nb = safeGetBlock(dim, np);
            if (!isNetworkBlock(nb)) continue;
            if (getFacing(nb) !== facing) continue; // ключ: соседняя структура с другим facing не попадёт
            seen.add(nk);
            q.push(np);
            out.push({ pos: np, block: nb });
        }
    }

    return { list: out, facing };
}

/** Утилита стейтов */
function setStates(block, tier, segment, cell) {
    try {
        let p = block.permutation;
        p = p.withState("sag:tier", String(tier));
        p = p.withState("sag:segment", segment);
        p = p.withState("sag:cell", cell);
        block.setPermutation(p);
    } catch {
        // Если каких-то стейтов нет у конкретного блока — молча пропускаем.
    }
}

/** Раскладка ролей внутри компоненты. Поддержка 1×1×L, 2×2×L, минимум 2×2×2. */
function retagComponent(dim, nodes, facing) {
    if (!nodes.length) return;

    // Локальные координаты относительно первого узла
    const origin = nodes[0].pos;
    const loc = nodes.map(n => {
        const lt = toLocal(facing, origin, n.pos);
        return { ...n, ns: lt.s, nu: lt.u, nt: lt.t };
    });

    // Нормализация к 0..(size-1)
    let sMin = Infinity, uMin = Infinity, tMin = Infinity, sMax = -Infinity, uMax = -Infinity, tMax = -Infinity;
    for (const e of loc) {
        sMin = Math.min(sMin, e.ns); uMin = Math.min(uMin, e.nu); tMin = Math.min(tMin, e.nt);
        sMax = Math.max(sMax, e.ns); uMax = Math.max(uMax, e.nu); tMax = Math.max(tMax, e.nt);
    }
    for (const e of loc) { e.ns -= sMin; e.nu -= uMin; e.nt -= tMin; }

    const S = sMax - sMin + 1; // длина
    const U = uMax - uMin + 1; // ширина (поперёк)
    const T = tMax - tMin + 1; // высота

    // Карта занятости
    const byKey = new Map(); // "s|u|t" -> блок
    for (const e of loc) byKey.set(`${e.ns}|${e.nu}|${e.nt}`, e.block);

    // Сначала всем зададим 1×1×L (на случай отсутствия полноценных 2×2)
    const mapByS = new Map();
    for (const e of loc) {
        if (!mapByS.has(e.ns)) mapByS.set(e.ns, []);
        mapByS.get(e.ns).push(e);
    }
    const sKeys = Array.from(mapByS.keys()).sort((a, b) => a - b);
    for (let i = 0; i < sKeys.length; i++) {
        const s = sKeys[i];
        const first = (i === 0), last = (i === sKeys.length - 1);
        const seg = (sKeys.length === 1) ? "unit" : first ? "face" : last ? "back" : (USE_MIDDLE ? "middle" : "back");
        for (const e of mapByS.get(s)) setStates(e.block, 1, seg, "single");
    }

    // Проверяем полноценные слои 2×2 (u:0..1, t:0..1). Требуем хотя бы длину 2 (2×2×2).
    if (U >= 2 && T >= 2 && S >= 2) {
        const full2x2AtS = new Array(S).fill(false);
        for (let s = 0; s < S; s++) {
            const k00 = `${s}|0|0`, k10 = `${s}|1|0`, k01 = `${s}|0|1`, k11 = `${s}|1|1`;
            if (byKey.has(k00) && byKey.has(k10) && byKey.has(k01) && byKey.has(k11)) full2x2AtS[s] = true;
        }
        // Непрерывные отрезки по S, где есть полный 2×2
        const runs = [];
        let i = 0;
        while (i < S) {
            if (!full2x2AtS[i]) { i++; continue; }
            let j = i; while (j + 1 < S && full2x2AtS[j + 1]) j++;
            runs.push([i, j]); i = j + 1;
        }

        const cellName = (u, t) => (t === 0 && u === 0) ? "dl" :
            (t === 0 && u === 1) ? "dr" :
                (t === 1 && u === 0) ? "ul" : "ur";

        for (const [a, b] of runs) {
            // Требуем минимум 2 слоя по длине (чтобы это был 2×2×2+)
            if ((b - a + 1) < 2) continue;

            for (let s = a; s <= b; s++) {
                const seg = (a === b) ? "unit" : (s === a ? "face" : s === b ? "back" : (USE_MIDDLE ? "middle" : "back"));
                for (let u = 0; u < 2; u++) {
                    for (let t = 0; t < 2; t++) {
                        const bk = byKey.get(`${s}|${u}|${t}`);
                        if (!bk) continue;
                        setStates(bk, 2, seg, cellName(u, t));
                    }
                }
            }
        }
    }
}

/** === PLACE: нормализуем facing, собираем компоненту, размечаем === */
function onPlace(ev) {
    try {
        const b = ev.block;
        if (!NETWORK_BLOCKS.has(b.typeId)) return;

        // нормализуем ориентацию (N->S, W->E)
        const nf = normalizeFacing(b) ?? getFacing(b);
        const dim = b.dimension;

        const { list, facing } = bfsComponent(dim, b.location, nf);
        if (!list.length || !facing) return;

        // Ретег всего компонента
        retagComponent(dim, list.map(x => ({ pos: x.pos, block: x.block })), facing);
    } catch (e) {
        console.warn("[structure_network] onPlace error:", e);
    }
}

/** === BREAK: на месте уже air, поэтому обходим соседей и ретегаем их компоненты === */
function onBreak(ev) {
    try {
        const brokenId = ev.brokenBlockPermutation?.type?.id;
        if (!NETWORK_BLOCKS.has(brokenId)) return;

        const dim = ev.block.dimension;
        const p = ev.block.location;

        // соберём все компоненты вокруг 6 соседей и ретегнём их по одному
        const seenOrigins = new Set();
        for (const d of OFF6) {
            const np = { x: p.x + d.x, y: p.y + d.y, z: p.z + d.z };
            const nb = safeGetBlock(dim, np);
            if (!isNetworkBlock(nb)) continue;

            const f = getFacing(nb);
            if (!f) continue;

            const { list, facing } = bfsComponent(dim, np, f);
            if (!list.length) continue;

            // Чтобы не перетегать одну и ту же компоненту несколько раз,
            // хешируем минимальную позицию в списке как её ключ
            const minKey = list
                .map(n => `${n.pos.x}|${n.pos.y}|${n.pos.z}`)
                .sort()[0];
            if (seenOrigins.has(minKey)) continue;
            seenOrigins.add(minKey);

            retagComponent(dim, list.map(x => ({ pos: x.pos, block: x.block })), facing);
        }
    } catch (e) {
        console.warn("[structure_network] onBreak error:", e);
    }
}

/** Подписки с фильтром по типам — сразу отсекаем весь лишний трафик */
world.afterEvents.playerPlaceBlock.subscribe(onPlace, {
    blockTypes: Array.from(NETWORK_BLOCKS),
});
world.afterEvents.playerBreakBlock.subscribe(onBreak, {
    blockTypes: Array.from(NETWORK_BLOCKS),
});

// На всякий случай один раз “пропихнём” тики, чтобы гарантировать инициализацию.
system.run(() => { });
