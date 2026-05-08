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
     * @notice Called exclusively by OracleRouter when a measurement passes verification.
     * @param deviceId Source device.
     * @param vppAddress Recipient of newly-minted tokens (the VPP operator).
     * @param kwhAmount Verified energy added in kWh (integer).
     * @return tokensMinted Amount of $XRGY minted (18 decimals).
     */
    function commitVerifiedEnergy(
        bytes32 deviceId,
        address vppAddress,
        uint256 kwhAmount
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
}
