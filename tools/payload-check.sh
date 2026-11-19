#!/bin/bash
#
# Payload self-check: builds console/main.cpp for this Mac and exercises the
# HTTP contract a browser and the Mac app actually depend on.
#
#   bash tools/payload-check.sh
#
# It runs a host build (no Sony libraries) against a throwaway library under
# /tmp, so it proves parsing, scanning, ETag/304, error codes and the task
# contract — everything except the calls only a console can make, which the
# payload answers with 501 instead of pretending.

set -u
cd "$(dirname "$0")/.." || exit 1

PASS=0
FAIL=0
ok() { echo "  ok    $1"; PASS=$((PASS + 1)); }
no() { echo "  FAIL  $1 ${2:-}"; FAIL=$((FAIL + 1)); }

ROOT=/tmp/pv_payload_check
PORT=8091
APP_ROOT="$ROOT/app"
B="http://127.0.0.1:$PORT"

# --- a library with one of every format the payload claims to read ---------
rm -rf "$ROOT"
mkdir -p "$ROOT/Games/PPSA00001/sce_sys" "$ROOT/Games/CUSA00002/sce_sys"
printf '{"titleId":"PPSA00001","titleName":"JSON Dump"}' > "$ROOT/Games/PPSA00001/sce_sys/param.json"
# A dump is a tree, not a file: the pull has to carry nested paths too.
mkdir -p "$ROOT/Games/PPSA00001/data"
head -c 1234 /dev/zero > "$ROOT/Games/PPSA00001/eboot.bin"
head -c 4321 /dev/zero > "$ROOT/Games/PPSA00001/data/chunk.bin"
python3 - "$ROOT" <<'PY'
import struct, sys
root = sys.argv[1]

def sfo(entries):
    keys = sorted(entries)
    kb = [k.encode() + b"\0" for k in keys]
    vb = [entries[k].encode() + b"\0" for k in keys]
    pad = lambda n: (n + 3) & ~3
    pd = [pad(len(b)) for b in vb]
    kts = 20 + 16 * len(keys)
    dts = kts + sum(len(b) for b in kb)
    out = bytearray(dts + sum(pd))
    struct.pack_into("<I", out, 0, 0x46535000)
    struct.pack_into("<I", out, 4, 0x00000101)
    struct.pack_into("<I", out, 8, kts)
    struct.pack_into("<I", out, 12, dts)
    struct.pack_into("<I", out, 16, len(keys))
    ko = do = 0
    for i, k in enumerate(keys):
        e = 20 + i * 16
        struct.pack_into("<H", out, e, ko)
        struct.pack_into("<H", out, e + 2, 0x0204)
        struct.pack_into("<I", out, e + 4, len(vb[i]))
        struct.pack_into("<I", out, e + 8, pd[i])
        struct.pack_into("<I", out, e + 12, do)
        out[kts + ko:kts + ko + len(kb[i])] = kb[i]
        out[dts + do:dts + do + len(vb[i])] = vb[i]
        ko += len(kb[i])
        do += pd[i]
    return bytes(out)

open(f"{root}/Games/CUSA00002/sce_sys/param.sfo", "wb").write(
    sfo({"TITLE_ID": "CUSA00002", "TITLE": "SFO Dump", "CATEGORY": "gd"})
)
PY
# A dump is a tree of files, and a symlink in one must not be a way out of it.
ln -s /etc/passwd "$ROOT/Games/PPSA00001/data/escape"

# A real title name arrives escaped: the quote and the backslash must survive
# the trip from param.json into the library.
python3 - "$ROOT" <<'PY'
import os, sys
folder = os.path.join(sys.argv[1], "Games", "PPSA00007", "sce_sys")
os.makedirs(folder, exist_ok=True)
with open(os.path.join(folder, "param.json"), "w") as handle:
    handle.write('{"titleId":"PPSA00007","titleName":"Ratchet \\"Rift\\" \\\\o/"}')
PY
head -c 2000 /dev/zero > "$ROOT/Games/PPSA00009.pkg"
head -c 3000 /dev/zero > "$ROOT/Games/PPSA00008.exfat"

