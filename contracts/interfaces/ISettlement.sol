// SPDX-License-Identifier: MIT
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
 * Fee structure (per Technical_Blueprint.md §2.4):
 *  - Minting fee: 1% of newly-minted tokens, taken inside Settlement only
 *    when invoked from a mint flow. (MVP: minting fee is collected directly
 *    by MintingEngine via this contract's `collectMintingFee` hook — see notes.)
 *  - Settlement fee: 0.25% of every settle transfer.
 *  - Distribution: Treasury 40%, Team 20%, Ecosystem 25%, Insurance 15%.
 */
interface ISettlement {
    /// @notice Routing buckets for fee distribution.
    struct FeeRecipients {
        address treasury; // 40%
        address team; // 20%
        address ecosystem; // 25%
        address insurance; // 15%
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
    /// @notice Fees were distributed to the four recipients.
    event FeesDistributed(uint256 treasuryAmt, uint256 teamAmt, uint256 ecosystemAmt, uint256 insuranceAmt);
    /// @notice Fee recipients were updated.
    event FeeRecipientsUpdated(FeeRecipients recipients);
    /// @notice Settlement fee bps was changed.
    event SettlementFeeBpsUpdated(uint256 newBps);
    /// @notice Minting fee bps was changed.
    event MintingFeeBpsUpdated(uint256 newBps);

    /// @notice Caller is not the MintingEngine.
    error NotMintingEngine();
    /// @notice Provided address is the zero address.
    error ZeroAddress();
    /// @notice Fee bps exceeds protocol-wide ceiling (10_000 = 100%).
    error FeeBpsTooHigh(uint256 bps);
    /// @notice Settling 0 tokens is not allowed.
    error AmountZero();
    /// @notice Allowance/balance insufficient for the requested settle amount.
    error InsufficientFunds();

    /**
     * @notice Settle energy consumption with a same-VPP provider.
     *         The full token amount transfers to the provider; the fee comes on top from the payer.
     * @param provider Energy provider receiving the tokens.
     * @param tokenAmount Amount of $XRGY transferred to the provider (pre-fee).
     * @param kwhConsumed kWh consumed; informs MintingEngine.totalVerifiedEnergyInStorage.
     */
    function settleEnergy(address provider, uint256 tokenAmount, uint256 kwhConsumed) external;

    /**
     * @notice Cross-VPP P2P transfer: pay another VPP's participant.
     * @param receiver Recipient of the tokens.
     * @param counterpartyVPPId Off-chain identifier of receiver's VPP (audit / analytics).
     * @param tokenAmount Amount of $XRGY transferred to the receiver (pre-fee).
     */
    function crossVPPSettle(address receiver, bytes32 counterpartyVPPId, uint256 tokenAmount) external;

    /**
     * @notice Hook used by MintingEngine to skim the 1% minting fee at mint time.
     * @dev Called immediately after MintingEngine mints to a VPP recipient.
     *      Settlement transferFroms the fee out of the recipient and distributes it.
     * @param mintRecipient The VPP that just received freshly-minted tokens.
     * @param grossMintedAmount The full amount minted (fee is calculated from this).
     * @return feeTaken Amount actually pulled from the recipient and distributed.
     */
    function collectMintingFee(address mintRecipient, uint256 grossMintedAmount) external returns (uint256 feeTaken);

    /// @notice Update fee distribution recipients (admin).
    function setFeeRecipients(FeeRecipients calldata recipients) external;

    /// @notice Update settlement fee in basis points (admin). Capped at MAX_FEE_BPS.
    function setSettlementFeeBps(uint256 newBps) external;

    /// @notice Update minting fee in basis points (admin). Capped at MAX_FEE_BPS.
    function setMintingFeeBps(uint256 newBps) external;

    /// @notice View current fee recipients.
    function feeRecipients() external view returns (FeeRecipients memory);

    /// @notice View current fee bps.
    function settlementFeeBps() external view returns (uint256);
    function mintingFeeBps() external view returns (uint256);
}
