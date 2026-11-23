// The widget catalog. Order here is the default dashboard order; defaultOn picks the defaults.
// Adding a widget: add it here, add its compute function in dashboard-widgets.ts (or -funnel.ts).

export const WIDGET_IDS = [
  "bottleneck",
  "queues",
  "mau",
  "signups",
  "collected",
  "placements",
  "signups-trend",
  "revenue-trend",
  "fill-rate",
  "time-to-hire",
  "collection-rate",
  "overdue-fees",
  "payment-health",
  "trust-cases",
  "activity-trend",
] as const;

type Id = (typeof WIDGET_IDS)[number];

export type CatalogItem = {
  id: Id;
  title: string;
  description: string;
  definition: string;
  group: "pipeline" | "people" | "money" | "operations" | "trust";
  kind: "kpi" | "series" | "funnel" | "queue" | "donut";
  span: 3 | 6 | 12;
  keywords: string[];
  href: string | null;
  defaultOn: boolean;
};

export const CATALOG: readonly CatalogItem[] = [
  {
    id: "bottleneck",
    title: "Where it's stuck",
    description: "Each step from sign-up to a paid placement, and where people drop off.",
    definition:
      "Cohorts that entered in the selected range. Conversion is the share of people who reached the steps it depends on, and wait is the median days from the last of them. That is the step before, except three: a tutor's first application and a student's hire count from sign-up (no ID check or posted requirement is needed), and a tutor's first placement counts from their first application. A step is flagged when, over the last 30 days against the 30 before, conversion fell 5 points or more or the wait grew 25% or more, with at least 30 people in both periods. Only people old enough to have had a chance count toward a flag. Waived fees count as settled; void fees are left out.",
    group: "pipeline",
    kind: "funnel",
    span: 12,
    keywords: ["bottleneck", "funnel", "stuck", "drop-off", "conversion", "pipeline", "placement"],
    href: null,
    defaultOn: true,
  },
  {
    id: "queues",
    title: "Needs attention",
    description: "Work waiting on an admin, oldest first.",
    definition:
      "Items waiting for an admin right now. Late means the oldest item has waited past its target time; watch means it is past half of it.",
    group: "operations",
    kind: "queue",
    span: 12,
    keywords: ["queue", "backlog", "pending", "review", "attention", "sla", "todo"],
    href: null,
    defaultOn: true,
  },
  {
    id: "mau",
    title: "Monthly active users",
    description: "Students and tutors who used the app in the last 30 days.",
    definition:
      "Accounts (not admins) that signed in or kept a session alive on any day in the last 30 days, whatever range is selected. History starts with the oldest session still stored. Blocked and deactivated accounts are left out.",
    group: "people",
    kind: "kpi",
    span: 3,
    keywords: ["mau", "active", "users", "engagement", "monthly"],
    href: "/dashboard/admin/accounts",
    defaultOn: true,
  },
  {
    id: "signups",
    title: "Sign-ups",
    description: "New student and tutor accounts.",
    definition: "Student and tutor accounts created in the range, deactivated ones included.",
    group: "people",
    kind: "kpi",
    span: 3,
    keywords: ["signups", "registrations", "new users", "growth", "accounts"],
    href: "/dashboard/admin/accounts",
    defaultOn: true,
  },
  {
    id: "collected",
    title: "Fees collected",
    description: "Placement fees received, after refunds.",
    definition:
      "Fee payments received in the range (online and cash) minus reversals in the range. A completed refund is recorded as a reversal. The SSLCommerz processing charge is not included.",
    group: "money",
    kind: "kpi",
    span: 3,
    keywords: ["revenue", "payments", "collected", "money", "fees", "income", "monthly payments"],
    href: "/dashboard/admin/fees",
    defaultOn: true,
  },
  {
    id: "placements",
    title: "Placements",
    description: "Tutors hired, from requirements and packages.",
    definition: "Applications confirmed in the range, from requirements and from package requests.",
    group: "pipeline",
    kind: "kpi",
    span: 3,
    keywords: ["placements", "hires", "matches", "confirmed"],
    href: "/dashboard/admin/applications",
    defaultOn: true,
  },
  {
    id: "signups-trend",
    title: "Sign-ups over time",
    description: "New students and tutors per day or month.",
    definition: "Student and tutor accounts created per Dhaka day (per month for 12 months).",
    group: "people",
    kind: "series",
    span: 6,
    keywords: ["signups", "growth", "trend", "registrations", "chart"],
    href: "/dashboard/admin/accounts",
    defaultOn: true,
  },
  {
    id: "revenue-trend",
    title: "Fees over time",
    description: "Fees collected and refunded per day or month.",
    definition:
      "Fee payments received and reversals (refunds included) per Dhaka day (per month for 12 months). Processing charges are not included.",
    group: "money",
    kind: "series",
    span: 6,
    keywords: ["revenue", "payments", "refunds", "money", "trend", "chart", "monthly payments"],
    href: "/dashboard/admin/payments",
    defaultOn: true,
  },
  {
    id: "fill-rate",
    title: "Fill rate",
    description: "Share of requirements that hired a tutor.",
    definition:
      "Requirements posted in the range (drafts excluded) that have a confirmed application so far. Recent requirements may still fill.",
    group: "pipeline",
    kind: "kpi",
    span: 3,
    keywords: ["fill rate", "hired", "requirements", "conversion", "liquidity"],
    href: "/dashboard/admin/matching",
    defaultOn: false,
  },
  {
    id: "time-to-hire",
    title: "Time to hire",
    description: "Days from posting a requirement to hiring a tutor.",
    definition:
      "Median days from posting to the confirmed application, for hires confirmed in the range.",
    group: "pipeline",
    kind: "kpi",
    span: 3,
    keywords: ["time to hire", "speed", "days", "wait", "latency"],
    href: "/dashboard/admin/matching",
    defaultOn: false,
  },
  {
    id: "collection-rate",
    title: "Collection rate",
    description: "Share of fees raised in the range that are paid.",
    definition:
      "Amount paid over amount due, for fees created in the range. Waived and void fees are left out.",
    group: "money",
    kind: "kpi",
    span: 3,
    keywords: ["collection", "paid", "take rate", "fees", "money"],
    href: "/dashboard/admin/fees",
    defaultOn: false,
  },
  {
    id: "overdue-fees",
    title: "Overdue fees",
    description: "Unpaid fees past their due date, by age.",
    definition:
      "Amount still owed on fees that are due or part paid and past their due date now, grouped by days overdue. The range does not apply.",
    group: "money",
    kind: "donut",
    span: 6,
    keywords: ["overdue", "unpaid", "debt", "fees", "late", "ageing"],
    href: "/dashboard/admin/fees",
    defaultOn: false,
  },
  {
    id: "payment-health",
    title: "Online payment results",
    description: "How SSLCommerz payment attempts ended.",
    definition:
      "Online payment attempts started in the range, by result. Success rate is succeeded over all attempts that finished.",
    group: "money",
    kind: "donut",
    span: 6,
    keywords: ["payments", "gateway", "sslcommerz", "failed", "success rate", "checkout"],
    href: "/dashboard/admin/payments",
    defaultOn: false,
  },
  {
    id: "trust-cases",
    title: "Reports and disputes",
    description: "Cases opened and closed per day or month.",
    definition:
      "Reports and disputes opened, and closed (resolved or dismissed), per Dhaka day (per month for 12 months).",
    group: "trust",
    kind: "series",
    span: 6,
    keywords: ["reports", "disputes", "trust", "safety", "cases", "complaints"],
    href: "/dashboard/admin/reports",
    defaultOn: false,
  },
  {
    id: "activity-trend",
    title: "Daily active users",
    description: "Students and tutors active each day.",
    definition:
      "Accounts (not admins) that signed in or kept a session alive each Dhaka day (monthly actives for 12 months). Blocked and deactivated accounts are left out.",
    group: "people",
    kind: "series",
    span: 6,
    keywords: ["dau", "active", "daily", "engagement", "usage", "trend"],
    href: "/dashboard/admin/accounts",
    defaultOn: false,
  },
];

export const DEFAULT_WIDGETS: Id[] = CATALOG.filter((item) => item.defaultOn).map(
  (item) => item.id,
);
