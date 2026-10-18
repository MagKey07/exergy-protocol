// SPDX-License-Identifier: BUSL-1.1
// WARNING: MVP testnet implementation. Production deployment requires security audit by OpenZeppelin or Trail of Bits.
pragma solidity ^0.8.24;

/**
 * @title ISettlement
 * @notice Token transfer + fee router for the protocol.
 *
 * CRITICAL: NO BURN. Tokens are money, not coupons. When a participant
 * settles energy with a provider, the token transfers to the provider and
 * keeps circulating. The floating index self-regulates as the MintingEngine
 * tracks totalVerifiedEnergyInStorage moving with physical reality.
 *
 * Fee structure (protocol constitution):
 *  - Every mint (taken inside MintingEngine): Key Energy treasury 10% for the
 *    first four years after mainnet, then 5%; insurance reserve 1%; the rest to
 *    the community that stored the energy.
 *  - Settlement fee: 0.25% of every settle, paid on top, 100% to the Key Energy
 *    treasury; corridor 0.1–0.5%. Never charged on plain transfers.
 */
interface ISettlement {
    /// @notice Routing buckets for fee distribution.
    struct FeeRecipients {
        address treasury; // Key Energy treasury: mint share + settlement fee
        address team; // unused since 18.10.2026 (kept for storage layout)
        address ecosystem; // unused since 18.10.2026 (kept for storage layout)
        address insurance; // network insurance reserve: 1% of every mint
    }

    /// @notice A participant settled energy with a provider.
    event EnergySettled(
        address indexed payer,
        address indexed provider,
        uint256 tokensTransferred,
        uint256 kwhConsumed,
        uint256 feePaid
    );
    /// @notice Cross-VPP transfer (settlement between participants of different VPPs).
    event CrossVPPSettled(
        address indexed payer,
        address indexed receiver,
        bytes32 indexed counterpartyVPPId,
        uint256 tokensTransferred,
        uint256 feePaid
    );
    /// @notice A participant was placed into (or removed from, vppId == 0) a VPP perimeter.
    event ParticipantVPPSet(address indexed participant, bytes32 indexed vppId);
    /// @notice A settlement fee was paid to the Key Energy treasury.
    event SettlementFeePaid(address indexed treasury, uint256 amount);
    /// @notice Fee recipients were updated.
    event FeeRecipientsUpdated(FeeRecipients recipients);
    /// @notice Settlement fee bps was changed.
    event SettlementFeeBpsUpdated(uint256 newBps);

    /// @notice Caller is not the MintingEngine.
    error NotMintingEngine();
    /// @notice Provided address is the zero address.
    error ZeroAddress();
    /// @notice Settlement fee outside the constitutional corridor (10–50 bps).
    error SettlementFeeOutOfCorridor(uint256 bps);
    /// @notice Settling 0 tokens is not allowed.
    error AmountZero();
    /// @notice Allowance/balance insufficient for the requested settle amount.
    error InsufficientFunds();
    /// @notice settleEnergy is energy for a note, delivered over a wire: payer and
    ///         provider must be registered in the same VPP perimeter.
    error OutsidePerimeter(address payer, address provider);
    /// @notice Caller may not manage VPP perimeters.
    error NotPerimeterManager();
    /// @notice Energy for a note must name the kWh delivered.
    error KwhRequired();
    /// @notice Nothing is stored in the network, so a note has no kWh content to settle at.
    error NoEnergyBehindNotes();
    /// @notice Notes paid differ from kWh delivered ÷ floating index by more than the tolerance.
    error OffIndexRate(uint256 tokensPaid, uint256 tokensAtIndex);

    /**
     * @notice Settle energy consumption with a same-VPP provider.
     *         The full token amount transfers to the provider; the fee comes on top from the payer.
     * @param provider Energy provider receiving the tokens.
     * @param tokenAmount Amount of $XRGY transferred to the provider (pre-fee).
     * @param kwhConsumed kWh consumed; informs MintingEngine.totalVerifiedEnergyInStorage.
     */
    function settleEnergy(address provider, uint256 tokenAmount, uint256 kwhConsumed) external;
    /**
     * @notice Place a participant into a VPP perimeter (vppId == 0 removes it).
     * @dev Only addresses in the same perimeter can settle energy with each other.
     *      Moving a note anywhere stays open — see crossVPPSettle.
     */
    function setParticipantVPP(address participant, bytes32 vppId) external;
    /// @notice The VPP perimeter a participant belongs to (0 if none).
    function participantVPP(address participant) external view returns (bytes32);

    /**
     * @notice Cross-VPP P2P transfer: pay another VPP's participant.
     * @param receiver Recipient of the tokens.
     * @param counterpartyVPPId Off-chain identifier of receiver's VPP (audit / analytics).
     * @param tokenAmount Amount of $XRGY transferred to the receiver (pre-fee).
     */
    function crossVPPSettle(address receiver, bytes32 counterpartyVPPId, uint256 tokenAmount) external;

    /// @notice Update fee distribution recipients (admin).
    function setFeeRecipients(FeeRecipients calldata recipients) external;

    /// @notice Update settlement fee in basis points (admin), only inside the 10–50 bps corridor.
    function setSettlementFeeBps(uint256 newBps) external;

    /// @notice View current fee recipients.
    function feeRecipients() external view returns (FeeRecipients memory);

    /// @notice View current fee bps.
    function settlementFeeBps() external view returns (uint256);
}
