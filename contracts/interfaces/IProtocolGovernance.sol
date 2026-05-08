// SPDX-License-Identifier: MIT
// WARNING: MVP testnet implementation. Production deployment requires security audit by OpenZeppelin or Trail of Bits.
pragma solidity ^0.8.24;

/**
 * @title IProtocolGovernance
 * @notice Admin / governance hub.
 *
 * Responsibilities (per Technical_Blueprint.md §2.5):
 *  - VPP registration and deactivation.
 *  - Parameter changes (mint rate ceilings, fee bps, epoch length).
 *    Production: 48-hour timelock. MVP: single owner address (no timelock).
 *  - Emergency pause (circuit breaker) for the entire protocol.
 *  - Two-step ownership transfer (uses OZ Ownable2StepUpgradeable).
 *  - UUPS upgrade authority for proxied contracts (Engine / Router / Settlement / itself).
 */
interface IProtocolGovernance {
    /// @notice Registered VPP record.
    struct VPPRecord {
        bytes32 vppId; // off-chain identifier
        address operatorAddress; // on-chain signer / treasury for the VPP
        bool active;
        uint64 registeredAt;
    }

    /// @notice A VPP was registered.
    event VPPRegistered(bytes32 indexed vppId, address indexed operatorAddress);
    /// @notice A VPP's active flag changed.
    event VPPActiveStatusChanged(bytes32 indexed vppId, bool active);
    /// @notice Protocol pause toggled.
    event ProtocolPauseToggled(bool paused);
    /// @notice Bound a managed contract (Engine / Router / Settlement / Token) for upgrade tracking.
    event ManagedContractSet(bytes32 indexed key, address indexed addr);

    /// @notice VPP id is already registered.
    error VPPAlreadyRegistered(bytes32 vppId);
    /// @notice VPP id is not registered.
    error VPPNotRegistered(bytes32 vppId);
    /// @notice Provided address is the zero address.
    error ZeroAddress();

    /**
     * @notice Register a new VPP. Restricted to GOVERNOR_ROLE.
     * @param vppId Off-chain identifier (e.g. keccak256("LEIGH_GOODMAN_VPP_UK_01")).
     * @param operatorAddress On-chain address that signs VPP-cloud measurements + receives mints.
     */
    function registerVPP(bytes32 vppId, address operatorAddress) external;

    /// @notice Activate / deactivate a registered VPP. Restricted to GOVERNOR_ROLE.
    function setVPPActive(bytes32 vppId, bool active) external;

    /// @notice Pause the protocol (emergency). Restricted to PAUSER_ROLE.
    function pauseProtocol() external;

    /// @notice Unpause the protocol. Restricted to GOVERNOR_ROLE.
    function unpauseProtocol() external;

    /// @notice Register a managed contract address by key (engine/router/settlement/token).
    function setManagedContract(bytes32 key, address addr) external;

    /// @notice Lookup VPP by id.
    function getVPP(bytes32 vppId) external view returns (VPPRecord memory);

    /// @notice Returns true if `addr` is the registered operator of an active VPP.
    function isActiveVPPOperator(address addr) external view returns (bool);

    /// @notice Returns the address of a managed contract by key.
    function getManagedContract(bytes32 key) external view returns (address);
}
