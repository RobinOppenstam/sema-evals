// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice Patched staking vault: burns shares before the ETH transfer.
contract StakeVault {
    mapping(address => uint256) public shares;
    uint256 public totalShares;

    function stake() external payable {
        require(msg.value > 0, "zero");
        shares[msg.sender] += msg.value;
        totalShares += msg.value;
    }

    function sharesOf(address account) external view returns (uint256) {
        return shares[account];
    }

    function unstake(uint256 amount) external {
        require(shares[msg.sender] >= amount, "shares");
        /* PATCH: burn-before-transfer */
        shares[msg.sender] -= amount;
        totalShares -= amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "send");
    }
}
