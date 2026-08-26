#!/usr/bin/env bash
# Operator setter for a new cleaning-team login (docs/team-logins.md).
# Prompts for name + password interactively (password never echoes, never lands
# in shell history or chat — the standing secrets convention) and appends the
# entry to CLEANING_TEAMS in .env. Run from anywhere:
#   bash scripts/add-cleaning-team.sh
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo ".env not found — run from the app checkout" >&2; exit 1; }

read -rp "Team/cleaner name (lands in sheet 'Cleaned By'): " NAME
read -rp "Force-included picker properties, comma-separated canonical labels (e.g. 'Beachview Retreat, Whidbey Island Retreat'; empty = none): " PROPS
read -rp "Pre-selected default property (one canonical label; empty = none): " DEFAULT
read -rsp "Password: " PW; echo
read -rsp "Password (again): " PW2; echo
[ "$PW" = "$PW2" ] || { echo "Passwords do not match" >&2; exit 1; }
[ -n "$NAME" ] && [ -n "$PW" ] || { echo "Name and password are required" >&2; exit 1; }
case $PW in *"'"*) echo "Password may not contain a single quote (') — it would break the .env quoting" >&2; exit 1;; esac

cp .env ".env.bak.$(date +%Y%m%d%H%M%S)"

NAME="$NAME" PROPS="$PROPS" DEFAULT="$DEFAULT" PW="$PW" python3 - <<'PY'
import json, os, sys

path = ".env"
lines = open(path).read().splitlines(keepends=True)
idx = next((i for i, l in enumerate(lines) if l.startswith("CLEANING_TEAMS=")), None)
if idx is None:
    sys.exit("CLEANING_TEAMS not found in .env")
raw = lines[idx].rstrip("\n").split("=", 1)[1]
if raw.startswith("'") and raw.endswith("'"):
    raw = raw[1:-1]
teams = json.loads(raw)

name = os.environ["NAME"].strip()
pw = os.environ["PW"]
props = [p.strip() for p in os.environ["PROPS"].split(",") if p.strip()]
default = os.environ["DEFAULT"].strip()

if any(t.get("name") == name for t in teams):
    sys.exit(f"Team {name!r} already exists — edit CLEANING_TEAMS in .env by hand to change it")
if any(t.get("password") == pw for t in teams):
    sys.exit("That password is already used by another team — the password IS the identity")

entry = {"name": name, "password": pw}
if default:
    entry["defaultProperty"] = default
if props:
    entry["properties"] = props
teams.append(entry)

out = json.dumps(teams, separators=(",", ":"))
if "'" in out:
    sys.exit("Resulting JSON contains a single quote — refusing to write a broken .env line")
lines[idx] = "CLEANING_TEAMS='" + out + "'\n"
open(path, "w").writelines(lines)
print(f"Added team {name!r}" + (f" with properties {props}" if props else "") + (f", default {default!r}" if default else ""))
PY

echo
echo "Done (.env backed up alongside). Restart the app to pick up the change:"
echo "  docker compose up -d --force-recreate app"
