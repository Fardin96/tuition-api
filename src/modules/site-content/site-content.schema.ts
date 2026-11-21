import { z } from "zod";

// Landing-page blocks and the four static pages, stored as keyed JSON in site_content.
// Writes are validated here; reads parse the stored row with the same schema and fall back
// to the default when it no longer fits (see site-content.service.ts).

// ── Field helpers ──────────────────────────────────────────────

/** One line of text: trimmed, not empty, no line breaks. */
const line = (max: number) =>
  z
    .string()
    .trim()
    .min(1, "Required")
    .max(max, `At most ${max} characters`)
    .refine((v) => !/[\r\n]/.test(v), "Keep this on one line");

/** A paragraph: trimmed, not empty, line breaks allowed. */
const text = (max: number) =>
  z.string().trim().min(1, "Required").max(max, `At most ${max} characters`);

export const wordCount = (value: string) => value.split(/\s+/).filter(Boolean).length;

const words = (maxChars: number, maxWords: number) =>
  text(maxChars).refine((v) => wordCount(v) <= maxWords, `At most ${maxWords} words`);

// A site path ("/blog", "/#faq") or an https URL. Refuses "//host", backslashes, spaces,
// "javascript:", "data:" and plain http.
export const HREF_PATTERN = /^(?:\/(?![/\\])[^\s\\]*|https:\/\/[^\s\\/]+[^\s\\]*)$/;
const href = z
  .string()
  .trim()
  .min(1, "Required")
  .max(300, "At most 300 characters")
  .regex(HREF_PATTERN, "Use a site path like /blog or a link starting with https://");

const httpsUrl = z
  .string()
  .trim()
  .max(300, "At most 300 characters")
  .regex(/^https:\/\/[^\s\\/]+[^\s\\]*$/, "Use a link starting with https://");

// Media fields hold one of: a file shipped with the web app ("/assets/…", "/videos/….mp4"), an
// uploaded file ("file:<id>", purpose SITE_IMAGE or SITE_VIDEO), or an https URL. Stored values use
// the first two; the public GET answers uploaded files as https URLs, which the web renders
// unoptimized because next/image only optimizes known hosts.
export const FILE_REF_PATTERN =
  /^file:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const HTTPS_URL = /^https:\/\/[^\s\\/]+[^\s\\]*$/;

/** The uploaded file id in a "file:<id>" value, else null. */
export function fileRefId(value: string): string | null {
  return FILE_REF_PATTERN.exec(value)?.[1] ?? null;
}

/** Which upload kind each media field takes, by the field's name. */
export const MEDIA_FIELD_KINDS = { photo: "image", thumbnail: "image", video: "video" } as const;

export const IMAGE_PATTERN = /^\/assets\/(?!.*\.\.)[A-Za-z0-9/_.-]+\.(?:png|jpe?g|webp|svg)$/;
const image = z
  .string()
  .trim()
  .max(1000, "At most 1000 characters")
  .refine(
    (v) => IMAGE_PATTERN.test(v) || FILE_REF_PATTERN.test(v) || HTTPS_URL.test(v),
    "Upload an image or pick one from the list",
  );

export const VIDEO_PATTERN = /^\/videos\/[A-Za-z0-9_.-]+\.mp4$/;
const video = z
  .string()
  .trim()
  .max(1000, "At most 1000 characters")
  .refine(
    (v) => VIDEO_PATTERN.test(v) || FILE_REF_PATTERN.test(v) || HTTPS_URL.test(v),
    "Upload a video, pick one from the list, or use a link starting with https://",
  );

const link = z.object({ label: line(40), href });

// ── Blocks ─────────────────────────────────────────────────────

export const heroBlockSchema = z
  .object({
    tagline: line(60),
    headline: line(80),
    subline: text(200),
    skillPlaceholders: z.array(line(40)).min(1).max(8),
    placePlaceholders: z.array(line(40)).min(1).max(8),
    searchLabel: line(20),
  })
  .meta({ id: "SiteHeroBlock" });

