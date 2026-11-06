// Watch over the shadow pilot, run right after pilot-relay.ts every hour (run.sh on the server).
// Tells Mag in Telegram (via smm.agent_messages → Zyalmakh) once per problem, and once when it is over:
//  • our failures, at once after two runs in a row: the endpoint does not answer, the relay fails or
//    a packet is rejected on chain;
//  • the community's silence, once: no new reading from a sender for more than 24 hours. A test that
//    ends on their side is not a failure, so this is a note, not an alarm.
// Never touches the relay or the chain. DRY_RUN=1 prints instead of sending.
import fs from "fs";

const SUPABASE = "https://dgqozsxkqqfbvthibvhs.supabase.co/rest/v1";
const KEY = process.env.SUPABASE_SERVICE_KEY;
const ENDPOINT = process.env.PILOT_ENDPOINT ?? "https://keyenergy.io/api/pilot/readings";
const STATE = process.env.PILOT_WATCH_FILE ?? "state/watch.json";
const LOG = process.env.RELAY_LOG ?? "state/last-run.log";
const SENDERS = (process.env.PILOT_WATCH_SENDERS ?? "darmstadt").split(",");
const SILENT_HOURS = 24;
const DRY = !!process.env.DRY_RUN;

const headers = (profile) => ({ apikey: KEY, Authorization: `Bearer ${KEY}`, [profile[0]]: profile[1], "Content-Type": "application/json" });

async function tell(text, urgent) {
  if (DRY) return console.log(`DRY tell (${urgent ? "urgent" : "normal"}): ${text}`);
  const r = await fetch(`${SUPABASE}/agent_messages`, {
    method: "POST",
    headers: headers(["Content-Profile", "smm"]),
    body: JSON.stringify({ from_agent: "exergy_pilot_watch", to_agent: "zyalmakh", message: text, priority: urgent ? "urgent" : "normal" }),
  });
  if (!r.ok) console.log(`watch: could not send (${r.status})`);
}

async function problems() {
  const found = {};
  // 1. The relay.
  const exit = Number(process.env.RELAY_EXIT ?? 0);
  const log = fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf-8") : "";
  if (exit !== 0) found.relay = { urgent: true, text: `переводчик пилота упал: ${log.trim().split("\n").slice(-2).join(" / ").slice(0, 300)}` };
  const rejected = log.split("\n").filter((l) => l.startsWith("✗"));
  if (rejected.length) found.rejected = { urgent: true, text: `сеть отклонила ${rejected.length} показ.: ${rejected[0].slice(0, 250)}` };
  // 2. The endpoint.
  try {
    const r = await fetch(ENDPOINT, { signal: AbortSignal.timeout(15000) });
    if (!r.ok || !(await r.text()).includes("online")) found.endpoint = { urgent: true, text: `адрес приёма ${ENDPOINT} не отвечает (${r.status})` };
  } catch (e) {
    found.endpoint = { urgent: true, text: `адрес приёма ${ENDPOINT} не отвечает (${e.name})` };
  }
  // 3. Silence of a community.
  for (const name of SENDERS) {
    try {
      const [s] = await (await fetch(`${SUPABASE}/pilot_senders?name=eq.${name}&select=id`, { headers: headers(["Accept-Profile", "hq"]) })).json();
      if (!s) continue;
      const [last] = await (await fetch(`${SUPABASE}/pilot_readings?sender_id=eq.${s.id}&select=time&order=time.desc&limit=1`, { headers: headers(["Accept-Profile", "hq"]) })).json();
      if (!last) continue;
      const hours = (Date.now() - Date.parse(last.time)) / 3_600_000;
      if (hours > SILENT_HOURS) {
        found[`silent:${name}`] = {
          urgent: false,
          text: `${name}: новых показаний нет ${Math.floor(hours)} ч (последнее ${last.time.slice(0, 16).replace("T", " ")} UTC). Это может быть конец теста у них, не авария.`,
        };
      }
    } catch {
      // Storage unreachable: the endpoint check above covers the visible part.
    }
  }
  return found;
}

const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf-8")) : {};
const now = await problems();
for (const [k, p] of Object.entries(now)) {
  const s = (state[k] ??= { runs: 0, told: false });
  s.runs += 1;
  // Our failures must hold for two runs, so one slow RPC call does not wake anyone.
  if (!s.told && (k.startsWith("silent:") || s.runs >= 2)) {
    await tell(`⚠️ Пилот Exergy: ${p.text}`, p.urgent);
    s.told = true;
  }
}
for (const k of Object.keys(state)) {
  if (now[k]) continue;
  if (state[k].told) await tell(`✅ Пилот Exergy: снова в порядке (${k.replace("silent:", "")}).`, false);
  delete state[k];
}
if (!DRY) fs.writeFileSync(STATE, JSON.stringify(state));
console.log(`watch: ${Object.keys(now).length ? Object.keys(now).join(", ") : "all fine"}`);
