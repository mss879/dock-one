export type SceneVariant = "night" | "paper" | "violet" | "lime";

type Cube = { x: number; y: number; s: number; c: string };

const base: Record<SceneVariant, string> = {
  night: "bg-night [--grid-line:rgb(255_255_255/0.06)]",
  paper: "bg-surface-2 [--grid-line:rgb(11_11_12/0.07)]",
  violet: "bg-violet [--grid-line:rgb(255_255_255/0.12)]",
  lime: "bg-lime [--grid-line:rgb(11_11_12/0.1)]",
};

const cubes: Record<SceneVariant, Cube[]> = {
  night: [
    { x: 58, y: 16, s: 14, c: "bg-violet" }, { x: 88, y: 28, s: 9, c: "bg-lime" }, { x: 52, y: 70, s: 8, c: "bg-white/20" },
    { x: 93, y: 62, s: 18, c: "bg-white/10" }, { x: 70, y: 86, s: 10, c: "bg-violet/70" }, { x: 80, y: 8, s: 6, c: "bg-white/30" },
  ],
  paper: [
    { x: 56, y: 14, s: 22, c: "bg-ink/80" }, { x: 63, y: 24, s: 22, c: "bg-ink/25" }, { x: 86, y: 12, s: 14, c: "bg-violet" },
    { x: 92, y: 40, s: 18, c: "bg-ink/10" }, { x: 52, y: 66, s: 12, c: "bg-lime" }, { x: 88, y: 76, s: 24, c: "bg-ink/15" },
    { x: 60, y: 84, s: 10, c: "bg-violet/60" }, { x: 78, y: 90, s: 8, c: "bg-ink/60" },
  ],
  violet: [
    { x: 60, y: 12, s: 16, c: "bg-ink" }, { x: 90, y: 22, s: 10, c: "bg-lime" }, { x: 54, y: 72, s: 10, c: "bg-white/25" },
    { x: 92, y: 70, s: 20, c: "bg-ink/40" }, { x: 74, y: 88, s: 8, c: "bg-lime" },
  ],
  lime: [
    { x: 58, y: 14, s: 16, c: "bg-ink" }, { x: 90, y: 20, s: 10, c: "bg-violet" }, { x: 54, y: 74, s: 10, c: "bg-ink/30" },
    { x: 92, y: 72, s: 20, c: "bg-ink/15" }, { x: 72, y: 90, s: 8, c: "bg-ink" },
  ],
};

/**
 * CSS-only backdrop: blueprint grid, glow and scattered voxels.
 * Used on its own, and as the fallback wherever a generated scene is missing.
 */
export function Scene({ variant, ring = false, voxels = true, className = "" }: { variant: SceneVariant; ring?: boolean; voxels?: boolean; className?: string }) {
  return (
    <div aria-hidden className={`absolute inset-0 overflow-hidden ${base[variant]} ${className}`}>
      <div className="bg-grid absolute inset-0" />
      {variant === "night" && <div className="absolute inset-0 bg-[radial-gradient(60%_70%_at_72%_55%,rgb(109_59_255/0.42),transparent_70%)]" />}
      {variant === "paper" && <div className="absolute inset-0 bg-[radial-gradient(55%_65%_at_72%_50%,rgb(255_255_255/0.95),transparent_70%)]" />}
      {variant === "violet" && <div className="absolute inset-0 bg-[radial-gradient(55%_65%_at_72%_50%,rgb(255_255_255/0.22),transparent_70%)]" />}
      {variant === "lime" && <div className="absolute inset-0 bg-[radial-gradient(55%_65%_at_72%_50%,rgb(255_255_255/0.55),transparent_70%)]" />}
      {ring && (
        <div className="absolute top-1/2 left-[72%] aspect-square h-[78%] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-violet shadow-[0_0_70px_8px_rgb(109_59_255/0.55),inset_0_0_50px_rgb(109_59_255/0.35)]" />
      )}
      {voxels &&
        cubes[variant].map((cube, i) => (
          <span key={i} className={`absolute ${cube.c}`} style={{ left: `${cube.x}%`, top: `${cube.y}%`, width: cube.s, height: cube.s }} />
        ))}
    </div>
  );
}
