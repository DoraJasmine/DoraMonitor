/**
 * 纯几何工具:把指针的 SVG 用户坐标吸附到最近的刻度索引。
 *
 * 图表 SVG 设定了 viewBox 但未固定容器宽高比,浏览器默认
 * preserveAspectRatio="xMidYMid meet" 会把内容居中并留黑边;因此
 * 指针位置必须先经 CTM 反算成 SVG 用户坐标,再按与数据点相同的
 * xAt(i) 序列取最近点,不能把"容器宽度"线性映射成索引。
 */
export function nearestIndex(x, xs) {
  if (!Array.isArray(xs) || !xs.length) return null;
  if (!Number.isFinite(x)) return null;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < xs.length; i++) {
    const d = Math.abs(xs[i] - x);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}
