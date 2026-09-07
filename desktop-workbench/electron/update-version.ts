type Version = { release: bigint[]; pre: string[] };

function parse(value: string): Version | null {
  if (value.length > 128) return null;
  const match = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)|((?:a|b|rc|dev)\d+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (!match) return null;
  const suffix = match[2] ?? match[3]?.replace(/(\D+)(\d+)$/, "$1.$2");
  return { release: match[1].split(".").map(BigInt), pre: suffix?.split(".") ?? [] };
}

/** Numeric release segments support both 0.1.7.2 (Server) and Electron SemVer. */
export function compareUpdateVersions(left: string, right: string): number | null {
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return null;
  for (let i = 0; i < Math.max(a.release.length, b.release.length); i++) {
    const difference = (a.release[i] ?? 0n) - (b.release[i] ?? 0n);
    if (difference !== 0n) return difference > 0n ? 1 : -1;
  }
  if (!a.pre.length || !b.pre.length) return a.pre.length ? -1 : b.pre.length ? 1 : 0;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (BigInt(x) === BigInt(y)) continue;
      return BigInt(x) > BigInt(y) ? 1 : -1;
    }
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}
