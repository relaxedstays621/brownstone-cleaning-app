// Static fallback for the property picker. The live source is /api/properties
// (a weekly Hospitable pull); this list is served only when Hospitable is
// unreachable. Each label is ALSO the Drive folder name + sheet Property value, so
// every entry must match that property's EXISTING Drive folder exactly (verified
// against `matt@brownstonevacations.com` My Drive 2026-07-10) — a divergent label
// silently creates a second folder and splits the property's photos. These are the
// canonical forms `/api/properties`' normalizeLabel() produces from Hospitable's
// (inconsistently-formatted) `name`; keep the two in lockstep.
export const PROPERTIES = [
  "4006 - Suncadia Unit",
  "4008 - Suncadia Unit",
  "4006 & 4008 - Suncadia Unit",
  "5036 - Suncadia Unit",
  "2068 - Suncadia Unit",
  "Evergreen Getaway",
  "4070 - Suncadia Unit",
  "3022 - Suncadia Unit",
  "3023 - Suncadia Unit",
  "2038 - Suncadia Unit",
  "5058 - Suncadia Unit",
  "3033 - Suncadia Unit",
  "4038 - Suncadia Unit",
  "6052 - Suncadia Unit",
  "5040 - Suncadia Unit",
  "100 Black Nugget Ln",
  "1170 Airport Road",
  "127 Big Hill",
  // Heather's maintenance property (team defaultProperty). Hospitable name is
  // "b - Whidbey Island Retreat" (Oak Harbor) — this is its normalizeLabel()
  // canonical form. No Drive folder existed before team logins; the first
  // start-clean creates it under this exact name, which becomes the SoR.
  "Whidbey Island Retreat",
  // Second Whidbey-area team property (team `properties` include). Hospitable
  // name is "b - Beachview Retreat" (Clinton) — this is its normalizeLabel()
  // canonical form. Like Whidbey Island Retreat above, no Drive folder exists
  // until the first start-clean creates it under this exact name (the SoR).
  "Beachview Retreat",
] as const;

export type Property = (typeof PROPERTIES)[number];
