// Team registry for password-only logins. The login form has no username field —
// WHICH password was typed is the identity. CLEANING_TEAMS (JSON in .env) maps
// each password to a canonical team name; that name (never the password) is what
// lands in the sheet's "Cleaned By" / "Submitted By" columns.
//
// CLEANING_TEAMS='[{"name":"Nova","password":"..."},
//                  {"name":"Heather","password":"...","defaultProperty":"Whidbey Island Retreat"},
//                  {"name":"...","password":"...","properties":["Beachview Retreat","Whidbey Island Retreat"]}]'
//
// The legacy shared CLEANING_APP_PASSWORD keeps working during rollout, mapping
// to name "" (blank Cleaned By — same behavior as before teams existed). Remove
// it from .env once both teams have logged in with their own password.

export interface CleaningTeam {
  name: string;
  password: string;
  // Canonical picker label (post-normalizeLabel, e.g. "Whidbey Island Retreat",
  // NOT Hospitable's "b - " prefixed name). Pre-selected in the property picker
  // and force-included in /api/properties even outside the cleaning-cities filter.
  defaultProperty?: string;
  // Additional canonical picker labels force-included in /api/properties (same
  // rules as defaultProperty) but NOT pre-selected — for teams that work a fixed
  // set of properties outside the cleaning-cities filter (e.g. the Whidbey pair
  // "Beachview Retreat" + "Whidbey Island Retreat").
  properties?: string[];
}

let cached: CleaningTeam[] | null = null;

// Parses + validates CLEANING_TEAMS once per process. THROWS on malformed config
// or duplicate passwords/names — the password IS the identity, so a duplicate
// would silently attribute one team's work to another. A throw surfaces as a
// loud 500 at login instead.
export function getTeams(): CleaningTeam[] {
  if (cached) return cached;
  const raw = process.env.CLEANING_TEAMS;
  if (!raw) {
    cached = [];
    return cached;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("CLEANING_TEAMS is not valid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("CLEANING_TEAMS must be a JSON array");
  const teams: CleaningTeam[] = parsed.map((t, i) => {
    const entry = t as Partial<CleaningTeam> | null;
    if (!entry || typeof entry.name !== "string" || !entry.name.trim()) {
      throw new Error(`CLEANING_TEAMS[${i}]: missing name`);
    }
    if (typeof entry.password !== "string" || !entry.password) {
      throw new Error(`CLEANING_TEAMS[${i}] (${entry.name}): missing password`);
    }
    if (
      entry.properties !== undefined &&
      (!Array.isArray(entry.properties) ||
        entry.properties.some((p) => typeof p !== "string" || !p.trim()))
    ) {
      throw new Error(
        `CLEANING_TEAMS[${i}] (${entry.name}): properties must be an array of non-empty strings`
      );
    }
    const properties = Array.from(new Set((entry.properties ?? []).map((p) => p.trim())));
    return {
      name: entry.name.trim(),
      password: entry.password,
      ...(typeof entry.defaultProperty === "string" && entry.defaultProperty.trim()
        ? { defaultProperty: entry.defaultProperty.trim() }
        : {}),
      ...(properties.length ? { properties } : {}),
    };
  });
  const passwords = new Set(teams.map((t) => t.password));
  if (passwords.size !== teams.length) {
    throw new Error("CLEANING_TEAMS: duplicate passwords — the password is the identity");
  }
  const names = new Set(teams.map((t) => t.name));
  if (names.size !== teams.length) {
    throw new Error("CLEANING_TEAMS: duplicate team names");
  }
  if (teams.some((t) => t.password === process.env.CLEANING_APP_PASSWORD)) {
    throw new Error("CLEANING_TEAMS: a team password collides with legacy CLEANING_APP_PASSWORD");
  }
  cached = teams;
  return teams;
}

// Password → team, or null for no match. The legacy shared password maps to the
// anonymous team (name "") during the rollout window.
export function findTeamByPassword(password: string): CleaningTeam | null {
  const team = getTeams().find((t) => t.password === password);
  if (team) return team;
  const legacy = process.env.CLEANING_APP_PASSWORD;
  if (legacy && password === legacy) return { name: "", password };
  return null;
}

export function findTeamByName(name: string): CleaningTeam | null {
  if (!name) return null;
  return getTeams().find((t) => t.name === name) ?? null;
}

// All team property labels (defaultProperty + properties) for /api/properties'
// include-filter. Swallows config errors on purpose — the picker must never
// break on a bad env edit.
export function teamPropertyLabels(): string[] {
  try {
    return getTeams().flatMap((t) => [
      ...(t.defaultProperty ? [t.defaultProperty] : []),
      ...(t.properties ?? []),
    ]);
  } catch {
    return [];
  }
}
