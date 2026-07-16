// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice Train access-control fixture: unprotected treasury setter.
contract TreasuryGuard {
    address public owner;
    address public treasury;

    constructor(address initialTreasury) {
        owner = msg.sender;
        treasury = initialTreasury;
    }

    function setTreasury(address next) external {
        /* VULN: missing-onlyOwner */
        treasury = next;
    }

    function withdraw() external {
        uint256 bal = address(this).balance;
        (bool ok, ) = treasury.call{value: bal}("");
        require(ok, "send");
    }

    receive() external payable {}
}
