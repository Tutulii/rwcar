// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockComplianceValidator {
    mapping(address => bool) public compliant;
    mapping(address => bool) public registrar;

    address public lastRegisteredPool;
    address public lastRegisteredAToken;
    address public lastRegisteredFeeAddress;
    uint256 public registrationCount;

    error UnauthorizedRegistrar();

    function setCompliant(address user, bool value) external {
        compliant[user] = value;
    }

    function setRegistrar(address account, bool value) external {
        registrar[account] = value;
    }

    function complianceVerify(address, address user) external view returns (bool) {
        return compliant[user];
    }

    function registerApass(address poolAddress, address aTokenAddress, address feeAddress) external {
        if (!registrar[msg.sender]) revert UnauthorizedRegistrar();
        lastRegisteredPool = poolAddress;
        lastRegisteredAToken = aTokenAddress;
        lastRegisteredFeeAddress = feeAddress;
        registrationCount += 1;
    }
}
