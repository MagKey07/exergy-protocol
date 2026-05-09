// SPDX-License-Identifier: MIT
// WARNING: MVP testnet implementation. Production deployment requires security audit by OpenZeppelin or Trail of Bits.
pragma solidity ^0.8.24;

/**
 * @title IMintingEngine
 * @notice Core minting logic for $XRGY.
 *
 * Mechanics (per Technical_Blueprint.md §2.2 + §5):
 *  - Mint rate by era: era 0 = 1.0 token/kWh, era 1 = 0.5, era 2 = 0.25, …
 *  - Halving triggers when totalSupply >= halvingThreshold * (era + 1).
 *    Initial halvingThreshold = 1_000_000 * 1e18.
 *  - 24-hour epoch boundary (anti-gaming). All settlement, halving checks,
 *    and merkle commitments roll on epoch boundaries.
 *  - Floating index = totalVerifiedEnergyInStorage * 1e18 / totalSupply.
 *
 * IMPORTANT: There is NO burn anywhere in the system. The floating index
 * adjusts as totalVerifiedEnergyInStorage tracks physical reality (charging
 * adds, discharging subtracts) — token supply only moves up.
 */
interface IMintingEngine {
    /// @notice Per-epoch aggregate state.
    struct EpochData {
        uint256 totalVerifiedKwh;
        uint256 totalTokensMinted;
        bytes32 merkleRoot; // optional commitment (set by sealer/admin)
        bool sealed_; // trailing underscore: `sealed` is reserved
    }

    /**
     * @notice Per-device cycle history used for autonomous Proof-of-Wear enforcement.
     * @dev See Technical_Blueprint §5.6: Proof-of-Wear is the native Sybil resistance —
     *      every cycle physically degrades the battery; impossible cycle counts mean
     *      the device (or its VPP cloud) is lying. We reject those packets at the
     *      mint contract, autonomously, with no admin override.
     * @param lastCumulativeCycles The most recently accepted cumulativeCycles for this device.
     * @param lastEpoch The epoch in which `lastCumulativeCycles` was accepted (epoch counter, not seconds).
     * @param storageCapacity The device's storage capacity (kWh) as last attested by a
     *        successful packet. Locked in on first packet; later packets may only ATTEST
     *        equal-or-larger capacity (capacity shrink is rejected — physical batteries
     *        do not gain headroom mid-life).
     * @param initialized Whether this device has ever produced a successful packet.
     */
    struct DeviceCycleState {
        uint32 lastCumulativeCycles;
        uint64 lastEpoch;
        uint256 storageCapacity;
        bool initialized;
    }

    /// @notice Verified energy was added; tokens minted to VPP recipient.
    event EnergyMinted(
        bytes32 indexed deviceId,
        address indexed vppAddress,
        uint256 kwhAmount,
        uint256 tokensMinted,
        uint256 indexed epoch,
        uint256 era
    );
    /// @notice Halving boundary crossed mid-mint.
    event HalvingTriggered(uint256 indexed newEra, uint256 newRateNumerator, uint256 totalSupplyAtHalving);
    /// @notice Per-epoch merkle commitment was published.
    event EpochMerkleRootSet(uint256 indexed epoch, bytes32 merkleRoot);
    /// @notice Epoch was sealed (no more writes accepted).
    event EpochSealed(uint256 indexed epoch);
    /// @notice OracleRouter address bound to this engine.
    event OracleRouterSet(address indexed oracleRouter);
    /// @notice Settlement contract bound to this engine.
    event SettlementSet(address indexed settlement);
    /// @notice Total verified energy in storage adjusted (e.g. by Settlement on consumption).
    event TotalVerifiedEnergyChanged(int256 deltaKwh, uint256 newTotalKwh);
    /// @notice Admin override of epoch state (testnet only — see TestHooks).
    event AdminEpochStateOverridden(uint256 indexed epoch, string field, uint256 oldValue, uint256 newValue);
    /**
     * @notice A measurement was rejected by autonomous Proof-of-Wear / capacity logic.
     * @dev Emitted *before* revert in `commitVerifiedEnergy` so off-chain monitors can
     *      reconstruct the rejection without re-simulating. Indexed by deviceId because
     *      Sybil patterns cluster per-device.
     * @param deviceId The device whose packet was rejected.
     * @param vppAddress The VPP that co-signed the rejected packet.
     * @param kwhAmount The kWh amount in the rejected packet.
     * @param cumulativeCycles The cumulativeCycles in the rejected packet.
     * @param reason A bytes32 reason tag (`"PROOF_OF_WEAR"`, `"ENERGY_EXCEEDS_CAPACITY"`,
     *        `"CAPACITY_SHRINK"`).
     */
    event AnomalyRejected(
        bytes32 indexed deviceId,
        address indexed vppAddress,
        uint256 kwhAmount,
        uint32 cumulativeCycles,
        bytes32 reason
    );
    /// @notice First successful packet for a device — its cycle state was bootstrapped.
    event DeviceCycleStateInitialized(
        bytes32 indexed deviceId,
        uint32 cumulativeCycles,
        uint64 epoch,
        uint256 storageCapacity
    );