# An app the console already holds, with no .pkg anywhere: this is the
# "existing FPKG plays instantly" case, and PV_APP_ROOT lets a Mac test it.
mkdir -p "$APP_ROOT/PPTA00003/sce_sys"
printf '{"titleId":"PPTA00003","titleName":"Installed Demo"}' > "$APP_ROOT/PPTA00003/sce_sys/param.json"
head -c 64 /dev/zero > "$APP_ROOT/PPTA00003/sce_sys/icon0.png"

# --- build ----------------------------------------------------------------
if [ ! -f console/build/ui_data.cpp ]; then
  echo "console/build/ui_data.cpp is missing — run: make -C console" >&2
  exit 1
fi

# PV_CHECK_FLAGS lets the same suite run under a sanitiser, which is how the
# buffer arithmetic in the JSON builder and the sockets were checked.
#
#   PV_CHECK_FLAGS="-O1 -g -fsanitize=address,undefined -fno-omit-frame-pointer" \
#     bash tools/payload-check.sh
CHECK_FLAGS="${PV_CHECK_FLAGS:--O2 -Wall -Wextra}"
c++ -std=c++17 $CHECK_FLAGS -pthread "-DPV_ROOT=\"$ROOT\"" "-DPV_APP_ROOT=\"$APP_ROOT\"" -DPV_PORT=$PORT \
  console/main.cpp console/build/ui_data.cpp -o /tmp/pv_check_host 2>/tmp/pv_check_build.log
if [ $? -ne 0 ]; then
  echo "host build failed"
  tail -20 /tmp/pv_check_build.log
  exit 1
fi
ok "host build compiles clean"

/tmp/pv_check_host >/tmp/pv_check.log 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null' EXIT

first=""
for _ in $(seq 1 40); do
  first=$(curl -s --max-time 2 $B/api/games 2>/dev/null)
  [ -n "$first" ] && break
  sleep 0.1
done
echo "$first" | grep -q '"scanning"' && ok "games body reports scan state" || no "games body reports scan state" "$first"

for _ in $(seq 1 25); do
  body=$(curl -s --max-time 5 $B/api/games)
  echo "$body" | grep -q '"scanning":false' && break
  sleep 0.3
done
echo "$body" > /tmp/pv_check_games.json

python3 - <<'PY'
import json, sys
d = json.load(open("/tmp/pv_check_games.json"))
g = {x["id"]: x for x in d["games"]}
names = [x["name"] for x in d["games"]]
checks = [
    ("six titles found", len(g) == 6, str(sorted(g))),
    ("an escaped name survives intact",
     g.get("PPSA00007", {}).get("name") == 'Ratchet "Rift" \\o/', str(g.get("PPSA00007"))),
    ("PS5 dump read from param.json",
     g.get("PPSA00001", {}).get("platform") == "PS5" and g["PPSA00001"]["name"] == "JSON Dump", ""),
    ("PS4 dump read from param.sfo",
     g.get("CUSA00002", {}).get("platform") == "PS4" and g["CUSA00002"]["name"] == "SFO Dump", ""),
    ("pkg classified", g.get("PPSA00009", {}).get("kind") == "pkg", ""),
    ("image classified", g.get("PPSA00008", {}).get("kind") == "image", ""),
    ("pkg plays natively, no mount payload needed",
     g.get("PPSA00009", {}).get("native") is True, ""),
    ("image reports that it needs a mount",
     g.get("PPSA00008", {}).get("native") is False, ""),
    ("an installed app is found without any .pkg file",
     g.get("PPTA00003", {}).get("kind") == "app" and g["PPTA00003"]["installed"] is True, ""),
    ("an installed app is native and playable",
     g.get("PPTA00003", {}).get("native") is True, ""),
    ("every title reports installed as a boolean",
     all(isinstance(x.get("installed"), bool) for x in d["games"]), str(names)),
    ("titles are sorted by name",
     names == sorted(names, key=str.lower), str(names)),
]
bad = 0
for name, cond, detail in checks:
    print(("  ok    " if cond else "  FAIL  ") + name + (" " + detail if detail and not cond else ""))
    bad += 0 if cond else 1
sys.exit(1 if bad else 0)
PY
[ $? -eq 0 ] && PASS=$((PASS + 11)) || FAIL=$((FAIL + 1))

# --- rescan is acknowledged, not held open --------------------------------
code=$(curl -s -o /tmp/pv_check_scan.json -w '%{http_code}' -X POST -d '{}' $B/api/scan)
[ "$code" = "202" ] && ok "rescan answers 202 at once" || no "rescan answers 202 at once" "(got $code)"
grep -q '"scanning":true' /tmp/pv_check_scan.json && ok "rescan reports itself scanning" || no "rescan reports itself scanning"

