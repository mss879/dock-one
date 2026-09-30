/**
 * Streaming fallback while /recover reads the saved basket and the live catalogue. Generic on
 * purpose (it also briefly covers /recover/stop). This segment never calls notFound(), so a
 * loading boundary can't turn a 404 into a soft 200 (blueprint §3.2).
 */
export default function RecoverLoading() {
  return (
    <main id="main" className="shell pt-8 pb-24 lg:pt-12" aria-busy="true">
      <p className="sr-only" role="status">
        Loading…
      </p>
      <div aria-hidden className="space-y-6">
        <div className="h-4 w-40 bg-line" />
        <div className="h-14 w-full max-w-md bg-line" />
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="h-48 border border-line bg-surface" />
          <div className="h-48 border border-line bg-surface" />
        </div>
      </div>
    </main>
  );
}
