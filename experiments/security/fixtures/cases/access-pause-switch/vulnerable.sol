// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice Heldout access-control fixture: unprotected pause toggle.
contract PauseSwitch {
    address public curator;
    bool public paused;

    constructor() {
        curator = msg.sender;
    }

    function isPaused() external view returns (bool) {
        return paused;
    }

    function flipPause() external {
        /* VULN: open-flipPause */
        paused = !paused;
    }
}