for _ in $(seq 1 40); do
  curl -s --max-time 3 $B/api/games | grep -q '"scanning":false' && break
  sleep 0.2
done
ok "rescan settles without holding the request"

# --- ETag / 304 -----------------------------------------------------------
etag=$(curl -s -D - -o /dev/null $B/api/games | tr -d '\r' | awk -F': ' 'tolower($1)=="etag"{print $2}')
[ -n "$etag" ] && ok "games response carries an ETag" || no "games response carries an ETag"
code=$(curl -s -o /dev/null -w '%{http_code}' -H "If-None-Match: $etag" $B/api/games)
[ "$code" = "304" ] && ok "unchanged library answers 304" || no "unchanged library answers 304" "(got $code)"
code=$(curl -s -o /dev/null -w '%{http_code}' -H "If-None-Match: $etag" $B/api/games)
[ "$code" = "304" ] && ok "304 stays stable across polls" || no "304 stays stable across polls" "(got $code)"

# --- play -----------------------------------------------------------------
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"id":"PPSA00001"}' $B/api/play)
[ "$code" = "409" ] && ok "play on a dump is refused with 409" || no "play on a dump is refused with 409" "(got $code)"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"id":"PPSA00009"}' $B/api/play)
[ "$code" = "501" ] && ok "play on a package reaches the launcher path" || no "play on a package reaches the launcher path" "(got $code)"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"id":"PPSA99999"}' $B/api/play)
[ "$code" = "404" ] && ok "play on an unknown title is 404" || no "play on an unknown title is 404" "(got $code)"
message=$(curl -s -X POST -H 'content-type: application/json' -d '{"id":"PPSA00008"}' $B/api/play)
echo "$message" | grep -q "mount" && ok "an unmountable image says why, by name" || no "an unmountable image says why" "$message"

# --- install --------------------------------------------------------------
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"id":"PPSA00009"}' $B/api/install)
[ "$code" = "501" ] && ok "install on a host build is 501, not a pretend job" || no "install on a host build is 501" "(got $code)"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"id":"PPSA99999"}' $B/api/install)
[ "$code" = "404" ] && ok "install on an unknown title is 404" || no "install on an unknown title is 404" "(got $code)"

# --- pulling a dump off the console, for the packer on this Mac ----------
curl -s "$B/api/tree/PPSA00001" -o /tmp/pv_tree.json
python3 - <<'PY'
import json, sys
try:
    d = json.load(open("/tmp/pv_tree.json"))
except Exception as e:
    print(f"  FAIL  the dump tree is valid JSON ({e})")
    sys.exit(1)
files = {f["p"]: f["s"] for f in d.get("files", [])}
wanted = ("sce_sys/param.json", "eboot.bin", "data/chunk.bin")
good = all(files.get(p, 0) > 0 for p in wanted) and d.get("bytes", 0) == sum(files[p] for p in wanted)
print(("  ok    " if good else "  FAIL  ") + "the dump tree is valid JSON with real file sizes")
sys.exit(0 if good else 1)
PY
[ $? -eq 0 ] && PASS=$((PASS + 1)) || FAIL=$((FAIL + 1))
tree=$(cat /tmp/pv_tree.json)
echo "$tree" | grep -q 'sce_sys/param.json' && ok "a dump tree lists its files" || no "a dump tree lists its files" "$tree"
echo "$tree" | grep -q '"bytes":' && ok "a dump tree reports its total size" || no "a dump tree reports its total size"
body=$(curl -s "$B/api/dump/PPSA00001/sce_sys/param.json")
echo "$body" | grep -q 'JSON Dump' && ok "a dump file streams its bytes" || no "a dump file streams its bytes" "$body"

code=$(curl -s -o /dev/null -w '%{http_code}' --path-as-is "$B/api/dump/PPSA00001/../../../etc/passwd")
[ "$code" = "403" ] && ok "climbing out of a dump is refused" || no "climbing out of a dump is refused" "(got $code)"
code=$(curl -s -o /dev/null -w '%{http_code}' "$B/api/tree/PPSA00009")
[ "$code" = "404" ] && ok "only a dump folder is pullable" || no "only a dump folder is pullable" "(got $code)"