export const navBlockSchema = z
  .object({ links: z.array(link).min(1).max(7), cta: link })
  .meta({ id: "SiteNavBlock" });

export const categoriesBlockSchema = z
  .object({ title: line(80), description: text(200), cta: link })
  .meta({ id: "SiteCategoriesBlock" });

// Where a card came from when an admin added it from a user's submission. The card comes off the
// landing when that submission is withdrawn, rejected or removed. Stored only; the public GET drops it.
export const cardSourceSchema = z
  .object({
    kind: z.enum(["story", "tutor_video"]),
    id: z.string().uuid(),
  })
  .meta({ id: "SiteCardSource" });
export type CardSource = z.infer<typeof cardSourceSchema>;
export type LandingSourceKind = CardSource["kind"];

// Upload purposes a site content value may reference. Plain strings: the web app copies this file.
export const MEDIA_PURPOSES = [
  "SITE_IMAGE",
  "SITE_VIDEO",
  "STORY_IMAGE",
  "STORY_VIDEO",
  "TUTOR_VIDEO",
] as const;
export type MediaPurpose = (typeof MEDIA_PURPOSES)[number];

export const testimonialSchema = z
  .object({
    name: line(60),
    role: line(80),
    photo: image,
    quote: line(85),
    comment: words(700, 90),
    /** Optional clip that plays muted in the photo panel; the photo shows until it loads. */
    video: video.optional(),
    source: cardSourceSchema.optional(),
  })
  .meta({ id: "SiteTestimonial" });

/** A submission can appear once per list. */
function noDuplicateSources(items: { source?: CardSource }[], ctx: z.RefinementCtx) {
  const seen = new Set<string>();
  items.forEach((item, i) => {
    if (!item.source) return;
    const id = `${item.source.kind}:${item.source.id}`;
    if (seen.has(id)) {
      ctx.addIssue({
        code: "custom",
        path: [i, "source"],
        message: "This submission is already in the list",
      });
    }
    seen.add(id);
  });
}

export const testimonialsBlockSchema = z
  .object({
    enabled: z.boolean(),
    title: line(80),
    items: z.array(testimonialSchema).min(1).max(12).superRefine(noDuplicateSources),
  })
  .meta({ id: "SiteTestimonialsBlock" });

const showcaseBase = {
  name: line(60),
  subject: line(60),
  thumbnail: image,
  source: cardSourceSchema.optional(),
};

export const showcaseItemSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("video"), ...showcaseBase, video }),
    z.object({
      kind: z.literal("comment"),
      ...showcaseBase,
      university: line(100),
      comment: text(300),
    }),
  ])
  .meta({ id: "SiteShowcaseItem" });

export const showcaseBlockSchema = z
  .object({
    enabled: z.boolean(),
    title: line(80),
    items: z.array(showcaseItemSchema).min(1).max(16).superRefine(noDuplicateSources),
  })
  .meta({ id: "SiteShowcaseBlock" });

export const STEP_ICONS = ["signup", "details", "search", "documents", "discovered"] as const;

const flowSchema = z
  .object({
    label: line(30),
    video: z.object({
      title: line(60),
      subtitle: line(80),
      thumbnail: image,
      video,
    }),
    steps: z
      .array(z.object({ title: line(60), description: text(160), icon: z.enum(STEP_ICONS) }))
      .min(1)
      .max(6),
  })
  .meta({ id: "SiteHowItWorksFlow" });

export const howItWorksBlockSchema = z
  .object({ enabled: z.boolean(), title: line(80), find: flowSchema, become: flowSchema })
  .meta({ id: "SiteHowItWorksBlock" });

export const faqBlockSchema = z
  .object({
    enabled: z.boolean(),
    title: line(80),
    items: z
      .array(z.object({ question: line(160), answer: text(800) }))
      .min(1)
      .max(20),
    /** 0-based index of the question that starts open, or null for none. */
    openIndex: z.number().int().min(0).nullable(),
    cta: link,
  })
  .refine((b) => b.openIndex === null || b.openIndex < b.items.length, {
    path: ["openIndex"],
    message: "Pick a question from the list",
  })
  .meta({ id: "SiteFaqBlock" });

