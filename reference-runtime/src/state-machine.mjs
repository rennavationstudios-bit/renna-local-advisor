import { FleetError } from "./errors.mjs";
import { PACKET_STATES } from "./schemas.mjs";

const TRANSITIONS = Object.freeze({
  PLANNED: ["VALIDATED", "BLOCKED", "STOPPED"],
  VALIDATED: ["CLAIMED", "BLOCKED", "STOPPED"],
  CLAIMED: ["RUNNING", "BLOCKED", "STOPPED"],
  RUNNING: ["DELIVERED", "VERIFYING", "BLOCKED", "STOPPED"],
  DELIVERED: [],
  VERIFYING: ["RETAINED", "BLOCKED", "QUARANTINED"],
  RETAINED: ["INTEGRATION_PENDING"],
  BLOCKED: ["QUARANTINED", "VALIDATED"],
  QUARANTINED: ["VALIDATED"],
  STOPPED: ["VALIDATED"],
  INTEGRATION_PENDING: [],
});

export function transitionState(current, next) {
  if (!PACKET_STATES.includes(current) || !PACKET_STATES.includes(next)) {
    throw new FleetError("INVALID_STATE", `Invalid packet state transition ${current} -> ${next}.`);
  }
  if (!TRANSITIONS[current].includes(next)) {
    throw new FleetError("INVALID_TRANSITION", `Packet cannot transition ${current} -> ${next}.`);
  }
  return next;
}

export function isTerminalState(state) {
  return ["DELIVERED", "INTEGRATION_PENDING", "QUARANTINED", "STOPPED"].includes(state);
}
