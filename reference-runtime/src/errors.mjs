export class FleetError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "FleetError";
    this.code = code;
    this.details = details;
  }
}

export function fail(code, message, details = {}) {
  throw new FleetError(code, message, details);
}