export const ctaBannerBlockSchema = z
  .object({ heading: line(120), text: text(300), cta: link })
  .meta({ id: "SiteCtaBannerBlock" });

export const SOCIAL_PLATFORMS = ["instagram", "telegram", "tiktok", "youtube"] as const;

export const footerBlockSchema = z
  .object({
    about: text(300),
    address: text(200),
    phone: z
      .string()
      .trim()
      .regex(/^\+?[0-9][0-9 -]{5,23}$/, "Use digits, spaces, + and - only"),
    email: z.string().trim().max(120).email("Enter a valid email"),
    columns: z.array(z.object({ heading: line(40), links: z.array(link).min(1).max(8) })).length(3),
    socials: z
      .array(z.object({ platform: z.enum(SOCIAL_PLATFORMS), href: httpsUrl }))
      .max(SOCIAL_PLATFORMS.length)
      .refine(
        (list) => new Set(list.map((s) => s.platform)).size === list.length,
        "Each platform can appear once",
      ),
    brandName: line(60),
  })
  .meta({ id: "SiteFooterBlock" });

export const seoBlockSchema = z
  .object({ title: line(70), description: text(200) })
  .meta({ id: "SiteSeoBlock" });

export const pageBlockSchema = z
  .object({ title: line(80), description: text(200), body: text(20_000) })
  .meta({ id: "SitePageBlock" });

// ── Keys ───────────────────────────────────────────────────────

export const LANDING_KEYS = [
  "hero",
  "nav",
  "categories",
  "testimonials",
  "showcase",
  "how_it_works",
  "faq",
  "cta_banner",
  "footer",
  "seo",
] as const;
export type LandingKey = (typeof LANDING_KEYS)[number];

export const PAGE_KEYS = ["about_page", "terms_page", "privacy_page", "contact_page"] as const;
export type PageKey = (typeof PAGE_KEYS)[number];

export const SITE_CONTENT_KEYS = [...LANDING_KEYS, ...PAGE_KEYS] as const;
export type SiteContentKey = (typeof SITE_CONTENT_KEYS)[number];

/** Public URL slug of each static page. */
export const PAGE_SLUGS = {
  "about-us": "about_page",
  terms: "terms_page",
  privacy: "privacy_page",
  contact: "contact_page",
} as const satisfies Record<string, PageKey>;
export type PageSlug = keyof typeof PAGE_SLUGS;

export const BLOCK_SCHEMAS = {
  hero: heroBlockSchema,
  nav: navBlockSchema,
  categories: categoriesBlockSchema,
  testimonials: testimonialsBlockSchema,
  showcase: showcaseBlockSchema,
  how_it_works: howItWorksBlockSchema,
  faq: faqBlockSchema,
  cta_banner: ctaBannerBlockSchema,
  footer: footerBlockSchema,
  seo: seoBlockSchema,
  about_page: pageBlockSchema,
  terms_page: pageBlockSchema,
  privacy_page: pageBlockSchema,
  contact_page: pageBlockSchema,
} as const satisfies Record<SiteContentKey, z.ZodType>;

export type BlockValue<K extends SiteContentKey> = z.output<(typeof BLOCK_SCHEMAS)[K]>;

// ── Requests and responses ────────────────────────────────────

export const siteContentSchema = z
  .object({
    hero: heroBlockSchema,
    nav: navBlockSchema,
    categories: categoriesBlockSchema,
    testimonials: testimonialsBlockSchema,
    showcase: showcaseBlockSchema,
    how_it_works: howItWorksBlockSchema,
    faq: faqBlockSchema,
    cta_banner: ctaBannerBlockSchema,
    footer: footerBlockSchema,
    seo: seoBlockSchema,
  })
  .meta({ id: "SiteContent" });
