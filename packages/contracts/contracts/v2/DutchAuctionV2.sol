// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Deterministic linear-price auction state. The controlling engine performs token
/// settlement and compliance checks atomically with `markSold`.
contract DutchAuctionV2 {
    enum AuctionStatus {
        NONE,
        LIVE,
        SOLD,
        FAILED
    }

    struct Auction {
        uint8 referenceKind;
        uint64 startedAt;
        uint64 endsAt;
        uint128 assetAmount;
        uint256 startPrice;
        uint256 floorPrice;
        uint256 salePrice;
        uint256 referenceId;
        address buyer;
        AuctionStatus status;
    }

    error OnlyController();
    error InvalidAuction();
    error InvalidAmount();
    error InvalidStatus(AuctionStatus expected, AuctionStatus actual);
    error AuctionNotEnded();

    address public immutable controller;
    uint256 public nextAuctionId = 1;
    mapping(uint256 auctionId => Auction auction) private _auctions;
    mapping(bytes32 refHash => uint256 auctionId) public auctionForReference;

    event AuctionStarted(
        uint256 indexed auctionId,
        uint8 indexed referenceKind,
        uint256 indexed referenceId,
        uint256 assetAmount,
        uint256 startPrice,
        uint256 floorPrice,
        uint64 endsAt
    );
    event AuctionSold(uint256 indexed auctionId, address indexed buyer, uint256 price);
    event AuctionFailed(uint256 indexed auctionId);

    modifier onlyController() {
        if (msg.sender != controller) revert OnlyController();
        _;
    }

    constructor(address controller_) {
        if (controller_ == address(0)) revert InvalidAuction();
        controller = controller_;
    }

    function create(
        uint8 referenceKind,
        uint256 referenceId,
        uint256 assetAmount,
        uint256 startPrice,
        uint256 floorPrice,
        uint64 duration
    ) external onlyController returns (uint256 auctionId) {
        if (
            referenceKind == 0 || referenceId == 0 || assetAmount == 0 || startPrice == 0 || floorPrice == 0
                || floorPrice > startPrice || duration == 0 || assetAmount > type(uint128).max
        ) revert InvalidAmount();
        bytes32 refHash = keccak256(abi.encode(referenceKind, referenceId));
        if (auctionForReference[refHash] != 0) revert InvalidAuction();

        auctionId = nextAuctionId++;
        uint64 startedAt = uint64(block.timestamp);
        uint64 endsAt = startedAt + duration;
        _auctions[auctionId] = Auction({
            referenceKind: referenceKind,
            startedAt: startedAt,
            endsAt: endsAt,
            assetAmount: uint128(assetAmount),
            startPrice: startPrice,
            floorPrice: floorPrice,
            salePrice: 0,
            referenceId: referenceId,
            buyer: address(0),
            status: AuctionStatus.LIVE
        });
        auctionForReference[refHash] = auctionId;
        emit AuctionStarted(
            auctionId, referenceKind, referenceId, assetAmount, startPrice, floorPrice, endsAt
        );
    }

    function markSold(uint256 auctionId, address buyer, uint256 maxPrice)
        external
        onlyController
        returns (uint256 price)
    {
        Auction storage auction = _auctions[auctionId];
        _requireStatus(auction, AuctionStatus.LIVE);
        if (buyer == address(0) || block.timestamp > auction.endsAt) revert InvalidAuction();
        price = currentPrice(auctionId);
        if (price > maxPrice) revert InvalidAmount();
        auction.status = AuctionStatus.SOLD;
        auction.buyer = buyer;
        auction.salePrice = price;
        emit AuctionSold(auctionId, buyer, price);
    }

    function markFailed(uint256 auctionId) external onlyController {
        Auction storage auction = _auctions[auctionId];
        _requireStatus(auction, AuctionStatus.LIVE);
        if (block.timestamp <= auction.endsAt) revert AuctionNotEnded();
        auction.status = AuctionStatus.FAILED;
        emit AuctionFailed(auctionId);
    }

    function currentPrice(uint256 auctionId) public view returns (uint256) {
        Auction storage auction = _auctions[auctionId];
        if (auction.status != AuctionStatus.LIVE) {
            if (auction.status == AuctionStatus.SOLD) return auction.salePrice;
            revert InvalidAuction();
        }
        if (block.timestamp >= auction.endsAt) return auction.floorPrice;
        uint256 elapsed = block.timestamp - auction.startedAt;
        uint256 duration = auction.endsAt - auction.startedAt;
        uint256 discount = Math.mulDiv(uint256(auction.startPrice) - auction.floorPrice, elapsed, duration);
        return uint256(auction.startPrice) - discount;
    }

    function getAuction(uint256 auctionId) external view returns (Auction memory) {
        return _auctions[auctionId];
    }

    function _requireStatus(Auction storage auction, AuctionStatus expected) private view {
        if (auction.status != expected) revert InvalidStatus(expected, auction.status);
    }
}
