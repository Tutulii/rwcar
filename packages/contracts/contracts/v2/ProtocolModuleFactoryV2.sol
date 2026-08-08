// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IComplianceValidator} from "../interfaces/IComplianceValidator.sol";
import {CollateralVaultV2} from "./CollateralVaultV2.sol";
import {DutchAuctionV2} from "./DutchAuctionV2.sol";
import {SettlementEscrowV2} from "./SettlementEscrowV2.sol";

/// @notice Deploys controller-bound protocol modules and, after Cleanverse grants this exact
/// factory REGISTER_ROLE, registers contract CVI only for custody modules it actually deployed.
contract ProtocolModuleFactoryV2 is Ownable2Step {
    enum ModuleType {
        NONE,
        COLLATERAL_VAULT,
        DUTCH_AUCTION,
        SETTLEMENT_ESCROW
    }

    error InvalidAddress();
    error InvalidCustodyModule();
    error CustodyTokenMismatch();
    error CustodyAlreadyRegistered();

    IComplianceValidator public immutable validator;
    mapping(address module => address controller) public moduleController;
    mapping(address module => address token) public moduleToken;
    mapping(address module => ModuleType moduleType) public moduleType;
    mapping(bytes32 registrationKey => bool registered) public custodyRegistered;

    event ModuleDeployed(address indexed controller, address indexed module, uint8 indexed moduleType, address asset);
    event CvaCustodyRegistered(
        address indexed pool,
        address indexed aToken,
        address indexed custodyAddress,
        bytes32 registrationKey
    );

    constructor(address initialOwner, address validator_) Ownable(initialOwner) {
        if (initialOwner == address(0) || validator_ == address(0) || validator_.code.length == 0) {
            revert InvalidAddress();
        }
        validator = IComplianceValidator(validator_);
    }

    function deployVault(address asset) external returns (address module) {
        module = address(new CollateralVaultV2(msg.sender, asset));
        _recordModule(module, msg.sender, asset, ModuleType.COLLATERAL_VAULT);
    }

    function deployAuction() external returns (address module) {
        module = address(new DutchAuctionV2(msg.sender));
        _recordModule(module, msg.sender, address(0), ModuleType.DUTCH_AUCTION);
    }

    function deploySettlementEscrow(address settlementToken, address validator_) external returns (address module) {
        if (validator_ != address(validator)) revert InvalidAddress();
        module = address(new SettlementEscrowV2(msg.sender, settlementToken, validator_, msg.sender));
        _recordModule(module, msg.sender, settlementToken, ModuleType.SETTLEMENT_ESCROW);
    }

    /// @notice The owner calls this only after the factory has REGISTER_ROLE and the pool has
    /// been registered with its approved RuleV2. The validator registers CVI for both the pool
    /// and `custodyAddress` (the documented `feeAddress` argument).
    function registerCvaCustody(address pool, address aToken, address custodyAddress) external onlyOwner {
        if (pool == address(0) || aToken == address(0) || custodyAddress == address(0)) revert InvalidAddress();
        ModuleType kind = moduleType[custodyAddress];
        if (
            moduleController[custodyAddress] != pool
                || (kind != ModuleType.COLLATERAL_VAULT && kind != ModuleType.SETTLEMENT_ESCROW)
        ) revert InvalidCustodyModule();
        if (moduleToken[custodyAddress] != aToken) revert CustodyTokenMismatch();
        bytes32 registrationKey = keccak256(abi.encode(pool, aToken, custodyAddress));
        if (custodyRegistered[registrationKey]) revert CustodyAlreadyRegistered();

        validator.registerApass(pool, aToken, custodyAddress);
        custodyRegistered[registrationKey] = true;
        emit CvaCustodyRegistered(pool, aToken, custodyAddress, registrationKey);
    }

    function _recordModule(address module, address controller, address token, ModuleType kind) private {
        moduleController[module] = controller;
        moduleToken[module] = token;
        moduleType[module] = kind;
        emit ModuleDeployed(controller, module, uint8(kind), token);
    }
}
