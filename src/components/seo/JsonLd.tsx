import { jsonLdScript } from "@/lib/html";

/**
 * One JSON-LD block (blueprint §9.1 / §6.6): serialised with jsonLdScript(), which escapes
 * `<`, `>`, `&`, U+2028 and U+2029 so a product named `</script>` cannot break out.
 */
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(data) }} />;
}