export type SiteContentResponse = z.infer<typeof siteContentSchema>;

export const pageSlugParamSchema = z.object({
  slug: z.enum(Object.keys(PAGE_SLUGS) as [PageSlug, ...PageSlug[]]),
});
export type PageSlugParam = z.infer<typeof pageSlugParamSchema>;

export const sitePageSchema = z
  .object({
    slug: z.string(),
    title: z.string(),
    description: z.string(),
    body: z.string(),
    updatedAt: z.date().nullable(),
  })
  .meta({ id: "SitePage" });
export type SitePageResponse = z.infer<typeof sitePageSchema>;

export const siteContentKeyParamSchema = z.object({ key: z.enum(SITE_CONTENT_KEYS) });
export type SiteContentKeyParam = z.infer<typeof siteContentKeyParamSchema>;

export const adminSiteContentItemSchema = z
  .object({
    key: z.enum(SITE_CONTENT_KEYS),
    // Shape depends on key; see the Site*Block schemas.
    value: z.unknown(),
    defaultValue: z.unknown(),
    // Each uploaded file the value uses, keyed by file id. url is null when it cannot be served.
    media: z.record(
      z.string(),
      z.object({
        url: z.string().nullable(),
        contentType: z.string(),
        originalName: z.string().nullable(),
        purpose: z.enum(MEDIA_PURPOSES),
      }),
    ),
    isDefault: z.boolean(),
    updatedAt: z.date().nullable(),
    updatedByName: z.string().nullable(),
  })
  .meta({ id: "AdminSiteContentItem" });
export type AdminSiteContentItem = z.infer<typeof adminSiteContentItemSchema>;

export const adminSiteContentListSchema = z
  .object({ items: z.array(adminSiteContentItemSchema) })
  .meta({ id: "AdminSiteContentList" });

// A submission an admin can add to a card list. Story fields are null for a video and the reverse.
const sourceMediaSchema = z.record(
  z.string(),
  z.object({
    url: z.string().nullable(),
    contentType: z.string(),
    originalName: z.string().nullable(),
    purpose: z.enum(MEDIA_PURPOSES),
  }),
);

export const adminSiteSourceSchema = z
  .object({
    source: cardSourceSchema,
    authorName: z.string(),
    role: z.enum(["STUDENT", "TUTOR"]),
    headline: z.string().nullable(),
    body: z.string().nullable(),
    title: z.string().nullable(),
    /** "file:<id>" of the photo, or null. */
    imageRef: z.string().nullable(),
    /** "file:<id>" of the clip, or null. */
    videoRef: z.string().nullable(),
    media: sourceMediaSchema,
    subjectHint: z.string().nullable(),
    instituteHint: z.string().nullable(),
    consentAt: z.date(),
    /** Already on the landing page, in a testimonials or showcase card. */
    onLanding: z.boolean(),
  })
  .meta({ id: "AdminSiteSource" });
export type AdminSiteSource = z.infer<typeof adminSiteSourceSchema>;

export const adminSiteSourceListSchema = z
  .object({ sources: z.array(adminSiteSourceSchema) })
  .meta({ id: "AdminSiteSourceList" });

export const siteSourcesQuerySchema = z.object({
  for: z.enum(["testimonials", "showcase"]),
});
export type SiteSourcesQuery = z.infer<typeof siteSourcesQuerySchema>;

export const updateSiteContentSchema = z
  .object({
    value: z.unknown(),
    // updatedAt the editor loaded, or null when it loaded the default. A mismatch is a 409.
    expectedUpdatedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .meta({ id: "UpdateSiteContent" });
export type UpdateSiteContentInput = z.infer<typeof updateSiteContentSchema>;

export const resetSiteContentQuerySchema = z.object({
  expectedUpdatedAt: z.iso.datetime({ offset: true }).optional(),
});
export type ResetSiteContentQuery = z.infer<typeof resetSiteContentQuerySchema>;
