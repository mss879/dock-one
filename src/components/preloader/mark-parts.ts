import { MARK } from "@/components/brand/logo-paths";

/*
 * The DO monogram split into the pieces the preloaders animate separately. MARK.d is four
 * subpaths in this order: the O arc, the D outline, the D's counter (hole), the lens inside it.
 * The D keeps its hole so it still fills correctly on its own.
 */
const [o, dOuter, dHole, lens] = MARK.d.split(/(?<=Z)(?=M)/);

export const MARK_PARTS = { w: MARK.w, h: MARK.h, o, d: `${dOuter}${dHole}`, lens } as const;