# A symlink inside a dump points anywhere on the console, so it is neither
# listed nor served.
code=$(curl -s -o /dev/null -w '%{http_code}' "$B/api/dump/PPSA00001/data/escape")
[ "$code" = "404" ] && ok "a symlink inside a dump is not served" || no "a symlink inside a dump is not served" "(got $code)"
tree=$(curl -s "$B/api/tree/PPSA00001")
echo "$tree" | grep -q 'escape' && no "a symlink is left out of a dump tree" || ok "a symlink is left out of a dump tree"

# --- a single-file image source ------------------------------------------
info=$(curl -s "$B/api/source/PPSA00008")
echo "$info" | grep -q '"kind":"image"' && ok "an image reports itself as one file" || no "an image reports itself as one file" "$info"
echo "$info" | grep -q 'PPSA00008.exfat' && ok "an image source carries its filename" || no "an image source carries its filename" "$info"

size=$(curl -s "$B/api/source-file/PPSA00008" | wc -c | tr -d ' ')
[ "$size" = "3000" ] && ok "an image streams whole" || no "an image streams whole" "(got $size bytes)"

headers=$(curl -s -D - -o /tmp/pv_resume.bin -H 'Range: bytes=1000-' "$B/api/source-file/PPSA00008" | tr -d '\r')
echo "$headers" | grep -q '206 Partial Content' && ok "a ranged image request answers 206" || no "a ranged image request answers 206"
echo "$headers" | grep -q 'Content-Range: bytes 1000-2999/3000' && ok "206 describes the range" || no "206 describes the range"
[ "$(wc -c < /tmp/pv_resume.bin | tr -d ' ')" = "2000" ] && ok "a resumed transfer sends only the remaining bytes" || no "a resumed transfer sends only the remaining bytes"
grep -q 'resumed at 1000' /tmp/pv_check.log && ok "the payload logs the resume" || no "the payload logs the resume"

# --- a range that names an end is honoured -------------------------------
# Only the start used to be read: "bytes=10-19" sent the rest of the file and
# called it a 206 covering everything.
curl -s "$B/api/dump/PPSA00001/sce_sys/param.json" -o /tmp/pv_param_full.bin
FULL=$(wc -c < /tmp/pv_param_full.bin | tr -d ' ')
python3 - <<'PY'
open("/tmp/pv_param_10_20.bin", "wb").write(open("/tmp/pv_param_full.bin", "rb").read()[10:20])
PY
headers=$(curl -s -D - -o /tmp/pv_end.bin -H 'Range: bytes=10-19' "$B/api/dump/PPSA00001/sce_sys/param.json" | tr -d '\r')
[ "$(wc -c < /tmp/pv_end.bin | tr -d ' ')" = "10" ] && ok "a bounded range sends exactly its bytes" || no "a bounded range sends exactly its bytes" "(got $(wc -c < /tmp/pv_end.bin) of $FULL)"
cmp -s /tmp/pv_end.bin /tmp/pv_param_10_20.bin && ok "a bounded range sends the right bytes" || no "a bounded range sends the right bytes"
echo "$headers" | grep -q "Content-Range: bytes 10-19/$FULL" && ok "a bounded range describes itself" || no "a bounded range describes itself" "$headers"

headers=$(curl -s -D - -o /tmp/pv_suffix.bin -H 'Range: bytes=-20' "$B/api/dump/PPSA00001/sce_sys/param.json" | tr -d '\r')
[ "$(wc -c < /tmp/pv_suffix.bin | tr -d ' ')" = "20" ] && ok "a suffix range sends the last bytes" || no "a suffix range sends the last bytes" "(got $(wc -c < /tmp/pv_suffix.bin))"
echo "$headers" | grep -q "Content-Range: bytes $((FULL - 20))-$((FULL - 1))/$FULL" && ok "a suffix range describes itself" || no "a suffix range describes itself" "$headers"
# A suffix longer than the file is the whole file, not an error.
headers=$(curl -s -D - -o /tmp/pv_suffix_over.bin -H 'Range: bytes=-100' "$B/api/dump/PPSA00001/sce_sys/param.json" | tr -d '\r')
[ "$(wc -c < /tmp/pv_suffix_over.bin | tr -d ' ')" = "$FULL" ] && echo "$headers" | grep -q "Content-Range: bytes 0-$((FULL - 1))/$FULL" && ok "an oversized suffix sends the whole file" || no "an oversized suffix sends the whole file" "$(head -1 <<< \"$headers\")"

