#!/bin/bash
# End-to-end: image source on the console -> Mac pulls (resuming) -> packer
# builds a package -> console pulls it back.
set -u

R=/tmp/pv_e2e
MAC=/tmp/pv_app2
# A unique port per run: a server left behind by an earlier run would otherwise
# answer for the one this script started, and every symptom would be a lie.
MACPORT=${MACPORT:-$((8200 + ($$ % 400)))}
PAYLOAD=http://127.0.0.1:8096
MACURL=http://127.0.0.1:$MACPORT

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "  ok    $1"; }
no() { fail=$((fail + 1)); echo "  FAIL  $1 ${2:-}"; }

rm -rf "$R" "$MAC"
mkdir -p "$R/Games" "$R/data" "$MAC/data" /tmp/fakebin

# A "dumped disc image" — the shape that is packed without extracting it.
head -c 3000000 /dev/urandom > "$R/Games/PPSA00002.exfat"

# Stand-in implementing fpkg-cli's documented CLI surface. One process, on
# purpose: a shell stub that forks a sleeper per step was itself part of the
# flakiness this script kept showing.
cat > /tmp/fakebin/fpkg-cli <<'STUB'
#!/usr/bin/perl
use strict;
use warnings;

my ($src, $out);
for (my $i = 0; $i < @ARGV; $i++) {
  $src = $ARGV[$i + 1] if $ARGV[$i] eq "--source";
  $out = $ARGV[$i + 1] if $ARGV[$i] eq "--output";
}
die "no such source: " . ($src // "(none)") . "\n" unless $src && -e $src;
die "no output folder\n" unless $out;
mkdir $out unless -d $out;

$| = 1;
for my $p (20, 45, 70, 88, 100) {
  print "packing $p%\n";
  select(undef, undef, undef, 0.12);
}

open(my $fh, ">", "$out/UP9000-PPSA00002_00-STUBSTUBSTUB001.pkg") or die "cannot write: $!\n";
binmode $fh;
print $fh "x" x 400000;
close $fh;
exit 0;
STUB
chmod +x /tmp/fakebin/fpkg-cli

# The payload reads config.json beside PV_ROOT, not under data/.
echo "{\"mac\":\"127.0.0.1:$MACPORT\"}" > "$R/config.json"
echo "{\"port\":$MACPORT,\"consoleHost\":\"http://127.0.0.1:8096\",\"engine\":\"auto\",\"enginePaths\":{\"psviethoa\":\"/tmp/fakebin/fpkg-cli\"},\"scanDirs\":[]}" > "$MAC/data/config.json"
ln -sfn "$HOME/titan-forge/public" "$MAC/public"

# PRELOAD=1 puts a correct 1 MB prefix on disk so the pull must continue
# rather than restart; PRELOAD=0 exercises a pull from nothing.
if [ "${PRELOAD:-1}" = "1" ]; then
  mkdir -p "$MAC/data/pulled/PPSA00002"
  head -c 1000000 "$R/Games/PPSA00002.exfat" > "$MAC/data/pulled/PPSA00002/PPSA00002.exfat"
fi

cd "$HOME/titan-forge" || exit 1
c++ -std=c++17 -O2 -Wall -Wextra -pthread "-DPV_ROOT=\"$R\"" "-DPV_APP_ROOT=\"$R\"" -DPV_PORT=8096 \
  console/main.cpp console/build/ui_data.cpp -o /tmp/pv_e2e_host 2>/tmp/pv_e2e_compile.log || {
  echo "host build failed"; tail -5 /tmp/pv_e2e_compile.log; exit 1; }

/tmp/pv_e2e_host >/tmp/pv_e2e_payload.log 2>&1 &
PAYLOAD_PID=$!
# The wrapper records the server's exit status in the log, which is the only
# way to tell a crash from a signal from an orderly exit.
( cd "$MAC" && env PV_PORT=$MACPORT PV_CONFIG="$MAC/data/config.json" bun run "$HOME/titan-forge/app/server.ts" >/tmp/pv_e2e_mac.log 2>&1; echo "SERVER EXITED=$?" >>/tmp/pv_e2e_mac.log ) &
MAC_PID=$!
# No EXIT trap on purpose: bash lets command-substitution subshells inherit it,
# and an inherited trap here killed both servers a second into the run.
cleanup() {
  kill "$PAYLOAD_PID" "$MAC_PID" 2>/dev/null
  sleep 0.3
  kill -9 "$PAYLOAD_PID" "$MAC_PID" 2>/dev/null
}

for _ in $(seq 1 60); do curl -sf "$PAYLOAD/api/health" >/dev/null && break; sleep 0.25; done
for _ in $(seq 1 80); do curl -sf "$MACURL/api/state" >/dev/null && break; sleep 0.25; done

# A stale server left on the port would silently answer for this one.
if ! curl -sf "$MACURL/api/state" >/dev/null; then
  echo "  FAIL  the Mac never answered on $MACURL"
  tail -8 /tmp/pv_e2e_mac.log
  cleanup
  exit 1
fi
if ! curl -sf "$PAYLOAD/api/health" >/dev/null; then
  echo "  FAIL  the payload never answered on $PAYLOAD"
  tail -8 /tmp/pv_e2e_payload.log
  cleanup
  exit 1
fi
listener=$(lsof -ti tcp:$MACPORT 2>/dev/null | head -1)
if [ -z "$listener" ]; then
  echo "  FAIL  nothing is listening on $MACPORT"
  cleanup
  exit 1
fi
echo "  both ends answered (pid $MAC_PID)"

echo "== image source is offered whole =="
info=$(curl -s "$PAYLOAD/api/source/PPSA00002")
echo "$info" | grep -q '"kind":"image"' && ok "console reports an image source" || no "console reports an image source" "$info"
echo "$info" | grep -q 'PPSA00002.exfat' && ok "console names the image file" || no "console names the image file"
echo "$info" | grep -q '"size":3000000' && ok "console reports the image size" || no "console reports the image size" "$info"

echo "== convert pulls, packs and returns =="
curl -s -X POST "$PAYLOAD/api/convert" -d '{"id":"PPSA00002"}' >/tmp/pv_e2e_start.json
: >/tmp/pv_e2e_samples
n=0
for _ in $(seq 1 240); do
  task=$(curl -s "$PAYLOAD/api/task")
  echo "$task" | grep -q '"state":"running"' || break
  n=$((n + 1))
  if [ $((n % 4)) -eq 0 ]; then
    curl -s "$MACURL/api/state" | grep -o '"titleId":"[^"]*"[^}]*' | head -2 >>/tmp/pv_e2e_samples
  fi
  sleep 0.5
done
echo "  mac state: $(tail -1 /tmp/pv_e2e_samples)"
echo "  task: $(echo "$task" | head -c 220)"
echo "$task" | grep -q '"ok":true' && ok "the job finished successfully" || no "the job finished successfully" "$task"

echo "== the image arrived intact, by resume =="
pulled="$MAC/data/pulled/PPSA00002/PPSA00002.exfat"
[ "$(wc -c < "$pulled" | tr -d ' ')" = "3000000" ] && ok "pulled image is exactly 3,000,000 bytes" \
  || no "pulled image is exactly 3,000,000 bytes" "(got $(wc -c < "$pulled" | tr -d ' '))"
[ "$(shasum -a 256 "$pulled" | cut -d' ' -f1)" = "$(shasum -a 256 "$R/Games/PPSA00002.exfat" | cut -d' ' -f1)" ] \
  && ok "pulled image is byte-identical to the console's" || no "pulled image is byte-identical to the console's"
if [ "${PRELOAD:-1}" = "1" ]; then
  grep -q 'resumed at 1000000' /tmp/pv_e2e_payload.log && ok "the console resumed the transfer at 1 MB" \
    || no "the console resumed the transfer at 1 MB" "$(grep stream: /tmp/pv_e2e_payload.log | head -2)"
else
  grep -q 'resumed at' /tmp/pv_e2e_payload.log && no "a fresh pull sends no Range" || ok "a fresh pull sends no Range"
fi

echo "== the package came back =="
echo "$task" | grep -q 'received' && ok "the console reports the package received" || no "the console reports the package received" "$task"
pkg="$R/Games/PPSA00002.pkg"
if [ -f "$pkg" ]; then
  ok "the package is on the console"
  [ "$(wc -c < "$pkg" | tr -d ' ')" = "400000" ] && ok "the package is the packer's output" \
    || no "the package is the packer's output" "(got $(wc -c < "$pkg"))"
else
  no "the package is on the console" "(no $pkg)"
  no "the package is the packer's output" "(no $pkg)"
fi
curl -s "$PAYLOAD/api/games" | grep -q '"kind":"pkg"' && ok "the console lists it as a package now" \
  || no "the console lists it as a package now" "$(curl -s "$PAYLOAD/api/games" | head -c 200)"

echo "== mac log =="
tail -20 /tmp/pv_e2e_mac.log

echo "== the Mac recorded a real build =="
state=$(curl -s "$MACURL/api/state")
echo "$state" | grep -q '"simulated":false' && ok "the build was not a placeholder" || no "the build was not a placeholder"
grep -q 'packing 45%' /tmp/pv_e2e_mac.log && ok "packer progress was read" || no "packer progress was read"

cleanup
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
