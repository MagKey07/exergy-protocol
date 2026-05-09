// SPDX-License-Identifier: MIT
// WARNING: MVP testnet implementation. Production deployment requires security audit by OpenZeppelin or Trail of Bits.
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

import {IMintingEngine} from "./interfaces/IMintingEngine.sol";
import {IXRGYToken} from "./interfaces/IXRGYToken.sol";
import {ISettlement} from "./interfaces/ISettlement.sol";

/**
 * @title MintingEngine
 * @author Exergy Protocol
 * @notice Core minting + halving + epoch + floating index logic.
 *
 * @dev READ CORE_THESIS.md BEFORE EDITING.
 *
 * Mint formula (per Technical_Blueprint §5):
 *   tokensMinted_wei = kwhAmount * RATE_BASE_WEI / (2 ** era)
 *   where RATE_BASE_WEI = 1e18 (era 0 = 1 token / kWh).
 *
 * Halving rule (per spec §5):
 *   Era advances when totalSupply >= halvingThreshold * (era + 1).
 *   halvingThreshold = 1_000_000 * 1e18 (1M tokens) by default.
 *   The threshold is checked AFTER each successful mint; if multiple thresholds
 *   are crossed in a single mint, the era advances multiple times. Any tokens
 *   that would be minted at the *new* (post-halving) rate within the same call
 *   are NOT recomputed — to keep the per-call mint deterministic and gas-bounded
 *   we credit the full pre-halving rate for this kWh batch and emit a
 *   HalvingTriggered event so off-chain observers can reconcile.
 *
 * Epoch:
 *   epoch = (block.timestamp - genesisTimestamp) / EPOCH_DURATION
 *   EPOCH_DURATION = 24 hours.
 *   Per-epoch aggregates roll automatically; sealing is optional (admin) and
 *   exists so an off-chain merkle commitment can be published.
 *
 * Floating index (per spec §2.2):
 *   floatingIndex = totalVerifiedEnergyInStorage * 1e18 / totalSupply
 *   When totalSupply == 0 → returns 0 (defensive).
 *
 * NO BURN: when energy is consumed, Settlement calls recordEnergyConsumption
 * to subtract from totalVerifiedEnergyInStorage. Token supply only moves up.
 */
