// Application-level error carrying the HTTP status it should map to.
// Thrown anywhere in the service/repository layers and translated by the
// HTTP adapter in server.mjs. Any other thrown value is treated as unexpected.
export class DeskError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
