export class ConnectorRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
    this.name = "ConnectorRpcError";
  }

  get ownershipConflict(): boolean {
    return this.code === -32009 && !!this.data && typeof this.data === "object"
      && "reason" in this.data && this.data.reason === "connector_already_running";
  }
}

export const CONNECTOR_CONFLICT_MESSAGE = "当前已有其他 Connector 在运行，请先结束对应的 Connector 进程，然后重试。";
