// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * Foundry PoC skeleton for train case reentrancy-claim-pool.
 * Optional: run with `forge test` when Foundry is installed.
 * CI never requires Foundry (see ADR 0014).
 */
import "forge-std/Test.sol";

interface IClaimPool {
    function deposit() external payable;
    function claim() external;
}

contract ClaimPoolReentrancyPoC is Test {
    // Placeholder: wire the vulnerable ClaimPool and an attacker receiver.
    function test_poc_placeholder() public pure {
        assertTrue(true);
    }
}
