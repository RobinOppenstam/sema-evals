// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice Tracks claimable ETH balances and pays them out on demand.
contract ClaimPool {
    mapping(address => uint256) public claimable;
    uint256 public totalDeposits;

    function deposit() external payable {
        claimable[msg.sender] += msg.value;
        totalDeposits += msg.value;
    }

    function claimableOf(address account) external view returns (uint256) {
        return claimable[account];
    }

    function claim() external {
        uint256 amount = claimable[msg.sender];
        require(amount > 0, "nothing");
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "pay failed");
        claimable[msg.sender] = 0;
        totalDeposits -= amount;
    }
}
