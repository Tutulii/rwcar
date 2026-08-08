// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IComplianceValidator} from "../interfaces/IComplianceValidator.sol";

/// @notice Pull-payment escrow for settlement recipients that cannot receive an A-Token now.
/// The controller first transfers settlement tokens into this contract, then records claims.
contract SettlementEscrowV2 is ReentrancyGuard {
    using SafeERC20 for IERC20;

    error OnlyController();
    error InvalidAddress();
    error InvalidAmount();
    error InsufficientUnaccountedBalance(uint256 required, uint256 available);
    error InsufficientClaim(uint256 required, uint256 available);
    error ComplianceFailed(address recipient);
    error NonExactTransfer(uint256 expected, uint256 received);

    IERC20 public immutable settlementToken;
    IComplianceValidator public immutable validator;
    address public immutable policyPool;
    address public immutable controller;

    struct ClaimRecord {
        address beneficiary;
        bytes32 claimReference;
        uint256 remaining;
    }

    uint256 public nextClaimId = 1;
    uint256 public totalClaims;
    mapping(address beneficiary => uint256 amount) public claimable;
    mapping(uint256 claimId => ClaimRecord claimRecord) public claims;

    event ClaimRecorded(
        uint256 indexed claimId, address indexed beneficiary, uint256 amount, bytes32 indexed claimReference
    );
    event ClaimWithdrawn(
        uint256 indexed claimId, address indexed beneficiary, address indexed recipient, uint256 amount, uint256 remaining
    );

    modifier onlyController() {
        if (msg.sender != controller) revert OnlyController();
        _;
    }

    constructor(address controller_, address settlementToken_, address validator_, address policyPool_) {
        if (
            controller_ == address(0) || settlementToken_ == address(0) || validator_ == address(0)
                || policyPool_ == address(0)
        ) revert InvalidAddress();
        controller = controller_;
        settlementToken = IERC20(settlementToken_);
        validator = IComplianceValidator(validator_);
        policyPool = policyPool_;
    }

    /// @dev Tokens must already be in escrow. This makes claim accounting independent of token allowance semantics.
    function recordClaim(address beneficiary, uint256 amount, bytes32 claimReference)
        external
        onlyController
        returns (uint256 claimId)
    {
        if (beneficiary == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        uint256 balance = settlementToken.balanceOf(address(this));
        uint256 unaccounted = balance > totalClaims ? balance - totalClaims : 0;
        if (unaccounted < amount) revert InsufficientUnaccountedBalance(amount, unaccounted);
        totalClaims += amount;
        claimable[beneficiary] += amount;
        claimId = nextClaimId++;
        claims[claimId] = ClaimRecord(beneficiary, claimReference, amount);
        emit ClaimRecorded(claimId, beneficiary, amount, claimReference);
    }

    function claim(uint256 claimId, uint256 amount, address recipient) external nonReentrant {
        if (recipient == address(0)) revert InvalidAddress();
        ClaimRecord storage claimRecord = claims[claimId];
        if (claimRecord.beneficiary != msg.sender) revert InsufficientClaim(amount, 0);
        if (!validator.complianceVerify(policyPool, msg.sender)) revert ComplianceFailed(msg.sender);
        if (!validator.complianceVerify(policyPool, recipient)) revert ComplianceFailed(recipient);
        uint256 available = claimRecord.remaining;
        if (amount == 0 || amount > available) revert InsufficientClaim(amount, available);
        claimRecord.remaining = available - amount;
        claimable[msg.sender] -= amount;
        totalClaims -= amount;
        uint256 escrowBefore = settlementToken.balanceOf(address(this));
        uint256 recipientBefore = settlementToken.balanceOf(recipient);
        settlementToken.safeTransfer(recipient, amount);
        uint256 escrowAfter = settlementToken.balanceOf(address(this));
        uint256 recipientAfter = settlementToken.balanceOf(recipient);
        uint256 debited = escrowBefore >= escrowAfter ? escrowBefore - escrowAfter : 0;
        uint256 received = recipientAfter >= recipientBefore ? recipientAfter - recipientBefore : 0;
        if (debited != amount || received != amount) revert NonExactTransfer(amount, received);
        emit ClaimWithdrawn(claimId, msg.sender, recipient, amount, claimRecord.remaining);
    }
}
