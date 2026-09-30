#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# scripts/db/verify.sh — prove every migration on a throwaway, Supabase-shaped Postgres 16
# (blueprint §15.1, BUILD_SPEC §8).
#
#   1. stops and wipes any previous cluster in $PG_WORK_DIR, then initdb (C locale, UTF8)
#   2. starts it on 127.0.0.1:$PG_PORT — TCP only (unix socket paths are too long here)
#   3. creates the database, loads supabase/tests/harness.sql (roles, auth, default privileges)
#   4. applies supabase/migrations/*.sql in sorted order, then ALL OF THEM A SECOND TIME
#      (idempotency is a law: P11)
#   5. runs every supabase/tests/*.test.sql (sorted) — each in its OWN fresh copy of the
#      migrated database (CREATE DATABASE … TEMPLATE), so test files never see each other's
#      fixtures — counting `PASS:` notices and stopping a file at its first error
#   6. prints a summary and stops the cluster (unless --keep)
#
# Usage:  PG_PORT=55431 PG_WORK_DIR=/some/short/dir scripts/db/verify.sh [--keep]
#   PG_PORT      TCP port (default 55431; see BUILD_SPEC §8 for the per-agent ports)
#   PG_WORK_DIR  cluster + logs (default ${TMPDIR:-/tmp}/dockone-pg-$PG_PORT)
#   PG_BIN       Postgres 16 binaries (default /opt/homebrew/opt/postgresql@16/bin)
#   --keep       leave the cluster (and the per-test databases) running; prints psql commands
#   VERIFY_ONLY  optional partial chain while other agents are mid-edit, e.g. VERIFY_ONLY="01-11 30 23":
#                applies/tests only those migration numbers (ranges allowed) and skips the
#                full-chain tests (98_*, 99_*). A hand-off still needs a FULL run.
# Exit status: 0 only when every migration applied twice and every test file passed.
# ═════════════════════════════════════════════════════════════════════════════
set -Eeuo pipefail
# NOTE: written for the bash 3.2 that macOS ships — empty arrays are expanded as
# ${arr[@]+"${arr[@]}"} because `set -u` treats "${arr[@]}" of an empty array as unbound there.

PG_PORT="${PG_PORT:-55431}"
PG_WORK_DIR="${PG_WORK_DIR:-${TMPDIR:-/tmp}/dockone-pg-$PG_PORT}"
PG_BIN="${PG_BIN:-/opt/homebrew/opt/postgresql@16/bin}"
export LANG=C LC_ALL=C

KEEP=0
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "verify.sh: unknown argument '$arg' (only --keep is supported)" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIG_DIR="$ROOT/supabase/migrations"
TEST_DIR="$ROOT/supabase/tests"
HARNESS="$TEST_DIR/harness.sql"
PG_WORK_DIR="${PG_WORK_DIR%/}"
DATA="$PG_WORK_DIR/data"
LOGS="$PG_WORK_DIR/logs"
DB="dockone"

die() { echo "verify.sh: $*" >&2; exit 2; }

[[ "$PG_PORT" =~ ^[0-9]{2,5}$ ]] || die "PG_PORT must be a number (got '$PG_PORT')"
[[ -n "$PG_WORK_DIR" && "$PG_WORK_DIR" != "/" && "$PG_WORK_DIR" != "$HOME" && "$PG_WORK_DIR" != "$ROOT"* ]] \
  || die "refusing to use PG_WORK_DIR='$PG_WORK_DIR' (must be a scratch directory outside the repo)"
for bin in initdb pg_ctl psql createdb pg_isready; do
  [[ -x "$PG_BIN/$bin" ]] || die "$PG_BIN/$bin not found — set PG_BIN to a Postgres 16 bin directory"
done
[[ -f "$HARNESS" ]] || die "missing $HARNESS"

PSQL=("$PG_BIN/psql" -X -h 127.0.0.1 -p "$PG_PORT" -U postgres)

