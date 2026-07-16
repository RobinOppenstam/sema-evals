// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice Patched treasury guard: onlyOwner on setTreasury.
contract TreasuryGuard {
    address public owner;
    address public treasury;

    constructor(address initialTreasury) {
        owner = msg.sender;
        treasury = initialTreasury;
    }

    function setTreasury(address next) external {
        /* PATCH: onlyOwner-guard */
        require(msg.sender == owner, "not owner");
        treasury = next;
    }

    function withdraw() external {
        uint256 bal = address(this).balance;
        (bool ok, ) = treasury.call{value: bal}("");
        require(ok, "send");
    }

    receive() external payable {}
}
