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

    /// @dev Reserved storage gap for upgradeable layout safety.
    uint256[40] private __gap;

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
        uint256 kwhAmount
    ) external override whenNotPaused nonReentrant returns (uint256 tokensMinted) {
        if (msg.sender != oracleRouter) revert NotOracleRouter();
        if (vppAddress == address(0)) revert ZeroAddress();

        uint256 era = currentEra;
        uint256 rate = _rateForEra(era);
        tokensMinted = kwhAmount * rate;
        if (tokensMinted == 0) revert MintAmountZero();

        // Apply state.
        uint256 epoch = currentEpoch();
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

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

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