stop_cluster() {
  if [[ -f "$DATA/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA" -m fast -w -t 30 stop >/dev/null 2>&1 \
      || "$PG_BIN/pg_ctl" -D "$DATA" -m immediate -w -t 30 stop >/dev/null 2>&1 || true
  fi
}

on_exit() {
  local status=$?
  if [[ $KEEP -eq 1 && -f "$DATA/postmaster.pid" ]]; then
    echo
    echo "--keep: cluster left running on 127.0.0.1:$PG_PORT (data $DATA)"
    echo "  connect:  ${PG_BIN}/psql -h 127.0.0.1 -p $PG_PORT -U postgres -d $DB"
    echo "  stop:     ${PG_BIN}/pg_ctl -D $DATA -m fast stop"
  else
    stop_cluster
  fi
  exit "$status"
}

# ── 1. fresh cluster ─────────────────────────────────────────────────────────
stop_cluster
rm -rf -- "$DATA" "$LOGS"
mkdir -p "$DATA" "$LOGS"
chmod 700 "$DATA"

set +e
"$PG_BIN/pg_isready" -q -h 127.0.0.1 -p "$PG_PORT" >/dev/null 2>&1
ready=$?
set -e
if [[ $ready -eq 0 || $ready -eq 1 ]]; then
  die "something is already listening on 127.0.0.1:$PG_PORT (another agent's cluster?) — pick another PG_PORT"
fi

echo "== Dock One SQL verify — Postgres at 127.0.0.1:$PG_PORT, work dir $PG_WORK_DIR"
"$PG_BIN/initdb" -D "$DATA" --locale=C -E UTF8 -U postgres -A trust >"$LOGS/initdb.log" 2>&1 \
  || { cat "$LOGS/initdb.log" >&2; die "initdb failed"; }

trap on_exit EXIT
"$PG_BIN/pg_ctl" -D "$DATA" -l "$LOGS/postgres.log" -w -t 60 \
  -o "-p $PG_PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=40" \
  start >"$LOGS/pg_ctl.log" 2>&1 \
  || { tail -n 30 "$LOGS/postgres.log" >&2 2>/dev/null; die "could not start Postgres (see $LOGS/postgres.log)"; }

"$PG_BIN/createdb" -h 127.0.0.1 -p "$PG_PORT" -U postgres "$DB"

# ── 2. harness ───────────────────────────────────────────────────────────────
if ! PGOPTIONS="-c client_min_messages=warning" "${PSQL[@]}" -d "$DB" -v ON_ERROR_STOP=1 -q -f "$HARNESS" \
      >"$LOGS/harness.log" 2>&1; then
  cat "$LOGS/harness.log" >&2
  echo "== RESULT: harness failed to load" >&2
  exit 1
fi

# ── 3. migrations, twice ─────────────────────────────────────────────────────
shopt -s nullglob
migrations=("$MIG_DIR"/*.sql)
tests=()
for t in "$TEST_DIR"/*.test.sql; do tests+=("$t"); done
shopt -u nullglob

in_only() {  # $1 = numeric prefix of a file; true when VERIFY_ONLY selects it
  local n tok lo hi
  n=$((10#$1))
  for tok in $VERIFY_ONLY; do
    if [[ "$tok" == *-* ]]; then
      lo=$((10#${tok%-*})); hi=$((10#${tok#*-}))
      if (( n >= lo && n <= hi )); then return 0; fi
    elif [[ "$tok" =~ ^[0-9]+$ ]]; then
      if (( n == 10#$tok )); then return 0; fi
    fi
  done
  return 1
}
if [[ -n "${VERIFY_ONLY:-}" ]]; then
  kept=()
  for f in ${migrations[@]+"${migrations[@]}"}; do
    b="$(basename "$f")"; num="${b%%_*}"
    if [[ "$num" =~ ^[0-9]+$ ]] && in_only "$num"; then kept+=("$f"); fi
  done
  migrations=(${kept[@]+"${kept[@]}"})
  kept=()
  for t in ${tests[@]+"${tests[@]}"}; do
    b="$(basename "$t")"; num="${b%%_*}"
    if [[ "$num" =~ ^[0-9]+$ ]] && (( 10#$num < 98 )) && in_only "$num"; then kept+=("$t"); fi
  done
  tests=(${kept[@]+"${kept[@]}"})
  echo "   note  PARTIAL chain (VERIFY_ONLY='$VERIFY_ONLY'): ${#migrations[@]} migration(s); full-chain tests 98/99 skipped"
fi

mig_failed=""
for pass in 1 2; do
  for f in ${migrations[@]+"${migrations[@]}"}; do
    name="$(basename "$f")"
    log="$LOGS/migrate.pass$pass.$name.log"
    if ! PGOPTIONS="-c client_min_messages=warning" "${PSQL[@]}" -d "$DB" -v ON_ERROR_STOP=1 -q -f "$f" >"$log" 2>&1; then
      mig_failed="$name (pass $pass)"
      echo "   FAIL  migration $name on pass $pass:"
      grep -m1 -A6 'ERROR:' "$log" | sed 's/^/         /' || tail -n 12 "$log" | sed 's/^/         /'
      break 2
    fi
    if [[ $pass -eq 1 ]] && grep -q 'WARNING:' "$log"; then
      grep 'WARNING:' "$log" | sed "s/^/   note  $name: /"
    fi
  done
done

if [[ -n "$mig_failed" ]]; then
  echo "== RESULT: migrations FAILED at $mig_failed — tests not run (logs: $LOGS)"
  exit 1
fi
echo "   ok    ${#migrations[@]} migration file(s) applied x2 (idempotent)"

# ── 4. tests, each in its own copy of the migrated database ──────────────────
passed=0
failed=0
checks=0
failures=()
if [[ ${#tests[@]} -eq 0 ]]; then
  echo "   note  no supabase/tests/*.test.sql files found"
fi
i=0
for t in ${tests[@]+"${tests[@]}"}; do
  i=$((i + 1))
  name="$(basename "$t")"
  tdb="t$(printf '%02d' "$i")_$(echo "${name%.test.sql}" | tr -c 'a-zA-Z0-9_\n' '_' | cut -c1-40)"
  log="$LOGS/test.$name.log"
  "${PSQL[@]}" -d postgres -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS \"$tdb\"" -c "CREATE DATABASE \"$tdb\" TEMPLATE \"$DB\"" \
    >"$LOGS/clone.$name.log" 2>&1 || { cat "$LOGS/clone.$name.log" >&2; die "could not clone the migrated database for $name"; }
  set +e
  "${PSQL[@]}" -d "$tdb" -v ON_ERROR_STOP=1 -q -f "$t" >"$log" 2>&1
  status=$?
  set -e
  n=$(grep -c 'PASS:' "$log" || true)
  checks=$((checks + n))
  if [[ $status -eq 0 ]]; then
    passed=$((passed + 1))
    printf '   PASS  %-44s %3d check(s)\n' "$name" "$n"
  else
    failed=$((failed + 1))
    msg="$(grep -m1 -E 'ERROR:|FATAL:' "$log" | sed -E 's/^psql:[^ ]+: //' || true)"
    [[ -n "$msg" ]] || msg="$(tail -n 3 "$log" | tr '\n' ' ')"
    printf '   FAIL  %-44s %3d check(s) passed before: %s\n' "$name" "$n" "$msg"
    ctx="$(grep -m1 -A4 -E 'ERROR:|FATAL:' "$log" | tail -n +2 | grep -E 'CONTEXT|LINE|DETAIL|HINT|PL/pgSQL' | head -n 3 || true)"
    [[ -n "$ctx" ]] && echo "$ctx" | sed 's/^/         /'
    failures+=("$name")
  fi
  if [[ $KEEP -eq 0 ]]; then
    "${PSQL[@]}" -d postgres -q -c "DROP DATABASE IF EXISTS \"$tdb\"" >/dev/null 2>&1 || true
  fi
done

echo "== RESULT: migrations ${#migrations[@]} file(s) applied x2 OK; tests ${passed} passed, ${failed} failed (${checks} checks passed); logs in $LOGS"
if [[ $failed -gt 0 ]]; then
  echo "   failing: ${failures[*]+"${failures[*]}"}"
  exit 1
fi
exit 0
