// Shadow pilot relay: battery readings from the pilot endpoint → measurement packets on the test network.
//
// Communities forward state-of-charge readings to keyenergy.io/api/pilot/readings (stored in
// Supabase hq.pilot_readings). This script turns them into dual-signed packets and submits them.
// In the shadow pilot we hold the device and community keys ourselves; in a live pilot the
// meter signs. Nothing here talks to a battery.
//
// How readings become packets (follows MintingEngine rules):
//  • first packet of a battery: state-of-charge report, kwhAmount 0 — its existing charge joins
//    the stock without minting;
//  • charge lower than on chain: state-of-charge report (kwhAmount 0), the figure on notes falls;
//  • charge higher than on chain: a packet with the new energy, sent when a charging session ends
//    (Proof-of-Wear: a packet with energy must add at least one cycle; we count each charging
//    session as one cycle, as battery controllers do, at most 2 per day). While the battery is still
//    charging the rise waits, and no lower report is sent above the chain level.
//  • at most one packet per battery per hour; readings older than 72h are skipped (router window).
//
// Origin rules (decided 04.11.2026, OracleRouter since 06.11):
//  • every packet goes through submitMeasurementWithOrigin; the community signs how much of the
//    charge came from other participants. The pilot format carries no allocation data yet, so the
//    community states 0;
//  • notes mint only in a community of two or more independent participants (own metering point).
//    A battery name comes from the sender and proves nothing: one sender could invent two names and
//    look like two households. So the relay never makes up a metering point. Key Energy confirms each
//    battery's point by hand (grid-operator id from the community) in PILOT_POINTS_FILE,
//    { "<sender>": { "<battery>": "<metering point id>" } }; the relay applies it only on an admin run
//    (REGISTER_COMMUNITIES=1). Until then the battery stores and reports, and mints nothing.
//
// Keys and state live outside the repository: ~/.secrets/exergy_pilot_devices.json.
//
// Plain ethers, no Hardhat, so it runs on a small server every hour:
//   SUPABASE_SERVICE_KEY=… PRIVATE_KEY=… node --experimental-strip-types scripts/pilot-relay.ts
//   NETWORK=arbitrumSepolia (default) reads deployments/<NETWORK>.json; RPC_URL overrides the RPC.
//   DRY_RUN=1 prints the packets and sends nothing. PILOT_STATE_FILE overrides the state file.

import fs from "fs";
import os from "os";
import path from "path";
import { ethers } from "ethers";

const NETWORK = process.env.NETWORK ?? "arbitrumSepolia";
const RPC_URL = process.env.RPC_URL ?? (NETWORK === "localhost" ? "http://127.0.0.1:8545" : "https://sepolia-rollup.arbitrum.io/rpc");
const DEPLOYMENTS = process.env.DEPLOYMENTS_DIR ?? path.resolve(import.meta.dirname, "../deployments");
const PACKET_ABI = "(bytes32 deviceId,uint256 kwhAmount,uint64 timestamp,uint256 storageCapacity,uint8 chargeLevelPercent,uint8 sourceType,uint32 cumulativeCycles)";
const ROUTER_ABI = [
  "function registerDevice(bytes32 deviceId, address vppAddress, bytes32 devicePubKeyHash)",
  `function submitMeasurementWithOrigin(${PACKET_ABI} packet, uint256 kwhFromMembers, bytes deviceSignature, bytes vppSignature)`,
  "function setDeviceMeteringPoint(bytes32 deviceId, bytes32 meteringPoint)",
  "error MembersEnergyExceedsCharge(uint256,uint256)", "error InvalidDeviceSignature()", "error InvalidVPPSignature()", "error DuplicateMeasurement(bytes32)",
  "error TimestampOutOfWindow()", "error SourceNotAllowed(uint8)", "error DeviceNotRegistered(bytes32)",
];
const GOV_ABI = ["function registerVPP(bytes32 vppId, address operatorAddress)"];
const ENGINE_ABI = [
  "function totalVerifiedEnergyInStorage() view returns (uint256)", "function totalTokensMinted() view returns (uint256)",
  "function getFloatingIndex() view returns (uint256)",
  "error ProofOfWearViolation(uint256,uint256)", "error EnergyExceedsCapacity(uint256,uint256)",
  "error ChargeRiseWithoutEnergy(uint256,uint256)", "error CapacityShrinkRejected(uint256,uint256)",
];

