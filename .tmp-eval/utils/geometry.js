"use strict";
// Pure 2D geometry helpers — no OpenCV, no DOM.
Object.defineProperty(exports, "__esModule", { value: true });
exports.add = exports.sub = void 0;
exports.clamp01 = clamp01;
exports.dist = dist;
exports.centroid = centroid;
exports.polygonArea = polygonArea;
exports.orderQuad = orderQuad;
exports.angleAt = angleAt;
exports.rightAngleScore = rightAngleScore;
exports.squareScore = squareScore;
exports.centerScore = centerScore;
exports.convexHull = convexHull;
exports.variance = variance;
exports.pointInPoly = pointInPoly;
exports.dpClosed = dpClosed;
exports.topKCorners = topKCorners;
exports.parallelogramScore = parallelogramScore;
exports.minAreaRect = minAreaRect;
function clamp01(x) {
    return x < 0 ? 0 : x > 1 ? 1 : x;
}
function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}
function centroid(pts) {
    let x = 0, y = 0;
    for (const p of pts) {
        x += p.x;
        y += p.y;
    }
    return { x: x / pts.length, y: y / pts.length };
}
// Shoelace area of a polygon.
function polygonArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
        const p = pts[i], q = pts[(i + 1) % pts.length];
        a += p.x * q.y - q.x * p.y;
    }
    return Math.abs(a) / 2;
}
// Order 4 points as TL, TR, BR, BL (screen coords, y down).
function orderQuad(pts) {
    const c = centroid(pts);
    const withAngle = pts.map((p) => ({ p, a: Math.atan2(p.y - c.y, p.x - c.x) }));
    // sort clockwise starting from top-left
    withAngle.sort((u, v) => u.a - v.a);
    const ordered = withAngle.map((w) => w.p);
    // rotate so the top-left (smallest x+y) is first
    let startIdx = 0, best = Infinity;
    for (let i = 0; i < ordered.length; i++) {
        const s = ordered[i].x + ordered[i].y;
        if (s < best) {
            best = s;
            startIdx = i;
        }
    }
    return [
        ordered[startIdx],
        ordered[(startIdx + 1) % 4],
        ordered[(startIdx + 2) % 4],
        ordered[(startIdx + 3) % 4],
    ];
}
// Interior angle at vertex b given neighbours a and c, in degrees.
function angleAt(a, b, c) {
    const v1x = a.x - b.x, v1y = a.y - b.y;
    const v2x = c.x - b.x, v2y = c.y - b.y;
    const dot = v1x * v2x + v1y * v2y;
    const m = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) || 1;
    return (Math.acos(Math.max(-1, Math.min(1, dot / m))) * 180) / Math.PI;
}
// 1 when all four interior angles are 90°, decaying as they deviate.
function rightAngleScore(pts) {
    let dev = 0;
    for (let i = 0; i < 4; i++) {
        const a = pts[(i + 3) % 4], b = pts[i], c = pts[(i + 1) % 4];
        dev += Math.abs(angleAt(a, b, c) - 90);
    }
    return clamp01(1 - dev / 4 / 35); // ~35° mean deviation → 0
}
// 1 when the four sides are equal length, decaying with imbalance.
function squareScore(pts) {
    const sides = [
        dist(pts[0], pts[1]),
        dist(pts[1], pts[2]),
        dist(pts[2], pts[3]),
        dist(pts[3], pts[0]),
    ];
    const mn = Math.min(...sides), mx = Math.max(...sides);
    return mx === 0 ? 0 : mn / mx;
}
// 1 when the quad is centred in the frame.
function centerScore(pts, W, H) {
    const c = centroid(pts);
    const dx = (c.x - W / 2) / (W / 2);
    const dy = (c.y - H / 2) / (H / 2);
    return clamp01(1 - Math.hypot(dx, dy) / 1.1);
}
// Andrew's monotone-chain convex hull (CCW, no repeated endpoint).
function convexHull(points) {
    if (points.length < 3)
        return points.slice();
    const pts = points.slice().sort((a, b) => (a.x - b.x) || (a.y - b.y));
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower = [];
    for (const p of pts) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
            lower.pop();
        lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
        const p = pts[i];
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
            upper.pop();
        upper.push(p);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
}
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
exports.sub = sub;
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
exports.add = add;
function variance(pts) {
    const c = centroid(pts);
    let v = 0;
    for (const p of pts)
        v += (p.x - c.x) ** 2 + (p.y - c.y) ** 2;
    return v / pts.length;
}
function pointInPoly(pt, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
        if (((yi > pt.y) !== (yj > pt.y)) && (pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi))
            inside = !inside;
    }
    return inside;
}
function perpDist(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
}
function dpOpen(pts, eps) {
    if (pts.length < 3)
        return pts.slice();
    let idx = -1, mx = 0;
    for (let i = 1; i < pts.length - 1; i++) {
        const d = perpDist(pts[i], pts[0], pts[pts.length - 1]);
        if (d > mx) {
            mx = d;
            idx = i;
        }
    }
    if (mx > eps) {
        const l = dpOpen(pts.slice(0, idx + 1), eps);
        const r = dpOpen(pts.slice(idx), eps);
        return l.slice(0, -1).concat(r);
    }
    return [pts[0], pts[pts.length - 1]];
}
// Douglas-Peucker on a closed polygon (convex hull) → corner list.
function dpClosed(hull, eps) {
    const n = hull.length;
    if (n < 4)
        return hull.slice();
    let a = 0, b = 0, md = 0;
    for (let i = 0; i < n; i++)
        for (let j = i + 1; j < n; j++) {
            const d = dist(hull[i], hull[j]);
            if (d > md) {
                md = d;
                a = i;
                b = j;
            }
        }
    const arc1 = [];
    for (let i = a; i !== b; i = (i + 1) % n)
        arc1.push(hull[i]);
    arc1.push(hull[b]);
    const arc2 = [];
    for (let i = b; i !== a; i = (i + 1) % n)
        arc2.push(hull[i]);
    arc2.push(hull[a]);
    return dpOpen(arc1, eps).slice(0, -1).concat(dpOpen(arc2, eps).slice(0, -1));
}
// Keep the k sharpest-turn corners (in original order).
function topKCorners(poly, k) {
    const n = poly.length;
    if (n <= k)
        return poly;
    const ang = poly.map((p, i) => {
        const a = poly[(i - 1 + n) % n], b = poly[(i + 1) % n];
        const v1x = a.x - p.x, v1y = a.y - p.y, v2x = b.x - p.x, v2y = b.y - p.y;
        const dot = v1x * v2x + v1y * v2y;
        const m = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) || 1;
        return { i, turn: Math.acos(Math.max(-1, Math.min(1, dot / m))) };
    });
    ang.sort((x, y) => x.turn - y.turn);
    const keep = ang.slice(0, k).map((o) => o.i).sort((x, y) => x - y);
    return keep.map((i) => poly[i]);
}
// How parallelogram-like a quad [a,b,c,d] is: opposite sides equal & parallel.
function parallelogramScore(q) {
    const [a, b, c, d] = q;
    const s1 = dist(a, b), s2 = dist(b, c), s3 = dist(c, d), s4 = dist(d, a);
    const eq1 = Math.min(s1, s3) / Math.max(s1, s3), eq2 = Math.min(s2, s4) / Math.max(s2, s4);
    const dir = (p, q2) => { const dx = q2.x - p.x, dy = q2.y - p.y, l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]; };
    const [ax, ay] = dir(a, b), [cx, cy] = dir(d, c);
    const [bx, by] = dir(b, c), [dx2, dy2] = dir(a, d);
    return eq1 * eq2 * Math.abs(ax * cx + ay * cy) * Math.abs(bx * dx2 + by * dy2);
}
// Minimum-area enclosing rectangle of a convex hull (rotating calipers).
// Returns the 4 corners (ordered TL,TR,BR,BL) and the rectangle area.
function minAreaRect(hull) {
    if (hull.length < 3)
        return null;
    let best = null;
    const n = hull.length;
    for (let i = 0; i < n; i++) {
        const a = hull[i], b = hull[(i + 1) % n];
        let ux = b.x - a.x, uy = b.y - a.y;
        const len = Math.hypot(ux, uy) || 1;
        ux /= len;
        uy /= len;
        const vx = -uy, vy = ux;
        let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
        for (const p of hull) {
            const du = p.x * ux + p.y * uy;
            const dv = p.x * vx + p.y * vy;
            if (du < minU)
                minU = du;
            if (du > maxU)
                maxU = du;
            if (dv < minV)
                minV = dv;
            if (dv > maxV)
                maxV = dv;
        }
        const area = (maxU - minU) * (maxV - minV);
        if (!best || area < best.area) {
            const corner = (uu, vv) => ({ x: ux * uu + vx * vv, y: uy * uu + vy * vv });
            best = {
                area,
                corners: [corner(minU, minV), corner(maxU, minV), corner(maxU, maxV), corner(minU, maxV)],
            };
        }
    }
    if (!best)
        return null;
    return { corners: orderQuad(best.corners), area: best.area };
}