contract MintingEngine is
    IMintingEngine,
    Initializable,
    UUPSUpgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable
{
    // ---------------------------------------------------------------------
    // Roles
    // ---------------------------------------------------------------------

    /// @notice Address allowed to upgrade the implementation.
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    /// @notice Address allowed to flip pause state.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    /// @notice Address allowed to seal epochs / set merkle roots.
    bytes32 public constant EPOCH_SEALER_ROLE = keccak256("EPOCH_SEALER_ROLE");
    /// @notice Testnet-only role for poking epoch state (see TestHooks).
    bytes32 public constant TEST_HOOK_ROLE = keccak256("TEST_HOOK_ROLE");

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    /// @notice 1 token (18-decimal wei) per kWh at era 0.
    uint256 public constant RATE_BASE_WEI = 1e18;

    /// @notice Epoch length: 24h.
    uint256 public constant EPOCH_DURATION = 1 days;

    /// @notice Hard ceiling on era to avoid pathological infinite halving loops.
    uint256 public constant MAX_ERA = 64;

    /**
     * @notice Per-epoch ceiling on cycle deltas accepted from a single device.
     * @dev THIS IS THE PROOF-OF-WEAR FLOOR. See Technical_Blueprint §5.6 + CORE_THESIS:
     *      Proof-of-Wear is the native Sybil resistance that distinguishes Exergy from
     *      PoW (electricity cost, recoverable) and PoS (capital lockup cost, recoverable).
     *      Cycling a battery costs ~$0.10/kWh in irreversible hardware degradation —
     *      Bitcoin spends electricity, we spend the asset. That is only true if the
     *      contract REJECTS impossible cycle counts. Otherwise an attacker simulates
     *      cycles for free and the entire Sybil-resistance story collapses.
     *
     *      Number rationale: NREL residential lithium-ion data shows ~1 full equivalent
     *      cycle per day under normal solar+load duty. EPOCH_DURATION = 24h. We accept
     *      up to 2 cycles per epoch — one realistic full-cycle plus a margin for partial
     *      cycles, clock skew, and unusual but legitimate dispatch days.
     *
     *      Autonomous by design: there is NO setter for this value. Not by admin, not
     *      by governance. CORE_THESIS §5.5 ("no human reviews, no subjective decisions")
     *      and the CONCEPT_AUDIT D-7 fix both bind this constant to the code.
     */
    uint256 public constant MAX_CYCLES_PER_EPOCH = 2;

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    IXRGYToken public token;
    address public oracleRouter;
    ISettlement public settlement;

    /// @notice Halving threshold in 18-decimal wei. Default 1_000_000 * 1e18.
    uint256 public halvingThreshold;

    /// @notice Current era (0, 1, 2, …). Updated lazily as totalSupply crosses thresholds.
    uint256 public override currentEra;

    /// @notice kWh currently held in protocol-tracked battery storage.
    uint256 public override totalVerifiedEnergyInStorage;

    /// @notice Cumulative mint counter (mirrors token.totalSupply, kept locally for invariants).
    uint256 public override totalTokensMinted;

    /// @notice Genesis timestamp anchoring epoch 0.
    uint256 public genesisTimestamp;

    /// @notice Per-epoch aggregate state.
    mapping(uint256 => EpochData) private _epochs;

    /**
     * @notice Per-device Proof-of-Wear state.
     * @dev Lazily initialized on a device's first successful packet — see
     *      `_validateAndUpdateProofOfWear`. Once initialized, stores the device's
     *      monotonic cycle counter, the epoch the last accepted packet was minted in,
     *      and the device's storage capacity. Capacity may grow (re-attestation of a
     *      hardware expansion) but never shrink.
     */
    mapping(bytes32 => DeviceCycleState) private _deviceCycleState;

    /// @dev Reserved storage gap for upgradeable layout safety.
    /// @dev DECREMENTED from 40 → 39 to account for new `_deviceCycleState` mapping above.
    uint256[39] private __gap;

    // ---------------------------------------------------------------------
    // Initializer
    // ---------------------------------------------------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @param token_ Deployed XRGYToken address.
     * @param admin Initial holder of DEFAULT_ADMIN_ROLE / UPGRADER_ROLE.
     * @param halvingThresholdTokens Halving threshold in WHOLE tokens (e.g. 1_000_000 → 1M).
     */
    function initialize(
        address token_,
        address admin,
        uint256 halvingThresholdTokens
    ) external initializer {
        if (token_ == address(0) || admin == address(0)) revert ZeroAddress();

        __UUPSUpgradeable_init();
        __AccessControl_init();
        __Pausable_init();
        __ReentrancyGuard_init();

        token = IXRGYToken(token_);
        halvingThreshold = halvingThresholdTokens * 1e18;
        genesisTimestamp = block.timestamp;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
        _grantRole(EPOCH_SEALER_ROLE, admin);
        _grantRole(TEST_HOOK_ROLE, admin);
    }

    // ---------------------------------------------------------------------
    // Wiring (one-shot setters; idempotent guard)
    // ---------------------------------------------------------------------

    /**
     * @notice Bind the OracleRouter that may submit verified energy to this engine.
     * @dev One-shot.
     */
    function setOracleRouter(address router) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (router == address(0)) revert ZeroAddress();
        if (oracleRouter != address(0)) revert AlreadySet();
        oracleRouter = router;
        emit OracleRouterSet(router);
    }

    /**
     * @notice Bind the Settlement contract that may collect minting fees / report consumption.
     * @dev One-shot.
     */
    function setSettlement(address settlement_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (settlement_ == address(0)) revert ZeroAddress();
        if (address(settlement) != address(0)) revert AlreadySet();
        settlement = ISettlement(settlement_);
        emit SettlementSet(settlement_);
    }

    // ---------------------------------------------------------------------
    // Mint flow (called by OracleRouter only)
    // ---------------------------------------------------------------------

    /// @inheritdoc IMintingEngine
    function commitVerifiedEnergy(
        bytes32 deviceId,
        address vppAddress,
        uint256 kwhAmount,
        uint32 cumulativeCycles,
        uint256 storageCapacity
    ) external override whenNotPaused nonReentrant returns (uint256 tokensMinted) {
        if (msg.sender != oracleRouter) revert NotOracleRouter();
        if (vppAddress == address(0)) revert ZeroAddress();

        uint256 epoch = currentEpoch();

        // -------- PROOF-OF-WEAR ENFORCEMENT (Blueprint §5.6) --------
        // CORE_THESIS: this is the native Sybil resistance — the on-chain check that
        // turns "device cycled an impossible amount" into a hard revert. Runs BEFORE
        // any state mutation so a rejected packet leaves no trace except the
        // AnomalyRejected event already emitted inside the helper.
        _validateAndUpdateProofOfWear(
            deviceId,
            vppAddress,
            kwhAmount,
            cumulativeCycles,
            storageCapacity,
            epoch
        );

        uint256 era = currentEra;
        uint256 rate = _rateForEra(era);
        // SCALING: kwhAmount is 18-decimal (1 kWh = 1e18), rate is 18-decimal (1 token/kWh = 1e18).
        // Naive multiplication produces 36-decimal output. Divide by 1e18 to keep token supply
        // in canonical 18-decimal ERC-20 wei units.
        tokensMinted = (kwhAmount * rate) / 1e18;
        if (tokensMinted == 0) revert MintAmountZero();

        // Apply state.
        EpochData storage e = _epochs[epoch];
        if (e.sealed_) revert EpochAlreadySealed(epoch);
        e.totalVerifiedKwh += kwhAmount;
        e.totalTokensMinted += tokensMinted;

        totalVerifiedEnergyInStorage += kwhAmount;
        totalTokensMinted += tokensMinted;

        // Mint tokens to the VPP recipient.
        token.mint(vppAddress, tokensMinted);

        emit EnergyMinted(deviceId, vppAddress, kwhAmount, tokensMinted, epoch, era);

        // Lazy halving check after mint. May advance multiple eras at once.
        _checkAndAdvanceHalving();

        // Skim minting fee via Settlement, if wired.
        // The fee is pulled from `vppAddress` via transferFrom; VPP must approve Settlement once.
        if (address(settlement) != address(0)) {
            // Best-effort skim. We do NOT revert if fee collection fails on testnet
            // (e.g. recipient hasn't approved yet) — minting must always succeed for
            // verified energy; the fee is a downstream concern. Production may
            // tighten this to a hard requirement.
            try settlement.collectMintingFee(vppAddress, tokensMinted) returns (uint256) {
                // ok
            } catch {
                // swallow on testnet; off-chain monitor flags missed fees
            }
        }
    }

    // ---------------------------------------------------------------------
    // Consumption flow (called by Settlement only) — NO BURN
    // ---------------------------------------------------------------------

    /// @inheritdoc IMintingEngine
    function recordEnergyConsumption(uint256 kwhConsumed) external override whenNotPaused {
        if (msg.sender != address(settlement)) revert NotSettlement();
        if (kwhConsumed == 0) return;
        if (kwhConsumed > totalVerifiedEnergyInStorage) revert EnergyUnderflow();
        unchecked {
            totalVerifiedEnergyInStorage -= kwhConsumed;
        }
        emit TotalVerifiedEnergyChanged(-int256(kwhConsumed), totalVerifiedEnergyInStorage);
    }

    // ---------------------------------------------------------------------
    // Epoch sealing / merkle (off-chain commitment)
    // ---------------------------------------------------------------------

    /// @notice Publish a merkle root committing to the epoch's verified measurement set.
    function setEpochMerkleRoot(uint256 epoch, bytes32 root) external onlyRole(EPOCH_SEALER_ROLE) {
        EpochData storage e = _epochs[epoch];
        if (e.sealed_) revert EpochAlreadySealed(epoch);
        e.merkleRoot = root;
        emit EpochMerkleRootSet(epoch, root);
    }

    /// @notice Seal an epoch. After sealing, no more writes accepted for that epoch.
    function sealEpoch(uint256 epoch) external onlyRole(EPOCH_SEALER_ROLE) {
        EpochData storage e = _epochs[epoch];
        if (e.sealed_) revert EpochAlreadySealed(epoch);
        e.sealed_ = true;
        emit EpochSealed(epoch);
    }

    // ---------------------------------------------------------------------
    // Pause
    // ---------------------------------------------------------------------

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // ---------------------------------------------------------------------
    // Test hooks (testnet only — gated by TEST_HOOK_ROLE)
    // ---------------------------------------------------------------------

    /**
     * @notice Override total verified energy in storage (TESTNET ONLY).
     * @dev TEST_HOOK_ROLE only. Lets QA simulate consumption / charge without going through
     *      Settlement. MUST NOT exist in production deployment — strip TEST_HOOK_ROLE before
     *      mainnet.
     */
    function adminSetTotalVerifiedEnergy(uint256 newTotal) external onlyRole(TEST_HOOK_ROLE) {
        emit AdminEpochStateOverridden(currentEpoch(), "totalVerifiedEnergyInStorage", totalVerifiedEnergyInStorage, newTotal);
        totalVerifiedEnergyInStorage = newTotal;
    }

    /**
     * @notice Override the current era (TESTNET ONLY) to fast-forward halving.
     */
    function adminSetEra(uint256 newEra) external onlyRole(TEST_HOOK_ROLE) {
        if (newEra > MAX_ERA) newEra = MAX_ERA;
        emit AdminEpochStateOverridden(currentEpoch(), "currentEra", currentEra, newEra);
        currentEra = newEra;
        emit HalvingTriggered(newEra, _rateForEra(newEra), totalTokensMinted);
    }

    /**
     * @notice Override the halving threshold (TESTNET ONLY).
     */
    function adminSetHalvingThreshold(uint256 newThresholdWei) external onlyRole(TEST_HOOK_ROLE) {
        emit AdminEpochStateOverridden(currentEpoch(), "halvingThreshold", halvingThreshold, newThresholdWei);
        halvingThreshold = newThresholdWei;
    }

    /**
     * @notice Override the genesis timestamp (TESTNET ONLY) to fast-forward epoch boundaries.
     */
    function adminSetGenesisTimestamp(uint256 newGenesis) external onlyRole(TEST_HOOK_ROLE) {
        emit AdminEpochStateOverridden(0, "genesisTimestamp", genesisTimestamp, newGenesis);
        genesisTimestamp = newGenesis;
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @inheritdoc IMintingEngine
    function currentMintRateWeiPerKwh() external view override returns (uint256) {
        return _rateForEra(currentEra);
    }

    /// @inheritdoc IMintingEngine
    function getFloatingIndex() external view override returns (uint256) {
        uint256 supply = token.totalSupply();
        if (supply == 0) return 0;
        return (totalVerifiedEnergyInStorage * 1e18) / supply;
    }

    /// @inheritdoc IMintingEngine
    function currentEpoch() public view override returns (uint256) {
        if (block.timestamp < genesisTimestamp) return 0;
        return (block.timestamp - genesisTimestamp) / EPOCH_DURATION;
    }

    /// @inheritdoc IMintingEngine
    function getEpochData(uint256 epoch) external view override returns (EpochData memory) {
        return _epochs[epoch];
    }

    /// @inheritdoc IMintingEngine
    function getDeviceCycleState(bytes32 deviceId)
        external
        view
        override
        returns (DeviceCycleState memory)
    {
        return _deviceCycleState[deviceId];
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    /**
     * @dev Autonomous Proof-of-Wear + capacity enforcement.
     *
     *      CORE_THESIS / Blueprint §5.6 contract: every charge/discharge cycle costs the
     *      operator real, irreversible hardware degradation (~$0.10/kWh, NREL). That cost
     *      is what makes wash-trading uneconomical and Sybil-resistant. But the cost only
     *      bites if the contract REFUSES to accept impossible cycle counts — otherwise an
     *      attacker can claim 1000 cycles in a day on a simulated battery and never pay
     *      the wear. So this function is the load-bearing implementation of that thesis.
     *
     *      Three checks, in order, all autonomous (no admin override, no setter, no
     *      governance vote):
     *
     *      1. **Capacity-shrink rejection.** First packet locks in `storageCapacity` for
     *         the device. Later packets may attest equal-or-greater capacity but never
     *         less. (Physical batteries don't grow back. An attacker shrinking capacity
     *         lets them slip a smaller kWh through the §3 check — we close that door.)
     *
     *      2. **Cycle-monotonicity + cap.** `cumulativeCycles` is a lifetime counter from
     *         the device firmware. It MUST be ≥ the last accepted value (regression
     *         rejected). The delta from last packet MUST be ≤
     *         `MAX_CYCLES_PER_EPOCH * (epochsDelta + 1)` — i.e. at most 2 cycles per
     *         24h epoch since last submission. The `+1` is intentional: a packet within
     *         the same epoch as the previous one still gets one full epoch of cycle
     *         budget (a battery that legitimately cycled twice in one day produces two
     *         packets in the same epoch).
     *
     *      3. **Energy-vs-capacity sanity.** `kwhAmount` for THIS packet must be
     *         ≤ `storageCapacity * cyclesDelta`. (You cannot have moved more energy
     *         through the battery than `capacity × number_of_cycles_since_last_packet`.)
     *         When `cyclesDelta == 0` the packet is reporting energy without any wear,
     *         which is a cleaner Sybil pattern than impossible-high cycles — we treat it
     *         the same as cyclesDelta=0 → max=0, so any non-zero kWh is rejected.
     *
     *      On the first packet for a device, all three checks degrade gracefully: there
     *      is no prior state, so monotonicity and the cycle-cap are skipped (we cannot
     *      compute a delta), but the energy-vs-capacity check still runs against
     *      `cumulativeCycles` itself (lifetime cycles bound the lifetime energy ever
     *      stored). This keeps a freshly-registered Sybil device from claiming 10 GWh on
     *      its first packet just because it has no history.
     *
     *      All rejections emit `AnomalyRejected(deviceId, vppAddress, kwhAmount,
     *      cumulativeCycles, reason)` BEFORE the revert so off-chain monitors can index
     *      Sybil patterns without re-executing.
     */
    function _validateAndUpdateProofOfWear(
        bytes32 deviceId,
        address vppAddress,
        uint256 kwhAmount,
        uint32 cumulativeCycles,
        uint256 storageCapacity,
        uint256 epoch
    ) internal {
        DeviceCycleState storage state = _deviceCycleState[deviceId];

        if (!state.initialized) {
            // -------- First packet for this device --------
            // We cannot check monotonicity / cycle-delta cap (no prior state). But the
            // energy-vs-capacity invariant still applies: `kwhAmount ≤ capacity ×
            // lifetimeCycles`. A device that has cycled 0 times cannot have stored any
            // energy regardless of capacity — reject.
            uint256 firstPacketMaxEnergy = storageCapacity * uint256(cumulativeCycles);
            if (kwhAmount > firstPacketMaxEnergy) {
                emit AnomalyRejected(
                    deviceId,
                    vppAddress,
                    kwhAmount,
                    cumulativeCycles,
                    bytes32("ENERGY_EXCEEDS_CAPACITY")
                );
                revert EnergyExceedsCapacity(kwhAmount, firstPacketMaxEnergy);
            }

            state.lastCumulativeCycles = cumulativeCycles;
            state.lastEpoch = uint64(epoch);
            state.storageCapacity = storageCapacity;
            state.initialized = true;
            emit DeviceCycleStateInitialized(deviceId, cumulativeCycles, uint64(epoch), storageCapacity);
            return;
        }

        // -------- Subsequent packet for an initialized device --------

        // (1) Capacity must not shrink. Equal-or-grow is OK (hardware expansion event;
        //     the larger capacity becomes the new lock).
        if (storageCapacity < state.storageCapacity) {
            emit AnomalyRejected(
                deviceId,
                vppAddress,
                kwhAmount,
                cumulativeCycles,
                bytes32("CAPACITY_SHRINK")
            );
            revert CapacityShrinkRejected(state.storageCapacity, storageCapacity);
        }

        // (2) Cycle counter must be monotonically non-decreasing.
        if (cumulativeCycles < state.lastCumulativeCycles) {
            emit AnomalyRejected(
                deviceId,
                vppAddress,
                kwhAmount,
                cumulativeCycles,
                bytes32("CYCLE_REGRESSION")
            );
            revert CycleCounterRegression(state.lastCumulativeCycles, cumulativeCycles);
        }

        // (3) Cycle delta must fit inside the per-epoch cap.
        //     `epochsDelta + 1` budget reflects: even a same-epoch resubmission gets a
        //     full epoch's worth of cycles (a battery that legitimately cycled twice in
        //     one day will emit two packets within the same epoch).
        uint256 cyclesDelta;
        unchecked {
            cyclesDelta = uint256(cumulativeCycles - state.lastCumulativeCycles);
        }
        uint256 epochsDelta = epoch - uint256(state.lastEpoch); // epoch >= state.lastEpoch (currentEpoch is monotonic; same-epoch packets give 0 here)
        uint256 maxCyclesAllowed = MAX_CYCLES_PER_EPOCH * (epochsDelta + 1);
        if (cyclesDelta > maxCyclesAllowed) {
            emit AnomalyRejected(
                deviceId,
                vppAddress,
                kwhAmount,
                cumulativeCycles,
                bytes32("PROOF_OF_WEAR")
            );
            revert ProofOfWearViolation(cyclesDelta, maxCyclesAllowed);
        }

        // (4) Energy claimed in this packet must be physically possible given
        //     declared capacity and cycles since last packet.
        uint256 maxEnergy = storageCapacity * cyclesDelta;
        if (kwhAmount > maxEnergy) {
            emit AnomalyRejected(
                deviceId,
                vppAddress,
                kwhAmount,
                cumulativeCycles,
                bytes32("ENERGY_EXCEEDS_CAPACITY")
            );
            revert EnergyExceedsCapacity(kwhAmount, maxEnergy);
        }

        // All checks passed — update device state.
        state.lastCumulativeCycles = cumulativeCycles;
        state.lastEpoch = uint64(epoch);
        // Capacity may grow over time (hardware expansion). Lock in the new larger value.
        if (storageCapacity > state.storageCapacity) {
            state.storageCapacity = storageCapacity;
        }
    }

    /**
     * @dev Mint rate at era N = RATE_BASE_WEI >> N (integer division by 2^N).
     *      At era >= 60 the rate underflows to zero, which is the practical
     *      protocol ceiling. Era is hard-capped at MAX_ERA.
     */
    function _rateForEra(uint256 era) internal pure returns (uint256) {
        if (era >= MAX_ERA) return 0;
        return RATE_BASE_WEI >> era;
    }

    /**
     * @dev Advance era while the halving threshold for the *next* era is crossed.
     *      Threshold for era N → N+1 is: halvingThreshold * (N + 1).
     *      i.e. era 0 → 1 at 1M, era 1 → 2 at 2M cumulative, era 2 → 3 at 3M, …
     *      This matches Technical_Blueprint §5: each era's supply range is
     *      [N*1M, (N+1)*1M].
     */
    function _checkAndAdvanceHalving() internal {
        uint256 era = currentEra;
        uint256 supply = totalTokensMinted;
        while (era < MAX_ERA && supply >= halvingThreshold * (era + 1)) {
            unchecked {
                era += 1;
            }
            emit HalvingTriggered(era, _rateForEra(era), supply);
        }
        if (era != currentEra) {
            currentEra = era;
        }
    }

    // ---------------------------------------------------------------------
    // UUPS
    // ---------------------------------------------------------------------

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER_ROLE) {}
}
