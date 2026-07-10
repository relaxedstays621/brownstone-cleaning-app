import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { PROPERTIES } from "@/lib/properties";

// Live property picker source. Replaces the hardcoded list so new Suncadia units
// appear without a deploy. Backed by a ~weekly in-process cache over the
// Hospitable REST API, with the static list as a fail-safe so the picker never
// breaks if Hospitable is down.
export const dynamic = "force-dynamic";

const HOSPITABLE_URL = "https://public.api.hospitable.com/v2/properties";
const FETCH_TIMEOUT_MS = 10_000;
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // "once a week"
const PAGE_SAFETY_CAP = 20;

// The cleaning team services only the Suncadia (WA) set; the same Hospitable
// account also holds Florida + Whidbey homes this team never touches. City is the
// reliable discriminator (tags are opaque, `listed` is true for all).
const CLEANING_CITIES = new Set(["Cle Elum", "Ronald"]);

export interface PropertyOption {
  id: string; // Hospitable UUID — kept for later linkage; label stays the SoR for folder/sheet.
  label: string;
}

// The label is the Drive folder name + sheet Property value (see start-clean:
// `<root>/<label>/<date>/clean_<id>/`), so it must match the property's EXISTING
// Drive folder exactly — a divergent label silently creates a second folder and
// splits that property's photos. Two transforms:
//   1. Strip the leading `a - `/`b - `/`c - ` portfolio prefix + collapse whitespace.
//   2. Canonicalize the Suncadia-unit pattern to `NNNN - Suncadia Unit`. Hospitable's
//      `name` is inconsistently formatted for these ("2038 Suncadia Unit" with no
//      dash, "3023 - Suncadia unit" lowercased), but every existing Drive folder is
//      `NNNN - Suncadia Unit`. Verified 2026-07-10: this reproduces all 14 existing
//      folders exactly and leaves non-unit names (Evergreen Getaway, street
//      addresses, the "4006 & 4008" combo) untouched. Future Suncadia units get the
//      same canonical form automatically.
function normalizeLabel(name: string): string {
  const stripped = name
    .replace(/^[a-c]\s*-\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const unit = stripped.match(/^(\d{3,4})\s*-?\s*Suncadia\s+Unit$/i);
  return unit ? `${unit[1]} - Suncadia Unit` : stripped;
}

async function fetchFromHospitable(): Promise<PropertyOption[]> {
  const token = process.env.HOSPITABLE_API_TOKEN;
  if (!token) throw new Error("HOSPITABLE_API_TOKEN not set");

  const out: PropertyOption[] = [];
  let page = 1;
  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let json: {
      data?: Array<{ id?: string; name?: string; address?: { city?: string } }>;
      meta?: { last_page?: number };
    };
    try {
      const res = await fetch(`${HOSPITABLE_URL}?per_page=100&page=${page}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: controller.signal,
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`Hospitable ${res.status}`);
      json = await res.json();
    } finally {
      clearTimeout(timer);
    }

    const rows = Array.isArray(json?.data) ? json.data : [];
    for (const r of rows) {
      if (r?.address?.city && CLEANING_CITIES.has(r.address.city)) {
        const label = normalizeLabel(String(r.name ?? ""));
        if (label) out.push({ id: String(r.id ?? ""), label });
      }
    }

    const lastPage = Number(json?.meta?.last_page ?? page);
    if (!Number.isFinite(lastPage) || page >= lastPage || page >= PAGE_SAFETY_CAP) break;
    page++;
  }

  // An empty result means the shape/filter broke (e.g. Hospitable renamed cities).
  // Treat as an error so we serve the static list instead of an empty picker.
  if (out.length === 0) {
    throw new Error("Hospitable returned no Cle Elum/Ronald properties");
  }
  return out;
}

interface CacheEntry {
  items: PropertyOption[];
  fetchedAt: number;
}
let cache: CacheEntry | null = null;
let refreshing = false;

async function refresh(): Promise<PropertyOption[]> {
  const items = await fetchFromHospitable();
  cache = { items, fetchedAt: Date.now() };
  return items;
}

const STATIC_FALLBACK: PropertyOption[] = PROPERTIES.map((label) => ({ id: "", label }));

function respond(
  properties: PropertyOption[],
  source: string,
  fetchedAt?: number
) {
  return NextResponse.json({ properties, source, fetchedAt: fetchedAt ?? null });
}

export async function GET(req: NextRequest) {
  // Property names are operational data — the picker is authenticated UI, so this
  // route requires the same session as every other app API. (Health/monitoring
  // has its own unauthenticated route; this is not it.)
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const force = new URL(req.url).searchParams.get("refresh") === "1";
  const now = Date.now();

  // Fresh cache — serve as-is.
  if (!force && cache && now - cache.fetchedAt < TTL_MS) {
    return respond(cache.items, "cache", cache.fetchedAt);
  }

  // Stale cache — serve stale immediately, refresh in the background (single-flight).
  if (!force && cache) {
    if (!refreshing) {
      refreshing = true;
      void refresh()
        .catch((err) => console.error("[api/properties] background refresh failed:", err))
        .finally(() => {
          refreshing = false;
        });
    }
    return respond(cache.items, "stale", cache.fetchedAt);
  }

  // No cache yet, or a forced refresh — fetch synchronously, degrade gracefully.
  try {
    const items = await refresh();
    return respond(items, "hospitable", cache?.fetchedAt);
  } catch (err) {
    console.error("[api/properties] falling back:", err);
    if (cache) return respond(cache.items, "stale-error", cache.fetchedAt);
    return respond(STATIC_FALLBACK, "static");
  }
}
