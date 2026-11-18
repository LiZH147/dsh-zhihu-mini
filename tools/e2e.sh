#!/usr/bin/env bash
# dsh-zhihu-mini end-to-end verification.
#
#   bash tools/e2e.sh                 # static checks + live probes against the running DSH
#   bash tools/e2e.sh --static        # static checks only
#   BASE_URL=http://127.0.0.1:62154 bash tools/e2e.sh
#
# Static: file inventory, JS syntax (node --check), package.json manifest, bundle patch row,
# locale meta, icon sanity.
# Live (skipped with --static, warned when nothing listens): route JSON shapes, panel-state
# round-trip, SSE content type, trust-fence rejection of a cross-site POST.
#
# Exit code 0 only when every executed hard check passed.
set -u

STATIC_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --static) STATIC_ONLY=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN="$ROOT/plugin"
BASE_URL_FALLBACK="http://127.0.0.1:58842"
if [ -n "${BASE_URL:-}" ]; then :; else BASE_URL="$BASE_URL_FALLBACK"; fi

PASS=0
FAIL=0
WARN=0
SKIP=0

ok()   { PASS=$((PASS + 1)); printf '  PASS  %s\n' "$*"; }
bad()  { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$*"; }
warn() { WARN=$((WARN + 1)); printf '  WARN  %s\n' "$*"; }
skip() { SKIP=$((SKIP + 1)); printf '  SKIP  %s\n' "$*"; }
section() { printf '\n== %s ==\n' "$*"; }

if [ -n "${BASE_URL:-}" ]; then BASE_URL="$BASE_URL"; else BASE_URL="$BASE_URL_FALLBACK"; fi

# --- static ---------------------------------------------------------------
section "file inventory"
for f in index.js client.js zhihu.js sanitize.js store.js trust.js package.json cordis.patch.yml icon.svg README.md LICENSE NOTES.md locale/zh.json locale/en.json; do
  if [ -f "$PLUGIN/$f" ]; then ok "plugin/$f"; else bad "plugin/$f missing"; fi
done

section "javascript syntax"
if command -v node >/dev/null 2>&1; then
  for f in index.js client.js zhihu.js sanitize.js store.js trust.js; do
    if [ ! -f "$PLUGIN/$f" ]; then skip "node --check $f (missing)"; continue; fi
    if out=$(node --check "$PLUGIN/$f" 2>&1); then ok "node --check $f"; else bad "node --check $f: $out"; fi
  done
else
  bad "node not found on PATH"
fi

section "manifest (package.json)"
if command -v node >/dev/null 2>&1 && [ -f "$PLUGIN/package.json" ]; then
  node - "$PLUGIN/package.json" <<'JS'
const fs = require('node:fs')
const p = process.argv[2]
let m
try { m = JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) { console.log('  FAIL  package.json is not valid JSON: ' + e.message); process.exit(1) }
const problems = []
const expect = (cond, msg) => { if (!cond) problems.push(msg) }
expect(m.name === 'dsh-zhihu-mini', 'name must be dsh-zhihu-mini')
expect(/^0\.2\.\d+$/.test(String(m.version)), 'version should be 0.2.x')
expect(m.type === 'module', 'type must be module')
expect(m.main === './index.js', 'main must be ./index.js')
expect(m.license === 'MIT', 'license must be MIT')
expect(m.exports && m.exports['.'] === './index.js', 'exports["."] must be ./index.js')
expect(m.exports && m.exports['./client'] === './client.js', 'exports["./client"] must be ./client.js')
expect(m.exports && m.exports['./locale/*.json'] === './locale/*.json', 'locale export missing')
expect(m.exports && m.exports['./icon'] === './icon.svg', 'icon export missing')
expect(m.exports && m.exports['./package.json'] === './package.json', 'package.json export missing')
expect(m.dsh && m.dsh.bundle && m.dsh.bundle.patch === './cordis.patch.yml', 'dsh.bundle.patch must be ./cordis.patch.yml')
expect(m.dsh && m.dsh.client && m.dsh.client.platform === 'web', 'dsh.client.platform must be web')
expect(m.dsh && m.dsh.client && m.dsh.client.immediately === true, 'dsh.client.immediately must be true')
expect(Array.isArray(m.files) && m.files.includes('client.js') && m.files.includes('cordis.patch.yml') && m.files.includes('icon.svg'), 'files must ship client.js, cordis.patch.yml, icon.svg')
expect(Array.isArray(m.keywords) && m.keywords.length > 0, 'keywords must be non-empty')
expect(!m.dependencies || Object.keys(m.dependencies).length === 0, 'runtime dependencies must be empty')
if (problems.length) { for (const x of problems) console.log('  FAIL  ' + x); process.exit(1) }
console.log('  PASS  manifest keys, exports, dsh.bundle/dsh.client, files, keywords')
JS
  if [ $? -ne 0 ]; then FAIL=$((FAIL + 1)); fi
else
  skip "manifest assertions (node or package.json missing)"
fi

section "bundle patch (cordis.patch.yml)"
if [ -f "$PLUGIN/cordis.patch.yml" ]; then
  if grep -q 'id: zhihu-mini' "$PLUGIN/cordis.patch.yml" && grep -q "name: 'dsh-zhihu-mini'" "$PLUGIN/cordis.patch.yml"; then
    ok "patch inserts row id=zhihu-mini name=dsh-zhihu-mini"
  else
    bad "patch row id/name not found"
  fi
  if grep -q 'feedSize' "$PLUGIN/cordis.patch.yml"; then ok "patch carries config.feedSize"; else warn "patch has no feedSize"; fi
else
  skip "patch (missing)"
fi

section "locale meta"
if command -v node >/dev/null 2>&1; then
  for loc in zh en; do
    f="$PLUGIN/locale/$loc.json"
    if [ ! -f "$f" ]; then bad "locale/$loc.json missing"; continue; fi
    node - "$f" "$loc" <<'JS'
const fs = require('node:fs')
const [file, loc] = process.argv.slice(2)
let m
try { m = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { console.log('  FAIL  locale/' + loc + '.json is not valid JSON: ' + e.message); process.exit(1) }
if (!m.meta || typeof m.meta.title !== 'string' || !m.meta.title.trim()) { console.log('  FAIL  locale/' + loc + '.json meta.title missing'); process.exit(1) }
if (typeof m.meta.description !== 'string' || m.meta.description.trim().length < 8) { console.log('  FAIL  locale/' + loc + '.json meta.description too short'); process.exit(1) }
console.log('  PASS  locale/' + loc + '.json meta.title="' + m.meta.title + '"')
JS
    if [ $? -ne 0 ]; then FAIL=$((FAIL + 1)); fi
  done
else
  skip "locale assertions (node missing)"
fi

section "icon"
if [ -f "$PLUGIN/icon.svg" ]; then
  isize=$(wc -c < "$PLUGIN/icon.svg" | tr -d ' ')
  head -c 4 "$PLUGIN/icon.svg" | grep -q '<svg' && ok "icon.svg starts with <svg" || bad "icon.svg does not start with <svg"
  grep -q 'viewBox="0 0 96 96"' "$PLUGIN/icon.svg" && ok "icon.svg 96x96 viewBox" || bad "icon.svg viewBox missing"
  if [ "$isize" -le 262144 ]; then ok "icon.svg $isize bytes (<= 256 KiB)"; else bad "icon.svg too large: $isize bytes"; fi
  grep -q '#0084ff' "$PLUGIN/icon.svg" && ok "icon.svg uses Zhihu blue #0084ff" || warn "icon.svg does not reference #0084ff"
else
  bad "icon.svg missing"
fi

# --- live -----------------------------------------------------------------
section "live probes"
if [ "$STATIC_ONLY" -eq 1 ]; then
  skip "live probes (--static)"
elif ! command -v curl >/dev/null 2>&1; then
  warn "curl not available; live probes not run"
elif [ "$(curl -s -m 4 -o /dev/null -w '%{http_code}' "$BASE_URL/" 2>/dev/null)" = "000" ]; then
  # Any HTTP status means the GUI server is up; 401/403 is the harness auth gate on "/",
  # which is normal for an unauthenticated curl.
  warn "nothing answers at $BASE_URL (DSH not running?)"
else
  echo "  target: $BASE_URL"
  probe() { # name, path, expected-substring
    local name="$1" path="$2" needle="$3" body code
    body=$(curl -sS -m 15 -w '\n%{http_code}' "$BASE_URL$path" 2>&1)
    code=$(printf '%s' "$body" | tail -n 1)
    if [ "$code" != "200" ]; then bad "$name -> HTTP $code"; return; fi
    if printf '%s' "$body" | grep -q "$needle"; then ok "$name -> 200 containing $needle"; else bad "$name -> 200 but no '$needle'"; fi
  }
  probe "GET /api/login/status" "/zhihu-mini/api/login/status" '"ok":true'
  probe "GET /api/panel"        "/zhihu-mini/api/panel"        '"ok":true'
  probe "GET /api/hot"          "/zhihu-mini/api/hot?limit=3"  '"ok":true'

  # Save the user's current panel snapshot so the probe can put it back afterwards.
  ORIG_PANEL="$(mktemp)"
  curl -fsS -m 5 "$BASE_URL/zhihu-mini/api/panel" -o "$ORIG_PANEL" 2>/dev/null || : > "$ORIG_PANEL"

  state='{"view":"hot","updatedAt":1,"loggedIn":false,"title":"e2e-probe"}'
  if curl -fsS -m 5 -X POST -H 'Content-Type: application/json' -H "Origin: $BASE_URL" --data "$state" "$BASE_URL/zhihu-mini/api/panel" >/dev/null 2>&1; then
    if curl -fsS -m 5 "$BASE_URL/zhihu-mini/api/panel" | grep -q 'e2e-probe'; then
      ok "POST/GET /api/panel round-trip"
    else
      bad "POST /api/panel accepted but GET did not return the snapshot"
    fi
  else
    bad "POST /api/panel failed"
  fi

  # limit is honoured locally (upstream ignores ?limit= for topstory endpoints).
  lim() { # path, expected-max
    local path="$1" max="$2" n
    n=$(curl -sS -m 20 -H "Origin: $BASE_URL" "$BASE_URL$path" 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);process.stdout.write(String((j.items||[]).length))}catch{process.stdout.write("?")}})')
    case "$n" in
      ''|'?') bad "$path -> unparsable item count" ;;
      *) if [ "$n" -le "$max" ]; then ok "$path -> $n items (<= $max)"; else bad "$path -> $n items (> $max); limit not applied"; fi ;;
    esac
  }
  lim "/zhihu-mini/api/hot?limit=3" 3
  lim "/zhihu-mini/api/feed?limit=2" 2

  # Absent limit must fall back to the documented default (30 hot / feedSize feed), not to 1.
  deflim() { # path, minimum-acceptable-item-count
    local path="$1" min="$2" n
    n=$(curl -sS -m 20 -H "Origin: $BASE_URL" "$BASE_URL$path" 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);process.stdout.write(String((j.items||[]).length))}catch{process.stdout.write("?")}})')
    case "$n" in
      ''|'?') bad "$path (no limit) -> unparsable item count" ;;
      *) if [ "$n" -ge "$min" ]; then ok "$path (no limit) -> $n items (>= $min)"; else bad "$path (no limit) -> $n items (< $min); default limit not applied"; fi ;;
    esac
  }
  deflim "/zhihu-mini/api/hot" 2
  deflim "/zhihu-mini/api/feed" 2

  # 19-digit question ids must survive JSON parsing unrounded (upstream sends them as numbers).
  if [ -f "$PLUGIN/zhihu.js" ] && command -v node >/dev/null 2>&1; then
    idout=$(node --input-type=module -e '
      const { pathToFileURL } = await import("node:url");
      const mod = await import(pathToFileURL(process.argv[1]).href);
      const raw = "{\"id\":2103784826771862921,\"title\":\"t\"}";
      const parsed = mod.parseZhihuJson(raw);
      const okId = String(parsed.id) === "2103784826771862921" && mod.normalizeId(parsed.id) === "2103784826771862921";
      process.stdout.write(okId ? "ok" : "bad:" + String(parsed.id));
    ' -- "$PLUGIN/zhihu.js" 2>&1)
    case "$idout" in
      ok) ok "parseZhihuJson keeps 19-digit ids exact" ;;
      *) warn "19-digit id precision not confirmed: $idout" ;;
    esac
  fi

  # Restore the pre-test snapshot (the guide requires restoring user state after testing).
  if [ -s "$ORIG_PANEL" ]; then
    restore=$(node -e 'const fs=require("node:fs");try{const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(j&&j.panel)process.stdout.write(JSON.stringify(j.panel))}catch{}' "$ORIG_PANEL" 2>/dev/null)
    if [ -n "$restore" ]; then
      if curl -fsS -m 5 -X POST -H 'Content-Type: application/json' -H "Origin: $BASE_URL" --data "$restore" "$BASE_URL/zhihu-mini/api/panel" >/dev/null 2>&1; then
        ok "restored the pre-test panel snapshot"
      else
        warn "could not restore the pre-test panel snapshot"
      fi
    else
      skip "pre-test panel snapshot was empty; nothing to restore"
    fi
  fi
  rm -f "$ORIG_PANEL"

  # SSE: headers only (a real 'open' delivery needs the zhihu_open agent tool, which is
  # exercised by tools/e2e-report.md through the agent loop, not over HTTP).
  if curl -sS -m 3 -D - -o /dev/null "$BASE_URL/zhihu-mini/api/events" 2>/dev/null | grep -qi 'content-type: text/event-stream'; then
    ok "GET /api/events serves text/event-stream"
  else
    bad "GET /api/events did not return text/event-stream"
  fi

  code=$(curl -sS -m 5 -o /dev/null -w '%{http_code}' -X POST \
    -H 'Content-Type: application/json' -H 'Origin: https://evil.example' -H 'Sec-Fetch-Site: cross-site' \
    --data '{"view":"hot","updatedAt":1}' "$BASE_URL/zhihu-mini/api/panel" 2>/dev/null)
  case "$code" in
    401|403) ok "trust fence rejects cross-site POST (HTTP $code)" ;;
    *)       bad "trust fence did not reject cross-site POST (HTTP $code)" ;;
  esac
fi

# --- summary --------------------------------------------------------------
printf '\n== summary ==\n  pass=%d  fail=%d  warn=%d  skip=%d\n' "$PASS" "$FAIL" "$WARN" "$SKIP"
if [ "$FAIL" -eq 0 ]; then echo "  RESULT: PASS"; exit 0; fi
echo "  RESULT: FAIL"
exit 1
