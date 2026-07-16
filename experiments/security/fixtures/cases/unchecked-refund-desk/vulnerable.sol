// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice Desk that tracks owed amounts and issues ETH refunds.
contract RefundDesk {
    mapping(address => uint256) public owed;
    uint256 public deskBalance;

    function fundDesk() external payable {
        deskBalance += msg.value;
    }

    function owedOf(address account) external view returns (uint256) {
        return owed[account];
    }

    function issueRefund(address payable recipient, uint256 amount) external {
        require(owed[recipient] >= amount, "owed");
        require(deskBalance >= amount, "desk");
        owed[recipient] -= amount;
        deskBalance -= amount;
        recipient.call{value: amount}("");
    }
}
