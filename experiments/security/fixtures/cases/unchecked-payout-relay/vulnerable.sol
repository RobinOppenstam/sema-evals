// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice Credit-based relay that forwards ETH to a chosen recipient.
contract PayoutRelay {
    mapping(address => uint256) public credits;

    function credit() external payable {
        credits[msg.sender] += msg.value;
    }

    function relay(address payable to, uint256 amount) external {
        require(credits[msg.sender] >= amount, "credit");
        credits[msg.sender] -= amount;
        to.call{value: amount}("");
    }
}