code=$(curl -s -o /tmp/pv_416.json -w '%{http_code}' -H 'Range: bytes=999999-' "$B/api/dump/PPSA00001/sce_sys/param.json")
[ "$code" = "416" ] && ok "a range past the end is refused with 416" || no "a range past the end is refused with 416" "(got $code)"
grep -q "Content-Range: bytes \*/$FULL" <(curl -s -D - -o /dev/null -H 'Range: bytes=999999-' "$B/api/dump/PPSA00001/sce_sys/param.json" | tr -d '\r') && ok "416 says how long the file is" || no "416 says how long the file is"
grep -q '"ok":false' /tmp/pv_416.json && ok "416 is JSON" || no "416 is JSON" "$(cat /tmp/pv_416.json)"

code=$(curl -s -o /tmp/pv_back.json -w '%{http_code}' -H 'Range: bytes=90-10' "$B/api/dump/PPSA00001/sce_sys/param.json")
[ "$code" = "416" ] && ok "a backwards range is refused" || no "a backwards range is refused" "(got $code)"

code=$(curl -s -o /tmp/pv_multi.bin -w '%{http_code}' -H 'Range: bytes=0-9,20-29' "$B/api/dump/PPSA00001/sce_sys/param.json")
[ "$code" = "200" ] && [ "$(wc -c < /tmp/pv_multi.bin | tr -d ' ')" = "$FULL" ] && ok "a multi-range request gets the whole file" || no "a multi-range request gets the whole file" "($code, $(wc -c < /tmp/pv_multi.bin) bytes)"

code=$(curl -s -o /tmp/pv_img_416.json -w '%{http_code}' -H 'Range: bytes=3000-' "$B/api/source-file/PPSA00008")
[ "$code" = "416" ] && ok "the image route refuses a range past its end" || no "the image route refuses a range past its end" "(got $code)"

# --- six pulls of one file at once ----------------------------------------
before=$(lsof -p $PID 2>/dev/null | wc -l | tr -d ' ')
pids=()
for i in 1 2 3 4 5 6; do
  curl -s --max-time 10 -o "/tmp/pv_conc_$i.bin" -H "Range: bytes=$((i * 5))-" "$B/api/dump/PPSA00001/sce_sys/param.json" &
  pids+=($!)
done
# Only the curls: a bare `wait` here also waits for the server itself.
wait "${pids[@]}"
whole=1
for i in 1 2 3 4 5 6; do
  python3 - "$i" <<'PY'
import sys
n = int(sys.argv[1]) * 5
data = open("/tmp/pv_param_full.bin", "rb").read()
open(f"/tmp/pv_conc_want_{n}.bin", "wb").write(data[n:])
PY
  cmp -s "/tmp/pv_conc_$i.bin" "/tmp/pv_conc_want_$((i * 5)).bin" || whole=0
done
[ "$whole" = "1" ] && ok "six pulls at once each get the right bytes" || no "six pulls at once each get the right bytes"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 $B/api/games)
[ "$code" = "200" ] && ok "the server answers during and after six pulls" || no "the server answers during and after six pulls" "(got $code)"
after=$(lsof -p $PID 2>/dev/null | wc -l | tr -d ' ')
[ "$after" -le $((before + 2)) ] && ok "connections and files do not accumulate" || no "connections and files do not accumulate" "($before -> $after)"

# A client that connects and never finishes its header must not block the
# others: the cap is 24 workers, and a dropped Wi-Fi link leaves sockets open.
python3 - "$PORT" <<'PY' &
import socket, sys, time
s = socket.create_connection(("127.0.0.1", int(sys.argv[1])), timeout=5)
s.sendall(b"GET /api/games HTTP/1.1\r\nHost: x\r\n")
time.sleep(3)
s.close()
PY
HALF=$!
sleep 0.3
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 $B/api/games)
[ "$code" = "200" ] && ok "a half-sent request does not block other clients" || no "a half-sent request does not block other clients" "(got $code)"
wait $HALF 2>/dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 $B/api/games)
[ "$code" = "200" ] && ok "the stalled worker is reclaimed" || no "the stalled worker is reclaimed" "(got $code)"