    /// @notice Caller is not the authorized OracleRouter.
    error NotOracleRouter();
    /// @notice Caller is not the authorized Settlement contract.
    error NotSettlement();
    /// @notice Provided address is the zero address.
    error ZeroAddress();
    /// @notice Address has already been wired (one-time setter).
    error AlreadySet();
    /// @notice Epoch is sealed; cannot write.
    error EpochAlreadySealed(uint256 epoch);
    /// @notice Mint amount underflows to zero (kwhAmount × rate < 1 wei).
    error MintAmountZero();
    /// @notice kWh delta would cause totalVerifiedEnergyInStorage to underflow.
    error EnergyUnderflow();
    /**
     * @notice Cycle delta exceeds the physically-possible cap (Proof-of-Wear violation).
     * @dev See Blueprint §5.6. Lithium-ion residential batteries cycle ~1× per day under
     *      normal duty; we cap at 2 cycles per epoch (24h) plus a margin. Anything above
     *      means the device is reporting impossible wear — i.e. wash-trading or simulation.
     */
    error ProofOfWearViolation(uint256 cyclesDelta, uint256 maxAllowed);
    /**
     * @notice kWh claimed in this packet exceeds storageCapacity × cyclesDelta — i.e. the
     *         packet asserts more energy moved through the battery than the battery can
     *         physically hold given its declared capacity and the cycles since last packet.
     */
    error EnergyExceedsCapacity(uint256 claimed, uint256 max);
    /**
     * @notice The packet attests a SMALLER storage capacity than was previously locked in.
     * @dev Physical batteries do not grow back. Capacity may stay the same or grow (e.g. a
     *      neighbor expansion that we treat as a re-registration). Any shrink is treated as
     *      a hostile re-attestation — we reject so an attacker cannot lie capacity DOWN to
     *      fit an inflated kWh under the energy-vs-capacity check.
     */
    error CapacityShrinkRejected(uint256 priorCapacity, uint256 attestedCapacity);
    /// @notice Packet's cumulativeCycles is lower than the last accepted value (monotonicity).
    error CycleCounterRegression(uint32 priorCycles, uint32 attestedCycles);

    /**
     * @notice Called exclusively by OracleRouter when a measurement passes signature verification.
     * @dev The router has already established that the device + VPP cloud both signed this
     *      payload (Anti-Simulation Lock). This function performs the SECOND, autonomous,
     *      on-chain trust check: Proof-of-Wear + capacity sanity. If the cycle delta or the
     *      claimed kWh is physically impossible for the device's storage size, the packet is
     *      rejected and `AnomalyRejected` is emitted before the revert.
     *
     *      This is the load-bearing implementation of Technical_Blueprint §5.6 — the
     *      "rejected by the minting contract at the epoch boundary" clause. Per CORE_THESIS
     *      this differentiator vs PoW/PoS MUST be enforcement, not decoration.
     *
     * @param deviceId Source device.
     * @param vppAddress Recipient of newly-minted tokens (the VPP operator).
     * @param kwhAmount Verified energy added in kWh (integer).
     * @param cumulativeCycles Lifetime cycle counter from the device firmware (Proof-of-Wear).
     *        Must be monotonically increasing and within the per-epoch cap.
     * @param storageCapacity The device's storage capacity (kWh). On the first successful
     *        packet this is locked into MintingEngine state. Subsequent packets may attest
     *        equal-or-greater capacity but never less.
     * @return tokensMinted Amount of $XRGY minted (18 decimals).
     */
    function commitVerifiedEnergy(
        bytes32 deviceId,
        address vppAddress,
        uint256 kwhAmount,
        uint32 cumulativeCycles,
        uint256 storageCapacity
    ) external returns (uint256 tokensMinted);

    /**
     * @notice Settlement reports that energy left storage (consumption / discharge).
     *         Reduces totalVerifiedEnergyInStorage WITHOUT burning tokens.
     * @param kwhConsumed Quantity in integer kWh.
     */
    function recordEnergyConsumption(uint256 kwhConsumed) external;

    /// @notice Read the current per-kWh mint rate, expressed as numerator/denominator over 1e18 wei.
    /// @return rateNumerator How many wei of $XRGY are minted per 1 kWh.
    function currentMintRateWeiPerKwh() external view returns (uint256 rateNumerator);

    /// @notice Current era index (0, 1, 2, …).
    function currentEra() external view returns (uint256);

    /// @notice Floating index in 18-decimal fixed point: totalVerifiedEnergyInStorage * 1e18 / totalSupply.
    /// @dev Returns 0 when totalSupply is 0.
    function getFloatingIndex() external view returns (uint256);

    /// @notice Current epoch number (epoch = (block.timestamp - genesisTimestamp) / EPOCH_DURATION).
    function currentEpoch() external view returns (uint256);

    /// @notice Read aggregate state for an epoch.
    function getEpochData(uint256 epoch) external view returns (EpochData memory);

    /// @notice Total verified energy currently held in protocol-tracked storage (kWh, integer).
    function totalVerifiedEnergyInStorage() external view returns (uint256);

    /// @notice Cumulative tokens minted since genesis.
    function totalTokensMinted() external view returns (uint256);

    /**
     * @notice Per-epoch ceiling on cycle deltas accepted from a single device.
     * @dev Industry baseline (NREL, lithium-ion residential): ~1 full charge/discharge
     *      cycle per day. EPOCH_DURATION = 24h. We allow 2× that (one full cycle plus a
     *      generous margin for partial discharges and clock skew between epochs). Anything
     *      above means the battery is reporting wear that exceeds physical possibility.
     *
     *      This constant is INTENTIONALLY autonomous and unchangeable — there is no
     *      `setMaxCycles`, no admin override, no governance vote. CORE_THESIS §5.5
     *      ("no human reviews, no subjective decisions") binds this code.
     */
    function MAX_CYCLES_PER_EPOCH() external view returns (uint256);

    /// @notice Read the per-device Proof-of-Wear state.
    function getDeviceCycleState(bytes32 deviceId) external view returns (DeviceCycleState memory);
}