const WAD = 10n ** 18n;
const SUPABASE = "https://dgqozsxkqqfbvthibvhs.supabase.co/rest/v1";
const STATE_FILE = process.env.PILOT_STATE_FILE ?? path.join(os.homedir(), ".secrets", "exergy_pilot_devices.json");
const POINTS_FILE = process.env.PILOT_POINTS_FILE ?? path.join(os.homedir(), ".secrets", "exergy_pilot_points.json");
const MAX_AGE_S = 72 * 3600 - 600;
const MAX_CYCLES_PER_DAY = 2;
const DRY = !!process.env.DRY_RUN;
// Source per battery: a market battery charges from the grid at its owner's cost (4); home batteries mostly from solar (0).
const sourceFor = (battery: string) => (battery.toLowerCase().includes("bickenbach") ? 4 : 0);

interface Device {
  deviceKey: string;
  registered: boolean;
  pointSet?: boolean;    // placed behind its metering point (independence rule)
  lastTime?: string;     // last reading consumed
  chainHeldKwh?: number; // what the chain believes the battery holds
  sessions: number;      // completed charging sessions = cycles
  charging?: boolean;
  lastSoc?: number;
  reportedCycles?: number;
  lastPacketDay?: number;
  initialized: boolean;
}
interface Community { cloudKey: string; registered: boolean; devices: Record<string, Device> }
type State = Record<string, Community>; // by sender name

const PACKET_TYPE =
  "tuple(bytes32 deviceId,uint256 kwhAmount,uint64 timestamp,uint256 storageCapacity,uint8 chargeLevelPercent,uint8 sourceType,uint32 cumulativeCycles)";
const kwh = (x: number) => BigInt(Math.round(x * 1e6)) * (WAD / 1_000_000n);
const day = (t: number) => Math.floor(t / 86400);

async function sb(q: string) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_KEY is not set");
  const r = await fetch(`${SUPABASE}/${q}`, { headers: { apikey: key, Authorization: `Bearer ${key}`, "Accept-Profile": "hq" } });
  if (!r.ok) throw new Error(`supabase ${r.status}: ${await r.text()}`);
  return r.json();
}

// Contract truth: keccak256(abi.encodePacked(device address)), as in seed-test-data.ts.
function devicePubKeyHash(pk: string) {
  return ethers.solidityPackedKeccak256(["address"], [new ethers.Wallet(pk).address]);
}

