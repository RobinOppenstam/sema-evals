// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice Patched refund desk: checks the low-level call success flag.
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
        /* PATCH: check-success */
        (bool ok, ) = recipient.call{value: amount}("");
        require(ok, "refund failed");
    }
}
