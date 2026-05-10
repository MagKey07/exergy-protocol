# @exergy/vpp-connector-sdk

Minimal TypeScript SDK for VPP operators integrating their battery cloud against the Exergy Protocol on Arbitrum Sepolia.

**About 250 lines of source. Single runtime dependency: `ethers v6`.** Designed to either depend on as a package or copy the four `src/` files directly into your codebase — both approaches are supported.

For the architectural and onboarding context, see [`docs/VPP_INTEGRATION_GUIDE.md`](../docs/VPP_INTEGRATION_GUIDE.md) at the repository root. This README covers installation and the SDK API only.

---

## Install

If consuming as a package (after publish):

```bash
npm install @exergy/vpp-connector-sdk
```

If copying into your codebase:

```
src/
├── packet.ts      # MeasurementPacket type + canonical hash builder
├── signing.ts     # device + VPP signature builders
├── submitter.ts   # OracleRouter submission with gas budget
├── abi.ts         # minimal ABIs for the four contracts you'll touch
├── addresses.ts   # live Sepolia deployment addresses
└── index.ts       # re-exports
```

Drop in `src/exergy/` (or wherever) and add `ethers@^6.13.4` to your dependencies.

---

## Quick mint

```typescript
import { ethers } from "ethers";
import {
  signPacket,
  submitMeasurement,
  ARBITRUM_SEPOLIA,
  kwhToWad,
  SourceType,
} from "@exergy/vpp-connector-sdk";

const provider = new ethers.JsonRpcProvider(ARBITRUM_SEPOLIA.rpcUrl);
const vppCloudWallet = new ethers.Wallet(process.env.VPP_CLOUD_PRIVATE_KEY!, provider);
const deviceWallet = new ethers.Wallet(process.env.DEVICE_PRIVATE_KEY!);

const packet = {
  deviceId: ethers.id("vpp:my-network:device:0001"),
  kwhAmount: kwhToWad(5.2),
  timestamp: BigInt(Math.floor(Date.now() / 1000)),
  storageCapacity: kwhToWad(13.5),
  chargeLevelPercent: 87,
  sourceType: SourceType.Solar,
  cumulativeCycles: 142,
};

const signed = await signPacket({ packet, deviceWallet, vppCloudWallet });

const result = await submitMeasurement({
  packet,
  signed,
  oracleRouterAddress: ARBITRUM_SEPOLIA.contracts.oracleRouter,
  signer: vppCloudWallet,
});

console.log("Minted in block", result.blockNumber, "tx", result.txHash);
```

Prerequisites for this code to actually mint:

1. Your VPP cloud wallet must hold `CHAINLINK_RELAYER_ROLE` on OracleRouter (one-time grant during onboarding — see Integration Guide §4.1).
2. The `deviceId` must be registered in OracleRouter against your VPP wallet (one-time admin call — see §4.3).
3. Your VPP cloud wallet must have approved `Settlement` on `XRGYToken` for `MaxUint256` (one-time, see §4.4).
4. Your VPP cloud wallet must have a small Sepolia ETH balance for gas.

---

## API reference

### `MeasurementPacket`

```typescript
interface MeasurementPacket {
  deviceId: string;            // bytes32, 0x-prefixed hex
  kwhAmount: bigint;           // 18-decimal fixed point
  timestamp: bigint;           // unix seconds
  storageCapacity: bigint;     // 18-decimal fixed point
  chargeLevelPercent: number;  // 0–100
  sourceType: SourceType;      // enum: Solar=0, Wind=1, Hydro=2, Other=3
  cumulativeCycles: number;    // monotonic per-device lifetime cycles
}
```

### `kwhToWad(kwh: number): bigint`

Convert human kWh to the 18-decimal fixed-point integer the contract expects. Uses two-stage multiplication for higher precision than `kwh * 1e18`.

### `signPacket(args): Promise<SignedPacket>`

Produce both signatures for a packet. Returns `{ packetHash, deviceSignature, vppSignature }`.

The function does:

1. `packetHash = keccak256(abi.encode(packet))`.
2. `deviceSignature = deviceWallet.signMessage(getBytes(packetHash))` — EIP-191 prefix.
3. `vppDigest = keccak256(abi.encode(packetHash, deviceSignature))` — note: only `(bytes32, bytes)`, no VPP address.
4. `vppSignature = vppCloudWallet.signMessage(getBytes(vppDigest))` — EIP-191 prefix.

### `submitMeasurement(args): Promise<SubmitMeasurementResult>`

Submit a signed packet to OracleRouter. Uses `gasLimit: 600_000n` by default — see "Why explicit gas limit" below.

### `simulateSubmitMeasurement(args): Promise<string | null>`

Pre-flight check using `staticCall`. Returns `null` if the call would succeed, or the revert reason string if it would fail. Use this before paying for a doomed transaction — useful for catching `InvalidDeviceSignature` or `ProofOfWearViolation` early.

### `devicePubKeyHashFor(address: string): string`

Compute the on-chain `devicePubKeyHash` value for a device wallet address. The contract stores the hash of the 20-byte address, NOT the public key bytes. Pass the result of this function as the third argument to `OracleRouter.registerDevice`.

### `ARBITRUM_SEPOLIA: NetworkDeployment`

Live deployment metadata: chainId, rpcUrl, all five contract addresses, deploy block.

### `MINTING_ENGINE_ABI`, `ORACLE_ROUTER_ABI`, `SETTLEMENT_ABI`, `XRGY_TOKEN_ABI`

Narrow ABI fragments covering only the functions and events most integrations need. If you need a wider surface, the full Solidity sources are in `MVP/contracts/` and the compiled artifacts in `MVP/contracts/artifacts/`.

---

## Why explicit gas limit

`MintingEngine.commitVerifiedEnergy` calls `Settlement.collectMintingFee` inside a Solidity `try/catch` block. Per [EIP-150](https://eips.ethereum.org/EIPS/eip-150), only 63/64 of the remaining gas is forwarded to the inner call. If `submitMeasurement` is called with a tight `estimateGas` value, the inner call OOG-reverts silently — the outer mint succeeds but the 1% protocol fee is never collected.

`DEFAULT_SUBMIT_GAS_LIMIT = 600_000n` is comfortably above the worst-case observed gas cost (~430k) on Arbitrum Sepolia. This Phase 0 workaround is removed in Phase 1 once the engine returns explicit success/failure from the fee call.

---

## Worked example

```bash
cd MVP/sdk
npm install
cp .env.example .env  # then fill in PRIVATE_KEY and DEVICE_LABEL
npm run example:submit
```

`examples/submit-one-packet.ts` is the smallest end-to-end script that exercises every primitive in the SDK against the live Sepolia deployment. Read it as the reference implementation.

---

## License

MIT — same as the protocol. See `LICENSE` at the repository root.