async function main() {
  const book = JSON.parse(fs.readFileSync(path.join(DEPLOYMENTS, `${NETWORK}.json`), "utf-8"));
  if (!process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY is not set");
  const signer = new ethers.NonceManager(new ethers.Wallet(process.env.PRIVATE_KEY, new ethers.JsonRpcProvider(RPC_URL)));
  const router = new ethers.Contract(book.contracts.OracleRouter, [...ROUTER_ABI, ...ENGINE_ABI.filter((x) => x.startsWith("error"))], signer);
  const governance = new ethers.Contract(book.contracts.ProtocolGovernance, GOV_ABI, signer);
  const engine = new ethers.Contract(book.contracts.MintingEngine, [...ENGINE_ABI, ...ROUTER_ABI.filter((x) => x.startsWith("error"))], signer);
  const points: Record<string, Record<string, string>> = fs.existsSync(POINTS_FILE) ? JSON.parse(fs.readFileSync(POINTS_FILE, "utf-8")) : {};
  const state: State = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) : {};
  const save = () => { if (!DRY) { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1)); fs.chmodSync(STATE_FILE, 0o600); } };

  const senders = (await sb("pilot_senders?active=eq.true&select=id,name")) as { id: number; name: string }[];
  const now = Math.floor(Date.now() / 1000);

  for (const s of senders) {
    const batteries = (await sb(`pilot_readings?sender_id=eq.${s.id}&select=battery&order=battery`)) as { battery: string }[];
    const names = [...new Set(batteries.map((b) => b.battery))];
    if (!names.length) continue;

    // A community is admitted once, by the network's governor (GOVERNOR_ROLE), not by this relay.
    // REGISTER_COMMUNITIES=1 lets an admin run register new ones.
    const com = (state[s.name] ??= { cloudKey: ethers.Wallet.createRandom().privateKey, registered: false, devices: {} });
    const cloud = new ethers.Wallet(com.cloudKey);
    if (!com.registered) {
      if (!process.env.REGISTER_COMMUNITIES) { console.log(`skip ${s.name}: community not admitted yet`); continue; }
      console.log(`register community ${s.name} (cloud ${cloud.address})`);
      if (!DRY) { await (await governance.registerVPP(ethers.id(`pilot:${s.name}`), cloud.address)).wait(); com.registered = true; save(); }
    }

    for (const name of names) {
      const dev = (com.devices[name] ??= { deviceKey: ethers.Wallet.createRandom().privateKey, registered: false, sessions: 0, initialized: false });
      const deviceId = ethers.id(`pilot:${s.name}:${name}`);
      if (!dev.registered) {
        console.log(`  register battery ${name} (${deviceId.slice(0, 12)}…)`);
        if (!DRY) { await (await router.registerDevice(deviceId, cloud.address, devicePubKeyHash(dev.deviceKey))).wait(); dev.registered = true; save(); }
      }
      const point = points[s.name]?.[name];
      if (!dev.pointSet && point && process.env.REGISTER_COMMUNITIES) {
        console.log(`  metering point for ${name}: confirmed ${point}`);
        if (!DRY) { await (await router.setDeviceMeteringPoint(deviceId, ethers.id(`metering-point:${point}`))).wait(); dev.pointSet = true; save(); }
      } else if (!dev.pointSet) {
        console.log(`  ${name}: no confirmed metering point, stores without notes`);
      }
      const device = new ethers.Wallet(dev.deviceKey);

      const after = dev.lastTime ? `&time=gt.${encodeURIComponent(dev.lastTime)}` : "";
      const rows = (await sb(`pilot_readings?sender_id=eq.${s.id}&battery=eq.${encodeURIComponent(name)}${after}&select=time,soc_percent,capacity_kwh,energy_in_kwh&order=time&limit=5000`)) as
        { time: string; soc_percent: number; capacity_kwh: number; energy_in_kwh: number | null }[];
      if (!rows.length) continue;

      // Charging sessions from every reading; packets from the last reading of each hour.
      const hourly = new Map<number, { r: (typeof rows)[number]; sessions: number }>();
      for (const r of rows) {
        const soc = Number(r.soc_percent);
        if (dev.lastSoc != null) {
          if (soc > dev.lastSoc) dev.charging = true;
          else if (dev.charging) { dev.charging = false; dev.sessions += 1; }
        }
        dev.lastSoc = soc;
        hourly.set(Math.floor(Date.parse(r.time) / 3_600_000), { r, sessions: dev.sessions });
      }

      for (const { r, sessions } of hourly.values()) {
        const t = Math.floor(Date.parse(r.time) / 1000);
        const cap = Number(r.capacity_kwh);
        const pct = Math.round(Number(r.soc_percent));
        const held = (cap * pct) / 100;
        const cycles = sessions;
        dev.lastTime = r.time;
        if (now - t > MAX_AGE_S) continue;

        let kwhAmount = 0;
        let reported = dev.reportedCycles ?? cycles;
        if (!dev.initialized) {
          kwhAmount = 0; // existing charge joins the stock, no notes
        } else if (held <= (dev.chainHeldKwh ?? 0)) {
          kwhAmount = 0;
          if (held === dev.chainHeldKwh) continue;
        } else {
          const budget = MAX_CYCLES_PER_DAY * (day(t) - (dev.lastPacketDay ?? day(t)) + 1);
          reported = Math.min(cycles, (dev.reportedCycles ?? 0) + budget);
          if (reported <= (dev.reportedCycles ?? 0)) continue; // rise waits for a full cycle
          kwhAmount = held - (dev.chainHeldKwh ?? 0);
        }

        const packet = {
          deviceId, kwhAmount: kwh(kwhAmount), timestamp: t, storageCapacity: kwh(cap),
          chargeLevelPercent: pct, sourceType: sourceFor(name), cumulativeCycles: reported,
        };
        const pHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode([PACKET_TYPE], [[
          packet.deviceId, packet.kwhAmount, packet.timestamp, packet.storageCapacity,
          packet.chargeLevelPercent, packet.sourceType, packet.cumulativeCycles]]));
        const devSig = await device.signMessage(ethers.getBytes(pHash));
        const kwhFromMembers = 0n; // no allocation data in the pilot format yet
        const vppSig = await cloud.signMessage(ethers.getBytes(ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "bytes", "uint256"], [pHash, devSig, kwhFromMembers]))));

        const label = `  ${name} ${r.time} ${pct}% held ${held.toFixed(1)} kWh new ${kwhAmount.toFixed(1)} cycles ${reported}`;
        if (DRY) { console.log("DRY" + label); }
        else {
          try {
            await (await router.submitMeasurementWithOrigin(packet, kwhFromMembers, devSig, vppSig)).wait();
            console.log("✓" + label);
          } catch (e: any) {
            console.log("✗" + label + " — " + (e.shortMessage ?? e.message));
            continue;
          }
        }
        dev.initialized = true;
        dev.chainHeldKwh = held;
        dev.reportedCycles = reported;
        dev.lastPacketDay = day(t);
      }
      save();
    }
  }

  const supply = await engine.totalTokensMinted();
  const index = supply > 0n ? await engine.getFloatingIndex() : 0n;
  console.log(`network: ${ethers.formatUnits(await engine.totalVerifiedEnergyInStorage(), 18)} kWh stored, ${ethers.formatUnits(supply, 18)} notes, ${ethers.formatUnits(index, 18)} kWh per note`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