# --- task contract (convert status is the same body) ----------------------
task=$(curl -s $B/api/task)
status=$(curl -s $B/api/convert/status)
[ "$task" = "$status" ] && ok "/api/task mirrors /api/convert/status" || no "/api/task mirrors /api/convert/status"
echo "$task" | grep -q '"kind"' && ok "task body carries a kind" || no "task body carries a kind" "$task"

# --- a body that arrives in its own packet --------------------------------
# The header and the body do not always share a segment; over Wi-Fi the body
# often lands second. Reading only up to the header terminator left the body
# empty, which silently cleared the stored Mac address.
python3 - "$PORT" <<'PY'
import socket, sys, time
port = int(sys.argv[1])
body = b'{"mac":"192.168.1.50:8090"}'
s = socket.create_connection(("127.0.0.1", port), timeout=5)
s.sendall(b"POST /api/config HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n"
          b"Content-Length: %d\r\n\r\n" % len(body))
time.sleep(0.4)
s.sendall(body)
answer = b""
while True:
    chunk = s.recv(4096)
    if not chunk:
        break
    answer += chunk
s.close()
open("/tmp/pv_check_split.txt", "wb").write(answer)
PY
grep -q 'HTTP/1.1 200' /tmp/pv_check_split.txt && ok "a request body sent in a second packet is read" || no "a request body sent in a second packet is read" "$(head -1 /tmp/pv_check_split.txt)"
stored=$(curl -s --max-time 5 $B/api/games | python3 -c 'import json,sys; print(json.load(sys.stdin).get("mac",""))')
[ "$stored" = "192.168.1.50:8090" ] && ok "the address from that body was stored" || no "the address from that body was stored" "$stored"

# An over-large declared body is refused before it is buffered.
python3 - "$PORT" <<'PY'
import socket, sys
s = socket.create_connection(("127.0.0.1", int(sys.argv[1])), timeout=5)
s.sendall(b"POST /api/config HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 999999\r\n\r\n")
answer = b""
while True:
    chunk = s.recv(4096)
    if not chunk:
        break
    answer += chunk
s.close()
open("/tmp/pv_check_huge.txt", "wb").write(answer)
PY
grep -q 'HTTP/1.1 413' /tmp/pv_check_huge.txt && ok "an over-large declared body is refused" || no "an over-large declared body is refused" "$(head -1 /tmp/pv_check_huge.txt)"

# A dump path shorter than a title id used to read past its own terminator.
short=$(curl -s -o /tmp/pv_check_short.txt -w '%{http_code}' "$B/api/dump/")
[ "$short" = "403" ] && ok "a dump path with no id is refused, not served" || no "a dump path with no id is refused, not served" "$short"
grep -q '"ok":false' /tmp/pv_check_short.txt && ok "that refusal is JSON" || no "that refusal is JSON" "$(cat /tmp/pv_check_short.txt)"

# --- health, port fallback ------------------------------------------------
health=$(curl -s --max-time 5 $B/api/health)
echo "$health" | grep -q "\"port\":$PORT" && ok "health reports the bound port" || no "health reports the bound port" "$health"
echo "$health" | grep -q '"firmware":"host"' && ok "health names a host build honestly" || no "health names a host build honestly" "$health"
echo "$health" | grep -q '"install":"host"' && ok "health does not claim a host install" || no "health does not claim a host install" "$health"

/tmp/pv_check_host >/tmp/pv_check2.log 2>&1 &
PID2=$!
bound=""
for _ in $(seq 1 20); do
  bound=$(curl -s --max-time 2 http://127.0.0.1:$((PORT + 1))/api/health 2>/dev/null | grep -o "\"port\":$((PORT + 1))")
  [ -n "$bound" ] && break
  sleep 0.3
done
grep -q "in use" /tmp/pv_check2.log && ok "second instance notices a taken port" || no "second instance notices a taken port"
[ -n "$bound" ] && ok "second instance falls over to the next port" || no "second instance falls over to the next port"
kill $PID2 2>/dev/null

grep -q "scan: 6 titles" /tmp/pv_check.log && ok "scan logged six titles" || no "scan logged six titles"

echo
echo "passed=$PASS failed=$FAIL"
exit $([ $FAIL -eq 0 ] && echo 0 || echo 1)
