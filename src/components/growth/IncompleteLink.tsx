import { Button } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Notice";

/**
 * A token link that arrived without a usable token (cut off by a mail client, mistyped). Judged
 * on the URL's shape alone — nothing is looked up, so it reveals nothing about any record (P14).
 */
export function IncompleteLink({ what }: { what: string }) {
  return (
    <div className="max-w-xl space-y-6">
      <Notice tone="info" title="This link is incomplete">
        The {what} link from your email includes a code this page needs. Open it again straight from the email — if your mail app split it over two
        lines, copy the whole link.
      </Notice>
      <Button href="/">Back to the store</Button>
    </div>
  );
}
