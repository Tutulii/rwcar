// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice Two-of-three signed price oracle. Prices are settlement-token units per whole asset,
/// scaled by 1e18. Every nonce is globally single-use and attestations have explicit validity.
contract SignedValuationOracle is Ownable2Step, EIP712 {
    struct Attestation {
        address asset;
        address settlementToken;
        uint256 priceE18;
        uint64 observedAt;
        uint64 validUntil;
        uint256 nonce;
        bytes32 evidenceHash;
    }

    struct Valuation {
        uint256 priceE18;
        uint64 observedAt;
        uint64 validUntil;
        uint256 nonce;
        bytes32 digest;
        address settlementToken;
        bytes32 evidenceHash;
    }

    bytes32 public constant ATTESTATION_TYPEHASH = keccak256(
        "Attestation(address asset,address settlementToken,uint256 priceE18,uint64 observedAt,uint64 validUntil,uint256 nonce,bytes32 evidenceHash)"
    );
    uint256 public constant SIGNER_COUNT = 3;
    uint256 public constant THRESHOLD = 2;
    uint64 public constant SIGNER_ROTATION_DELAY = 2 days;

    struct PendingSignerSet {
        address[3] signers;
        uint64 executeAfter;
        bytes32 signerSetHash;
    }

    error InvalidAddress();
    error InvalidSignerSet();
    error InvalidAttestation();
    error InvalidSignatureCount();
    error UnauthorizedSigner(address signer);
    error DuplicateSigner(address signer);
    error NonceUnavailable(uint256 nonce);
    error ValuationNotNewer();
    error StaleValuation(address asset);
    error SignerRotationNotReady();
    error SignerSetHashMismatch();

    mapping(address signer => bool allowed) public isSigner;
    mapping(address asset => mapping(uint256 nonce => bool unavailable)) public nonceUnavailable;
    mapping(address asset => uint256 nonce) public lastNonce;
    mapping(address asset => bytes32 digest) public invalidatedLatestDigest;
    mapping(address asset => Valuation valuation) private _latest;
    address[3] private _signers;
    PendingSignerSet private _pendingSignerSet;

    event ValuationAccepted(
        address indexed asset,
        uint256 priceE18,
        uint64 observedAt,
        uint64 validUntil,
        uint256 indexed nonce,
        bytes32 indexed digest,
        address settlementToken,
        bytes32 evidenceHash
    );
    event NonceInvalidated(address indexed asset, uint256 indexed nonce);
    event ValuationInvalidated(address indexed asset, uint256 indexed nonce, bytes32 indexed digest);
    event SignerSetScheduled(bytes32 indexed signerSetHash, uint64 executeAfter, address[3] signers);
    event SignerSetApplied(bytes32 indexed signerSetHash, address[3] signers);

    constructor(address initialOwner, address[3] memory signers)
        Ownable(initialOwner)
        EIP712("RWCAR Signed Valuation Oracle", "2")
    {
        if (initialOwner == address(0)) revert InvalidAddress();
        for (uint256 i; i < SIGNER_COUNT; ++i) {
            address signer = signers[i];
            if (signer == address(0) || isSigner[signer]) revert InvalidSignerSet();
            isSigner[signer] = true;
            _signers[i] = signer;
        }
    }

    function submit(Attestation calldata attestation, bytes[] calldata signatures) external returns (bytes32 digest) {
        if (
            attestation.asset == address(0) || attestation.settlementToken == address(0)
                || attestation.evidenceHash == bytes32(0) || attestation.priceE18 == 0
                || attestation.observedAt > block.timestamp
                || attestation.validUntil < block.timestamp || attestation.validUntil <= attestation.observedAt
        ) revert InvalidAttestation();
        if (nonceUnavailable[attestation.asset][attestation.nonce] || attestation.nonce <= lastNonce[attestation.asset]) {
            revert NonceUnavailable(attestation.nonce);
        }
        if (signatures.length < THRESHOLD || signatures.length > SIGNER_COUNT) revert InvalidSignatureCount();

        Valuation storage previous = _latest[attestation.asset];
        if (attestation.observedAt <= previous.observedAt) revert ValuationNotNewer();

        bytes32 structHash = keccak256(
            abi.encode(
                ATTESTATION_TYPEHASH,
                attestation.asset,
                attestation.settlementToken,
                attestation.priceE18,
                attestation.observedAt,
                attestation.validUntil,
                attestation.nonce,
                attestation.evidenceHash
            )
        );
        digest = _hashTypedDataV4(structHash);

        address[] memory recovered = new address[](signatures.length);
        for (uint256 i; i < signatures.length; ++i) {
            address signer = ECDSA.recover(digest, signatures[i]);
            if (!isSigner[signer]) revert UnauthorizedSigner(signer);
            for (uint256 j; j < i; ++j) {
                if (recovered[j] == signer) revert DuplicateSigner(signer);
            }
            recovered[i] = signer;
        }

        nonceUnavailable[attestation.asset][attestation.nonce] = true;
        lastNonce[attestation.asset] = attestation.nonce;
        _latest[attestation.asset] = Valuation({
            priceE18: attestation.priceE18,
            observedAt: attestation.observedAt,
            validUntil: attestation.validUntil,
            nonce: attestation.nonce,
            digest: digest,
            settlementToken: attestation.settlementToken,
            evidenceHash: attestation.evidenceHash
        });
        delete invalidatedLatestDigest[attestation.asset];
        emit ValuationAccepted(
            attestation.asset,
            attestation.priceE18,
            attestation.observedAt,
            attestation.validUntil,
            attestation.nonce,
            digest,
            attestation.settlementToken,
            attestation.evidenceHash
        );
    }

    function invalidateNonce(address asset, uint256 nonce) external onlyOwner {
        if (asset == address(0) || nonceUnavailable[asset][nonce]) revert NonceUnavailable(nonce);
        nonceUnavailable[asset][nonce] = true;
        emit NonceInvalidated(asset, nonce);
    }

    function invalidateValuation(address asset, bytes32 expectedDigest) external onlyOwner {
        Valuation storage valuation = _latest[asset];
        if (valuation.digest == bytes32(0) || valuation.digest != expectedDigest) revert InvalidAttestation();
        invalidatedLatestDigest[asset] = expectedDigest;
        emit ValuationInvalidated(asset, valuation.nonce, expectedDigest);
    }

    function scheduleSignerSet(address[3] calldata signers) external onlyOwner {
        _validateSignerSet(signers);
        bytes32 signerSetHash = keccak256(abi.encode(signers));
        uint64 executeAfter = uint64(block.timestamp) + SIGNER_ROTATION_DELAY;
        _pendingSignerSet = PendingSignerSet(signers, executeAfter, signerSetHash);
        emit SignerSetScheduled(signerSetHash, executeAfter, signers);
    }

    function applySignerSet(address[3] calldata signers) external onlyOwner {
        PendingSignerSet storage pending = _pendingSignerSet;
        if (pending.signerSetHash == bytes32(0) || block.timestamp < pending.executeAfter) {
            revert SignerRotationNotReady();
        }
        bytes32 signerSetHash = keccak256(abi.encode(signers));
        if (signerSetHash != pending.signerSetHash) revert SignerSetHashMismatch();
        for (uint256 i; i < SIGNER_COUNT; ++i) isSigner[_signers[i]] = false;
        for (uint256 i; i < SIGNER_COUNT; ++i) {
            isSigner[signers[i]] = true;
            _signers[i] = signers[i];
        }
        delete _pendingSignerSet;
        emit SignerSetApplied(signerSetHash, signers);
    }

    function signerSet() external view returns (address[3] memory) {
        return _signers;
    }

    function pendingSignerSet() external view returns (PendingSignerSet memory) {
        return _pendingSignerSet;
    }

    function latest(address asset) external view returns (Valuation memory) {
        return _latest[asset];
    }

    function freshPrice(address asset, address settlementToken, uint256 maxAge)
        external
        view
        returns (uint256 priceE18, uint64 observedAt, bytes32 digest)
    {
        Valuation storage valuation = _latest[asset];
        if (
            valuation.priceE18 == 0 || invalidatedLatestDigest[asset] == valuation.digest
                || valuation.settlementToken != settlementToken
                || valuation.validUntil < block.timestamp
                || uint256(valuation.observedAt) + maxAge < block.timestamp
        ) revert StaleValuation(asset);
        return (valuation.priceE18, valuation.observedAt, valuation.digest);
    }

    function hashAttestation(Attestation calldata attestation) external view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ATTESTATION_TYPEHASH,
                    attestation.asset,
                    attestation.settlementToken,
                    attestation.priceE18,
                    attestation.observedAt,
                    attestation.validUntil,
                    attestation.nonce,
                    attestation.evidenceHash
                )
            )
        );
    }

    function _validateSignerSet(address[3] calldata signers) private pure {
        for (uint256 i; i < SIGNER_COUNT; ++i) {
            if (signers[i] == address(0)) revert InvalidSignerSet();
            for (uint256 j; j < i; ++j) {
                if (signers[i] == signers[j]) revert InvalidSignerSet();
            }
        }
    }

}
