// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice Train unchecked-call fixture: ignored low-level return.
contract PayoutRelay {
    mapping(address => uint256) public credits;

    function credit() external payable {
        credits[msg.sender] += msg.value;
    }

    function relay(address payable to, uint256 amount) external {
        require(credits[msg.sender] >= amount, "credit");
        credits[msg.sender] -= amount;
        /* VULN: ignore-return */
        to.call{value: amount}("");
    }
}
