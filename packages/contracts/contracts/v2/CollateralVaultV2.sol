// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Single-CVA custody vault. All accounting mutations are exclusively controlled by
/// the market that deployed the vault; users never call the vault directly.
contract CollateralVaultV2 is ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant BUCKET_AVAILABLE = keccak256("AVAILABLE");
    bytes32 public constant BUCKET_OFFER_RESERVED = keccak256("OFFER_RESERVED");
    bytes32 public constant BUCKET_POSITION_LOCKED = keccak256("POSITION_LOCKED");
    bytes32 public constant BUCKET_AUCTION_LOCKED = keccak256("AUCTION_LOCKED");
    bytes32 public constant BUCKET_MARGIN_LOCKED = keccak256("MARGIN_LOCKED");

    struct Bucket {
        address owner;
        uint128 amount;
    }

    error OnlyController();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidOwner();
    error InsufficientAvailable(uint256 required, uint256 available);
    error InsufficientBucket(uint256 required, uint256 available);
    error NonExactTransfer(uint256 expected, uint256 received);
    error AccountedAssetRescueForbidden();

    IERC20 public immutable asset;
    address public immutable controller;
    uint256 public totalAccounted;

    mapping(address owner => uint256 amount) public availableBalance;
    mapping(uint256 offerId => Bucket bucket) private _offerReserved;
    mapping(uint256 positionId => Bucket bucket) private _positionLocked;
    mapping(uint256 auctionId => Bucket bucket) private _auctionLocked;
    mapping(uint256 accountId => Bucket bucket) private _marginLocked;

    event CollateralDeposited(address indexed owner, uint256 amount);
    event CollateralWithdrawn(address indexed owner, address indexed recipient, uint256 amount);
    event OfferReserved(uint256 indexed offerId, address indexed owner, uint256 amount);
    event OfferReleased(uint256 indexed offerId, address indexed owner, uint256 amount);
    event PositionAllocated(uint256 indexed offerId, uint256 indexed positionId, uint256 amount);
    event PositionReleased(uint256 indexed positionId, address indexed owner, uint256 amount);
    event PositionSeized(
        uint256 indexed positionId, address indexed owner, address indexed recipient, uint256 amount
    );
    event AuctionAllocated(uint256 indexed positionId, uint256 indexed auctionId, uint256 amount);
    event AuctionReleased(uint256 indexed auctionId, address indexed recipient, uint256 amount);
    event MarginReserved(uint256 indexed accountId, address indexed owner, uint256 amount);
    event MarginReleased(uint256 indexed accountId, address indexed owner, uint256 amount);
    event MarginAuctionAllocated(uint256 indexed accountId, uint256 indexed auctionId, uint256 amount);
    event ExcessTokenRescued(address indexed token, address indexed recipient, uint256 amount);
    event VaultBalanceChanged(
        address indexed account,
        address indexed asset,
        bytes32 indexed bucket,
        int256 delta,
        uint256 balanceAfter,
        bytes32 referenceType,
        uint256 referenceId,
        bytes32 reason
    );

    modifier onlyController() {
        if (msg.sender != controller) revert OnlyController();
        _;
    }

    constructor(address controller_, address asset_) {
        if (controller_ == address(0) || asset_ == address(0) || asset_.code.length == 0) revert InvalidAddress();
        controller = controller_;
        asset = IERC20(asset_);
    }

    function depositFor(address owner, uint256 amount) external onlyController nonReentrant {
        if (owner == address(0)) revert InvalidAddress();
        if (amount == 0 || amount > type(uint128).max) revert InvalidAmount();

        uint256 beforeBalance = asset.balanceOf(address(this));
        asset.safeTransferFrom(owner, address(this), amount);
        uint256 received = asset.balanceOf(address(this)) - beforeBalance;
        if (received != amount) revert NonExactTransfer(amount, received);

        availableBalance[owner] += amount;
        totalAccounted += amount;
        _emitBalance(owner, BUCKET_AVAILABLE, true, amount, availableBalance[owner], bytes32(0), 0, "DEPOSIT");
        emit CollateralDeposited(owner, amount);
    }

    function withdrawTo(address owner, address recipient, uint256 amount) external onlyController nonReentrant {
        if (owner == address(0) || recipient == address(0)) revert InvalidAddress();
        _debitAvailable(owner, amount);
        _emitBalance(owner, BUCKET_AVAILABLE, false, amount, availableBalance[owner], bytes32(0), 0, "WITHDRAW");
        totalAccounted -= amount;
        _transferAssetExact(recipient, amount);
        emit CollateralWithdrawn(owner, recipient, amount);
    }

    function reserveOffer(address owner, uint256 offerId, uint256 amount) external onlyController {
        if (owner == address(0) || amount == 0 || amount > type(uint128).max) revert InvalidAmount();
        Bucket storage bucket = _offerReserved[offerId];
        if (bucket.owner != address(0)) revert InvalidOwner();
        _debitAvailable(owner, amount);
        _emitBalance(owner, BUCKET_AVAILABLE, false, amount, availableBalance[owner], "OFFER", offerId, "RESERVE");
        bucket.owner = owner;
        bucket.amount = uint128(amount);
        _emitBalance(owner, BUCKET_OFFER_RESERVED, true, amount, amount, "OFFER", offerId, "RESERVE");
        emit OfferReserved(offerId, owner, amount);
    }

    function releaseOffer(address owner, uint256 offerId, uint256 amount) external onlyController {
        Bucket storage bucket = _offerReserved[offerId];
        _requireOwner(bucket, owner);
        _debitBucket(bucket, amount);
        uint256 reservedAfter = bucket.amount;
        availableBalance[owner] += amount;
        _emitBalance(owner, BUCKET_OFFER_RESERVED, false, amount, reservedAfter, "OFFER", offerId, "RELEASE");
        _emitBalance(owner, BUCKET_AVAILABLE, true, amount, availableBalance[owner], "OFFER", offerId, "RELEASE");
        if (bucket.amount == 0) delete _offerReserved[offerId];
        emit OfferReleased(offerId, owner, amount);
    }

    function allocatePosition(address owner, uint256 offerId, uint256 positionId, uint256 amount)
        external
        onlyController
    {
        Bucket storage offerSlot = _offerReserved[offerId];
        _requireOwner(offerSlot, owner);
        Bucket storage positionSlot = _positionLocked[positionId];
        if (positionSlot.owner != address(0)) revert InvalidOwner();
        _debitBucket(offerSlot, amount);
        uint256 offerAfter = offerSlot.amount;
        _emitBalance(owner, BUCKET_OFFER_RESERVED, false, amount, offerAfter, "POSITION", positionId, "ALLOCATE");
        if (offerSlot.amount == 0) delete _offerReserved[offerId];
        positionSlot.owner = owner;
        positionSlot.amount = uint128(amount);
        _emitBalance(owner, BUCKET_POSITION_LOCKED, true, amount, amount, "POSITION", positionId, "ALLOCATE");
        emit PositionAllocated(offerId, positionId, amount);
    }

    function releasePosition(address owner, uint256 positionId) external onlyController returns (uint256 amount) {
        Bucket storage bucket = _positionLocked[positionId];
        _requireOwner(bucket, owner);
        amount = bucket.amount;
        if (amount == 0) revert InvalidAmount();
        delete _positionLocked[positionId];
        availableBalance[owner] += amount;
        _emitBalance(owner, BUCKET_POSITION_LOCKED, false, amount, 0, "POSITION", positionId, "REPAY");
        _emitBalance(owner, BUCKET_AVAILABLE, true, amount, availableBalance[owner], "POSITION", positionId, "REPAY");
        emit PositionReleased(positionId, owner, amount);
    }

    function seizePosition(uint256 positionId, address recipient)
        external
        onlyController
        nonReentrant
        returns (uint256 amount)
    {
        if (recipient == address(0)) revert InvalidAddress();
        Bucket storage bucket = _positionLocked[positionId];
        address owner = bucket.owner;
        amount = bucket.amount;
        if (amount == 0) revert InvalidAmount();
        delete _positionLocked[positionId];
        _emitBalance(owner, BUCKET_POSITION_LOCKED, false, amount, 0, "POSITION", positionId, "STALE_ORACLE_CLAIM");
        totalAccounted -= amount;
        _transferAssetExact(recipient, amount);
        emit PositionSeized(positionId, owner, recipient, amount);
    }

    function allocateAuction(address owner, uint256 positionId, uint256 auctionId)
        external
        onlyController
        returns (uint256 amount)
    {
        Bucket storage positionSlot = _positionLocked[positionId];
        _requireOwner(positionSlot, owner);
        Bucket storage auctionSlot = _auctionLocked[auctionId];
        if (auctionSlot.owner != address(0)) revert InvalidOwner();
        amount = positionSlot.amount;
        if (amount == 0) revert InvalidAmount();
        delete _positionLocked[positionId];
        auctionSlot.owner = owner;
        auctionSlot.amount = uint128(amount);
        _emitBalance(owner, BUCKET_POSITION_LOCKED, false, amount, 0, "AUCTION", auctionId, "DEFAULT");
        _emitBalance(owner, BUCKET_AUCTION_LOCKED, true, amount, amount, "AUCTION", auctionId, "DEFAULT");
        emit AuctionAllocated(positionId, auctionId, amount);
    }

    function releaseAuction(uint256 auctionId, address recipient) external onlyController nonReentrant returns (uint256 amount) {
        if (recipient == address(0)) revert InvalidAddress();
        Bucket storage bucket = _auctionLocked[auctionId];
        amount = bucket.amount;
        if (amount == 0) revert InvalidAmount();
        address owner = bucket.owner;
        delete _auctionLocked[auctionId];
        _emitBalance(owner, BUCKET_AUCTION_LOCKED, false, amount, 0, "AUCTION", auctionId, "SETTLE");
        totalAccounted -= amount;
        _transferAssetExact(recipient, amount);
        emit AuctionReleased(auctionId, recipient, amount);
    }

    function releaseAuctionPartial(uint256 auctionId, address recipient, uint256 amount)
        external
        onlyController
        nonReentrant
    {
        if (recipient == address(0)) revert InvalidAddress();
        Bucket storage bucket = _auctionLocked[auctionId];
        address owner = bucket.owner;
        _debitBucket(bucket, amount);
        uint256 balanceAfter = bucket.amount;
        if (balanceAfter == 0) delete _auctionLocked[auctionId];
        _emitBalance(owner, BUCKET_AUCTION_LOCKED, false, amount, balanceAfter, "AUCTION", auctionId, "CLAIM");
        totalAccounted -= amount;
        _transferAssetExact(recipient, amount);
        emit AuctionReleased(auctionId, recipient, amount);
    }

    function reserveMargin(address owner, uint256 accountId, uint256 amount) external onlyController {
        if (owner == address(0) || amount == 0 || amount > type(uint128).max) revert InvalidAmount();
        Bucket storage bucket = _marginLocked[accountId];
        if (bucket.owner != address(0)) revert InvalidOwner();
        _debitAvailable(owner, amount);
        _emitBalance(owner, BUCKET_AVAILABLE, false, amount, availableBalance[owner], "MARGIN", accountId, "RESERVE");
        bucket.owner = owner;
        bucket.amount = uint128(amount);
        _emitBalance(owner, BUCKET_MARGIN_LOCKED, true, amount, amount, "MARGIN", accountId, "RESERVE");
        emit MarginReserved(accountId, owner, amount);
    }

    function addMargin(address owner, uint256 accountId, uint256 amount) external onlyController {
        Bucket storage bucket = _marginLocked[accountId];
        _requireOwner(bucket, owner);
        _debitAvailable(owner, amount);
        _emitBalance(owner, BUCKET_AVAILABLE, false, amount, availableBalance[owner], "MARGIN", accountId, "ADD_MARGIN");
        uint256 newAmount = uint256(bucket.amount) + amount;
        if (newAmount > type(uint128).max) revert InvalidAmount();
        bucket.amount = uint128(newAmount);
        _emitBalance(owner, BUCKET_MARGIN_LOCKED, true, amount, newAmount, "MARGIN", accountId, "ADD_MARGIN");
        emit MarginReserved(accountId, owner, amount);
    }

    function releaseMargin(address owner, uint256 accountId, uint256 amount) external onlyController {
        Bucket storage bucket = _marginLocked[accountId];
        _requireOwner(bucket, owner);
        _debitBucket(bucket, amount);
        uint256 marginAfter = bucket.amount;
        availableBalance[owner] += amount;
        _emitBalance(owner, BUCKET_MARGIN_LOCKED, false, amount, marginAfter, "MARGIN", accountId, "RELEASE");
        _emitBalance(owner, BUCKET_AVAILABLE, true, amount, availableBalance[owner], "MARGIN", accountId, "RELEASE");
        if (bucket.amount == 0) delete _marginLocked[accountId];
        emit MarginReleased(accountId, owner, amount);
    }

    function allocateMarginAuction(address owner, uint256 accountId, uint256 auctionId)
        external
        onlyController
        returns (uint256 amount)
    {
        Bucket storage marginSlot = _marginLocked[accountId];
        _requireOwner(marginSlot, owner);
        Bucket storage auctionSlot = _auctionLocked[auctionId];
        if (auctionSlot.owner != address(0)) revert InvalidOwner();
        amount = marginSlot.amount;
        if (amount == 0) revert InvalidAmount();
        delete _marginLocked[accountId];
        auctionSlot.owner = owner;
        auctionSlot.amount = uint128(amount);
        _emitBalance(owner, BUCKET_MARGIN_LOCKED, false, amount, 0, "AUCTION", auctionId, "LIQUIDATE");
        _emitBalance(owner, BUCKET_AUCTION_LOCKED, true, amount, amount, "AUCTION", auctionId, "LIQUIDATE");
        emit MarginAuctionAllocated(accountId, auctionId, amount);
    }

    function offerBucket(uint256 offerId) external view returns (Bucket memory) {
        return _offerReserved[offerId];
    }

    function positionBucket(uint256 positionId) external view returns (Bucket memory) {
        return _positionLocked[positionId];
    }

    function auctionBucket(uint256 auctionId) external view returns (Bucket memory) {
        return _auctionLocked[auctionId];
    }

    function marginBucket(uint256 accountId) external view returns (Bucket memory) {
        return _marginLocked[accountId];
    }

    /// @notice Rescue unrelated tokens, or only surplus accounted-token units sent directly to the vault.
    function rescueExcessToken(IERC20 token, address recipient, uint256 amount) external onlyController nonReentrant {
        if (recipient == address(0)) revert InvalidAddress();
        // Never expose accounted-asset liabilities to unusual transfer semantics. Direct CVA
        // donations remain a permanent solvency buffer and cannot be administratively seized.
        if (address(token) == address(asset)) revert AccountedAssetRescueForbidden();
        token.safeTransfer(recipient, amount);
        emit ExcessTokenRescued(address(token), recipient, amount);
    }

    function isSolvent() external view returns (bool) {
        return asset.balanceOf(address(this)) >= totalAccounted;
    }

    function _debitAvailable(address owner, uint256 amount) private {
        uint256 available = availableBalance[owner];
        if (amount == 0 || available < amount) revert InsufficientAvailable(amount, available);
        availableBalance[owner] = available - amount;
    }

    function _debitBucket(Bucket storage bucket, uint256 amount) private {
        uint256 available = bucket.amount;
        if (amount == 0 || available < amount) revert InsufficientBucket(amount, available);
        bucket.amount = uint128(available - amount);
    }

    function _requireOwner(Bucket storage bucket, address owner) private view {
        if (bucket.owner != owner || owner == address(0)) revert InvalidOwner();
    }

    function _transferAssetExact(address recipient, uint256 amount) private {
        uint256 vaultBefore = asset.balanceOf(address(this));
        uint256 recipientBefore = asset.balanceOf(recipient);
        asset.safeTransfer(recipient, amount);
        uint256 vaultAfter = asset.balanceOf(address(this));
        uint256 recipientAfter = asset.balanceOf(recipient);
        if (vaultBefore < vaultAfter || vaultBefore - vaultAfter != amount) {
            revert NonExactTransfer(amount, vaultBefore > vaultAfter ? vaultBefore - vaultAfter : 0);
        }
        uint256 received = recipientAfter >= recipientBefore ? recipientAfter - recipientBefore : 0;
        if (received != amount) revert NonExactTransfer(amount, received);
    }

    function _emitBalance(
        address account,
        bytes32 bucket,
        bool increase,
        uint256 amount,
        uint256 balanceAfter,
        bytes32 referenceType,
        uint256 referenceId,
        bytes32 reason
    ) private {
        if (amount > uint256(type(int256).max)) revert InvalidAmount();
        int256 delta = int256(amount);
        emit VaultBalanceChanged(
            account,
            address(asset),
            bucket,
            increase ? delta : -delta,
            balanceAfter,
            referenceType,
            referenceId,
            reason
        );
    }
}
