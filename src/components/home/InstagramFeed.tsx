/* eslint-disable @next/next/no-img-element -- Instagram's own picture URLs (signed, short-lived): served as they are, not through the image optimiser */
import { Camera, Play } from "lucide-react";
import { BracketLink } from "@/components/ui/Button";
import { SectionHeader } from "@/components/ui/SectionHeader";
import type { InstagramFeed as Feed } from "@/lib/instagram";

/**
 * "Follow us on Instagram" — the store's latest posts (55_instagram_feed; the client's reference was
 * laptop.lk's strip). Square tiles in a row that scrolls sideways, each opening the post on
 * Instagram. Hidden until the owner connects Instagram in the admin.
 */
export function InstagramFeed({ feed, index, profileUrl }: { feed: Feed; index: string; profileUrl: string | null }) {
  const handle = feed.username ? `@${feed.username}` : "Instagram";
  const profile = profileUrl ?? (feed.username ? `https://www.instagram.com/${feed.username}/` : null);
  return (
    <section aria-labelledby="instagram" className="scroll-mt-28">
      <SectionHeader index={index} title="Follow us on Instagram" id="instagram">
        {profile && (
          <a href={profile} target="_blank" rel="noopener noreferrer" className="label mb-1 inline-flex items-center gap-1.5 font-semibold text-violet-ink hover:text-ink">
            <Camera aria-hidden className="size-4" />
            {handle}
          </a>
        )}
      </SectionHeader>
      <ul className="-mx-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-2 [scrollbar-width:none] sm:mx-0 sm:scroll-px-0 sm:px-0">
        {feed.posts.map((post) => (
          <li key={post.id} className="w-[46%] shrink-0 snap-start sm:w-[31%] lg:w-[calc((100%-3*0.75rem)/4)] xl:w-[calc((100%-5*0.75rem)/6)]">
            <a
              href={post.permalink}
              target="_blank"
              rel="noopener noreferrer"
              className="group relative block aspect-square overflow-hidden border border-line bg-surface-2 hover:border-ink"
              aria-label={post.caption ? `Instagram post: ${post.caption.slice(0, 120)}` : "Open this post on Instagram"}
            >
              <img
                src={post.image}
                alt=""
                loading="lazy"
                decoding="async"
                className="absolute inset-0 size-full object-cover transition-transform duration-500 ease-brut group-hover:scale-105"
              />
              {post.mediaType === "VIDEO" && (
                <span aria-hidden className="absolute top-2 right-2 grid size-7 place-items-center bg-ink/70 text-paper">
                  <Play className="size-3.5 fill-current" />
                </span>
              )}
              {post.caption && (
                <span className="absolute inset-x-0 bottom-0 line-clamp-3 bg-ink/80 px-2.5 py-2 text-[12px] leading-4 text-paper opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100">
                  {post.caption}
                </span>
              )}
            </a>
          </li>
        ))}
      </ul>
      {profile && (
        <BracketLink href={profile} className="mt-3">
          {`See more on Instagram`}
        </BracketLink>
      )}
    </section>
  );
}
